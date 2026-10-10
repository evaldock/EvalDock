import test from 'node:test';import assert from 'node:assert/strict';
import {Capture,normalizedEvent} from '../../adapters/shared/capture.mjs';
import {hermesEvent,restoreHermesEvidence} from '../../adapters/hermes/adapter.mjs';
import {validateCapture} from '../../adapters/compatibility/contracts.mjs';
test('Hermes native IDs restore parallel CLI evidence without pairing by order',()=>{
 const c=new Capture('hermes');for(const name of ['read','write'])hermesEvent({type:'tool_use',name,input:{}},c);
 for(const name of ['write','read'])hermesEvent({type:'tool_result',name,output:name},c);
 c.cleanup='STOPPED';c.result={stopReason:'end_turn'};c.finalText('done');
 const rows=[{role:'assistant',tool_calls:JSON.stringify([{id:'a',function:{name:'read',arguments:'{}'}},{id:'b',function:{name:'write',arguments:'{}'}}])},{role:'tool',tool_call_id:'b',tool_name:'write',content:'written'},{role:'tool',tool_call_id:'a',tool_name:'read',content:'read'}];
 for(const [i,row] of rows.entries())row.timestamp=1700000000+i;
 const restored=restoreHermesEvidence(c.finish(),rows);
 assert.equal(restored.queue.find(r=>r.event.type==='tool/result'&&r.event.data.callId==='b').at,new Date(1700000001000).toISOString());
 assert.deepEqual(validateCapture({trace:{normalizeEvent:normalizedEvent}},restored,{required:['tools'],controlled:true}),[]);
 assert.equal(restored.queue.find(r=>r.event.type==='tool/result'&&r.event.data.callId==='b').event.data.result,'written');
 assert.throws(()=>restoreHermesEvidence(c.finish(),rows.slice(0,-1)),/EVIDENCE_INCOMPLETE/);
});
test('Hermes Interrupted result cannot overwrite a host-observed cancellation',()=>{
 const c=new Capture('hermes');c.error='AGENT_CANCELLED';hermesEvent({type:'result',exit_code:130,error:'Interrupted'},c);assert.equal(c.error,'AGENT_CANCELLED');
});
