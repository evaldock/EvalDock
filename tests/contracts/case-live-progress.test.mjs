import test from 'node:test';
import assert from 'node:assert/strict';
import {recordCaseProgress,runProgress} from '../../workbench/lib/run-progress.mjs';
test('case stages survive bounded log replay and out-of-order concurrent completion',()=>{
 const job={state:'RUNNING',events:[]};let tick=0;
 const emit=(ordinal,phase,extra={})=>{const e={ordinal,total:4,caseId:'case-'+ordinal,datasetId:'dataset.test/v1',phase,at:new Date(1700000000000+tick++).toISOString(),...extra};const text='[evaldock:case] '+JSON.stringify(e);recordCaseProgress(job,text);job.events.push({kind:'stderr',text,time:e.at});};
 for(let i=1;i<=4;i++)emit(i,'QUEUED');emit(1,'PREPARING');emit(1,'EXECUTING',{sessionId:'own-1'});emit(2,'EXECUTING');emit(1,'JUDGING',{labelId:'reasoning',labelIndex:1,labelCount:2});emit(2,'FAILED',{reasonCode:'AGENT_FILE_OUTPUT_UNSUPPORTED'});
 job.events=job.events.slice(-3);let p=runProgress(job);assert.equal(p.cases.length,4);assert.deepEqual(p.currentCases.map(c=>c.ordinal),[1]);assert.equal(p.current.phase,'JUDGING');assert.equal(p.current.sessionId,'own-1');assert.equal(p.failed,1);assert.equal(p.cases[2].phase,'QUEUED');assert.equal(p.cases[1].reasonCode,'AGENT_FILE_OUTPUT_UNSUPPORTED');
 emit(1,'COMPLETED');p=runProgress(job);assert.equal(p.normal,1);assert.equal(p.ended,2);assert.equal(p.cases[0].phase,'COMPLETED');
 job.state='CANCELLED';assert.equal(runProgress(job).cases[2].phase,'NOT_FINISHED');assert.equal(runProgress(job).currentCases.length,0);
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
