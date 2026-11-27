import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {io} from 'socket.io-client';
const port=39173,base=`http://127.0.0.1:${port}`;
test('demo API, authenticated live sockets, tracking and partial fulfillment work together',{timeout:20000},async()=>{
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:String(port),DEMO_MODE:'true',DASHBOARD_PASSWORD:'integration-only',SESSION_SECRET:'this-is-only-a-test-session-key-1234567890',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 let socket;
 try{
  let ready=false;child.stdout.on('data',d=>{if(String(d).includes('listening'))ready=true});
  for(let i=0;i<100&&!ready;i++)await new Promise(r=>setTimeout(r,50));assert(ready,'server started');
  assert.equal((await fetch(`${base}/health`)).status,200);
  assert.equal((await fetch(`${base}/api/dashboard`)).status,401);
  const invalid=await fetch(`${base}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'wrong'})});assert.equal(invalid.status,401);
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'integration-only'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const fetchAPI=(path,options={})=>fetch(`${base}/api${path}`,{...options,headers:{cookie,'content-type':'application/json',...options.headers}});
  const dashboard=await (await fetchAPI('/dashboard')).json();assert(dashboard.demo);assert.equal(dashboard.orders.length,12);assert(dashboard.metrics.retail>0);
  socket=io(base,{extraHeaders:{cookie},transports:['websocket'],reconnection:false});await once(socket,'connect');
  const selected=dashboard.orders.find(o=>o.status==='UNFULFILLED'),line=selected.items[0];
  const update=once(socket,'data:changed');
  const response=await fetchAPI('/orders/fulfill',{method:'POST',body:JSON.stringify({orderId:selected.id,items:[{id:line.id,quantity:1}],number:'TEST123456',company:'Chit Chats',url:'https://example.com/track',notifyCustomer:true,requestId:crypto.randomUUID()})});assert.equal(response.status,200);await update;
  const after=await (await fetchAPI('/dashboard')).json();const changed=after.orders.find(o=>o.id===selected.id);assert.equal(changed.status,'PARTIALLY_FULFILLED');assert.equal(changed.items[0].remaining,line.remaining-1);assert.equal(changed.fulfillments.at(-1).trackingInfo[0].number,'TEST123456');
  const bad=await fetchAPI('/orders/fulfill',{method:'POST',body:JSON.stringify({orderId:selected.id,items:[{id:line.id,quantity:999}],number:'TEST',company:'Chit Chats',notifyCustomer:true,requestId:crypto.randomUUID()})});assert.equal(bad.status,400);
  const csrf=await fetchAPI('/sync',{method:'POST',headers:{origin:'https://untrusted.example'}});assert.equal(csrf.status,403);
  const unsigned=await fetch(`${base}/api/webhooks`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unsigned.status,401);
 }finally{socket?.disconnect();child.kill('SIGTERM');await once(child,'exit');}
});
