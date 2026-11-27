import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import pg from 'pg';
import {fileURLToPath} from 'node:url';
import {gql,queries,verifyWebhook,completeLines,fulfillmentInput} from './shopify.js';
import {orderView,metrics} from './data.js';
import {demoData} from './demo.js';
const demo=process.env.DEMO_MODE==='true'||(process.env.NODE_ENV!=='production'&&process.env.DEMO_MODE!=='false');
if(!demo&&(!process.env.DATABASE_URL||!process.env.DASHBOARD_PASSWORD||!process.env.SESSION_SECRET||!process.env.SHOPIFY_CLIENT_SECRET)) throw new Error('Live mode requires DATABASE_URL, DASHBOARD_PASSWORD, SESSION_SECRET and SHOPIFY_CLIENT_SECRET.');
if(process.env.DASHBOARD_PASSWORD&&(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32))throw new Error('Use a SESSION_SECRET of at least 32 characters.');
const app=express(),server=createServer(app),io=new Server(server);
app.set('trust proxy',1);app.use(helmet({contentSecurityPolicy:{directives:{'img-src':["'self'",'data:','https://cdn.shopify.com'],'connect-src':["'self'",'ws:','wss:']}}}));app.use(cookieParser());
const pool=!demo?new pg.Pool({connectionString:process.env.DATABASE_URL}):null;
if(pool){await pool.query(`CREATE TABLE IF NOT EXISTS cache (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS webhook_jobs (id text PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL, attempts int NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS fulfillment_attempts (key text PRIMARY KEY, order_id text NOT NULL, state text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now());`);}
let demoState=demoData(),syncState={state:'idle',lastSync:null,error:null},syncing=false;
async function put(kind,id,data,client=pool){await client.query('INSERT INTO cache(kind,id,data) VALUES($1,$2,$3) ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data',[kind,id,JSON.stringify(data)]);}
async function cached(kind){return (await pool.query('SELECT data FROM cache WHERE kind=$1',[kind])).rows.map(r=>r.data);}
async function publish(){if(pool)await pool.query("SELECT pg_notify('dashboard_changes','refresh')");else io.emit('data:changed');}
if(pool){const listener=await pool.connect();await listener.query('LISTEN dashboard_changes');listener.on('notification',()=>io.emit('data:changed'));listener.on('error',e=>{console.error('Realtime database connection failed:',e.message);process.exit(1);});}
function equal(a,b){const aa=crypto.createHash('sha256').update(a).digest(),bb=crypto.createHash('sha256').update(b).digest();return crypto.timingSafeEqual(aa,bb);}
function validSession(value){if(!process.env.DASHBOARD_PASSWORD)return demo;const [expires,sig]=String(value||'').split('.');return Number(expires)>Date.now()&&equal(sig||'',crypto.createHmac('sha256',process.env.SESSION_SECRET).update(expires).digest('hex'));}
function originAllowed(req){return !req.headers.origin||req.headers.origin===`${req.protocol}://${req.get('host')}`;}
const loginLimit=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false});
app.get('/health',async(req,res)=>{try{if(pool)await pool.query('SELECT 1');res.json({ok:true});}catch{res.status(503).json({ok:false});}});
app.post('/api/webhooks',express.raw({type:'application/json',limit:'5mb'}),async(req,res)=>{
 if(demo||!verifyWebhook(req.body,req.get('x-shopify-hmac-sha256'),process.env.SHOPIFY_CLIENT_SECRET))return res.sendStatus(401);
 if(req.get('x-shopify-shop-domain')!==process.env.SHOPIFY_STORE)return res.sendStatus(401);
 try{const id=req.get('x-shopify-webhook-id');if(!id)return res.sendStatus(400);await pool.query('INSERT INTO webhook_jobs(id,topic,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,req.get('x-shopify-topic'),JSON.parse(req.body)]);res.sendStatus(200);}catch{res.sendStatus(503);}
});
app.use(express.json({limit:'100kb'}));
app.get('/api/session',(req,res)=>res.json({authenticated:validSession(req.cookies.session),demo}));
app.post('/api/login',loginLimit,(req,res)=>{if(!originAllowed(req))return res.sendStatus(403);if(!process.env.DASHBOARD_PASSWORD||!equal(String(req.body.password||''),process.env.DASHBOARD_PASSWORD))return res.status(401).json({error:'Incorrect password.'});const expires=String(Date.now()+12*60*60*1000),sig=crypto.createHmac('sha256',process.env.SESSION_SECRET).update(expires).digest('hex');res.cookie('session',`${expires}.${sig}`,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:12*60*60*1000});res.json({ok:true});});
app.use('/api',(req,res,next)=>{if(!validSession(req.cookies.session))return res.status(401).json({error:'Please sign in.'});if(req.method!=='GET'&&!originAllowed(req))return res.sendStatus(403);next();});
app.post('/api/logout',(req,res)=>{res.clearCookie('session');res.json({ok:true});});
io.use((socket,next)=>{const cookies=Object.fromEntries((socket.handshake.headers.cookie||'').split(';').map(x=>x.trim().split('=')));if(!validSession(cookies.session))return next(new Error('Unauthorized'));const origin=socket.handshake.headers.origin;const expected=process.env.APP_URL;if(origin&&expected&&origin!==new URL(expected).origin)return next(new Error('Origin rejected'));next();});
io.on('connection',socket=>{const timer=setInterval(()=>{const cookies=Object.fromEntries((socket.handshake.headers.cookie||'').split(';').map(x=>x.trim().split('=')));if(!validSession(cookies.session))socket.disconnect(true);},60000);socket.on('disconnect',()=>clearInterval(timer));});
app.get('/api/dashboard',async(req,res)=>{if(demo)return res.json({...demoState,metrics:metrics(demoState.orders,demoState.products,demoState.shop),products:undefined});const [orders,products,shops]=await Promise.all([cached('order'),cached('product'),cached('shop')]);const shop=shops[0]||{currencyCode:'CAD',ianaTimezone:'America/Toronto',name:'Go Next Hobbies'};res.json({orders:orders.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),metrics:metrics(orders,products,shop),shop,sync:syncState,demo:false});});
app.get('/api/inventory',async(req,res)=>res.json({products:demo?demoState.products:await cached('product')}));
async function refreshOrder(id){const raw=(await gql(queries.order,{id})).order;if(raw)await put('order',id,orderView(await completeLines(raw)));else await pool.query("DELETE FROM cache WHERE kind='order' AND id=$1",[id]);}
async function syncProducts(){const collected=[];let cursor=null;do{const page=(await gql(queries.products,{cursor})).products;for(const p of page.nodes){let c=p.variants.pageInfo.endCursor;while(p.variants.pageInfo.hasNextPage){const next=(await gql(queries.variants,{id:p.id,cursor:c})).product.variants;p.variants.nodes.push(...next.nodes);p.variants.pageInfo=next.pageInfo;c=next.pageInfo.endCursor;}collected.push(p);}cursor=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;}while(cursor);const client=await pool.connect();try{await client.query('BEGIN');await client.query("DELETE FROM cache WHERE kind='product'");for(const p of collected)await put('product',p.id,p,client);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function fullSync(){if(syncing)return;syncing=true;syncState={...syncState,state:'syncing',error:null};io.emit('data:changed');const client=await pool.connect();let locked=false;try{locked=(await client.query('SELECT pg_try_advisory_lock(491204) AS locked')).rows[0].locked;if(!locked)return;const shop=(await gql(queries.shop)).shop;await put('shop','primary',shop);let cursor=null;do{const page=(await gql(queries.orders,{cursor})).orders;for(const o of page.nodes)await put('order',o.id,orderView(await completeLines(o)));cursor=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;}while(cursor);await syncProducts();syncState={state:'ready',lastSync:new Date().toISOString(),error:null};await publish();}catch(e){syncState={...syncState,state:'error',error:e.message};console.error('Sync failed:',e.message);}finally{if(locked)await client.query('SELECT pg_advisory_unlock(491204)');client.release();syncing=false;io.emit('data:changed');}}
app.post('/api/sync',(req,res)=>{if(demo)return res.json({ok:true});void fullSync();res.status(202).json({ok:true});});
app.post('/api/orders/fulfill',async(req,res)=>{
 const {orderId,items,number,company,url,notifyCustomer,requestId}=req.body;
 if(typeof orderId!=='string'||!Array.isArray(items)||!items.length||typeof number!=='string'||!number.trim()||number.length>200||typeof company!=='string'||!company.trim()||typeof notifyCustomer!=='boolean'||!/^[-\w]{20,80}$/.test(requestId||''))return res.status(400).json({error:'Select items and enter a carrier and tracking number.'});
 if(url){try{if(!['https:','http:'].includes(new URL(url).protocol))throw Error();}catch{return res.status(400).json({error:'Enter a valid tracking URL.'});}}
 if(demo){const order=demoState.orders.find(o=>o.id===orderId);if(!order)return res.sendStatus(404);for(const selection of items){const line=order.items.find(i=>i.id===selection.id);if(!line||!Number.isInteger(selection.quantity)||selection.quantity<1||selection.quantity>line.remaining)return res.status(400).json({error:'Invalid quantity.'});}for(const selection of items)order.items.find(i=>i.id===selection.id).remaining-=selection.quantity;order.status=order.items.some(i=>i.remaining>0)?'PARTIALLY_FULFILLED':'FULFILLED';order.fulfillments.push({id:crypto.randomUUID(),status:'SUCCESS',trackingInfo:[{number,company,url}]});await publish();return res.json({ok:true,demo:true});}
 const client=await pool.connect();let started=false;
 try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[orderId]);const previous=(await client.query('SELECT * FROM fulfillment_attempts WHERE key=$1',[requestId])).rows[0];if(previous){await client.query('ROLLBACK');return res.status(previous.state==='success'?200:409).json(previous.state==='success'?{ok:true}:{error:'This request may already have reached Shopify. Refresh and verify the order before trying again.'});}
 let cursor=null,orders=[];do{const page=(await gql(queries.fulfillmentOrders,{id:orderId,cursor})).order?.fulfillmentOrders;if(!page)throw new Error('Order not found.');orders.push(...page.nodes);cursor=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;}while(cursor);
 const pending=await client.query("SELECT key FROM fulfillment_attempts WHERE order_id=$1 AND state='pending' LIMIT 1",[orderId]);
 if(pending.rows.length)throw new Error('A previous fulfillment has an uncertain result. Check its status in Shopify before another shipment; see the recovery instructions in README.');
 const input=fulfillmentInput(orders,items,{number:number.trim(),company:company.trim(),...(url?{url}: {})},notifyCustomer);
 await client.query("INSERT INTO fulfillment_attempts(key,order_id,state) VALUES($1,$2,'pending')",[requestId,orderId]);await client.query('COMMIT');started=true;
 // Pending is committed before calling Shopify so a timeout cannot silently duplicate a fulfillment.
 const result=(await gql(queries.fulfill,{fulfillment:input})).fulfillmentCreate;
 if(result.userErrors.length){await pool.query("UPDATE fulfillment_attempts SET state='rejected',result=$2 WHERE key=$1",[requestId,JSON.stringify(result)]);return res.status(422).json({error:result.userErrors.map(e=>e.message).join('; ')});}
 await pool.query("UPDATE fulfillment_attempts SET state='success',result=$2 WHERE key=$1",[requestId,JSON.stringify(result)]);await refreshOrder(orderId);await publish();res.json({ok:true});
 }catch(e){if(!started)await client.query('ROLLBACK');res.status(409).json({error:started?'Shopify may have processed this fulfillment. Refresh and check Shopify before submitting another shipment.':e.message});}finally{client.release();}
});
let processing=false;
async function jobs(){if(processing||syncing)return;processing=true;const client=await pool.connect();try{await client.query('BEGIN');const result=await client.query('SELECT * FROM webhook_jobs WHERE next_attempt<=now() ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED');let products=false;for(const j of result.rows){try{if(j.topic.startsWith('orders/')&&j.topic!=='orders/delete'){await refreshOrder(j.payload.admin_graphql_api_id||`gid://shopify/Order/${j.payload.id}`);}else if(j.topic==='orders/delete'){await pool.query("DELETE FROM cache WHERE kind='order' AND id=$1",[`gid://shopify/Order/${j.payload.id}`]);}else products=true;await client.query('DELETE FROM webhook_jobs WHERE id=$1',[j.id]);}catch(e){await client.query("UPDATE webhook_jobs SET attempts=attempts+1,next_attempt=now()+interval '1 minute' * LEAST(60,attempts+1) WHERE id=$1",[j.id]);console.error('Webhook retry:',e.message);}}if(products)await syncProducts();await client.query('COMMIT');if(result.rows.length)await publish();}catch(e){await client.query('ROLLBACK');console.error('Webhook processing:',e.message);}finally{client.release();processing=false;}}
app.post('/api/webhooks/register',async(req,res)=>{
 if(demo)return res.status(400).json({error:'Configure live mode first.'});if(!process.env.APP_URL?.startsWith('https://'))return res.status(400).json({error:'Set APP_URL to the public HTTPS address first.'});
 const uri=`${process.env.APP_URL.replace(/\/$/,'')}/api/webhooks`,existing=[];let cursor=null;do{const page=(await gql(queries.webhooks,{cursor})).webhookSubscriptions;existing.push(...page.nodes);cursor=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;}while(cursor);
 const results=[];for(const topic of ['ORDERS_CREATE','ORDERS_UPDATED','ORDERS_DELETE','PRODUCTS_CREATE','PRODUCTS_UPDATE','PRODUCTS_DELETE','INVENTORY_LEVELS_UPDATE','INVENTORY_ITEMS_UPDATE']){if(existing.some(w=>w.topic===topic&&w.uri===uri)){results.push({topic,status:'existing'});continue;}const result=(await gql(queries.webhook,{topic,webhookSubscription:{uri,format:'JSON'}})).webhookSubscriptionCreate;results.push({topic,status:result.userErrors.length?'error':'created',errors:result.userErrors});}res.json({results});
});
app.use(express.static(fileURLToPath(new URL('../dist',import.meta.url))));app.get('/{*path}',(req,res)=>res.sendFile(fileURLToPath(new URL('../dist/index.html',import.meta.url))));
app.use((error,req,res,next)=>{console.error(error.message);res.status(500).json({error:'The request failed. Please try again or check the server logs.'});});
server.listen(process.env.PORT||3000,'0.0.0.0',()=>{console.log(`Go Next Operations listening (${demo?'demo':'live'} mode)`);if(!demo){void fullSync();setInterval(()=>void jobs(),1500).unref();setInterval(()=>void fullSync(),15*60*1000).unref();}});
async function shutdown(){io.close();server.close();if(pool)await pool.end();process.exit(0);}process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
