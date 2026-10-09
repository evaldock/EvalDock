import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdir,readFile,rm,writeFile,chmod} from 'node:fs/promises';
import {temporary,question,json,judgeInput,trace} from './support.mjs';
import {loadDatasetCase} from '../../dist/src/datasets/loader.js';
import {createDefaultLabelJudge,parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
import {scoreBenchDockReport} from '../../dist/src/evaluation/benchdock.js';
import {writeTraceDirectory} from '../../dist/src/all-trace/store.js';
import {buildResult,serializeReportDocument} from '../../dist/src/reporting/record.js';
import {runEvaluation} from '../../adapters/shared/evaluation.mjs';

async function publicCase(t){
 const root=await temporary(t),{dir,q}=await question(root);
 q.grading={mode:'unavailable',reason:'PRIVATE_EVALUATOR_NOT_DISTRIBUTED',weight:0.5};
 q.inputs.forEach(x=>x.delivery='workspace');
 const provenance=JSON.stringify({schema:'benchdock.catalog/v1',distribution:'bundled',task_id:q.id,title:q.title,prompt:q.task.instructions,inputs:q.inputs.map(x=>({destination:x.destination,sha256:x.sha256}))});
 await writeFile(path.join(dir,'PROVENANCE.json'),provenance);
 q.version='a'.repeat(40);
 q.benchdock={repo_id:'EvalDock/BenchDock',task_id:q.id,revision:'a'.repeat(40),task_record_sha256:createHash('sha256').update(provenance).digest('hex')};
 await json(path.join(dir,'question.json'),q);await rm(path.join(dir,'private'),{recursive:true});
 const data=await loadDatasetCase({datasetsRoot:root,datasetId:'dataset.example/v1',labelIds:['label.contract/v1']});
 return {root,dir,q,data};
}
test('public Case loads without a private directory; Judge never needs credentials or invents a zero score',async t=>{
 const {data,dir,q}=await publicCase(t);
 const input={...judgeInput(),case:data};
 const result=await createDefaultLabelJudge({}).evaluate(input);
 assert.equal(result.status,'UNASSESSABLE');assert.equal(result.score,null);assert.equal(result.model,'not-invoked');
 q.grading.reference='private/secret.json';await json(path.join(dir,'question.json'),q);
 await assert.rejects(loadDatasetCase({datasetsRoot:path.dirname(path.dirname(dir)),datasetId:'dataset.example/v1',labelIds:['label.contract/v1']}),/must not carry/);
});
test('shared execution pipeline preserves outputs and report without calling an injected Judge',async t=>{
 const {root,data,dir}=await publicCase(t),runtime=await temporary(t),label=judgeInput().label;
 const {cp}=await import('node:fs/promises');
 await cp(root,path.join(runtime,'datasets'),{recursive:true});
 await json(path.join(runtime,'labels/contract.json'),label);
 await writeFile(path.join(runtime,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Synthetic',description:'Fixture',labelIds:[label.labelId],availableCaseCount:1}]})+'\n```');
 const adapter={kind:'pi',targetId:'pi',name:'Synthetic runner',inspect:async()=>({evaluationReady:true,version:'fixture',installRoot:runtime,limitations:[]}),prepare:async()=>({}),dispose:async()=>{},staticInfo:()=>({plugins:[],tools:[],limitations:[]}),trace:{kind:'pi',sourceType:'PI_PROBE',externalSchema:'pi/events',blindSpots:[],normalizeEvent:r=>r},run:async({cwd})=>{
  assert.equal(await readFile(path.join(cwd,'input/data.txt'),'utf8'),'public input 1');
  await writeFile(path.join(cwd,'output/result.txt'),'integration fixture only');
  return {sessionId:'fixture.session',queue:[],seen:0,final:'File written',error:null,cleanup:'CONFIRMED',result:{stopReason:'end_turn'}};
 }};
 const result=await runEvaluation({root:runtime,runId:'benchdock.execution',adapter,onProgress:()=>{},evaluationConfig:{mode:'FULL',selection:{kind:'SELECTED',items:[{datasetId:'dataset.example/v1',caseIndices:[0]}]}},judgeFactory:()=>({evaluate:async()=>{throw Error('Judge must not be called');}})});
 assert.equal(result.status,'COMPLETED',JSON.stringify(result));assert.equal(result.scores[0].status,'UNASSESSABLE');assert.equal(result.dimensions[0].score,null);
 const reportPath=path.join(runtime,'var/evaluation-results/agents/pi/runs/benchdock.execution/cases/example.case-1/report.json');
 const report=JSON.parse(await readFile(reportPath,'utf8'));
 assert.equal(report.case.question.benchdock.revision,data.question.benchdock.revision);
 assert.equal(report.evaluationMode,'FULL');assert.ok(report.allTraceRef);assert.ok(!JSON.stringify(report).includes('private answer'));
});
test('deferred evaluator binds the private reference to the exact public task revision and verified trace',async t=>{
 const {root,data}=await publicCase(t),base=judgeInput(),allTrace=trace();
 const ref=await writeTraceDirectory({caseDirectory:root,trace:allTrace,maxBytes:1024*1024});
 const result=buildResult({runId:allTrace.scope.runId,scope:allTrace.scope,target:{},evaluationMode:'EFFECT',case:data,labels:[base.label],allTraceRef:ref,
  scores:[],dimensions:[],timeline:[],artifacts:[],currentPhase:'REPORTED',runState:'COMPLETED',operationalHealth:'HEALTHY',fixture:true,securityIsolation:'FIXTURE',environmentState:'FIXTURE',failures:[]},'fixture');
 const reportFile=path.join(root,'report.json'),referenceFile=path.join(root,'private-bundle.json');
 await writeFile(reportFile,serializeReportDocument(result));
 const bundle={schema:'evaldock.benchdock-private-reference/v1',taskId:data.question.id,revision:'a'.repeat(40),taskRecordSha256:data.question.benchdock.task_record_sha256,reference:{answer:'synthetic evaluator secret'}};
 await json(referenceFile,bundle);
 let calls=0;
 const judge={evaluate:async input=>{calls++;assert.equal(input.evaluationMode,'EFFECT');assert.equal(input.case.grading.weight,0.5);assert.equal(input.case.grading.reference.answer,'synthetic evaluator secret');return parseLabelScore(JSON.stringify({status:'SCORED',score:7,reason:'Synthetic test only',evidence_ids:[]}),input,'fixture');}};
 const scored=await scoreBenchDockReport({reportFile,referenceFile,judge});assert.equal(scored.scores[0].score,7);assert.equal(calls,1);
 assert.equal(scored.evaluationMode,'EFFECT');
 assert.ok(!JSON.stringify(scored).includes('synthetic evaluator secret'));
 for (const change of [
  {evaluationMode:undefined},
  {scope:{...result.scope,targetId:'agent.another'}},
  {scope:{...result.scope,attemptId:'attempt.another'}},
  {case:{...result.case,question:{...result.case.question,id:'wrong-task'}}},
  {case:{...result.case,grading:{...result.case.grading,weight:-1}}},
 ]) {
  await writeFile(reportFile,serializeReportDocument(buildResult(JSON.parse(JSON.stringify({...result,...change})),'fixture')));
  await assert.rejects(scoreBenchDockReport({reportFile,referenceFile,judge}),/mode|scope|provenance|weight/);
 }
 assert.equal(calls,1);
 await writeFile(reportFile,serializeReportDocument(result));
 bundle.revision='c'.repeat(40);await json(referenceFile,bundle);
 await assert.rejects(scoreBenchDockReport({reportFile,referenceFile,judge}),/identity/);assert.equal(calls,1);
 bundle.revision='a'.repeat(40);await json(referenceFile,bundle);
 await chmod(path.join(root,'all-trace/manifest.json'),0o600);
 await writeFile(path.join(root,'all-trace/manifest.json'),'{}');
 await assert.rejects(scoreBenchDockReport({reportFile,referenceFile,judge}),/digest mismatch/);assert.equal(calls,1);
});

test('BenchDock loader rejects task, prompt override, input mapping and provenance changes after import',async t=>{
 const {root,dir,q}=await publicCase(t);
 const load=()=>loadDatasetCase({datasetsRoot:root,datasetId:'dataset.example/v1',labelIds:['label.contract/v1']});
 await writeFile(path.join(dir,'prompt.md'),'Different local prompt');
 await assert.rejects(load(),/pinned source record/);await rm(path.join(dir,'prompt.md'));
 q.task.instructions='Changed instruction';await json(path.join(dir,'question.json'),q);
 await assert.rejects(load(),/pinned source record/);
 q.task.instructions='Read the input';q.inputs[0].destination='input/renamed.txt';await json(path.join(dir,'question.json'),q);
 await assert.rejects(load(),/input mapping/);
 q.inputs[0].destination='input/data.txt';await json(path.join(dir,'question.json'),q);
 await writeFile(path.join(dir,'PROVENANCE.json'),'{}');
 await assert.rejects(load(),/pinned source record/);
});
