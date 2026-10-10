import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {temporary} from './support.mjs';
import {ensureCompatibility,verifyIdentity} from '../../adapters/compatibility/check.mjs';
import {validateCapture,conclusion,classify} from '../../adapters/compatibility/contracts.mjs';
import {normalizedEvent} from '../../adapters/shared/capture.mjs';
import {acquire} from '../../adapters/compatibility/store.mjs';
import {runEvaluation} from '../../adapters/shared/evaluation.mjs';
import {randomUUID} from 'node:crypto';
function fixture(){
 let serial=0;
 const adapter={kind:'pi',targetId:'fixture-'+randomUUID(),configuration:{},version:'1',broken:false,runs:0,trace:{normalizeEvent:normalizedEvent},
 inspect:async()=>({evaluationReady:true,version:adapter.version}),prepare:async()=>({}),dispose:async()=>{},
 async run({cwd,caseDirectory,prompt,onSession,signal}){
  adapter.runs++;const sessionId='s'+(++serial);await onSession(sessionId);
  const c={sessionId,queue:[],seen:1,final:'EVALDOCK_COMPAT_OK',result:{stopReason:'end_turn'},cleanup:'STOPPED'};
  if(path.basename(caseDirectory)==='cancel'){
   await writeFile(path.join(cwd,'output/started.txt'),'started');
   await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
   return {...c,error:'AGENT_CANCELLED',result:null};
  }
  if(prompt.includes('challenge.txt')){
   const secret=await readFile(path.join(cwd,'input/challenge.txt'),'utf8');await writeFile(path.join(cwd,'output/answer.txt'),secret);c.final=secret;
   if(!adapter.broken)c.queue=[{event:{type:'tool/call',data:{callId:'read',arguments:{command:'cat input/challenge.txt > output/answer.txt; cat input/challenge.txt'}}}},{event:{type:'tool/result',data:{callId:'read',result:secret}}}];
  }
  return c;
 }};
 return adapter;
}
test('new versions pass behavior without code changes; exact identity and evidence permit reuse',async t=>{
 const root=await temporary(t),adapter=fixture();
 const first=await ensureCompatibility({root,adapter});assert.equal(first.status,'COMPATIBLE',JSON.stringify(first));assert.equal(adapter.runs,4);
 const reused=await ensureCompatibility({root,adapter});assert.equal(reused.reusedFrom,first.id);assert.equal(adapter.runs,4);
 adapter.version='99';await assert.rejects(verifyIdentity(adapter,first),/IDENTITY_CHANGED/);
 const next=await ensureCompatibility({root,adapter});assert.equal(next.status,'COMPATIBLE');assert.equal(adapter.runs,8);assert.notEqual(next.fingerprint.digest,first.fingerprint.digest);
 await writeFile(path.join(next.evidence,'report.json'),'{}');
 await ensureCompatibility({root,adapter});assert.equal(adapter.runs,12);
});
test('file delivered but renamed/missing tool events blocks admission and revokes earlier receipt',async t=>{
 const root=await temporary(t),adapter=fixture();assert.equal((await ensureCompatibility({root,adapter})).status,'COMPATIBLE');
 adapter.broken=true;const bad=await ensureCompatibility({root,adapter,force:true});assert.equal(bad.status,'INCOMPATIBLE');assert.ok(bad.issues.some(i=>i.code==='AGENT_READ_EVIDENCE_CONTRACT_BROKEN'));
 const retry=await ensureCompatibility({root,adapter});assert.equal(retry.reusedFrom,undefined);assert.equal(retry.status,'INCOMPATIBLE');
});
test('login is an environment blocker; missing protocol remains unverified',async t=>{
 const root=await temporary(t),adapter=fixture();adapter.inspect=async()=>({evaluationReady:false,reasonCode:'AGENT_LOGIN_REQUIRED'});
 assert.equal((await ensureCompatibility({root,adapter})).status,'ENVIRONMENT_BLOCKED');assert.equal(adapter.runs,0);
 adapter.inspect=async()=>({evaluationReady:true});adapter.kind='unknown';assert.equal((await ensureCompatibility({root,adapter})).status,'INDETERMINATE');assert.equal(adapter.runs,0);
});
test('capture acceptance detects missing results, missing child completion, mixed sessions and incomplete cleanup',()=>{
 const adapter=fixture(),base={sessionId:'s',cleanup:'STOPPED',final:'ok',result:{stopReason:'end_turn'},queue:[]};
 assert.equal(conclusion(validateCapture(adapter,base)),'COMPATIBLE');
 assert.equal(conclusion(validateCapture(adapter,base,{required:['tools'],controlled:true})),'INDETERMINATE');
 const queue=[{event:{type:'tool/call',data:{callId:'t',arguments:{}}}},{event:{type:'task/delegated',data:{threadId:'child'}}}];
 const issues=validateCapture(adapter,{...base,queue},{required:['tools','subtasks']});assert.ok(issues.some(i=>i.code==='AGENT_TOOL_EVIDENCE_INCOMPLETE'));assert.ok(issues.some(i=>i.code==='AGENT_SUBTASK_TERMINATION_MISSING'));
 assert.equal(conclusion(validateCapture(adapter,{...base,queue:[{event:{type:'text',data:{sessionId:'foreign'}}}]})),'INCOMPATIBLE');
 assert.equal(conclusion(validateCapture(adapter,{...base,cleanup:'UNKNOWN'})),'ENVIRONMENT_BLOCKED');
});
test('formal execution is stopped before preparing, selecting tasks or invoking Judge',async t=>{
 const root=await temporary(t),adapter=fixture();adapter.inspect=async()=>({evaluationReady:false,reasonCode:'AGENT_LOGIN_REQUIRED'});
 adapter.prepare=async()=>assert.fail('must not prepare');
 const report=await runEvaluation({root,adapter,runId:'blocked',onProgress:()=>{},matcherFactory:()=>assert.fail('must not plan'),judgeFactory:()=>assert.fail('must not judge')});
 assert.equal(report.status,'FAILED');assert.equal(report.compatibility.status,'ENVIRONMENT_BLOCKED');assert.equal(adapter.runs,0);
});
test('compatibility and formal runs share a cross-process target lease',async()=>{
 const adapter=fixture(),release=await acquire(adapter);
 try{await assert.rejects(acquire(adapter),/BUSY/);}finally{await release();}
 await(await acquire(adapter))();
});

test('failed cleanup quarantines the target and prevents subsequent sessions',async t=>{
 const root=await temporary(t),adapter=fixture();adapter.run=async({onSession})=>{adapter.runs++;await onSession('owned');return {sessionId:'owned',queue:[],final:'ok',cleanup:'UNKNOWN'};};
 const {machineBlock}=await import('../../adapters/compatibility/store.mjs');t.after(()=>rm(machineBlock(adapter),{force:true}));
 const first=await ensureCompatibility({root,adapter});assert.equal(first.status,'ENVIRONMENT_BLOCKED');assert.equal(adapter.runs,1);
 const second=await ensureCompatibility({root,adapter});assert.equal(second.status,'ENVIRONMENT_BLOCKED');assert.equal(adapter.runs,1);
});
test('configuration and capability changes cannot reuse a narrower certificate',async t=>{
 const root=await temporary(t),adapter=fixture();assert.equal((await ensureCompatibility({root,adapter,required:['text']})).status,'COMPATIBLE');
 const count=adapter.runs;assert.equal((await ensureCompatibility({root,adapter})).reusedFrom,undefined);assert.ok(adapter.runs>count);
 adapter.configuration.model='different';assert.equal((await ensureCompatibility({root,adapter})).reusedFrom,undefined);
 const bad=await ensureCompatibility({root,adapter,required:['fabricated']});assert.equal(bad.status,'INDETERMINATE');assert.equal(bad.reusedFrom,undefined);
});

test('DSH headless missing configuration cannot bypass the formal compatibility gate',async t=>{
 const {prepareDshCompatibility}=await import('../../adapters/compatibility/dsh.mjs');
 const root=await temporary(t);
 await assert.rejects(prepareDshCompatibility({root,descriptor:{targetId:'test-headless-'+randomUUID(),sourceRoot:root,dshExecutable:'dsh.mjs',profile:'test'},onProgress:()=>{}}),/AGENT_COMPATIBILITY_ENVIRONMENT_BLOCKED/);
});

test('DSH Web aliases and plugin identities cannot acquire independent leases for the same service',async()=>{
 const configuration={webEndpoint:'http://127.0.0.1:19999',dshHome:'/synthetic/dsh',profile:'web'},a={kind:'dsh-web',targetId:'a',configuration},b={kind:'dsh-web',targetId:'b',configuration:{...configuration,plugins:['different']}};
 const release=await acquire(a);try{await assert.rejects(acquire(b),/BUSY/);}finally{await release();}
});


test('headless acceptance requires valid session ownership, sequence and completed turn',async()=>{
 const {captureDshArchive}=await import('../../adapters/compatibility/dsh.mjs');
 const adapter={trace:{normalizeEvent:normalizedEvent}},sessionId='session-test',at=new Date().toISOString();
 const rows=[{type:'session',id:sessionId,cwd:'/synthetic'},
  {type:'tool/call',seq:1,time:Date.now(),data:{callId:'a',name:'read',arguments:{path:'input/challenge.txt'}}},
  {type:'tool/result',seq:2,time:Date.now(),data:{callId:'a',result:'challenge',status:'completed'}},
  {type:'assistant/message',seq:3,time:Date.now(),data:{message:{content:[{type:'text',text:'ok'}]}}},
  {type:'turn/end',seq:4,time:Date.now(),data:{reason:{kind:'completed'}}}];
 const capture=(entries,patch={})=>captureDshArchive({sessionId,jsonl:entries.map(x=>JSON.stringify(x)).join('\n'),result:{terminationKind:'EXITED',startedAt:at,endedAt:at,pid:1},cleanup:'STOPPED',...patch});
 assert.equal(conclusion(validateCapture(adapter,capture(rows),{required:['tools'],controlled:true})),'COMPATIBLE');
 assert.equal(capture(rows.slice(0,-1)).error,'AGENT_COMPLETION_UNCONFIRMED');
 assert.equal(capture([{...rows[0],id:'foreign'},...rows.slice(1)]).error,'AGENT_DSH_SESSION_CONTRACT_BROKEN');
 assert.equal(capture(rows.filter(r=>r.seq!==2)).error,'AGENT_DSH_SESSION_CONTRACT_BROKEN');
 assert.ok(validateCapture(adapter,capture(rows,{truncated:true}),{required:['tools']}).some(i=>i.code==='AGENT_EVIDENCE_TRUNCATED'));
 assert.equal(conclusion(validateCapture(adapter,capture(rows,{cleanup:'UNKNOWN'}))),'ENVIRONMENT_BLOCKED');
});


test('DSH resolves v4 then v3 archives while retaining legacy support and rejecting unsafe sources',async t=>{
 const {resolveDshSessionArchive}=await import('../../dist/src/runtime/dsh-session-trace.js');
 const {symlink}=await import('node:fs/promises');const root=await temporary(t);
 const legacy=path.join(root,'session.jsonl.zstd'),current=path.join(root,'session.v3.jsonl.zstd');
 await assert.rejects(resolveDshSessionArchive(legacy),/ARCHIVE_MISSING/);
 await writeFile(legacy,'old');assert.equal(await resolveDshSessionArchive(legacy),legacy);
 await writeFile(current,'current');assert.equal(await resolveDshSessionArchive(legacy),current);
 const latest=path.join(root,'session.v4.jsonl.zstd');await writeFile(latest,'latest');assert.equal(await resolveDshSessionArchive(legacy),latest);
 await rm(latest);await symlink(legacy,latest);await assert.rejects(resolveDshSessionArchive(legacy),/ARCHIVE_UNSAFE/);await rm(latest);
 await rm(current);await symlink(legacy,current);await assert.rejects(resolveDshSessionArchive(legacy),/ARCHIVE_UNSAFE/);
});


test('DSH session tool-result blocks and compacted argument references retain actual evidence',async()=>{
 const {captureDshArchive}=await import('../../adapters/compatibility/dsh.mjs');
 const now=new Date().toISOString(),rows=[{type:'session',id:'session-test',cwd:'/synthetic'},
 {type:'assistant/message',seq:0,time:1,data:{message:{content:[{type:'tool-call',arguments:'{"path":"output/answer.txt"}'}]}}},
 {type:'tool/call',seq:1,time:2,data:{callId:'a',arguments:'{"path":"output/answer.txt"}'}},
 {type:'tool/result',seq:2,time:3,data:{message:{content:[{type:'tool-result',toolCallId:'a',content:[{type:'text',text:'hidden-token'}]}]}}},
 {type:'assistant/message',seq:3,time:4,data:{message:{content:[{type:'text',text:'done'}]}}},
 {type:'turn/end',seq:4,time:5,data:{reason:{kind:'completed'}}}];
 const c=captureDshArchive({sessionId:'session-test',jsonl:rows.map(JSON.stringify).join('\n'),result:{terminationKind:'EXITED',startedAt:now,endedAt:now},cleanup:'STOPPED'});
 assert.equal(conclusion(validateCapture({trace:{normalizeEvent:normalizedEvent}},c,{required:['tools'],controlled:true})),'COMPATIBLE');
 assert.match(JSON.stringify(c.queue),/output\/answer.txt/);assert.match(JSON.stringify(c.queue),/hidden-token/);
});


test('DSH authentication failures are environment blockers, not protocol incompatibility',()=>{
 assert.equal(classify('DSH_WEB_HTTP_401'),'ENVIRONMENT_BLOCKED');
 assert.equal(classify('DSH_WEB_HTTP_403'),'ENVIRONMENT_BLOCKED');
});
test('DSH Headless aliases share the profile lease',async()=>{
 const a={kind:'dsh-headless',targetId:'a',configuration:{dshHome:'/synthetic/headless',profile:'headless'}},b={...a,targetId:'b',configuration:{...a.configuration,targetId:'b'}};
 const release=await acquire(a);try{await assert.rejects(acquire(b),/BUSY/);}finally{await release();}
});

test('text-only Graph cancellation waits for actual graph activity after startup',async t=>{
 const root=await temporary(t),adapter=fixture();adapter.kind='langgraph';adapter.configuration={tools:[]};
 adapter.run=async({caseDirectory,onActivity,onSession,signal})=>{
  const sessionId=path.basename(caseDirectory);await onSession(sessionId);
  if(sessionId==='cancel'){
   await new Promise(r=>setTimeout(r,1100));assert.equal(signal.aborted,false);
   onActivity();assert.equal(signal.aborted,true);
   return {sessionId,queue:[],seen:1,error:'AGENT_CANCELLED',cleanup:'STOPPED'};
  }
  return {sessionId,queue:[],final:'EVALDOCK_COMPAT_OK',result:{stopReason:'end_turn'},cleanup:'STOPPED'};
 };
 const result=await ensureCompatibility({root,adapter});assert.equal(result.status,'COMPATIBLE');assert.equal(result.checks.at(-1).cancelMode,'OBSERVED_GRAPH_ACTIVITY');
});

test('DSH v4 tool messages retain result content, error status and call ownership',async()=>{
 const {captureDshArchive}=await import('../../adapters/compatibility/dsh.mjs');
 const at=new Date().toISOString();
 const capture=message=>captureDshArchive({sessionId:'session-v4',jsonl:[
  {type:'session',version:4,id:'session-v4',cwd:'/synthetic'},
  {type:'tool/call',seq:0,time:1,data:{callId:'a',name:'read',arguments:{path:'input/challenge.txt'}}},
  {type:'tool/result',seq:1,time:2,data:{message}},
  {type:'turn/end',seq:2,time:3,data:{reason:{kind:'completed'}}}
 ].map(JSON.stringify).join('\n'),result:{terminationKind:'EXITED',startedAt:at,endedAt:at},cleanup:'STOPPED'});
 const message={role:'tool',source:{kind:'tool',callId:'a'},toolCallId:'a',content:[{type:'text',text:'synthetic-secret'}],isError:false};
 const good=capture(message);
 assert.equal(good.error,null);
 assert.deepEqual(good.queue[1].event.data,{callId:'a',result:message.content,status:'completed'});
 assert.equal(capture({...message,isError:true}).queue[1].event.data.status,'failed');
 assert.equal(capture({...message,toolCallId:'foreign'}).error,'AGENT_TOOL_CONTRACT_BROKEN');
 assert.equal(capture({...message,content:null}).error,'AGENT_TOOL_CONTRACT_BROKEN');
});
