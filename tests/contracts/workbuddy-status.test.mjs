import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWorkBuddy} from '../../adapters/workbuddy/status.mjs';

function fixture({version='5.7.7',bundle='com.tencent.workbuddy.mac',authenticated=true,error}={}){
 const calls=[];
 return {calls,options:{execCommand:async()=>({stdout:JSON.stringify({CFBundleIdentifier:bundle,CFBundleShortVersionString:version})}),connect:async()=>{calls.push('connect');if(error)throw Error(error);return {authenticated:async()=>{calls.push('auth');return authenticated;},close(){calls.push('close');}};}}};
}
test('WorkBuddy admits working interfaces regardless of release number',async()=>{
 for(const version of ['5.5.6','5.6.2','5.7.7','6.0.0']){
  const f=fixture({version}),s=await inspectWorkBuddy(f.options);
  assert.equal(s.version,version);assert.equal(s.evaluationReady,true);assert.equal(s.status,'READY');
  assert.deepEqual(f.calls,['connect','auth','close']);
 }
});
test('WorkBuddy reports actual connection and interface failures',async()=>{
 for(const error of ['WORKBUDDY_NOT_CONNECTED','WORKBUDDY_INTERFACE_CHANGED','WORKBUDDY_EVENT_TRANSPORT_UNAVAILABLE']){
  const f=fixture({error}),s=await inspectWorkBuddy(f.options);
  assert.equal(s.evaluationReady,false);assert.equal(s.reasonCode,error);assert.notEqual(s.status,'NOT_INSTALLED');
 }
 const f=fixture({authenticated:false}),s=await inspectWorkBuddy(f.options);
 assert.equal(s.status,'LOGIN_REQUIRED');assert.equal(s.evaluationReady,false);assert.deepEqual(f.calls,['connect','auth','close']);
});
test('WorkBuddy rejects the wrong application before connecting',async()=>{
 const f=fixture({bundle:'other.app'}),s=await inspectWorkBuddy(f.options);
 assert.equal(s.evaluationReady,false);assert.equal(s.reasonCode,'WORKBUDDY_APP_ID_MISMATCH');assert.deepEqual(f.calls,[]);
});

test('desktop interface checks distinguish missing invocation and event transport',async()=>{
 const {Desktop}=await import('../../adapters/workbuddy/desktop.mjs');
 const {default:vm}=await import('node:vm');
 for(const [window,MessageChannel,error] of [
  [{},class{},'WORKBUDDY_INTERFACE_CHANGED'],
  [{__wbInvoke(){}},class{},'WORKBUDDY_EVENT_TRANSPORT_UNAVAILABLE'],
  [{__wbInvoke(){},postMessage(){}},undefined,'WORKBUDDY_EVENT_TRANSPORT_UNAVAILABLE'],
  [{__wbInvoke(){},postMessage(){}},class{},null],
 ]){
  const context=vm.createContext({window,MessageChannel});
  const driver={evaluate:async expression=>vm.runInContext(expression,context)};
  if(error)await assert.rejects(Desktop.prototype.checkInterfaces.call(driver),{message:error});
  else await Desktop.prototype.checkInterfaces.call(driver);
 }
});

test('failed login inspection closes the transport and clears readiness',async()=>{
 let closed=false;
 const f=fixture();f.options.connect=async()=>({authenticated:async()=>{throw Error('WORKBUDDY_RPC_REJECTED');},close(){closed=true;}});
 const s=await inspectWorkBuddy(f.options);
 assert.equal(s.reasonCode,'WORKBUDDY_RPC_REJECTED');assert.equal(s.evaluationReady,false);assert.equal(s.probeReady,false);assert.equal(s.executionReady,false);assert.equal(closed,true);
});
