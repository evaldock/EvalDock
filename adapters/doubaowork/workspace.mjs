/** Runs inside the installed desktop renderer; uses the user's existing authorization mode. */
export async function prepareWorkspace({sessionId,cwd}){
 const modules=window.__evaldockDoubaoBindings;
 const env=await modules.environment.sandboxEnvironmentController.query();
 if(!env.isReady||!env.environmentId)throw Error('AGENT_LOCAL_RUNTIME_UNAVAILABLE');
 const client=await modules.workspace.buildGeneralAgentCompletionTaskParam('local_'+sessionId,cwd),auth=modules.authorization.wn();
 const sandbox=await modules.sandbox.H({cwd,envId:client.sandbox_id,from:'main',globalSkillPath:client.agent_workspace?.agent_workspace,sandboxAuthType:auth.sandboxAuthType,sendContext:{localConversationId:'local_'+sessionId,localMessageId:sessionId}});
 const sandboxId=sandbox.sandboxId??sandbox.instanceId;
 if(!sandboxId)throw Error('AGENT_WORKSPACE_UNAVAILABLE');
 if(!(sandbox.resolvedSharedFolders??[]).includes(cwd)){try{await modules.release.rS({communicate:modules.communicate._(),request:{sandboxId,localMessageId:sessionId,agentType:'organizer',source:'evaldock'}});}catch{}throw Error('AGENT_WORKSPACE_NOT_GRANTED');}
 return {runtime_type:2,client_option:{...client,sandbox_id:sandboxId,shared_folder_path:sandbox.resolvedSharedFolders,sandbox_auth_type:auth.sandboxAuthType}};
}
