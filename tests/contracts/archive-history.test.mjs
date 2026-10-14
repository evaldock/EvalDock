import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startControlServer} from '../../workbench/control-server.mjs';
import {temporary} from './support.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function server(t,controllers){
 const root=await temporary(t);
 const runtime=await startControlServer({root,port:0,...controllers,modelSettingsFile:path.join(root,'models.env'),agentModelSettings:{init:async()=>{}}});
 t.after(()=>new Promise(resolve=>runtime.server.close(resolve)));
 return 'http://127.0.0.1:'+runtime.server.address().port;
}
test('advanced archive history reads and merges saved records without probing Agents',async t=>{
 let probes=0;const status=async()=>{probes++;throw Error('No Agent probe is allowed');};
 const archived={id:'external-synthetic',targetId:'synthetic-pi',runId:'synthetic-run',createdAt:'2026-01-01',state:'SUCCEEDED',agentKind:'pi'},owned={...archived,id:'synthetic-controller'};
 const run={agentId:archived.targetId,agentKind:'pi',run:{id:archived.runId}};
 const quiet={status,records:async()=>({jobs:[],runs:[]})};
 const origin=await server(t,{controller:{status,records:async()=>({jobs:[archived],runs:[run]})},workbuddyController:quiet,agentControllers:{pi:{status,records:async()=>({jobs:[owned],runs:[run]})}}});
 const response=await fetch(origin+'/archive/api/history');assert.equal(response.status,200);const history=await response.json();
 assert.deepEqual(history.jobs,[owned]);assert.deepEqual(history.runs,[run]);assert.deepEqual(history.errors,[]);assert.equal(probes,0);
 assert.equal((await fetch(origin+'/archive/api/history',{headers:{origin:'https://outside.invalid'}})).status,403);
 assert.equal((await fetch(origin+'/archive/api/history',{method:'POST'})).status,405);assert.equal(probes,0);
});
test('archive history preserves readable records and reports a sibling store failure',async t=>{
 const quiet={records:async()=>({jobs:[],runs:[]})},job={id:'synthetic-readable',targetId:'synthetic-graph',runId:'synthetic-run',createdAt:'2026-01-01'};
 const origin=await server(t,{controller:quiet,workbuddyController:{records:async()=>{throw Error('SYNTHETIC_UNREADABLE_STORE');}},agentControllers:{langgraph:{records:async()=>({jobs:[job],runs:[]})}}});
 const response=await fetch(origin+'/archive/api/history');assert.equal(response.status,200);const history=await response.json();
 assert.deepEqual(history.jobs,[job]);assert.deepEqual(history.errors,['workbuddy 的记录暂时无法读取']);
});
test('advanced history keeps partial-error diagnostics and retained records after a failed refresh',async()=>{
 const source=await readFile('workbench/design-prototypes/control-ui.js','utf8'),history={jobs:[{id:'synthetic-retained'}],runs:[],errors:['workbuddy 的记录暂时无法读取']};
 const context=vm.createContext({sessionStorage:{getItem:()=>null},AbortSignal,applyControlRuns:()=>{},fetch:async route=>{assert.equal(route,'/archive/api/history');return {ok:true,json:async()=>history};}});
 vm.runInContext(source.slice(0,source.indexOf('\nconst controlPluginDescriptions')),context);
 await vm.runInContext('refreshArchiveHistory(true)',context);
 assert.equal(vm.runInContext('archiveError',context),history.errors[0]);
 context.fetch=async()=>({ok:false});await vm.runInContext('refreshArchiveHistory(true)',context);
 assert.equal(vm.runInContext('archiveSnapshot.jobs[0].id',context),'synthetic-retained');
 assert.match(vm.runInContext('archiveError',context),/已加载的记录仍保留/);
});
