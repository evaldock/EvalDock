/** Host-owned DSH Web and Headless acceptance over their existing execution paths. */
import {mkdir,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectWebTarget,executeWebTarget,rpc} from '../../dist/src/runtime/web-target.js';
import {dshConfiguration} from '../../dist/src/runtime/dsh-control.js';
import {Capture,normalizedEvent} from '../shared/capture.mjs';
import {ensureCompatibility,verifyIdentity} from './check.mjs';
import {acquire} from './store.mjs';
import {hash,sourceDigest} from './identity.mjs';
import {executeTarget} from '../../dist/src/runtime/target.js';
import {readDshSessionArchive,dshSessionCwd,dshSessionsToProbeJsonl} from '../../dist/src/runtime/dsh-session-trace.js';
import {setTimeout as delay} from 'node:timers/promises';

async function archives(home){
 const result=new Map(),base=path.join(home,'sessions');
 for(const dir of await readdir(base,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
  if(!dir.isDirectory()||dir.isSymbolicLink())continue;
  for(const entry of await readdir(path.join(base,dir.name),{withFileTypes:true}))
   if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^session-[A-Za-z0-9-]+$/.test(entry.name))result.set(entry.name,path.join(base,dir.name,entry.name,'session.jsonl.zstd'));
 }
 return result;
}
// A zero exit status alone is not proof of session completion or descendant cleanup.
async function stopOwnedGroup(pid){
 if(!pid)return 'STOPPED';
 const alive=()=>{try{process.kill(-pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
 try{
  if(!alive())return 'STOPPED';
  process.kill(-pid,'SIGTERM');
  for(let i=0;i<10&&alive();i++)await delay(50);
  if(alive())process.kill(-pid,'SIGKILL');
  for(let i=0;i<20&&alive();i++)await delay(50);
  return alive()?'UNKNOWN':'STOPPED';
 }catch{return 'UNKNOWN';}
}
export function captureDshArchive({sessionId,jsonl,truncated=false,result,cleanup}){
 const capture=new Capture('dsh-headless');capture.sessionId=sessionId;capture.cleanup=cleanup;
 const rows=dshSessionsToProbeJsonl({sessions:[{sessionId,jsonl,truncated}],sourceRunId:'compat',pid:result.pid??1,startedAt:result.startedAt,endedAt:result.endedAt}).toString().trim().split('\n').map(JSON.parse);
 if(rows[0].captureDiagnostics?.issues?.length)capture.error='AGENT_DSH_SESSION_CONTRACT_BROKEN';
 if(truncated)capture.omitted++;
 const events=rows.filter(r=>r.kind==='session/event').map(r=>r.data.event);
 if(events.length&&events[0].seq>1)capture.error='AGENT_DSH_SEQUENCE_CONTRACT_BROKEN';
 const bySeq=new Map(events.map(e=>[e.seq,e]));
 function expand(value,depth=0){
  if(depth>32)throw Error('AGENT_DSH_EVIDENCE_REFERENCE_CONTRACT_BROKEN');
  if(!value||typeof value!=='object')return value;
  if(value.evidenceRef){
   const ref=value.evidenceRef;let resolved=bySeq.get(ref.seq);
   if(typeof ref.path!=='string'||!ref.path.startsWith('/'))throw Error('AGENT_DSH_EVIDENCE_REFERENCE_CONTRACT_BROKEN');
   for(const part of ref.path.slice(1).split('/'))resolved=resolved?.[part.replaceAll('~1','/').replaceAll('~0','~')];
   if(resolved===undefined)throw Error('AGENT_DSH_EVIDENCE_REFERENCE_CONTRACT_BROKEN');
   return expand(resolved,depth+1);
  }
  return Array.isArray(value)?value.map(v=>expand(v,depth+1)):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(v,depth+1)]));
 }
 try{for(const e of events){
  if(e.type==='tool/call')capture.add(e.type,expand(e.data));
  else if(e.type==='tool/result'){
   const data=expand(e.data);
   if(data.callId&&Object.hasOwn(data,'result'))capture.add(e.type,data);
   else if(data.message?.role==='tool' && typeof data.message.toolCallId==='string' && data.message.toolCallId.length && Array.isArray(data.message.content)){
    const message=data.message;
    if(message.source?.callId!==undefined && message.source.callId!==message.toolCallId)capture.error='AGENT_TOOL_CONTRACT_BROKEN';
    else capture.add(e.type,{callId:message.toolCallId,result:message.content,status:message.isError?'failed':'completed'});
   }
   else {
    const blocks=data.message?.content?.filter(b=>b.type==='tool-result')??[];
    if(!blocks.length)capture.error='AGENT_TOOL_CONTRACT_BROKEN';
    for(const block of blocks)capture.add(e.type,{callId:block.toolCallId,result:block.content,status:block.isError?'failed':'completed'});
   }
  }else if(/tool/i.test(e.type))capture.error='AGENT_TOOL_CONTRACT_BROKEN';
 }}catch(e){capture.error=e.message;}
 const final=[...events].reverse().find(e=>e.type==='assistant/message');
 capture.finalText((final?.data?.message?.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n'));
 const permission=[...events].reverse().find(e=>e.type==='permission/preset')?.data?.preset;
 const sandbox=[...events].reverse().find(e=>e.type==='sandbox/mode')?.data?.mode;
 if(typeof permission==='string'&&typeof sandbox==='string')capture.runtimeFacts={permissionPreset:permission,sandboxMode:sandbox};
 const end=[...events].reverse().find(e=>e.type==='turn/end');
 if(result.terminationKind==='CANCELLED')capture.error??='AGENT_CANCELLED';
 else if(result.terminationKind==='EXITED'&&end?.data?.reason?.kind==='completed')capture.result={stopReason:'end_turn'};
 else capture.error??='AGENT_COMPLETION_UNCONFIRMED';
 return capture.finish();
}
async function inspectHeadless(d){
 if(!d.dshHome||!path.isAbsolute(d.dshHome)||!d.profile)throw Error('AGENT_DSH_CONFIGURATION_UNAVAILABLE');
 const profile=path.join(d.dshHome,'profiles',d.profile);
 const pkg=JSON.parse(await readFile(path.join(d.sourceRoot,'package.json'),'utf8'));
 const manifest=JSON.parse(await readFile(path.join(profile,'package.json'),'utf8'));
 const bundles=manifest.dsh?.profile?.bundles;
 if(!Array.isArray(bundles)||!bundles.includes('@deepseek-ai/dsh-headless'))throw Error('AGENT_DSH_HEADLESS_CONFIGURATION_UNAVAILABLE');
 const components=[];
 for(const name of bundles){
  let installed;
  for(const base of [profile,path.join(d.dshHome,'profiles'),d.sourceRoot]){
   try{installed=await realpath(path.join(base,'node_modules',name));break;}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  if(!installed)throw Error('AGENT_DSH_PLUGIN_NOT_INSTALLED');
  components.push({name,digest:await sourceDigest(installed)});
 }
 const configuration={profileDigest:hash(await readFile(path.join(profile,'package.json'),'utf8')),runtimeDigest:await sourceDigest(path.join(d.sourceRoot,'lib'))};
 for(const [key,file] of [['patch',path.join(profile,'cordis.patch.yml')],['settings',path.join(d.dshHome,'settings.yaml')]]){
  configuration[key+'Digest']=await readFile(file,'utf8').then(hash).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 }
 return {evaluationReady:true,version:pkg.version,components,configuration};
}
async function runHeadless(descriptor,{cwd,caseDirectory,prompt,deadlineMs,signal,onSession}){
 const home=path.join(caseDirectory,'runtime');await mkdir(path.join(home,'tmp'),{recursive:true});
 const before=await archives(descriptor.dshHome);let pid,result,cleanup;
 try{
  result=await executeTarget({executablePath:path.resolve(descriptor.sourceRoot,descriptor.dshExecutable),profile:descriptor.profile,task:prompt,cwd,runtimeDshHomePath:home,sessionDshHomePath:descriptor.dshHome,probeOutputPath:path.join(home,'probe.jsonl'),sourceRunId:'compat-'+randomUUID(),contentMode:'FULL',deadlineMs,maxOutputBytes:65536,signal,
   onStarted:async id=>{pid=id;await onSession('process-'+id);}});
 }finally{cleanup=await stopOwnedGroup(pid);}
 const matches=[];
 try{
 for(const [sessionId,file] of await archives(descriptor.dshHome)){
  if(before.has(sessionId))continue;
  const archive=await readDshSessionArchive(file,1048576);
  if(dshSessionCwd(archive.jsonl)===cwd)matches.push({sessionId,...archive});
 }
 if(matches.length!==1)return {sessionId:'process-'+pid,queue:[],cleanup,error:'AGENT_SESSION_ISOLATION_UNCONFIRMED'};
 const archive=matches[0];await onSession(archive.sessionId);
 return captureDshArchive({...archive,result,cleanup});
 }catch(e){return {sessionId:'process-'+pid,queue:[],cleanup,error:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'AGENT_DSH_ARCHIVE_READ_FAILED'};}
}

export function createDshCompatibilityAdapter(descriptor){
 return {
  kind:descriptor.webEndpoint?'dsh-web':'dsh-headless',targetId:String(descriptor.targetId),name:'DSH',configuration:{...descriptor,executable:path.resolve(descriptor.sourceRoot,descriptor.dshExecutable)},
  trace:{normalizeEvent:normalizedEvent},
  async inspect(){
   if(!descriptor.webEndpoint)return inspectHeadless(descriptor);
   const [state,configuration]=await Promise.all([inspectWebTarget(descriptor),dshConfiguration(descriptor)]);
   return {evaluationReady:true,version:state.dshVersion,installRoot:descriptor.sourceRoot,components:configuration.plugins,runtimeIdentity:{pid:state.web?.pid},configuration:{profileDigest:configuration.profileDigest,runtimeDigest:await sourceDigest(path.join(descriptor.sourceRoot,'lib')),model:state.web?.model,permission:state.permissionPreset}};
  },
  prepare:async()=>({}),dispose(){},
  async run({cwd,caseDirectory,prompt,deadlineMs,signal,onSession}){
   if(!descriptor.webEndpoint)return runHeadless(descriptor,{cwd,caseDirectory,prompt,deadlineMs,signal,onSession});
   const home=path.join(caseDirectory,'runtime');await mkdir(home,{recursive:true});
   let owned;
   const result=await executeWebTarget({executablePath:path.resolve(descriptor.sourceRoot,descriptor.dshExecutable),profile:descriptor.profile,task:prompt,cwd,runtimeDshHomePath:home,probeOutputPath:path.join(home,'probe.jsonl'),sourceRunId:'compat-'+randomUUID(),contentMode:'FULL',deadlineMs,maxOutputBytes:65536,signal,
    onStarted:async()=>{const receipt=JSON.parse(await readFile(path.join(home,'web-session.json'),'utf8'));owned=receipt.sessionId;await onSession(owned);}},descriptor);
   if(!owned)return {queue:[],cleanup:'UNKNOWN',error:'AGENT_SESSION_ISOLATION_UNCONFIRMED'};
   const state=await rpc(descriptor.webEndpoint,'session.list',{});
   const cleanup=Array.isArray(state.items)&&!state.items.some(s=>s.sessionId===owned&&s.running)?'STOPPED':'UNKNOWN';
   const history=await rpc(descriptor.webEndpoint,'session.history',{sessionId:owned,maxMessages:200});
   const rows=(history.events??[]).map(x=>x.event??x);
   const capture=captureDshArchive({sessionId:owned,jsonl:[{type:'session',id:owned,cwd},...rows].map(x=>JSON.stringify(x)).join('\n'),result,cleanup});
   return {...capture,kind:'dsh-web'};
  },
 };
}
export async function prepareDshCompatibility({root,descriptor,signal,onProgress=console.error}){
 const adapter=createDshCompatibilityAdapter(descriptor),release=await acquire(adapter);
 try{
  const report=await ensureCompatibility({root,adapter,signal,onProgress});
  onProgress('[evaldock:compatibility] '+JSON.stringify({status:report.status,evidence:report.evidence,issues:report.issues}));
  if(report.status!=='COMPATIBLE')throw Error('AGENT_COMPATIBILITY_'+report.status);
  await verifyIdentity(adapter,report);return {report,release,verify:()=>verifyIdentity(adapter,report)};
 }catch(e){await release();throw e;}
}
