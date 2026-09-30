/** Runs inside the installed desktop renderer; uses the user's existing authorization mode. */
export async function prepareWorkspace({sessionId,cwd}){
 const r=window.__evaldockDoubaoRequire;await r.e('7153');
 const env=await r(209715).sandboxEnvironmentController.query();
 if(!env.isReady||!env.environmentId)throw Error('AGENT_LOCAL_RUNTIME_UNAVAILABLE');
 const client=await r(209874).buildGeneralAgentCompletionTaskParam('local_'+sessionId,cwd),auth=r(40111).wn();
 const sandbox=await r(876207).H({cwd,envId:client.sandbox_id,from:'main',globalSkillPath:client.agent_workspace?.agent_workspace,sandboxAuthType:auth.sandboxAuthType,sendContext:{localConversationId:'local_'+sessionId,localMessageId:sessionId}});
 const sandboxId=sandbox.sandboxId??sandbox.instanceId;
 if(!sandboxId)throw Error('AGENT_WORKSPACE_UNAVAILABLE');
 if(!(sandbox.resolvedSharedFolders??[]).includes(cwd)){try{await r(421540).rS({communicate:r(886735)._(),request:{sandboxId,localMessageId:sessionId,agentType:'organizer',source:'evaldock'}});}catch{}throw Error('AGENT_WORKSPACE_NOT_GRANTED');}
 return {runtime_type:2,client_option:{...client,sandbox_id:sandboxId,shared_folder_path:sandbox.resolvedSharedFolders,sandbox_auth_type:auth.sandboxAuthType}};
}
