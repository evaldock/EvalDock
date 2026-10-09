import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {judgeInput,trace} from './support.mjs';
import {judgePrompt,parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
import {parseEvaluationConfig} from '../../dist/src/app/evaluation-config.js';
import {evaluationCatalog,validateEvaluationConfig} from '../../workbench/lib/evaluation-config.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
test('effect Judge sees only delivery evidence and rejects process citations',()=>{
  const input={...judgeInput(trace([{id:'process',layer:'AGENT',content:{tool:'secret'}},{id:'answer',layer:'DELIVERY',content:{content:'42'}}])),evaluationMode:'EFFECT'};
  const prompt=judgePrompt(input);
  assert.equal(prompt.all_trace,undefined);
  assert.deepEqual(prompt.output_schema.evidence_ids,['output_evidence.entries[].id']);
  assert.ok(!JSON.stringify(prompt).includes('All trace is identical')); 
  assert.deepEqual(prompt.output_evidence.entries.map(entry=>entry.id),['answer']);
  assert.ok(!JSON.stringify(prompt).includes('secret'));
  const score=parseLabelScore('{"score":4,"reason":"Answer supports result","evidence_ids":["process","answer"]}',input,'contract');
  assert.deepEqual(score.evidenceIds,['answer']);
});
test('evaluation selections are validated against live Case inventory',async()=>{
  const catalog=await evaluationCatalog(root);
  assert.ok(catalog.datasets.length>0);
  const first=catalog.datasets[0];
  const config={mode:'FULL',selection:{kind:'SELECTED',items:[{datasetId:first.id,caseIndices:[0]}]}};
  assert.deepEqual(await validateEvaluationConfig(root,config),config);
  assert.equal(parseEvaluationConfig(config).selection.kind,'SELECTED');
  await assert.rejects(()=>validateEvaluationConfig(root,{...config,selection:{kind:'SELECTED',items:[{datasetId:first.id,caseIndices:[first.cases.length]}]}}));
  assert.throws(()=>parseEvaluationConfig({mode:'EFFECT',selection:{kind:'COUNT',caseCount:0}}));
});


test('ALL without a per-Dataset limit validates and selects every available Case',async()=>{
  const config={mode:'FULL',selection:{kind:'ALL'}};
  assert.deepEqual(parseEvaluationConfig(config),config);
  assert.deepEqual(await validateEvaluationConfig(root,config),config);
  const {selectAllDatasets}=await import('../../dist/src/planning/all-datasets.js');
  const catalog=await evaluationCatalog(root);
  const availableDatasets=catalog.datasets.map(d=>({datasetId:d.id,labelIds:['label.reasoning-planning/v1'],availableCaseCount:d.cases.length}));
  const plan=selectAllDatasets({profile:'STANDARD',availableDatasets});
  assert.equal(plan.totalCaseCount,catalog.datasets.reduce((n,d)=>n+d.cases.length,0));
  assert.deepEqual(plan.selectedDatasets.map(d=>d.caseCount),catalog.datasets.map(d=>d.cases.length));
  const large=selectAllDatasets({profile:'STANDARD',availableDatasets:[{datasetId:'dataset.synthetic/v1',labelIds:[],availableCaseCount:16}]});
  assert.equal(large.selectedDatasets[0].caseCount,16);
});
test('explicit legacy limits remain opt-in and invalid limits are rejected',async()=>{
  const {selectAllDatasets}=await import('../../dist/src/planning/all-datasets.js');
  const input={profile:'STANDARD',availableDatasets:[{datasetId:'dataset.example/v1',labelIds:[],availableCaseCount:16}]};
  assert.equal(selectAllDatasets({...input,testSize:{casesPerDataset:3}}).totalCaseCount,3);
  assert.throws(()=>selectAllDatasets({...input,testSize:{maxCases:5}}),/exceeds Case limit/);
  for(const limit of [0,-1,null,1.5,10001]){
    const config={mode:'FULL',selection:{kind:'ALL',casesPerDataset:limit}};
    assert.throws(()=>parseEvaluationConfig(config));
    await assert.rejects(()=>validateEvaluationConfig(root,config));
  }
});
