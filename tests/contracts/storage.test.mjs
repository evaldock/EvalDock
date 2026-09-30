import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {readFile,writeFile,readdir,chmod} from 'node:fs/promises';
import {temporary,trace} from './support.mjs';
import {writeTraceDirectory,readTraceDirectory,readEvidenceFile} from '../../dist/src/all-trace/store.js';
import {buildResult,serializeReportDocument,parseVerifiedReportDocument} from '../../dist/src/reporting/record.js';
import {projectPaths} from '../../dist/src/platform/paths.js';
test('all storage roots are separate and relative to the project',()=>{const p=projectPaths('/example');assert.equal(new Set(Object.values(p)).size,4);assert.ok(Object.values(p).every(x=>x.startsWith('/example/var/')));});
test('Trace roundtrip preserves events, shares bodies, detects corruption and path escapes',async t=>{
 const dir=await temporary(t);const text='shared'.repeat(1000);const source=trace(Array.from({length:4},(_,i)=>({id:'event.'+i,layer:'AGENT',content:{nested:{arguments:text,result:text},callId:String(i)}})));
 const ref=await writeTraceDirectory({caseDirectory:dir,trace:source,maxBytes:1024*1024});
 assert.deepEqual(JSON.parse(JSON.stringify(await readTraceDirectory(dir,ref,1024*1024))),source);
 const blobs=await readdir(path.join(dir,'all-trace/blobs'));assert.ok(blobs.length<source.entries.length*3,'large object wrappers must not each become a blob');
 await assert.rejects(readEvidenceFile(dir,'../secret',1024));
 await chmod(path.join(dir,'all-trace/blobs',blobs[0]),0o600);
 await writeFile(path.join(dir,'all-trace/blobs',blobs[0]),'corrupted');
 await assert.rejects(readTraceDirectory(dir,ref,1024*1024));
});
test('small output bodies refer to the archived output; immutable directories reject replacement',async t=>{
 const dir=await temporary(t),source=trace([{id:'file',layer:'DELIVERY',content:{portablePath:'output/a.txt',mediaType:'text/plain',byteLength:3000,representation:'TEXT',content:'x'.repeat(3000),contentTruncated:false,contentRestricted:false}}]);
 const ref=await writeTraceDirectory({caseDirectory:dir,trace:source,maxBytes:100000});
 assert.equal((await readFile(path.join(dir,'output/a.txt'))).length,3000);assert.deepEqual(JSON.parse(JSON.stringify(await readTraceDirectory(dir,ref,100000))),source);
 await assert.rejects(writeTraceDirectory({caseDirectory:dir,trace:source,maxBytes:100000}));
});
test('reports project input bodies out without mutating execution input',()=>{
 const data={runId:'run',scope:{runId:'run'},target:{},scores:[],dimensions:[],timeline:[],artifacts:[],case:{task:'Task',inputs:[{source:'input/x'}],seedEntries:[{content:'PRIVATE_LARGE_SEED'}]},plan:{casePlan:{seedSpec:{entries:[{content:'PRIVATE_LARGE_SEED'}]},scenarioId:'case'}}};
 const report=buildResult(data,'test'),text=serializeReportDocument(report);
 assert.ok(!text.includes('PRIVATE_LARGE_SEED'));assert.equal(data.case.seedEntries.length,1);assert.equal(parseVerifiedReportDocument(text).case.task,'Task');
 assert.equal(parseVerifiedReportDocument(serializeReportDocument(buildResult(report,'test'))).runId,'run');
 const changed=JSON.parse(text);changed.runId='other';assert.throws(()=>parseVerifiedReportDocument(JSON.stringify(changed)));
});
