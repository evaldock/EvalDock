import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {trace,judgeInput} from './support.mjs';
import {OpenAiCompatibleLabelJudge,createDefaultLabelJudge,judgeMessages} from '../../dist/src/evaluation/llm-label-judge.js';
import {providerUsage,summarizeJudgeUsage} from '../../dist/src/evaluation/judge-usage.js';
import {evaluateLabels} from '../../dist/src/evaluation/evaluate-labels.js';
import {RequestLimiter} from '../../dist/src/evaluation/judge-concurrency.js';
import {digestValue} from '../../dist/src/core/models.js';

const inputs=(n=4)=>Array.from({length:n},(_,i)=>{
  const input=judgeInput(trace([{id:'answer',layer:'DELIVERY',content:{text:'Shared evidence '.repeat(4000)}}]));
  const label={...input.label,labelId:`label.${i}/v1`,title:`Dimension ${i}`,scoringStandard:{scoring_scale:{min:0,max:100}},judge:{modelRole:`Judge ${i}`,instructions:[`Use criterion ${i}`]}};
  return {...input,label:{...label,contentDigest:digestValue(label)}};
});
const options={endpoint:'https://judge.test/api',apiKey:'synthetic-key',model:'test',retryDelayMs:0};
const row=(id,score=80)=>({labelId:id,status:'SCORED',score,reason:'Supported by answer',evidence_ids:['answer']});
const reply=(content,usage)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],...(usage?{usage}:{})}));
const rubric=body=>JSON.parse(body.messages.at(-1).content);
const responseFor=body=>{const r=rubric(body);return r.labels?{results:r.labels.map(item=>row(item.label.labelId)).reverse()}:row(r.label.labelId);};

test('four rubrics share a lossless trace once; reordered responses keep label identity and usage is counted once',async()=>{
  const requests=[],batch=inputs();
  const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async(_url,request)=>{
    const body=JSON.parse(request.body);requests.push(body);
    return reply(responseFor(body),{prompt_tokens:1000,completion_tokens:150,prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:200});
  }});
  const scores=await evaluateLabels(judge,batch);
  assert.equal(requests.length,1);assert.deepEqual(scores.map(score=>score.labelId),batch.map(input=>input.label.labelId));
  assert.ok(scores.every(score=>score.score===80));
  const shared=JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(shared.all_trace,batch[0].allTrace);
  assert.deepEqual(rubric(requests[0]).labels.map(item=>item.instructions),batch.map(input=>input.label.judge.instructions));
  const summary=summarizeJudgeUsage(scores);
  assert.equal(summary.requestCount,1);assert.equal(summary.inputTokens,1000);assert.equal(summary.outputTokens,150);
  assert.equal(summary.cacheHitTokens,800);assert.equal(summary.cacheHitRate,.8);
  assert.equal(new Set(scores.map(score=>score.diagnostics.requests[0].requestId)).size,1);
  for(const score of scores) assert.deepEqual(score.contentDigest,digestValue(score,['contentDigest']));
  const individualBytes=batch.reduce((sum,input)=>sum+Buffer.byteLength(JSON.stringify(judgeMessages([input]))),0);
  const batchBytes=Buffer.byteLength(JSON.stringify(judgeMessages(batch)));
  assert.ok(batchBytes < individualBytes*.3,`${batchBytes} vs ${individualBytes}`);
});

test('shared message prefix is identical across label groups; batchSize=1 uses independent responses',async()=>{
  const batch=inputs(8),a=judgeMessages(batch.slice(0,4)),b=judgeMessages(batch.slice(4));
  assert.deepEqual(a.slice(0,2),b.slice(0,2));assert.notDeepEqual(a[2],b[2]);
  let calls=0;
  const judge=new OpenAiCompatibleLabelJudge({...options,batchSize:1,fetchImpl:async(_url,req)=>{calls++;return reply(responseFor(JSON.parse(req.body)));}});
  const scores=await judge.evaluateBatch(batch);
  assert.equal(calls,8);assert.ok(scores.every(score=>score.status==='SCORED'));
  assert.equal(summarizeJudgeUsage(scores).unknownUsageRequests,8);
});

test('actual evidence, case and mode differences never share a request, even with stale equal digests',async()=>{
  const batch=inputs(4);
  batch[1]={...batch[1],case:{...batch[1].case,task:'Different task'}};
  batch[2]={...batch[2],allTrace:{...batch[2].allTrace,entries:[{id:'answer',layer:'DELIVERY',content:{text:'different evidence'}}]}};
  batch[3]={...batch[3],evaluationMode:'EFFECT'};
  let calls=0;
  const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async(_url,req)=>{calls++;return reply(responseFor(JSON.parse(req.body)));}});
  await judge.evaluateBatch(batch);assert.equal(calls,4);
  assert.throws(()=>judgeMessages(batch),/CONTEXT_MISMATCH/);
});

test('EFFECT batches never send process evidence or accept citations to it',async()=>{
  const batch=inputs(2).map(input=>({...input,evaluationMode:'EFFECT',allTrace:trace([{id:'secret-process',layer:'AGENT',content:{text:'PROCESS_SECRET'}},{id:'answer',layer:'DELIVERY',content:{text:'result'}}])}));
  const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async(_url,req)=>{
    assert.ok(!req.body.includes('PROCESS_SECRET'));assert.ok(!req.body.includes('secret-process'));
    return reply({results:batch.map(input=>({...row(input.label.labelId),evidence_ids:['secret-process']}))});
  }});
  const scores=await judge.evaluateBatch(batch);assert.ok(scores.every(score=>score.reason==='JUDGE_BATCH_EVIDENCE_OUTSIDE_VIEW'));
});

test('missing, duplicate and unknown labels cannot shift other scores; malformed labels are not retried',async()=>{
  const batch=inputs(4);let calls=0;
  const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async()=>{calls++;return reply({results:[row(batch[3].label.labelId,91),row(batch[0].label.labelId),row(batch[0].label.labelId),row('unknown'),{...row(batch[1].label.labelId),score:101}]});}});
  const scores=await judge.evaluateBatch(batch);
  assert.equal(scores[0].reason,'JUDGE_BATCH_LABEL_DUPLICATE');assert.equal(scores[1].reason,'JUDGE_SCORE_OUT_OF_RANGE');
  assert.equal(scores[2].reason,'JUDGE_BATCH_LABEL_MISSING');assert.equal(scores[3].score,91);
  assert.ok(scores[3].warnings.includes('BATCH_UNKNOWN_LABEL_IGNORED'));assert.equal(calls,1);
});

test('scored batch results require valid citations; unassessable results retain null without evidence',async()=>{
  const batch=inputs(4);
  const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async()=>reply({results:[
    {...row(batch[0].label.labelId),evidence_ids:[]},
    {...row(batch[1].label.labelId),evidence_ids:['unknown']},
    {...row(batch[2].label.labelId),evidence_ids:'answer'},
    {...row(batch[3].label.labelId),status:'UNASSESSABLE',score:null,evidence_ids:[]},
  ]})});
  const scores=await judge.evaluateBatch(batch);
  assert.deepEqual(scores.map(score=>score.status),['ERROR','ERROR','ERROR','UNASSESSABLE']);
});

test('retry ledger includes failed physical attempts once per batch and never fabricates their usage',async()=>{
  const batch=inputs(4);let calls=0;
  const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async(_url,req)=>{
    if(++calls===1) throw Error('Network failure');
    return reply(responseFor(JSON.parse(req.body)),{prompt_tokens:100,completion_tokens:50,prompt_tokens_details:{cached_tokens:60}});
  }});
  const scores=await judge.evaluateBatch(batch),usage=summarizeJudgeUsage(scores);
  assert.equal(calls,2);assert.equal(usage.requestCount,2);assert.equal(usage.unknownUsageRequests,1);
  assert.equal(usage.inputTokens,100);assert.equal(usage.cacheMissTokens,40);assert.equal(usage.cacheHitRate,null);
  assert.ok(scores.every(score=>score.diagnostics.attempts===2 && score.diagnostics.requests.length===2));
});

test('invalid JSON and permanent context failures do not fan out into paid single-label retries',async()=>{
  for(const response of [()=>reply('not-json',{prompt_tokens:100,completion_tokens:10}),()=>new Response('context length exceeded',{status:400})]) {
    let calls=0;const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async()=>{calls++;return response();}});
    const scores=await judge.evaluateBatch(inputs());assert.ok(scores.every(score=>score.status==='ERROR'));assert.equal(calls,1);
    assert.equal(summarizeJudgeUsage(scores).requestCount,1);
  }
});

test('shared concurrency limit covers different Judge instances and batches',async()=>{
  let active=0,peak=0;
  const fetchImpl=async(_url,req)=>{peak=Math.max(peak,++active);await delay(5);active--;return reply(responseFor(JSON.parse(req.body)));};
  const judges=Array.from({length:3},()=>new OpenAiCompatibleLabelJudge({...options,batchSize:2,fetchImpl}));
  const results=await Promise.all(judges.map(judge=>judge.evaluateBatch(inputs(12))));
  assert.equal(peak,4);assert.ok(results.flat().every(score=>score.status==='SCORED'));
});

test('queued cancellation removes requests and release is idempotent',async()=>{
  const limiter=new RequestLimiter(1),release=await limiter.acquire(),abort=new AbortController();
  const waiting=limiter.acquire(abort.signal);abort.abort();await assert.rejects(waiting,/JUDGE_CANCELLED/);
  release();release();const done=await limiter.acquire();done();
  let calls=0;const judge=new OpenAiCompatibleLabelJudge({...options,signal:abort.signal,fetchImpl:async()=>{calls++;throw Error();}});
  const scores=await judge.evaluateBatch(inputs());assert.equal(calls,0);
  assert.ok(scores.every(score=>score.reason==='JUDGE_CANCELLED'));assert.equal(summarizeJudgeUsage(scores).requestCount,0);
});

test('missing private references bypass Judge and credentials; custom single-label judges remain supported',async()=>{
  const batch=inputs(2).map(input=>({...input,case:{...input.case,grading:{mode:'unavailable'}}}));
  const scores=await evaluateLabels(createDefaultLabelJudge({}),batch);
  assert.ok(scores.every(score=>score.model==='not-invoked'));assert.equal(summarizeJudgeUsage(scores).untrackedScoreCount,0);
  const ordinary=inputs(2);let calls=0;
  const single={evaluate:async input=>{calls++;return {labelId:input.label.labelId};}};
  assert.equal((await evaluateLabels(single,ordinary)).length,2);assert.equal(calls,2);
  await assert.rejects(evaluateLabels({evaluateBatch:async()=>[]},ordinary),/RESULT_MISMATCH/);
});

test('duplicate input labels fail before sending; invalid batching configuration is rejected',async()=>{
  const input=inputs(1)[0];let calls=0;
  const judge=new OpenAiCompatibleLabelJudge({...options,fetchImpl:async()=>{calls++;throw Error();}});
  await assert.rejects(judge.evaluateBatch([input,input]),/LABEL_DUPLICATE/);assert.equal(calls,0);
  for(const batchSize of [0,9,1.5,NaN]) assert.throws(()=>new OpenAiCompatibleLabelJudge({...options,batchSize}),/batchSize/);
});

test('usage validation retains unknown values and does not add cache hits to input tokens',()=>{
  assert.deepEqual(providerUsage(undefined),{inputTokens:null,outputTokens:null,cacheHitTokens:null,cacheMissTokens:null});
  const usage=providerUsage({prompt_tokens:100,completion_tokens:0,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20});
  assert.equal(usage.inputTokens,100);assert.equal(usage.cacheHitTokens,80);assert.equal(usage.outputTokens,0);
  assert.equal(providerUsage({prompt_tokens:10,prompt_cache_hit_tokens:50}).cacheHitTokens,null);
  assert.equal(providerUsage({prompt_tokens:100,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:80}).cacheHitTokens,null);
});
