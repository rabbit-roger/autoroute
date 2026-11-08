import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/core/parser.js';
import { assertCatalog,features,decide,rewrite,versionAtLeast } from '../src/core/policy.js';
import { normalize,equivalent,equivalentRange,effectiveRates,assertPrices } from '../src/core/usage.js';
import { Store } from '../src/service/store.js';
import type { Capabilities,Session,Task } from '../src/core/types.js';
import {caps} from './fixtures.js';
const session=():Session=>({key:'claude:s1',host:'claude',hostVersion:'2.1.317',enabled:true,pins:{},revision:0,dwell:0});
const task=(text='Implement a flag'):Task=>({id:'t1',key:'claude:s1',nativeTurnId:'turn1',owner:'owner',enabled:true,features:features(text),baseline:{model:'native',effort:'medium'},state:'running',failures:0,evidence:[],createdAt:new Date().toISOString()});
function withStore(run:(s:Store,path:string)=>void){const dir=mkdtempSync(join(tmpdir(),'autoroute-'));let s:Store|undefined;try{s=new Store(join(dir,'db'));run(s,join(dir,'db'));}finally{s?.close();rmSync(dir,{recursive:true,force:true});}}
test('parser preserves all bytes after one delimiter including large pasted content',()=>{const text=' line 1\n\n'+('x'.repeat(20000))+'\n';const p=parse('/autoroute-task-on '+text);assert.deepEqual(p,{kind:'task',enabled:true,text});});
test('hyphenated toggles parse independently and old toggle syntax is rejected',()=>{assert.deepEqual(parse('/autoroute-on'),{kind:'session',enabled:true});assert.deepEqual(parse('/autoroute-off'),{kind:'session',enabled:false});assert.deepEqual(parse('/autoroute-task-on task'),{kind:'task',enabled:true,text:'task'});assert.deepEqual(parse('/autoroute-task-off task'),{kind:'task',enabled:false,text:'task'});for(const old of ['/autoroute on','/autoroute off','/autoroute-task on task','/autoroute-task off task'])assert.equal(parse(old).kind,'error');assert.deepEqual(parse('/autoroute-status'),{kind:'status'});assert.deepEqual(parse('/autoroute-dashboard'),{kind:'dashboard'});for(const old of ['/autoroute status','/autoroute stats','/autoroute','/autoroute-status now'])assert.equal(parse(old).kind,'error');});
test('reject empty, multiple and malformed commands without sticky state',()=>{for(const input of ['/autoroute-task-on','/autoroute-task-on   ','/autoroute-on\n/autoroute-off','/autoroute-task-on foo\n/autoroute-off','/autoroute banana'])assert.equal(parse(input).kind,'error');});
test('quoted commands and similar prefixes are ordinary task text',()=>{for(const text of ['```\n/autoroute-on\n```','Explain /autoroute-on','/autorouter on'])assert.deepEqual(parse(text),{kind:'prompt',text});});
test('risk floors recognize consequential mutations',()=>{for(const text of ['Implement OAuth login','Fix the payment migration'])assert.equal(decide(session(),task(text),caps).route.model,'fixture-strong');assert.equal(features('Explain migration strategy').risk,false);});
test('unknown short followups never route light',()=>assert.notEqual(decide(session(),task('ok'),caps).route.model,'fixture-light'));
test('off preserves event identity, including native settings and attachments',()=>{const t=task();t.enabled=false;const event={model:'native',effort:'medium' as const,attachments:[{bytes:'original'}],index:1};assert.equal(rewrite(event,decide(session(),t,caps)),event);});
test('a host older than the catalog requires, or with an unreadable version, keeps native settings',()=>{for(const v of ['2.0.9','next','']){const s=session();s.hostVersion=v;const d=decide(s,task(),caps);assert.equal(d.action,'passthrough');assert.deepEqual(d.reasons,['host-version-unsupported']);}const s=session();s.hostVersion='3.0.0';assert.equal(decide(s,task(),caps).action,'apply');});
test('version comparison is numeric, not textual',()=>{assert.ok(versionAtLeast('2.1.317','2.1.317'));assert.ok(versionAtLeast('2.1.1000','2.1.317'));assert.ok(versionAtLeast('2.2','2.1.317'));assert.ok(!versionAtLeast('2.1.99','2.1.317'));assert.ok(!versionAtLeast('2.1.317-beta','2.1.317'));});
test('manual pins dominate risk floors and unsupported effort fails native',()=>{const s=session();s.pins={model:'fixture-light'};const d=decide(s,task('Implement OAuth'),caps);assert.equal(d.route.model,'fixture-light');assert.ok(d.reasons.includes('risk-floor-pin-conflict'));s.pins.effort='max';assert.equal(decide(s,task(),caps).action,'passthrough');});
test('a light task after a heavy one moves down within the session, but a model pin still holds',()=>{const s=session();s.lastRoute={model:'fixture-strong',effort:'high'};assert.equal(decide(s,task('Find the README'),caps).route.model,'fixture-light');s.pins={model:'fixture-strong'};assert.equal(decide(s,task('Find the README'),caps).route.model,'fixture-strong');});
test('failed verifier increases effort before replacing a balanced model',()=>{const t=task();t.route={model:'fixture-balanced',effort:'medium'};t.failures=1;assert.deepEqual(decide(session(),t,caps).route,{model:'fixture-balanced',effort:'high'});t.failures=2;assert.equal(decide(session(),t,caps).route.model,'fixture-strong');});
test('catalog validates version, source, tier, duplicate ids',()=>{assertCatalog(caps);for(const value of [{...caps,minHostVersion:'latest'},{...caps,source:'host-picker'},{...caps,candidates:[caps.candidates[0],caps.candidates[0]]},{...caps,candidates:[{...caps.candidates[0],tier:'bogus'},caps.candidates[1]]}])assert.throws(()=>assertCatalog(value));});
test('unavailable counters stay unknown',()=>{assert.equal(normalize('claude',{}).output,null);assert.equal(normalize('claude',{input_tokens:-1}).input,null);});
test('counterfactual same-usage prices require cache TTL, exclude reasoning add-on',()=>{const p={model:'fixture',date:'2026-11-06',source:'https://example.invalid',input:2,output:10,cacheRead:0.2,cacheWrite5m:2.5,cacheWrite1h:4};const u={input:100,output:10,cacheRead:100,cacheWrite:0,reasoning:5};assert.equal(equivalent(u,p),0.00032);assert.equal(equivalent({...u,cacheWrite:20},p),null);});
test('session command idempotency and stale revision rejection',()=>withStore(s=>{s.session('claude:s1','claude','test-only');const a=s.command('claude:s1',true,'cmd1',0);assert.equal(s.command('claude:s1',true,'cmd1',0).session.revision,a.session.revision);assert.throws(()=>s.command('claude:s1',false,'cmd2',0));}));
test('override does not change session, ends on cancellation, other session isolated',()=>withStore(s=>{s.session('claude:s1','claude','test-only');s.session('claude:s2','claude','test-only');const t=s.start('claude:s1','turn1','o',{model:'native'},features('Add flag'),true);assert.equal(s.session('claude:s1').enabled,false);assert.equal(s.session('claude:s2').enabled,false);s.finish(t.id,'cancelled');assert.throws(()=>s.route(t.id,'o'));assert.equal(s.start('claude:s1','turn2','o',{model:'native'},features('Add flag')).enabled,false);}));
test('leases prevent concurrent turn and owner races',()=>withStore(s=>{s.session('claude:s1','claude','test-only');const t=s.start('claude:s1','turn1','o',{model:'native'},features('Add flag'));assert.throws(()=>s.start('claude:s1','turn2','p',{model:'native'},features('Add flag')));assert.throws(()=>s.route(t.id,'p'));}));
test('restart retains session on, abandons unfinished override',()=>{const dir=mkdtempSync(join(tmpdir(),'autoroute-restart-'));const path=join(dir,'db');let s=new Store(path);s.session('claude:s1','claude','test-only');s.command('claude:s1',true,'cmd1',0);const t=s.start('claude:s1','turn1','o',{model:'native'},features('Add flag'),false);s.close();s=new Store(path);assert.equal(s.session('claude:s1').enabled,true);assert.equal(s.task(t.id).state,'abandoned');assert.throws(()=>s.route(t.id,'o'));s.close();rmSync(dir,{recursive:true,force:true});});
test('database is private; purge clears history and session preferences',()=>withStore((s,path)=>{assert.equal(statSync(path).mode&0o777,0o600);s.session('claude:s1','claude','test-only');s.purge();assert.equal(s.history().sessions.length,0);}));
test('unknown baseline and smaller-window candidates do not receive the task',()=>{const t=task();t.baseline.model='unknown';assert.equal(decide(session(),t,caps).action,'passthrough');const c=structuredClone(caps);for(const candidate of c.candidates)if(candidate.model!=='native')candidate.contextWindow=1;assert.equal(decide(session(),task(),c).route.model,'native');});
test('a catalog with one model cannot route',()=>{assert.equal(decide(session(),task(),{...caps,candidates:[caps.candidates[0]!]}).action,'passthrough');});

const P=(model:string,input:number,output:number,cacheRead:number,cacheWrite5m:number)=>({model,date:'2026-11-07',source:'https://example.invalid',input,output,cacheRead,cacheWrite5m});
const prices=[P('fixture-strong',4,20,0.2,5),P('fixture-balanced',2,10,0.1,2.5),P('fixture-light',0.1,0.5,0.01,0.125)];
const warm=(contextTokens?:number,idleMs=1000)=>({lastModel:'fixture-strong',idleMs,contextTokens});
test('switch guard: unpriced downgrade is held only for a large warm context, and never when the cache is cold',()=>{
 assert.equal(decide(session(),task('Find the README'),caps,[],warm(500000)).route.model,'fixture-strong');
 assert.equal(decide(session(),task('Find the README'),caps,[],warm(5000)).route.model,'fixture-light');
 assert.equal(decide(session(),task('Find the README'),caps,[],warm(500000,3_700_000)).route.model,'fixture-light');
 assert.equal(decide(session(),task('Find the README'),caps,[],warm(undefined)).route.model,'fixture-strong');
});
test('switch guard: priced downgrade is held until the saving pays back the uncached re-read',()=>{
 const d=(text:string,ctx:number)=>decide(session(),task(text),caps,prices,warm(ctx));
 assert.equal(d('Find the README',200000).route.model,'fixture-light'); // cheap target: even uncached it undercuts the strong model's cache read
 const big=decide(session(),task('Implement a flag'),caps,prices,warm(200000));assert.equal(big.route.model,'fixture-strong');assert.ok(big.reasons.includes('cache-switch-not-paid-back'));
 const small=decide(session(),task('Implement a flag'),caps,prices,warm(1000));assert.equal(small.route.model,'fixture-balanced');assert.ok(small.reasons.includes('cache-switch-paid-back'));
});
test('switch guard: upgrades, pins and the first request are never held',()=>{
 const up=decide(session(),task('Implement OAuth login'),caps,prices,{lastModel:'fixture-light',idleMs:10,contextTokens:900000});assert.equal(up.route.model,'fixture-strong');
 assert.equal(decide(session(),task('Find the README'),caps,prices,undefined).route.model,'fixture-light');
});
test('price import rejects incomplete, non-HTTPS and duplicate entries',()=>{
 const ok={host:'claude',model:'m1',date:'2026-11-07',source:'https://example.invalid/p',input:1,output:2,cacheRead:0.1};
 assertPrices([ok]);
 for(const bad of [[],{},[{...ok,source:'http://x'}],[{...ok,date:'yesterday'}],[{...ok,cacheRead:undefined}],[{...ok,input:-1}],[ok,ok],[{...ok,maxContext:1.5}],[{...ok,host:'x'}]])assert.throws(()=>assertPrices(bad as any));
});



const HAIKU={model:'h',date:'2026-11-07',source:'https://example.invalid',input:0.1,output:0.5,cacheRead:0.01,cacheWrite5m:0.125,cacheWrite1h:0.2,longContext:{threshold:100000,input:0.5,output:2.5,cacheRead:0.05,cacheWrite5m:0.625,cacheWrite1h:1}};
const OPUS={model:'o',date:'2026-11-07',source:'https://example.invalid',input:4,output:20,cacheRead:0.2,cacheWrite5m:5,cacheWrite1h:8};
const U=(o:Partial<Record<string,number|null>>)=>({input:2,output:1000,cacheRead:50000,cacheWrite:1000,reasoning:null,cacheWrite5m:null,cacheWrite1h:null,...o}) as any;
test('long-context tier is chosen per request from the whole prompt, cache included',()=>{
 assert.equal(effectiveRates(HAIKU,100000).input,0.1);assert.equal(effectiveRates(HAIKU,100001).input,0.5);assert.equal(effectiveRates(OPUS,9e9).input,4);
 const small=equivalentRange(U({}),HAIKU)!,big=equivalentRange(U({cacheRead:150000}),HAIKU)!;
 assert.ok(Math.abs(small.low-(2*0.1+1000*0.5+50000*0.01+1000*0.125)/1e6)<1e-12);
 assert.ok(Math.abs(big.high-(2*0.5+1000*2.5+150000*0.05+1000*1)/1e6)<1e-12);
});
test('cost range spans the 5-minute and 1-hour cache-write rates when the split is unknown, and is exact when known',()=>{
 const r=equivalentRange(U({}),OPUS)!;assert.ok(r.high>r.low);assert.ok(Math.abs((r.high-r.low)-1000*(8-5)/1e6)<1e-12);
 const exact=equivalentRange(U({cacheWrite5m:400,cacheWrite1h:600}),OPUS)!;assert.equal(exact.low,exact.high);
 assert.equal(equivalentRange(U({cacheWrite5m:400,cacheWrite1h:null}),OPUS),null,'inconsistent split stays unknown');
 assert.equal(equivalentRange(U({cacheRead:null}),OPUS),null);assert.equal(equivalentRange(undefined,OPUS),null);
 assert.equal(equivalentRange(U({}),{...OPUS,cacheWrite1h:undefined}),null);
 assert.equal(equivalentRange(U({cacheWrite:0}),{...OPUS,cacheWrite5m:undefined,cacheWrite1h:undefined})!.low,(2*4+1000*20+50000*0.2)/1e6);
});
test('price import validates the long-context tier',()=>{
 const ok={host:'claude',model:'m1',date:'2026-11-07',source:'https://example.invalid/p',input:1,output:2,cacheRead:0.1};
 assertPrices([{...ok,longContext:{threshold:100000,input:2,output:4,cacheRead:0.2}}]);
 for(const bad of [{threshold:0,input:2,output:4,cacheRead:0.2},{threshold:1,input:2,output:4},{threshold:1.5,input:2,output:4,cacheRead:0.2},{threshold:1,input:-2,output:4,cacheRead:0.2}])assert.throws(()=>assertPrices([{...ok,longContext:bad}]));
});
