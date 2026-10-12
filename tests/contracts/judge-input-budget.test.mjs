import test from 'node:test';
import assert from 'node:assert/strict';
import {compactSharedInput,expandSharedInput,POOL_INSTRUCTION} from '../../dist/src/evaluation/judge-input-budget.js';
import {OpenAiCompatibleLabelJudge,judgeMessages} from '../../dist/src/evaluation/llm-label-judge.js';
import {trace,judgeInput} from './support.mjs';
const long='Repeated 中文 evidence. '.repeat(1000);
const base={endpoint:'https://judge.invalid/chat',apiKey:'fixture',model:'fixture'};
const response=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({status:'UNASSESSABLE',score:null,reason:'Not enough evidence',evidence_ids:[]})}}]}));
function fixture(){return judgeInput(trace([{id:'a',layer:'AGENT',payload:{text:long}},{id:'b',layer:'DELIVERY',payload:{text:long}}]));}

test('shared string pooling round trips nested data, unusual keys and literal reference-like content',()=>{
  const value=JSON.parse(JSON.stringify({a:[long,{text:long}],b:{schema:'evaldock.judge-string-pool/v1',data:long,repeatedStrings:[{value:long,paths:[['a']]}]}}));
  Object.defineProperty(value,'__proto__',{value:{text:long},enumerable:true});
  const original=JSON.stringify(value),compact=compactSharedInput(original);
  assert.ok(Buffer.byteLength(compact)<Buffer.byteLength(original)/2);
  assert.deepEqual(expandSharedInput(compact),value);
  assert.equal(compactSharedInput(original),compact);
  assert.equal({}.text,undefined);
  assert.equal(compactSharedInput('{"text":"short"}'),'{"text":"short"}');
});
test('over-budget requests fail before auditing, observation or fetching, with no retries/usage',async()=>{
  let calls=0;
  const judge=new OpenAiCompatibleLabelJudge({...base,maxInputBytes:100,fetchImpl:async()=>{calls++;return response();},requestAudit:async()=>{calls++;},requestObserver:()=>{calls++;}});
  const score=await judge.evaluate(fixture());
  assert.equal(score.reason,'JUDGE_INPUT_TOO_LARGE');assert.equal(score.status,'ERROR');assert.equal(score.diagnostics.attempts,1);
  assert.ok(score.diagnostics.savedInputBytes>0);assert.ok(score.diagnostics.requestBytes>100);assert.deepEqual(score.diagnostics.requests,[]);assert.equal(calls,0);
});
test('actual UTF-8 wire bytes including model, rubric and envelope enforce the exact budget boundary',async()=>{
  const input=fixture();let wire;
  const fetchImpl=async(_url,request)=>{wire=request.body;return response();};
  const first=await new OpenAiCompatibleLabelJudge({...base,fetchImpl}).evaluate(input);
  const size=Buffer.byteLength(wire);assert.equal(first.diagnostics.requestBytes,size);
  const body=JSON.parse(wire);assert.ok(body.messages[0].content.includes(POOL_INSTRUCTION));
  assert.deepEqual(expandSharedInput(body.messages[1].content),JSON.parse(judgeMessages([input])[1].content));
  assert.equal(body.messages[2].content,judgeMessages([input])[2].content);
  const exact=await new OpenAiCompatibleLabelJudge({...base,maxInputBytes:size,fetchImpl}).evaluate(input);
  assert.equal(exact.status,'UNASSESSABLE');
  const tooSmall=await new OpenAiCompatibleLabelJudge({...base,maxInputBytes:size-1,fetchImpl:async()=>{throw Error('must not fetch');}}).evaluate(input);
  assert.equal(tooSmall.reason,'JUDGE_INPUT_TOO_LARGE');
});
test('EFFECT pooling cannot expose process-only evidence and batch rubrics retain separate identities',async()=>{
  const input={...fixture(),evaluationMode:'EFFECT'};let body;
  const judge=new OpenAiCompatibleLabelJudge({...base,fetchImpl:async(_url,request)=>{body=JSON.parse(request.body);return response();}});
  await judge.evaluate(input);
  const shared=expandSharedInput(body.messages[1].content);
  assert.equal(shared.all_trace,undefined);assert.deepEqual(shared.output_evidence.entries.map(e=>e.id),['b']);
  const {digestValue}=await import('../../dist/src/core/models.js');
  const other={...input,label:{...input.label,labelId:'label.other/v1',title:'Other'}};
  other.label.contentDigest=digestValue(other.label,['contentDigest']);
  await judge.evaluateBatch([input,other]);
  assert.deepEqual(JSON.parse(body.messages[2].content).labels.map(l=>l.label.labelId),['label.contract/v1','label.other/v1']);
});
test('invalid input budgets are rejected at configuration time',()=>{
  for(const maxInputBytes of [0,-1,NaN,Infinity,1.5])assert.throws(()=>new OpenAiCompatibleLabelJudge({...base,maxInputBytes}),/maxInputBytes/);
});
