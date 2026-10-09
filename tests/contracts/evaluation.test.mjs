import test from 'node:test';import assert from 'node:assert/strict';
import {trace,judgeInput} from './support.mjs';
import {judgePrompt,OpenAiCompatibleLabelJudge,parseLabelScore} from '../../dist/src/evaluation/llm-label-judge.js';
import {aggregateScores} from '../../dist/src/evaluation/scoring.js';
import {submissionContent,SUBMISSION_CONTENT_BUDGET_BYTES} from '../../dist/src/all-trace/submission.js';
import {environmentFinalEntry} from '../../dist/src/all-trace/environment-summary.js';
test('every label receives the same complete evidence',()=>{const evidence=trace([{id:'e1',layer:'AGENT',content:{text:'actual body'}}]),a=judgeInput(evidence),b={...a,label:{...a.label,labelId:'label.other/v1'}};assert.deepEqual(judgePrompt(a).all_trace,judgePrompt(b).all_trace);assert.equal(judgePrompt(a).all_trace,evidence);});
test('Judge tolerates wrappers and extra fields without inventing scores',()=>{
 const input=judgeInput();const score=parseLabelScore(JSON.stringify({type:'text',content:'{"score":"7.25","reason":"Supported","extra":true}'}),input,'test');
 assert.equal(score.score,7.25);assert.throws(()=>parseLabelScore('{"reason":"no score"}',input,'test'));
 assert.equal(parseLabelScore('{"score":null,"reason":"Evidence unavailable"}',input,'test').score,null);
});
test('weighted aggregation excludes null and zero weight, retains zero scores',()=>{
 const input=judgeInput(),score=n=>parseLabelScore(JSON.stringify({score:n,reason:'test'}),input,'test');
 const result=aggregateScores([{...score(0),weight:1},{...score(10),weight:3},{...score(4),weight:0},score(null)])[0];
 assert.equal(result.score,7.5);assert.equal(result.scoredCases,2);assert.equal(result.unassessableCases,1);
 assert.throws(()=>aggregateScores([{...score(3),weight:-1}]));
 assert.throws(()=>aggregateScores([score(1),{...score(2),scale:{min:0,max:5}}]));
});
test('Judge transient errors retry; context errors stay explicit and do not retry blindly',async()=>{
 let calls=0;const j=new OpenAiCompatibleLabelJudge({endpoint:'https://judge.test/api',apiKey:'not-real',model:'test',retryDelayMs:0,fetchImpl:async()=>{calls++;if(calls===1)throw new Error('offline');return new Response(JSON.stringify({choices:[{message:{content:'{"score":6,"reason":"supported"}'}}]}));}});
 assert.equal((await j.evaluate(judgeInput())).score,6);assert.equal(calls,2);
 let permanent=0;const bad=new OpenAiCompatibleLabelJudge({endpoint:'https://judge.test/api',apiKey:'not-real',model:'test',fetchImpl:async()=>{permanent++;return new Response('{"error":{"message":"maximum context length exceeded"}}',{status:400});}});
 const score=await bad.evaluate(judgeInput());assert.equal(score.status,'ERROR');assert.equal(score.score,null);assert.equal(permanent,1);
});
test('large deliverables become indexes; small contents respect their combined budget',()=>{
 const big=submissionContent(Buffer.alloc(SUBMISSION_CONTENT_BUDGET_BYTES+1),'output/a.xlsx',1e6,false);assert.equal(big.representation,'INDEX_ONLY');assert.equal(big.content,null);
 assert.equal(submissionContent(Buffer.from('hello'),'output/a.txt',100,false).content,'hello');
 assert.equal(submissionContent(Buffer.from('hello'),'output/a.txt',1,false).evaluationScope,'EXISTENCE_ONLY');
});
test('environment summaries remain bounded with arbitrary component registries',()=>{
 const paused=Array.from({length:180},(_,i)=>'custom-observer-'+i);const result=environmentFinalEntry([],[],[],paused);
 assert.ok(Buffer.byteLength(JSON.stringify([result]))<=1024);assert.ok(result.content.omittedComponents>0);
});
