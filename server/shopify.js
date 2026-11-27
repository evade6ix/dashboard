import crypto from 'node:crypto';
let tokenCache;
const store = process.env.SHOPIFY_STORE;
const version = process.env.SHOPIFY_API_VERSION || '2026-10';
export async function accessToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (tokenCache && tokenCache.until > Date.now()) return tokenCache.token;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(store || '')) throw new Error('Set SHOPIFY_STORE to your canonical myshopify.com domain.');
  const response = await fetch(`https://${store}/admin/oauth/access_token`, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:process.env.SHOPIFY_CLIENT_ID,client_secret:process.env.SHOPIFY_CLIENT_SECRET}),signal:AbortSignal.timeout(30000)});
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error('Shopify authentication failed. Verify installation and server credentials.');
  tokenCache = {token:body.access_token,until:Date.now()+(body.expires_in-120)*1000};
  return tokenCache.token;
}
export async function gql(query, variables={}) {
  for (let attempt=0;attempt<5;attempt++) {
    const response = await fetch(`https://${store}/admin/api/${version}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':await accessToken()},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
    const data=await response.json();
    if (response.status===429 || data.errors?.some(e=>e.extensions?.code==='THROTTLED')) {await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));continue;}
    if (!response.ok || data.errors) throw new Error(data.errors?.map(e=>e.message).join('; ') || `Shopify request failed (${response.status})`);
    return data.data;
  }
  throw new Error('Shopify is busy. Please retry shortly.');
}
export const ORDER_FIELDS=`id name createdAt updatedAt processedAt cancelledAt email note tags displayFinancialStatus displayFulfillmentStatus currencyCode currentTotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } } customer { displayName email } shippingAddress { name address1 address2 city provinceCode zip country countryCodeV2 phone } shippingLines(first:20) { nodes { title } } lineItems(first:20) { nodes { id title variantTitle sku quantity currentQuantity unfulfilledQuantity image { url } originalUnitPriceSet { shopMoney { amount currencyCode } } } pageInfo { hasNextPage endCursor } } fulfillments { id status createdAt trackingInfo { number company url } }`;
export const queries={
 orders:`query Orders($cursor:String) { orders(first:5,after:$cursor,sortKey:CREATED_AT,reverse:true) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
 order:`query Order($id:ID!) { order(id:$id) { ${ORDER_FIELDS} } }`,
 lines:`query Lines($id:ID!,$cursor:String) { order(id:$id) { lineItems(first:100,after:$cursor) { nodes { id title variantTitle sku quantity currentQuantity unfulfilledQuantity image { url } originalUnitPriceSet { shopMoney { amount currencyCode } } } pageInfo { hasNextPage endCursor } } } }`,
 products:`query Products($cursor:String) { products(first:10,after:$cursor,query:"status:active") { nodes { id title status variants(first:20) { nodes { id title sku price inventoryQuantity inventoryItem { unitCost { amount currencyCode } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }`,
 variants:`query Variants($id:ID!,$cursor:String) { product(id:$id) { variants(first:100,after:$cursor) { nodes { id title sku price inventoryQuantity inventoryItem { unitCost { amount currencyCode } } } pageInfo { hasNextPage endCursor } } } }`,
 shop:`query Shop { shop { name currencyCode ianaTimezone } }`,
 fulfillmentOrders:`query FulfillmentOrders($id:ID!,$cursor:String) { order(id:$id) { fulfillmentOrders(first:50,after:$cursor) { nodes { id status assignedLocation { location { id name } } supportedActions { action } lineItems(first:100) { nodes { id remainingQuantity lineItem { id } } pageInfo { hasNextPage } } } pageInfo { hasNextPage endCursor } } } }`,
 fulfill:`mutation Fulfill($fulfillment:FulfillmentInput!) { fulfillmentCreate(fulfillment:$fulfillment) { fulfillment { id status } userErrors { field message } } }`,
 webhook:`mutation Webhook($topic:WebhookSubscriptionTopic!,$webhookSubscription:WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic:$topic,webhookSubscription:$webhookSubscription) { webhookSubscription { id topic } userErrors { field message } } }`,
 webhooks:`query Webhooks($cursor:String) { webhookSubscriptions(first:100,after:$cursor) { nodes { topic uri } pageInfo { hasNextPage endCursor } } }`
};
export function verifyWebhook(raw, hmac, secret) {
  if (!secret || !hmac) return false;
  const expected=crypto.createHmac('sha256',secret).update(raw).digest();
  const provided=Buffer.from(hmac,'base64');
  return expected.length===provided.length && crypto.timingSafeEqual(expected,provided);
}
export async function completeLines(order) {
  let cursor=order.lineItems.pageInfo.endCursor;
  while(order.lineItems.pageInfo.hasNextPage){const data=(await gql(queries.lines,{id:order.id,cursor})).order.lineItems;order.lineItems.nodes.push(...data.nodes);order.lineItems.pageInfo=data.pageInfo;cursor=data.pageInfo.endCursor;}
  return order;
}
export function fulfillmentInput(orders, selections, tracking, notifyCustomer) {
  const requested=new Map(selections.map(s=>[s.id,s.quantity]));
  if (!requested.size || requested.size!==selections.length || selections.some(s=>!Number.isInteger(s.quantity)||s.quantity<1)) throw new Error('Choose valid item quantities.');
  const groups=[];let location;
  for(const fo of orders){
    if(!fo.supportedActions.some(a=>a.action==='CREATE_FULFILLMENT')) continue;
    if(fo.lineItems.pageInfo.hasNextPage) throw new Error('This fulfillment has over 100 lines. Fulfill it in Shopify.');
    const lines=[];
    for(const item of fo.lineItems.nodes){const needed=requested.get(item.lineItem.id)||0;const quantity=Math.min(needed,item.remainingQuantity);if(quantity>0){lines.push({id:item.id,quantity});requested.set(item.lineItem.id,needed-quantity);}}
    if(lines.length){const next=fo.assignedLocation.location?.id;if(location && location!==next) throw new Error('Selected items ship from different locations. Fulfill each location separately in Shopify.');location=next;groups.push({fulfillmentOrderId:fo.id,fulfillmentOrderLineItems:lines});}
  }
  if([...requested.values()].some(n=>n>0)||!groups.length) throw new Error('These quantities are no longer fulfillable. Refresh the order.');
  return {lineItemsByFulfillmentOrder:groups,trackingInfo:tracking,notifyCustomer};
}
