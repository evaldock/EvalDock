import path from 'node:path';
import {mkdir,writeFile,readdir,lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {digestValue,digestBytes,validatePortablePath} from '../../dist/src/core/models.js';
import {assembleAllTrace} from '../../dist/src/all-trace/assemble.js';
import {submissionContent,submissionIndex} from '../../dist/src/all-trace/submission.js';
import {createSessionEvidenceCompactor} from '../../src/agent-trace/native-probe/lib/evidence-events.js';
export const TRACE_MAX_BYTES=1024*1024;
const stamp=()=>new Date().toISOString();
async function boundedRead(handle){const buf=Buffer.alloc(256*1024+1);let offset=0;while(offset<buf.length){const {bytesRead}=await handle.read(buf,offset,buf.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}if(offset>256*1024)throw new Error('AGENT_UNSTABLE_OUTPUT');return buf.subarray(0,offset);}

export const seal=v=>({...v,contentDigest:digestValue(v)});
export async function seedWorkspace(root,entries){
  await mkdir(root,{recursive:true,mode:0o700});if(await realpath(root)!==root)throw new Error('AGENT_UNSAFE_WORKSPACE');
  for(const e of entries){validatePortablePath(e.portablePath);const dest=path.join(root,e.portablePath);
    if(e.entryType==='DIRECTORY'){await mkdir(dest,{recursive:true,mode:0o700});continue;}
    if(e.entryType!=='FILE'||e.encoding!=='base64')throw new Error('AGENT_UNSUPPORTED_INPUT');
    await mkdir(path.dirname(dest),{recursive:true,mode:0o700});await writeFile(dest,Buffer.from(e.content,'base64'),{flag:'wx',mode:0o444});
  }
}
export async function snapshot(root){
  const entries=[];let truncated=false;
  const walk=async(relative='',depth=0)=>{if(depth>12){truncated=true;return;}
    const dir=await open(path.join(root,relative),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{if(!(await dir.stat()).isDirectory())throw new Error('AGENT_UNSAFE_WORKSPACE');
      // Dirents never follow symlinks. Canonicalize every descent as the target shares this UID.
      if(await realpath(path.join(root,relative))!==path.join(root,relative))throw new Error('AGENT_UNSAFE_WORKSPACE');
      for(const e of (await readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        if(entries.length>=400){truncated=true;return;}
        const portablePath=relative?relative+'/'+e.name:e.name,full=path.join(root,portablePath),s=await lstat(full);
        if(s.isFile()&&s.size>256*1024)truncated=true;
        if(e.isDirectory()&&!s.isSymbolicLink()){await walk(portablePath,depth+1);continue;}
        let hash=null;if(s.isFile()&&s.size<=256*1024){const h=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);try{const current=await h.stat();if(!current.isFile()||current.ino!==s.ino)throw new Error('AGENT_UNSTABLE_OUTPUT');hash=digestBytes(await boundedRead(h)).value;}finally{await h.close();}}
        entries.push({portablePath,entryType:s.isSymbolicLink()?'SYMLINK':s.isFile()?'FILE':'OTHER',byteLength:s.size,mtimeMs:s.mtimeMs,hash});
      }
    }finally{await dir.close();}
  };await walk();return {entries,truncated};
}
export async function collectFiles(root,after,allowedPaths,scope){
  const files=[],artifacts=[],bodies=new Map();let budget=192*1024;
  for(const e of after.entries){if(e.entryType!=='FILE'||!allowedPaths.some(p=>e.portablePath===p||e.portablePath.startsWith(p+'/')))continue;
    if(files.length>=80)break;validatePortablePath(e.portablePath);
    let bytes;if(e.byteLength<=256*1024){const full=path.join(root,e.portablePath);if(await realpath(full)!==full)throw new Error('AGENT_UNSAFE_OUTPUT');const h=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await h.stat();if(!s.isFile()||s.size>256*1024)throw new Error('AGENT_UNSTABLE_OUTPUT');bytes=await boundedRead(h);if(bytes.length>256*1024||digestBytes(bytes).value!==e.hash)throw new Error('AGENT_UNSTABLE_OUTPUT');}finally{await h.close();}}
    const content=bytes?submissionContent(bytes,e.portablePath,budget,false):submissionIndex('FILE_TOO_LARGE');budget-=content.consumedBytes;
    const {consumedBytes,...view}=content;let ref;
    if(bytes){const artifact=makeArtifact(scope,'file-'+files.length,e.portablePath,bytes);artifacts.push(artifact);bodies.set(artifact.artifactId,bytes);ref={schema:artifact.schema,id:artifact.artifactId,digest:artifact.contentDigest};}
    files.push({...e,mediaType:'application/octet-stream',...view,...ref?{artifactRef:ref}:{},contentRestricted:false,archiveStatus:bytes?'ARCHIVED':'NOT_ARCHIVED'});
  }
  return {files,artifacts,bodies};
}
function makeArtifact(scope,id,portablePath,bytes){return seal({schema:'evaldock.mvp.artifact/v1',scope,createdAt:stamp(),producerVersion:'evaldock-agent-adapter/1',artifactId:id,artifactType:'DELIVERY',logicalName:portablePath,mediaType:'application/octet-stream',portablePath,byteLength:bytes.length,artifactContentDigest:digestBytes(bytes),sensitivity:'EXPORTABLE',redactionState:'NOT_REQUIRED',state:'COMMITTED'});}
export function buildTrace({scope,capture,before,after,delivery,startedAt,endedAt,agent}){
  const common={scope,createdAt:endedAt,producerVersion:'evaldock-agent-adapter/1'};
  const source=(id,type,blind)=>seal({...common,schema:'evaldock.mvp.source/v1',sourceId:id,sourceType:type,externalSchema:type===agent.sourceType?agent.externalSchema:'evaldock.filesystem-snapshot/v1',collectorName:agent.kind,collectorVersion:'1',collectorCapabilityDigest:digestValue({type}),trust:type==='FILESYSTEM'?'INDEPENDENT':'COOPERATIVE',resourceBinding:capture.sessionId??scope.attemptId,sequenceMode:'CAPTURE_ORDER',watermarkDefinition:'Observed task events; internal reasoning and unexposed events are not inferred',contentMode:'BOUNDED',knownBlindSpots:blind});
  const agentSource=source(agent.kind+'-probe',agent.sourceType,agent.blindSpots);
  const fs=source(agent.kind+'-files','FILESYSTEM',['WORKSPACE_ONLY','TRANSIENT_CHANGES_NOT_OBSERVED']);
  const ref=s=>({schema:s.schema,id:s.sourceId,digest:s.contentDigest});
  const observation=(s,payload,n)=>seal({...common,schema:'evaldock.mvp.raw-observation/v1',observationId:'observation.'+s.sourceId+'.'+n,attemptId:scope.attemptId,sourceRef:ref(s),externalEventType:'CAPTURE',sourceTime:{observedAt:endedAt,clockDomain:"evaldock-host",sourceSeq:n},captureMetadata:{lineNumber:n},rawDigest:digestValue(payload),payloadInline:payload});
  const contents=(capture.queue??[]).map((r,i)=>agent.normalizeEvent(r,capture.sessionId,i+1));
  contents.push({at:endedAt,kind:agent.kind+'/events',data:{sessionId:capture.sessionId,event:{type:'session/completion',data:{stopReason:capture.result?.stopReason??null,error:capture.error??null,finalResponseEntryId:'trace.'+scope.attemptId+'.final-response',usage:capture.result?.usage??null}}}});
  const prior=new Map(before.entries.map(x=>[x.portablePath,x])),post=new Map(after.entries.map(x=>[x.portablePath,x]));
  const changes=[...post.values()].filter(x=>JSON.stringify(x)!==JSON.stringify(prior.get(x.portablePath))).map(x=>({op:prior.has(x.portablePath)?'MODIFY':'ADD',value:x}));
  for(const x of prior.values())if(!post.has(x.portablePath))changes.push({op:'REMOVE',value:x});
  const finalBytes=Buffer.from(capture.final??''),artifact=makeArtifact(scope,'final-response','final-response.txt',finalBytes);
  delivery.artifacts.push(artifact);delivery.bodies.set(artifact.artifactId,finalBytes);
  const coverage=(s,partial,count,truncated,extra={})=>seal({...common,schema:'evaldock.mvp.collection-status/v1',collectionStatusId:'coverage.'+s.sourceId,sourceRef:ref(s),openedAt:startedAt,closedAt:endedAt,recordCount:count,finalWatermark:extra,gaps:partial?[{kind:'LIMITATION',reasonCode:'PARTIAL_OBSERVABILITY'}]:[],truncated,health:capture.error?'DEGRADED':'HEALTHY',completeness:partial?'PARTIAL':'COMPLETE',failureRefs:[]});
  let dropped=0;
  while(true){
    // Rebuild references after pruning so every reference targets retained evidence.
    const compactor=createSessionEvidenceCompactor();
    const retained=contents.map((p,i)=>({...p,data:{...p.data,event:compactor.accept({...p.data.event,seq:i+1})}}));
    const trace=assembleAllTrace({traceId:'trace.'+scope.attemptId,...common,agentSourceTypes:[agent.sourceType],agentObservations:retained.map((p,i)=>observation(agentSource,p,i+1)),environmentChanges:[observation(fs,{changes},1)],sources:[agentSource,fs],coverage:[coverage(agentSource,true,contents.length,!!(capture.omitted||capture.clipped||capture.finalTruncated||dropped),{captureMode:'EVENT_PUSH',receivedEvents:capture.seen??0,noiseEvents:capture.noise??0,duplicateEvents:capture.duplicates??0,mergedToolUpdates:capture.mergedUpdates??0,reusedBodies:compactor.stats.reusedBodies,omittedEvents:capture.omitted??0,clippedEvents:capture.clipped??0,budgetDroppedEvents:dropped,stopReason:capture.result?.stopReason??null}),coverage(fs,before.truncated||after.truncated,after.entries.length,after.truncated)],artifacts:delivery.artifacts,finalResponse:{content:capture.final??'',artifactRef:{schema:artifact.schema,id:artifact.artifactId,digest:artifact.contentDigest},capturedBytes:finalBytes.length,captureTruncated:!!capture.finalTruncated,contentTruncated:!!capture.finalTruncated,contentRestricted:false,completedAt:endedAt},files:delivery.files});
    if(Buffer.byteLength(JSON.stringify(trace))<=TRACE_MAX_BYTES)return trace;
    if(!contents.length)throw new Error('AGENT_TRACE_METADATA_TOO_LARGE');const count=Math.max(1,Math.ceil(contents.length/4));contents.splice(0,count);dropped+=count;
  }
}
