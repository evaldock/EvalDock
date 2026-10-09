import {toolAttribution} from '../dist/src/reporting/tool-attribution.js';
import {projectPaths} from './lib/paths.mjs';
import path from 'node:path';
import os from 'node:os';
import {readFile,readdir,mkdir,open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ControlResults} from './lib/control-results.mjs';
import {archivedRuntime} from './lib/trace-preview.mjs';
import {observationWriter,pollInterval} from './lib/background-io.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {reserveRunDisplay} from '../dist/src/runtime/session-naming.js';

export const active = j => ['STARTING','RUNNING','CANCELLING'].includes(j?.state);
export function compactText(value,limit=6000){
 const s=typeof value==='string'?value:JSON.stringify(value??'');
 return s.length>limit?s.slice(0,limit)+'\n…（预览已截断）':s;
}
const textBlocks=blocks=>(blocks??[]).filter(b=>b.type==='text').map(b=>b.text??'').join('\n');
export function projectHistory(history,previous={}){
 const entries=new Map((previous.entries??[]).map(e=>[e.key,e]));let lastActivity=previous.lastActivity??null,model=previous.model??null;
 for(const wrapper of history.events??[]){
  const e=wrapper.event??wrapper,d=e.data??{};
  if(e.time&&(!lastActivity||e.time>lastActivity))lastActivity=e.time;
  if(e.type==='tool/call'){
   let args;try{args=JSON.parse(d.arguments);}catch{args=d.arguments;}
   const key='tool:'+d.callId,old=entries.get(key);
   entries.set(key,{...old,key,kind:'tool',seq:e.seq,time:e.time,callId:d.callId,name:d.name,arguments:compactText(args),summary:compactText(args?.description||args?.command||args?.file_path||args?.path||d.name,180),state:old?.state??'running'});
  }else if(e.type==='tool/result'){
   for(const b of d.message?.content??[]){if(b.type!=='tool-result')continue;
    const key='tool:'+b.toolCallId,old=entries.get(key);
    entries.set(key,{key,kind:'tool',seq:e.seq,time:e.time,callId:b.toolCallId,name:'tool',...old,state:b.isError?'error':'done',result:compactText(textBlocks(b.content))});
   }
  }else if(e.type==='assistant/message'){
   model=d.message?.source?.model??model;const content=textBlocks(d.message?.content);
   if(content)entries.set('message:'+e.seq,{key:'message:'+e.seq,seq:e.seq,time:e.time,kind:'message',text:compactText(content,12000)});
  }
 }
 const values=history.projections?.values??{};
 return {entries:[...entries.values()].sort((a,b)=>a.seq-b.seq).slice(-24),lastActivity,model,steps:values.sessionStats?.steps??previous.steps,usage:values.tokenUsage??previous.usage,todos:(values.todos??[]).slice(0,10),lastSeq:history.projections?.asOfSeq??previous.lastSeq};
}
export function sessionForJob(sessions,job){
 if(job.agentKind&&job.agentKind!=='dsh')return null;
 const n=job.progress?.current?.ordinal;if(!n)return null;
 const prefix=job.runId+'.c'+n;
 return sessions.find(s=>s.cwd?.split('/').includes(prefix)&&s.cwd?.split('/').includes(job.runId))??null;
}
async function json(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}}
async function files(dir){try{return await readdir(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
async function rpc(endpoint,method,payload){
 const r=await fetch(endpoint+'/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload}),signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new Error('DSH_HTTP_'+r.status);const d=await r.json();if(!d.result?.ok)throw new Error('DSH_RPC_UNAVAILABLE');return d.result.value;
}
export async function collectNames(home){
 const runs={},agents={};const dir=path.join(home,'evaldock-display/runs');
 for(const f of (await files(dir)).filter(f=>/^\d{8}-\d+\.json$/.test(f)).sort()){
  const n=await json(path.join(dir,f));if(!n?.agentId||!n.runId)continue;
  runs[n.agentId+'::'+n.runId]={runName:n.runName,agentName:n.agentName};agents[n.agentId]=n.agentName;
 }
 return {runs,agents};
}
async function liveTask(root,job){
 const ordinal=job.progress?.current?.ordinal;if(!ordinal)return {};
 const child=job.runId+'.c'+ordinal,base=path.join(root,'var/batch-runtime',job.runId,child),records=path.join(base,'records',child,'records/evaluation-plan');
 const inspectionDir=path.join(base,'records',child,'records/inspection');
 let toolDeclarations=[];
 for(const f of await files(inspectionDir)){const inspection=await json(path.join(inspectionDir,f));if(inspection?.toolSchemas)toolDeclarations=inspection.toolSchemas;}
 for(const f of await files(records)){
  const p=await json(path.join(records,f));const cp=p?.casePlan;if(!cp)continue;
  const task=await readFile(path.join(base,'artifacts',child,'objects',cp.agentTaskArtifactRef.id),'utf8').catch(()=>null);
  return {task,toolDeclarations,dataset:cp.datasetId,title:cp.scenarioId?.replace(/^scenario\./,'').replace(/\/v\d+$/,'').split('.').at(-1),deadlineMs:cp.deadlineMs};
 }
 return {toolDeclarations};
}
export async function partialRun(reader,job){
 // Case reports are committed independently, before the final run.json exists.
 const base='agents/'+job.targetId+'/runs/'+job.runId,caseResults=[],previews=new Map();
 for(const caseId of await files(path.join(reader.root,base,'cases'))){
  if(!/^[A-Za-z0-9._-]+$/.test(caseId))continue;
  const r=await reader.json(base+'/cases/'+caseId+'/report.json');if(!r)continue;
  previews.set(caseId,await archivedRuntime(path.resolve(reader.root,'../..'),path.join(reader.root,base,'cases',caseId),r));
  caseResults.push({caseId,datasetId:r.plan?.casePlan?.datasetId,status:r.runState,ordinal:Number(r.scope?.runId?.match(/\.c(\d+)$/)?.[1])||0});
 }
 caseResults.sort((a,b)=>a.ordinal-b.ordinal);
 const out=await reader.get({...job,summary:{...job.summary,caseResults}});
 const declarations=new Map((out.run.target.toolDetails??[]).map(t=>[t.name,t]));
 for(const [caseId,preview] of previews){
  const {toolDeclarations,...runtime}=preview;
  Object.assign(out.runtime[job.targetId+'::'+job.runId+'::'+caseId]??={},runtime);
  for(const tool of toolDeclarations??[])declarations.set(tool.name,tool);
 }
 if(declarations.size){out.run.target.toolDetails=[...declarations.values()];out.run.target.toolNames=[...declarations.keys()];out.run.target.toolSource='本批次 request/header';out.run.target.probeStatus='已采集 · all-trace';}
 const currents=job.progress?.currentCases??(job.progress?.current?[job.progress.current]:[]);
 for(const current of currents)if(active(job)&&!out.run.cases.some(c=>c.id===current.caseId))out.run.cases.push({id:current.caseId,title:current.caseId,dataset:'',status:'running',time:'执行中',evidence:0,weight:1,scores:{},events:[],files:[],file:'',finalAnswer:''});
 for(const c of out.run.cases)c.ordinal=caseResults.find(x=>x.caseId===c.id)?.ordinal??currents.find(x=>x.caseId===c.id)?.ordinal;
 return out;
}
export async function startCollector({root,port=18767,home=path.join(os.homedir(),'.dsh'),once=false,signal,interval=pollInterval}={}){
 root??=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const dir=path.join(projectPaths(root).workbench,'control');await mkdir(dir,{recursive:true});
 const lock=path.join(dir,'live-observation.pid');
 try{const handle=await open(lock,'wx');await handle.writeFile(String(process.pid));await handle.close();}
 catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await readFile(lock,'utf8'));try{process.kill(pid,0);return;}catch{}await unlink(lock);return startCollector({root,port,home,once,signal,interval});}
 const reader=new ControlResults(root);let last=null,lastCases=[],names={},nameTime=0,errorCode='',trackedId=null,revision;
 const writer=observationWriter(path.join(projectPaths(root).workbench,'cache/live-observation.json'));
 const shutdown=new AbortController(),stop=()=>shutdown.abort();let running=false;
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 async function tick(){
  const activityResponse=await fetch('http://127.0.0.1:'+port+'/api/control/activity',{signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(20000)])});
  if(!activityResponse.ok)throw new Error('CONTROL_HTTP_'+activityResponse.status);
  const activity=await activityResponse.json();running=activity.active;
  if(!running&&revision===activity.revision)return;
  const response=await fetch('http://127.0.0.1:'+port+'/api/control/status',{signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(20000)])});
  if(!response.ok)throw new Error('CONTROL_HTTP_'+response.status);const s=await response.json();
  if(Date.now()-nameTime>30000){
   names=await collectNames(home);
   for(const j of s.jobs){if(j.pluginSelection?.length&&!names.runs[j.targetId+'::'+j.runId])await reserveRunDisplay(home,{agentId:j.targetId,runId:j.runId,plugins:j.pluginSelection.map(p=>p.name),createdAt:j.createdAt});}
   names=await collectNames(home);nameTime=Date.now();
  }
  const job=s.jobs.find(active)??s.jobs.find(j=>j.runId===trackedId)??s.jobs[0];
  let live=null,liveCases=[],updates=[];
  if(job){
   trackedId=job.runId;
   const currents=job.progress?.currentCases??(job.progress?.current?[job.progress.current]:[]);
   liveCases=await Promise.all((currents.length?currents:[null]).map(async current=>{
    const n=current?.ordinal,previous=lastCases.find(c=>c.runId===job.runId&&c.ordinal===n)??last;
    const matching=previous?.runId===job.runId&&previous?.ordinal===n;
    const caseJob={...job,progress:{...job.progress,current}};
    const session=sessionForJob(s.activeSessions??[],caseJob);
    const value={...(matching?previous:{}),runId:job.runId,agentId:job.targetId,caseId:current?.caseId,ordinal:n,active:active(job),progress:job.progress,phase:active(job)?session?'执行中':matching&&previous.sessionId?'评分与归档中':'准备 Case':'本轮已结束',observedAt:Date.now(),error:null};
    if(active(job)){
     Object.assign(value,await liveTask(root,caseJob));
     if(session){
      if(value.sessionId!==session.id){value.entries=[];value.lastActivity=null;}
      value.sessionId=session.id;value.sessionTitle=session.title;
      try{Object.assign(value,projectHistory(await rpc(s.endpoint,'session.history',{sessionId:session.id,maxMessages:2}),value));}
      catch(e){value.error=e.message;value.phase='实时观测暂不可用';}
     }
    }
    value.entries=(value.entries??[]).map(entry=>entry.kind==='tool'?{...entry,attribution:toolAttribution(entry.name,value.toolDeclarations??[])}:entry);
    return value;
   }));
   live=liveCases[0]??null;
   updates=[await partialRun(reader,job)];
   const staticTools=liveCases.find(value=>value.toolDeclarations?.length)?.toolDeclarations;
   if(staticTools?.length){updates[0].run.target.toolNames=[...new Set(staticTools.filter(t=>typeof t.name==='string').map(t=>t.name))];updates[0].run.target.toolDetails=updates[0].run.target.toolNames.map(name=>({...staticTools.find(t=>t.name===name),attribution:toolAttribution(name,staticTools)}));updates[0].run.target.toolSource='本批次冻结的静态声明';}
   for(const value of liveCases){
    const c=updates[0].run.cases.find(c=>c.id===value.caseId);
    if(c&&active(job)){if(value.title)c.title=value.title;c.ordinal=value.ordinal;if(value.task)updates[0].details[c.id]={...updates[0].details[c.id],task:value.task};}
   }
   last=live;lastCases=liveCases;
  }
  const output={version:1,observedAt:Date.now(),names,live,liveCases,updates};
  await writer(output);
  revision=activity.revision;
 }
 try{
  do{
   try{
    await tick();if(process.connected)process.send({type:'observation-heartbeat',at:Date.now()});
    if(errorCode){console.log('Observation recovered');errorCode='';}
   }catch(e){if(!shutdown.signal.aborted&&errorCode!==e.message){errorCode=e.message;console.error('Observation unavailable:',errorCode);}}
   if(!once&&!shutdown.signal.aborted)await delay(interval(running),undefined,{signal:shutdown.signal}).catch(e=>{if(e.name!=='AbortError')throw e;});
  }while(!once&&!shutdown.signal.aborted);
 }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);signal?.removeEventListener('abort',stop);await unlink(lock).catch(()=>{});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await startCollector({port:Number(process.env.WORKBENCH_PORT??18767),once:process.argv.includes('--once')});
