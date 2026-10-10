import {buildTrace as assemble} from '../shared/evidence.mjs';
export {seedWorkspace,snapshot,collectFiles,TRACE_MAX_BYTES,seal} from '../shared/evidence.mjs';
export function normalizeEvent(record,sessionId,seq){
  const raw=record.event,u=raw.update??raw,type=u.sessionUpdate??raw.type;let event;
  if(type==='tool_call')event={type:'tool/call',data:{name:u._meta?.toolName??u.title??u.kind??'unknown',callId:u.toolCallId,arguments:u.rawInput??null}};
  else if(type==='tool_call_update')event={type:'tool/result',data:{name:u._meta?.toolName??u.title??u.kind??'unknown',callId:u.toolCallId,result:u.rawOutput??u.content??null,isError:u.status==='failed',status:u.status}};
  else event={type:'workbuddy/'+(type??'event'),data:u};
  return JSON.parse(JSON.stringify({at:record.at,kind:'workbuddy/acp',data:{sessionId,event:{...event,seq}},provenance:{nativeType:type??null,channel:'session:event (MessagePort)'}}));
}

export const workbuddyTrace={kind:'workbuddy',sourceType:'WORKBUDDY_PROBE',externalSchema:'workbuddy.desktop.session-event/v1',blindSpots:['TOKEN_THOUGHT_STREAM_OMITTED','INTERMEDIATE_ASSISTANT_TEXT_OMITTED','TOOL_INVENTORY_NOT_EXPOSED','SESSION_EVENT_CONTRACT_VALIDATED_AT_RUNTIME'],normalizeEvent};
export const buildTrace=input=>assemble({...input,agent:workbuddyTrace});
