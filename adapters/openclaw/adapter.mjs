import {checkCliInterface} from '../shared/cli-interface.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Capture,runProcess,normalizedEvent} from '../shared/capture.mjs';
import {loadAgentEnvironment,staticInfo} from '../shared/registry.mjs';
const exec=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
export function openClawEvent(row,capture){
 if(row.type==='runtime/result'){
  const r=row.data;capture.finalText(r.final??'');capture.nativeSessionId=r.sessionId;
  capture.result={stopReason:r.ok&&r.status==='ok'?'end_turn':'error',usage:r.usage};
  if(!r.ok||r.status!=='ok'){capture.error='OPENCLAW_EXECUTION_FAILED';capture.add('runtime/error',{message:r.error,status:r.status});}
 }else if(row.type==='runtime/error'||row.type==='probe/error'){capture.error='OPENCLAW_EXECUTION_FAILED';capture.add(row.type,row.data,row.at);}
 else capture.add(row.type,row.data,row.at);
}
export async function inspectOpenClaw(target,{execCommand=exec,loadEnvironment=loadAgentEnvironment}={}){
 const s={agentKind:'openclaw',name:target.name,installRoot:target.sourceRoot,version:null,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,driver:'OPENCLAW_COMPLETION_TRANSCRIPT',permissionPreset:'HEADLESS_CODING_WORKSPACE',components:[],toolSchemas:['read','write','edit','exec','process'].map(name=>({name,source:'OPENCLAW_CODING_PROFILE_DECLARATION'})),limitations:['任务结束触发一次原生会话记录读取；保留工具调用、结果和最终回答，不轮询。','每题独立配置、状态、会话和工作目录，不接入聊天渠道。','仅投递文本和工作目录文件；系统级状态不自动重置。']};
 try{const r=await execCommand(target.node,[target.executable,'--version'],{timeout:15000,maxBuffer:65536}).catch(()=>({stdout:''}));s.version=r.stdout.trim().split("\n")[0]||null;s.status='INSTALLED';await checkCliInterface({command:target.node,args:[target.executable,'agent','exec','--help'],required:['--config', '--state-dir', '--cwd', '--model', '--message-file', '--code-mode', '--json', '--timeout'],execCommand});s.executionReady=true;s.probeReady=true;await loadEnvironment();s.status='READY';s.evaluationReady=true;}
 catch(e){s.evaluationReady=false;s.executionReady=false;s.probeReady=false;if(s.status!=='NOT_INSTALLED')s.status='UNAVAILABLE';s.reasonCode=/^AGENT_[A-Z_]+$/.test(e.message)?e.message:'OPENCLAW_CONFIGURATION_UNAVAILABLE';}
 return s;
}
export function createOpenClawAdapter(target){return {
 configuration:target,kind:'openclaw',targetId:target.id,name:target.name,supportsAttachments:false,
 inspect:()=>inspectOpenClaw(target),staticInfo:s=>{const info=staticInfo(target,s);return {...info,probe:{...info.probe,order_status:'COMPLETION_TRIGGERED'}};},
 trace:{kind:'openclaw',sourceType:'OPENCLAW_PROBE',externalSchema:'openclaw.transcript/2026.9.6',normalizeEvent:(r,id,seq)=>({...normalizedEvent(r,id,seq),provenance:{channel:'native transcript read once after process termination'}}),blindSpots:['INTERNAL_THOUGHT_NOT_OBSERVED','INTERMEDIATE_TEXT_OMITTED','COMPLETION_TRIGGERED_NOT_LIVE','BOUNDED_LAST_256_TRANSCRIPT_ROWS']},
 async prepare(){const s=await inspectOpenClaw(target);if(!s.evaluationReady)throw Error(s.reasonCode);return {env:await loadAgentEnvironment()};},
 async run({context,caseDirectory,cwd,prompt,deadlineMs,signal,onSession}){
  const state=path.join(caseDirectory,'openclaw-state');await mkdir(state,{recursive:true,mode:0o700});
  const input=path.join(caseDirectory,'agent-input.txt'),config=path.join(caseDirectory,'openclaw.json');
  await writeFile(input,prompt,{mode:0o600});
  await writeFile(config,JSON.stringify({models:{providers:{deepseek:{baseUrl:'https://api.deepseek.com/v1',apiKey:'${DEEPSEEK_API_KEY}',api:'openai-completions',models:[{id:target.model,name:target.model,contextWindow:1000000,maxTokens:8192,reasoning:false,input:['text']}]}}},agents:{defaults:{model:{primary:'deepseek/'+target.model},workspace:cwd}},plugins:{enabled:false}}),{mode:0o600});
  const env={...context.env,PATH:path.dirname(target.node)+':'+context.env.PATH,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config,OPENCLAW_NO_RESPAWN:'1'};
  const args=[path.join(here,'runner.mjs'),target.node,target.executable,'agent','exec','--config',config,'--state-dir',state,'--cwd',cwd,'--model','deepseek/'+target.model,'--message-file',input,'--code-mode','direct','--json','--timeout',String(Math.max(1,Math.floor(deadlineMs/1000)))];
  const capture=new Capture('openclaw');
  await runProcess({command:target.node,args,cwd,env,deadlineMs,signal,capture,onEvent:openClawEvent,onSession});
  // The process has exited (or been cancelled): read only this Case's native session once.
  try{
   const r=await exec(target.node,[path.join(here,'transcript.mjs'),state,...capture.nativeSessionId?[capture.nativeSessionId]:[]],{timeout:10000,maxBuffer:400*1024,env});
   let body=r.stdout;for(const [k,v] of Object.entries(env))if(/KEY|TOKEN|SECRET|PASSWORD/.test(k)&&v.length>=8)body=body.split(v).join('[REDACTED]');
   const observed=JSON.parse(body);if(observed.error)throw Error(observed.error);
   for(const row of observed.queue)capture.add(row.event.type,row.event.data,row.at);
   capture.omitted+=observed.omitted;capture.clipped+=observed.clipped;capture.nativeSessionId=observed.nativeSessionId;
   if(!capture.final&&observed.final)capture.finalText(observed.final);
  }catch{capture.error??='OPENCLAW_PROBE_UNAVAILABLE';capture.add('probe/error',{code:'NATIVE_TRANSCRIPT_UNAVAILABLE'});}
  return capture.finish();
 },dispose(){}
};}
