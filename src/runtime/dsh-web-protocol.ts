/** Known DSH Web wire protocols, selected by a read-only interface probe. */
import {randomUUID} from "node:crypto";
import {WebSocket} from "undici";
import {webFetch,webAuthHeaders,localWebOrigin} from "./web-auth.js";
type Obj=Record<string,any>;
export type WebProtocol="legacy"|"remote";
const protocols=new Map<string,WebProtocol>();
export async function wireRpc(base:string,method:string,payload:Obj,signal?:AbortSignal):Promise<any>{
 const response=await webFetch(base,"/api/"+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:randomUUID(),method,payload}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 if(!response.ok){await response.body?.cancel();throw Error(response.status===404?"DSH_WEB_INTERFACE_CHANGED":"DSH_WEB_HTTP_"+response.status);}
 const data=await response.json() as Obj;
 if(data.result?.ok!==true)throw Error("DSH_WEB_RPC_FAILED");
 return data.result.value;
}
export async function detectWebProtocol(base:string,signal?:AbortSignal,refresh=false):Promise<WebProtocol>{
 base=localWebOrigin(base);
 if(!refresh&&protocols.has(base))return protocols.get(base)!;
 protocols.delete(base);
 try{
  const list=await wireRpc(base,"session.list",{},signal);
  if(!Array.isArray(list?.items))throw Error("DSH_SESSION_STATE_UNKNOWN");
  protocols.set(base,"legacy");return "legacy";
 }catch(error){if(!(error instanceof Error)||error.message!=="DSH_WEB_INTERFACE_CHANGED")throw error;}
 const list=await wireRpc(base,"session/list",{args:{_request:{}}},signal);
 if(!Array.isArray(list?.items))throw Error("DSH_SESSION_STATE_UNKNOWN");
 protocols.set(base,"remote");return "remote";
}
/** Returning true consumes one snapshot and closes the owned stream. */
export function consumeRemoteStream(base:string,endpoint:string,args:Obj,signal:AbortSignal,onItem:(item:Obj)=>Promise<boolean|void>):Promise<void>{
 signal.throwIfAborted();const origin=localWebOrigin(base),streamId=randomUUID();
 return new Promise((resolve,reject)=>{
  const socket=new WebSocket(origin.replace(/^http:/,"ws:")+"/api/remote.mux",{headers:webAuthHeaders(origin)});
  let settled=false,queued=0,pending=Promise.resolve();
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener("abort",abort);try{socket.close();}catch{}if(error)reject(error);else resolve();};
  const abort=()=>finish();
  const timer=setTimeout(()=>finish(Error("DSH_REMOTE_STREAM_CONNECT_TIMEOUT")),15000);
  signal.addEventListener("abort",abort,{once:true});if(signal.aborted){finish();return;}
  socket.addEventListener("open",()=>{if(!settled)socket.send(JSON.stringify({type:"open",streamId,endpoint,payload:{args}}));});
  socket.addEventListener("error",()=>finish(Error("DSH_REMOTE_STREAM_ERROR")));
  socket.addEventListener("close",()=>finish(signal.aborted?undefined:Error("DSH_REMOTE_STREAM_CLOSED")));
  socket.addEventListener("message",event=>{
   if(settled)return;
   if(typeof event.data!=="string"){finish(Error("DSH_REMOTE_FRAME_INVALID"));return;}
   const raw=event.data,bytes=Buffer.byteLength(raw);queued+=bytes;
   if(queued>8*1024*1024){finish(Error("DSH_REMOTE_FRAME_TOO_LARGE"));return;}
   pending=pending.then(async()=>{
    if(settled)return;const frame=JSON.parse(raw) as Obj;
    if(frame.streamId!==streamId)throw Error("DSH_REMOTE_STREAM_ID_MISMATCH");
    if(frame.type!=="item"||!frame.value||typeof frame.value!=="object")throw Error("DSH_REMOTE_STREAM_FAILED");
    clearTimeout(timer);
    if(await onItem(frame.value))finish();queued-=bytes;
   });
   void pending.catch(()=>finish(Error("DSH_REMOTE_FRAME_INVALID")));
  });
 });
}
async function firstItem(base:string,endpoint:string,args:Obj,signal?:AbortSignal):Promise<Obj>{
 let value:Obj|undefined;
 const timeout=AbortSignal.timeout(20000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 await consumeRemoteStream(base,endpoint,args,combined,async item=>{value=item;return true;});
 if(!value)throw Error("DSH_REMOTE_SNAPSHOT_UNAVAILABLE");return value;
}
export async function dshRpc(base:string,method:string,payload:Obj={},signal?:AbortSignal):Promise<any>{
 if(await detectWebProtocol(base,signal)==="legacy")return wireRpc(base,method,payload,signal);
 if(method==="host.describe"){
  const frame=await firstItem(base,"$events",{},signal);
  if(frame.type!=="ready"||typeof frame.host?.home!=="string")throw Error("DSH_REMOTE_HOST_INVALID");return frame.host;
 }
 if(method==="session.history"){
  const frame=await firstItem(base,"session/follow",{request:{address:{kind:"session",sessionId:payload.sessionId},maxMessages:payload.maxMessages??200}},signal);
  if(frame.type!=="snapshot"||frame.header?.id!==payload.sessionId||!Array.isArray(frame.records))throw Error("DSH_REMOTE_SESSION_MISMATCH");
  return {events:frame.records,projections:frame.projections};
 }
 if(method==="session.prompt")return wireRpc(base,"session/prompt",{args:{request:{...payload,requestId:randomUUID()}}},signal);
 if(method==="session.list")return wireRpc(base,"session/list",{args:{_request:payload}},signal);
 if(["session.create","session.rename","session.cancel"].includes(method))return wireRpc(base,method.replace(".","/"),{args:{request:payload}},signal);
 if(method==="settings.describe")return wireRpc(base,"settings/describe",{args:{}},signal);
 throw Error("DSH_WEB_METHOD_UNSUPPORTED");
}
export async function setSessionPermission(base:string,sessionId:string,signal?:AbortSignal):Promise<void>{
 if(await detectWebProtocol(base,signal)==="legacy"){
  const r=await wireRpc(base,"session.prompt",{sessionId,mode:"steer",content:[{type:"text",text:"/permission danger-full-access"}]},signal);
  if(r.command?.kind!=="success")throw Error("DSH_AUTO_PERMISSION_NOT_APPLIED");
 }else{
  const r=await wireRpc(base,"commands/execute",{args:{agentId:sessionId,line:"/permission danger-full-access",submittedAttachments:[]}},signal);
  if(r?.result?.kind!=="success")throw Error("DSH_AUTO_PERMISSION_NOT_APPLIED");
 }
}
