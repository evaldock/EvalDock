import test from 'node:test';
import assert from 'node:assert/strict';
import {DshControl} from '../../workbench/lib/dsh-control.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';
import {temporary} from './support.mjs';
test('DSH 401 preserves static plugins and sibling Agent history, and cannot permit DSH mutations',async t=>{
 const root=await temporary(t),control=new DshControl(root);
 Object.assign(control,{descriptor:{webEndpoint:'http://127.0.0.1:1',profile:'web'},env:{},testPolicy:{},jobs:{children:new Map(),jobs:new Map(),view:x=>x},plugins:async()=>({revision:'r',profile:{dsh:{profile:{bundles:[]}}},catalog:[{name:'saved-plugin'}]}),core:{dshConfiguration:async()=>({agentId:'dsh',plugins:[]}),dshStatus:async()=>{throw Error('DSH_WEB_HTTP_401');}},currentInspection:async()=>({source:'CURRENT_CONFIGURATION'}),externalRuns:{get:async()=>[]},results:{}});
 const state=await control.status();assert.equal(state.plugins.length,1);assert.equal(state.externalEval,null);assert.match(state.error,/DSH/);await assert.rejects(control.idle(),/DSH/);
 const pi={active:false,records:async()=>({jobs:[{runId:'run',state:'SUCCEEDED'}],runs:[{run:{id:'run'},agentKind:'pi'}]})},workbuddy={active:false,records:async()=>({jobs:[],runs:[]})};
 const {server}=await startControlServer({root,port:0,controller:control,workbuddyController:workbuddy,agentControllers:{pi}});t.after(()=>new Promise(r=>server.close(r)));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/control/status');assert.equal(response.status,200);const data=await response.json();assert.equal(data.runs[0].agentKind,'pi');assert.equal(data.jobs[0].runId,'run');assert.ok(data.csrf);
});
