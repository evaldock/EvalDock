import test from 'node:test';
import assert from 'node:assert/strict';
import {recordCaseProgress,runProgress} from '../../workbench/lib/run-progress.mjs';
import {ControlResults} from '../../workbench/lib/control-results.mjs';
import {AgentControl} from '../../workbench/lib/agent-control.mjs';
import {WorkBuddyControl} from '../../workbench/lib/workbuddy-control.mjs';
import {DshControl} from '../../workbench/lib/dsh-control.mjs';
import {Jobs} from '../../workbench/lib/jobs.mjs';
import {temporary,json} from './support.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {renderRun} from '../../workbench/design-prototypes/product-pages.js';
test('case stages survive bounded log replay and out-of-order concurrent completion',()=>{
 const job={state:'RUNNING',events:[]};let tick=0;
 const emit=(ordinal,phase,extra={})=>{const e={ordinal,total:4,caseId:'case-'+ordinal,datasetId:'dataset.test/v1',phase,at:new Date(1700000000000+tick++).toISOString(),...extra};const text='[evaldock:case] '+JSON.stringify(e);recordCaseProgress(job,text);job.events.push({kind:'stderr',text,time:e.at});};
 for(let i=1;i<=4;i++)emit(i,'QUEUED');emit(1,'PREPARING');emit(1,'EXECUTING',{sessionId:'own-1'});emit(2,'EXECUTING');emit(1,'JUDGING',{labelId:'reasoning',labelIndex:1,labelCount:2});emit(2,'FAILED',{reasonCode:'AGENT_FILE_OUTPUT_UNSUPPORTED'});
 job.events=job.events.slice(-3);let p=runProgress(job);assert.equal(p.cases.length,4);assert.deepEqual(p.currentCases.map(c=>c.ordinal),[1]);assert.equal(p.current.phase,'JUDGING');assert.equal(p.current.sessionId,'own-1');assert.equal(p.failed,1);assert.equal(p.cases[2].phase,'QUEUED');assert.equal(p.cases[1].reasonCode,'AGENT_FILE_OUTPUT_UNSUPPORTED');
 emit(1,'COMPLETED');p=runProgress(job);assert.equal(p.normal,1);assert.equal(p.ended,2);assert.equal(p.cases[0].phase,'COMPLETED');
 job.state='CANCELLED';assert.equal(runProgress(job).cases[2].phase,'NOT_FINISHED');assert.equal(runProgress(job).currentCases.length,0);
});
test('saved Case results restore historical progress for every controller without batch logs',async t=>{
 const root=await temporary(t),targetId='synthetic-progress',runId='synthetic-history',file=path.join(root,'var/evaluation-results/agents',targetId,'runs',runId,'run.json');
 await json(file,{fixture:true,status:'COMPLETED',totalCaseCount:3,caseResults:[1,2,3].map(n=>({caseId:'synthetic-'+n,status:'COMPLETED'}))});const original=await readFile(file);
 const job={id:'synthetic-job',targetId,runId,state:'SUCCEEDED',createdAt:'2026-01-01',events:[],scale:{caseCount:3}},jobs=new Jobs({});jobs.jobs.set(job.id,job);
 const before=structuredClone(job),results=new ControlResults(root);
 const processAgent=Object.assign(new AgentControl({root,kind:'langgraph'}),{jobs,results,targets:[]});
 const officeAgent=Object.assign(new WorkBuddyControl({root}),{jobs,results});
 const dsh=Object.assign(new DshControl(root),{jobs,results,descriptor:{dshHome:path.join(root,'missing-dsh'),profile:'web'}});
 for(const controller of [processAgent,officeAgent,dsh]){
  const records=await controller.records(),progress=records.jobs[0].progress;
  assert.equal(progress.ended,3,controller.constructor.name);assert.equal(progress.normal,3);assert.equal(progress.total,3);assert.equal(progress.percent,100);
  assert.match(renderRun(records.jobs[0],records.runs[0]),/3 \/ 3 题已结束/);
 }
 assert.deepEqual(job,before);assert.deepEqual(await readFile(file),original);
});
test('historical progress counts saved outcomes without assuming a terminal Job completed every Case',async t=>{
 const root=await temporary(t),targetId='synthetic-partial',runId='synthetic-cancelled';
 await json(path.join(root,'var/evaluation-results/agents',targetId,'runs',runId,'run.json'),{fixture:true,status:'CANCELLED',totalCaseCount:5,caseResults:['COMPLETED','FAILED','CANCELLED'].map((status,n)=>({caseId:'synthetic-'+n,status}))});
 const jobs=new Jobs({});jobs.jobs.set('synthetic-job',{id:'synthetic-job',targetId,runId,state:'CANCELLED',createdAt:'2026-01-01',events:[]});
 const controller=Object.assign(new AgentControl({root,kind:'langgraph'}),{jobs,results:new ControlResults(root),targets:[]});
 const {jobs:records,runs}=await controller.records(),progress=records[0].progress;
 assert.equal(progress.total,5);assert.equal(progress.ended,3);assert.equal(progress.normal,1);assert.equal(progress.failed,1);assert.equal(progress.cancelled,1);assert.equal(progress.remaining,2);assert.equal(progress.percent,60);
 assert.match(renderRun(records[0],runs[0]),/3 \/ 5 题已结束/);
});
test('saved partial results preserve the live Case phase when progress logs are truncated',async t=>{
 const root=await temporary(t),targetId='synthetic-active',runId='synthetic-live';
 await json(path.join(root,'var/evaluation-results/agents',targetId,'runs',runId,'run.json'),{fixture:true,status:'RUNNING',totalCaseCount:5,caseResults:[1,2,3].map(n=>({caseId:'synthetic-'+n,status:'COMPLETED'}))});
 const job={id:'synthetic-job',targetId,runId,state:'RUNNING',createdAt:'2026-01-01',events:[],eventsTruncated:true};
 recordCaseProgress(job,'[evaldock:case] '+JSON.stringify({ordinal:4,total:5,caseId:'synthetic-4',phase:'JUDGING',labelIndex:1,labelCount:2,at:'2026-01-01T00:00:00Z'}));
 const before=structuredClone(job),jobs=new Jobs({});jobs.jobs.set(job.id,job);
 const controller=Object.assign(new AgentControl({root,kind:'langgraph'}),{jobs,results:new ControlResults(root),targets:[]});
 const {jobs:records}=await controller.records(),progress=records[0].progress;
 assert.equal(progress.ended,3);assert.equal(progress.remaining,2);assert.equal(progress.active,true);assert.equal(progress.current.caseId,'synthetic-4');assert.equal(progress.current.phase,'JUDGING');assert.equal(progress.current.labelCount,2);
 assert.deepEqual(job,before);
});
test('legacy DSH progress remains honest about undifferentiated execution and scoring',()=>{
 const job={state:'RUNNING',events:[]};recordCaseProgress(job,'[evaldock:batch] starting 1/3: legacy','2026-09-23T01:00:00Z');assert.equal(runProgress(job).cases[0].phase,'RUNNING');
 recordCaseProgress(job,'[evaldock:batch] finished 1/3: legacy (COMPLETED)','2026-09-23T01:01:00Z');assert.equal(runProgress(job).cases[0].endedAt,'2026-09-23T01:01:00Z');
});
test('malformed progress does not create phantom cases or expose arbitrary payload',()=>{
 const job={state:'RUNNING',events:[]};for(const value of ['bad',JSON.stringify({ordinal:99999,total:99999,caseId:'x',phase:'EXECUTING'}),JSON.stringify({ordinal:1,total:1,caseId:'x',phase:'EVIL',at:new Date().toISOString()})])recordCaseProgress(job,'[evaldock:case] '+value);
 assert.deepEqual(runProgress(job).cases,[]);
 recordCaseProgress(job,'[evaldock:case] '+JSON.stringify({ordinal:1,total:1,caseId:'x',phase:'EXECUTING',at:new Date().toISOString(),prompt:'secret task',token:'secret'}));assert.ok(!JSON.stringify(runProgress(job)).includes('secret'));
});
