import {consumeRemoteStream,wireRpc} from "./dsh-web-protocol.js";
import {WebSocket} from "undici";
import {webFetch,webAuthHeaders} from "./web-auth.js";
/** Unattended DSH interaction adapter. Uses the real server's answer protocol, not UI clicks. */
import { setTimeout as delay } from "node:timers/promises";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
export interface AutoAnswer { id: string; selected: string[]; custom?: string; }
export const AUTONOMOUS_DECISION = "这是无人值守任务。请根据原始任务目标、已有上下文和你的专业判断自主选择最合适的方案并继续执行，无需再次询问用户。优先满足原任务约束，不扩大任务范围；无法推断的真实信息应明确记录为缺失，不要编造。";

/** A recommended answer is the Agent's own recommendation. No external solver sees Case answers. */
export function chooseAutomaticAnswers(questions: unknown): AutoAnswer[] {
  if(!Array.isArray(questions) || questions.length === 0) throw new Error("DSH_AUTO_QUESTION_INVALID");
  return questions.map(value => {
    const q = obj(value);
    if(typeof q.id !== "string" || !q.id) throw new Error("DSH_AUTO_QUESTION_ID_INVALID");
    const options = Array.isArray(q.options) ? q.options.map(obj).filter(o => typeof o.label === "string") : [];
    const intent = obj(q.intent);
    const recommended = options.filter(o => /(?:\(recommended\)|（recommended）|\(推荐\)|（推荐）|\(建议\)|（建议）)$/iu.test(String(o.label).trim()));
    let selected: string[] = [];
    if(typeof intent.approve === "string" && options.some(o=>o.label===intent.approve)) selected = [intent.approve];
    else if(recommended.length === 1 || q.multiSelect === true && recommended.length > 0) selected = recommended.map(o=>String(o.label));
    else if(options.length === 1) selected = [String(options[0]!.label)];
    return selected.length ? {id:q.id,selected} : {id:q.id,selected:[],custom:AUTONOMOUS_DECISION};
  });
}

export function automaticResponse(frame: unknown, sessionId?: string): Obj | undefined {
  const f = obj(frame), p = obj(f.payload);
  if(typeof f.rpcId !== "string" || typeof p.sessionId !== "string" || sessionId && p.sessionId !== sessionId) return;
  let value: Obj;
  if(p.type === "approval/requested") {
    if(typeof p.approvalId !== "string") throw new Error("DSH_AUTO_APPROVAL_ID_INVALID");
    value = {sessionId:p.sessionId,approvalId:p.approvalId,outcome:"allowed-once"};
  } else if(p.type === "question/requested") {
    value = {sessionId:p.sessionId,answer:{answers:chooseAutomaticAnswers(p.questions)}};
  } else return;
  return {type:"client-response",rpcId:f.rpcId,result:{ok:true,value}};
}

/** New Remote waterfalls return only the native answer value, scoped to the owned session. */
export function remoteAutomaticResponse(frame:Obj,clientId:string,sessionId?:string):Obj|undefined {
 if(frame.type!=="waterfall")return;
 if(typeof frame.eventId!=="string"||typeof frame.agentId!=="string"||!clientId)throw Error("DSH_REMOTE_EVENT_INVALID");
 let outcome:Obj={kind:"next"};
 if(!sessionId||frame.agentId===sessionId){
  if(frame.event==="approval/request")outcome={kind:"result",value:"allowed-once"};
  else if(frame.event==="user-questions/request")outcome={kind:"result",value:{answers:chooseAutomaticAnswers(obj(frame.request).questions)}};
 }
 return {clientId,eventId:frame.eventId,outcome};
}

export interface AutoInteractionOptions {
  base: string;
  /** Case adapter only answers its own Session. The dedicated VM service covers this DSH as a whole. */
  sessionId?: string;
  signal?: AbortSignal;
  beforeConnect?: () => Promise<void>;
  onDecision?: (record: Obj) => void;
  onError?: (error: unknown) => void;
}
export function startAutoInteraction(options: AutoInteractionOptions): {
  ready: Promise<void>; done: Promise<void>; stop: () => Promise<void>;
} {
  const url = new URL(options.base);
  if(url.protocol !== "http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("DSH_AUTO_ENDPOINT_NOT_LOCAL");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal;
  let opened = false;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve,reject) => {resolveReady=resolve;rejectReady=reject;});
  // The daemon may rely on done rather than await ready. Still surface rejection to ready callers.
  void ready.catch(()=>{});
  const handled = new Set<string>();
  const processFrame=async(frame:Obj)=>{
  const reply=automaticResponse(frame,options.sessionId);
  if(!reply || handled.has(String(reply.rpcId)))return;
  const answer=await webFetch(url.origin,"/api/respond",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify(reply),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
  if(!answer.ok)throw new Error("DSH_AUTO_RESPONSE_HTTP_"+answer.status);
  const receipt=await answer.json() as Obj;
  if(receipt.accepted !== true && receipt.reason !== "not-pending")throw new Error("DSH_AUTO_RESPONSE_REJECTED");
  handled.add(String(reply.rpcId));
  if(handled.size>10000)handled.delete(handled.values().next().value!);
  if(receipt.accepted === true)options.onDecision?.({
    at:new Date().toISOString(),rpcId:reply.rpcId,type:obj(frame.payload).type,
    ...obj(obj(reply.result).value),source:"EVALDOCK_AUTOMATIC_USER_POLICY"
  });
  };
  let websocket=false,remote=false;
  const done = (async()=>{
    while(!signal.aborted) {
      try {
        await options.beforeConnect?.();
        if(remote){
          let clientId="";
          await consumeRemoteStream(url.origin,"$events",{},signal,async frame=>{
            if(frame.type==="ready"){
              if(typeof frame.clientId!=="string"||!frame.clientId)throw Error("DSH_REMOTE_EVENT_INVALID");
              clientId=frame.clientId;if(!opened){opened=true;resolveReady();}return;
            }
            const reply=remoteAutomaticResponse(frame,clientId,options.sessionId);
            if(!reply)return;
            await wireRpc(url.origin,"$events/result",{args:reply},signal);
            if(obj(reply.outcome).kind==="result")options.onDecision?.({at:new Date().toISOString(),type:frame.event,sessionId:frame.agentId,source:"EVALDOCK_AUTOMATIC_USER_POLICY"});
          });
          continue;
        }
        if(websocket){
          await consumeWebSocket(url.origin.replace(/^http/,"ws")+"/api/events.mux",signal,()=>{
            if(!opened){opened=true;resolveReady();}
          },processFrame);
          continue;
        }
        const connect = new AbortController();
        const timer = setTimeout(()=>connect.abort(),15000);
        let response: Response;
        try { response = await webFetch(url.origin,"/api/events.mux",{signal:AbortSignal.any([signal,connect.signal])}); }
        finally { clearTimeout(timer); }
        if(response.status===404){await response.body?.cancel();remote=true;continue;}
        if(response.status===426){
          await response.body?.cancel();websocket=true;continue;
        }
        if(!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
          throw new Error("DSH_AUTO_STREAM_HTTP_"+response.status);
        // Reconnecting replays still-pending questions and approvals.
        if(!opened){opened=true;resolveReady();}
        const reader = response.body.getReader(),decoder = new TextDecoder();
        let buffer = "";
        try {
          while(!signal.aborted) {
            const next = await reader.read();if(next.done)break;
            buffer += decoder.decode(next.value,{stream:true});
            if(buffer.length > 8*1024*1024)throw new Error("DSH_AUTO_FRAME_TOO_LARGE");
            let boundary: number;
            while((boundary=buffer.indexOf("\n\n"))>=0) {
              const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
              const raw=block.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
              if(!raw)continue;
              await processFrame(JSON.parse(raw) as Obj);
            }
          }
        } finally {await reader.cancel().catch(()=>{});}
      } catch(error) {
        if(signal.aborted)break;
        options.onError?.(error);
      }
      if(!signal.aborted)await delay(1000,undefined,{signal}).catch(()=>{});
    }
    if(!opened)rejectReady(new Error("DSH_AUTO_STOPPED_BEFORE_CONNECT"));
  })();
  return {ready,done,stop:async()=>{controller.abort();await done;}};
}


/** Current DSH serves event downlinks over WebSocket; answers still use POST /api/respond. */
export function consumeWebSocket(url:string,signal:AbortSignal,onReady:()=>void,onFrame:(frame:Obj)=>Promise<void>):Promise<void>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{headers:webAuthHeaders(new URL(url).origin.replace(/^ws:/,"http:"))});
    let settled=false,queued=0;
    let pending=Promise.resolve();
    const finish=(error?:Error)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener("abort",abort);
      try{socket.close();}catch{}
      if(error)reject(error);else resolve();
    };
    const abort=()=>finish();
    const timer=setTimeout(()=>finish(new Error("DSH_AUTO_WEBSOCKET_CONNECT_TIMEOUT")),15000);
    signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted){finish();return;}
    socket.addEventListener("open",()=>{clearTimeout(timer);if(!settled)onReady();});
    socket.addEventListener("error",()=>finish(new Error("DSH_AUTO_WEBSOCKET_ERROR")));
    socket.addEventListener("close",()=>finish(signal.aborted?undefined:new Error("DSH_AUTO_WEBSOCKET_CLOSED")));
    socket.addEventListener("message",event=>{
      if(settled)return;
      if(typeof event.data!=="string"){finish(new Error("DSH_AUTO_WEBSOCKET_FRAME_INVALID"));return;}
      const raw=event.data as string,bytes=Buffer.byteLength(raw);queued+=bytes;
      if(queued>8*1024*1024){finish(new Error("DSH_AUTO_FRAME_TOO_LARGE"));return;}
      pending=pending.then(async()=>{if(!settled)await onFrame(JSON.parse(raw) as Obj);queued-=bytes;});
      void pending.catch(error=>finish(error instanceof Error?error:new Error("DSH_AUTO_WEBSOCKET_FRAME_INVALID")));
    });
  });
}
