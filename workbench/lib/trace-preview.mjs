import {projectPaths} from './paths.mjs';
import path from 'node:path';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readTraceDirectory} from '../../dist/src/all-trace/store.js';
import {toolAttribution} from '../../dist/src/reporting/tool-attribution.js';
import {projectTraceOverview} from '../../dist/src/reporting/trace-overview.js';
const cache=new Map();
const preview=(v,limit=10000)=>{const s=typeof v==='string'?v:JSON.stringify(v,null,2);return s===undefined?null:s.length>limit?s.slice(0,limit)+'\n…（预览已截断，完整内容见报告）':s;};
export function requestTools(trace,inspection={}){
 const tools=new Map();
 for(const e of trace.entries??[]){
  if(e.layer!=='AGENT')continue;
  const event=e.content?.data?.event;
  if(event?.type!=='request/header')continue;
  for(const t of Array.isArray(event.data?.header?.tools)?event.data.header.tools:[]){
   const tool=t.function??t;if(typeof tool.name!=='string')continue;
   tools.set(tool.name,{name:tool.name,description:preview(tool.description??'',4000),parameters:preview(tool.parameters,12000),source:'request/header',attribution:toolAttribution(tool.name,inspection.toolSchemas??[])});
  }
 }
 return [...tools.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
export function projectRuntime(trace,ref,inspection={}){
 const v=projectTraceOverview(trace);
 const toolCalls=v.tools.slice(0,500).map(t=>({at:t.at,callId:t.callId,sessionId:t.session,toolName:t.name,argumentsCaptured:preview(t.arguments),result:preview(t.result),status:t.status,attribution:toolAttribution(t.name,inspection.toolSchemas??[]),completed:t.status==='COMPLETED'?true:t.status==='ERROR'?false:null}));
 return {trace:{eventCount:v.events,eventTypeCounts:Object.entries(v.types).map(([type,count])=>({type,count})),sessionIds:v.sessions,model:v.models.join(' · '),provider:v.providers.join(' · '),usage:{inputTokens:v.usage.input,outputTokens:v.usage.output,reasoningTokens:v.usage.reasoning,cacheReadTokens:v.usage.cacheRead},pluginToolCallCount:v.tools.filter(t=>toolAttribution(t.name,inspection.toolSchemas??[]).kind==='TESTED_PLUGIN').length,toolCallCount:v.tools.length,toolCalls,truncated:v.tools.length>toolCalls.length,source:'all-trace/manifest.json',verified:true,traceId:ref.traceId,manifestDigest:ref.manifestDigest.value},allTraceEntryCount:ref.entryCount,toolDeclarations:requestTools(trace,inspection),environmentSummary:trace.entries.find(e=>e.layer==='ENVIRONMENT')?.content??null,observationSources:(trace.sources??[]).map(s=>({id:s.sourceId,type:s.sourceType,trust:s.trust,collector:s.collectorName,version:s.collectorVersion,contentMode:s.contentMode}))};
}
export async function archivedRuntime(root,caseDirectory,report){
 const ref=report.allTraceRef;
 if(!ref)return {traceLoadState:'missing'};
 const key='plugin-attribution-v1:'+ref.manifestDigest.value+':'+caseDirectory+':'+createHash('sha256').update(JSON.stringify(report.inspection?.toolSchemas??[])).digest('hex');
 const existing=cache.get(key);if(existing&&(!existing.failedAt||Date.now()-existing.failedAt<30000))return existing.value;
 try{
  const trace=await readTraceDirectory(caseDirectory,ref,64*1024*1024);
  const detail=projectRuntime(trace,ref,report.inspection);
  const filename=createHash('sha256').update(key).digest('hex')+'.json';
  const relative='runtime-details/'+filename,dir=path.join(projectPaths(root).workbench,'cache/runtime-details');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,filename+'.tmp'),JSON.stringify(detail));await rename(path.join(dir,filename+'.tmp'),path.join(dir,filename));
  const value={traceLoadState:'available',traceDetailPath:relative,trace:{...detail.trace,toolCalls:[]},allTraceEntryCount:detail.allTraceEntryCount,toolDeclarations:detail.toolDeclarations};
  cache.set(key,{value});if(cache.size>256)cache.delete(cache.keys().next().value);return value;
 }catch(error){const value={traceLoadState:'error',traceError:String(error.message).slice(0,200),allTraceEntryCount:ref.entryCount};cache.set(key,{value,failedAt:Date.now()});return value;}
}
