import {parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelNetworkCircuitBreaker,modelNetworkFailureEvidence} from '../../dist/src/app/batch-network-circuit.js';
const transport=(labelId,code='ENOTFOUND')=>({...parseLabelScore('{"score":null,"reason":"fixture"}',judgeInput(),'fixture'),labelId,status:'ERROR',score:null,scale:{min:0,max:10},reason:'JUDGE_NETWORK_ERROR',diagnostics:{transportCode:code}});
const model={reasonCodes:['MODEL_TRANSPORT_ERROR'],scores:[]};
const judge={reasonCodes:['LABEL_JUDGE_ERROR'],scores:[transport('label.a/v1'),transport('label.b/v1','ENETUNREACH')]};
test('only trusted top-level model failures or complete frozen-label transport failure count',()=>{
 assert.equal(modelNetworkFailureEvidence(model).kind,'DSH_MODEL_TRANSPORT');
 assert.equal(modelNetworkFailureEvidence(judge,['label.a/v1','label.b/v1']).kind,'JUDGE_ALL_LABEL_TRANSPORT');
 for(const value of [
  {reasonCodes:['TOOL_NETWORK_ERROR'],scores:[]},
  {reasonCodes:[],message:'MODEL_TRANSPORT_ERROR'},
  {reasonCodes:['LABEL_JUDGE_ERROR'],scores:[transport('label.a/v1')]},
  {reasonCodes:['LABEL_JUDGE_ERROR'],scores:[transport('label.a/v1'),{...transport('label.b/v1'),status:'SCORED',score:0,reason:'failed task'}]},
  {reasonCodes:['LABEL_JUDGE_ERROR'],scores:[transport('label.a/v1'),{...transport('label.b/v1'),reason:'JUDGE_INPUT_TOO_LARGE'}]},
  {reasonCodes:['LABEL_JUDGE_ERROR'],scores:[transport('label.a/v1'),transport('label.a/v1')]},
  {reasonCodes:['LABEL_JUDGE_ERROR'],scores:[transport('label.a/v1','AUTH_FAILED'),transport('label.b/v1')]},
  {reasonCodes:['LABEL_JUDGE_ERROR'],scores:[{...transport('label.a/v1'),diagnostics:{}},transport('label.b/v1')]},
 ])assert.equal(modelNetworkFailureEvidence(value,['label.a/v1','label.b/v1']),undefined);
});
test('single transport error continues; a successful or ordinary failed Case resets the consecutive streak',()=>{
 const circuit=new ModelNetworkCircuitBreaker();let index=0;const observe=summary=>circuit.observe({caseId:'case-'+(++index),executionRunId:'run-'+index,summary,expectedLabelIds:['label.a/v1','label.b/v1'],unstartedCaseIds:['pending']});
 for(const reset of [{reasonCodes:[],scores:[]},{reasonCodes:['TARGET_FAILED'],scores:[]}]){assert.equal(observe(model),undefined);assert.equal(observe(judge),undefined);assert.equal(observe(reset),undefined);}
 assert.equal(observe(model),undefined);assert.equal(observe(judge),undefined);const stopped=observe(model);
 assert.equal(stopped.reasonCode,'BATCH_MODEL_NETWORK_UNAVAILABLE');assert.equal(stopped.threshold,3);assert.equal(stopped.completionOrder.length,3);assert.deepEqual(stopped.unstartedCaseIds,['pending']);
 assert.equal(observe({reasonCodes:[],scores:[]}),undefined);assert.equal(observe(model),undefined);assert.equal(stopped.completionOrder.length,3);
});

import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {temporary,question,json,judgeInput} from './support.mjs';
import {runEvaluationBatch} from '../../dist/src/app/batch.js';
import {runEvaluation} from '../../adapters/shared/evaluation.mjs';

test('DSH batch stops new dispatch after three network failures, drains in-flight Cases and records pending IDs',async t=>{
 const root=await temporary(t);await mkdir(path.join(root,'target'));let started=0,finished=0;
 const basic={schema:'evaldock.mvp.cli-summary/v1',command:'run',fixture:false,status:'COMPLETED',exitCode:0,operationalHealth:'HEALTHY',failureGroups:[],reasonCodes:[],recordsPath:'unused',scores:[]};
 const result=await runEvaluationBatch({cwd:root,runId:'circuit.dsh',descriptor:{targetId:'agent.contract',sourceRoot:path.join(root,'target')},workflowRunner:async input=>{
  if(input.stopAfter==='PLAN')return {...basic,runId:input.runId,datasetTestProfile:'STANDARD',selectedDatasets:[{datasetId:'dataset.dynamic/v1',evaluationLabelIds:['label.a/v1'],caseCount:10,reason:'test'}],totalCaseCount:10,datasetMatchModel:'fixture',datasetMatchDurationMs:0};
  const n=++started;await delay(n<=3?5:30);finished++;
  return n<=3?{...basic,runId:input.runId,status:'FAILED',exitCode:4,operationalHealth:'FAILED',reasonCodes:['LABEL_JUDGE_ERROR'],scores:[transport('label.a/v1')]}:{...basic,runId:input.runId};
 }});
 assert.ok(started>=3 && started<=5);assert.equal(finished,started);assert.equal(result.caseResults.length,started);
 assert.equal(result.status,'FAILED');assert.equal(result.dispatchStop.threshold,3);assert.equal(result.dispatchStop.unstartedCaseIds.length,10-started);
 assert.ok(result.reasonCodes.includes('BATCH_MODEL_NETWORK_UNAVAILABLE'));
 const persisted=JSON.parse(await readFile(result.runSummaryPath));assert.deepEqual(persisted.dispatchStop,result.dispatchStop);
 assert.equal(result.dispatchStop.completionOrder.length,3);
});

test('shared Agent pipeline also stops new dispatch and keeps network failures out of valid scores',async t=>{
 const root=await temporary(t),label=judgeInput().label;for(let i=1;i<=8;i++)await question(path.join(root,'datasets'),i);
 await json(path.join(root,'labels/contract.json'),label);
 await writeFile(path.join(root,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Synthetic',description:'Fixture',labelIds:[label.labelId],availableCaseCount:8}]})+'\n```');
 let executed=0;
 const adapter={kind:'pi',targetId:'pi',name:'Fixture',inspect:async()=>({evaluationReady:true,version:'fixture',installRoot:root,limitations:[]}),prepare:async()=>({}),dispose:async()=>{},staticInfo:()=>({plugins:[],tools:[],limitations:[]}),trace:{kind:'pi',sourceType:'PI_PROBE',externalSchema:'pi/events',blindSpots:[],normalizeEvent:r=>r},run:async()=>{executed++;await delay(5);return {sessionId:'fixture.session',queue:[],seen:0,final:'Fixture',error:null,cleanup:'CONFIRMED',result:{stopReason:'end_turn'}};}};
 const result=await runEvaluation({root,runId:'circuit.shared',adapter,onProgress:()=>{},evaluationConfig:{mode:'FULL',selection:{kind:'ALL'}},judgeFactory:()=>({evaluate:async input=>({...transport(input.label.labelId),scale:{min:0,max:10},model:'fixture',evidenceIds:[]})})});
 assert.ok(executed>=3 && executed<=5,JSON.stringify({executed,reasonCodes:result.reasonCodes,caseResults:result.caseResults.map(c=>({reasonCodes:c.reasonCodes,scores:c.scores}))}));assert.equal(result.status,'FAILED');assert.equal(result.dispatchStop.unstartedCaseIds.length,8-executed);
 assert.ok(result.reasonCodes.includes('BATCH_MODEL_NETWORK_UNAVAILABLE'));assert.equal(result.dimensions[0].score,null);
 const saved=JSON.parse(await readFile(path.join(root,'var/evaluation-results/agents/pi/runs/circuit.shared/run.json')));assert.equal(saved.dispatchStop.threshold,3);assert.equal(saved.caseResults.length,executed);
});
