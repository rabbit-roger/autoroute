import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createService} from '../src/service/server.js';
async function fixture(run:(url:string,token:string)=>Promise<void>){const dir=mkdtempSync(join(tmpdir(),'autoroute-http-'));const {server,token}=createService(dir);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;try{await run(url,token);}finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}}
test('authenticated API rejects foreign origin and host; static UI has restrictive CSP',()=>fixture(async(url,token)=>{assert.equal((await fetch(url+'/v1/history')).status,401);assert.equal((await fetch(url+'/v1/history',{headers:{Authorization:'Bearer '+token,Origin:'https://evil.invalid'}})).status,403);const badHost=await new Promise<number>(resolve=>{http.get(url+'/v1/history',{headers:{Authorization:'Bearer '+token,Host:'evil.invalid'}},r=>{r.resume();resolve(r.statusCode!);});});assert.equal(badHost,403);const r=await fetch(url);assert.equal(r.status,200);assert.ok(r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));}));
test('usage ingestion redacts content and deduplicates retries of event delivery',()=>fixture(async(url,token)=>{const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};const e={eventId:'event-1',key:'claude:s1',host:'claude',kind:'request',requestedModel:'native',prompt:'PROMPT_CANARY',error:'SECRET_CANARY',nativeUsage:{input_tokens:20,cache_read_input_tokens:80,output_tokens:20}};for(let i=0;i<2;i++)assert.equal((await fetch(url+'/v1/events',{method:'POST',headers,body:JSON.stringify(e)})).status,200);const body=await(await fetch(url+'/v1/history',{headers})).text();assert.ok(!body.includes('CANARY'));const events=JSON.parse(body).events;assert.equal(events.length,1);assert.equal(events[0].usage.input,20);assert.equal(events[0].observedModel,undefined);}));
test('purge requires explicit confirmation and valid content type',()=>fixture(async(url,token)=>{const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};assert.equal((await fetch(url+'/v1/purge',{method:'POST',headers,body:'{}'})).status,400);assert.equal((await fetch(url+'/v1/purge',{method:'POST',headers,body:'{"confirm":"PURGE"}'})).status,200);}));
const call=(url:string,method:string,path:string,headers:Record<string,string>,body?:unknown)=>new Promise<number>((resolve,reject)=>{const r=http.request(url+path,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})}},res=>{res.resume();resolve(res.statusCode!);});r.on('error',reject);if(body)r.write(JSON.stringify(body));r.end();});
test('the dashboard needs no key for its own read and purge calls, but nothing else does without one',()=>fixture(async(url,token)=>{
 const ui={'Sec-Fetch-Site':'same-origin','X-Autoroute-UI':'1'};
 assert.equal(await call(url,'GET','/v1/history',ui),200);
 assert.equal(await call(url,'GET','/v1/export?format=csv',ui),200);
 assert.equal(await call(url,'GET','/v1/history',{...ui,'Sec-Fetch-Site':'cross-site'}),401);
 assert.equal(await call(url,'GET','/v1/history',{'Sec-Fetch-Site':'same-origin'}),401);
 assert.equal(await call(url,'GET','/v1/history',{}),401);
 assert.equal(await call(url,'GET','/v1/health',ui),401);
 assert.equal(await call(url,'POST','/v1/session',ui,{key:'claude:x',host:'claude',hostVersion:'v'}),401);
 assert.equal(await call(url,'POST','/v1/decide',ui,{taskId:'t',owner:'o'}),401);
 assert.equal(await call(url,'POST','/v1/purge',ui,{confirm:'PURGE'}),200);
 assert.equal(await call(url,'GET','/v1/history',{Authorization:'Bearer '+token}),200);
}));
test('the live stream pings the dashboard after a write and refuses other sites',()=>fixture(async(url,token)=>{
 assert.equal(await call(url,'GET','/v1/stream',{}),401);
 assert.equal(await call(url,'GET','/v1/stream',{'Sec-Fetch-Site':'cross-site'}),401);
 const got=new Promise<string>((resolve,reject)=>{const r=http.get(url+'/v1/stream',{headers:{'Sec-Fetch-Site':'same-origin'}},res=>{assert.equal(res.statusCode,200);assert.match(String(res.headers['content-type']),/text\/event-stream/);let buf='';res.on('data',d=>{buf+=d;if(buf.includes('event: change')){r.destroy();resolve(buf);}});});r.on('error',e=>{if(!(e as any).code||(e as any).code!=='ECONNRESET')reject(e);});setTimeout(()=>{r.destroy();reject(new Error('no change event'));},4000).unref();});
 await new Promise(r=>setTimeout(r,200));
 assert.equal(await call(url,'POST','/v1/session',{Authorization:'Bearer '+token},{key:'claude:live',host:'claude',hostVersion:'v'}),200);
 assert.match(await got,/event: change/);
}));

test('the page icon is served without a key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'autoroute-icon-')),svc=createService(dir);
 await new Promise<void>(r=>svc.server.listen(0,'127.0.0.1',r));
 try{
  const port=(svc.server.address() as any).port;
  for(const path of ['/favicon.svg','/favicon.ico']){
   const r=await fetch(`http://127.0.0.1:${port}${path}`);
   assert.equal(r.status,200);
   assert.equal(r.headers.get('content-type'),'image/svg+xml');
  }
 }finally{await new Promise<void>(r=>svc.server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

test('bundled defaults install once, refresh a bundled catalog, and never overwrite a custom one or newer prices',async()=>{
 const {Store}=await import('../src/service/store.js');const {caps}=await import('./fixtures.js');
 const dir=mkdtempSync(join(tmpdir(),'autoroute-defaults-')),store=new Store(join(dir,'db'));
 const price=(date:string)=>[{model:'fixture-light',date,source:'https://example.invalid',input:1,output:2,cacheRead:0.1}];
 try{
  store.installDefaults(caps,price('2026-01-01'));assert.equal(store.catalog('claude')!.catalogVersion,'test');assert.equal(store.prices()[0]!.date,'2026-01-01');
  store.installDefaults({...caps,catalogVersion:'next'},price('2025-01-01'));assert.equal(store.catalog('claude')!.catalogVersion,'next');assert.equal(store.prices()[0]!.date,'2026-01-01');
  store.setCatalog({...caps,source:'custom',catalogVersion:'mine'});store.installDefaults({...caps,catalogVersion:'later'},price('2027-01-01'));
  assert.equal(store.catalog('claude')!.catalogVersion,'mine');assert.equal(store.prices()[0]!.date,'2027-01-01');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a new conversation follows the default routing setting sent by the plugin',()=>fixture(async(url,token)=>{
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const on=await(await fetch(url+'/v1/session',{method:'POST',headers,body:JSON.stringify({key:'claude:a',host:'claude',hostVersion:'2.1.317',defaultEnabled:true})})).json();
 const off=await(await fetch(url+'/v1/session',{method:'POST',headers,body:JSON.stringify({key:'claude:b',host:'claude',hostVersion:'2.1.317'})})).json();
 assert.equal(on.enabled,true);assert.equal(off.enabled,false);
}));
