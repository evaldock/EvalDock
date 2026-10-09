import {Desktop} from '../shared/desktop.mjs';
import {createRendererCapture} from '../shared/renderer-capture.mjs';
import {randomUUID} from 'node:crypto';
import {startDoubao} from './collector.mjs';
import {prepareWorkspace} from './workspace.mjs';
export {startDoubao} from './collector.mjs';
/** Version-bound module IDs from the installed office renderer. No cookie/token extraction. */
export async function installDoubao(){
  if(!window.__evaldockDoubaoRequire){
    const chunks=window['@flow-web/desktop:stable'];if(!Array.isArray(chunks))return false;
    chunks.push([['evaldock-office-bridge'],{},r=>{window.__evaldockDoubaoRequire=r;}]);
  }
  const r=window.__evaldockDoubaoRequire;
  for(const id of [788925,957165,446276,656207,71834,521109,63487,201753,609347,639732,734835,421540,886735])if(!r.m[id])return false;
  await r.e('94281');if(typeof r(35673).getIsLoggedIn!=='function')return false;
  const im=await r(788925).D('chatIMService'),service=await im?.getMessageService();
  return typeof service?.sendMessage==='function'&&typeof service?.breakMessage==='function';
}
export class DoubaoDesktop extends Desktop {
  static async connect(){const client=await Desktop.connect({port:18493,match:t=>/^(?:doubaowork|chrome):\/\/doubaowork-chat\//.test(t.url)});Object.setPrototypeOf(client,DoubaoDesktop.prototype);try{if(!await client.evaluate(`(${installDoubao.toString()})()`,20000))throw Error('AGENT_INTERFACE_CHANGED');return client;}catch(e){client.close();throw e;}}
  readiness(){return this.evaluate(`(async()=>{const r=window.__evaldockDoubaoRequire;await r.e('7153');const env=await r(209715).sandboxEnvironmentController.query();return {ready:!!(env.isReady&&env.environmentId),reasonCode:'AGENT_LOCAL_RUNTIME_UNAVAILABLE'};})()`);}
  authenticated(){return this.evaluate(`window.__evaldockDoubaoRequire(35673).getIsLoggedIn()===true`);}
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
