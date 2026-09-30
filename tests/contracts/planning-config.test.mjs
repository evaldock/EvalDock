import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {temporary,json} from './support.mjs';
import {OpenAiCompatibleDatasetMatcher} from '../../dist/src/planning/planner.js';
import {loadModelEnvironment,agentEnvironment} from '../../dist/src/platform/model-environment.js';
import {recordCaseProgress,runProgress} from '../../workbench/lib/run-progress.mjs';
import {DshControl} from '../../workbench/lib/dsh-control.mjs';
import {sessionForJob} from '../../workbench/live-observation.mjs';

const info={target_type:'FULL_AGENT',plugins:[],tools:[],tool_delta:{},limitations:[]};
const candidates=Array.from({length:11},(_,i)=>({datasetId:`dataset.c${i+1}/v1`,name:`c${i+1}`,description:'test',labelIds:['label.contract/v1'],availableCaseCount:i===0?1:i===1?2:10}));
async function select(counts){
 let prompt;
 const matcher=new OpenAiCompatibleDatasetMatcher({endpoint:'https://example.invalid/chat',apiKey:'test-key',model:'deepseek-flash',fetchImpl:async(_,request)=>{
  prompt=JSON.parse(JSON.parse(request.body).messages[0].content);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({selected_datasets:counts.map((n,i)=>({dataset_id:candidates[i].datasetId,case_count:n,reason:'coverage'}))})}}]}));
 }});
 const plan=await matcher.select({agentStaticInfo:info,availableDatasets:candidates,profile:'STANDARD'});
 return {plan,prompt};
}
test('Planner keeps small datasets and requires all their Cases; normal datasets use 3–7',async()=>{
 const {plan,prompt}=await select([1,2,3]);
 assert.equal(plan.totalCaseCount,6);
 assert.equal(prompt.inputs.available_datasets.length,11);
 assert.equal(prompt.inputs.policy.max_datasets,10);
 assert.equal(prompt.inputs.policy.max_total_cases,70);
 assert.equal((await select([1,2,7,3,3,3,3,3,3,3])).plan.selectedDatasets.length,10);
 for(const counts of [[1,1,3],[1,2,2],[1,2,8],[1,2],[1,2,3,3,3,3,3,3,3,3,3]])await assert.rejects(select(counts),/violates/);
});
test('evaluator file respects explicit settings and does not expose evaluator credentials to DSH',async t=>{
 const root=await temporary(t),file=path.join(root,'models.env');
 await writeFile(file,'EVALDOCK_PLANNER_API_KEY=planner-test\nEVALDOCK_JUDGE_API_KEY=judge-test\nEVALDOCK_PLANNER_MODEL=deepseek-flash\nDEEPSEEK_API_KEY=wrong-agent\nPATH=wrong-path\n');
 const env={DEEPSEEK_API_KEY:'agent-test',PATH:'/safe',EVALDOCK_PLANNER_MODEL:'explicit'};
 await loadModelEnvironment(env,file);
 assert.equal(env.EVALDOCK_PLANNER_API_KEY,'planner-test');assert.equal(env.EVALDOCK_JUDGE_API_KEY,'judge-test');
 assert.equal(env.EVALDOCK_PLANNER_MODEL,'explicit');
 assert.deepEqual(agentEnvironment(env),{DEEPSEEK_API_KEY:'agent-test',PATH:'/safe'});
});
test('out-of-order Case completion and log replay preserve every active Case and its session',()=>{
 const job={runId:'run',state:'RUNNING',events:[]};
 const event=text=>{job.events.push({kind:'stderr',text});recordCaseProgress(job,text);};
 for(let i=1;i<=3;i++)event(`[evaldock:batch] starting ${i}/6: case-${i}`);
 event('[evaldock:batch] finished 2/6: case-2 (COMPLETED)');
 const p=runProgress(job);assert.deepEqual(p.currentCases.map(c=>c.ordinal),[1,3]);assert.equal(p.ended,1);
 assert.equal(runProgress(job).current.caseId,'case-1');
 const sessions=[1,3,10].map(i=>({id:String(i),cwd:`/var/run/run.c${i}/workspaces`}));
 for(const c of p.currentCases)assert.equal(sessionForJob(sessions,{...job,progress:{current:c}}).id,String(c.ordinal));
 event('[evaldock:batch] finished 1/6: case-1 (FAILED)');event('[evaldock:batch] finished 3/6: case-3 (CANCELLED)');
 assert.deepEqual(runProgress(job).currentCases,[]);assert.equal(runProgress(job).failed,1);
});
test('workbench ignores old sizing settings when starting a normal run',async t=>{
 const root=await temporary(t);await json(path.join(root,'config/macos-vm.json'),{});
 const control=new DshControl(root);control.descriptor={profile:'web'};control.testPolicy={minDatasets:3,maxDatasets:10,minCasesPerDataset:3,maxCasesPerDataset:7,maxTotalCases:70};
 control.idle=async()=>({status:'RUNNING',revision:'current',modelReady:true});control.plugins=async()=>({});control.requireStartup=async()=>({status:'PASSED'});
 control.core={dshConfiguration:async()=>({agentId:'agent',plugins:[],profileDigest:'digest'})};control.env={};
 let request;const record={id:'job'};control.jobs={start:async input=>{request=input;return record;},get:()=>record,persist:async()=>{},view:x=>x};
 await control.run({revision:'current',datasetCount:4,caseCount:10,allDatasets:true,casesPerDataset:1});
 assert.deepEqual(request,{action:'run',targetId:'agent'});assert.equal(record.testPolicy.minCasesPerDataset,3);assert.equal(record.scale,undefined);
 const evaluationConfig={mode:'EFFECT',selection:{kind:'COUNT',caseCount:4}};
 await control.run({revision:'current',evaluationConfig});
 assert.deepEqual(request,{action:'run',targetId:'agent',evaluationConfig});
});
