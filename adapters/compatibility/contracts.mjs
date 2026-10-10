/** Host-owned acceptance rules. Never loaded into the tested Agent. */
export const SUITE_VERSION='evaldock.compatibility/v1';
export const PROTOCOLS=Object.freeze({
  'dsh-web':'dsh.web-session/v1','dsh-headless':'dsh.headless-session/v1',
  qwenwork:'qwen.rpc-stream/v1',doubaowork:'doubao.native-task/v1',workbuddy:'workbuddy.session-port/v1',
  pi:'pi.json-stream/v1',langgraph:'langgraph.events/v1',hermes:'hermes.stream-json/v1',openclaw:'openclaw.transcript/v1',
});
export function capabilities(adapter){
  const tools=adapter.kind!=='langgraph'||(adapter.configuration?.tools??[]).length>0;
  return ['text','isolation','cancel',...(tools?['files','tools']:[]),...(adapter.kind==='doubaowork'?['subtasks']:[])];
}
export function classify(code=''){
  if(/APP_ID_MISMATCH|INTERFACE_CHANGED|EVENT_PROTOCOL|CONTRACT_BROKEN/.test(code))return 'INCOMPATIBLE';
  if(/HTTP_401|HTTP_403|ENVIRONMENT|CONFIGURATION_UNAVAILABLE|LOGIN|AUTH|NOT_INSTALLED|NOT_CONNECTED|WINDOW_NOT_READY|KEY_MISSING|RUNTIME|WORKSPACE|PERMISSION|QUOTA|NETWORK|BUSY|CLEANUP|CANCELLED/.test(code))return 'ENVIRONMENT_BLOCKED';
  return 'INDETERMINATE';
}
export function events(adapter,capture){
  return (capture.queue??[]).map((row,index)=>adapter.trace.normalizeEvent(row,capture.sessionId,index+1).data.event);
}
export function validateCapture(adapter,capture,{required=[],controlled=false,cancel=false}={}){
  const issues=[];
  const add=(code,status='INDETERMINATE')=>issues.push({code,status});
  if(capture.cleanup!=='STOPPED')add('AGENT_CLEANUP_UNCONFIRMED','ENVIRONMENT_BLOCKED');
  if(capture.error&&!(cancel&&/CANCELLED$/.test(capture.error)))add(capture.error,classify(capture.error));
  if(cancel){if(!/CANCELLED$/.test(capture.error??''))add('AGENT_CANCEL_NOT_OBSERVED');return issues;}
  if(!capture.result?.stopReason||capture.done===false)add('AGENT_COMPLETION_UNCONFIRMED');
  if(!capture.final?.trim())add('AGENT_RESPONSE_EMPTY');
  const rows=events(adapter,capture),calls=new Map(),results=new Map();
  for(const event of rows){
    if(event.data?.sessionId&&event.data.sessionId!==capture.sessionId)add('AGENT_SESSION_CONTRACT_BROKEN','INCOMPATIBLE');
    if(event.type==='tool/call')calls.set(event.data?.callId,event.data);
    if(event.type==='tool/result')results.set(event.data?.callId,event.data);
  }
  // Runtime tasks may legitimately choose no tools. Controlled tasks must exercise them.
  if(required.includes('tools')){
    if((capture.unknownEvents??[]).some(e=>/tool/i.test(e.type)||(e.keys??[]).some(k=>/tool.?call|rawInput|rawOutput/i.test(k))))add('AGENT_TOOL_CONTRACT_BROKEN','INCOMPATIBLE');
    if(controlled&&!calls.size)add('AGENT_TOOL_BEHAVIOR_NOT_COVERED');
    for(const [id,call] of calls){
      const result=results.get(id);
      if(!id||!Object.hasOwn(call,'arguments')||!result||!Object.hasOwn(result,'result')||result.status&& !['completed','failed'].includes(result.status))add('AGENT_TOOL_EVIDENCE_INCOMPLETE');
    }
    for(const id of results.keys())if(!calls.has(id))add('AGENT_TOOL_EVIDENCE_INCOMPLETE');
    if(capture.omitted||capture.clipped)add('AGENT_EVIDENCE_TRUNCATED');
  }
  if(required.includes('subtasks')){
    const delegated=rows.filter(e=>e.type==='task/delegated');
    if(controlled&&!delegated.length)add('AGENT_SUBTASK_BEHAVIOR_NOT_COVERED');
    for(const e of delegated)if(!rows.some(r=>r.type==='task/completed'&&r.data?.threadId===e.data?.threadId))add('AGENT_SUBTASK_TERMINATION_MISSING');
  }
  return [...new Map(issues.map(i=>[i.code,i])).values()];
}
export function conclusion(issues){
  return ['ENVIRONMENT_BLOCKED','INCOMPATIBLE','INDETERMINATE'].find(s=>issues.some(i=>i.status===s))??'COMPATIBLE';
}
