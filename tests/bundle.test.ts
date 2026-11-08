import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
test('production register treats host options as options, not an injected HTTP client',async()=>{
 const {register}=await import(pathToFileURL(resolve('plugin/hooks/register.mjs')).href);
 const handlers=new Map<string,Function>();register((name:string,fn:Function)=>{handlers.set(name,fn);return {catch:()=>undefined};},{someHostOption:true});
 let reads=0,network=0;const commands:string[]=[];const bridge={plugin:{root:'fixture'},fs:{read:async()=>{reads++;return JSON.stringify({url:'http://127.0.0.1:1',token:'1'.repeat(64)});}},http:{fetch:async()=>{network++;return {ok:true,text:'{}'};}},session:{id:async()=>'s1',version:async()=>({version:'actual'}),model:async()=>'native'},env:{get:async()=>'claude-desktop'},ui:{log:()=>{}},command:{register:async(spec:{name:string})=>{commands.push(spec.name);}}};
 await handlers.get('session.start')!(bridge,{},async(e:unknown)=>e);assert.equal(reads,1);assert.equal(network,1);assert.deepEqual([...commands].sort(),['autoroute-dashboard','autoroute-off','autoroute-on','autoroute-status','autoroute-task-off','autoroute-task-on']);
});
test('dashboard script parses and has no line comment inside its one-line functions',async()=>{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm');
 const src=readFileSync(resolve('web/app.js'),'utf8');
 assert.doesNotThrow(()=>new vm.Script(src,{filename:'web/app.js'}));
 assert.ok(!/;\s*\/\/[^\n]*\$\(/.test(src),'a // comment on a code line would swallow the code after it');
});
