import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Desktop,runSession} from './desktop.mjs';
import {inspectWorkBuddy} from './status.mjs';
import {workbuddyTrace} from './evidence.mjs';

export function createWorkBuddyAdapter({inspect=inspectWorkBuddy,driverFactory=()=>Desktop.connect()}={}) {
  return {
    kind:'workbuddy',targetId:'workbuddy',name:'WorkBuddy',supportsAttachments:false,
    promptRoot:path.join(path.dirname(fileURLToPath(import.meta.url)),'prompts'),
    trace:workbuddyTrace,
    inspect,
    staticInfo:inspection=>({
      target_type:'FULL_AGENT',agent_kind:'workbuddy',agent_version:inspection.version,status:'AVAILABLE',
      plugins:[],tools:[],tool_delta:{status:'NOT_APPLICABLE'},permission_preset:'APPLICATION_DEFAULT',
      sandbox_mode:'WORKSPACE_ONLY_NOT_SANDBOX',probe:{configured:true,schema:'evaldock.all-trace/v1',order_status:'CAPTURE_ORDER'},
      limitations:[...inspection.limitations,'Tool inventory is unknown. Select representative text and local-file BASELINE tasks. Do not infer integrations, external accounts or privileges. Chat attachments are not implemented in MVP; inputs must be workspace files.'],
    }),
    async prepare(){
      const desktop=await driverFactory();
      try {if(!await desktop.authenticated())throw Error('WORKBUDDY_LOGIN_REQUIRED');return desktop;}
      catch(error){desktop.close();throw error;}
    },
    run:({context,...input})=>runSession(context,input),
    dispose:context=>context?.close(),
  };
}
