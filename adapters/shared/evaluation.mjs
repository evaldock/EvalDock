import {compatibilityService as defaultCompatibilityService} from '../compatibility/check.mjs';
import {capabilities} from '../compatibility/contracts.mjs';
import {samplePlannedCases} from '../../dist/src/planning/case-sampling.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile,rename,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {seedWorkspace,snapshot,collectFiles,buildTrace} from './evidence.mjs';
import {safeErrorDiagnostics} from '../../dist/src/core/errors.js';
import {loadModelEnvironment} from '../../dist/src/platform/model-environment.js';
import {projectPaths} from '../../dist/src/platform/paths.js';
import {loadDatasetDescriptionCatalog} from '../../dist/src/datasets/catalog.js';
import {countDatasetQuestionCases,loadDatasetCase} from '../../dist/src/datasets/loader.js';
import {createDefaultDatasetMatcher} from '../../dist/src/planning/planner.js';
import {selectAllDatasets} from '../../dist/src/planning/all-datasets.js';
import {loadLabels} from '../../dist/src/labels/catalog.js';
import {createDefaultLabelJudge,unavailableReferenceScore} from '../../dist/src/evaluation/llm-label-judge.js';
import {aggregateScores} from '../../dist/src/evaluation/scoring.js';
import {buildResult,serializeReportDocument} from '../../dist/src/reporting/record.js';
import {renderReportHtml} from '../../dist/src/reporting/html.js';
import {renderRunReport} from '../../dist/src/reporting/batch-html.js';
import {writeReportLoader} from '../../dist/src/reporting/trace-loader.js';
import {writeTraceDirectory} from '../../dist/src/all-trace/store.js';
const here=path.dirname(fileURLToPath(import.meta.url));
export const atomic=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,file);};
const stamp=()=>new Date().toISOString(),safeId=x=>typeof x==='string'&&/^[a-zA-Z0-9._-]{1,160}$/.test(x);
export async function runEvaluation({root,runId,signal,testSize,validationDatasetIds,evaluationConfig,onProgress=console.error,adapter,matcherFactory=createDefaultDatasetMatcher,judgeFactory=createDefaultLabelJudge,compatibilityService=defaultCompatibilityService}){
  if(!adapter||!safeId(adapter.targetId)||!safeId(runId))throw new Error('AGENT_INVALID_RUN_ID');
  const {kind,targetId,name}=adapter;
  const paths=projectPaths(root),runDir=path.join(paths.results,'agents',targetId,'runs',runId);
  await mkdir(path.dirname(runDir),{recursive:true,mode:0o700});
  await mkdir(runDir,{recursive:false,mode:0o700});
  const summary={schema:'evaldock.mvp.cli-summary/v1',command:'run',agentKind:kind,agentName:name,targetId,runId,status:'RUNNING',datasetTestProfile:'STANDARD',caseResults:[],selectedDatasets:[],totalCaseCount:0,scores:[],dimensions:[],failureGroups:[],reasonCodes:[],operationalHealth:'HEALTHY',securityIsolation:'WORKSPACE_ONLY_NOT_SANDBOX',createdAt:stamp(),caseConcurrency:3,validationOnly:!evaluationConfig&&!!testSize,...evaluationConfig?{evaluationConfig}:testSize?{validationConfig:{testSize,validationDatasetIds}}:{}};
  const persist=async()=>{summary.updatedAt=stamp();await atomic(path.join(runDir,'run.json'),summary);await writeFile(path.join(runDir,'report.html'),renderRunReport(summary),{mode:0o600});};
  let context,releaseCompatibility;
  await persist();
  try{
    releaseCompatibility=await compatibilityService.acquire(adapter);
    const compatibility=await compatibilityService.ensure({root,adapter,signal,onProgress});
    summary.compatibility=compatibility;await persist();
    if(compatibility.status!=='COMPATIBLE')throw Error('AGENT_COMPATIBILITY_'+compatibility.status);
    await compatibilityService.verify(adapter,compatibility);
    const inspection=await adapter.inspect();if(!inspection.evaluationReady)throw new Error(inspection.reasonCode??'AGENT_NOT_READY');
    summary.agentVersion=inspection.version;summary.target={targetId,targetType:'FULL_AGENT',agentKind:kind,agentName:name,agentVersion:inspection.version,installRoot:inspection.installRoot,components:inspection.components??[]};
    await atomic(path.join(runDir,'inspection.json'),{...inspection,...summary.target,toolSchemas:inspection.toolSchemas??[],limitations:inspection.limitations});
    
    const env={...process.env};await loadModelEnvironment(env);env.EVALDOCK_PLANNER_PROMPT_ROOT=adapter.promptRoot??path.join(here,'prompts');env.EVALDOCK_PLANNER_POLICY_FILE=path.join(root,'planning/policies.json');
    context=await adapter.prepare({root,inspection,signal});
    const labels=await loadLabels(path.join(root,'labels')),judge=judgeFactory(env,signal);
    const datasetsRoot=path.resolve(root,process.env.EVALDOCK_DATASETS_ROOT??'datasets'),available=[];
    for(const d of await loadDatasetDescriptionCatalog(path.join(datasetsRoot,'catalog.md'))){const availableCaseCount=await countDatasetQuestionCases(datasetsRoot,d.datasetId);if(availableCaseCount)available.push({...d,availableCaseCount});}
    if(validationDatasetIds&&(!testSize||validationDatasetIds.some(id=>!available.some(d=>d.datasetId===id))))throw new Error('AGENT_INVALID_VALIDATION_DATASETS');
    onProgress('[evaldock:'+kind+'] Planner selecting datasets');
    const choice=evaluationConfig?.selection;
    const effectiveSize=choice?.kind==='COUNT'?{caseCount:choice.caseCount,...choice.datasetCount?{datasetCount:choice.datasetCount}:{}}:testSize;
    let plan;
    if(choice?.kind==='ALL'){
      plan=selectAllDatasets({profile:'STANDARD',signal,testSize:{casesPerDataset:choice.casesPerDataset},availableDatasets:available,agentStaticInfo:adapter.staticInfo(inspection)});
    }else if(choice?.kind==='SELECTED'){
      const datasets=choice.items.map(item=>{
        const candidate=available.find(d=>d.datasetId===item.datasetId);
        if(!candidate||item.caseIndices.some(index=>!Number.isSafeInteger(index)||index<0||index>=candidate.availableCaseCount))throw Error('AGENT_SELECTED_CASE_UNAVAILABLE');
        return {datasetId:candidate.datasetId,evaluationLabelIds:candidate.labelIds,caseCount:item.caseIndices.length,reason:'Operator selected exact Cases'};
      });
      plan={schema:'evaldock.mvp.unified-planner-result/v1',profile:'STANDARD',selectedDatasets:datasets,evaluationLabelIds:[...new Set(datasets.flatMap(d=>d.evaluationLabelIds))],totalCaseCount:datasets.reduce((sum,d)=>sum+d.caseCount,0),model:'explicit-cases',durationMs:0};
    }else{
      plan=await matcherFactory(env,root).select({profile:'STANDARD',signal,testSize:effectiveSize,availableDatasets:validationDatasetIds?available.filter(d=>validationDatasetIds.includes(d.datasetId)):available,agentStaticInfo:adapter.staticInfo(inspection)});
    }
    summary.selectedDatasets=plan.selectedDatasets;summary.totalCaseCount=plan.totalCaseCount;summary.datasetMatchModel=plan.model;await persist();
    let queue=plan.selectedDatasets.flatMap(d=>{
      const indices=choice?.kind==='SELECTED'?choice.items.find(item=>item.datasetId===d.datasetId)?.caseIndices??[]:Array.from({length:d.caseCount},(_,i)=>i);
      return indices.map(i=>({dataset:d,caseIndex:i,caseId:d.datasetId.replace(/^dataset\./,'').replace(/\/v\d+$/,'')+'.case-'+(i+1)}));
    });
    if(choice?.kind!=='ALL'&&choice?.kind!=='SELECTED'){
      const sampling=await samplePlannedCases({root,datasetsRoot,selection:plan});
      if(sampling){
        queue=sampling.queue.map(item=>({...item,dataset:plan.selectedDatasets.find(d=>d.datasetId===item.datasetId)}));
        summary.caseSampling=sampling.metadata;
        onProgress('[evaldock:sampling] '+JSON.stringify(sampling.metadata));
      }
    }
    await atomic(path.join(runDir,'plan.json'),{...plan,schema:'evaldock.workbench.plan/v1',runId,agentId:targetId,createdAt:stamp(),queue:queue.map(item=>({datasetId:item.dataset.datasetId,caseIndex:item.caseIndex,caseId:item.caseId,...item.difficulty?{difficulty:item.difficulty}:{}})),...summary.caseSampling?{caseSampling:summary.caseSampling}:{},...evaluationConfig?{evaluationConfig}:{}});
    const caseProgress=(ordinal,item,phase,extra={})=>onProgress('[evaldock:case] '+JSON.stringify({ordinal:ordinal+1,total:queue.length,caseId:item.caseId,datasetId:item.dataset.datasetId,phase,at:stamp(),...extra}));
    queue.forEach((item,ordinal)=>caseProgress(ordinal,item,'QUEUED'));
    let cursor=0,persistence=Promise.resolve(),cleanupUnconfirmed=false;
    const work=async()=>{while(!signal?.aborted&&!cleanupUnconfirmed&&cursor<queue.length){
      const ordinal=cursor++,item=queue[ordinal];if(!safeId(item.caseId))throw new Error('AGENT_INVALID_CASE_ID');
      onProgress(`[evaldock:batch] starting ${ordinal+1}/${queue.length}: ${item.caseId}`);
      const caseDir=path.join(runDir,'cases',item.caseId);await mkdir(caseDir,{recursive:true,mode:0o700});
      const workspace=path.join(paths.runtime,kind,runId,item.caseId),startedAt=stamp();
      caseProgress(ordinal,item,'PREPARING');
      const scope={targetId,runId,caseId:item.caseId,attemptId:item.caseId+'.attempt-1'};
      let data,capture={queue:[],seen:0,final:'',error:null,cleanup:'NOT_STARTED'},before={entries:[],truncated:true},after=before,traceRef,trace,report;
      try{
        data=await loadDatasetCase({datasetsRoot,datasetId:item.dataset.datasetId,labelIds:item.dataset.evaluationLabelIds,caseIndex:item.caseIndex});
        if(!adapter.supportsAttachments&&data.inputs.some(i=>i.delivery==='chat-attachment'))throw new Error('AGENT_CHAT_ATTACHMENT_UNSUPPORTED');
        await seedWorkspace(workspace,data.seedEntries);before=await snapshot(workspace);
        const task=data.task+'\n\n工作目录：'+(adapter.workspaceDescription?.(workspace)??workspace)+'\n提供的输入文件：'+(data.inputs.map(i=>i.destination).join('、')||'无')+'\n请将需要交付的文件写入：'+data.allowedPaths.join('、')+'。';
        caseProgress(ordinal,item,'EXECUTING');
        await compatibilityService.verify(adapter,compatibility);
        capture=await adapter.run({context,root,caseDirectory:caseDir,caseData:data,cwd:workspace,prompt:task,deadlineMs:Math.min(data.deadlineMs,30*60*1000),signal,onSession:(sessionId,processInfo={})=>{caseProgress(ordinal,item,'EXECUTING',{sessionId});return atomic(path.join(caseDir,'session.json'),{schema:'evaldock.agent-session/v1',agentKind:kind,sessionId,...processInfo,runId,caseId:item.caseId,workspace,startedAt,cleanup:'PENDING'});}});
        const evidenceIssues=compatibilityService.validate(adapter,capture,{required:capabilities(adapter)});
        if(evidenceIssues.length){const critical=evidenceIssues.find(i=>/TOOL|SUBTASK|SESSION|CLEANUP|EVIDENCE/.test(i.code));if(critical){capture.executionError=capture.error;capture.error=critical.code;}else capture.error??=evidenceIssues[0].code;await atomic(path.join(caseDir,'compatibility.json'),{status:'INDETERMINATE',issues:evidenceIssues});}
        try{await compatibilityService.verify(adapter,compatibility);}catch(e){capture.error='AGENT_IDENTITY_CHANGED';cleanupUnconfirmed=true;}
        if(capture.cleanup==='UNKNOWN'){cleanupUnconfirmed=true;await compatibilityService.quarantine(root,adapter,'AGENT_CLEANUP_UNCONFIRMED');}
        if(capture.sessionId)await atomic(path.join(caseDir,'session.json'),{schema:'evaldock.agent-session/v1',agentKind:kind,sessionId:capture.sessionId,processGroupId:capture.processGroupId,runId,caseId:item.caseId,workspace,startedAt,endedAt:stamp(),cleanup:capture.cleanup});
        caseProgress(ordinal,item,'COLLECTING');
        after=await snapshot(workspace);const delivery=await collectFiles(workspace,after,data.allowedPaths,scope),endedAt=stamp();
        if(delivery.files.length&&!(capture.queue??[]).some((r,i)=>adapter.trace.normalizeEvent(r,capture.sessionId,i+1).data.event.type==='tool/call'))capture.error??='AGENT_FILE_EVIDENCE_MISSING';
        if(capture.error)await compatibilityService.invalidate(root,adapter);
        trace=buildTrace({scope,capture,before,after,delivery,startedAt,endedAt,agent:adapter.trace});
        traceRef=await writeTraceDirectory({caseDirectory:caseDir,trace,maxBytes:20*1024*1024,readArtifact:async a=>{const b=delivery.bodies.get(a.artifactId);if(!b)throw Error('AGENT_ARTIFACT_UNAVAILABLE');return b;}});
        const caseLabels=labels.filter(l=>data.labelIds.includes(l.labelId));if(caseLabels.length!==data.labelIds.length)throw new Error('AGENT_LABEL_NOT_FOUND');
        const scores=[];const judgingAllowed=!capture.error||['WORKBUDDY_TASK_TIMEOUT','WORKBUDDY_TURN_INCOMPLETE','AGENT_TASK_TIMEOUT','AGENT_TURN_INCOMPLETE'].includes(capture.error);if(judgingAllowed&&!signal?.aborted)for(const label of caseLabels){caseProgress(ordinal,item,'JUDGING',{labelId:label.labelId,labelIndex:scores.length+1,labelCount:caseLabels.length});scores.push(data.grading.mode==='unavailable'?unavailableReferenceScore({label,case:data,allTrace:trace}):await judge.evaluate({label,case:data,allTrace:trace,evaluationMode:evaluationConfig?.mode??'FULL'}));if(signal?.aborted)break;}
        caseProgress(ordinal,item,'REPORTING');
        report=buildResult({evaluationMode:evaluationConfig?.mode??'FULL',runId,scope,target:summary.target,inspection:{toolSchemas:inspection.toolSchemas??[],limitations:inspection.limitations,probeSchema:'evaldock.all-trace/v1',probeConfigured:true,headlessDriverStatus:inspection.driver??'DESKTOP_RPC',permissionPreset:inspection.permissionPreset??'APPLICATION_DEFAULT',sandboxMode:'WORKSPACE_ONLY_NOT_SANDBOX'},plan:{status:'FROZEN',casePlan:{datasetId:item.dataset.datasetId,labelIds:data.labelIds,environmentId:kind+'.workspace',deadlineMs:data.deadlineMs,allowedPaths:data.allowedPaths,forbiddenPaths:['private','checks']}},case:data,labels:caseLabels,execution:{task,agentSessionIds:capture.sessionId?[capture.sessionId]:[],terminationKind:capture.error??capture.result?.stopReason??'UNKNOWN',exitCode:capture.error?1:0,stdout:capture.final??'',stdoutCapturedBytes:Buffer.byteLength(capture.final??''),stdoutCaptureTruncated:!!capture.finalTruncated,stdoutReportTruncated:!!capture.finalTruncated,startedAt,endedAt,durationMs:Date.parse(endedAt)-Date.parse(startedAt)},allTraceRef:traceRef,scores,dimensions:aggregateScores(scores),artifacts:trace.artifacts,timeline:[{number:1,label:name+' 任务执行',status:capture.error?'FAILED':'SUCCEEDED',objectRefs:capture.sessionId?[capture.sessionId]:[],failureGroups:[]}],currentPhase:'REPORTED',runState:capture.error?'FAILED':'COMPLETED',operationalHealth:capture.error||scores.some(s=>s.status==='ERROR')?'DEGRADED':'HEALTHY',fixture:false,securityIsolation:summary.securityIsolation,environmentState:'WORKSPACE_RETAINED_GLOBAL_RESET_NOT_PERFORMED',failures:capture.error?[{code:capture.error,severity:'ERROR',message:capture.error}]:[]},'evaldock-agent-adapter/1');
        await writeFile(path.join(caseDir,'report.json'),serializeReportDocument(report),{flag:'wx',mode:0o600});await writeFile(path.join(caseDir,'report.html'),renderReportHtml(report),{flag:'wx',mode:0o600});await writeReportLoader(caseDir);
      }catch(e){capture.error=/^(WORKBUDDY|AGENT|PI|LANGGRAPH|HERMES|OPENCLAW)_[A-Z0-9_]+$/.test(e.message??'')?e.message:'AGENT_CASE_FAILED';onProgress('[evaldock:'+kind+'] '+capture.error);await atomic(path.join(caseDir,'failure.json'),{code:capture.error,at:stamp(),diagnostics:safeErrorDiagnostics(e)});}
      if(capture.sessionId)await atomic(path.join(caseDir,'session.json'),{schema:'evaldock.agent-session/v1',agentKind:kind,sessionId:capture.sessionId,processGroupId:capture.processGroupId,runId,caseId:item.caseId,workspace,startedAt,endedAt:stamp(),cleanup:capture.cleanup});
      const status=signal?.aborted?'CANCELLED':capture.error?'FAILED':'COMPLETED';
      const result={caseId:item.caseId,datasetId:item.dataset.datasetId,status,scores:report?.scores??[],agentSessionIds:capture.sessionId?[capture.sessionId]:[],dshSessionIds:[],...(report?{reportHtml:true}:{}),reasonCodes:capture.error?[capture.error]:[]};
      caseProgress(ordinal,item,status,{reasonCode:capture.error??null});
      summary.caseResults.push(result);summary.caseResults.sort((a,b)=>queue.findIndex(c=>c.caseId===a.caseId)-queue.findIndex(c=>c.caseId===b.caseId));summary.scores=summary.caseResults.flatMap(c=>c.scores);summary.dimensions=aggregateScores(summary.scores);
      persistence=persistence.then(persist);await persistence;onProgress(`[evaldock:batch] finished ${ordinal+1}/${queue.length}: ${item.caseId} (${status})`);
    }};
    const workers=await Promise.allSettled(Array.from({length:Math.min(3,queue.length)},work));
    if(workers.some(r=>r.status==='rejected'))throw new Error('AGENT_REPORT_WRITE_FAILED');
    summary.status=signal?.aborted?'CANCELLED':summary.caseResults.some(c=>c.status==='FAILED')||cleanupUnconfirmed?'FAILED':'COMPLETED';
    summary.reasonCodes=[...new Set(summary.caseResults.flatMap(c=>c.reasonCodes))];
    if(cleanupUnconfirmed)summary.reasonCodes.push('AGENT_CLEANUP_UNCONFIRMED');
    if(summary.status!=='COMPLETED'||summary.scores.some(s=>s.status==='ERROR'))summary.operationalHealth='DEGRADED';
  }catch(e){summary.failureDiagnostics=safeErrorDiagnostics(e);onProgress(JSON.stringify({phase:'PREPARATION',diagnostics:summary.failureDiagnostics}));summary.status=signal?.aborted?'CANCELLED':'FAILED';summary.operationalHealth='DEGRADED';summary.reasonCodes.push(/^(WORKBUDDY|AGENT|PI|LANGGRAPH|HERMES|OPENCLAW)_[A-Z0-9_]+$/.test(e.message??'')?e.message:'AGENT_PREPARATION_FAILED');}
  finally{try{await adapter.dispose(context);}catch(e){summary.status='FAILED';summary.operationalHealth='DEGRADED';summary.reasonCodes.push('AGENT_CLEANUP_UNCONFIRMED');summary.failureDiagnostics=safeErrorDiagnostics(e);}summary.endedAt=stamp();try{await persist();}finally{await releaseCompatibility?.();}}
  return summary;
}
