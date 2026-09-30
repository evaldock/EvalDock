import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {temporary,json} from './support.mjs';
import {ControlResults} from '../../workbench/lib/control-results.mjs';
import {WorkBuddyControl} from '../../workbench/lib/workbuddy-control.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';

test('WorkBuddy readiness is explicit, installation does not imply login',async()=>{
  const control=new WorkBuddyControl({inspect:async()=>({status:'LOGIN_REQUIRED',evaluationReady:false,executionReady:true,probeReady:true})});
  assert.equal((await control.status()).evaluationReady,false);
});

test('WorkBuddy status is independent of DSH, and cannot route mutations to DSH',async t=>{
  let dshCalls=0;
  const controller={jobs:{children:new Map()},status:async()=>({status:'STOPPED',jobs:[],runs:[]}),action:async()=>{dshCalls++;},run:async()=>{dshCalls++;}};
  const {server}=await startControlServer({root:await temporary(t),port:0,controller,workbuddyController:{status:async()=>({agentKind:'workbuddy',evaluationReady:false}),run:async()=>{throw new Error('WORKBUDDY_LOGIN_REQUIRED');}}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  assert.deepEqual(await(await fetch(base+'/api/control/workbuddy/status')).json(),{agentKind:'workbuddy',evaluationReady:false});
  const {csrf}=await(await fetch(base+'/api/control/status')).json();
  for(const route of ['run','service'])assert.equal((await fetch(base+'/api/control/workbuddy/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':csrf},body:'{}'})).status,route==='run'?409:404);
  assert.equal(dshCalls,0);
});

test('WorkBuddy and legacy DSH reports use the same results and retain real zero scores and errors',async t=>{
  const root=await temporary(t),base=path.join(root,'var/evaluation-results/agents/work/runs/run');
  const scores=[{labelId:'tool.code',score:0,weight:2,status:'SCORED',scale:{min:0,max:5}},{labelId:'loop',score:null,status:'ERROR',reason:'JUDGE_RESPONSE_EMPTY'}];
  await json(path.join(base,'run.json'),{agentKind:'workbuddy',status:'COMPLETED',totalCaseCount:1,caseResults:[{caseId:'case',datasetId:'dataset',status:'COMPLETED'}]});
  await json(path.join(base,'cases/case/report.json'),{target:{agentKind:'workbuddy',agentVersion:'1.2'},inspection:{toolSchemas:[{name:'shell'}]},scores,execution:{exitCode:0,stdout:'WorkBuddy answer'},case:{question:{title:'Real task'}}});
  const result=await new ControlResults(root).get({targetId:'work',runId:'run',events:[],state:'SUCCEEDED'});
  assert.equal(result.agentKind,'workbuddy');assert.equal(result.run.targetSummary,'WorkBuddy / 1.2');
  assert.equal(result.run.target.profile,undefined);assert.equal(result.run.staticPlugins,undefined);
  assert.equal(result.run.cases[0].scores['tool.code'].value,0);assert.equal(result.run.cases[0].scores['tool.code'].state,'scored');
  assert.equal(result.run.cases[0].scores.loop.state,'error');assert.equal(result.run.cases[0].weight,2);
  assert.equal(result.runtime['work::run::case'].execution.stdout,'WorkBuddy answer');assert.deepEqual(result.run.target.toolNames,['shell']);
  const legacy=await new ControlResults(root).get({targetId:'old',runId:'run',events:[],state:'SUCCEEDED'});
  assert.equal(legacy.agentKind,'dsh');assert.equal(legacy.run.target.profile,'web');
});

test('WorkBuddy static inspection does not inherit current DSH tools or plugin fields',async()=>{
  const html=await readFile('workbench/design-prototypes/index.html','utf8');
  const source=html.slice(html.indexOf('function staticView(){'),html.indexOf('\nfunction planReason'));
  const context=vm.createContext({activeRun:{agentKind:'workbuddy',target:{agentVersion:'2',toolNames:['WORK_TOOL']}},controlSnapshot:{staticInspection:{plugins:[{name:'DSH_PLUGIN'}],target:{dshVersion:'DSH_VERSION',toolNames:['DSH_TOOL']}}},currentAgentName:()=> 'WorkBuddy',esc:String,metaTable:JSON.stringify,observedToolList:JSON.stringify,observedPluginList:()=>{throw Error('WorkBuddy has no plugin section');},section:(_title,body)=>body});
  vm.runInContext(source,context);const rendered=vm.runInContext('staticView()',context);
  assert.ok(rendered.includes('WORK_TOOL'));assert.ok(rendered.includes('WorkBuddy 版本'));
  for(const value of ['DSH_TOOL','DSH_PLUGIN','DSH 版本','Profile','插件声明'])assert.ok(!rendered.includes(value),value);
});

test('independent Agent runs may start together while each controller serializes its own mutations',async t=>{
  let dshCalls=0,wbCalls=0,piCalls=0;
  let releaseDsh,releaseWb,releasePi,signalDsh,signalWb,signalPi;
  const dshStarted=new Promise(resolve=>{signalDsh=resolve;}),wbStarted=new Promise(resolve=>{signalWb=resolve;}),piStarted=new Promise(resolve=>{signalPi=resolve;});
  const dsh={jobs:{children:new Map()},status:async()=>({jobs:[],runs:[]}),run:async()=>{dshCalls++;signalDsh();await new Promise(resolve=>{releaseDsh=resolve;});return {};}};
  const work={active:false,run:async()=>{wbCalls++;signalWb();await new Promise(resolve=>{releaseWb=resolve;});return {};}};
  const pi={active:false,run:async()=>{piCalls++;signalPi();await new Promise(resolve=>{releasePi=resolve;});return {};}};
  const {server}=await startControlServer({root:await temporary(t),port:0,controller:dsh,workbuddyController:work,agentControllers:{pi}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port,{csrf}=await(await fetch(base+'/api/control/status')).json();
  const post=(route,token=csrf)=>fetch(base+'/api/control/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:'{}'});
  assert.equal((await post('workbuddy/run','invalid')).status,403);
  const dshRequest=post('run');await dshStarted;
  const wbRequest=post('workbuddy/run');await wbStarted;
  const piRequest=post('pi/run');await piStarted;
  assert.equal((await post('run')).status,409);
  assert.equal((await post('workbuddy/run')).status,409);
  assert.deepEqual([dshCalls,wbCalls,piCalls],[1,1,1]);
  releaseDsh();releaseWb();releasePi();
  assert.deepEqual(await Promise.all([dshRequest,wbRequest,piRequest].map(async request=>(await request).status)),[200,200,200]);
});
test('unconfirmed cleanup blocks a new run even when the previous job was cancelled',async t=>{
  const root=await temporary(t),control=new WorkBuddyControl({root,inspect:async()=>({status:'READY',evaluationReady:true})});
  control.jobs={jobs:new Map([['job',{id:'job',runId:'job',state:'CANCELLED'}]]),children:new Map()};
  await json(path.join(root,'var/evaluation-results/agents/workbuddy/runs/job/cases/case/session.json'),{runId:'job',caseId:'case',sessionId:'owned-session',cleanup:'UNKNOWN'});
  const s=await control.status();assert.equal(s.status,'RECOVERY_REQUIRED');assert.equal(s.evaluationReady,false);assert.equal(s.pendingCleanup,1);
});


test('bounded validation size is explicit, preserves the normal launch and rejects invalid selections',async()=>{
  const c=new WorkBuddyControl({inspect:async()=>({evaluationReady:true})}),launches=[],records=new Map();
  c.jobs={children:new Map(),jobs:new Map(),cliPrefix:['adapter.mjs'],start:async()=>{launches.push([...c.jobs.cliPrefix]);const job={id:'job-'+launches.length};records.set(job.id,job);return job;},get:id=>records.get(id),persist:async()=>{},view:j=>j};
  const ids=['dataset.memory-accurate-recall/v1','dataset.retrieval-hotpot-evidence/v1'];
  const j=await c.run({smoke:true,datasetCount:2,caseCount:4,datasetIds:ids});
  assert.deepEqual(j.validationConfig,{testSize:{datasetCount:2,caseCount:4},validationDatasetIds:ids});assert.equal(j.validationOnly,true);assert.equal(launches[0][1],'--validation-config');assert.deepEqual(c.jobs.cliPrefix,['adapter.mjs']);
  await c.run();assert.deepEqual(launches[1],['adapter.mjs']);
  for(const input of [{datasetCount:0},{datasetCount:2,caseCount:1},{caseCount:71},{datasetCount:2,caseCount:4,datasetIds:[ids[0],ids[0]]}])await assert.rejects(()=>c.run({smoke:true,...input}),/WORKBUDDY_INVALID_VALIDATION/);
  assert.equal(launches.length,2);
});
