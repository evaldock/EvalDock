import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRendererCapture} from '../../adapters/shared/renderer-capture.mjs';
import {subscribeQwen} from '../../adapters/qwenwork/desktop.mjs';
import {buildTrace} from '../../adapters/shared/evidence.mjs';
import {normalizedEvent} from '../../adapters/shared/capture.mjs';
import {projectTraceOverview} from '../../dist/src/reporting/trace-overview.js';

function qwen(){
 const handlers={},context=vm.createContext({window:{desktopApi:Object.fromEntries(['onChatStreamChunk','onChatStreamComplete','onChatStreamError'].map(k=>[k,f=>(handlers[k]=f,()=>{})]))},TextEncoder});
 vm.runInContext(`(${subscribeQwen.toString()})('owned',${createRendererCapture.toString()})`,context);
 const capture=context.window.__evaldockQwenSessions.owned;capture.start();
 return {handlers,capture,push:(usage,subChatId='owned')=>handlers.onChatStreamChunk({subChatId,chunk:{type:'context-usage',usage}})};
}

test('Qwen keeps native result API counters once, excluding context estimates and client default zeroes',async()=>{
 const f=qwen();
 f.push({totalTokens:999999,maxTokens:1000000,percentage:.9});
 f.push({apiUsage:{input_tokens:9999,output_tokens:9999}},'foreign');
 const usage={apiUsage:{input_tokens:120,output_tokens:8,cache_read_input_tokens:80,cache_creation_input_tokens:0,authorization:'private-secret'},totalTokens:88888};
 f.push(usage);f.push(usage);
 f.push({...usage,apiUsage:{...usage.apiUsage,output_tokens:10}});
 f.handlers.onChatStreamComplete({subChatId:'owned'});await f.capture.wait;const out=f.capture.extract();
 assert.equal(out.usage.inputTokens,120);assert.equal(out.usage.outputTokens,10);assert.equal(out.usage.cacheReadTokens,80);
 assert.equal(out.usage.totalTokens,undefined);assert.equal(out.usage.cacheWriteTokens,undefined);
 assert.equal(out.usageEvidence.records,1);assert.equal(out.usageEvidence.scope,'NATIVE_RESULT_SNAPSHOT');
 assert.equal(out.usageEvidence.inputTokenBasis,'EXCLUDES_CACHE');assert.ok(out.execution.durationMs>=0);
 assert.ok(!JSON.stringify(out).includes('private-secret'));assert.ok(!JSON.stringify(out).includes('9999'));
 const trace=buildTrace({scope:{targetId:'qwenwork',runId:'run',caseId:'case',attemptId:'attempt'},capture:{...out,cleanup:'STOPPED'},before:{entries:[],truncated:false},after:{entries:[],truncated:false},delivery:{files:[],artifacts:[],bodies:new Map()},startedAt:out.execution.startedAt,endedAt:out.execution.endedAt,agent:{kind:'qwenwork',sourceType:'QWENWORK_PROBE',externalSchema:'qwen.rpc-stream/v1',normalizeEvent:normalizedEvent,blindSpots:[]}});
 const end=trace.entries.find(e=>e.content?.data?.event?.type==='session/completion').content.data.event.data;
 assert.equal(end.usage.inputTokens,120);assert.equal(end.usageEvidence.scope,'NATIVE_RESULT_SNAPSHOT');assert.equal(projectTraceOverview(trace).usage.input,120);
});

test('Qwen context-only snapshots and fabricated numeric strings remain unknown',async()=>{
 const f=qwen();f.push({totalTokens:10000,maxTokens:20000,apiUsage:{input_tokens:'100',output_tokens:-1}});
 f.handlers.onChatStreamComplete({subChatId:'owned'});await f.capture.wait;const out=f.capture.extract();
 assert.equal(out.usage,null);assert.equal(out.usageEvidence.records,0);assert.equal(out.result.usage,undefined);
});

test('serialized renderer usage is bounded, numeric-only and deduplicated by completed response ID',()=>{
 const context=vm.createContext({TextEncoder});const c=vm.runInContext(`(${createRendererCapture.toString()})('owned')`,context);
 c.start();c.recordUsage('response',{inputTokens:10,outputTokens:0,totalTokens:10});
 c.recordUsage('response',{inputTokens:10,outputTokens:2});
 c.recordUsage('bad',{inputTokens:'999',outputTokens:NaN,cacheReadTokens:-1,token:'secret'});
 for(let i=0;i<5000;i++)c.recordUsage('r-'+i,{inputTokens:1});
 c.finish();c.recordUsage('late',{inputTokens:9999});const out=c.extract();
 assert.equal(out.usage.inputTokens,4105);assert.equal(out.usage.outputTokens,2);assert.equal(out.usage.totalTokens,undefined);
 assert.equal(out.usageEvidence.records,4096);assert.ok(out.usageEvidence.omitted>0);assert.equal(out.usageLedger,undefined);
 assert.ok(Buffer.byteLength(JSON.stringify(out))<4096);assert.ok(!JSON.stringify(out).includes('secret'));
});

test('different native input accounting bases remain unknown when response counters are aggregated',()=>{
 const c=createRendererCapture('owned');
 c.recordUsage('first',{inputTokens:20},{inputTokenBasis:'INCLUDES_CACHE'});
 c.recordUsage('second',{inputTokens:30},{inputTokenBasis:'UNKNOWN'});
 c.recordUsage('third',{inputTokens:40},{inputTokenBasis:'INCLUDES_CACHE'});
 assert.equal(c.usage.inputTokens,90);assert.equal(c.usageEvidence.inputTokenBasis,'UNKNOWN');
});
