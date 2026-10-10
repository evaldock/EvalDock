import {fileURLToPath} from 'node:url';
import {checkCliInterface} from '../shared/cli-interface.mjs';
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
  if(row.exit_code!==0){capture.error??='HERMES_EXECUTION_FAILED';capture.add('runtime/error',{message:row.error??'Hermes did not complete',exitCode:row.exit_code},at);}
 }else{capture.seen++;capture.noise++;}
}
/** Restore IDs from the owned native DB, never pair parallel calls by arrival order. */
export function restoreHermesEvidence(captured,rows){
 const events=[];
 for(const row of rows){
  if(typeof row.timestamp!=='number'||!Number.isFinite(row.timestamp))throw Error('AGENT_HERMES_EVIDENCE_INCOMPLETE');
  const at=new Date(row.timestamp*1000).toISOString();
  if(row.tool_calls){for(const call of JSON.parse(row.tool_calls)){
   if(!call.id||!call.function?.name||call.function.arguments===undefined)throw Error('AGENT_TOOL_CONTRACT_BROKEN');
   events.push({at,type:'tool/call',data:{callId:call.id,name:call.function.name,arguments:call.function.arguments}});
  }}
  if(row.role==='tool'){
   if(!row.tool_call_id||row.content===null)throw Error('AGENT_TOOL_CONTRACT_BROKEN');
   events.push({at,type:'tool/result',data:{callId:row.tool_call_id,name:row.tool_name,result:row.content}});
  }
 }
 for(const type of ['tool/call','tool/result']){
  const old=captured.queue.filter(r=>r.event.type===type),fresh=events.filter(e=>e.type===type);
  if(old.length!==fresh.length)throw Error('AGENT_HERMES_EVIDENCE_INCOMPLETE');
  if(type==='tool/call'&&JSON.stringify(old.map(r=>r.event.data.name).sort())!==JSON.stringify(fresh.map(e=>e.data.name).sort()))throw Error('AGENT_TOOL_CONTRACT_BROKEN');
 }
 const c=new Capture('hermes'),{queue,...metadata}=captured;Object.assign(c,metadata);
 for(const row of queue)if(!row.event.type.startsWith('tool/'))c.add(row.event.type,row.event.data,row.at);
 for(const event of events)c.add(event.type,event.data,event.at);
 const result=c.finish();result.toolEvidenceSource='OWNED_NATIVE_SESSION_DATABASE';return result;
}
export async function inspectHermes(target,{execCommand=exec,loadEnvironment=loadAgentEnvironment}={}){
 const result={agentKind:'hermes',name:target.name,installRoot:target.sourceRoot,version:null,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,driver:'HERMES_JSON_STREAM',permissionPreset:'CLI_NONINTERACTIVE',components:[],toolSchemas:['terminal','read_file','write_file','patch'].map(name=>({name,source:'HERMES_TOOLSET_DECLARATION'})),limitations:['原生 JSON 事件推送；仅保留工具调用、结果、最终回答与真实用量。','原生工具输出最多 5000 字符；逐 token 文本和内部推理不保留。','每题独立 Hermes 状态与工作目录；进程隔离不等于系统沙箱。','CLI 缺失调用 ID 时读取本题原生会话数据库；仍缺失时不推断对应关系。']};
 try{const r=await execCommand(target.executable,['--version'],{timeout:12000,maxBuffer:65536}).catch(()=>({stdout:''}));result.version=r.stdout.trim().split("\n")[0]||null;result.status='INSTALLED';await checkCliInterface({command:target.executable,args:['chat','--help'],required:['--query-file', '--oneshot', '--format', '--provider', '--model', '--toolsets', '--ignore-rules', '--max-turns', '--run-budget'],execCommand});result.executionReady=true;result.probeReady=true;await loadEnvironment();result.status='READY';result.evaluationReady=true;}
 catch(e){result.evaluationReady=false;result.executionReady=false;result.probeReady=false;if(result.status!=='NOT_INSTALLED')result.status='UNAVAILABLE';result.reasonCode=/^AGENT_[A-Z_]+$/.test(e.message)?e.message:'HERMES_CONFIGURATION_UNAVAILABLE';}
 return result;
}
export function createHermesAdapter(target){return {
 configuration:target,kind:'hermes',targetId:target.id,name:target.name,supportsAttachments:false,
 inspect:()=>inspectHermes(target),staticInfo:s=>staticInfo(target,s),
 trace:{kind:'hermes',sourceType:'HERMES_PROBE',externalSchema:'hermes.stream-json/0.21',normalizeEvent:normalizedEvent,blindSpots:['THOUGHT_AND_TEXT_DELTAS_OMITTED','NATIVE_TOOL_OUTPUT_5000_CHAR_LIMIT','ONLY_EXPOSED_CLI_EVENTS']},
 async prepare(){const inspection=await inspectHermes(target);if(!inspection.evaluationReady)throw Error(inspection.reasonCode);return {env:await loadAgentEnvironment()};},
 async run({context,caseDirectory,cwd,prompt,deadlineMs,signal,onSession}){
  const home=path.join(caseDirectory,'hermes-home');await mkdir(home,{recursive:true,mode:0o700});
  const input=path.join(caseDirectory,'agent-input.txt');await writeFile(input,prompt,{mode:0o600});
  const env={...context.env,HERMES_HOME:home,TERMINAL_CWD:cwd,TERMINAL_ENV:'local',PYTHONUNBUFFERED:'1'};
  const args=['chat','--query-file',input,'--oneshot','--format','stream-json','--provider','deepseek','--model',target.model,'--toolsets','terminal,file','--ignore-rules','--max-turns','80','--run-budget',String(Math.max(1,Math.floor(deadlineMs/1000)))];
  const captured=await runProcess({command:target.executable,args,cwd,env,deadlineMs,signal,capture:new Capture('hermes'),onEvent:hermesEvent,onSession});
  if(captured.cleanup==='STOPPED'&&!signal?.aborted&&captured.nativeSessionId&&captured.queue.some(r=>String(r.event.data?.callId).startsWith('unpaired-'))){
   try{const {stdout}=await exec(path.join(path.dirname(target.executable),'python'),[fileURLToPath(new URL('./session-evidence.py',import.meta.url)),path.join(home,'state.db'),captured.nativeSessionId],{timeout:10000,maxBuffer:1048576});let safe=stdout;for(const [key,secret] of Object.entries(env))if(/KEY|TOKEN|SECRET|PASSWORD/.test(key)&&secret.length>=8)safe=safe.split(secret).join('[REDACTED]');return restoreHermesEvidence(captured,JSON.parse(safe));}
   catch{captured.error??='AGENT_HERMES_EVIDENCE_INCOMPLETE';}
  }
  return captured;
 },dispose(){}
};}
