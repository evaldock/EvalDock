import {createAdapter} from '../../adapters/shared/run.mjs';
import {createWorkBuddyAdapter} from '../../adapters/workbuddy/adapter.mjs';

/** Read real current interfaces without submitting a task; never infer tools from an install. */
export async function plannerTargetInfo({root,control,workbuddy,agents},{agentKind,targetId}){
  if(agentKind==='dsh'&&targetId!=='dsh'||agentKind==='workbuddy'&&targetId!=='workbuddy')throw Error('所选 Agent 不存在');
  const owner=agentKind==='dsh'?control:agentKind==='workbuddy'?workbuddy:agents[agentKind];
  if(!owner||owner.active||owner.busy)throw Error('请选择已就绪且空闲的 Agent');
  if(agentKind==='dsh'){
    const status=await control.status(true);
    if(status.status!=='RUNNING'||status.error||!status.modelReady||status.needsRestart||status.externalEval||status.runningSessions>0)throw Error('请先完成 DSH 的连接和运行条件检查');
    const inspection=status.staticInspection,target=inspection?.target;
    if(!target)throw Error('无法读取 DSH 的实际能力信息');
    return {target_type:'FULL_AGENT',agent_kind:'dsh',agent_version:status.version??'UNKNOWN',tools:target.toolDetails??[],tool_delta:{},permission_preset:target.permissionPreset??'UNKNOWN',sandbox_mode:target.sandboxMode??'UNKNOWN',probe:{configured:false},plugins:inspection.plugins??[],limitations:['Only declared tools and the live connection were inspected. External environments are not provisioned.']};
  }
  const adapter=agentKind==='workbuddy'?createWorkBuddyAdapter():await createAdapter(root,targetId);
  if(agentKind!=='workbuddy'&&adapter.kind!==agentKind)throw Error('所选 Agent 类型与安装不一致');
  const inspection=await adapter.inspect();
  if(!inspection.evaluationReady)throw Error('请先完成所选 Agent 的连接、登录和运行条件检查');
  return adapter.staticInfo(inspection);
}
