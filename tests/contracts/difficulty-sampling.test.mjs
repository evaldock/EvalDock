import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {temporary,question,json,judgeInput} from './support.mjs';
import {sampleDifficultyPools,samplePlannedCases,withDifficultyHints} from '../../dist/src/planning/case-sampling.js';
import {runEvaluationBatch} from '../../dist/src/app/batch.js';
import {runEvaluation} from '../../adapters/shared/evaluation.mjs';
import {currentQuestionCases} from '../../dist/src/datasets/loader.js';
import {parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
const percentages={EASY:20,MEDIUM:40,HARD:40};
const pool=(name,count,levels)=>({datasetId:`dataset.${name}/v1`,count,cases:levels.map((difficulty,caseIndex)=>({datasetId:`dataset.${name}/v1`,caseId:`${name}.case-${caseIndex+1}`,caseIndex,difficulty}))});
const mix=()=>Array.from({length:10},()=>['EASY','MEDIUM','HARD']).flat();
test('20/40/40 is exact where feasible, reproducible by seed and varies across runs without duplicates',()=>{
 const pools=[pool('a',5,mix()),pool('b',5,mix()),pool('c',5,mix()),pool('d',5,mix())];
 const signatures=new Set();
 for(let seed=0;seed<20;seed++){
  const r=sampleDifficultyPools(pools,percentages,String(seed));
  assert.deepEqual(r.actual,{EASY:4,MEDIUM:8,HARD:8,UNKNOWN:0});assert.equal(r.exact,true);
  assert.equal(new Set(r.queue.map(c=>c.caseId)).size,20);
  for(const p of pools)assert.equal(r.queue.filter(c=>c.datasetId===p.datasetId).length,p.count);
  assert.deepEqual(r,sampleDifficultyPools(pools,percentages,String(seed)));
  signatures.add(r.queue.map(c=>c.caseId).sort().join(','));
 }
 assert.ok(signatures.size>15);
});
test('rounding, constrained rerouting and unavailable tiers keep the requested total and dataset allocations',()=>{
 for(let seed=0;seed<30;seed++){
  const rounded=sampleDifficultyPools([pool('a',4,mix())],percentages,String(seed));
  assert.equal(rounded.target.EASY,1);assert.deepEqual([rounded.target.MEDIUM,rounded.target.HARD].sort(),[1,2]);assert.equal(rounded.queue.length,4);
  const r=sampleDifficultyPools([pool('flex',1,['EASY','MEDIUM']),pool('onlyeasy',1,['EASY'])],{EASY:50,MEDIUM:50,HARD:0},String(seed));
  assert.equal(r.exact,true);assert.equal(r.queue.find(c=>c.datasetId==='dataset.flex/v1').difficulty,'MEDIUM');
 }
 const shortage=sampleDifficultyPools([pool('a',3,['EASY','EASY','EASY','EASY']),pool('b',2,['MEDIUM','UNKNOWN'])],percentages,'short');
 assert.equal(shortage.queue.length,5);assert.equal(shortage.actual.UNKNOWN,1);assert.equal(shortage.shortfall.HARD,2);assert.equal(shortage.exact,false);
});
async function fixture(t){
 const root=await temporary(t),cases=[];
 for(let n=1;n<=15;n++){
  const {dir,q}=await question(path.join(root,'datasets'),n),bytes=await readFile(path.join(dir,'question.json'));
  cases.push({questionId:q.id,questionPath:path.relative(root,path.join(dir,'question.json')),level:n<=5?'EASY':n<=10?'MEDIUM':'HARD',questionSha256:createHash('sha256').update(bytes).digest('hex')});
 }
 await json(path.join(root,'planning/case-sampling.json'),{schema:'evaldock.case-sampling/v1',version:'1',enabled:true,percentages});
 await json(path.join(root,'planning/case-difficulty.json'),{schema:'evaldock.case-difficulty/v1',version:'1',cases});
 const label=judgeInput().label;await json(path.join(root,'labels/contract.json'),label);
 await writeFile(path.join(root,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Example',description:'Read local file',labelIds:[label.labelId],availableCaseCount:15}]})+'\n```');
 const selection={schema:'evaldock.mvp.unified-planner-result/v1',profile:'STANDARD',selectedDatasets:[{datasetId:'dataset.example/v1',evaluationLabelIds:[label.labelId],caseCount:5,reason:'fixture'}],evaluationLabelIds:[label.labelId],totalCaseCount:5,model:'fixture',durationMs:0};
 return {root,selection,cases};
}
test('annotations bind to question bytes; stale annotation becomes UNKNOWN, hints never contain private answers',async t=>{
 const {root,selection}=await fixture(t),input={root,datasetsRoot:path.join(root,'datasets'),selection,seed:'fixed'};
 const r=await samplePlannedCases(input);assert.deepEqual(r.metadata.actualCounts,{EASY:1,MEDIUM:2,HARD:2,UNKNOWN:0});assert.deepEqual(r.metadata.annotationWarnings,[]);
 await writeFile(path.join(root,'datasets/example/question-1/question.json'),JSON.stringify({id:'example-1',task:'changed'}));
 const changed=await samplePlannedCases(input);assert.equal(changed.metadata.annotationWarnings.length,1);assert.match(changed.metadata.annotationWarnings[0],/STALE/);
 const hints=await withDifficultyHints([{datasetId:'dataset.example/v1',description:'Read files'}],path.join(root,'planning/case-difficulty.json'));
 assert.match(hints[0].description,/简单 5，中等 5，困难 5/);assert.ok(!JSON.stringify(hints).includes('private answer'));
});
const basic={schema:'evaldock.mvp.cli-summary/v1',command:'run',fixture:false,status:'COMPLETED',exitCode:0,operationalHealth:'HEALTHY',failureGroups:[],reasonCodes:[],recordsPath:'unused',scores:[]};
test('DSH executes frozen sampled indices and preserves explicitly chosen cases with sampling enabled',async t=>{
 for(const manual of [false,true]){
  const {root,selection}=await fixture(t);await mkdir(path.join(root,'target'));const executed=[];
  const result=await runEvaluationBatch({cwd:root,runId:'sampling.dsh',descriptor:{targetId:'agent.contract',sourceRoot:path.join(root,'target')},...(manual?{evaluationConfig:{mode:'FULL',selection:{kind:'SELECTED',items:[{datasetId:'dataset.example/v1',caseIndices:[8,12]}]}}}:{}),workflowRunner:async input=>{
   if(input.stopAfter==='PLAN'){const p=input.precomputedDatasetSelection??selection;return {...basic,runId:input.runId,datasetTestProfile:'STANDARD',selectedDatasets:p.selectedDatasets,totalCaseCount:p.totalCaseCount,datasetMatchModel:'fixture',datasetMatchDurationMs:0};}
   executed.push(input.executionCase.caseIndex);return {...basic,runId:input.runId};
  }});
  const plan=JSON.parse(await readFile(path.join(root,'var/evaluation-results/agents/agent.contract/runs/sampling.dsh/plan.json')));
  assert.deepEqual(executed,plan.queue.map(c=>c.caseIndex));assert.equal(result.caseResults.length,manual?2:5);
  if(manual){assert.deepEqual(executed,[8,12]);assert.equal(plan.caseSampling,undefined);}else{assert.deepEqual(plan.caseSampling.actualCounts,{EASY:1,MEDIUM:2,HARD:2,UNKNOWN:0});assert.deepEqual(result.caseSampling,plan.caseSampling);}
 }
});
test('peer adapter uses sampled queue for automatic runs and leaves SELECTED/ALL modes unchanged',async t=>{
 for(const mode of ['AUTO','SELECTED','ALL']){
  const {root,selection}=await fixture(t),executed=[];
  const adapter={kind:'pi',targetId:'pi',name:'Pi',inspect:async()=>({evaluationReady:true,version:'fixture',installRoot:root,limitations:[]}),prepare:async()=>({}),dispose:async()=>{},staticInfo:()=>({plugins:[],tools:[],limitations:[]}),trace:{kind:'pi',sourceType:'PI_PROBE',externalSchema:'pi/events',blindSpots:[],normalizeEvent:r=>r},run:async({caseData})=>{executed.push(caseData.caseId);return {sessionId:caseData.caseId,queue:[],seen:0,final:'fixture answer',error:null,cleanup:'CONFIRMED',result:{stopReason:'end_turn'}};}};
  const choice=mode==='SELECTED'?{kind:'SELECTED',items:[{datasetId:'dataset.example/v1',caseIndices:[8,12]}]}:{kind:'ALL',casesPerDataset:15};
  const result=await runEvaluation({root,runId:'sampling.peer',adapter,onProgress:()=>{},...(mode==='AUTO'?{}:{evaluationConfig:{mode:'FULL',selection:choice}}),matcherFactory:()=>({select:async()=>selection}),judgeFactory:()=>({evaluate:async input=>parseLabelScore(JSON.stringify({status:'SCORED',score:7,reason:'Fixture',evidence_ids:[]}),input,'fixture')})});
  assert.equal(result.status,'COMPLETED',JSON.stringify(result));
  const plan=JSON.parse(await readFile(path.join(root,'var/evaluation-results/agents/pi/runs/sampling.peer/plan.json')));
  const files=await currentQuestionCases(path.join(root,'datasets'),'dataset.example/v1');
  const expected=await Promise.all(plan.queue.map(async c=>'scenario.'+JSON.parse(await readFile(files[c.caseIndex])).id+'/v1'));
  assert.deepEqual([...executed].sort(),expected.sort());
  if(mode==='AUTO'){assert.equal(executed.length,5);assert.deepEqual(result.caseSampling.actualCounts,{EASY:1,MEDIUM:2,HARD:2,UNKNOWN:0});}
  else{assert.equal(result.caseSampling,undefined);assert.equal(executed.length,mode==='ALL'?15:2);if(mode==='SELECTED')assert.deepEqual(plan.queue.map(c=>c.caseIndex),[8,12]);}
 }
});
