import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Desktop} from './desktop.mjs';
const exec=promisify(execFile);
export const APP='/Applications/WorkBuddy.app';
export async function inspectWorkBuddy(){
  const status={agentKind:'workbuddy',name:'WorkBuddy',environment:'macOS',installRoot:APP,version:null,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,checkedAt:new Date().toISOString(),limitations:['桌面接口按 5.5.6 版本适配；升级后必须重新验证。','未暴露完整工具清单和内部推理。','MVP 仅投递文本与工作目录文件，不支持原生聊天附件。','文件观测仅覆盖各 Case 工作目录；不自动重置全局应用、数据库或账号状态。']};
  let desktop;
  try{
    const p=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',APP+'/Contents/Info.plist'],{timeout:3000,maxBuffer:1024*1024})).stdout);status.version=p.CFBundleShortVersionString;
    if(p.CFBundleIdentifier!=='com.tencent.workbuddy.mac'||status.version!=='5.5.6'){status.status='INCOMPATIBLE';status.reasonCode='WORKBUDDY_VERSION_UNVERIFIED';return status;}
    status.status='INSTALLED';desktop=await Desktop.connect();status.executionReady=true;status.probeReady=true;
    const authenticated=await desktop.authenticated();status.status=authenticated?'READY':'LOGIN_REQUIRED';status.evaluationReady=authenticated;if(!authenticated)status.reasonCode='WORKBUDDY_LOGIN_REQUIRED';
  }catch(e){status.reasonCode=e.message?.startsWith('WORKBUDDY_')?e.message:'WORKBUDDY_NOT_INSTALLED';}
  finally{desktop?.close();}return status;
}
