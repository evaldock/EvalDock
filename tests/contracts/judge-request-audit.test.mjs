import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,readdir,stat,symlink,mkdir} from 'node:fs/promises';
import {temporary,judgeInput} from './support.mjs';
import {OpenAiCompatibleLabelJudge} from '../../dist/src/evaluation/llm-label-judge.js';
import {createJudgeRequestAuditSink} from '../../dist/src/evaluation/judge-request-audit.js';
const options={endpoint:'https://audit.test/api',apiKey:'synthetic-auth-not-in-body',model:'fixture',retryDelayMs:0};
const records=async dir=>Promise.all((await readdir(dir)).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(path.join(dir,f),'utf8'))));
const reply=content=>new Response(JSON.stringify({usage:{prompt_tokens:10,completion_tokens:5},choices:[{message:{content,reasoning_content:'PRIVATE_THINKING'}}]}));

test('request persists before dispatch; paid malformed response survives parse failure without retry',async t=>{
 const dir=path.join(await temporary(t),'audit');let calls=0;
 const judge=new OpenAiCompatibleLabelJudge({...options,auditDirectory:dir,fetchImpl:async()=>{
   calls++;const [started]=await records(dir);assert.equal(started.status,'STARTED');assert.equal(started.billingStatus,'UNKNOWN');
   assert.ok(started.request.body.messages);assert.ok(!JSON.stringify(started).includes(options.apiKey));
   return reply('not valid score JSON');
 }});
 const score=await judge.evaluate(judgeInput());assert.equal(score.status,'ERROR');assert.equal(calls,1);
 const [record]=await records(dir);assert.equal(record.status,'RESPONSE_RECEIVED');assert.equal(record.response.content,'not valid score JSON');
 assert.equal(record.response.usage.inputTokens,10);assert.equal(record.requestId,score.diagnostics.requests[0].requestId);
 assert.deepEqual(record.events.map(e=>e.status),['STARTED','RESPONSE_RECEIVED']);assert.ok(!JSON.stringify(record).includes('PRIVATE_THINKING'));
 assert.equal((await stat(path.join(dir,record.requestId+'.json'))).mode&0o777,0o600);assert.equal((await stat(dir)).mode&0o777,0o700);
});

test('failed attempts retain distinct durable IDs and unknown billing',async t=>{
 const dir=path.join(await temporary(t),'audit');let calls=0;
 const judge=new OpenAiCompatibleLabelJudge({...options,auditDirectory:dir,fetchImpl:async()=>{if(++calls===1)throw Object.assign(new Error('do not store me'),{cause:{code:'ECONNRESET'}});return reply('{"score":7,"reason":"ok"}');}});
 const score=await judge.evaluate(judgeInput()),saved=await records(dir);assert.equal(saved.length,2);assert.equal(score.score,7);
 const failed=saved.find(r=>r.status==='FAILED');assert.equal(failed.billingStatus,'UNKNOWN');assert.equal(failed.error.code,'JUDGE_NETWORK_ERROR');assert.ok(!JSON.stringify(saved).includes('do not store me'));
 assert.equal(new Set(score.diagnostics.requests.map(r=>r.requestId)).size,2);
});

test('audit write failures prevent dispatch or rebilling; response persistence failure preserves STARTED',async t=>{
 let calls=0;const failed=new OpenAiCompatibleLabelJudge({...options,requestAudit:async()=>{throw Error('disk full');},fetchImpl:async()=>{calls++;return reply('{}');}});
 const score=await failed.evaluate(judgeInput());assert.equal(score.reason,'JUDGE_REQUEST_AUDIT_FAILED');assert.equal(calls,0);assert.deepEqual(score.diagnostics.requests,[]);
 const dir=path.join(await temporary(t),'audit'),sink=createJudgeRequestAuditSink(dir);
 const after=new OpenAiCompatibleLabelJudge({...options,requestAudit:async record=>{if(record.status!=='STARTED')throw Error('disk full');await sink(record);},fetchImpl:async()=>{calls++;return reply('{"score":7}');}});
 const paid=await after.evaluate(judgeInput());assert.equal(paid.reason,'JUDGE_REQUEST_AUDIT_FAILED');assert.equal(calls,1);assert.equal(paid.diagnostics.requests[0].inputTokens,10);
 assert.equal((await records(dir))[0].status,'STARTED');await after.evaluate(judgeInput());assert.equal(calls,1);
});

test('audit rejects a symlinked directory and public response excludes thinking blocks',async t=>{
 const root=await temporary(t),outside=path.join(root,'outside'),link=path.join(root,'link');await mkdir(outside);await symlink(outside,link);
 let calls=0;const judge=new OpenAiCompatibleLabelJudge({...options,auditDirectory:link,fetchImpl:async()=>{calls++;return reply('{}');}});
 assert.equal((await judge.evaluate(judgeInput())).reason,'JUDGE_REQUEST_AUDIT_FAILED');assert.equal(calls,0);assert.deepEqual(await readdir(outside),[]);
 const nested=new OpenAiCompatibleLabelJudge({...options,auditDirectory:path.join(link,'new-child'),fetchImpl:async()=>{calls++;return reply('{}');}});
 assert.equal((await nested.evaluate(judgeInput())).reason,'JUDGE_REQUEST_AUDIT_FAILED');assert.equal(calls,0);assert.deepEqual(await readdir(outside),[]);
 const dir=path.join(root,'real');const safe=new OpenAiCompatibleLabelJudge({...options,auditDirectory:dir,fetchImpl:async()=>reply([{type:'thinking',thinking:'HIDDEN'},{type:'text',text:'{"score":7}'}])});
 await safe.evaluate(judgeInput());const [record]=await records(dir);assert.deepEqual(record.response.content,[{type:'text',text:'{"score":7}'}]);assert.ok(!JSON.stringify(record).includes('HIDDEN'));
});
