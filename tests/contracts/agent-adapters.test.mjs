import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import vm from 'node:vm';
import {temporary} from './support.mjs';
import {Capture,runProcess,normalizedEvent,excerpt} from '../../adapters/shared/capture.mjs';
import {piEvent} from '../../adapters/pi/adapter.mjs';
import {langGraphEvent} from '../../adapters/langgraph/adapter.mjs';
import {buildTrace,collectFiles,snapshot,TRACE_MAX_BYTES} from '../../adapters/shared/evidence.mjs';
import {writeTraceDirectory,readTraceDirectory} from '../../dist/src/all-trace/store.js';
import {projectTraceOverview} from '../../dist/src/reporting/trace-overview.js';
import {startControlServer} from '../../workbench/control-server.mjs';
import {sessionForJob} from '../../workbench/live-observation.mjs';

test('Pi push events preserve distinct tools and final answer, omit token updates and fit the common Trace store',async t=>{
  const c=new Capture('pi');
  for(let i=0;i<12000;i++)piEvent({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'noise'}},c);
  for(let i=0;i<250;i++){
    piEvent({type:'tool_execution_start',toolCallId:'call-'+i,toolName:'read',args:{path:'input/file',body:'same body'.repeat(2000)}},c);
    piEvent({type:'tool_execution_end',toolCallId:'call-'+i,toolName:'read',result:{content:[{type:'text',text:'result'}]}},c);
  }
  piEvent({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'actual final'}]}},c);
  piEvent({type:'agent_end'},c);
  const capture=c.finish();assert.ok(capture.noise>=12000);assert.ok(capture.omitted>0);assert.equal(capture.final,'actual final');
  const root=await temporary(t),before=await snapshot(root),scope={targetId:'pi',runId:'pi-run',caseId:'case',attemptId:'pi-attempt'};
  const delivery=await collectFiles(root,before,[],scope);
  const trace=buildTrace({scope,capture,before,after:before,delivery,startedAt:'2026-09-22T00:00:00Z',endedAt:'2026-09-22T00:01:00Z',agent:{kind:'pi',sourceType:'PI_PROBE',externalSchema:'pi.json-events/0.85.1',normalizeEvent:normalizedEvent,blindSpots:['INTERNAL_THOUGHT_NOT_OBSERVED']}});
  assert.ok(Buffer.byteLength(JSON.stringify(trace))<=TRACE_MAX_BYTES);assert.equal(trace.schema,'evaldock.all-trace/v1');
  assert.equal(trace.sources[0].sourceType,'PI_PROBE');assert.ok(trace.coverage[0].truncated);
  const view=projectTraceOverview(trace);assert.ok(view.tools.length>0);assert.equal(new Set(view.tools.map(x=>x.callId)).size,view.tools.length);
  const ref=await writeTraceDirectory({caseDirectory:root,trace,maxBytes:20*1024*1024,readArtifact:async a=>delivery.bodies.get(a.artifactId)});
  assert.deepEqual((await readTraceDirectory(root,ref,20*1024*1024)).contentDigest,trace.contentDigest);
});

test('process capture drains oversized lines, keeps framing, redacts target keys and stops on cancellation',async t=>{
  const cwd=await temporary(t),key='target-secret-key-for-test';
  const source="console.log('x'.repeat(700000)); console.log(JSON.stringify({type:'tool/call',data:{callId:'a',name:'tool',result:process.env.DEEPSEEK_API_KEY}})); console.log(JSON.stringify({type:'runtime/completed'}));";
  const result=await runProcess({command:process.execPath,args:['-e',source],cwd,env:{DEEPSEEK_API_KEY:key},deadlineMs:5000,capture:new Capture('langgraph'),onEvent:langGraphEvent});
  assert.equal(result.error,null);assert.equal(result.cleanup,'STOPPED');assert.ok(result.omitted>0);assert.ok(!JSON.stringify(result).includes(key));assert.ok(JSON.stringify(result).includes('[REDACTED]'));
  const abort=new AbortController();setTimeout(()=>abort.abort(),50);
  const cancelled=await runProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd,env:{},deadlineMs:5000,signal:abort.signal,capture:new Capture('pi'),onEvent:piEvent});
  assert.equal(cancelled.error,'AGENT_CANCELLED');assert.equal(cancelled.cleanup,'STOPPED');
});

test('capture redacts nested secrets before clipping and cleans surviving tool processes',async t=>{
  const secret='hidden-nested-key';
  assert.ok(!JSON.stringify(excerpt({nested:{api_key:secret},large:'x'.repeat(50000)})).includes(secret));
  const cwd=await temporary(t);
  const source="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();console.log(JSON.stringify({type:'tool/call',data:{callId:'pid',pid:c.pid}}));console.log(JSON.stringify({type:'runtime/completed'}));";
  const result=await runProcess({command:process.execPath,args:['-e',source],cwd,env:{},deadlineMs:5000,capture:new Capture('langgraph'),onEvent:langGraphEvent});
  assert.equal(result.cleanup,'STOPPED');
  const pid=result.queue.find(r=>r.event.type==='tool/call').event.data.pid;
  assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('LangGraph runner streams events without replay, deduplicates repeated state messages and does not use fixture scoring',async t=>{
  const cwd=await temporary(t),graph=path.join(cwd,'graph.py'),input=path.join(cwd,'input.json');
  await writeFile(input,JSON.stringify({task:'public task'}));
  await writeFile(graph,[
    'class Graph:',
    '    async def astream(self, value, **kwargs):',
    '        assert value["task"] == "public task"',
    '        call = {"type":"ai","id":"a","content":"","tool_calls":[{"id":"tool1","name":"read","args":{"path":"input/data"}}]}',
    '        result = {"type":"tool","id":"t","tool_call_id":"tool1","name":"read","content":"observed result"}',
    '        for i in range(30):',
    '            yield ("updates", {"tools":{"messages":[call,result]}})',
    '        yield ("updates", {"model":{"messages":[{"type":"ai","id":"answer","content":"real observed final","tool_calls":[]}]}})',
    'def create_graph(): return Graph()',
  ].join('\n'));
  const runner=path.resolve('adapters/langgraph/runner.py');
  const r=await promisify(execFile)('python3',['-u',runner,'--graph',graph+':create_graph','--input',input,'--thread','test'],{cwd,maxBuffer:1024*1024});
  const events=r.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.type==='tool/call').length,1);assert.equal(events.filter(e=>e.type==='tool/result').length,1);
  assert.equal(events.find(e=>e.type==='assistant/final').data.text,'real observed final');
  assert.equal(events.at(-1).type,'runtime/completed');
  assert.ok(!r.stdout.includes('score'));assert.ok(!r.stdout.includes('native.jsonl'));
});

test('Pi/LangGraph routes are CSRF protected and allow independent Agent runs',async t=>{
  const root=await temporary(t);let piActive=false,dshRun=0,piRun=0,lgRun=0;
  const dsh={jobs:{children:new Map()},status:async()=>({jobs:[],runs:[],runningSessions:0}),run:async()=>{dshRun++;}};
  const workbuddy={active:false,status:async()=>({}),records:async()=>({jobs:[],runs:[]})};
  const pi={get active(){return piActive;},status:async()=>({targets:[{id:'pi',name:'Pi',evaluationReady:true}]}),records:async()=>({jobs:[],runs:[]}),run:async()=>{piRun++;return {};}};
  const langgraph={active:false,status:async()=>({targets:[]}),records:async()=>({jobs:[],runs:[]}),run:async()=>{lgRun++;return {};}};
  const {server}=await startControlServer({root,port:0,controller:dsh,workbuddyController:workbuddy,agentControllers:{pi,langgraph}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port,csrf=(await(await fetch(base+'/api/control/status')).json()).csrf;
  const post=(route,token=csrf)=>fetch(base+'/api/control/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:'{}'});
  assert.equal((await post('pi/run','wrong')).status,403);
  assert.equal((await post('pi/run')).status,200);assert.equal(piRun,1);assert.equal(dshRun,0);
  piActive=true;assert.equal((await post('run')).status,200);assert.equal((await post('langgraph/run')).status,200);assert.equal(dshRun,1);assert.equal(lgRun,1);
  assert.equal((await fetch(base+'/api/control/langgraph/status')).status,200);
});

test('Pi and concrete LangGraph targets display their own static identity rather than DSH fields',async()=>{
  const html=await readFile('workbench/design-prototypes/index.html','utf8');
  const source=html.slice(html.indexOf('function staticView(){'),html.indexOf('\nfunction planReason'));
  for(const [kind,name] of [['pi','Pi'],['langgraph','DeepAgents']]){
    const context=vm.createContext({activeRun:{agentKind:kind,agentName:name,target:{agentVersion:'1',toolNames:['OWN_TOOL']}},controlSnapshot:{staticInspection:{plugins:[{name:'DSH_PLUGIN'}],target:{toolNames:['DSH_TOOL']}}},currentAgentName:()=>name,esc:String,metaTable:JSON.stringify,observedToolList:JSON.stringify,observedPluginList:()=>{throw Error('No DSH plugin section');},section:(_title,body)=>body});
    vm.runInContext(source,context);const rendered=vm.runInContext('staticView()',context);
    assert.ok(rendered.includes(name+' 版本'));assert.ok(rendered.includes('OWN_TOOL'));assert.ok(!rendered.includes('DSH_TOOL'));assert.ok(!rendered.includes('DSH 版本'));
  }
});

test('DSH live observer never polls a Pi, WorkBuddy or LangGraph session',()=>{
  const sessions=[{id:'dsh-session',cwd:'/var/run/run.c1/workspaces'}];
  const job={runId:'run',progress:{current:{ordinal:1}}};
  assert.equal(sessionForJob(sessions,job)?.id,'dsh-session');
  for(const agentKind of ['pi','langgraph','workbuddy'])assert.equal(sessionForJob(sessions,{...job,agentKind}),null);
});
