import {createRendererCapture} from '../shared/renderer-capture.mjs';
import {Desktop} from '../shared/desktop.mjs';
const routes=new Set(['auth.authCheck','localProjects.create','chats.create','chats.get','agent.submitMessage','agent.cancelStream','agent.getStreamingState']);
export function installBridge(){
  if(window.__evaldockQwenRPCVersion===2)return true;
  window.__evaldockQwenRPCVersion=2;
  if(!window.electronTRPC?.sendMessage||!window.desktopApi?.onChatStreamChunk)return false;
  const pending=new Map();let seq=0;
  window.electronTRPC.onMessage(message=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);const error=message.error?.json??message.error;if(error)p.reject(new Error(error.data?.code??'AGENT_RPC_REJECTED'));else p.resolve(message.result?.data&&Object.hasOwn(message.result.data,'json')?message.result.data.json:message.result?.data);});
  window.__evaldockQwenRPC=(path,type,input)=>new Promise((resolve,reject)=>{
    const id='evaldock-'+Date.now()+'-'+(++seq),timer=setTimeout(()=>{pending.delete(id);reject(new Error('AGENT_RPC_TIMEOUT'));},45000);
    pending.set(id,{resolve,reject,timer});window.electronTRPC.sendMessage({method:'request',operation:{id,path,type,input:input===undefined?undefined:{json:input}}});
  });return true;
}
export class QwenDesktop extends Desktop {
  static async connect(){const client=await Desktop.connect({port:18492,match:t=>t.url.startsWith('file:///Applications/QwenWorkCN.app/Contents/Resources/app.asar/out/renderer/index.html')});Object.setPrototypeOf(client,QwenDesktop.prototype);try{if(!await client.evaluate(`(${installBridge.toString()})()`))throw Error('AGENT_INTERFACE_CHANGED');return client;}catch(e){client.close();throw e;}}
  async invoke(path,type='query',input){if(!routes.has(path))throw Error('AGENT_CHANNEL_NOT_ALLOWED');return this.evaluate(`window.__evaldockQwenRPC(${JSON.stringify(path)},${JSON.stringify(type)},${JSON.stringify(input)})`,50000);}
  async authenticated(){const status=await this.invoke('auth.authCheck');return status?.loggedIn===true;}
}

export function subscribeQwen(sessionId,createCapture){
  const root=window.__evaldockQwenSessions??=Object.create(null);if(root[sessionId])throw Error('AGENT_DUPLICATE_SESSION');
  const c=createCapture(sessionId),names=new Map();let currentText=null;
  // Desktop 1.2.1 pushes projected patches, not the executor's raw token events.
  const part=p=>{
    if(!p||typeof p!=='object')return;
    if(p.type==='text'&&typeof p.text==='string')c.text(p.text);
    const name=p.toolName??(p.type?.startsWith('tool-')?p.type.slice(5):null);
    if(!name||['Thinking','TaskText'].includes(name)||!p.toolCallId)return;
    if(p.state==='input-streaming')return;
    c.add('tool/call',{callId:p.toolCallId,name,arguments:p.input});
    if(p.state==='output-available'||p.state==='output-error')c.add('tool/result',{callId:p.toolCallId,name,result:p.output??p.result??p.errorText,isError:p.state==='output-error'});
  };
  const owned=fn=>payload=>{if(payload?.subChatId===sessionId&&!c.done)fn(payload);};
  const dispose=[
    window.desktopApi.onChatStreamChunk(owned(({chunk:e})=>{
      if(!e)return;
      if(e.type==='message-parts-patch'){
        for(const op of e.patch?.operations??[]){if(['append-parts','replace-parts'].includes(op.type))for(const p of op.parts??[])part(p);else if(op.type==='upsert-part')part(op.part);else if(op.type==='set-current-text'&&op.currentTextAcc)c.text(op.currentTextAcc);}
      }else if(e.type==='message-parts-snapshot'){for(const p of e.parts??[])part(p);if(e.currentTextAcc)c.text(e.currentTextAcc);}
      else if(e.type==='text-start'){if(currentText!==e.id){currentText=e.id;c.text('');}}
      else if(e.type==='text-delta'){if(currentText!==e.id){currentText=e.id;c.text('');}c.text(e.delta,true);}
      else if(e.type==='tool-input-start'){names.set(e.toolCallId,e.toolName);if(names.size>256)names.delete(names.keys().next().value);}
      else if(e.type==='tool-input-available'){const name=e.toolName??names.get(e.toolCallId)??'unknown';names.set(e.toolCallId,name);if(name!=='Thinking'&&name!=='TaskText')c.add('tool/call',{callId:e.toolCallId,name,arguments:e.input});}
      else if(e.type==='tool-output-available'||e.type==='tool-output-error'){const name=names.get(e.toolCallId)??e.toolName??'unknown';if(name!=='Thinking'&&name!=='TaskText')c.add('tool/result',{callId:e.toolCallId,name,result:e.output??e.errorText,isError:e.type==='tool-output-error'});}
      else if(['auth-error','api-error','error'].includes(e.type)){c.add('runtime/error',{reason:e.type});c.finish(e.type==='auth-error'?'AGENT_LOGIN_REQUIRED':'AGENT_MODEL_RESPONSE_FAILED');}
      else if(e.type==='permission-request'||e.type==='ask-user-question'){c.finish('AGENT_INTERACTION_REQUIRED');}
      else{c.seen++;c.noise++;}
    })),
    window.desktopApi.onChatStreamComplete(owned(()=>c.finish())),
    window.desktopApi.onChatStreamError(owned(()=>c.finish('AGENT_TASK_FAILED'))),
  ];
  root[sessionId]={wait:c.wait,extract(){for(const f of dispose)f?.();delete root[sessionId];return c.extract();}};return true;
}
export async function runQwen(desktop,{cwd,prompt,deadlineMs,signal,onSession}){
  if(signal?.aborted)throw Error('AGENT_CANCELLED');
  const project=await desktop.invoke('localProjects.create','mutation',{rootPaths:[cwd],name:'EvalDock '+cwd.split('/').at(-1)});
  const created=await desktop.invoke('chats.create','mutation',{localProjectId:project.project.id,name:'EvalDock '+cwd.split('/').at(-1),useWorktree:false,chatType:'task',mode:'agent',additionalDirectories:[cwd]});
  const chatId=created?.id??created?.chat?.id;
  const details=chatId?await desktop.invoke('chats.get','query',{id:chatId}):null;
  const sessionId=details?.subChats?.[0]?.id??created?.subChatId;
  if(typeof chatId!=='string'||typeof sessionId!=='string')throw Error('AGENT_CREATE_FAILED');
  let error=null,capture,cleanup='UNKNOWN';
  try{
    await onSession?.(sessionId);
    if(signal?.aborted)throw Error('AGENT_CANCELLED');
    await desktop.evaluate(`(${subscribeQwen.toString()})(${JSON.stringify(sessionId)},${createRendererCapture.toString()})`);
    await desktop.invoke('agent.submitMessage','mutation',{chatId,subChatId:sessionId,prompt,cwd,projectPath:cwd,additionalDirectories:[cwd],userSelectedDirectories:[cwd],outputDirectory:cwd,mode:'agent'});
    const out=await desktop.evaluate(`window.__evaldockQwenSessions[${JSON.stringify(sessionId)}].wait`,deadlineMs,signal);error=out?.error??null;
  }catch(e){error=e.message==='AGENT_RPC_TIMEOUT'?'AGENT_TASK_TIMEOUT':e.message.startsWith('AGENT_')?e.message:'AGENT_EXECUTION_ERROR';}
  try{
    if(error)await desktop.invoke('agent.cancelStream','mutation',{subChatId:sessionId});
    const state=await desktop.invoke('agent.getStreamingState','query',{subChatId:sessionId});
    // One post-completion verification; never poll history or streaming state.
    if(!state||state.isStreaming===false)cleanup='STOPPED';
  }catch{}
  try{capture=await desktop.evaluate(`window.__evaldockQwenSessions?.[${JSON.stringify(sessionId)}]?.extract()??null`);}catch{error??='AGENT_CAPTURE_FAILED';}
  if(!error&&!capture?.done)error='AGENT_COMPLETION_UNCONFIRMED';
  if(cleanup==='UNKNOWN')error??='AGENT_CLEANUP_UNCONFIRMED';
  return {...capture,sessionId,chatId,error,cleanup};
}
