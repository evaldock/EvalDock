import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {Capture,runProcess,normalizedEvent} from '../shared/capture.mjs';
import {loadAgentEnvironment,staticInfo} from '../shared/registry.mjs';

const exec=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
export async function inspectLangGraph(target,{execCommand=exec,loadEnvironment=loadAgentEnvironment}={}){
  const status={agentKind:'langgraph',name:target.name,version:null,installRoot:target.sourceRoot,status:'NOT_INSTALLED',evaluationReady:false,executionReady:false,probeReady:false,driver:'LANGGRAPH_EVENT_STREAM',permissionPreset:'GRAPH_DECLARED_TOOLS',components:[],toolSchemas:(target.tools??[]).map(name=>({name,source:'GRAPH_DECLARATION'})),limitations:['观测 Graph 推送的消息、工具与节点事件；不保留逐 token 输出和完整 state 快照。','声明工具不代表运行时已经调用；未暴露的内部事件不推断。','工作目录与进程隔离，不自动重置全局系统、账号或外部数据库。','中断会记录为未完成任务；当前控制台不提供 checkpoint 恢复。']};
  try{
    status.status='INSTALLED';
    const environment=await loadEnvironment(),home=await mkdtemp(path.join(tmpdir(),'evaldock-graph-check-'));
    try{
      const result=await execCommand(target.python,[path.join(here,'preflight.py'),target.entrypoint],{cwd:home,timeout:15000,maxBuffer:65536,env:{...environment,HOME:home,PYTHONPATH:path.join(target.sourceRoot,'src'),PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1',EVALDOCK_WORKSPACE:home,DEFAULT_MODEL:target.model??'deepseek-v4-flash',LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false',ANONYMIZED_TELEMETRY:'False',USE_FAKE_MODEL:'false'}});
      const check=JSON.parse(result.stdout);if(check.ready!==true)throw Error('LANGGRAPH_INTERFACE_UNAVAILABLE');
      status.version=check.version;status.executionReady=true;status.probeReady=true;status.status='READY';status.evaluationReady=true;
    }finally{await rm(home,{recursive:true,force:true});}
  }catch(error){status.status=status.status==='NOT_INSTALLED'?'NOT_INSTALLED':'UNAVAILABLE';status.evaluationReady=false;status.executionReady=false;status.probeReady=false;status.reasonCode=error.message==='AGENT_MODEL_KEY_MISSING'?error.message:'LANGGRAPH_INTERFACE_UNAVAILABLE';}
  return status;
}
export function langGraphEvent(row,capture){
  if(row.type==='assistant/final'){capture.finalText(row.data?.text??'');capture.finalTruncated||=!!row.data?.truncated;}
  else if(row.type==='runtime/completed')capture.result={stopReason:'end_turn'};
  else if(row.type==='runtime/error'){capture.error='LANGGRAPH_EXECUTION_FAILED';capture.add(row.type,row.data,row.at);}
  else if(row.type==='interrupt/raise'){capture.error='AGENT_TURN_INCOMPLETE';capture.add(row.type,row.data,row.at);}
  else capture.add(row.type,row.data,row.at);
}
export function createLangGraphAdapter(target){
  return {
    configuration:target,kind:'langgraph',targetId:target.id,name:target.name,supportsAttachments:false,
    workspaceDescription:cwd=>target.workspacePaths==='virtual-root'?'当前任务的独立工作目录。文件工具使用以 / 为根的虚拟路径（如 /input/context.md、/output/answer.json）；shell 使用当前目录的相对路径。不要把宿主机绝对路径传入虚拟文件工具。':cwd,
    inspect:()=>inspectLangGraph(target),staticInfo:s=>staticInfo(target,s),
    trace:{kind:'langgraph',sourceType:'LANGGRAPH_PROBE',externalSchema:'evaldock.langgraph.events/v1',normalizeEvent:normalizedEvent,blindSpots:['TOKEN_STREAM_OMITTED','STATE_SNAPSHOTS_OMITTED','ONLY_EXPOSED_GRAPH_EVENTS']},
    async prepare(){const s=await inspectLangGraph(target);if(!s.evaluationReady)throw Error(s.reasonCode);return {env:await loadAgentEnvironment()};},
    async run({context,caseDirectory,cwd,prompt,deadlineMs,signal,onSession,onActivity}){
      const home=path.join(caseDirectory,'runtime-home');await mkdir(home,{recursive:true,mode:0o700});
      const input=path.join(caseDirectory,'agent-input.json');
      await writeFile(input,JSON.stringify({task:prompt}),{mode:0o600});
      const capture=new Capture('langgraph');
      const args=['-u',path.join(here,'runner.py'),'--graph',target.entrypoint,'--input',input,'--thread',capture.sessionId];
      const env={...context.env,HOME:home,PYTHONPATH:path.join(target.sourceRoot,'src'),PYTHONUNBUFFERED:'1',EVALDOCK_WORKSPACE:cwd,DEFAULT_MODEL:target.model??'deepseek-v4-flash',LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false',ANONYMIZED_TELEMETRY:'False',USE_FAKE_MODEL:'false'};
      return runProcess({command:target.python,args,cwd,env,deadlineMs,signal,capture,onEvent:(row,c)=>{langGraphEvent(row,c);if(row.type==='node/start')onActivity?.();},onSession});
    },
    dispose(){},
  };
}
