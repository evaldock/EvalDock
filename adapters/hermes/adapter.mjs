import path from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Capture,runProcess,normalizedEvent} from '../shared/capture.mjs';
import {loadAgentEnvironment,staticInfo} from '../shared/registry.mjs';
const exec=promisify(execFile);
export function hermesEvent(row,capture){
 const at=Number.isFinite(row.timestamp)?new Date(row.timestamp).toISOString():new Date().toISOString();
 if(row.type==='system'){capture.nativeSessionId=row.session_id;return;}
 if(row.type==='tool_use'||row.type==='tool_result'){
  const callId=row.tool_call_id??`unpaired-${capture.seen+1}`;
  capture.add(row.type==='tool_use'?'tool/call':'tool/result',row.type==='tool_use'?{callId,name:row.name,arguments:row.input}:{callId,name:row.name,result:row.output,isError:row.is_error,durationMs:row.duration_ms},at);
 }else if(row.type==='result'){
  capture.finalText(row.text??'');capture.nativeSessionId=row.session_id;
  capture.result={stopReason:row.exit_code===0?'end_turn':'error',usage:row.tokens};
  if(row.exit_code!==0){capture.error='HERMES_EXECUTION_FAILED';capture.add('runtime/error',{message:row.error??'Hermes did not complete',exitCode:row.exit_code},at);}
 }else{capture.seen++;capture.noise++;}
}
export async function inspectHermes(target){
 const result={agentKind:'hermes',name:target.name,installRoot:target.sourceRoot,version:null,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,driver:'HERMES_JSON_STREAM',permissionPreset:'CLI_NONINTERACTIVE',components:[],toolSchemas:['terminal','read_file','write_file','patch'].map(name=>({name,source:'HERMES_TOOLSET_DECLARATION'})),limitations:['原生 JSON 事件推送；仅保留工具调用、结果、最终回答与真实用量。','原生工具输出最多 5000 字符；逐 token 文本和内部推理不保留。','每题独立 Hermes 状态与工作目录；进程隔离不等于系统沙箱。','无原生调用 ID 时不推断工具调用与结果的对应关系。']};
 try{const r=await exec(target.executable,['--version'],{timeout:12000,maxBuffer:65536});result.version=r.stdout.trim().split("\n")[0];result.executionReady=true;result.probeReady=true;await loadAgentEnvironment();result.status='READY';result.evaluationReady=true;}
 catch(e){result.reasonCode=e.message==='AGENT_MODEL_KEY_MISSING'?e.message:'HERMES_CONFIGURATION_UNAVAILABLE';}
 return result;
}
export function createHermesAdapter(target){return {
 kind:'hermes',targetId:target.id,name:target.name,supportsAttachments:false,
 inspect:()=>inspectHermes(target),staticInfo:s=>staticInfo(target,s),
 trace:{kind:'hermes',sourceType:'HERMES_PROBE',externalSchema:'hermes.stream-json/0.21',normalizeEvent:normalizedEvent,blindSpots:['THOUGHT_AND_TEXT_DELTAS_OMITTED','NATIVE_TOOL_OUTPUT_5000_CHAR_LIMIT','ONLY_EXPOSED_CLI_EVENTS']},
 async prepare(){const inspection=await inspectHermes(target);if(!inspection.evaluationReady)throw Error(inspection.reasonCode);return {env:await loadAgentEnvironment()};},
 async run({context,caseDirectory,cwd,prompt,deadlineMs,signal,onSession}){
  const home=path.join(caseDirectory,'hermes-home');await mkdir(home,{recursive:true,mode:0o700});
  const input=path.join(caseDirectory,'agent-input.txt');await writeFile(input,prompt,{mode:0o600});
  const env={...context.env,HERMES_HOME:home,TERMINAL_CWD:cwd,TERMINAL_ENV:'local',PYTHONUNBUFFERED:'1'};
  const args=['chat','--query-file',input,'--oneshot','--format','stream-json','--provider','deepseek','--model',target.model,'--toolsets','terminal,file','--ignore-rules','--max-turns','80','--run-budget',String(Math.max(1,Math.floor(deadlineMs/1000)))];
  return runProcess({command:target.executable,args,cwd,env,deadlineMs,signal,capture:new Capture('hermes'),onEvent:hermesEvent,onSession});
 },dispose(){}
};}
