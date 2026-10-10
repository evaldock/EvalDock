import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Desktop} from './desktop.mjs';
const exec=promisify(execFile);
export const APP='/Applications/WorkBuddy.app';
export async function inspectWorkBuddy({appPath=APP,endpoint,execCommand=exec,connect=()=>Desktop.connect({appPath,endpoint})}={}){
  const status={agentKind:'workbuddy',name:'WorkBuddy',environment:'macOS',installRoot:appPath,version:null,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,checkedAt:new Date().toISOString(),limitations:['按桌面连接、调用桥和登录状态检查准入；会话执行与事件采集在运行时验证。','未暴露完整工具清单和内部推理。','MVP 仅投递文本与工作目录文件，不支持原生聊天附件。','文件观测仅覆盖各 Case 工作目录；不自动重置全局应用、数据库或账号状态。']};
  let desktop;
  try{
    const p=JSON.parse((await execCommand('/usr/bin/plutil',['-convert','json','-o','-',appPath+'/Contents/Info.plist'],{timeout:3000,maxBuffer:1024*1024})).stdout);status.version=p.CFBundleShortVersionString;status.build=p.CFBundleVersion;status.bundle=p.CFBundleIdentifier;
    if(p.CFBundleIdentifier!=='com.tencent.workbuddy.mac'){status.status='INCOMPATIBLE';status.reasonCode='WORKBUDDY_APP_ID_MISMATCH';return status;}
    status.status='INSTALLED';desktop=await connect();if(desktop.evaluate)status.runtimeIdentity=await desktop.evaluate('({startedAt:performance.timeOrigin})');status.executionReady=true;status.probeReady=true;
    const authenticated=await desktop.authenticated();status.status=authenticated?'READY':'LOGIN_REQUIRED';status.evaluationReady=authenticated;if(!authenticated)status.reasonCode='WORKBUDDY_LOGIN_REQUIRED';
  }catch(e){status.evaluationReady=false;status.executionReady=false;status.probeReady=false;status.reasonCode=e.message?.startsWith('WORKBUDDY_')?e.message:status.status==='NOT_INSTALLED'?'WORKBUDDY_NOT_INSTALLED':'WORKBUDDY_INSPECTION_FAILED';if(status.status!=='NOT_INSTALLED')status.status='UNAVAILABLE';}
  finally{desktop?.close();}return status;
}
