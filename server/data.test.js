import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {metrics} from './data.js';
import {verifyWebhook,fulfillmentInput} from './shopify.js';
const shop={currencyCode:'CAD',ianaTimezone:'America/Toronto'};
test('daily sales use store timezone and exclude cancelled orders',()=>{
 const orders=[{createdAt:'2026-11-27T04:30:00Z',total:100,items:[]},{createdAt:'2026-11-27T05:30:00Z',total:50,items:[]},{createdAt:'2026-11-27T06:00:00Z',total:80,cancelledAt:'2026-11-27T07:00:00Z',items:[]}];
 const m=metrics(orders,[],shop,new Date('2026-11-27T16:00:00Z'));assert.equal(m.sales,50);assert.equal(m.todayOrders,1);
});
test('inventory excludes draft and archived, clamps negative stock, reports missing costs',()=>{
 const variant=(q,p,c)=>({inventoryQuantity:q,price:p,inventoryItem:{unitCost:c==null?null:{amount:c,currencyCode:'CAD'}}});
 const products=[{status:'ACTIVE',variants:{nodes:[variant(5,20,10),variant(-2,50,20),variant(3,10,null)]}},{status:'DRAFT',variants:{nodes:[variant(100,100,80)]}},{status:'ARCHIVED',variants:{nodes:[variant(100,100,80)]}}];
 const m=metrics([],products,shop);assert.equal(m.retail,130);assert.equal(m.cost,50);assert.equal(m.units,8);assert.equal(m.activeProducts,1);assert.equal(m.missingCosts,1);
});
test('webhook HMAC verifies exact raw payload and rejects altered or absent signatures',()=>{const payload=Buffer.from('{"id":1}'),secret='test-only';const signature=crypto.createHmac('sha256',secret).update(payload).digest('base64');assert.equal(verifyWebhook(payload,signature,secret),true);assert.equal(verifyWebhook(Buffer.from('{"id":2}'),signature,secret),false);assert.equal(verifyWebhook(payload,'bad',secret),false);assert.equal(verifyWebhook(payload,null,secret),false);});
const fo=(id,location,remaining=3)=>({id,status:'OPEN',assignedLocation:{location:{id:location}},supportedActions:[{action:'CREATE_FULFILLMENT'}],lineItems:{nodes:[{id:`fo-line-${id}`,remainingQuantity:remaining,lineItem:{id:'line-1'}}],pageInfo:{hasNextPage:false}}});
test('partial fulfillment uses Shopify fulfillment line IDs and exact quantities',()=>{const input=fulfillmentInput([fo('fo-1','loc-1')],[{id:'line-1',quantity:2}],{number:'123'},true);assert.deepEqual(input.lineItemsByFulfillmentOrder,[{fulfillmentOrderId:'fo-1',fulfillmentOrderLineItems:[{id:'fo-line-fo-1',quantity:2}]}]);assert.equal(input.notifyCustomer,true);});
test('fulfillment rejects excess, negative, fractional, duplicate, unavailable and multi-location quantities',()=>{
 for(const selections of [[{id:'line-1',quantity:4}],[{id:'line-1',quantity:-1}],[{id:'line-1',quantity:.5}],[{id:'line-1',quantity:1},{id:'line-1',quantity:1}],[{id:'missing',quantity:1}],[]])assert.throws(()=>fulfillmentInput([fo('fo-1','loc-1')],selections,{},false));
 assert.throws(()=>fulfillmentInput([fo('fo-1','loc-1',1),fo('fo-2','loc-2',1)],[{id:'line-1',quantity:2}],{},false),/different locations/);
 const unavailable=fo('fo-1','loc-1');unavailable.supportedActions=[];assert.throws(()=>fulfillmentInput([unavailable],[{id:'line-1',quantity:1}],{},false));
});
