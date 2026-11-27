export function orderView(o) {
  const money=o.currentTotalPriceSet;
  return {id:o.id,name:o.name,createdAt:o.createdAt,updatedAt:o.updatedAt,cancelledAt:o.cancelledAt,customer:o.customer?.displayName||o.shippingAddress?.name||'Guest customer',email:o.email||o.customer?.email,address:o.shippingAddress,note:o.note,tags:o.tags||[],payment:o.displayFinancialStatus,status:o.displayFulfillmentStatus,total:Number(money?.shopMoney.amount||0),currency:money?.shopMoney.currencyCode||o.currencyCode,presentmentTotal:Number(money?.presentmentMoney.amount||0),presentmentCurrency:money?.presentmentMoney.currencyCode,shipping:o.shippingLines?.nodes.map(s=>s.title).join(', ')||'Shipping',items:o.lineItems.nodes.map(l=>({id:l.id,title:l.title,variant:l.variantTitle,sku:l.sku,quantity:l.currentQuantity,remaining:l.unfulfilledQuantity,image:l.image?.url,price:Number(l.originalUnitPriceSet?.shopMoney.amount||0)})),fulfillments:o.fulfillments||[]};
}
export function metrics(orders,products,shop,date=new Date()) {
  const day=d=>new Intl.DateTimeFormat('en-CA',{timeZone:shop.ianaTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d));
  const today=orders.filter(o=>!o.cancelledAt&&day(o.createdAt)===day(date));
  let retail=0,cost=0,units=0,missingCosts=0,activeProducts=0;
  for(const p of products){if(p.status!=='ACTIVE')continue;activeProducts++;for(const v of p.variants.nodes){const qty=Math.max(0,v.inventoryQuantity||0);units+=qty;retail+=Number(v.price)*qty;if(v.inventoryItem.unitCost)cost+=Number(v.inventoryItem.unitCost.amount)*qty;else if(qty>0)missingCosts++;}}
  return {sales:today.reduce((a,o)=>a+o.total,0),todayOrders:today.length,awaiting:orders.filter(o=>!o.cancelledAt&&o.items.some(i=>i.remaining>0)).length,retail,cost,units,missingCosts,activeProducts,date:day(date),currency:shop.currencyCode,timeZone:shop.ianaTimezone};
}
