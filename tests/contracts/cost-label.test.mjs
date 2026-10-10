import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadLabels} from '../../dist/src/labels/catalog.js';
import {loadDatasetDescriptionCatalog} from '../../dist/src/datasets/catalog.js';
import {currentQuestionCases,loadDatasetCase} from '../../dist/src/datasets/loader.js';
import {selectAllDatasets} from '../../dist/src/planning/all-datasets.js';
import {OpenAiCompatibleDatasetMatcher} from '../../dist/src/planning/planner.js';
import {judgePrompt,parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
import {aggregateScores} from '../../dist/src/evaluation/scoring.js';
import {judgeInput,trace} from './support.mjs';
const id='label.efficiency-cost/v1';
const labels=await loadLabels('labels');
const cost=labels.find(l=>l.labelId===id);
const catalog=await loadDatasetDescriptionCatalog('datasets/catalog.md');
test('every catalog Dataset and loadable Case includes cost exactly once, alongside existing labels',async()=>{
 assert.ok(cost);assert.equal(cost.scoringStandard.label,'efficiency.cost');assert.deepEqual(cost.scoringStandard.scoring_scale,{min:0,max:100,decimal_places:2});
 let cases=0;
 for(const d of catalog){
  assert.equal(d.labelIds.filter(l=>l===id).length,1,d.datasetId);assert.ok(d.labelIds.length>1);
  const files=await currentQuestionCases('datasets',d.datasetId);
  for(let i=0;i<files.length;i++){
   const q=JSON.parse(await readFile(files[i],'utf8'));
   assert.equal(q.capabilityLabels.filter(l=>l==='efficiency-cost').length,1,files[i]);
   const c=await loadDatasetCase({datasetsRoot:'datasets',datasetId:d.datasetId,labelIds:d.labelIds,caseIndex:i});
   assert.equal(c.labelIds.filter(l=>l===id).length,1);assert.ok(c.labelIds.every(l=>labels.some(x=>x.labelId===l)));cases++;
  }
 }
 assert.equal(labels.length,15);assert.equal(catalog.length,1);assert.equal(cases,1);
});
test('ALL and LLM planning deterministically preserve the new Dataset label',async()=>{
 const availableDatasets=Array.from({length:3},(_,i)=>({...catalog[0],datasetId:'dataset.synthetic-'+i+'/v1',availableCaseCount:1}));
 const input={profile:'STANDARD',availableDatasets,testSize:{datasetCount:3,casesPerDataset:1},agentStaticInfo:{plugins:[],tools:[],limitations:[]}};
 const all=selectAllDatasets(input);assert.ok(all.evaluationLabelIds.includes(id));
 const matcher=new OpenAiCompatibleDatasetMatcher({endpoint:'https://planner.test/api',apiKey:'test',model:'test',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({selected_datasets:availableDatasets.map(d=>({dataset_id:d.datasetId,case_count:1,reason:'test'}))})}}]}))});
 const plan=await matcher.select(input);
 for(const selection of [all,plan])for(const d of selection.selectedDatasets)assert.equal(d.evaluationLabelIds.filter(l=>l===id).length,1);
});
test('cost uses identical FULL evidence and existing EFFECT isolation, null/error do not become zero',()=>{
 const evidence=trace([{id:'runtime',layer:'AGENT',content:{usage:{inputTokens:250,outputTokens:20},durationMs:1000}},{id:'final',layer:'DELIVERY',content:{content:'answer'}}]);
 const input={...judgeInput(evidence),label:cost};
 assert.equal(judgePrompt(input).all_trace,evidence);
 const effect=judgePrompt({...input,evaluationMode:'EFFECT'});
 assert.equal(effect.all_trace,undefined);assert.deepEqual(effect.output_evidence.entries.map(e=>e.id),['final']);
 const scored=parseLabelScore(JSON.stringify({status:'SCORED',score:3.25,reason:'fixture',evidence_ids:['runtime']}),input,'fixture');
 const unknown=parseLabelScore(JSON.stringify({status:'UNASSESSABLE',score:null,reason:'No cost evidence'}),input,'fixture');
 const result=aggregateScores([scored,unknown,{...unknown,status:'ERROR'}])[0];
 assert.equal(result.score,3.25);assert.equal(result.scoredCases,1);assert.equal(result.unassessableCases,1);assert.equal(result.errorCases,1);
});
test('workbench Dataset resource views include canonical cost label without changing historical runs',async()=>{
 for(const file of ['workbench/design-prototypes/index.html','workbench/design-prototypes/catalog-snapshot.js']){
  const source=await readFile(file,'utf8');const value=JSON.parse(source.match(/const resourceSnapshot = (.*);/)[1]);
  for(const dataset of value.datasets){assert.equal(dataset.labels.filter(l=>l==='efficiency.cost').length,1);for(const c of dataset.cases)assert.equal(c.labels.filter(l=>l==='efficiency.cost').length,1);}
 }
});

test('public static inventory retains standards but no real task snapshots',async()=>{
 const index=JSON.parse(await readFile('workbench/design-prototypes/question-inventory/index.json','utf8'));
 const valid=new Set(labels.map(l=>l.labelId));assert.equal(valid.size,15);
 assert.deepEqual(index.labels.map(l=>l.labelId).sort(),[...valid].sort());
 assert.deepEqual(index.datasets,[]);
});
