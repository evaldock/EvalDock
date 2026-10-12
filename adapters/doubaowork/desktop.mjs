import {Desktop} from '../shared/desktop.mjs';
import {createRendererCapture} from '../shared/renderer-capture.mjs';
import {randomUUID} from 'node:crypto';
import {startDoubao} from './collector.mjs';
import {prepareWorkspace} from './workspace.mjs';
import {doubaoModule,bindDoubao} from './interface.mjs';
import {assertDesktopOwner} from '../shared/desktop-owner.mjs';
export {startDoubao} from './collector.mjs';
/** Discover registered contracts; known lazy chunks remain a checked legacy fallback. */
export async function installDoubao(resolve=doubaoModule,bind=bindDoubao){
  if(!window.__evaldockDoubaoRequire){
    const chunks=window['@flow-web/desktop:stable'];if(!Array.isArray(chunks))return false;
    chunks.push([['evaldock-office-bridge'],{},r=>{window.__evaldockDoubaoRequire=r;}]);
  }
  const r=window.__evaldockDoubaoRequire;
  const authSpec={id:35673,properties:{getIsLoggedIn:'function'},marker:'getIsLoggedIn'};
  let auth;
  try{auth=resolve(r,authSpec);}catch(e){if(e.message!=='AGENT_INTERFACE_CHANGED')throw e;try{await r.e('94281');}catch{throw Error('AGENT_INTERFACE_CHANGED');}auth=resolve(r,authSpec);}
  if(!auth.getIsLoggedIn())return {ready:false,reasonCode:'AGENT_LOGIN_REQUIRED'};
  let modules;
  try{modules=bind(r,resolve);}catch(e){if(e.message!=='AGENT_INTERFACE_CHANGED')throw e;try{await r.e('7153');}catch{throw Error('AGENT_INTERFACE_CHANGED');}modules=bind(r,resolve);}
  window.__evaldockDoubaoBindings=modules;
  const im=await modules.injection.D('chatIMService'),service=await im?.getMessageService();
  return typeof service?.sendMessage==='function'&&typeof service?.breakMessage==='function';
}
export class DoubaoDesktop extends Desktop {
  static async connect({appPath='/Applications/DoubaoWork.app',endpoint='http://127.0.0.1:18493',verifyOwner=assertDesktopOwner}={}){await verifyOwner(endpoint,appPath);const client=await Desktop.connect({endpoint,match:t=>/^(?:doubaowork|chrome):\/\/doubaowork-chat\/chat\//.test(t.url)});Object.setPrototypeOf(client,DoubaoDesktop.prototype);try{const check=await client.evaluate(`(${installDoubao.toString()})(${doubaoModule.toString()},${bindDoubao.toString()})`,20000);if(check?.reasonCode==='AGENT_LOGIN_REQUIRED')throw Error(check.reasonCode);if(check!==true)throw Error('AGENT_INTERFACE_CHANGED');client.protocol={id:'doubao.office-services/v1',moduleBinding:'EXPORTED_CONTRACTS'};return client;}catch(e){client.close();throw e;}}
  readiness(){return this.evaluate(`(async()=>{const env=await window.__evaldockDoubaoBindings.environment.sandboxEnvironmentController.query();return {ready:!!(env.isReady&&env.environmentId),reasonCode:'AGENT_LOCAL_RUNTIME_UNAVAILABLE'};})()`);}
  authenticated(){return this.evaluate(`window.__evaldockDoubaoBindings.auth.getIsLoggedIn()===true`);}
}
export async function runDoubao(desktop,{prompt,deadlineMs,signal,onSession,caseData,cwd}){
  if(typeof cwd!=='string'||!cwd.startsWith('/'))throw Error('AGENT_WORKSPACE_REQUIRED');
  const sessionId='evaldock-'+randomUUID();let capture,error=null,cleanup='UNKNOWN',started=false;
  try{
    if(signal?.aborted)throw Error('AGENT_CANCELLED');await onSession?.(sessionId);
    await desktop.evaluate(`(${startDoubao.toString()})(${JSON.stringify({sessionId,prompt,cwd})},${createRendererCapture.toString()},${prepareWorkspace.toString()})`,30000);started=true;
    const result=await desktop.evaluate(`window.__evaldockDoubaoSessions[${JSON.stringify(sessionId)}].wait`,deadlineMs,signal);error=result?.error??null;if(!error)cleanup='STOPPED';
  }catch(e){error=e.message==='AGENT_RPC_TIMEOUT'?'AGENT_TASK_TIMEOUT':e.message.startsWith('AGENT_')?e.message:'AGENT_EXECUTION_ERROR';if(!started&&['AGENT_LOGIN_REQUIRED','AGENT_OFFICE_MODE_UNAVAILABLE','AGENT_LOCAL_RUNTIME_UNAVAILABLE','AGENT_WORKSPACE_UNAVAILABLE','AGENT_WORKSPACE_NOT_GRANTED'].includes(error))cleanup='STOPPED';}
  if(error&&started)try{if(await desktop.evaluate(`window.__evaldockDoubaoSessions[${JSON.stringify(sessionId)}].cancel()`))cleanup='STOPPED';}catch{}
  try{capture=await desktop.evaluate(`window.__evaldockDoubaoSessions?.[${JSON.stringify(sessionId)}]?.extract()??null`);}catch{error??='AGENT_CAPTURE_FAILED';}
  if(!error&&!capture?.done)error='AGENT_COMPLETION_UNCONFIRMED';
  // Unknown cancellation blocks subsequent cases; no fabricated terminal confirmation.
  return {...capture,sessionId,error,cleanup};
}
