import {mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {SUITE_VERSION,capabilities,validateCapture,conclusion,classify,events} from './contracts.mjs';
import {fingerprint,hash} from './identity.mjs';
import {atomic,readJSON,dataRoot,acquire,quarantine,invalidate,assertNotQuarantined} from './store.mjs';
import {excerpt} from '../shared/capture.mjs';
const TTL=24*60*60*1000;
async function ordinaryFile(file){try{const s=await lstat(file);return s.isFile()&&!s.isSymbolicLink()&&s.size<65536?await readFile(file,'utf8'):null;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function safeCode(e){if(e?.code==='ENOENT')return 'AGENT_ENVIRONMENT_PATH_MISSING';if(e?.code==='EACCES')return 'AGENT_ENVIRONMENT_ACCESS_DENIED';return /^[A-Z][A-Z0-9_]+$/.test(e?.message??'')?e.message:'AGENT_COMPATIBILITY_CHECK_FAILED';}
/** Caller owns the same execution lease used by formal runs. No Planner/Judge import. */
export async function ensureCompatibility({root,adapter,signal,force=false,required=capabilities(adapter),onProgress=()=>{}}){
  const id=randomUUID(),directory=path.join(dataRoot(root),'checks',id);
  await mkdir(directory,{recursive:true,mode:0o700});
  const report={schema:'evaldock.compatibility/v1',id,targetId:adapter.targetId,kind:adapter.kind,suite:SUITE_VERSION,status:'INDETERMINATE',required,passedCapabilities:[],checks:[],issues:[],createdAt:new Date().toISOString(),evidence:directory};
  let context,identity,inspection;
  const save=async()=>{report.status=conclusion(report.issues);report.completedAt=new Date().toISOString();await atomic(path.join(directory,'report.json'),report);return report;};
  try{
    await assertNotQuarantined(root,adapter);
    if(signal?.aborted)throw Error('AGENT_CANCELLED');
    if(adapter.compatibilityUnavailable)throw Error(adapter.compatibilityUnavailable);
    inspection=await adapter.inspect();
    if(!inspection.evaluationReady)throw Error(inspection.reasonCode??'AGENT_ENVIRONMENT_NOT_READY');
    identity=await fingerprint(adapter,inspection);report.fingerprint=identity;
    if(required.some(x=>!capabilities(adapter).includes(x)))throw Error('AGENT_CAPABILITY_NOT_DECLARED');
    const receiptFile=path.join(dataRoot(root),'receipts',hash(adapter.targetId)+'.json');
    const receipt=await readJSON(receiptFile);
    if(!force&&receipt?.status==='COMPATIBLE'&&receipt.suite===SUITE_VERSION&&receipt.fingerprint.digest===identity.digest&&Date.now()<Date.parse(receipt.expiresAt)&&required.every(x=>receipt.passedCapabilities.includes(x))){
      const evidence=await readJSON(path.join(dataRoot(root),'checks',receipt.id,'report.json'));
      if(evidence&&hash(evidence)===receipt.reportDigest){report.reusedFrom=receipt.id;if(evidence.runtimeFacts)report.runtimeFacts=evidence.runtimeFacts;report.passedCapabilities=receipt.passedCapabilities;return save();}
    }
    await rm(receiptFile,{force:true});
    context=await adapter.prepare({root,inspection,signal});
    const sessions=new Set(),priorSecrets=[];
    async function execute(name,prompt,{files=false,cancel=false,subtasks=false}={}){
      if(signal?.aborted)throw Error('AGENT_CANCELLED');
      const caseDirectory=path.join(directory,name),cwd=path.join(caseDirectory,'workspace');await mkdir(path.join(cwd,'input'),{recursive:true});await mkdir(path.join(cwd,'output'),{recursive:true});
      const secret='compat-'+randomUUID();
      if(files)await writeFile(path.join(cwd,'input/challenge.txt'),secret+'\n',{mode:0o600});
      const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
      const delayedCancel=required.includes('files')&&(adapter.kind!=='langgraph'||(adapter.configuration?.tools??[]).some(name=>/shell|terminal|bash|exec/i.test(name)));
      let timer,watcher,cancelObserved=false,sessionId,cancelAt;
      if(cancel&&delayedCancel){watcher=setInterval(()=>{void ordinaryFile(path.join(cwd,'output/started.txt')).then(value=>{if(value?.trim()==='started'){cancelObserved=true;cancelAt??=Date.now();controller.abort();}}).catch(()=>{});},100);}
      const task=prompt+'\n工作目录：'+(adapter.workspaceDescription?.(cwd)??cwd)+'\n仅操作本工作目录，不访问其他会话、账号或目录。';
      let capture;
      onProgress('[evaldock:compatibility] '+name);
      try{
        timer=setTimeout(abort,120000);
        capture=await adapter.run({context,root,cwd,caseDirectory,caseData:{inputs:[],allowedPaths:['output']},prompt:task,deadlineMs:120000,signal:controller.signal,
          onActivity:()=>{if(cancel&&!delayedCancel){cancelObserved=true;controller.abort();}},
          onSession:async id=>{sessionId=id;await atomic(path.join(caseDirectory,'session.json'),{sessionId:id,cleanup:'PENDING'});}});
      }catch(e){capture={error:safeCode(e),cleanup:sessionId?'UNKNOWN':'NOT_STARTED',queue:[]};}
      finally{clearTimeout(timer);clearInterval(watcher);signal?.removeEventListener('abort',abort);}
      const issues=validateCapture(adapter,capture,{required:[...(files?['tools','files']:[]),...(subtasks?['subtasks']:[])],controlled:true,cancel});
      if(sessionId&&capture.sessionId!==sessionId)issues.push({code:'AGENT_SESSION_CONTRACT_BROKEN',status:'INCOMPATIBLE'});
      if(!capture.sessionId||sessions.has(capture.sessionId))issues.push({code:'AGENT_SESSION_ISOLATION_UNCONFIRMED',status:'INDETERMINATE'});
      sessions.add(capture.sessionId);
      const serialized=JSON.stringify(capture);
      if(priorSecrets.some(token=>serialized.includes(token)))issues.push({code:'AGENT_SESSION_CONTRACT_BROKEN',status:'INCOMPATIBLE'});
      if(files){
        const actual=await ordinaryFile(path.join(cwd,'output/answer.txt'));
        if(actual?.trim()!==secret)issues.push({code:'AGENT_FILE_BEHAVIOR_NOT_COVERED',status:'INDETERMINATE'});
        const rows=events(adapter,capture);
        if(actual?.trim()===secret&&!rows.some(e=>e.type==='tool/call'&&String(JSON.stringify(e.data?.arguments)).includes('answer.txt')))issues.push({code:'AGENT_WRITE_EVIDENCE_CONTRACT_BROKEN',status:'INCOMPATIBLE'});
        if(actual?.trim()===secret&&!rows.some(e=>e.type==='tool/result'&&String(JSON.stringify(e.data?.result)).includes(secret)))issues.push({code:'AGENT_READ_EVIDENCE_CONTRACT_BROKEN',status:'INCOMPATIBLE'});
        priorSecrets.push(secret);
      }
      if(cancel){
        if(cancelAt)await new Promise(resolve=>setTimeout(resolve,Math.max(0,cancelAt+4000-Date.now())));
        if(!cancelObserved||!delayedCancel&&!capture.seen)issues.push({code:'AGENT_CANCEL_BEHAVIOR_NOT_COVERED',status:'INDETERMINATE'});
        if(delayedCancel&&await ordinaryFile(path.join(cwd,'output/late.txt'))!==null)issues.push({code:'AGENT_CANCEL_CONTRACT_BROKEN',status:'INCOMPATIBLE'});
      }
      if(name==='text'&&!capture.final?.includes('EVALDOCK_COMPAT_OK'))issues.push({code:'AGENT_TEXT_BEHAVIOR_NOT_COVERED',status:'INDETERMINATE'});
      if(name==='text'&&!issues.length&&adapter.kind==='dsh-headless'&&capture.runtimeFacts)report.runtimeFacts=capture.runtimeFacts;
      await atomic(path.join(caseDirectory,'capture.json'),excerpt(capture,65536));
      await atomic(path.join(caseDirectory,'session.json'),{sessionId:capture.sessionId??sessionId??null,cleanup:capture.cleanup});
      report.checks.push({name,...(cancel?{cancelMode:delayedCancel?'DELAYED_FILE_WRITE':'OBSERVED_GRAPH_ACTIVITY'}:{}),status:conclusion(issues),issues,sessionId:capture.sessionId??null});report.issues.push(...issues);
      if(capture.cleanup==='UNKNOWN'||capture.cleanup==='PENDING'){await quarantine(root,adapter,'AGENT_CLEANUP_UNCONFIRMED');throw Error('AGENT_CLEANUP_UNCONFIRMED');}
      return issues.length===0;
    }
    if(await execute('text','仅回复 EVALDOCK_COMPAT_OK。'))report.passedCapabilities.push('text');
    if(required.includes('files')||required.includes('tools')){
      const prompt='必须实际使用工具读取 input/challenge.txt，将读取的内容原样写入 output/answer.txt，并在最终回复中给出读取的内容。不要猜测文件内容。';
      const first=await execute('files-first',prompt,{files:true});
      const second=await execute('files-second',prompt,{files:true});
      if(first&&second)report.passedCapabilities.push('files','tools','isolation');
    }else if(await execute('text-second','这是独立的新会话，仅回复 SECOND_SESSION_OK，不引用其他会话。'))report.passedCapabilities.push('isolation');
    if(required.includes('subtasks')&&await execute('subtasks','必须创建一个后台任务或子 Agent，由它实际读取 input/challenge.txt 并将内容原样写到 output/answer.txt。等待它真正完成后，在最终回复中给出文件内容。',{files:true,subtasks:true}))report.passedCapabilities.push('subtasks');
    if(required.includes('cancel')&&await execute('cancel',(required.includes('files')&&(adapter.kind!=='langgraph'||(adapter.configuration?.tools??[]).some(name=>/shell|terminal|bash|exec/i.test(name))))?'必须使用 Shell 执行：先写入 output/started.txt，内容为 started；随后 sleep 3；最后写入 output/late.txt。保持任务执行，不提前回复。':'请连续生成一万行不同的短句，直到任务被取消。',{cancel:true}))report.passedCapabilities.push('cancel');
    for(const capability of required)if(!report.passedCapabilities.includes(capability))report.issues.push({code:'AGENT_CAPABILITY_UNVERIFIED_'+capability.toUpperCase(),status:'INDETERMINATE'});
    await adapter.dispose(context);context=undefined;
    if((await fingerprint(adapter,await adapter.inspect())).digest!==identity.digest)throw Error('AGENT_IDENTITY_CHANGED');
    await save();
    if(report.status==='COMPATIBLE')await atomic(receiptFile,{...report,reportDigest:hash(report),expiresAt:new Date(Date.now()+TTL).toISOString()});
    return report;
  }catch(e){const code=safeCode(e);report.issues.push({code,status:classify(code)});return await save();}
  finally{if(context!==undefined){try{await adapter.dispose(context);}catch{await quarantine(root,adapter,'AGENT_CLEANUP_UNCONFIRMED');report.issues.push({code:'AGENT_CLEANUP_UNCONFIRMED',status:'ENVIRONMENT_BLOCKED'});await save();}}}
}
export async function verifyIdentity(adapter,report){
  const inspection=await adapter.inspect();if(!inspection.evaluationReady)throw Error(inspection.reasonCode??'AGENT_ENVIRONMENT_NOT_READY');
  if((await fingerprint(adapter,inspection)).digest!==report.fingerprint?.digest)throw Error('AGENT_IDENTITY_CHANGED');
}
export const compatibilityService={acquire,ensure:ensureCompatibility,verify:verifyIdentity,validate:validateCapture,quarantine,invalidate};
