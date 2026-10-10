/** Interface-checked CLI transport to the actual WorkBuddy desktop, not a standalone CodeBuddy process. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function desktopConnection({appPath='/Applications/WorkBuddy.app',endpoint='http://127.0.0.1:18491'}={}){
 const url=new URL(endpoint);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!path.isAbsolute(appPath)||!appPath.endsWith('.app'))throw Error('WORKBUDDY_INVALID_ENDPOINT');
 return {endpoint:url.origin,renderer:pathToFileURL(path.join(appPath,'Contents/Resources/app.asar/renderer/index.html')).href};
}
const channels=new Set(['auth:getAccount','session:create','session:sendMessage','session:cancel','session:destroy','session:notifyListenerReady']);
export class Desktop {
  constructor(ws){this.ws=ws;this.next=0;this.pending=new Map();
    ws.addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);p.dispose();m.error?p.reject(new Error('WORKBUDDY_TRANSPORT_ERROR')):p.resolve(m.result);});
    ws.addEventListener('close',()=>{for(const p of this.pending.values()){p.dispose();p.reject(new Error('WORKBUDDY_DISCONNECTED'));}this.pending.clear();});
  }
  static async connect(options){
    const {endpoint,renderer}=desktopConnection(options);
    let targets;try{const r=await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error();targets=await r.json();}catch{throw new Error('WORKBUDDY_NOT_CONNECTED');}
    const t=targets.find(x=>x.type==='page'&&x.url?.split(/[?#]/,1)[0]===renderer);
    if(!t)throw new Error('WORKBUDDY_WINDOW_NOT_READY');
    const url=new URL(t.webSocketDebuggerUrl);if(url.protocol!=='ws:'||url.host!==new URL(endpoint).host||url.username||url.password)throw new Error('WORKBUDDY_INVALID_ENDPOINT');
    const ws=new WebSocket(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('WORKBUDDY_CONNECT_TIMEOUT'));},3000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('WORKBUDDY_CONNECT_FAILED'));},{once:true});});
    const client=new Desktop(ws);try{await client.checkInterfaces();return client;}catch(e){client.close();throw e;}
  }
  async evaluate(expression,timeout=10000,signal){
    if(signal?.aborted)throw new Error('WORKBUDDY_CANCELLED');
    const id=++this.next;
    const r=await new Promise((resolve,reject)=>{
      const dispose=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      const fail=code=>{this.pending.delete(id);dispose();reject(new Error(code));};
      const abort=()=>fail('WORKBUDDY_CANCELLED');
      const timer=setTimeout(()=>fail('WORKBUDDY_RPC_TIMEOUT'),timeout);
      this.pending.set(id,{resolve,reject,dispose});signal?.addEventListener('abort',abort,{once:true});
      try{this.ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));}
      catch{fail('WORKBUDDY_DISCONNECTED');}
    });
    if(r.exceptionDetails)throw new Error('WORKBUDDY_RPC_REJECTED');return r.result?.value;
  }
  async invoke(channel,...args){if(!channels.has(channel))throw new Error('WORKBUDDY_CHANNEL_NOT_ALLOWED');const r=await this.evaluate(`window.__wbInvoke(${JSON.stringify(channel)}, {}, ...${JSON.stringify(args)})`,channel==='session:create'?60000:10000);if(r?.__wbError)throw new Error(/Authentication required/i.test(r.message??'')?'WORKBUDDY_LOGIN_REQUIRED':'WORKBUDDY_RPC_REJECTED');return r;}
  async checkInterfaces(){
    if(!await this.evaluate('typeof window.__wbInvoke === "function"'))throw new Error('WORKBUDDY_INTERFACE_CHANGED');
    if(!await this.evaluate('typeof window.postMessage === "function" && typeof MessageChannel === "function"'))throw new Error('WORKBUDDY_EVENT_TRANSPORT_UNAVAILABLE');
  }
  async authenticated(){return this.evaluate('window.__wbInvoke("auth:getAccount",{}).then(a=>!!a&&!a.__wbError)');}
  async confirmStopped(sessionId){
    // One state read after destroying our own session, never history polling.
    const state=await this.evaluate(`window.__wbInvoke("session:get",{},${JSON.stringify(sessionId)})`);
    return state===null||state?.__wbError&&state.code==='SESSION_NOT_FOUND'||state?.sessionId===sessionId&&(state.running===false||['completed','terminated'].includes(state.status));
  }
  close(){this.ws.close();}
}

/** Renderer-side event subscription. No history reads or polling; only this owned Session. */
export function installCapture(sessionId){
  const root=window.__evaldockWorkBuddy??=Object.create(null);
  if(root[sessionId])throw new Error('duplicate collector');
  const encoder=new TextEncoder(),tools=new Map(),eventIds=new Set();
  const c=root[sessionId]={seen:0,noise:0,duplicates:0,mergedUpdates:0,omitted:0,clipped:0,bytes:0,final:'',finalTruncated:false,done:false,result:null,error:null};
  let order=0,messageKey=null,closed=false,started=false,resolveTask,resolveReady,readyTimer;
  const ready=new Promise(resolve=>{resolveReady=resolve;});
  const task=new Promise(resolve=>{resolveTask=resolve;});
  const textLimit=(text,limit)=>{
    if(encoder.encode(text).length<=limit)return {text,truncated:false};
    let low=0,high=Math.min(text.length,limit);
    while(low<high){const mid=Math.ceil((low+high)/2);if(encoder.encode(text.slice(0,mid)).length<=limit)low=mid;else high=mid-1;}
    if(low>0&&/[\uD800-\uDBFF]/.test(text[low-1]))low--;
    return {text:text.slice(0,low),truncated:true};
  };
  const clip=(v,depth=0)=>{
    if(typeof v==='string'){const x=textLimit(v,16384);if(x.truncated)c.clipped++;return x.text+(x.truncated?' [TRUNCATED]':'');}
    if(v==null||typeof v==='boolean'||typeof v==='number')return v;
    if(depth>6){c.clipped++;return '[DEPTH_LIMIT]';}
    if(Array.isArray(v)){if(v.length>32)c.clipped++;return v.slice(0,32).map(x=>clip(x,depth+1));}
    if(typeof v==='object'){const pairs=Object.entries(v);if(pairs.length>32)c.clipped++;return Object.fromEntries(pairs.slice(0,32).map(([k,x])=>[k,/^(?:accessToken|refreshToken|token|password|authorization|api.?key|secret)$/i.test(k)?'[REDACTED]':clip(x,depth+1)]));}
    return null;
  };
  const bounded=value=>{let v=clip(value);if(encoder.encode(JSON.stringify(v)).length>32768){c.clipped++;v={contentOmitted:true,reason:'FIELD_SIZE_LIMIT'};}return v;};
  const setFinal=text=>{const x=textLimit(text,64*1024);c.final=x.text;c.finalTruncated=x.truncated;};
  const finish=(error,result)=>{if(c.done)return;c.done=true;c.error=error??null;c.result=result??null;resolveTask({error:c.error});};
  c.accept=(channel,payload,envelopeId)=>{
    if(channel!=='session:event:'+sessionId||payload?.sessionId!==sessionId||c.done||!started)return;
    if(envelopeId){if(eventIds.has(envelopeId)){c.duplicates++;return;}eventIds.add(envelopeId);if(eventIds.size>2048)eventIds.delete(eventIds.values().next().value);}
    c.seen++;const event=payload.event??payload,u=event.update??event,type=u.sessionUpdate??event.type;
    if((event._meta??payload._meta)?.['codebuddy.ai']?.syntheticOwnerHistory){c.noise++;return;}
    if(type==='permissionRequest'||type==='questionRequest'){finish('WORKBUDDY_INTERACTION_REQUIRED');return;}
    if(type==='agent_message_chunk'||type==='assistant_message_chunk'){
      const meta=u._meta??payload._meta??{},key=meta['codebuddy.ai/llmMessageId']??u.messageId??null;
      if(key!==messageKey){messageKey=key;c.final='';c.finalTruncated=false;}
      const blocks=Array.isArray(u.content)?u.content:[u.content];
      for(const b of blocks){if(b?.type!=='text'||typeof b.text!=='string')continue;const wasTruncated=c.finalTruncated;setFinal(c.final+b.text);c.finalTruncated ||= wasTruncated;}
      return;
    }
    if(type!=='tool_call'&&type!=='tool_call_update'){c.noise++;if(!['agent_thought_chunk','usage_update','available_commands_update','current_mode_update'].includes(type)){c.unknownEvents??=[];if(c.unknownEvents.length<16)c.unknownEvents.push({type:String(type??'unknown').slice(0,80),keys:Object.keys(u).slice(0,16)});}return;}
    if(typeof u.toolCallId!=='string'){c.omitted++;return;}
    const at=new Date().toISOString(),id=u.toolCallId;let t=tools.get(id);
    if(!t){t={call:null,result:null,bytes:0};tools.set(id,t);}else c.mergedUpdates++;
    c.bytes-=t.bytes;
    const meta={toolName:u._meta?.toolName??t.call?.event.update._meta?.toolName??u.title??u.kind??'unknown'};
    if(!t.call||type==='tool_call'||u.rawInput!==undefined){
      const old=t.call?.event.update??{};
      t.call={at:t.call?.at??at,order:t.call?.order??++order,event:{update:{sessionUpdate:'tool_call',toolCallId:id,_meta:meta,rawInput:u.rawInput===undefined?old.rawInput??null:bounded(u.rawInput)}}};
    }
    // Every update replaces the previous snapshot for this call; retries have distinct call IDs.
    if(type==='tool_call_update'||u.rawOutput!==undefined){
      const old=t.result?.event.update??{};
      t.result={at,order:++order,event:{update:{sessionUpdate:'tool_call_update',toolCallId:id,_meta:meta,status:u.status??old.status??'unknown',rawOutput:u.rawOutput===undefined&&u.content===undefined?old.rawOutput??null:bounded(u.rawOutput??u.content)}}};
    }
    t.bytes=encoder.encode(JSON.stringify(t.call)+JSON.stringify(t.result)).length;c.bytes+=t.bytes;
    while(c.bytes>192*1024||tools.size>128){const key=tools.keys().next().value,old=tools.get(key);c.bytes-=old.bytes;tools.delete(key);c.omitted+=(old.call?1:0)+(old.result?1:0);}
  };
  const channel=new MessageChannel(),port=channel.port1,requestId='evaldock-send-'+sessionId;
  const transportError=()=>{clearTimeout(readyTimer);resolveReady(false);finish('WORKBUDDY_EVENT_TRANSPORT_FAILED');};
  port.onmessage=({data:m})=>{
    if(closed)return;
    if(m?.kind==='open'){clearTimeout(readyTimer);resolveReady(true);return;}
    if(m?.kind==='error'||m?.kind==='close'){transportError();return;}
    if(m?.kind!=='message')return;const frame=m.json;
    if(frame?.type==='event'){c.accept(frame.channel,frame.result,frame.id);return;}
    if(frame?.id!==requestId)return;
    if(frame.type==='error'||frame.result?.__wbError){finish('WORKBUDDY_TASK_REJECTED');return;}
    if(frame.type==='response'){
      const r=frame.result,final=r?._meta?.['codebuddy.ai']?.lastAssistantText;
      if(typeof final==='string')setFinal(final);
      finish(null,{stopReason:r?.stopReason,usage:bounded(r?.usage??null)});
    }
  };
  port.onmessageerror=transportError;port.start();
  readyTimer=setTimeout(transportError,5000);
  window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[channel.port2]);
  c.start=prompt=>{
    if(started||closed||c.done)throw new Error('collector unavailable');started=true;
    port.postMessage({kind:'message',json:{id:requestId,type:'request',channel:'session:sendMessage',args:[sessionId,[{type:'text',text:prompt}]]}});
    return task;
  };
  c.extract=()=>{
    closed=true;clearTimeout(readyTimer);port.postMessage({kind:'close'});port.close();
    resolveTask({error:c.error??'WORKBUDDY_CANCELLED'});delete root[sessionId];
    const queue=[...tools.values()].flatMap(t=>[t.call,t.result].filter(Boolean)).sort((a,b)=>a.order-b.order).map(({order,...r})=>r);
    const {accept,start,extract,...data}=c;return {...data,queue};
  };
  return ready;
}
export async function runSession(desktop,{cwd,prompt,deadlineMs,signal,onSession}){
  if(signal?.aborted)throw new Error('WORKBUDDY_CANCELLED');
  const created=await desktop.invoke('session:create',{cwd,config:{mode:'craft'}});
  const sessionId=created?.sessionId;if(typeof sessionId!=='string'||!/^[a-zA-Z0-9._-]{1,200}$/.test(sessionId))throw new Error('WORKBUDDY_CREATE_FAILED');
  let outcome;
  try{
    await onSession?.(sessionId);
    if(signal?.aborted)throw new Error('WORKBUDDY_CANCELLED');
    if(!await desktop.evaluate(`(${installCapture.toString()})(${JSON.stringify(sessionId)})`))throw new Error('WORKBUDDY_EVENT_TRANSPORT_FAILED');
    await desktop.invoke('session:notifyListenerReady',sessionId);
    // One pending completion promise. Evidence arrives on the MessagePort, never from session:get.
    const result=await desktop.evaluate(`window.__evaldockWorkBuddy[${JSON.stringify(sessionId)}].start(${JSON.stringify(prompt)})`,deadlineMs,signal).catch(e=>{if(e.message==='WORKBUDDY_RPC_TIMEOUT')throw new Error('WORKBUDDY_TASK_TIMEOUT');throw e;});
    if(result?.error)throw new Error(result.error);
  }catch(e){outcome=e.message.startsWith('WORKBUDDY_')?e.message:'WORKBUDDY_EXECUTION_ERROR';await desktop.invoke('session:cancel',sessionId).catch(()=>{});}
  let capture;
  try{capture=await desktop.evaluate(`window.__evaldockWorkBuddy?.[${JSON.stringify(sessionId)}]?.extract() ?? null`);}
  catch{outcome??='WORKBUDDY_CAPTURE_FAILED';}
  // Stop only the owned runtime, retaining native conversation history for audit.
  let cleanup='UNKNOWN';try{await desktop.invoke('session:destroy',sessionId);if(await desktop.confirmStopped?.(sessionId))cleanup='STOPPED';}catch{}
  if(cleanup==='UNKNOWN')outcome??='WORKBUDDY_CLEANUP_UNCONFIRMED';
  if(!outcome&&(!capture?.done||!capture?.result?.stopReason))outcome='WORKBUDDY_COMPLETION_UNCONFIRMED';
  if(!outcome&&!capture?.seen)outcome='WORKBUDDY_CAPTURE_EMPTY';
  if(!outcome&&!['end_turn','stop_sequence','refusal'].includes(capture.result.stopReason))outcome='WORKBUDDY_TURN_INCOMPLETE';
  return {sessionId,...capture,error:outcome??capture?.error??null,cleanup};
}
