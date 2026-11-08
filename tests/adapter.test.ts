import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerAdapter,type Bridge} from '../src/adapters/claude.js';
import {Store} from '../src/service/store.js';
import {features,validCapabilities} from '../src/core/policy.js';
import {caps} from './fixtures.js';
function harness() {
 const dir=mkdtempSync(join(tmpdir(),'autoroute-adapter-')),store=new Store(join(dir,'db'));store.setCatalog(caps);
 const handlers=new Map<string,Function>(),logs:string[]=[],writes:any[]=[],classifierCalls:any[]=[];let ctxTokens=1000;
 // Stand-in for the cheap model: answers with the rule-based features of the quoted request, unless a test overrides it.
 let classifierReply:(o:any)=>Promise<any>=async o=>{const text=/<request>\n([\s\S]*)\n<\/request>/.exec(o.prompt)?.[1]??'';const f=features(text);return {isAnswered:true,text:JSON.stringify({activity:f.activity,complexity:f.complexity,risk:f.risk,uncertain:f.uncertain})};};
 const bridge:Bridge={plugin:{root:'fixture'},fs:{read:async()=>''},http:{fetch:async()=>{throw new Error('unused');}},session:{usage:async()=>({context:{tokens:ctxTokens}}),id:async()=>'s1',model:async()=>'native',version:async()=>({version:'2.1.317'})},model:{complete:async o=>{classifierCalls.push(o);return classifierReply(o);}},command:{register:async()=>{}},env:{get:async()=>'claude-desktop'},ui:{log:m=>logs.push(m)}};
 const client=async(path:string,b:any={})=>{writes.push({path,...b});switch(path){case '/v1/session':{const x=store.session(b.key,b.host,b.hostVersion,b.defaultEnabled);return {...x,routable:validCapabilities(store.catalog(x.host),x)};}case '/v1/command':return store.command(b.key,b.enabled,b.commandId,b.revision);case '/v1/pin':return store.pin(b.key,{model:b.model,effort:b.effort});case '/v1/task':return store.start(b.key,b.turnId,b.owner,b.baseline,b.features,b.override);case '/v1/decide':return store.route(b.taskId,b.owner,b.cache);case '/v1/finish':return store.finish(b.taskId,b.state);case '/v1/events':return undefined;default:throw new Error('unexpected');}};
 registerAdapter((event,handler)=>{handlers.set(event,handler);return {catch:()=>undefined};},client);
 const invoke=(name:string,e:any,next:Function=async(e:any)=>e)=>handlers.get(name)!(bridge,e,next);
 const close=()=>{store.close();rmSync(dir,{recursive:true,force:true});};return {store,invoke,close,bridge,handlers,writes,logs,classifierCalls,setClassifier:(f:(o:any)=>Promise<any>)=>{classifierReply=f;},setContext:(n:number)=>{ctxTokens=n;}};
}
async function step(h:ReturnType<typeof harness>,turnId:string,eventExtra:any={}){let sent:any,calls=0;async function* next(e:any){calls++;sent=e;yield {delta:'unchanged'};return {usage:{model:e.model},stopReason:'end_turn'};}const stream=h.invoke('turn.step',{turnId,index:0,model:'native',effort:'medium',messageCount:1,...eventExtra},next);const chunks=[];for await(const x of stream)chunks.push(x);assert.equal(calls,1);assert.deepEqual(chunks,[{delta:'unchanged'}]);return sent;}
test('one-task routing preserves attachment object, streams once, restores following task',async()=>{const h=harness();try{await h.invoke('session.start',{});const attachments=[{type:'image',opaque:'do-not-copy'}];await h.invoke('prompt.submit',{text:'/autoroute-task-on Implement OAuth',attachments,origin:{kind:'composer'}},async(e:any)=>{assert.equal(e.attachments,attachments);assert.equal(e.text,'Implement OAuth');await h.invoke('turn.start',{turnId:'t1',text:e.text});});assert.equal((await step(h,'t1')).model,'fixture-strong');await h.invoke('turn.complete',{turnId:'t1'});await h.invoke('prompt.submit',{text:'Implement another flag',origin:{kind:'composer'}},async(e:any)=>h.invoke('turn.start',{turnId:'t2',text:e.text}));assert.equal((await step(h,'t2')).model,'native');assert.equal(h.store.session('claude:s1').enabled,false);}finally{h.close();}});
test('mid-turn task commands are rejected and no override bleeds into steering',async()=>{const h=harness();try{await h.invoke('session.start',{});let calls=0;const r=await h.invoke('prompt.submit',{text:'/autoroute-task-on new task',turnId:'active',origin:{kind:'composer'}},()=>calls++);assert.ok(r.drop);assert.equal(calls,0);}finally{h.close();}});
test('task slash dispatch before submission fails explicitly without re-submission',async()=>{const h=harness();try{const r=await h.invoke('command.run',{command:'autoroute-task-on',args:'foo',origin:{kind:'composer'}});assert.match(r.text,/nothing was sent/);assert.equal(h.writes.length,0);}finally{h.close();}});
test('model errors are never replayed by adapter',async()=>{const h=harness();try{await h.invoke('session.start',{});let calls=0;async function* bad(){calls++;throw new Error('model-failure');yield 0;}await assert.rejects(async()=>{for await(const _ of h.invoke('turn.step',{turnId:'unknown',model:'native'},bad)){}},/model-failure/);assert.equal(calls,1);}finally{h.close();}});
test('non-user commands cannot enable routing',async()=>{const h=harness();try{await h.invoke('session.start',{});await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'plugin',name:'other'}});assert.equal(h.store.session('claude:s1').enabled,false);}finally{h.close();}});
test('a host older than the catalog requires keeps native settings',async()=>{const h=harness();try{h.bridge.session.version=async()=>({version:'2.0.1'});await h.invoke('session.start',{});await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});await h.invoke('prompt.submit',{text:'Implement OAuth',origin:{kind:'composer'}},async(e:any)=>h.invoke('turn.start',{turnId:'upgrade',text:e.text}));assert.equal((await step(h,'upgrade')).model,'native');}finally{h.close();}});
test('late decision after cancellation never rewrites the native request',async()=>{const h=harness();try{await h.invoke('session.start',{});await h.invoke('prompt.submit',{text:'/autoroute-task-on Implement OAuth',origin:{kind:'composer'}},async(e:any)=>h.invoke('turn.start',{turnId:'late',text:e.text}));const controller=new AbortController();controller.abort();let sent:any;const next:any=async function*(e:any){sent=e;return {usage:null,stopReason:null};};next.signal=controller.signal;for await(const _ of h.invoke('turn.step',{turnId:'late',index:0,model:'native',effort:'medium'},next)){}assert.equal(sent.model,'native');}finally{h.close();}});
async function runTask(h:ReturnType<typeof harness>,turnId:string,text:string){await h.invoke('prompt.submit',{text,origin:{kind:'composer'}},async(e:any)=>h.invoke('turn.start',{turnId,text:e.text}));const sent=await step(h,turnId);await h.invoke('turn.complete',{turnId});return sent;}
test('the classification from the cheap model, not keyword rules, drives the route',async()=>{const h=harness();try{await h.invoke('session.start',{});await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});h.setClassifier(async()=>({isAnswered:true,text:'Sure.\n{"activity":"docs","complexity":0,"risk":false,"uncertain":false}'}));assert.equal((await runTask(h,'ru1','Fix the typo in the README')).model,'fixture-light');h.setClassifier(async()=>({isAnswered:true,text:'{"activity":"debug","complexity":6,"risk":true,"uncertain":false}'}));const sent=await runTask(h,'ru2','Fix the login bug and drop the production database migration');assert.equal(sent.model,'fixture-strong');assert.equal(h.classifierCalls.length,2);const c=h.classifierCalls[1];assert.equal(c.model,'haiku');assert.equal(c.effort,'low');assert.match(c.prompt,/Fix the login bug/);}finally{h.close();}});
test('classifier failure, timeout or malformed answer keeps native settings',async()=>{const h=harness();try{await h.invoke('session.start',{});await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});const replies:Array<()=>Promise<any>>=[async()=>({isAnswered:false,reason:'api-error'}),async()=>({isAnswered:true,text:'banana'}),async()=>({isAnswered:true,text:'{"activity":"implement","complexity":99,"risk":false,"uncertain":false}'}),async()=>{throw new Error('model blocked by organization');}];let i=0;for(const r of replies){h.setClassifier(r);assert.equal((await runTask(h,'f'+i,'Implement OAuth login')).model,'native');i++;}assert.equal(h.classifierCalls.length,4);}finally{h.close();}});
test('no classifier call when routing is off or the host is not routable',async()=>{const h=harness();try{await h.invoke('session.start',{});assert.equal((await runTask(h,'off1','Implement OAuth login')).model,'native');assert.equal(h.classifierCalls.length,0);await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});h.bridge.session.version=async()=>({version:'2.0.1'});h.store.session('claude:s1','claude','2.0.1');await h.invoke('session.start',{});assert.equal((await runTask(h,'off2','Implement OAuth login')).model,'native');}finally{h.close();}});
test('turn.start after prompt.submit has returned still tracks the task (real host order)',async()=>{const h=harness();try{await h.invoke('session.start',{});await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});h.setClassifier(async()=>({isAnswered:true,text:'{"activity":"debug","complexity":6,"risk":true,"uncertain":false}'}));await h.invoke('prompt.submit',{text:'Fix the login bug',origin:{kind:'composer'}});await h.invoke('turn.start',{turnId:'late-start'});assert.equal((await step(h,'late-start')).model,'fixture-strong');await h.invoke('turn.complete',{turnId:'late-start'});await h.invoke('turn.start',{turnId:'no-prompt'});assert.equal((await step(h,'no-prompt')).model,'native');}finally{h.close();}});

test('a downgrade is held for a large warm context and allowed for a small one',async()=>{const h=harness();try{await h.invoke('session.start',{});await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});const strong='{"activity":"debug","complexity":6,"risk":true,"uncertain":false}',light='{"activity":"docs","complexity":0,"risk":false,"uncertain":false}';h.setClassifier(async()=>({isAnswered:true,text:strong}));assert.equal((await runTask(h,'c1','Fix auth')).model,'fixture-strong');h.setClassifier(async()=>({isAnswered:true,text:light}));h.setContext(500000);assert.equal((await runTask(h,'c2','Fix a typo')).model,'fixture-strong');h.setContext(2000);assert.equal((await runTask(h,'c3','Fix a typo')).model,'fixture-light');}finally{h.close();}});
test('an old host is reported as unsupported, not as routing-off, and makes no classifier call',async()=>{const h=harness();try{await h.invoke('session.start',{});await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});h.store.setCatalog({...caps,minHostVersion:'9.0.0'});await runTask(h,'u1','Explain DNS');assert.equal(h.classifierCalls.length,0);const t=h.store.history().tasks[0];assert.equal(t.enabled,true);assert.equal(t.state,'completed');assert.ok(h.writes.some(w=>w.path==='/v1/decide'));}finally{h.close();}});
test('namespaced command spelling reaches the same handler and status reports whether routing is active',async()=>{const h=harness();try{await h.invoke('session.start',{});const on=await h.invoke('command.run',{command:'autoroute:autoroute-on',args:'',origin:{kind:'composer'}});assert.match(on.text,/Routing is ON/);assert.equal(h.store.session('claude:s1').enabled,true);const st=await h.invoke('command.run',{command:'autoroute:autoroute-status',args:'',origin:{kind:'composer'}});assert.match(st.text,/Routing is ON.*Autoroute chooses/);h.store.setCatalog({...caps,minHostVersion:'9.0.0'});const st2=await h.invoke('command.run',{command:'autoroute-status',args:'',origin:{kind:'composer'}});assert.match(st2.text,/older than Autoroute supports/);}finally{h.close();}});

test('a rejected service key is reported once instead of failing silently',async()=>{
 const handlers=new Map<string,Function>(),logs:string[]=[];
 const bridge:Bridge={plugin:{root:'fixture'},fs:{read:async()=>JSON.stringify({url:'http://127.0.0.1:1',token:'a'.repeat(64)})},http:{fetch:async()=>({ok:false,status:401,text:'{}'})},session:{usage:async()=>({}),id:async()=>'s1',model:async()=>'native',version:async()=>({version:'2.1.317'})},model:{complete:async()=>({isAnswered:false})},command:{register:async()=>{}},env:{get:async()=>'claude-desktop'},ui:{log:m=>logs.push(m)}};
 registerAdapter(((name:string,h:Function)=>{handlers.set(name,h);return Promise.resolve();}) as any);
 await handlers.get('session.start')!(bridge,{},async(e:any)=>e);
 assert.equal(logs.length,1);
 assert.match(logs[0]??'',/rejected this conversation's key.*autoroute setup/);
});

test('dashboard command replies with the link, or says the service is down',async()=>{
 const h=harness();
 try{
  await h.invoke('session.start',{});
  const ok=await h.invoke('command.run',{command:'autoroute-dashboard',args:'',origin:{kind:'composer'}});
  assert.match(ok.text,/http:\/\/127\.0\.0\.1:\d+\//);
 }finally{h.close();}
});


test('defaultRouting "on" starts new conversations with routing on',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'autoroute-default-')),store=new Store(join(dir,'db'));store.setCatalog(caps);
 const handlers=new Map<string,Function>();
 const client=async(path:string,b:any={})=>path==='/v1/session'?store.session(b.key,b.host,b.hostVersion,b.defaultEnabled):undefined;
 registerAdapter(((name:string,h:Function)=>{handlers.set(name,h);return {catch:()=>undefined};}) as any,client,{defaultRouting:'on'});
 const bridge:any={plugin:{root:'x'},env:{get:async()=>undefined},session:{id:async()=>'d1',version:async()=>({version:'2.1.317'}),root:async()=>'/tmp/p'},command:{register:async()=>{}},ui:{log:()=>{}}};
 try{await handlers.get('session.start')!(bridge,{},async(e:any)=>e);assert.equal(store.session('claude:d1').enabled,true);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('routing turns itself off after the host twice answers with a different model',async()=>{
 const h=harness();
 try{
  await h.invoke('session.start',{});
  await h.invoke('command.run',{command:'autoroute-on',args:'',origin:{kind:'composer'}});
  h.setClassifier(async()=>({isAnswered:true,text:'{"activity":"debug","complexity":6,"risk":true,"uncertain":false}'}));
  for(const id of ['m1','m2']){
   await h.invoke('prompt.submit',{text:'Fix auth',origin:{kind:'composer'}},async(e:any)=>h.invoke('turn.start',{turnId:id,text:e.text}));
   async function* next(e:any){return {usage:{model:'some-other-model'},stopReason:'end_turn'};}
   for await(const _ of h.invoke('turn.step',{turnId:id,index:0,model:'native',effort:'medium'},next)){}
   await h.invoke('turn.complete',{turnId:id});
  }
  assert.equal(h.store.session('claude:s1').enabled,false);
  assert.ok(h.logs.some(l=>/turned routing off.*some-other-model/.test(l)));
 }finally{h.close();}
});
