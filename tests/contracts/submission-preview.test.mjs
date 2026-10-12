import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {writeFile,symlink,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {temporary} from './support.mjs';
import {submissionContent,submissionFilePreview,SUBMISSION_CONTENT_BUDGET_BYTES as BUDGET} from '../../dist/src/all-trace/submission.js';
import {snapshot,collectFiles} from '../../adapters/shared/evidence.mjs';
const pieces=text=>[...text.matchAll(/\[bytes (\d+)\.\.(\d+)\)\n([^]*?)(?=\n\n\[bytes |$)/g)];
test('large UTF-8 previews retain exact bounded head/middle/tail bytes and source hash',()=>{
 const bytes=Buffer.from('甲乙丙丁🌊,abc\n'.repeat(40000));const view=submissionContent(bytes,'report.csv',BUDGET,false);
 assert.equal(view.representation,'TEXT');assert.equal(view.contentTruncated,true);assert.equal(view.evaluationScope,'CONTENT');assert.ok(view.consumedBytes<16000);
 assert.ok(view.content.includes(createHash('sha256').update(bytes).digest('hex')));const parts=pieces(view.content);assert.equal(parts.length,3);
 for(const [,start,end,text]of parts){assert.equal(text,bytes.subarray(+start,+end).toString('utf8'));assert.ok(!text.includes('�'));assert.ok(+end-(+start)<=4096);}
 assert.equal(+parts[0][1],0);assert.equal(+parts[2][2],bytes.length);
});
test('restricted, binary, invalid UTF-8 and exhausted budgets remain indexes',()=>{
 for(const [bytes,name]of [[Buffer.alloc(300000),'x.csv'],[Buffer.alloc(300000,255),'x.json'],[Buffer.alloc(300000,65),'x.xlsx']])assert.equal(submissionContent(bytes,name,BUDGET,false).representation,'INDEX_ONLY');
 assert.equal(submissionContent(Buffer.alloc(300000,65),'x.txt',BUDGET,true).contentOmittedReason,'RESTRICTED');
 assert.equal(submissionContent(Buffer.alloc(300000,65),'x.txt',100,false).contentOmittedReason,'CASE_CONTENT_BUDGET');
 assert.equal(submissionContent(Buffer.from('complete'),'x.txt',BUDGET,false).content,'complete');
});
test('file preview and shared adapter include bounded content without claiming original is archived',async t=>{
 const root=await temporary(t);await mkdir(path.join(root,'output'));const file=path.join(root,'output/large.csv');
 const bytes=Buffer.from('a,b,c\n'.repeat(200000));await writeFile(file,bytes);
 const sampled=await submissionFilePreview(file,root,'output/large.csv',BUDGET);assert.equal(sampled.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(sampled.byteLength,bytes.length);
 const collected=await collectFiles(root,await snapshot(root),['output'],{targetId:'agent',runId:'run',caseId:'case',attemptId:'attempt'});
 assert.equal(collected.files[0].contentTruncated,true);assert.equal(collected.files[0].archiveStatus,'NOT_ARCHIVED');assert.equal(collected.files[0].hash,sampled.sha256);assert.equal(collected.bodies.size,0);
 const outside=path.join(await temporary(t),'secret.txt');await writeFile(outside,bytes);await symlink(outside,path.join(root,'escape.txt'));
 await assert.rejects(submissionFilePreview(path.join(root,'escape.txt'),root,'escape.txt',BUDGET),/outside|regular/);
});
