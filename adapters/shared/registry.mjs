import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {homedir} from 'node:os';
import {platformEnvironment} from './platform-environment.mjs';

export async function loadTargets(root) {
  let document;
  try {document=JSON.parse(await readFile(path.join(root,'config/agents.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(document.schema!=='evaldock.agent-targets/v1'||!Array.isArray(document.targets))throw Error('AGENT_INVALID_TARGET_CONFIG');
  const ids=new Set();
  for(const target of document.targets){
    if(!/^[a-zA-Z0-9._-]{1,100}$/.test(target.id)||ids.has(target.id)||!['pi','langgraph','qwenwork','doubaowork','hermes','openclaw'].includes(target.kind))throw Error('AGENT_INVALID_TARGET_CONFIG');
    ids.add(target.id);
  }
  return document.targets;
}
export async function resolveTarget(root,id) {
  const target=(await loadTargets(root)).find(t=>t.id===id);
  if(!target)throw Error('AGENT_TARGET_NOT_FOUND');
  return target;
}
export async function readAgentModelKey({environment=process.env,file=path.join(homedir(),'.config/evaldock/agent-model.env'),legacyFile=path.join(homedir(),'.dsh/.env')}={}) {
  const read=async file=>{
    try{return parseEnv(await readFile(file,'utf8')).DEEPSEEK_API_KEY;}
    catch(error){if(error.code==='ENOENT')return undefined;throw error;}
  };
  return await read(file)||environment.DEEPSEEK_API_KEY||await read(legacyFile);
}
export async function loadAgentEnvironment({environment:source=process.env,...credentialOptions}={}) {
  // Only the target credential is available to child Agents; evaluator keys are excluded.
  const environment=platformEnvironment(source);
  const key=await readAgentModelKey({...credentialOptions,environment:source});
  if(!key)throw Error('AGENT_MODEL_KEY_MISSING');
  environment.DEEPSEEK_API_KEY=key;
  return environment;
}
export function staticInfo(target,inspection) {
  return {
    target_type:'FULL_AGENT',agent_kind:target.kind,agent_name:target.name,agent_version:inspection.version,
    status:inspection.evaluationReady?'AVAILABLE':'UNKNOWN',
    components:inspection.components??[],tools:inspection.toolSchemas??[],
    tool_delta:{status:'BASELINE_NOT_MEASURED'},
    permission_preset:inspection.permissionPreset,sandbox_mode:'WORKSPACE_ONLY_NOT_SANDBOX',
    probe:{configured:inspection.probeReady,schema:'evaldock.all-trace/v1',order_status:'EVENT_PUSH'},
    limitations:inspection.limitations,
    semantics:{tools:'DECLARED_AVAILABLE_NOT_PROOF_OF_USE',components:'EXPLICITLY_SELECTED_COMPONENTS'},
  };
}
