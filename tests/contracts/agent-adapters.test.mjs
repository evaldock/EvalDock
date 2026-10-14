import {pythonExecutable} from './python-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
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
import {platformEnvironment} from '../../adapters/shared/platform-environment.mjs';

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
  if(result.error)t.diagnostic(JSON.stringify({error:result.error,cleanup:result.cleanup,diagnostics:result.diagnostics}));
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

test('process capture cancels before launch without creating a session',async t=>{
  const cwd=await temporary(t),abort=new AbortController();abort.abort();let session=false;
  const result=await runProcess({command:path.join(cwd,'must-not-start'),args:[],cwd,env:{},signal:abort.signal,deadlineMs:1000,capture:new Capture('pi'),onEvent:piEvent,onSession:()=>{session=true;}});
  assert.equal(result.error,'AGENT_CANCELLED');assert.equal(result.cleanup,'STOPPED');assert.equal(session,false);assert.equal(result.processGroupId,undefined);
});

for(const mode of ['cancel','timeout'])test('process capture '+mode+' stops owned children and preserves an unrelated process',{timeout:20000},async t=>{
  const cwd=await temporary(t),abort=new AbortController();
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(()=>{sentinel.kill();});
  await new Promise((resolve,reject)=>{sentinel.once('spawn',resolve);sentinel.once('error',reject);});
  const childSource="setInterval(()=>{},1000)";
  const source="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"+JSON.stringify(childSource)+"],{stdio:'ignore'});console.log(JSON.stringify({type:'tool/call',data:{callId:'owned',pid:child.pid}}));setInterval(()=>{},1000);";
  let ownedPid;
  const result=await runProcess({command:process.execPath,args:['-e',source],cwd,env:{},signal:abort.signal,deadlineMs:5000,capture:new Capture('pi'),onEvent:(row,c)=>{
    if(row.type==='tool/call'){ownedPid=row.data.pid;if(mode==='cancel')abort.abort();}piEvent(row,c);
  }});
  assert.ok(Number.isInteger(ownedPid),'the target actually started before cancellation or deadline');
  assert.equal(result.error,mode==='cancel'?'AGENT_CANCELLED':'AGENT_TASK_TIMEOUT');assert.equal(result.cleanup,'STOPPED');
  assert.throws(()=>process.kill(ownedPid,0),e=>e.code==='ESRCH');
  assert.doesNotThrow(()=>process.kill(sentinel.pid,0));
});

test('Windows job cleans non-Node descendants after root exit and drains inherited pipes',{
  skip:process.platform!=='win32'?'Requires Windows Job Objects and native process handles':false,timeout:20000,
},async t=>{
  const cwd=await temporary(t);
  // Python does not provide Node/libuv's kill-direct-child-on-parent-exit behavior.
  const source="import subprocess,sys,json\nc=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\nprint(json.dumps({'type':'tool/call','data':{'callId':'python-child','pid':c.pid}}),flush=True)\nprint(json.dumps({'type':'runtime/completed'}),flush=True)";
  const result=await runProcess({command:pythonExecutable,args:['-u','-c',source],cwd,env:platformEnvironment(),deadlineMs:5000,capture:new Capture('langgraph'),onEvent:langGraphEvent});
  assert.equal(result.error,null);assert.equal(result.cleanup,'STOPPED');
  const pid=result.queue.find(row=>row.event.type==='tool/call').event.data.pid;
  assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('Windows supervisor preserves argv and target environment without shell expansion',{
  skip:process.platform!=='win32'?'Requires Windows CreateProcess argument and environment handling':false,timeout:15000,
},async t=>{
  const cwd=path.join(await temporary(t),'space 中文'),args=['','two words','quote"inside','trailing\\','中文','& echo forbidden','%PATH%'];await mkdir(cwd);
  const source="console.log(JSON.stringify({type:'tool/call',data:{callId:'argv',args:process.argv.slice(1),allowed:process.env.TEST_ALLOWED,blocked:process.env.EVALDOCK_SUPERVISOR_TEST_SECRET??null}}));console.log(JSON.stringify({type:'runtime/completed'}))";
  const original=process.env.EVALDOCK_SUPERVISOR_TEST_SECRET;process.env.EVALDOCK_SUPERVISOR_TEST_SECRET='synthetic-host-only-secret';
  t.after(()=>{if(original===undefined)delete process.env.EVALDOCK_SUPERVISOR_TEST_SECRET;else process.env.EVALDOCK_SUPERVISOR_TEST_SECRET=original;});
  const result=await runProcess({command:process.execPath,args:['-e',source,'--',...args],cwd,env:{TEST_ALLOWED:'target-only'},deadlineMs:5000,capture:new Capture('langgraph'),onEvent:langGraphEvent});
  assert.equal(result.error,null);assert.equal(result.cleanup,'STOPPED');
  const data=result.queue.find(row=>row.event.type==='tool/call').event.data;
  assert.deepEqual(data.args,args);assert.equal(data.allowed,'target-only');assert.equal(data.blocked,null);
});

test('Windows capture requires a supervisor cleanup receipt and isolates its launch channel',async t=>{
  const cwd=await temporary(t),source=(await readFile('adapters/shared/capture.mjs','utf8')).replace(/^import .*;\r?\n/gm,'').replaceAll('export ','').replaceAll('import.meta.url',JSON.stringify(new URL('../../adapters/shared/capture.mjs',import.meta.url).href));
  for(const receipt of [true,false,null,'hung']){
    let launch,request='',kills=0;const abort=new AbortController();
    const helper=new EventEmitter();helper.stdout=new PassThrough();helper.stderr=new PassThrough();
    helper.stdin=new Writable({write(chunk,_encoding,done){request+=chunk;done();}});helper.kill=()=>{kills++;};
    const context=vm.createContext({spawn:(command,args,options)=>{launch={command,args,options};setImmediate(()=>{
      helper.stdout.write(JSON.stringify({type:'started',pid:12345,at:'2026-01-01T00:00:00Z'})+'\n');
      if(receipt==='hung')return;
      helper.stdout.write(JSON.stringify({type:'stdout',data:Buffer.from('{"type":"runtime/completed"}\n').toString('base64')})+'\n');
      helper.stdout.write(JSON.stringify({type:'exit',code:0,at:'2026-01-01T00:00:01Z'})+'\n');
      if(receipt!==null)helper.stdout.write(JSON.stringify({type:'cleanup',stopped:receipt,stderrBytes:0})+'\n');
      helper.emit('close',receipt===null?1:0);
    });return helper;},path,fileURLToPath,platformEnvironment:()=>({SystemRoot:'C:\\Windows',PATH:'synthetic-path'}),Buffer,setTimeout:(fn,ms)=>setTimeout(fn,receipt==='hung'&&ms===5000?0:ms),clearTimeout,URL,
      process:{platform:'win32'},StringDecoder:(await import('node:string_decoder')).StringDecoder});
    const run=vm.runInContext(source+'\nrunProcess',context);
    const result=await run({command:'synthetic.exe',args:['a b'],cwd,env:{DEEPSEEK_API_KEY:'synthetic-target-secret'},deadlineMs:30000,signal:abort.signal,capture:new Capture('langgraph'),onEvent:langGraphEvent,onSession:()=>{if(receipt==='hung')abort.abort();}});
    assert.equal(result.cleanup,receipt===true?'STOPPED':'UNKNOWN');
    assert.ok(!JSON.stringify(launch).includes('synthetic-target-secret'));
    const config=JSON.parse(request.split('\n')[0]);assert.deepEqual(config.args,['a b']);
    assert.ok(Buffer.from(config.environment,'base64').toString('utf16le').includes('DEEPSEEK_API_KEY=synthetic-target-secret'));
    if(receipt===null)assert.equal(result.error,'AGENT_PROCESS_FAILED');
    if(receipt==='hung'){assert.equal(kills,1);assert.equal(result.error,'AGENT_CANCELLED');}
  }
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
  const r=await promisify(execFile)(pythonExecutable,['-u',runner,'--graph',graph+':create_graph','--input',input,'--thread','test'],{cwd,maxBuffer:1024*1024});
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
