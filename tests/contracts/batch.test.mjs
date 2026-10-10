import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {temporary} from './support.mjs';import {runEvaluationBatch} from '../../dist/src/app/batch.js';
async function run(t,allFailed){const root=await temporary(t);await mkdir(path.join(root,'target'));
 let invoked=0;const basic={schema:'evaldock.mvp.cli-summary/v1',command:'run',fixture:false,status:'COMPLETED',exitCode:0,operationalHealth:'HEALTHY',failureGroups:[],reasonCodes:[],recordsPath:'unused',scores:[]};
 const result=await runEvaluationBatch({cwd:root,runId:'contract.batch',descriptor:{targetId:'agent.contract',sourceRoot:path.join(root,'target')},workflowRunner:async input=>{
  if(input.stopAfter==='PLAN'){await mkdir(path.join(root,'var/batch-runtime/contract.batch/planning'),{recursive:true});return {...basic,runId:input.runId,datasetTestProfile:'STANDARD',selectedDatasets:[{datasetId:'dataset.dynamic/v1',evaluationLabelIds:['label.contract/v1'],caseCount:3,reason:'explicit'}],totalCaseCount:3,datasetMatchModel:'contract',datasetMatchDurationMs:0};}
  invoked++;if(allFailed||invoked===1)throw new Error('case-local failure');
  return {...basic,runId:input.runId};
 }});
 assert.equal(invoked,3);assert.equal(result.caseResults.length,3);assert.equal(result.caseResults[0].status,'FAILED');
 assert.equal(JSON.parse(await readFile(result.runSummaryPath,'utf8')).caseResults.length,3);
 assert.ok(result.runSummaryPath.startsWith(path.join(root,'var/evaluation-results')));
 return result;
}
test('Case failure does not truncate the selected queue',async t=>{const result=await run(t,false);assert.equal(result.caseResults.at(-1).status,'COMPLETED');});
test('all Cases failing still publishes an inspectable Run summary',async t=>{const result=await run(t,true);assert.ok(result.caseResults.every(c=>c.status==='FAILED'));});

test('three Cases overlap, groups are bounded, and cancellation stops the next group',async t=>{
 for(const cancel of [false,true]){
  const root=await temporary(t);await mkdir(path.join(root,'target'));
  const controller=new AbortController();let active=0,peak=0,invoked=0;const paths=new Set();
  const basic={schema:'evaldock.mvp.cli-summary/v1',command:'run',fixture:false,status:'COMPLETED',exitCode:0,failureGroups:[],reasonCodes:[],recordsPath:'unused',scores:[]};
  const result=await runEvaluationBatch({cwd:root,runId:'contract.parallel',signal:controller.signal,descriptor:{targetId:'agent.contract',sourceRoot:path.join(root,'target')},workflowRunner:async input=>{
   if(input.stopAfter==='PLAN')return {...basic,runId:input.runId,datasetTestProfile:'STANDARD',selectedDatasets:[{datasetId:'dataset.dynamic/v1',evaluationLabelIds:['label.contract/v1'],caseCount:7,reason:'test'}],totalCaseCount:7,datasetMatchModel:'contract',datasetMatchDurationMs:0};
   invoked++;active++;peak=Math.max(peak,active);paths.add(input.configOverrides.workspaceRoot);
   await new Promise(resolve=>setTimeout(resolve,10));active--;
   if(cancel)controller.abort();
   return {...basic,runId:input.runId,...(cancel?{status:'CANCELLED',exitCode:130}:{})};
  }});
  assert.equal(peak,3);assert.equal(result.caseConcurrency,3);assert.equal(invoked,cancel?3:7);
  assert.equal(paths.size,invoked);assert.equal(result.caseResults.length,invoked);
  assert.deepEqual(result.caseResults.map(c=>c.executionRunId),Array.from({length:invoked},(_,i)=>`contract.parallel.c${i+1}`));
 }
});

test('a freed slot starts the next Case while two earlier Cases are still running',async t=>{
 const root=await temporary(t);await mkdir(path.join(root,'target'));
 let release;const blocked=new Promise(resolve=>{release=resolve;});let fourth;const fourthStarted=new Promise(resolve=>{fourth=resolve;});
 let active=0,peak=0;const basic={schema:'evaldock.mvp.cli-summary/v1',command:'run',fixture:false,status:'COMPLETED',exitCode:0,failureGroups:[],reasonCodes:[],recordsPath:'unused',scores:[]};
 const task=runEvaluationBatch({cwd:root,runId:'contract.refill',descriptor:{targetId:'agent.contract',sourceRoot:path.join(root,'target')},workflowRunner:async input=>{
  if(input.stopAfter==='PLAN')return {...basic,runId:input.runId,datasetTestProfile:'STANDARD',selectedDatasets:[{datasetId:'dataset.dynamic/v1',evaluationLabelIds:['label.contract/v1'],caseCount:6,reason:'test'}],totalCaseCount:6,datasetMatchModel:'contract',datasetMatchDurationMs:0};
  active++;peak=Math.max(peak,active);
  if(input.executionCase.ordinal<=2)await blocked;
  if(input.executionCase.ordinal===4){assert.equal(active,3);fourth();}
  active--;return {...basic,runId:input.runId};
 }});
 let timer;try{await Promise.race([fourthStarted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fourth Case waited for the entire group')),2000);})]);}finally{clearTimeout(timer);release();}
 const result=await task;assert.equal(peak,3);assert.equal(result.caseResults.length,6);assert.deepEqual(result.caseResults.map(c=>c.caseIndex),[0,1,2,3,4,5]);
});

test('explicit Case indices freeze an exact queue without Planner selection',async t=>{
 const root=await temporary(t),target=path.join(root,'target');await mkdir(target);
 const catalogDir=path.join(root,'datasets');await mkdir(path.join(catalogDir,'foo','a'),{recursive:true});await mkdir(path.join(catalogDir,'foo','b'),{recursive:true});
 await writeFile(path.join(catalogDir,'foo','a','question.json'),'{}');await writeFile(path.join(catalogDir,'foo','b','question.json'),'{}');
 await writeFile(path.join(catalogDir,'catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.foo/v1',name:'Foo',description:'Foo Cases',labelIds:['label.foo/v1'],availableCaseCount:2}]})+'\n```');
 const seen=[],basic={schema:'evaldock.mvp.cli-summary/v1',command:'run',fixture:false,status:'COMPLETED',exitCode:0,operationalHealth:'HEALTHY',failureGroups:[],reasonCodes:[],recordsPath:'unused',scores:[]};
 const result=await runEvaluationBatch({cwd:root,runId:'contract.selected',descriptor:{targetId:'agent.contract',sourceRoot:target},evaluationMode:'EFFECT',evaluationConfig:{mode:'EFFECT',selection:{kind:'SELECTED',items:[{datasetId:'dataset.foo/v1',caseIndices:[1]}]}},workflowRunner:async input=>{
  if(input.stopAfter==='PLAN')return {...basic,runId:input.runId,datasetTestProfile:'STANDARD',selectedDatasets:input.precomputedDatasetSelection.selectedDatasets,totalCaseCount:1,datasetMatchModel:'explicit-cases',datasetMatchDurationMs:0};
  seen.push(input.executionCase.caseIndex);return {...basic,runId:input.runId};
 }});
 assert.deepEqual(seen,[1]);assert.deepEqual(result.caseResults.map(c=>c.caseId),['foo.case-2']);
 assert.equal(result.evaluationConfig.mode,'EFFECT');
 const plan=JSON.parse(await readFile(path.join(root,'var/evaluation-results/agents/agent.contract/runs/contract.selected/plan.json'),'utf8'));
 assert.deepEqual(plan.queue.map(q=>q.caseIndex),[1]);
});
