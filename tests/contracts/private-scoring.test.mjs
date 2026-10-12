import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {cp,readFile,writeFile,access,open,symlink} from 'node:fs/promises';
import {temporary,question,json,judgeInput,trace} from './support.mjs';
import {fixtureCompatibilityService} from './compatibility-fixture.mjs';
import {loadDatasetCase} from '../../dist/src/datasets/loader.js';
import {digestValue} from '../../dist/src/core/models.js';
import {buildResult,serializeReportDocument,parseVerifiedReportDocument,publicReportDocument} from '../../dist/src/reporting/record.js';
import {renderReportHtml} from '../../dist/src/reporting/html.js';
import {parseLabelScore,judgePrompt} from '../../dist/src/evaluation/llm-label-judge.js';
import {runEvaluation} from '../../adapters/shared/evaluation.mjs';
import {evaluationCatalog} from '../../workbench/lib/evaluation-config.mjs';
import {ControlResults} from '../../workbench/lib/control-results.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';
import {importLibrary} from '../../desktop/workspace.mjs';
import {renderDatasets} from '../../workbench/design-prototypes/product-pages.js';

const secret='SYNTHETIC_PRIVATE_ASSESSMENT_SENTINEL';
async function library(t){
  const root=await temporary(t),{dir,q}=await question(path.join(root,'datasets'));
  q.grading={reference:'private/final.json',criteria:[{prompt:secret}],weight:2};q.evidence={privateGuidance:secret};
  await json(path.join(dir,'question.json'),q);await json(path.join(dir,'private/final.json'),{answer:secret,rubric:secret});
  const label=judgeInput().label;await json(path.join(root,'labels/contract.json'),label);
  await writeFile(path.join(root,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Synthetic private scoring',description:'Contract fixture',labelIds:[label.labelId],availableCaseCount:1}]})+'\n```');
  const data=await loadDatasetCase({datasetsRoot:path.join(root,'datasets'),datasetId:'dataset.example/v1',labelIds:[label.labelId]});
  return {root,dir,q,label,data};
}
function resultData(data,label){const source=trace();return {runId:source.scope.runId,scope:source.scope,target:{},evaluationMode:'FULL',case:data,labels:[label],scores:[],dimensions:[],timeline:[],artifacts:[],currentPhase:'REPORTED',runState:'COMPLETED',operationalHealth:'HEALTHY',fixture:true,securityIsolation:'FIXTURE',environmentState:'FIXTURE',failures:[]};}

test('Judge retains private material while new records and HTML expose only its digest',async t=>{
  const {data,label}=await library(t),record=buildResult(resultData(data,label),'fixture');
  assert.ok(JSON.stringify(judgePrompt({case:data,label,allTrace:trace()})).includes(secret));
  assert.ok(!serializeReportDocument(record).includes(secret));assert.ok(!renderReportHtml(resultData(data,label)).includes(secret));
  assert.deepEqual(record.case.grading.referenceDigest,digestValue(data.grading.reference));
  assert.equal(record.case.grading.weight,2);assert.equal(record.case.question.grading,undefined);assert.equal(record.case.question.evidence,undefined);
  assert.equal(data.grading.reference.answer,secret);assert.equal(data.seedEntries.length,3);
  assert.equal(parseVerifiedReportDocument(serializeReportDocument(record)).case.grading.mode,'reference');
});

test('catalog reports reference readiness, invalidation and public-only state without exposing contents',async t=>{
  const {root,dir,q}=await library(t);
  let catalog=await evaluationCatalog(root);assert.equal(catalog.scoring.readyCases,1);assert.deepEqual(catalog.scoring.labelIds,['label.contract/v1']);
  assert.ok(!JSON.stringify(catalog).includes(secret));
  const html=renderDatasets({catalog,ui:{datasetId:null,datasetQuery:'',selection:new Map()}});assert.match(html,/1 \/ 1/);assert.match(html,/可评分题目覆盖/);
  await writeFile(path.join(dir,'private/final.json'),'broken');catalog=await evaluationCatalog(root);assert.equal(catalog.scoring.readyCases,0);assert.equal(catalog.datasets[0].cases[0].scoringState,'INVALID');
  q.grading={mode:'unavailable',reason:'PRIVATE_EVALUATOR_NOT_DISTRIBUTED'};await json(path.join(dir,'question.json'),q);
  catalog=await evaluationCatalog(root);assert.equal(catalog.datasets[0].cases[0].scoringState,'UNAVAILABLE');assert.deepEqual(catalog.scoring.labelIds,[]);
});

test('reference metadata refuses symlinks and missing reference files',async t=>{
  const {root,dir,q}=await library(t);await json(path.join(root,'outside.json'),{answer:secret});
  await symlink(path.join(root,'outside.json'),path.join(dir,'private/link.json'));q.grading.reference='private/link.json';await json(path.join(dir,'question.json'),q);
  assert.equal((await evaluationCatalog(root)).datasets[0].cases[0].scoringState,'INVALID');
  q.grading.reference='private/missing.json';await json(path.join(dir,'question.json'),q);
  assert.equal((await evaluationCatalog(root)).datasets[0].cases[0].scoringState,'MISSING');
});

test('private library execution gives the adapter public task data and the Judge the real reference, preserving zero',async t=>{
  const {root,label}=await library(t);let calls=0;
  const adapter={kind:'pi',targetId:'private-fixture',name:'Synthetic adapter',inspect:async()=>({evaluationReady:true,version:'fixture',installRoot:root,limitations:[]}),prepare:async()=>({}),dispose:async()=>{},trace:{kind:'pi',sourceType:'PI_PROBE',externalSchema:'fixture/v1',blindSpots:[],normalizeEvent:(r,sessionId,seq)=>({at:r.at,kind:'agent/events',data:{sessionId,event:{...r.event,seq}},provenance:{channel:'fixture'}})},run:async({cwd,caseData,prompt})=>{
    assert.ok(!JSON.stringify(caseData).includes(secret));assert.ok(!prompt.includes(secret));await assert.rejects(access(path.join(cwd,'private/final.json')));
    assert.equal(await readFile(path.join(cwd,'input/data.txt'),'utf8'),'public input 1');
    return {sessionId:'fixture.session',queue:[],seen:0,final:'Synthetic result',error:null,cleanup:'CONFIRMED',result:{stopReason:'end_turn'}};
  }};
  const result=await runEvaluation({root,runId:'private-score',adapter,compatibilityService:fixtureCompatibilityService,onProgress:()=>{},evaluationConfig:{mode:'FULL',selection:{kind:'SELECTED',items:[{datasetId:'dataset.example/v1',caseIndices:[0]}]}},judgeFactory:()=>({evaluate:async input=>{calls++;assert.equal(input.case.grading.reference.answer,secret);assert.equal(input.evaluationMode,'FULL');return parseLabelScore('{"status":"SCORED","score":0,"reason":"Synthetic zero result","evidence_ids":[]}',input,'fixture');}})});
  assert.equal(result.status,'COMPLETED');assert.equal(calls,1);assert.equal(result.dimensions[0].score,0);
  const file=path.join(root,'var/evaluation-results/agents/private-fixture/runs/private-score/cases/example.case-1/report.json');
  assert.ok(!(await readFile(file,'utf8')).includes(secret));assert.equal(JSON.parse(await readFile(file,'utf8')).scores[0].labelId,label.labelId);
});

test('old private records remain immutable while JSON, HTML and workbench views omit assessment material',async t=>{
  const {root,data,label}=await library(t);const base=buildResult(resultData(data,label),'fixture');
  const body={...base,case:{...data}};const legacy={...body,contentDigest:digestValue(body,['contentDigest'])};
  const file=path.join(root,'var/evaluation-results/agents/agent/runs/run/cases/case/report.json');await json(file,legacy);
  const htmlFile=path.join(path.dirname(file),'report.html');await writeFile(htmlFile,secret);
  await json(path.join(root,'var/evaluation-results/agents/agent/runs/run/run.json'),{caseResults:[{caseId:'case',status:'COMPLETED'}]});
  const before=await readFile(file,'utf8');const projected=publicReportDocument(legacy);assert.ok(!JSON.stringify(projected).includes(secret));assert.deepEqual(projected.sourceReportDigest,legacy.contentDigest);
  const results=new ControlResults(root);assert.ok(!JSON.stringify(await results.get({targetId:'agent',runId:'run',state:'SUCCEEDED',events:[]})).includes(secret));
  const inert={active:false,jobs:{jobs:new Map()},status:async()=>({jobs:[],runs:[],targets:[]})};
  const {server}=await startControlServer({root,port:0,controller:inert,workbuddyController:inert,agentControllers:{},modelSettingsFile:path.join(root,'models.env')});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/reports/agent/run/cases/case/report.';
  for(const extension of ['json','html']){const response=await fetch(url+extension);assert.equal(response.status,200);assert.ok(!(await response.text()).includes(secret));}
  assert.equal(await readFile(file,'utf8'),before);assert.equal(await readFile(htmlFile,'utf8'),secret);
});

test('private library import still rejects the size limit before reading oversized content',async t=>{
  const root=await temporary(t),source=await temporary(t);const handle=await open(path.join(source,'oversized.fixture'),'w');
  await handle.truncate(4*1024**3+1);await handle.close();
  await assert.rejects(importLibrary(source,root),/4 GB/);
});
