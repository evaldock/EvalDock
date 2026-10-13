import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizedEvent} from './capture.mjs';
import {staticInfo} from './registry.mjs';
import {inspectionEnvironment} from './cli-interface.mjs';
import {acquire} from '../compatibility/store.mjs';
import {stopDesktopInstallation,waitForDesktopConnection} from './desktop-launch.mjs';
const exec=promisify(execFile);
export function createOfficeAdapter(target,{app,bundle,port,Desktop,run,limitations,workspaceDescription,restartDisconnected=false},{execCommand=exec,spawnProcess=spawn,acquireLease=acquire,...launchOptions}={}){
  app=target.appPath??app;const endpoint=target.endpoint??`http://127.0.0.1:${port}`;
  const inspect=async()=>{
    const status={agentKind:target.kind,name:target.name,environment:'macOS',installRoot:app,version:null,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,driver:'DESKTOP_EVENT_PUSH',permissionPreset:'APPLICATION_DEFAULT',components:[],toolSchemas:[],limitations,checkedAt:new Date().toISOString()};let desktop;
    try{
      const info=JSON.parse((await execCommand('/usr/bin/plutil',['-convert','json','-o','-',app+'/Contents/Info.plist'],{timeout:3000})).stdout);status.version=info.CFBundleShortVersionString;status.build=info.CFBundleVersion;status.bundle=info.CFBundleIdentifier;
      if(typeof info.CFBundleExecutable==='string'&&info.CFBundleExecutable&&!/[\/\\\0]/.test(info.CFBundleExecutable)&&!['.','..'].includes(info.CFBundleExecutable))status.executable=app+'/Contents/MacOS/'+info.CFBundleExecutable;
      if(info.CFBundleIdentifier!==bundle){status.status='INCOMPATIBLE';status.reasonCode='AGENT_APP_ID_MISMATCH';return status;}
      status.status='NOT_CONNECTED';desktop=await Desktop.connect({appPath:app,endpoint});if(desktop.evaluate)status.runtimeIdentity=await desktop.evaluate('({startedAt:performance.timeOrigin})');status.protocol=desktop.protocol??{id:target.kind+'.desktop-events/v1'};status.executionReady=true;status.probeReady=true;
      const authenticated=await desktop.authenticated();status.evaluationReady=authenticated;status.status=authenticated?'READY':'LOGIN_REQUIRED';if(!authenticated)status.reasonCode='AGENT_LOGIN_REQUIRED';
      if(authenticated&&desktop.readiness){const runtime=await desktop.readiness();if(!runtime.ready){status.evaluationReady=false;status.status='RUNTIME_NOT_READY';status.reasonCode=runtime.reasonCode;}}
    }catch(e){status.evaluationReady=false;status.executionReady=false;status.probeReady=false;status.reasonCode=/^AGENT_[A-Z_]+$/.test(e.message)?e.message:status.status==='NOT_INSTALLED'?'AGENT_NOT_INSTALLED':'AGENT_INSPECTION_FAILED';if(status.status!=='NOT_INSTALLED')status.status=status.reasonCode==='AGENT_LOGIN_REQUIRED'?'LOGIN_REQUIRED':'UNAVAILABLE';}
    finally{desktop?.close();}return status;
  };
  return {
    configuration:target,kind:target.kind,targetId:target.id,name:target.name,supportsAttachments:false,inspect,
    staticInfo:s=>({...staticInfo(target,s),plugins:[],tool_delta:{status:'NOT_APPLICABLE'},limitations:[...s.limitations,'Tool inventory is not exposed. Do not infer external accounts, connectors, internal reasoning or unavailable tools. Select only tasks supported by the stated input/output limitations.']}),
    trace:{kind:target.kind,sourceType:target.kind.toUpperCase()+'_PROBE',externalSchema:target.kind+'.desktop-events/v1',normalizeEvent:normalizedEvent,blindSpots:['INTERNAL_THOUGHT_NOT_OBSERVED','UNEXPOSED_TOOL_EVENTS_NOT_OBSERVED','INTERMEDIATE_TEXT_OMITTED']},
    workspaceDescription,
    async prepare(){const desktop=await Desktop.connect({appPath:app,endpoint});try{if(!await desktop.authenticated())throw Error('AGENT_LOGIN_REQUIRED');if(desktop.readiness){const runtime=await desktop.readiness();if(!runtime.ready)throw Error(runtime.reasonCode??'AGENT_LOCAL_RUNTIME_UNAVAILABLE');}return desktop;}catch(e){desktop.close();throw e;}},
    run:({context,...input})=>run(context,input),dispose:context=>context?.close(),
    async launch(){
      const s=await inspect();if(s.probeReady||s.status==='LOGIN_REQUIRED')return s;
      if(!['AGENT_NOT_CONNECTED','AGENT_WINDOW_NOT_READY'].includes(s.reasonCode))throw Error(s.reasonCode??'AGENT_LAUNCH_FAILED');
      if(s.reasonCode==='AGENT_WINDOW_NOT_READY')return waitForDesktopConnection(inspect,launchOptions);
      const info=JSON.parse((await execCommand('/usr/bin/plutil',['-convert','json','-o','-',app+'/Contents/Info.plist'],{timeout:3000,env:inspectionEnvironment()})).stdout);
      if(info.CFBundleIdentifier!==bundle||typeof info.CFBundleExecutable!=='string'||!info.CFBundleExecutable||/[\/\\\0]/.test(info.CFBundleExecutable)||['.','..'].includes(info.CFBundleExecutable))throw Error('AGENT_APP_ID_MISMATCH');
      const executable=app+'/Contents/MacOS/'+info.CFBundleExecutable;
      const env=inspectionEnvironment();delete env.ELECTRON_RUN_AS_NODE;
      const origin=new URL(endpoint);if(origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('AGENT_INVALID_ENDPOINT');
      const release=await acquireLease({kind:target.kind,targetId:target.id,configuration:target});
      try{
        if(restartDisconnected)await stopDesktopInstallation(app,executable,{execCommand,...launchOptions});
        const child=spawnProcess(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+(origin.port||80)],{detached:true,stdio:'ignore',env});
        await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('AGENT_LAUNCH_FAILED')));});child.unref();
        return await waitForDesktopConnection(inspect,launchOptions);
      }finally{await release();}
    },
  };
}
