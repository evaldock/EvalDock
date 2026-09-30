let liveSnapshot=null,liveFollowRun=null;
function displayAgent(id){
 const record=resourceSnapshot.agents.find(a=>a.id===id);
 if(record?.agentKind&&record.agentKind!=='dsh')return record.name||record.agentKind;
 const named=liveSnapshot?.names?.agents?.[id];if(named)return named;
 const a=historicalAgents.find(a=>a.id===id);const ps=a?.runs?.find(r=>r.staticPlugins?.length)?.staticPlugins;
 if(ps?.length)return 'DSH'+[...new Set(ps.map(p=>p.name).filter(n=>n&&!['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'].includes(n)))].sort().map(n=>' + '+n).join('');
 return id==='vm.real-dsh-web'?'DSH Web':id==='vm.real-dsh-headless'?'DSH Headless':id;
}
function runCombinationName(agent,run){
 const kind=run.agentKind||agent.agentKind||resourceSnapshot.agents.find(a=>a.id===agent.id)?.agentKind||'dsh';
 const unique=items=>[...new Set(items.filter(Boolean))].sort();
 if(kind==='dsh'){
  const recorded=run.staticPlugins??[];
  const plugins=unique(recorded.map(p=>p.name).filter(n=>!['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'].includes(n)));
  return 'DSH'+plugins.map(n=>' + '+n).join('');
 }
 if(kind==='pi'){
  const extensions=unique((run.components??[]).filter(c=>c.kind==='EXTENSION').map(c=>c.name));
  return 'Pi'+extensions.map(n=>' + '+n).join('');
 }
 return run.agentName||({workbuddy:'WorkBuddy',langgraph:'LangGraph'}[kind]??displayAgent(agent.id));
}
function testedAgentEntries(){
 const items=historicalAgents.flatMap(agent=>(agent.runs??[]).map(run=>({agentId:agent.id,runId:run.id,base:runCombinationName(agent,run),startedAt:run.startedAt??run.updatedAt??'',status:run.status})));
 items.sort((a,b)=>(Date.parse(a.startedAt)||0)-(Date.parse(b.startedAt)||0)||a.runId.localeCompare(b.runId));
 for(const item of items)item.name=displayAgentRun(item.agentId,item.runId);
 return items.reverse();
}
function displayAgentRun(agentId,runId){
 const agent=historicalAgents.find(a=>a.id===agentId),run=agent?.runs.find(r=>r.id===runId);
 const record=resourceSnapshot.agents.find(a=>a.id===agentId);
 const kind=run?.agentKind||agent?.agentKind||record?.agentKind||'dsh';
 const job=allControlJobs().find(j=>j.targetId===agentId&&(j.runId||j.id)===runId);
 const current=run??{id:runId,agentKind:kind,staticPlugins:job?.pluginSelection??[],components:[],agentName:({dsh:'DSH',pi:'Pi',openclaw:'OpenClaw',hermes:'Hermes',workbuddy:'WorkBuddy',qwenwork:'千问办公',doubaowork:'豆包办公',langgraph:'LangGraph'}[kind]??kind)};
 return runCombinationName(agent??{id:agentId,agentKind:kind,runs:[]},current)+' + '+displayRun(agentId,runId);
}
function displayRun(agentId,runId){
 const named=liveSnapshot?.names?.runs?.[agentId+'::'+runId]?.runName;
 if(named)return named;
 const run=historicalAgents.find(a=>a.id===agentId)?.runs.find(r=>r.id===runId);
 const job=allControlJobs().find(j=>j.targetId===agentId&&(j.runId||j.id)===runId);
 const date=new Date(job?.createdAt??run?.startedAt);
 if(!Number.isFinite(date.getTime()))return runId;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
 return parts.year+parts.month+parts.day+'-'+parts.hour+parts.minute+parts.second;
}
function displayJob(job){return displayAgentRun(job.targetId,job.runId||job.id);}
function displayCase(c,index){return 'C'+String(c.ordinal??index+1).padStart(2,'0')+' · '+(c.title||c.id);}
async function refreshLiveObservation(){
 try{const r=await fetch('/live-observation.json',{cache:'no-cache',signal:AbortSignal.timeout(5000)});if(r.ok){const next=await r.json();if(next.version===1)liveSnapshot=next;}}catch{}
}
function liveUpdatesFor(data){
 if(!liveSnapshot||liveSnapshot.live?.active&&Date.now()-(controlSnapshot?.observationCheckedAt??0)>45000)return data;
 const extra=(liveSnapshot.updates||[]).filter(n=>{
  const j=controlSnapshot?.jobs.find(j=>j.runId===n.run.id&&j.targetId===n.agentId);
  // A stale sidecar must never replace a newer terminal state or current Case.
  return j&&j.state===({COMPLETED:'SUCCEEDED',PLAN_UNSATISFIABLE:'FAILED'}[n.run.status]||n.run.status)&&(j.progress?.current?.caseId===liveSnapshot.live?.caseId||!j.progress?.active);
 });
 return [...data.filter(n=>!extra.some(x=>x.agentId===n.agentId&&x.run.id===n.run.id)),...extra];
}
function livePanel(job,caseId){
 const live=liveSnapshot?.liveCases?.find(c=>c.caseId===caseId&&c.runId===job?.runId)??liveSnapshot?.live;if(!job||!live||live.runId!==job.runId||live.agentId!==job.targetId||(caseId&&caseId!==live.caseId))return '';
 const stale=live.active&&(Date.now()-(controlSnapshot?.observationCheckedAt??0)>45000||!!live.error),phase=stale?'观测连接待恢复':live.phase;
 const stamp=t=>t?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'—';
 const entries=(live.entries||[]).slice(-10).reverse(),latest=entries.find(e=>e.kind==='tool');
 const heading='C'+String(live.ordinal||1).padStart(2,'0')+' · '+(live.title||live.caseId||'准备中');
 return '<section class="control-panel live-panel" data-live-run="'+esc(live.runId)+'"><div class="live-heading"><div><h2>实时执行过程</h2><strong>'+esc(heading)+'</strong></div><span class="live-phase '+(stale?'stale':'')+'">'+esc(phase)+'</span></div>'+
 '<div class="live-facts"><span>步骤 <b>'+esc(live.steps??'—')+'</b></span><span>最近活动 <b>'+stamp(live.lastActivity)+'</b></span><span>更新 <b>'+stamp(liveSnapshot.observedAt)+'</b></span><span>'+esc(live.model||'')+'</span></div>'+
 (latest?'<div class="live-current"><b>'+esc(latest.name)+'</b><span>'+esc(latest.summary||'')+'</span></div>':'')+
 (live.task?'<details class="live-task" data-live-key="task:'+esc(live.caseId)+'" open><summary>Agent 收到的任务原文</summary><pre>'+esc(live.task)+'</pre></details>':'')+
 '<div class="live-stream"><h3>最近执行记录</h3>'+(entries.length?entries.map((e,i)=>e.kind==='tool'?'<details data-live-key="'+esc(e.key)+'" '+(i===0?'open':'')+'><summary><time>'+stamp(e.time)+'</time><strong>'+esc(e.name)+'</strong>'+(e.attribution?.kind==='TESTED_PLUGIN'?'<span class="plugin-origin plugin-origin-tested_plugin">被测插件</span>':'')+'<span class="live-event-summary">'+esc(e.summary||'工具返回')+'</span><span class="live-tool-state '+esc(e.state)+'">'+({done:'已返回',running:'调用中',error:'错误'}[e.state]||'')+'</span></summary>'+pluginAttributionBadge(e.attribution)+'<div class="live-event-body"><h4>参数</h4><pre>'+esc(e.arguments??'本次预览未包含调用参数')+'</pre>'+(e.result!==undefined?'<h4>返回</h4><pre>'+esc(e.result||'（空）')+'</pre>':'')+'</div></details>':'<details data-live-key="'+esc(e.key)+'"><summary><time>'+stamp(e.time)+'</time><strong>Agent 输出</strong><span class="live-event-summary">'+esc(e.text.slice(0,100))+'</span></summary><pre>'+esc(e.text)+'</pre></details>').join(''):'<div class="live-wait">'+(stale?'等待观测连接恢复':'等待可展示的执行记录')+'</div>')+'</div>'+
 '<details class="live-identifiers" data-live-key="ids"><summary>记录标识</summary><div>Agent：'+esc(live.agentId)+'<br>Run：'+esc(live.runId)+'<br>Case：'+esc(live.caseId||'—')+'<br>Session：'+esc(live.sessionId||'—')+'</div></details></section>';
}
function selectedLivePanel(caseId){const job=controlSnapshot?.jobs.find(j=>j.runId===activeRun?.id&&j.targetId===selectedAgent);return livePanel(job,caseId);}

function followCurrentCase(){const job=controlSnapshot?.jobs.find(j=>j.runId===activeRun?.id&&j.targetId===selectedAgent);if(!job?.progress?.current)return;liveFollowRun=job.runId;const i=cases.findIndex(c=>c.id===job.progress.current.caseId);if(i>=0)selectedCase=i;render();}
document.addEventListener('click',e=>{if(e.target.closest('[data-follow-current-case]'))followCurrentCase();});
document.addEventListener('change',e=>{if(e.target.id==='execution-case')liveFollowRun=null;});

function agentRunningIndicator(agentId,runId){
 const jobs=controlSnapshot?.jobs||[];
 const active=jobs.some(j=>j.targetId===agentId&&(!runId||j.runId===runId)&&['STARTING','RUNNING','CANCELLING'].includes(j.state)&&j.progress?.active!==false);
 return active?'<span class="agent-running-spinner" role="img" aria-label="评测进行中" title="评测进行中"></span>':'';
}
