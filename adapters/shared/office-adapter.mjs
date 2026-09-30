import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizedEvent} from './capture.mjs';
import {staticInfo} from './registry.mjs';
const exec=promisify(execFile);
export function createOfficeAdapter(target,{app,bundle,version,port,Desktop,run,limitations,workspaceDescription}){
  const inspect=async()=>{
    const status={agentKind:target.kind,name:target.name,environment:'VMmac',installRoot:app,version:null,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,driver:'DESKTOP_EVENT_PUSH',permissionPreset:'APPLICATION_DEFAULT',components:[],toolSchemas:[],limitations,checkedAt:new Date().toISOString()};let desktop;
    try{
      const info=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',app+'/Contents/Info.plist'],{timeout:3000})).stdout);status.version=info.CFBundleShortVersionString;
      if(info.CFBundleIdentifier!==bundle||status.version!==version){status.status='INCOMPATIBLE';status.reasonCode='AGENT_VERSION_UNVERIFIED';return status;}
      status.status='NOT_CONNECTED';desktop=await Desktop.connect();status.executionReady=true;status.probeReady=true;
      const authenticated=await desktop.authenticated();status.evaluationReady=authenticated;status.status=authenticated?'READY':'LOGIN_REQUIRED';if(!authenticated)status.reasonCode='AGENT_LOGIN_REQUIRED';
      if(authenticated&&desktop.readiness){const runtime=await desktop.readiness();if(!runtime.ready){status.evaluationReady=false;status.status='RUNTIME_NOT_READY';status.reasonCode=runtime.reasonCode;}}
    }catch(e){status.reasonCode=/^AGENT_[A-Z_]+$/.test(e.message)?e.message:'AGENT_NOT_INSTALLED';}
    finally{desktop?.close();}return status;
  };
  return {
    kind:target.kind,targetId:target.id,name:target.name,supportsAttachments:false,inspect,
    staticInfo:s=>({...staticInfo(target,s),plugins:[],tool_delta:{status:'NOT_APPLICABLE'},limitations:[...s.limitations,'Tool inventory is not exposed. Do not infer external accounts, connectors, internal reasoning or unavailable tools. Select only tasks supported by the stated input/output limitations.']}),
    trace:{kind:target.kind,sourceType:target.kind.toUpperCase()+'_PROBE',externalSchema:target.kind+'.desktop-events/'+version,normalizeEvent:normalizedEvent,blindSpots:['INTERNAL_THOUGHT_NOT_OBSERVED','UNEXPOSED_TOOL_EVENTS_NOT_OBSERVED','INTERMEDIATE_TEXT_OMITTED']},
    workspaceDescription,
    async prepare(){const desktop=await Desktop.connect();try{if(!await desktop.authenticated())throw Error('AGENT_LOGIN_REQUIRED');return desktop;}catch(e){desktop.close();throw e;}},
    run:({context,...input})=>run(context,input),dispose:context=>context?.close(),
    async launch(){
      const s=await inspect();if(s.probeReady)return s;if(s.status==='INCOMPATIBLE'||s.status==='NOT_INSTALLED')throw Error(s.reasonCode);
      const executable=app+'/Contents/MacOS/'+app.split('/').at(-1).replace(/\.app$/,'');
      const child=spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{detached:true,stdio:'ignore'});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('AGENT_LAUNCH_FAILED')));});child.unref();return {status:'LAUNCH_REQUESTED'};
    },
  };
}
