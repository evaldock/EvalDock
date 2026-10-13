import {createHash} from 'node:crypto';
import type {AllTrace} from '../../all-trace/types.js';
// Adapter payloads remain heterogeneous; unknown events are retained verbatim.
export type Obj = Record<string, any>;
export const object=(v:unknown):Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{};
export const json=(v:unknown)=>JSON.stringify(v??null);
export function buildTag(trace:AllTrace,task:string,title:string){
 const records=trace.entries, lookup=new Map<string,{record:Obj;event:Obj}>(),gaps:Obj[]=[];
 const duplicateRefs=new Set<string>();
 const native=(r:Obj)=>{const c=object(r.content);return c.data?.event?object(c.data.event):{type:c.kind,data:c.data};};
 const session=(r:Obj)=>String(object(r.content).data?.sessionId??'');
 const key=(r:Obj,id:unknown,s=session(r))=>json([r.sourceId??'',s,id]);
 for(const r of records){const e=native(r);if(e.seq!==undefined){const k=key(r,e.seq);if(lookup.has(k))duplicateRefs.add(k);lookup.set(k,{record:r,event:e});}}
 function resolve(v:any,r:Obj,seen=new Set<string>(),depth=0):any{
  if(depth>50)return {unresolved:'reference-depth-limit'};
  if(Array.isArray(v))return v.map(x=>resolve(x,r,seen,depth+1));
  if(v===null||typeof v!=='object')return v;
  const ref=v.evidenceRef??v.sessionEvidenceRef;
  if(ref){const k=key(r,ref.seq,ref.sessionId??session(r)),marker=k+'|'+ref.path,found=lookup.get(k);
   if(duplicateRefs.has(k)||!found||records.indexOf(found.record as typeof records[number])>records.indexOf(r as typeof records[number])||seen.has(marker)||typeof ref.path!=='string'||!ref.path.startsWith('/')){gaps.push({code:'UNRESOLVED_REFERENCE',recordId:r.id});return {unresolvedReference:ref};}
   let value:any=found.event;for(const part of ref.path.slice(1).split('/')){const p=part.replace(/~1/g,'/').replace(/~0/g,'~');value=value!=null&&Object.hasOwn(value,p)?value[p]:undefined;}
   if(value===undefined){gaps.push({code:'UNRESOLVED_POINTER',recordId:r.id});return {unresolvedReference:ref};}
   return resolve(value,found.record,new Set([...seen,marker]),depth+1);
  }
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x,r,seen,depth+1)]));
 }
 const nodes:Obj[]=[],edges:Obj[]=[],calls=new Map<string,Obj[]>(),returns:Obj[]=[];
 const edge=(type:string,a:Obj,b:Obj,extra:Obj={})=>edges.push({id:'edge'+(edges.length+1),source:a.id,target:b.id,type,evidenceStatus:'direct',sourceRefs:[...a.sourceRefs,...b.sourceRefs],...extra});
 for(const [i,r] of records.entries()){
  const ev=native(r),d=object(resolve(ev.data??{},r)),ty=String(ev.type??object(r.content).kind??r.layer),args=typeof d.arguments==='string'?(()=>{try{return JSON.parse(d.arguments)}catch{return d.arguments}})():d.arguments??{};
  const blocks=object(d.message).content,block=Array.isArray(blocks)?blocks.find((x:Obj)=>x.type==='tool-result'):null;
  const cid=d.callId??block?.toolCallId??object(d.message).source?.callId;
  let result=d.result??(block?{output:(block.content??[]).filter((x:Obj)=>x.type==='text').map((x:Obj)=>x.text).join('\n')}:d);
  if(typeof result==='string'){try{result=JSON.parse(result)}catch{result={output:result}}}
  const subtype=ty==='tool/call'?'action':ty==='tool/result'?'observation':/^(assistant|user)\/message$/.test(ty)?'message':r.layer==='ENVIRONMENT'?'environment':/completion|turn\/end/.test(ty)?'completion':'unknown';
  const detail=subtype==='action'?json(args):subtype==='observation'?json(result):json(d.message??r.content);
  const n:Obj={id:'e'+(i+1),kind:'event',subtype,recordId:r.id,index:i+1,eventType:ty,label:ty,tool:d.name??'',arguments:args,result,detail,at:object(r.content).at??null,raw:r,nativeStep:d.step??null,nativeTurn:d.turn??null,sessionId:session(r),sourceId:r.sourceId??'',isError:!!(d.isError||block?.isError),auxiliary:subtype==='unknown',sourceRefs:[{file:'data/trace.json',pointer:'/entries/'+i,recordId:r.id}]};
  if(subtype==='message')n.label=ty==='assistant/message'?'Agent 消息':'用户消息';
  nodes.push(n);if(i)edge('CAPTURE_NEXT',nodes[i-1]!,n);
  if(cid!==undefined){n.callId=cid;if(subtype==='action'){const k=key(r,cid);calls.set(k,[...(calls.get(k)??[]),n]);}else if(subtype==='observation')returns.push(n);}
 }
 // Exact native ID and source/session only. Ambiguous/reused IDs stay unpaired.
 for(const n of returns){const matches=calls.get(key(n.raw,n.callId))??[];if(matches.length===1&&returns.filter(r=>key(r.raw,r.callId)===key(n.raw,n.callId)).length===1&&matches[0]!.index<n.index){const a=matches[0]!;n.tool ||= a.tool;n.pairEvidenceStatus='direct';a.resultEventId=n.id;edge('CALL_RESULT',a,n);}else gaps.push({code:'UNPAIRED_RETURN',recordId:n.recordId});}
 const resources=new Map<string,Obj>();
 function resource(p:string,n:Obj){let r=resources.get(p);if(!r){r={id:'r:'+createHash('sha256').update(p).digest('hex').slice(0,16),kind:'resource',path:p,label:p,sourceRefs:n.sourceRefs};resources.set(p,r);nodes.push(r);}return r;}
 for(const n of [...nodes]){if(n.subtype==='action'){const a=object(n.arguments),p=a.file_path??a.path;if(typeof p==='string'&&p.length<4096){const r=resource(p,n);edge('TARGETS',n,r,{operation:/edit|patch/.test(n.tool)?'patch':/write/.test(n.tool)?'write':/read/.test(n.tool)?'read':'reference'});}}
  if(n.raw?.layer==='ENVIRONMENT'){
   n.label='环境观测';const c=object(n.raw.content);
   for(const [i,change] of (Array.isArray(c.changes)?c.changes:[]).entries()){
    const p=change.path??change.portablePath??change.value?.portablePath;if(typeof p!=='string'||(change.component&&change.component!=='filesystem'))continue;
    const r=resource(p,n),s:Obj={id:'env:'+n.id+':'+i,kind:'state',resourceId:r.id,path:p,index:n.index,metadata:change,observationKind:'environment',sourceRefs:n.sourceRefs};nodes.push(s);edge('OBSERVES',n,s);edge('STATE_OF',s,r);
   }
  }
  if(n.raw?.layer==='DELIVERY'&&!n.raw.content.portablePath){n.label='最终回复';n.subtype='completion';n.detail=json(n.raw.content);}
  if(n.raw?.layer==='DELIVERY'){const c=object(n.raw.content);if(typeof c.portablePath==='string'){
   n.subtype='observation';n.label='归档文件';n.observationKind='archive';const r=resource(c.portablePath,n);
   const s:Obj={id:'s:'+n.id,kind:'state',resourceId:r.id,path:c.portablePath,index:n.index,observationKind:'archive',byteLength:c.byteLength,representation:c.representation,contentRestricted:c.contentRestricted,contentTruncated:c.contentTruncated,metadata:{evaluationScope:c.evaluationScope,archiveStatus:c.archiveStatus},sourceRefs:n.sourceRefs};
   if(!c.contentRestricted&&!c.contentTruncated&&c.representation==='TEXT'&&typeof c.content==='string'){s.content=c.content;if(Buffer.byteLength(c.content)===c.byteLength)s.hash=createHash('sha256').update(c.content).digest('hex');}
   nodes.push(s);n.stateIds=[s.id];edge('OBSERVES',n,s);edge('STATE_OF',s,r);
  }}
 }
 const items:Obj[]=[],frames:Obj[]=[],histories=new Map<string,string[]>();
 const cats:Obj={'system/message':'system','user/message':'user','assistant/message':'assistant','tool/result':'tool','request/header':'definitions'};
 for(const n of nodes.filter(n=>n.kind==='event')){const d=object(resolve(native(n.raw).data??{},n.raw)),sk=json([n.sourceId,n.sessionId]),history=histories.get(sk)??[];
  if(n.eventType==='assistant/message'){const u=object(d.usage),known=[u.inputTokens,u.cacheReadTokens,u.outputTokens,u.totalTokens].every(x=>typeof x==='number'&&x>=0)&&u.inputTokens+u.cacheReadTokens+u.outputTokens===u.totalTokens;
   const content=object(d.message).content;const ids=new Set((Array.isArray(content)?content:[]).filter((x:Obj)=>x.type==='tool-call').map((x:Obj)=>x.id));
   const prior=frames.filter(f=>f.sessionKey===sk).at(-1);
   frames.push({id:frames.length+1,step:frames.length+1,nodeId:n.id,recordIndex:n.index,sessionKey:sk,usage:known?u:null,inputTotal:known?u.inputTokens+u.cacheReadTokens:null,historyIds:[...history],newHistoryIds:history.filter(id=>!prior?.historyIds.includes(id)),actionIds:nodes.filter(a=>a.subtype==='action'&&a.sessionId===n.sessionId&&a.sourceId===n.sourceId&&ids.has(a.callId)).map(a=>a.id),fullRequestCaptured:false,removed:null,compressed:null,sourcePointer:'/entries/'+(n.index-1)+'/content/data/event/data/usage'});
  }
  if(cats[n.eventType]){const v=n.eventType==='request/header'?object(d.header).tools??[]:object(d.message).content??d.message??d;const content=JSON.stringify(v,null,2);items.push({id:n.id,recordId:n.recordId,recordIndex:n.index,category:cats[n.eventType],chars:content.length,content,eventType:n.eventType,sourcePointer:'/entries/'+(n.index-1)});history.push(n.id);histories.set(sk,history);}
 }
 const graph:Obj={schema:'evaldock.tag/v1',meta:{title,task,displayCase:title,recordCount:records.length,traceDigest:trace.contentDigest,coverage:trace.coverage,sources:trace.sources,llmInFactProjection:false,evidenceBase:'data/'},nodes,edges,records,assessments:[],reportAssessments:[],gaps,presentation:{grouping:'records'},scoring:{rubricVersion:'tag-five-dim/3.1-mvp',review:{} }};
 return {graph,context:{schema:'evaldock.context-replay/v1',frames,items,fullRequestCaptured:false}};
}
