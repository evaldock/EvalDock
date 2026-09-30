/** Serialized into the renderer. Reads only newly owned sessions and discovered child threads. */
export async function startDoubao({sessionId,prompt,cwd},createCapture,prepareLocal){
 const root=window.__evaldockDoubaoSessions??=Object.create(null);if(root[sessionId])throw Error('AGENT_DUPLICATE_SESSION');
 const r=window.__evaldockDoubaoRequire;if(!r(35673).getIsLoggedIn())throw Error('AGENT_LOGIN_REQUIRED');
 const im=await r(788925).D('chatIMService'),service=await im.getMessageService(),ts=await im.getThreadMessageService();
 const config=r(521109).Wp('chatInputStore').getState(),mode=config.modeSelectValue;
 if(!r(63487).MR(mode,config.modeSelectConfigs))throw Error('AGENT_OFFICE_MODE_UNAVAILABLE');
 const taskParam=await prepareLocal({sessionId,cwd});
 const c=createCapture(sessionId),types=r(201753).zcD,threads=new Map(),store=r(734835).I;
 let chatTerminal=false,chatSuccess=false,disposed=false,submitted=false,subscription,unwatch,finalCheckScheduled=false,released=false,cancelling=false;
 const stateListeners=new Set(),notifyState=()=>{for(const fn of stateListeners)fn();};
 const terminalStatuses=new Set([2,3,4]);
 const finishIfReady=()=>{
  if(cancelling||c.done||!chatTerminal||[...threads.values()].some(t=>!t.terminal||t.loading))return;
  if(!chatSuccess)return c.finish('AGENT_TASK_FAILED');
  if([...threads.values()].some(t=>t.failed))return c.finish('AGENT_TASK_FAILED');
  const finals=[...threads.values()].filter(t=>t.kind!=='sub_agent'&&t.final).map(t=>t.final);
  if(finals.length)c.text(finals.join('\n\n'));
  c.finish(c.final.trim()?null:'AGENT_RESPONSE_EMPTY');
 };
 const check=()=>{if(finalCheckScheduled)return;finalCheckScheduled=true;queueMicrotask(()=>{finalCheckScheduled=false;finishIfReady();});};
 const fail=e=>c.finish(/^AGENT_[A-Z_]+$/.test(e?.message??'')?e.message:'AGENT_CAPTURE_FAILED');
 const scanThread=(id,t)=>{
  if(disposed||c.done&&!cancelling)return;
  const map=store.getState().messageMap[id]??{};if(t.map===map)return;t.map=map;
  const rows=Object.values(map);if(rows.length>32)c.omitted+=rows.length-32;
  for(const m of rows.slice(-32)){
   if(t.seen.get(m.message_id)===m)continue;t.seen.set(m.message_id,m);while(t.seen.size>32)t.seen.delete(t.seen.keys().next().value);
   if(m.user_type===1)continue;observe(m,t);
   let asyncJob;try{asyncJob=JSON.parse(m.ext?.async_job??'{}');}catch{}
   if(m.stage===4&&terminalStatuses.has(asyncJob?.status)){t.terminal=true;t.failed=asyncJob.status!==2;}
  }
  notifyState();check();
 };
 const follow=(id,kind='organizer')=>{
  id=String(id);if(threads.has(id))return;
  if(threads.size>=32){c.omitted++;c.finish('AGENT_THREAD_LIMIT');return;}
  const t={id,kind,terminal:false,failed:false,loading:true,final:'',seen:new Map(),map:null};threads.set(id,t);
  c.add('task/delegated',{threadId:id,kind});
  // One bootstrap read when a task card appears. Native service resumes its event
  // stream; subsequent collection is store subscription, never timer/history polling.
  (async()=>{await ts.loadThreadMessageList({threadId:id,options:{limit:20}});scanThread(id,t);
   if(!t.terminal){const info=await r(639732).V({thread_id:id});const status=info.data?.thread_info?.ext?.thread_status;if(['completed','failed','cancelled','canceled','terminated'].includes(status)){t.terminal=true;t.failed=status!=='completed';}}
  })().catch(fail).finally(()=>{t.loading=false;notifyState();check();});
 };
 const observe=(m,thread)=>{
  if(disposed||c.done)return;
  if(m.error_details?.has_error){c.finish('AGENT_TASK_FAILED');return;}
  const blocks=m.content_blocks_v2??m.content_block??m.content_blocks??[];let final='';
  for(const block of blocks){
   const content=block.content??{},data=block.content_obj??content.file_operation_block??content.super_task_tool_block??content.generic_tool_block??content.gui_tool_block;
   const delegated=content.complex_task_block??content.task_card_block;
   if(delegated?.thread_id)follow(delegated.thread_id,delegated.display_type??'organizer');
   if(block.block_type===types.BLOCK_TEXT&&block.control_info?.is_visible!==false){const text=content.text_block?.text??block.content_obj?.text;if(typeof text==='string'&&text.trim())final=text;}
   if([types.BLOCK_SUPERTASK_TOOL,types.BLOCK_GENERICTOOL,types.BLOCK_GUI_TOOL,types.BLOCK_FILE_OPERATION].includes(block.block_type)){
    const callId=data?.id??block.block_id??block.id;if(!callId){c.omitted++;continue;}
    const file=block.block_type===types.BLOCK_FILE_OPERATION,display=data?.display_content;
    const name=file?(data?.file_type==='shell'?'Shell':({1:'Read',2:'Write'}[data?.operation_type]??'FileOperation')):(data?.tool_name??data?.name??'office_tool_'+block.block_type);
    const args=file?{path:data?.path,operation:display?.operation}:data?.input??data?.arguments??{observedBlock:content};
    c.add('tool/call',{callId,name,arguments:args,...thread?{threadId:thread.id}:{}});
    if(block.is_finish===true||data?.is_finish===true||data?.is_finish===1)c.add('tool/result',{callId,name,result:display??data?.output??data?.result??data??{observedBlock:content},isError:!!data?.is_error||typeof display?.exit_code==='number'&&display.exit_code!==0});
   }
   if([types.BLOCK_PERMISSION_APPLY,types.BLOCK_INTERACTION_ASK].includes(block.block_type)&&block.is_finish!==true)c.finish('AGENT_INTERACTION_REQUIRED');
  }
  if(final){if(thread)thread.final=final.slice(0,65536);else if(!threads.size)c.text(final);}
  c.seen++;
 };
 unwatch=store.subscribe(()=>{for(const [id,t]of threads)scanThread(id,t);});
 const release=async()=>{if(released)return;released=true;try{return await r(421540).rS({communicate:r(886735)._(),request:{agentType:'organizer',localMessageId:sessionId,sandboxId:taskParam.client_option.sandbox_id,source:'evaldock'}});}catch{return null;}};
 root[sessionId]={wait:c.wait,async cancel(){
  cancelling=true;
  for(const t of threads.values())if(!t.terminal){try{ts.markCurrentSessionUserCancel({threadId:t.id});const res=await r(609347).iv.AGWTaskTerminate({thread_id:t.id});const info=await r(639732).V({thread_id:t.id});const status=info.data?.thread_info?.ext?.thread_status;t.terminal ||= res.code===0&&['completed','failed','cancelled','canceled','terminated'].includes(status);}catch{}}
  if(submitted&&!chatTerminal){try{await service.breakMessage({session:service.lifecycleRegistry.getSession(sessionId)});}catch{}}
  const confirmed=()=>(!submitted||chatTerminal)&&[...threads.values()].every(t=>t.terminal&&!t.loading);
  if(!confirmed())await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);stateListeners.delete(checkState);resolve();},checkState=()=>{if(confirmed())finish();};const timer=setTimeout(finish,12000);stateListeners.add(checkState);checkState();});
  const stopped=confirmed();
  c.finish('AGENT_CANCELLED');await release();return stopped;
 },async extract(){disposed=true;unwatch?.();subscription?.unsubscribe();await release();delete root[sessionId];return {...c.extract(),backgroundThreadIds:[...threads.keys()],workspace:cwd};}};
 try{
  const message=r(957165).createSendMessage({conversationContext:{local_conversation_id:'local_'+sessionId,bot_id:r(656207).IO(r(71834).NW.getState())},message:{unique_id:sessionId,content_blocks_v2:[r(446276).mapTextToTextBlock(prompt)],ext:{autoNavigate:'0',conversation_mode:'office',use_deep_think:mode,agent_mode:'1',general_task_param:JSON.stringify(taskParam)}}});
  service.sendMessage({sessionId,messages:[message],sendMode:'normal',session:{reportParams:{}}});submitted=true;
  const native=service.lifecycleRegistry.getSession(sessionId);if(typeof native?.subscribe!=='function')throw Error('AGENT_INTERFACE_CHANGED');subscription=native.subscribe();
  (async()=>{try{for await(const {message:m}of subscription){if(!m)continue;observe(m);if(m.final_status?.session){chatTerminal=true;notifyState();chatSuccess=m.final_status.session==='Success';check();}}
   if(!chatTerminal)c.finish('AGENT_STREAM_CLOSED');else check();
  }catch(e){fail(e);}})();
 }catch(e){fail(e);}
 return {sessionId};
}
