/** Bridge the existing DSH Web executor into the same host-owned acceptance suite. */
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectWebTarget,executeWebTarget,rpc} from '../../dist/src/runtime/web-target.js';
import {dshConfiguration} from '../../dist/src/runtime/dsh-control.js';
import {Capture,normalizedEvent} from '../shared/capture.mjs';
import {ensureCompatibility,verifyIdentity} from './check.mjs';
import {acquire} from './store.mjs';
export function createDshCompatibilityAdapter(descriptor){
 return {
  kind:descriptor.webEndpoint?'dsh-web':'dsh-headless',targetId:String(descriptor.targetId),name:'DSH',configuration:{...descriptor,executable:path.resolve(descriptor.sourceRoot,descriptor.dshExecutable)},
  compatibilityUnavailable:descriptor.webEndpoint?null:'AGENT_DSH_HEADLESS_SUITE_UNAVAILABLE',
  trace:{normalizeEvent:normalizedEvent},
  async inspect(){
   if(!descriptor.webEndpoint)return {evaluationReady:false,reasonCode:'AGENT_DSH_HEADLESS_SUITE_UNAVAILABLE'};
   const [state,configuration]=await Promise.all([inspectWebTarget(descriptor),dshConfiguration(descriptor)]);
   return {evaluationReady:true,version:state.dshVersion,installRoot:descriptor.sourceRoot,components:configuration.plugins,configuration:{profileDigest:configuration.profileDigest,model:state.web?.model,permission:state.permissionPreset}};
  },
  prepare:async()=>({}),dispose(){},
  async run({cwd,caseDirectory,prompt,deadlineMs,signal,onSession}){
   const home=path.join(caseDirectory,'runtime');await mkdir(home,{recursive:true});
   const capture=new Capture('dsh-web');let owned;
   const result=await executeWebTarget({executablePath:path.resolve(descriptor.sourceRoot,descriptor.dshExecutable),profile:descriptor.profile,task:prompt,cwd,runtimeDshHomePath:home,probeOutputPath:path.join(home,'probe.jsonl'),sourceRunId:'compat-'+randomUUID(),contentMode:'FULL',deadlineMs,maxOutputBytes:65536,signal,
    onStarted:async()=>{const receipt=JSON.parse(await readFile(path.join(home,'web-session.json'),'utf8'));owned=receipt.sessionId;await onSession(owned);}},descriptor);
   capture.sessionId=owned??capture.sessionId;capture.finalText(result.stdout.toString('utf8'));
   if(owned){
    const state=await rpc(descriptor.webEndpoint,'session.list',{});
    capture.cleanup=Array.isArray(state.items)&&!state.items.some(s=>s.sessionId===owned&&s.running)?'STOPPED':'UNKNOWN';
    const history=await rpc(descriptor.webEndpoint,'session.history',{sessionId:owned,maxMessages:200});
    const rows=(history.events??[]).map(x=>x.event??x);let previous;
    for(const event of rows){
     if(typeof event.seq!=='number'||previous!==undefined&&event.seq!==previous+1)capture.error='AGENT_DSH_SEQUENCE_CONTRACT_BROKEN';
     previous=event.seq;
     if(event.type==='tool/call'||event.type==='tool/result')capture.add(event.type,event.data);
    }
    if(!rows.some(e=>e.type==='turn/end')&&result.terminationKind!=='CANCELLED')capture.error='AGENT_COMPLETION_UNCONFIRMED';
   }else capture.cleanup='UNKNOWN';
   if(result.terminationKind==='EXITED')capture.result={stopReason:'end_turn'};
   else capture.error=result.terminationKind==='CANCELLED'?'AGENT_CANCELLED':'AGENT_DSH_EXECUTION_FAILED';
   return capture.finish();
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
