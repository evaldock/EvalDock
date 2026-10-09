/** Exercise canonical storage, relocation, report reconstruction and identical Judge inputs with a real Case. */
import assert from "node:assert/strict";
import {readFile,writeFile,mkdir,readdir,lstat,rm,unlink,link} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {writeTraceDirectory,readTraceDirectory,linkEvidenceTree} from "../dist/src/all-trace/store.js";
import {digestValue} from "../dist/src/core/models.js";
import {judgePrompt} from "../dist/src/evaluation/llm-label-judge.js";
import {renderReportHtml} from "../dist/src/reporting/html.js";
import {writeReportLoader} from "../dist/src/reporting/trace-loader.js";
import {serializeReportDocument,parseVerifiedReportDocument} from "../dist/src/reporting/record.js";
import {commitReportJson,commitReportHtml} from "../dist/src/platform/export.js";
import {exportCaseBundle} from "../dist/src/platform/case-bundle.js";
import {rebuildCommittedReportHtml} from "../dist/src/app/workflow.js";
import {startViewer} from "../dist/src/platform/viewer.js";
const originalPath=process.argv[2], root=path.resolve(process.argv[3]??"");
assert(originalPath && process.argv[3],"Supply original real report and a fresh validation root");
const originalBytes=await readFile(originalPath);
const original=JSON.parse(originalBytes);assert.equal(original.fixture,false);
const maxBytes=256*1024*1024;
const reportRoot=path.join(root,"reports"), source=path.join(reportRoot,original.runId);
const ref=await writeTraceDirectory({caseDirectory:source,trace:original.allTrace,maxBytes,
  readArtifact:async artifact=> {
    const entry=original.allTrace.entries.find(e=>e.layer==="DELIVERY" && e.content?.artifactRef?.id===artifact.artifactId);
    assert(entry);return readFile(path.join(path.dirname(originalPath),entry.content.portablePath));
  }});
const restored=await readTraceDirectory(source,ref,maxBytes);
assert.deepEqual(JSON.parse(JSON.stringify(restored)),original.allTrace);
const {allTrace:_trace,contentDigest:_digest,...metadata}=original;
const withoutDigest={...metadata,allTraceRef:ref};
const document={...withoutDigest,contentDigest:digestValue(withoutDigest)};
const stored=serializeReportDocument(document);
assert(!JSON.parse(stored).allTrace);
await commitReportJson({reportRoot,runId:original.runId,bytes:stored,maxBytes});
await writeReportLoader(source);
await mkdir(path.join(source,"judge"),{recursive:true});
for(const score of original.scores)await writeFile(path.join(source,"judge",score.labelId.replaceAll("/","_")+".json"),JSON.stringify(score)+"\n",{flag:"wx"});
const html=renderReportHtml(document);
assert.equal(html.match(/<style>(.*?)<\/style>/s)[1],renderReportHtml(original).match(/<style>(.*?)<\/style>/s)[1]);
assert(html.includes("report-data.js") && html.includes("data-trace-select"));
assert(!html.includes('"payloadInline"'));
await commitReportHtml({reportRoot,runId:original.runId,bytes:html,maxBytes});
assert.equal((await rebuildCommittedReportHtml({reportRoot,runId:original.runId,maxBytes})).htmlStatus,"VERIFIED");
const judges=original.labels.map(label=>{
 const transmitted=JSON.parse(JSON.stringify(judgePrompt({label,case:original.case,allTrace:restored})));
 assert.deepEqual(transmitted.all_trace,original.allTrace);
 return {labelId:label.labelId,entries:transmitted.all_trace.entries.length,traceDigest:transmitted.all_trace.contentDigest.value};
});
const bundle=await exportCaseBundle({resultRoot:path.join(root,"results"),runRoot:path.join(root,"records"),
 artifactRoot:path.join(root,"unused-artifacts"),reportRoot,agentId:original.target.targetId,runId:"storage-real-replay",
 sourceRunId:original.runId,caseId:path.basename(path.dirname(originalPath)),maxFileBytes:maxBytes});
assert.deepEqual(JSON.parse(JSON.stringify(await readTraceDirectory(bundle.directory,ref,maxBytes))),original.allTrace);
const manifest=JSON.parse(await readFile(path.join(bundle.directory,ref.manifestPath),"utf8"));
const firstBlob=manifest.files.find(f=>f.path.startsWith("all-trace/blobs/"));
assert(firstBlob);
assert.equal((await lstat(path.join(source,firstBlob.path))).ino,(await lstat(path.join(bundle.directory,firstBlob.path))).ino);
await rm(reportRoot,{recursive:true,force:true});
assert.deepEqual(JSON.parse(JSON.stringify(await readTraceDirectory(bundle.directory,ref,maxBytes))),original.allTrace);
const bad=path.join(root,"fault-injection");await linkEvidenceTree(bundle.directory,bad);
await unlink(path.join(bad,firstBlob.path));
await assert.rejects(readTraceDirectory(bad,ref,maxBytes));
await writeFile(path.join(bad,firstBlob.path),"corrupt");
await assert.rejects(readTraceDirectory(bad,ref,maxBytes),/digest|size/i);
await rm(bad,{recursive:true,force:true});
const tamperRef={...ref,manifestPath:"../report.json"};
await assert.rejects(readTraceDirectory(bundle.directory,tamperRef,maxBytes),/reference/);
assert.deepEqual(await readFile(originalPath),originalBytes);
let total=0, files=0, unique=0;const inodes=new Set();
async function walk(dir){for(const name of await readdir(dir)){const p=path.join(dir,name),s=await lstat(p);if(s.isDirectory())await walk(p);else{files++;total+=s.size;const k=s.dev+":"+s.ino;if(!inodes.has(k)){unique+=s.size;inodes.add(k)}}}}
await walk(bundle.directory);
// Viewer uses a reportRoot/runId boundary; link the published Case as a fresh read-only serving tree.
const servingRoot=path.join(root,"viewer");await linkEvidenceTree(bundle.directory,path.join(servingRoot,original.runId));
await mkdir(path.join(root,"records"),{recursive:true});
const viewer=await startViewer({reportRoot:servingRoot,runRoot:path.join(root,"records"),runId:original.runId,port:0});
try {
 for(const route of ["/report","/report-data.js","/"+ref.manifestPath,"/"+firstBlob.path,"/"+ref.outputs[0]]){
  const response=await fetch(viewer.url.replace(/\/$/,"")+route);assert.equal(response.status,200,route);
 }
}finally{await viewer.close();}
await rm(servingRoot,{recursive:true,force:true});
const summary={verification:"REAL_CASE_STORAGE_REPLAY",originalPath,bundle:bundle.directory,judgeInputs:judges,
 originalReportBytes:originalBytes.length,compactReportBytes:Buffer.byteLength(stored),htmlBytes:Buffer.byteLength(html),
 evidenceFiles:manifest.files.length,caseFiles:files,caseBytes:total,uniqueFileBytes:unique,
 checks:{fullTraceRoundTrip:true,sameTraceForAllJudges:true,cssUnchanged:true,noInlineTraceInJsonOrHtml:true,
 relocationAndSourceDeletion:true,hardlinkExport:true,missingEvidenceRejected:true,corruptionRejected:true,
 traversalRejected:true,viewerEvidenceRoutes:true,historicalReportUnchanged:true,modelCalls:0}};
await writeFile(path.join(root,"verification.json"),JSON.stringify(summary,null,2)+"\n");
console.log(JSON.stringify(summary,null,2));
