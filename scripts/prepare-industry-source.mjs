#!/usr/bin/env node
/** Evaluator-only snapshot: public tasks and allowlisted score metadata, never grading references. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {sha256} from './lib/industry-assessment.mjs';
const requireThat=(v,code)=>{if(!v)throw Error(code);};
const token=value=>requireThat(typeof value==='string'&&/^[a-zA-Z0-9_.-]+$/.test(value),'INVALID_SOURCE_TOKEN');
export async function prepareIndustrySource({runtimeRoot,apiUrl,roundId,outputFile}) {
 const api=new URL(apiUrl);requireThat(['http:','https:'].includes(api.protocol)&&['127.0.0.1','localhost','[::1]'].includes(api.hostname)&&!api.username&&!api.password,'LOOPBACK_SOURCE_REQUIRED');token(roundId);
 const root=await realpath(runtimeRoot),load=rel=>import(pathToFileURL(path.join(root,rel)).href);
 const [{localConfig},{currentQuestionCases},{parseVerifiedReportDocument},{findLogicalRound,readRoundSource},{readScoreRevision}]=await Promise.all([
  load('collaboration/config.mjs'),load('dist/src/datasets/loader.js'),load('dist/src/reporting/record.js'),load('workbench/lib/logical-rounds.mjs'),load('workbench/lib/score-revisions.mjs')]);
 const team=localConfig(root);requireThat(team,'LOGICAL_ROUND_RUNTIME_REQUIRED');
 const response=await fetch(new URL(`/api/control/rounds/${roundId}/report.json`,api),{signal:AbortSignal.timeout(30000)});requireThat(response.ok,'ROUND_SOURCE_UNAVAILABLE');const doc=await response.json();
 requireThat(doc.schema==='evaldock.logical-round-report/v1'&&doc.round?.id===roundId&&doc.round.agentKind==='dsh'&&doc.plan?.model==='explicit-all-datasets','ROUND_SOURCE_MISMATCH');
 const record=await findLogicalRound(team,doc.round.canonicalAgentId,roundId);requireThat(record,'ROUND_MANIFEST_REQUIRED');const canonical=await readRoundSource(team,record.manifest.canonical);const queue=new Map(canonical.plan.queue.map(c=>[c.caseId,c]));
 const cases=[],teamRoot=await realpath(team.teamRoot);
 for(const c of doc.round.cases){
  const item=queue.get(c.id);requireThat(item?.datasetId===c.dataset,'ROUND_CASE_PLAN_MISMATCH');
  let report=null,sourceReport=null,bytes=null,question=null,task=null,questionFileSha256=null;
  if(c.source?.reportSha256){
   const s=c.source;[s.teamJobId,s.agentId,s.runId,c.id].forEach(token);
   sourceReport=path.join(teamRoot,'runs',s.teamJobId,'var/evaluation-results/agents',s.agentId,'runs',s.runId,'cases',c.id,'report.json');
   requireThat((await realpath(sourceReport)).startsWith(teamRoot+path.sep),'REPORT_OUTSIDE_TEAM');const info=await lstat(sourceReport);requireThat(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024*1024,'SOURCE_REPORT_FILE_INVALID');
   bytes=await readFile(sourceReport);requireThat(sha256(bytes)===s.reportSha256,'SOURCE_REPORT_CHANGED');report=parseVerifiedReportDocument(bytes.toString());
   question=report.case?.question;task=report.case?.task;
   const revision=await readScoreRevision(path.dirname(sourceReport),report);requireThat(!revision||revision.status==='available','SOURCE_REVISION_INVALID');
   if(c.scoringRevision)requireThat(revision?.revision.id===c.scoringRevision.id,'SOURCE_REVISION_CHANGED');
   const scores=revision?.scores??report.scores;
   if(c.effective)for(const [id,score] of Object.entries(c.scores)){
    const actual=scores.find(s=>s.labelId===id);requireThat(actual&&score.standardDigest===actual.labelDigest?.value,'SOURCE_SCORE_STANDARD_MISMATCH');
    if(score.state==='scored')requireThat(actual.status==='SCORED'&&actual.score===score.value,'SOURCE_SCORE_CHANGED');
    if(score.state==='null')requireThat(actual.status==='UNASSESSABLE','SOURCE_SCORE_STATE_MISMATCH');
   }
  }else{
   const files=await currentQuestionCases(team.datasetsRoot,c.dataset),file=files[item.caseIndex];requireThat(file,'UNEXECUTED_PUBLIC_TASK_UNAVAILABLE');
   const bytes=await readFile(file);question=JSON.parse(bytes);questionFileSha256=sha256(bytes);
   task=await readFile(path.join(path.dirname(file),'prompt.md'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return question.task?.instructions;});
  }
  requireThat(typeof task==='string'&&task&&typeof question?.id==='string','PUBLIC_TASK_UNAVAILABLE');
  cases.push({caseId:c.id,datasetId:c.dataset,questionId:question.id,questionTitle:question.title,task,effective:c.effective===true,scoringStatus:c.scoringStatus,executionStatus:c.executionStatus,
   holdReason:c.holdReason??null,source:c.source??null,sourceReport,sourceReportSha256:bytes?sha256(bytes):null,caseDigest:report?.case?.contentDigest??null,traceDigest:report?.allTraceRef?.contentDigest??null,
   scoreRevision:c.scoringRevision??null,evaluationMode:c.evaluationMode??report?.evaluationMode??doc.round.evaluationMode,weight:c.weight??1,hasTrace:!!report?.allTraceRef,
   classificationTaskSource:report?'FROZEN_REPORT':'INSTALLED_UNEXECUTED',questionFileSha256,
   scores:Object.fromEntries(Object.entries(c.scores??{}).map(([id,s])=>[id,Object.fromEntries(['state','value','scale','standardDigest','standardVersion'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]]))]))});
 }
 const value={schema:'evaldock.industry-source/v1',roundId,generatedAt:new Date().toISOString(),roundManifestSha256:record.sha256,cases};
 await writeFile(outputFile,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});return {roundId,caseCount:cases.length,frozenReportCount:cases.filter(c=>c.sourceReport).length,sourceSnapshotSha256:sha256(await readFile(outputFile))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href){
 try{const o={};for(let i=2;i<process.argv.length;i+=2){requireThat(['--runtime-root','--api-url','--round-id','--output'].includes(process.argv[i])&&process.argv[i+1],'INVALID_ARGUMENT');o[process.argv[i]]=process.argv[i+1];}
  requireThat(Object.keys(o).length===4,'RUNTIME_API_ROUND_OUTPUT_REQUIRED');console.log(JSON.stringify(await prepareIndustrySource({runtimeRoot:o['--runtime-root'],apiUrl:o['--api-url'],roundId:o['--round-id'],outputFile:o['--output']})));
 }catch(e){console.error(JSON.stringify({error:e.message??'INDUSTRY_SOURCE_FAILED'}));process.exitCode=1;}
}
