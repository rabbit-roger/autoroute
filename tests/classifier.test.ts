import test from 'node:test';
import assert from 'node:assert/strict';
import {parseClassification,classify} from '../src/core/classifier.js';
test('classification is parsed strictly and carries the attachment flag',()=>{
 assert.deepEqual(parseClassification('{"activity":"plan","complexity":7,"risk":false,"uncertain":true}',true),{activity:'plan',complexity:7,risk:false,uncertain:true,attachment:true});
 for(const bad of [undefined,'','no json','{"activity":"x","complexity":1,"risk":false,"uncertain":false}','{"activity":"docs","complexity":1.5,"risk":false,"uncertain":false}','{"activity":"docs","complexity":-1,"risk":false,"uncertain":false}','{"activity":"docs","complexity":1,"risk":"no","uncertain":false}','{"activity":"docs","complexity":1}','{broken'])assert.equal(parseClassification(bad as any,false),undefined);
});
test('classify truncates the prompt and never throws',async()=>{
 let seen:any;const ok=await classify({model:{complete:async o=>{seen=o;return {isAnswered:true,text:'{"activity":"explain","complexity":1,"risk":false,"uncertain":false}'};}}},'\u044f'.repeat(9000),false);
 assert.equal(ok.features?.activity,'explain');assert.ok(seen.prompt.length<4100);assert.equal(seen.model,'haiku');assert.equal(seen.effort,'low');
 assert.equal((await classify({model:{complete:async()=>{throw new Error('x');}}},'hi',false)).features,undefined);
});
