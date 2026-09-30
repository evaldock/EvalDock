/** Read-only replay of a real DSH archive; verifies v2 semantic compression and references. */
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import path from "node:path";
import {dshSessionsToProbeJsonl,readDshSessionArchive} from "../dist/src/runtime/dsh-session-trace.js";
import {reduceSessionEvents,mergeRemainingStreams} from "../dist/src/agent-trace/native-probe/src/session-events.js";
import {readTraceDirectory} from "../dist/src/all-trace/store.js";
const reportPath=process.argv[2];assert(reportPath,"Supply a real report.json");
const report=JSON.parse(await readFile(reportPath,"utf8"));assert.equal(report.fixture,false);
const trace=await readTraceDirectory(path.dirname(reportPath),report.allTraceRef,268435456);
const root="/Users/dsheval/.dsh/sessions", result=[];
for(const sessionId of report.execution.dshSessionIds){
 let archive;
 for(const dir of await readdir(root)){const p=path.join(root,dir,sessionId,"session.jsonl.zstd");try{await readFile(p);archive=p;break;}catch{}}
 assert(archive,"Original archive is available");
 const input=await readDshSessionArchive(archive,268435456);assert.equal(input.truncated,false);
 const rows=input.jsonl.trim().split("\n").map(JSON.parse).filter(x=>x.type!=="session");
 const expected=mergeRemainingStreams(reduceSessionEvents(rows).records);
 const bytes=dshSessionsToProbeJsonl({sessions:[{sessionId,jsonl:input.jsonl}],sourceRunId:"verify-source",pid:123,
  startedAt:report.execution.startedAt,endedAt:report.execution.endedAt});
 const wire=bytes.toString().trim().split("\n").map(JSON.parse);
 assert.deepEqual(wire[0].captureDiagnostics.issues,[]);
 const events=wire.filter(x=>x.kind==="session/event").map(x=>x.data.event), index=new Map(events.map(e=>[e.seq,e]));
 function decode(value,active=new Set()){
  if(Array.isArray(value))return value.map(x=>decode(x,active));
  if(!value||typeof value!=="object")return value;
  if(value.evidenceRef&&Object.keys(value).length===1){
   const {seq,path:ptr}=value.evidenceRef,key=seq+":"+ptr;assert(!active.has(key),"No cyclic body references");
   let target=index.get(seq);assert(target,"Reference event exists");
   for(const part of ptr.slice(1).split("/"))target=target[part.replaceAll("~1","/").replaceAll("~0","~")];
   assert.notEqual(target,undefined,"Reference points to actual content");
   return decode(target,new Set([...active,key]));
  }
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decode(v,active)]));
 }
 // These real archives contain no heartbeat/empty-message records.
 assert.deepEqual(events.map(e=>decode(e)),expected);
 const counts=type=>events.filter(e=>e.type===type).length;
 result.push({sessionId,archiveRows:rows.length,retainedEvents:events.length,toolCalls:counts("tool/call"),toolResults:counts("tool/result"),
  uncompressedEventBytes:Buffer.byteLength(JSON.stringify(expected)),compactEventBytes:Buffer.byteLength(JSON.stringify(events)),
  fullRoundTrip:true,diagnostics:wire[0].captureDiagnostics.issues});
}
console.log(JSON.stringify({reportPath,oldAgentBytes:Buffer.byteLength(JSON.stringify(trace.entries.filter(e=>e.layer==="AGENT"))),result},null,2));
