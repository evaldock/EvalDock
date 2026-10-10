import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRendererCapture} from '../../adapters/shared/renderer-capture.mjs';
import {subscribeQwen,runQwen,installBridge} from '../../adapters/qwenwork/desktop.mjs';
import {startDoubao,runDoubao} from '../../adapters/doubaowork/desktop.mjs';
import {normalizedEvent} from '../../adapters/shared/capture.mjs';
import {buildTrace,snapshot,collectFiles,TRACE_MAX_BYTES} from '../../adapters/shared/evidence.mjs';
import {writeTraceDirectory,readTraceDirectory} from '../../dist/src/all-trace/store.js';
import {temporary} from './support.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';

test('office collector bounds UTF-8, merges tool snapshots, preserves distinct calls and redacts secrets',()=>{
 const c=createRendererCapture('a');
 for(let i=0;i<10000;i++){c.add('tool/call',{callId:'one',name:'read',arguments:{path:'x',token:'hidden'}});c.add('tool/result',{callId:'one',result:'same'});}
 assert.equal(c.extract().queue.length,2);assert.ok(c.duplicates>10000);assert.ok(!JSON.stringify(c.extract()).includes('hidden'));
 for(let i=0;i<300;i++){c.add('tool/call',{callId:String(i),name:'read',arguments:'中'.repeat(16000)});c.add('tool/result',{callId:String(i),result:'data'});}
 c.text('中'.repeat(40000));c.finish();const out=c.extract();assert.ok(Buffer.byteLength(out.final)<=65536);assert.ok(out.finalTruncated);assert.ok(out.omitted>0);assert.ok(Buffer.byteLength(JSON.stringify(out.queue))<200*1024);assert.ok(!out.final.includes('\ufffd'));
 assert.equal(new Set(out.queue.filter(x=>x.event.type==='tool/call').map(x=>x.event.data.callId)).size,out.queue.filter(x=>x.event.type==='tool/call').length);
});
test('Qwen subscription isolates sessions, keeps latest final segment, omits thinking and unsubscribes',async()=>{
 const handlers={};const api=Object.fromEntries(['onChatStreamChunk','onChatStreamComplete','onChatStreamError'].map(k=>[k,f=>{(handlers[k]??=new Set()).add(f);return()=>handlers[k].delete(f);} ]));
 const ctx=vm.createContext({window:{desktopApi:api},TextEncoder});
 vm.runInContext(`(${subscribeQwen.toString()})('own',${createRendererCapture.toString()})`,ctx);
 const emit=(key,payload)=>handlers[key].forEach(f=>f(payload));
 const event=e=>emit('onChatStreamChunk',{subChatId:'own',chunk:e});
 emit('onChatStreamComplete',{subChatId:'other'});
 event({type:'text-start',id:'early'});event({type:'text-delta',id:'early',delta:'intermediate'});
 event({type:'tool-input-available',toolCallId:'call',toolName:'read',input:{path:'x'}});
 event({type:'tool-output-available',toolCallId:'call',output:'observed'});
 event({type:'tool-input-available',toolCallId:'thought',toolName:'Thinking',input:{text:'not collected'}});
 event({type:'text-start',id:'final'});event({type:'text-delta',id:'final',delta:'answer'});
 emit('onChatStreamComplete',{subChatId:'own'});
 const c=ctx.window.__evaldockQwenSessions.own;await c.wait;const out=c.extract();assert.equal(out.final,'answer');assert.equal(out.queue.length,2);assert.equal(out.error,null);assert.equal(handlers.onChatStreamChunk.size,0);assert.equal(ctx.window.__evaldockQwenSessions.own,undefined);
});
test('Doubao rejects missing workspace before opening a session',async()=>{
 await assert.rejects(runDoubao({}, {caseData:{inputs:[]}}),/AGENT_WORKSPACE_REQUIRED/);
});
test('both desktop traces roundtrip through unchanged all-trace storage and remain under 1 MiB',async t=>{
 const root=await temporary(t),before=await snapshot(root);
 for(const kind of ['qwenwork','doubaowork']){
  const scope={targetId:kind,runId:'test',caseId:'case',attemptId:'attempt'},capture=createRendererCapture(kind);capture.add('tool/call',{callId:'read',name:'read',arguments:{path:'x'}});capture.add('tool/result',{callId:'read',name:'read',result:'observed'});capture.text('answer');capture.finish();
  const delivery=await collectFiles(root,before,[],scope),trace=buildTrace({scope,capture:{...capture.extract(),cleanup:'STOPPED'},before,after:before,delivery,startedAt:'2026-09-23T00:00:00Z',endedAt:'2026-09-23T00:01:00Z',agent:{kind,sourceType:kind.toUpperCase()+'_PROBE',externalSchema:kind+'/test',normalizeEvent:normalizedEvent,blindSpots:['INTERNAL_THOUGHT_NOT_OBSERVED']}});
  assert.equal(trace.schema,'evaldock.all-trace/v1');assert.ok(Buffer.byteLength(JSON.stringify(trace))<=TRACE_MAX_BYTES);
  const ref=await writeTraceDirectory({caseDirectory:root+'/'+kind,trace,maxBytes:20*1024*1024,readArtifact:async a=>delivery.bodies.get(a.artifactId)});assert.deepEqual((await readTraceDirectory(root+'/'+kind,ref,20*1024*1024)).contentDigest,trace.contentDigest);
 }
});
test('new console routes enforce CSRF and permit independent Agent runs',async t=>{
 const root=await temporary(t);let active=false,calls=0;
 const controller={jobs:{children:new Map()},status:async()=>({jobs:[],runs:[],runningSessions:0})};
 const workbuddy={get active(){return active;},status:async()=>({}),records:async()=>({jobs:[],runs:[]})};
 const agent={active:false,status:async()=>({targets:[{status:'LOGIN_REQUIRED',evaluationReady:false}]}),records:async()=>({jobs:[],runs:[]}),run:async()=>{calls++;return {};},open:async()=>({status:'LAUNCH_REQUESTED'})};
 const {server}=await startControlServer({root,port:0,controller,workbuddyController:workbuddy,agentControllers:{qwenwork:agent,doubaowork:agent}});t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,csrf=(await(await fetch(base+'/api/control/status')).json()).csrf;
 const post=(route,token=csrf)=>fetch(base+'/api/control/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:'{}'});
 for(const kind of ['qwenwork','doubaowork']){assert.equal((await fetch(base+'/api/control/'+kind+'/status')).status,200);assert.equal((await post(kind+'/run','wrong')).status,403);assert.equal((await post(kind+'/open')).status,200);}
 active=true;assert.equal((await post('qwenwork/run')).status,200);assert.equal(calls,1);
});

test('Qwen orchestration uses a local project, records ownership and blocks on unconfirmed cleanup',async()=>{
 const calls=[];let cancelled=false;
 const desktop={invoke:async(path,type,input)=>{calls.push({path,type,input});if(path==='localProjects.create')return {project:{id:'project'}};if(path==='chats.create')return {id:'chat'};if(path==='chats.get')return {subChats:[{id:'session'}]};if(path==='agent.getStreamingState')return null;},evaluate:async expression=>expression.includes('.extract()')?{done:true,final:'answer',queue:[],result:{stopReason:'end_turn'}}:expression.endsWith('.wait')?{error:null}:true};
 const c=await runQwen(desktop,{cwd:'/case',prompt:'public',deadlineMs:5000,onSession:id=>{assert.equal(id,'session');}});
 assert.equal(c.cleanup,'STOPPED');assert.equal(c.error,null);assert.equal(calls.find(c=>c.path==='chats.create').input.localProjectId,'project');assert.deepEqual(calls.find(c=>c.path==='localProjects.create').input.rootPaths,['/case']);
 desktop.evaluate=async expression=>{if(expression.endsWith('.wait'))throw Error('AGENT_RPC_TIMEOUT');return expression.includes('.extract()')?{done:false,queue:[]}:true;};
 desktop.invoke=async(path,type,input)=>{if(path==='localProjects.create')return {project:{id:'project'}};if(path==='chats.create')return {id:'chat'};if(path==='chats.get')return {subChats:[{id:'session'}]};if(path==='agent.cancelStream'){cancelled=true;return {cancelled:true};}if(path==='agent.getStreamingState')return {status:'streaming'};};
 const failed=await runQwen(desktop,{cwd:'/case',prompt:'public',deadlineMs:5});assert.equal(cancelled,true);assert.equal(failed.error,'AGENT_TASK_TIMEOUT');assert.equal(failed.cleanup,'UNKNOWN');
});

test('Qwen SuperJSON null is decoded as null, rather than as a live stream object',async()=>{
 let listener;const ctx=vm.createContext({window:{desktopApi:{onChatStreamChunk(){},onChatStreamComplete(){},onChatStreamError(){}},electronTRPC:{onMessage:fn=>{listener=fn;},sendMessage:frame=>listener({id:frame.operation.id,result:{data:{json:null}}})}},setTimeout,clearTimeout});
 vm.runInContext(`(${installBridge.toString()})()`,ctx);assert.equal(await ctx.window.__evaldockQwenRPC('agent.getStreamingState','query',{subChatId:'owned'}),null);
});
test('Qwen projected patches merge snapshots and retain final answer after empty current-text reset',async()=>{
 const handlers={},ctx=vm.createContext({window:{desktopApi:Object.fromEntries(['onChatStreamChunk','onChatStreamComplete','onChatStreamError'].map(k=>[k,f=>(handlers[k]=f,()=>{})]))},TextEncoder});
 vm.runInContext(`(${subscribeQwen.toString()})('owned',${createRendererCapture.toString()})`,ctx);
 const push=operations=>handlers.onChatStreamChunk({subChatId:'owned',chunk:{type:'message-parts-patch',patch:{operations}}});
 const tool={type:'tool-Read',toolName:'Read',toolCallId:'call',input:{path:'input/context.md'},state:'call'};
 push([{type:'append-parts',parts:[tool]}]);for(let i=0;i<100;i++)push([{type:'upsert-part',part:{...tool,state:'output-available',output:'observed'}}]);
 push([{type:'set-current-text',currentTextAcc:'Final answer'}]);push([{type:'append-parts',parts:[{type:'text',text:'Final answer'}]},{type:'set-current-text',currentTextAcc:''}]);handlers.onChatStreamComplete({subChatId:'owned'});
 const c=ctx.window.__evaldockQwenSessions.owned;await c.wait;const out=c.extract();assert.equal(out.final,'Final answer');assert.equal(out.queue.length,2);assert.ok(out.duplicates>90);
});

test('office launch does not inherit the desktop server Node mode',async()=>{
 const {createOfficeAdapter}=await import('../../adapters/shared/office-adapter.mjs');
 const {EventEmitter}=await import('node:events');
 const previous=process.env.ELECTRON_RUN_AS_NODE;process.env.ELECTRON_RUN_AS_NODE='1';
 try{
  let options;
  const adapter=createOfficeAdapter({kind:'qwenwork',id:'test'},{app:'/Applications/Test.app',bundle:'test',version:'1',port:18492,Desktop:{connect:async()=>{throw Error('AGENT_NOT_CONNECTED');}},limitations:[]},{execCommand:async()=>({stdout:JSON.stringify({CFBundleIdentifier:'test',CFBundleShortVersionString:'1'})}),spawnProcess:(file,args,opts)=>{options=opts;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
  await adapter.launch();assert.ok(options.env);assert.equal(options.env.ELECTRON_RUN_AS_NODE,undefined);assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');
 }finally{if(previous===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=previous;}
});

test('office admission depends on interfaces and readiness, not release numbers',async()=>{
 const {createOfficeAdapter}=await import('../../adapters/shared/office-adapter.mjs');
 for(const kind of ['qwenwork','doubaowork']){
  let version='1.2.1',bundle='test',error=null,loggedIn=true,runtimeReady=true,closed=0,calls=0;
  const adapter=createOfficeAdapter({kind,id:'test'},{app:'/Applications/Test.app',bundle:'test',port:18492,Desktop:{connect:async()=>{calls++;if(error)throw Error(error);return {authenticated:async()=>loggedIn,readiness:async()=>({ready:runtimeReady,reasonCode:'AGENT_LOCAL_RUNTIME_UNAVAILABLE'}),close(){closed++;}};}},limitations:[]},{execCommand:async()=>({stdout:JSON.stringify({CFBundleIdentifier:bundle,CFBundleShortVersionString:version})})});
  for(version of ['1.2.1','1.2.5','2.31.3','99.0.0']){const s=await adapter.inspect();assert.equal(s.version,version);assert.equal(s.evaluationReady,true);}
  assert.equal(closed,4);
  error='AGENT_INTERFACE_CHANGED';assert.equal((await adapter.inspect()).reasonCode,error);
  error=null;loggedIn=false;assert.equal((await adapter.inspect()).reasonCode,'AGENT_LOGIN_REQUIRED');
  loggedIn=true;runtimeReady=false;assert.equal((await adapter.inspect()).reasonCode,'AGENT_LOCAL_RUNTIME_UNAVAILABLE');
  bundle='wrong';const before=calls;assert.equal((await adapter.inspect()).reasonCode,'AGENT_APP_ID_MISMATCH');assert.equal(calls,before);
 }
});

test('office readiness exceptions cannot leave an Agent evaluable',async()=>{
 const {createOfficeAdapter}=await import('../../adapters/shared/office-adapter.mjs');let closed=false;
 const adapter=createOfficeAdapter({kind:'doubaowork',id:'test'},{app:'/Applications/Test.app',bundle:'test',Desktop:{connect:async()=>({authenticated:async()=>true,readiness:async()=>{throw Error('AGENT_RPC_REJECTED');},close(){closed=true;}})},limitations:[]},{execCommand:async()=>({stdout:JSON.stringify({CFBundleIdentifier:'test',CFBundleShortVersionString:'99'})})});
 const s=await adapter.inspect();assert.equal(s.evaluationReady,false);assert.equal(s.executionReady,false);assert.equal(s.probeReady,false);assert.equal(s.reasonCode,'AGENT_RPC_REJECTED');assert.equal(closed,true);
});

test('Qwen checks every bridge and stream interface and retries after a failed check',()=>{
 for(const [owner,key] of [['electronTRPC','sendMessage'],['electronTRPC','onMessage'],['desktopApi','onChatStreamChunk'],['desktopApi','onChatStreamComplete'],['desktopApi','onChatStreamError']]){
  const window={electronTRPC:{sendMessage(){},onMessage(){}},desktopApi:{onChatStreamChunk(){},onChatStreamComplete(){},onChatStreamError(){}}};
  const original=window[owner][key];window[owner][key]=true;
  const ctx=vm.createContext({window,setTimeout,clearTimeout}),check=()=>vm.runInContext(`(${installBridge.toString()})()`,ctx);
  assert.equal(check(),false);assert.equal(window.__evaldockQwenRPCVersion,undefined);
  window[owner][key]=original;assert.equal(check(),true);assert.equal(check(),true);
  delete window[owner][key];assert.equal(check(),false);
 }
});

test('office preparation rechecks the runtime before admitting a task',async()=>{
 const {createOfficeAdapter}=await import('../../adapters/shared/office-adapter.mjs');let closed=false;
 const adapter=createOfficeAdapter({kind:'doubaowork',id:'test'},{Desktop:{connect:async()=>({authenticated:async()=>true,readiness:async()=>({ready:false,reasonCode:'AGENT_LOCAL_RUNTIME_UNAVAILABLE'}),close(){closed=true;}})},limitations:[]});
 await assert.rejects(adapter.prepare(),{message:'AGENT_LOCAL_RUNTIME_UNAVAILABLE'});assert.equal(closed,true);
});

test('Qwen renamed tool stream events do not certify a text-only successful response',async()=>{
 const {validateCapture}=await import('../../adapters/compatibility/contracts.mjs');
 const handlers={},ctx=vm.createContext({window:{desktopApi:Object.fromEntries(['onChatStreamChunk','onChatStreamComplete','onChatStreamError'].map(k=>[k,f=>(handlers[k]=f,()=>{})]))},TextEncoder});
 vm.runInContext(`(${subscribeQwen.toString()})('owned',${createRendererCapture.toString()})`,ctx);
 handlers.onChatStreamChunk({subChatId:'owned',chunk:{type:'renamed-tool-event',sensitive:'not retained'}});
 handlers.onChatStreamChunk({subChatId:'owned',chunk:{type:'text-delta',id:'final',delta:'normal response'}});
 handlers.onChatStreamComplete({subChatId:'owned'});
 const capture={...ctx.window.__evaldockQwenSessions.owned.extract(),sessionId:'owned',cleanup:'STOPPED'};
 assert.equal(capture.error,null);assert.equal(capture.unknownEvents[0].type,'renamed-tool-event');assert.ok(!JSON.stringify(capture).includes('not retained'));
 assert.ok(validateCapture({trace:{normalizeEvent:normalizedEvent}},capture,{required:['tools'],controlled:true}).some(i=>i.code==='AGENT_TOOL_BEHAVIOR_NOT_COVERED'));
});

test('Doubao logged-out lazy modules are an environment blocker before protocol diagnosis',async()=>{
 const {installDoubao}=await import('../../adapters/doubaowork/desktop.mjs');
 const r=id=>id===35673?{getIsLoggedIn:()=>false}:undefined;r.m={};r.e=async()=>{};
 const ctx=vm.createContext({window:{__evaldockDoubaoRequire:r}});
 const check=await vm.runInContext(`(${installDoubao.toString()})()`,ctx);
 assert.equal(check.reasonCode,'AGENT_LOGIN_REQUIRED');
});
