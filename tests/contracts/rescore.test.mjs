import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,chmod,mkdir,readdir,symlink} from 'node:fs/promises';
import {temporary,question,trace,judgeInput,json} from './support.mjs';
import {loadDatasetCase} from '../../dist/src/datasets/loader.js';
import {writeTraceDirectory} from '../../dist/src/all-trace/store.js';
import {buildResult,serializeReportDocument} from '../../dist/src/reporting/record.js';
import {rescoreArchivedTrace} from '../../dist/src/evaluation/rescore.js';
import {parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
import {digestValue} from '../../dist/src/core/models.js';
async function fixture(t){
  const root=await temporary(t);await question(root);
  const data=await loadDatasetCase({datasetsRoot:root,datasetId:'dataset.example/v1',labelIds:['label.contract/v1']});
  const allTrace=trace([{id:'delivery.1',layer:'DELIVERY',payload:{text:'Synthetic output'}}]);
  const ref=await writeTraceDirectory({caseDirectory:root,trace:allTrace,maxBytes:1024*1024});
  const report=buildResult({runId:allTrace.scope.runId,scope:allTrace.scope,target:{},evaluationMode:'EFFECT',case:data,labels:[judgeInput().label],allTraceRef:ref,
    scores:[],dimensions:[],timeline:[],artifacts:[],currentPhase:'REPORTED',runState:'COMPLETED',operationalHealth:'HEALTHY',fixture:true,securityIsolation:'FIXTURE',environmentState:'FIXTURE',failures:[]},'fixture');
  const reportFile=path.join(root,'report.json');await writeFile(reportFile,serializeReportDocument(report));
  return {root,report,reportFile};
}
function judge(onCall=()=>{}){return {evaluate:async input=>{await onCall(input);return parseLabelScore(JSON.stringify({status:'SCORED',score:7,reason:'Supported <script>example</script>',evidence_ids:['delivery.1']}),input,'fixture');}};}

test('re-scoring reuses exact archive/mode, writes a separate escaped report, preserves originals',async t=>{
  const {root,reportFile,report}=await fixture(t),before=await readFile(reportFile);
  const manifest=await readFile(path.join(root,'all-trace/manifest.json'));let calls=0;
  const {revisionDirectory,result}=await rescoreArchivedTrace({reportFile,revisionId:'rubric-v2',judge:judge(input=>{calls++;assert.equal(input.evaluationMode,'EFFECT');assert.equal(input.allTrace.contentDigest.value,report.allTraceRef.contentDigest.value);assert.equal(input.case.task,report.case.task);})});
  assert.equal(calls,1);assert.equal(result.status,'COMPLETE');assert.equal(result.scores[0].score,7);
  assert.deepEqual(await readFile(reportFile),before);assert.deepEqual(await readFile(path.join(root,'all-trace/manifest.json')),manifest);
  assert.equal(result.sourceReportDigest.value,report.contentDigest.value);
  assert.equal(result.contentDigest.value,digestValue(result,['contentDigest']).value);
  const html=await readFile(path.join(revisionDirectory,'report.html'),'utf8');assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  await assert.rejects(rescoreArchivedTrace({reportFile,revisionId:'rubric-v2',judge:judge(()=>{calls++;})}),{code:'EEXIST'});assert.equal(calls,1);
});
test('updated rubrics and a label subset are explicit and versioned without altering baseline',async t=>{
  const {root,reportFile,report}=await fixture(t);const labelsRoot=path.join(root,'new-labels');
  const {contentDigest,...raw}=report.labels[0];raw.version='2';raw.judge={modelRole:'new judge',instructions:['New synthetic rubric']};
  await json(path.join(labelsRoot,'contract.json'),raw);
  const {result}=await rescoreArchivedTrace({reportFile,labelsRoot,labelIds:[raw.labelId],judge:judge(input=>assert.equal(input.label.version,'2'))});
  assert.equal(result.labels[0].version,'2');assert.notEqual(result.labels[0].contentDigest.value,contentDigest.value);
  assert.equal(result.originalLabelDigests[0].contentDigest.value,contentDigest.value);
});
test('unknown selections, missing mode, bad scope and tampered evidence fail before Judge',async t=>{
  const {root,reportFile,report}=await fixture(t);let calls=0;const j=judge(()=>calls++);
  await assert.rejects(rescoreArchivedTrace({reportFile,labelIds:['label.unknown/v1'],judge:j}),/selection/);
  for(const changes of [{evaluationMode:undefined},{evaluationScope:{...report.scope,caseId:'wrong'}}]){
    await writeFile(reportFile,serializeReportDocument(buildResult(JSON.parse(JSON.stringify({...report,...changes})),'fixture')));
    await assert.rejects(rescoreArchivedTrace({reportFile,judge:j}),/mode|scope/);
  }
  await writeFile(reportFile,serializeReportDocument(report));
  const manifest=path.join(root,'all-trace/manifest.json');await chmod(manifest,0o600);await writeFile(manifest,'{}');
  await assert.rejects(rescoreArchivedTrace({reportFile,judge:j}),/digest/);assert.equal(calls,0);
});
test('a source change during grading keeps a failed revision and never publishes scores',async t=>{
  const {root,reportFile}=await fixture(t);
  await assert.rejects(rescoreArchivedTrace({reportFile,revisionId:'changed',judge:judge(()=>writeFile(reportFile,'{}'))}),/Source report changed/);
  const files=await readdir(path.join(root,'score-revisions/changed'));assert.ok(files.includes('failure.json'));assert.ok(!files.includes('report.json'));
});
test('Judge failures stay in the revision and do not replace the previous result',async t=>{
  const {reportFile}=await fixture(t),before=await readFile(reportFile);
  const j=judge();const failing={evaluate:async input=>{const score=await j.evaluate(input);const body={...score,status:'ERROR',score:null,reason:'JUDGE_TIMEOUT'};return {...body,contentDigest:digestValue(body,['contentDigest'])};}};
  const {result}=await rescoreArchivedTrace({reportFile,judge:failing});assert.equal(result.status,'SCORING_ERROR');assert.equal(result.dimensions[0].errorCases,1);assert.deepEqual(await readFile(reportFile),before);
});
test('unsafe revision directories and duplicate selected labels are rejected before grading',async t=>{
  const {root,reportFile}=await fixture(t);let calls=0;const j=judge(()=>calls++);
  await assert.rejects(rescoreArchivedTrace({reportFile,revisionId:'../escape',judge:j}),/revision ID/);
  await assert.rejects(rescoreArchivedTrace({reportFile,labelIds:['label.contract/v1','label.contract/v1'],judge:j}),/selection/);
  const outside=path.join(root,'outside');await mkdir(outside);await symlink(outside,path.join(root,'score-revisions'));
  await assert.rejects(rescoreArchivedTrace({reportFile,judge:j}),/revision directory/);assert.equal(calls,0);
});
