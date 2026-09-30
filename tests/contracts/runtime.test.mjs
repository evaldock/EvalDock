import test from 'node:test';import assert from 'node:assert/strict';
import {latestCompletedTurn,historySequence,cancelSessionAndWait} from '../../dist/src/runtime/session-lifecycle.js';
test('completion belongs to events after submission rather than historical turn endings',()=>{
 const history={events:[{event:{type:'turn/end',seq:3}},{event:{type:'assistant/message',seq:7}}],projections:{asOfSeq:7}};
 assert.equal(historySequence(history),7);assert.equal(latestCompletedTurn(history,3),undefined);
 history.events.push({event:{type:'turn/end',seq:8,data:{reason:{kind:'completed'}}}});
 assert.equal(latestCompletedTurn(history,7).seq,8);
});
test('cancel waits for the selected session to become idle',async()=>{
 const calls=[];let polls=0;
 await cancelSessionAndWait(async(method)=>{calls.push(method);return method==='session.list'?{items:[{sessionId:'target',running:++polls<3},{sessionId:'other',running:true}]}:{};},'target',{pollMs:1,timeoutMs:1000});
 assert.equal(polls,3);assert.equal(calls[0],'session.cancel');
});
test('unconfirmed or unreadable cancellation is never reported as stopped',async()=>{
 await assert.rejects(cancelSessionAndWait(async()=>({items:[{sessionId:'target',running:true}]}),'target',{pollMs:1,timeoutMs:3}),/UNCONFIRMED/);
 await assert.rejects(cancelSessionAndWait(async()=>({}),'target'),/UNKNOWN/);
});
