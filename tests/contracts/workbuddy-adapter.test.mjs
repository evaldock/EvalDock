import {fixtureCompatibilityService} from './compatibility-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {temporary,question,json,judgeInput} from './support.mjs';
import {installCapture,runSession} from '../../adapters/workbuddy/desktop.mjs';
import {seedWorkspace,snapshot,collectFiles,buildTrace,TRACE_MAX_BYTES} from '../../adapters/workbuddy/evidence.mjs';
import {runEvaluation} from '../../adapters/workbuddy/run.mjs';
import {parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
import {parseVerifiedReportDocument} from '../../dist/src/reporting/record.js';
import {readTraceDirectory,writeTraceDirectory} from '../../dist/src/all-trace/store.js';
import {projectTraceOverview} from '../../dist/src/reporting/trace-overview.js';
function fakeDesktop({hang=false,fail=false,disconnect=false,missingStop=false,onTask=async()=>{}}={}){
  const calls=[],ports=[],ctx=vm.createContext({TextEncoder,setTimeout,clearTimeout,window:{}});let serial=0;
  const emit=(id,update,eventId)=>{for(const port of ports)port.onmessage?.({data:{kind:'message',json:{type:'event',id:eventId,channel:'session:event:'+id,result:{sessionId:id,update}}}});};
  ctx.MessageChannel=class {
    constructor(){const port=this.port1={start(){},close(){},postMessage:frame=>{
      if(frame.kind!=='message')return;const q=frame.json;calls.push(q.channel);
      Promise.resolve().then(async()=>{
        const [id,blocks]=q.args;await onTask(id,blocks);if(hang)return;
        if(disconnect){port.onmessage({data:{kind:'close'}});return;}
        if(fail){port.onmessage({data:{kind:'message',json:{id:q.id,type:'error'}}});return;}
        emit(id,{sessionUpdate:'tool_call',toolCallId:'t1',title:'Read',rawInput:{file:'input/data.txt'}});
        emit(id,{sessionUpdate:'tool_call_update',toolCallId:'t1',status:'completed',rawOutput:'public input'});
        emit(id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The task is complete.'}});
        port.onmessage({data:{kind:'message',json:{id:q.id,type:'response',result:missingStop?{}:{stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5}}}}});
      }).catch(e=>{throw e;});
    }};this.port2=port;}
  };
  ctx.window.postMessage=(_msg,_origin,[port])=>{ports.push(port);queueMicrotask(()=>port.onmessage({data:{kind:'open'}}));};
  return {ctx,calls,emit,authenticated:async()=>true,confirmStopped:async()=>true,close(){},async invoke(c,...a){calls.push(c);if(c==='session:get')throw Error('Polling is forbidden');if(c==='session:create')return {sessionId:'test-session-'+(++serial)};return null;},async evaluate(s,timeout=10000,signal){
    return new Promise((resolve,reject)=>{
      const done=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>done(Error('WORKBUDDY_CANCELLED')),timer=setTimeout(()=>done(Error('WORKBUDDY_RPC_TIMEOUT')),timeout);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
      Promise.resolve(vm.runInContext(s,ctx)).then(v=>done(null,v),e=>done(e));
    });
  }};
}
test('push collector isolates sessions, merges call snapshots, drops noisy tokens and bounds bytes',async()=>{
  const d=fakeDesktop({hang:true});await vm.runInContext(`(${installCapture.toString()})('mine')`,d.ctx);
  const c=d.ctx.window.__evaldockWorkBuddy.mine;c.start('test');
  d.emit('other',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PRIVATE OTHER SESSION'}});
  for(let i=0;i<12000;i++)d.emit('mine',{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'unused thought'}});
  assert.equal(c.done,false);assert.equal(c.noise,12000);
  d.emit('mine',{sessionUpdate:'tool_call',toolCallId:'first',rawInput:{token:'private-key',body:'x'.repeat(10000)}});
  for(let i=0;i<900;i++)d.emit('mine',{sessionUpdate:'tool_call_update',toolCallId:'first',status:i===899?'completed':'in_progress',rawOutput:'public result '+i});
  d.emit('mine',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中'.repeat(50000)}},'same-frame');
  d.emit('mine',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中'.repeat(50000)}},'same-frame');
  const data=c.extract();assert.equal(data.queue.length,2);assert.equal(data.queue[1].event.update.status,'completed');assert.equal(data.queue[1].event.update.rawOutput,'public result 899');assert.equal(data.mergedUpdates,900);assert.equal(data.duplicates,1);assert.ok(data.finalTruncated);assert.ok(data.bytes<=192*1024);assert.ok(!JSON.stringify(data).includes('PRIVATE OTHER SESSION'));assert.ok(!JSON.stringify(data).includes('private-key'));
  await vm.runInContext(`(${installCapture.toString()})('budget')`,d.ctx);const budget=d.ctx.window.__evaldockWorkBuddy.budget;budget.start('test');
  for(let i=0;i<900;i++)d.emit('budget',{sessionUpdate:'tool_call',toolCallId:'tool-'+i,rawInput:{body:'中'.repeat(10000)}});
  const limited=budget.extract();assert.ok(limited.queue.length<=128);assert.ok(limited.bytes<=192*1024);assert.ok(limited.omitted>0);assert.ok(limited.clipped>0);
});
test('completion, cancellation, rejection and event disconnect stop owned session without history polling',async()=>{
  for(const opts of [{},{fail:true},{disconnect:true},{hang:true},{missingStop:true}]){
    const d=fakeDesktop(opts),r=await runSession(d,{cwd:'/tmp/test',prompt:'test',deadlineMs:20});
    assert.ok(d.calls.includes('session:destroy'));assert.equal(r.sessionId,'test-session-1');assert.ok(!d.calls.includes('session:get'));assert.equal(d.calls.filter(x=>x==='session:sendMessage').length,1);
    if(Object.keys(opts).length)assert.ok(r.error);else{assert.equal(r.error,null);assert.equal(r.final,'The task is complete.');}
  }
  const d=fakeDesktop({hang:true}),a=new AbortController();setTimeout(()=>a.abort(),10);
  assert.equal((await runSession(d,{cwd:'/tmp/test',prompt:'test',deadlineMs:60000,signal:a.signal})).error,'WORKBUDDY_CANCELLED');assert.ok(d.calls.includes('session:cancel'));
});
test('trace is bounded, retains v1 schema and coverage, and round-trips through shared store',async t=>{
  const root=await temporary(t),workspace=path.join(root,'workspace');await seedWorkspace(workspace,[]);const before=await snapshot(workspace);
  await mkdir(path.join(workspace,'output'));await writeFile(path.join(workspace,'output/result.txt'),'retained output');await symlink('/etc/hosts',path.join(workspace,'output/escape'));
  const after=await snapshot(workspace),scope={targetId:'workbuddy',runId:'run',caseId:'case',attemptId:'attempt'};
  const delivery=await collectFiles(workspace,after,['output'],scope);assert.equal(delivery.files.length,1);
  const capture={sessionId:'real-shape',queue:Array.from({length:400},()=>({at:'2026-09-21T00:00:00Z',event:{update:{sessionUpdate:'tool_call',toolCallId:'tool',title:'Read',rawInput:{text:'中'.repeat(8000)}}}})),final:'完成',seen:900,omitted:10,clipped:4,result:{stopReason:'end_turn'}};
  const trace=buildTrace({scope,capture,before,after,delivery,startedAt:'2026-09-21T00:00:00Z',endedAt:'2026-09-21T00:00:01Z'});
  assert.equal(trace.schema,'evaldock.all-trace/v1');assert.ok(Buffer.byteLength(JSON.stringify(trace))<=TRACE_MAX_BYTES);assert.equal(trace.sources[0].sourceType,'WORKBUDDY_PROBE');assert.equal(trace.coverage[0].completeness,'PARTIAL');assert.equal(trace.coverage[0].truncated,true);assert.equal(trace.integrity.length,0);assert.ok(trace.coverage[0].finalWatermark.reusedBodies>0);
  assert.equal(trace.entries.filter(e=>e.layer==='AGENT').length,401);
  assert.ok(!trace.entries.filter(e=>e.layer==='AGENT').some(e=>JSON.stringify(e).includes('完成')));
  const agentEvents=trace.entries.filter(e=>e.layer==='AGENT').map(e=>e.content.data.event);const sequences=new Set(agentEvents.map(e=>e.seq));
  const refs=[...JSON.stringify(agentEvents).matchAll(/"evidenceRef":\{"seq":(\d+)/g)];assert.ok(refs.length>0);for(const match of refs)assert.ok(sequences.has(Number(match[1])));
  assert.ok(!JSON.stringify(trace.entries.find(e=>e.id==='environment.final')).includes('workbuddy_probe'));
  const caseDir=path.join(root,'case');const ref=await writeTraceDirectory({caseDirectory:caseDir,trace,maxBytes:20*1024*1024,readArtifact:async a=>delivery.bodies.get(a.artifactId)});
  const restored=await readTraceDirectory(caseDir,ref,20*1024*1024);assert.deepEqual(restored.contentDigest,trace.contentDigest);assert.ok(projectTraceOverview(restored));
});
test('offline MVP reuses dataset loader, Judge contract, reports and score aggregation without private input leakage',async t=>{
  const root=await temporary(t);await question(path.join(root,'datasets'));
  const label=judgeInput().label;await json(path.join(root,'labels/contract.json'),label);
  await writeFile(path.join(root,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Example',description:'Read local file',labelIds:[label.labelId],availableCaseCount:1}]})+'\n```');
  const plan={schema:'evaldock.mvp.unified-planner-result/v1',profile:'STANDARD',selectedDatasets:[{datasetId:'dataset.example/v1',evaluationLabelIds:[label.labelId],caseCount:1,reason:'Fixture'}],evaluationLabelIds:[label.labelId],totalCaseCount:1,model:'contract-fixture',durationMs:0};
  const d=fakeDesktop({onTask:async(_id,blocks)=>assert.ok(!JSON.stringify(blocks).includes('private answer'))});
  const result=await runEvaluation({compatibilityService:fixtureCompatibilityService,root,runId:'mvp-contract',onProgress:()=>{},driverFactory:async()=>d,inspect:async()=>({evaluationReady:true,version:'5.5.6',installRoot:'/Applications/WorkBuddy.app',limitations:[]}),matcherFactory:()=>({select:async()=>plan}),judgeFactory:()=>({evaluate:async input=>parseLabelScore(JSON.stringify({status:'SCORED',score:0,reason:'Fixture zero score',evidence_ids:[]}),input,'contract-fixture')})});
  assert.equal(result.status,'COMPLETED',JSON.stringify(result));assert.equal(result.caseResults.length,1);assert.equal(result.dimensions[0].score,0);
  const report=parseVerifiedReportDocument(await readFile(path.join(root,'var/evaluation-results/agents/workbuddy/runs/mvp-contract/cases/example.case-1/report.json'),'utf8'));
  assert.equal(report.target.agentKind,'workbuddy');assert.equal(report.case.seedEntries,undefined);assert.equal(report.execution.agentSessionIds.length,1);assert.ok(report.allTraceRef);assert.ok(!JSON.stringify(report).includes('PRIVATE OTHER SESSION'));
});

test('destroy returning successfully is insufficient when actual stopped state is unavailable',async()=>{
 const d=fakeDesktop();d.confirmStopped=async()=>false;
 const result=await runSession(d,{cwd:'/tmp/test',prompt:'test',deadlineMs:1000});
 assert.equal(result.cleanup,'UNKNOWN');assert.equal(result.error,'WORKBUDDY_CLEANUP_UNCONFIRMED');
});
test('renamed tool notifications remain visible as structure and fail required tool acceptance',async()=>{
 const {validateCapture}=await import('../../adapters/compatibility/contracts.mjs');
 const {workbuddyTrace}=await import('../../adapters/workbuddy/evidence.mjs');
 const d=fakeDesktop({hang:true});await vm.runInContext(`(${installCapture.toString()})('mine')`,d.ctx);
 const c=d.ctx.window.__evaldockWorkBuddy.mine;c.start('test');
 d.emit('mine',{sessionUpdate:'renamed_tool_call',toolCallId:'tool',rawInput:{secret:'not retained'}});
 d.emit('mine',{sessionUpdate:'renamed_tool_result',toolCallId:'tool',rawOutput:'not retained'});
 d.emit('mine',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'normal final'}});
 const capture={...c.extract(),done:true,result:{stopReason:'end_turn'},cleanup:'STOPPED',sessionId:'mine'};
 assert.equal(capture.queue.length,0);assert.equal(capture.unknownEvents.length,2);assert.ok(!JSON.stringify(capture).includes('not retained'));
 assert.ok(validateCapture({trace:workbuddyTrace},capture,{required:['tools'],controlled:true}).some(i=>i.code==='AGENT_TOOL_BEHAVIOR_NOT_COVERED'));
});

test('WorkBuddy post-destroy check recognizes owned terminal state but rejects running and other sessions',async()=>{
 const {Desktop}=await import('../../adapters/workbuddy/desktop.mjs');
 for(const [state,expected] of [[{sessionId:'owned',status:'completed'},true],[{sessionId:'owned',status:'terminated'},true],[{sessionId:'owned',status:'running'},false],[{sessionId:'other',status:'completed'},false],[{},false]]){
  assert.equal(Boolean(await Desktop.prototype.confirmStopped.call({evaluate:async()=>state},'owned')),expected);
 }
});
