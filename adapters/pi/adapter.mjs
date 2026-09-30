import path from 'node:path';
import {readFile,access} from 'node:fs/promises';
import {Capture,runProcess,normalizedEvent} from '../shared/capture.mjs';
import {loadAgentEnvironment,staticInfo} from '../shared/registry.mjs';

import {piLaunch} from './launch.mjs';
import {preflightPi,preflightError} from './preflight.mjs';

const text=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(x=>x.type==='text').map(x=>x.text??'').join(''):'';
export function piEvent(row,capture){
  const at=new Date().toISOString();
  if(row.type==='tool_execution_start')capture.add('tool/call',{callId:row.toolCallId,name:row.toolName,arguments:row.args},at);
  else if(row.type==='tool_execution_end')capture.add('tool/result',{callId:row.toolCallId,name:row.toolName,result:row.result,isError:row.isError},at);
  else if(row.type==='message_end'){
    const m=row.message;
    if(m?.role==='assistant'){
      if(m.stopReason==='error'||m.stopReason==='aborted'){capture.error='PI_MODEL_RESPONSE_FAILED';capture.add('runtime/error',{reason:capture.error,stopReason:m.stopReason,message:String(m.errorMessage??'').slice(0,2000)},at);}
      const answer=text(m.content);if(answer)capture.finalText(answer);
    }
  }else if(row.type==='agent_end')capture.result={stopReason:'end_turn'};
  else if(row.type==='session')capture.nativeSessionId=row.id;
  else {capture.seen++;capture.noise++;}
}
export async function inspectPi(target){
  const status={agentKind:'pi',name:target.name,version:null,installRoot:target.sourceRoot,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,driver:'PI_JSON_STREAM',permissionPreset:target.permissionPreset??'PI_DEFAULT_TOOLS',toolSchemas:['read','bash','edit','write'].map(name=>({name,source:'PI_BUILTIN_DECLARATION'})),components:[],limitations:['观测 Pi JSON 事件流；内部推理、Extension 内部 hook 与未暴露事件不推断。','只投递文本与工作目录文件；不自动重置全局系统和账号。','使用独立 Home 与会话，关闭自动发现；仅加载明确选中的 Extension。']};
  try{
    const pkg=JSON.parse(await readFile(path.join(target.sourceRoot,'packages/coding-agent/package.json'),'utf8'));
    await access(target.executable);status.version=pkg.version;status.executionReady=true;status.probeReady=true;
    status.extensions=[];
    for(const item of target.extensionCatalog??[]){
      const pkg=JSON.parse(await readFile(path.join(item.path,'package.json'),'utf8'));
      const entries=Array.isArray(pkg.pi?.extensions)?pkg.pi.extensions:[];
      status.extensions.push({name:pkg.name,version:pkg.version,path:item.path,entries,enabled:(target.extensions??[]).includes(pkg.name)});
    }
    status.components=status.extensions.filter(e=>e.enabled).map(e=>({name:e.name,version:e.version,kind:'EXTENSION'}));
    await loadAgentEnvironment();status.status='READY';status.evaluationReady=true;
  }catch(error){status.status=status.executionReady?'UNAVAILABLE':'NOT_INSTALLED';status.reasonCode=error.message==='AGENT_MODEL_KEY_MISSING'?error.message:'PI_CONFIGURATION_UNAVAILABLE';}
  return status;
}
export function createPiAdapter(target){
  return {
    kind:'pi',targetId:target.id,name:target.name,supportsAttachments:false,
    inspect:()=>inspectPi(target),staticInfo:s=>staticInfo(target,s),
    async preflight({extensions}={}){const t=extensions?{...target,extensions}:target;return preflightPi(t,await inspectPi(t));},
    trace:{kind:'pi',sourceType:'PI_PROBE',externalSchema:'pi.json-events/0.85.1',normalizeEvent:normalizedEvent,blindSpots:['INTERNAL_THOUGHT_NOT_OBSERVED','EXTENSION_INTERNAL_HOOKS_NOT_OBSERVED','INTERMEDIATE_TEXT_OMITTED']},
    async prepare({inspection}){const check=await preflightPi(target,inspection);if(check.status!=='PASSED')throw preflightError(check);return {env:await loadAgentEnvironment(),inspection};},
    async run({context,caseDirectory,cwd,prompt,deadlineMs,signal,onSession}){
      const launch=await piLaunch(target,context.inspection,path.join(caseDirectory,'runtime-home'),{env:context.env});
      launch.args.push('--',prompt.startsWith('@')?'\n'+prompt:prompt);
      const capture=new Capture('pi');
      return runProcess({...launch,cwd,signal,deadlineMs,capture,onEvent:piEvent,onSession});
    },
    dispose(){},
  };
}
