const runtimeLabels={pi:'Pi',langgraph:'LangGraph',qwenwork:'千问办公',doubaowork:'豆包办公',hermes:'Hermes',openclaw:'OpenClaw'};
const runtimeSnapshots={},runtimeErrors={},runtimeSelected={},runtimePending={};
const runtimeNotices={};
let piDraft=null,piDraftBase='',piDraftStale=false;
let piPreflight=null,piPreflightBase='',piAction=null;
const piExtensionDescriptions={
  '@amaster.ai/pi-memory-mem0':'语义记忆的自动保存、检索与调用',
  '@amaster.ai/pi-video-gen':'AI 视频生成与本地视频合成',
  '@geohar/pi-mcp-combiner':'聚合 MCP 服务并提供工具发现',
  '@gotgenes/pi-permission-system':'控制工具与操作的执行权限',
  '@juicesharp/rpiv-todo':'维护与展示任务待办清单',
  '@narumitw/pi-goal':'围绕单一目标自主执行任务',
  '@narumitw/pi-plan-mode':'提供只读的规划与协作模式',
  'pi-agent-browser-native':'通过原生工具执行浏览器自动化',
  'pi-herdr-agents':'异步子 Agent 与独立 Git 工作目录',
  'pi-hermes-memory':'持久记忆、会话搜索与敏感信息扫描',
  'pi-mcp-adapter':'连接 MCP 服务并调用其工具',
  'pi-subagents':'子 Agent 委派与多 Agent 工作流',
  'pi-vision-handoff':'调用视觉模型，将图像信息交给文本模型',
  'pi-web-access':'网页检索、内容抓取及文档与视频解析',
  'pi-web-search':'接入模型提供方的原生网页搜索'
};
const piTarget=()=>runtimeSnapshots.pi?.targets?.find(t=>t.id===runtimeSelected.pi)??runtimeSnapshots.pi?.targets?.[0];
const enabledPi=s=>(s?.extensions??[]).filter(e=>e.enabled).map(e=>e.name);
const piKey=s=>JSON.stringify((s?.extensions??[]).map(e=>[e.name,e.version,e.enabled]).sort());
function piDirty(){return piDraft!==null&&JSON.stringify([...piDraft].sort())!==JSON.stringify(enabledPi(piTarget()).sort());}
function syncPiDraft(next){
  const target=next.targets?.find(t=>t.id===runtimeSelected.pi)??next.targets?.[0];
  if(piDraft===null||!piDirty()){piDraft=enabledPi(target);piDraftBase=piKey(target);piDraftStale=false;}
  else if(piDraftBase!==piKey(target))piDraftStale=true;
}
function runtimeNavigation(){
  return Object.entries(runtimeLabels).map(([kind,name])=>'<button class="nav control-nav '+(page===kind?'active':'')+'" data-page="'+kind+'">'+agentLogo(kind)+name+' 控制台</button>').join('');
}
function ensureRuntimeEntries(){
  for(const [kind,snapshot] of Object.entries(runtimeSnapshots)){
    for(const target of snapshot.targets??[]){
      if(!resourceSnapshot.agents.some(a=>a.id===target.id))resourceSnapshot.agents.push({id:target.id,name:target.name,agentKind:kind,placeholder:true});
    }
  }
}
function runtimeRecordsView(kind,targetId,omitActive=false){
  const jobs=allControlJobs().filter(j=>jobAgentKind(j)===kind&&(!targetId||j.targetId===targetId));
  const active=jobs.find(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state)),completed=controlCompletedJobs(jobs);
  return (!omitActive&&active?controlRoundView(active,true):'')+'<section class="control-panel"><h2>测试记录<span class="control-state-small">'+completed.length+' 个批次</span></h2>'+controlHistoryView(jobs)+'</section>';
}

function piStartupView(s,locked){
  const same=result=>result&&JSON.stringify([...(result.extensions??[])].sort())===JSON.stringify([...(piDraft??enabledPi(s))].sort());
  const check=piPreflightBase===piKey(s)&&same(piPreflight)?piPreflight:!piDirty()&&same(s?.preflight)?s.preflight:null;
  const failed=check?.status==='FAILED';
  const title=check?(failed?'启动预检未通过':'启动预检通过'):'启动预检';
  const issues=(check?.issues??[]).map(issue=>'<li><strong>'+esc(issue.message)+'</strong><div class="pi-conflict-links">'+(issue.extensions??[]).map(name=>'<button data-pi-locate="'+esc(name)+'">定位 '+esc(name)+'</button>').join('')+'</div></li>').join('');
  const button='<button data-agent-action="preflight" data-agent-kind="pi" '+(locked||!s?.executionReady||piDraftStale?'disabled':'')+'>'+(piAction==='preflight'?'检查中…':failed?'重新检查':'检查启动')+'</button>';
  return {check,failed,html:startupCheckPanel(title,button,issues,failed,check,'pi-preflight-'+(check?.checkedAt??''))};
}
function piConsoleView(){
  const snapshot=runtimeSnapshots.pi,s=piTarget(),dirty=piDirty();
  if(s)runtimeSelected.pi=s.id;
  const jobs=allControlJobs().filter(j=>jobAgentKind(j)==='pi').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const active=jobs.find(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state));
  const locked=controlBusy||!controlSnapshot||!!snapshot?.active;
  const startup=piStartupView(s,locked),conflicts=new Map((s?.extensions??[]).map(e=>[e.name,(startup.check?.issues??[]).filter(i=>(i.extensions??[]).includes(e.name))]));
  const state=snapshot?.active?'评测进行中':s?.preflight?.status==='FAILED'?'启动预检未通过':s?.preflight?.status==='PASSED'?'启动预检通过':s?.evaluationReady?'已安装 · 待启动检查':s?.status==='NOT_INSTALLED'?'未安装':s?'配置待检查':'连接中';
  const error=runtimeErrors.pi||(piDraftStale?'Pi 配置已变化，请还原选择后重新编辑。':s?.preflight?.status==='FAILED'?'':s?.reasonCode);
  const notice=runtimeNotices.pi;
  const selected=enabledPi(s);
  const canRun=s?.evaluationReady&&!locked&&!dirty&&!piDraftStale&&!startup.failed;
  const completed=controlCompletedJobs(jobs),history=controlHistoryView(jobs);
  return '<div class="titlebar"><div class="control-title"><h1>'+agentLogo('pi')+'Pi 控制台</h1><span class="control-state-small">本机 · CLI</span></div><button data-agent-refresh="pi">刷新状态</button></div>'+
    (error?'<div class="control-message" role="status">'+esc(error)+'</div>':notice?'<div class="control-message success" role="status">'+esc(notice)+'</div>':'')+
    activeEvaluationBlocker('pi')+
    '<section class="control-panel"><div class="control-status-row"><div class="control-status '+(s?.evaluationReady?'':'off')+'" role="status">● '+esc(state)+'</div></div><div class="control-facts">'+
    [['版本',s?.version??'—'],['运行方式','按 Case 启动'],['内置工具',s?.toolSchemas?.length===undefined?'—':s.toolSchemas.length+' 个'],['Extensions',s?selected.length+' 个':'—']].map(([k,v])=>'<div><span>'+k+'</span><strong>'+esc(v)+'</strong></div>').join('')+
    '</div><details class="control-config"><summary>连接与安装位置</summary><div>工作环境：本机<br>安装目录：'+esc(s?.installRoot??'读取中…')+'</div></details></section>'+
    (active?controlRoundView(active,true):'')+
    '<div class="control-layout"><div><section class="control-panel"><h2>Extensions<span class="control-state-small">'+(piDraft?.length??0)+' 个已选择</span></h2>'+startup.html+'<div class="control-plugin-scroll" role="region" aria-label="Extensions 列表" tabindex="0"><table class="control-plugins"><thead><tr><th>启用</th><th>扩展</th><th>功能</th><th>版本</th></tr></thead><tbody>'+
    ((s?.extensions??[]).map(e=>'<tr class="'+(conflicts.get(e.name)?.length?'pi-extension-conflict':'')+'"><td><input type="checkbox" data-pi-extension="'+esc(e.name)+'" aria-label="启用 '+esc(e.name)+'" '+(piDraft?.includes(e.name)?'checked ':'')+(locked||piDraftStale?'disabled':'')+'></td><td class="control-plugin-name">'+esc(e.name)+(conflicts.get(e.name)?.length?'<span class="pi-conflict-badge">'+esc(conflicts.get(e.name).map(i=>i.name?'冲突：'+i.name:'加载失败').join('；'))+'</span>':'')+'</td><td class="control-plugin-function">'+esc(piExtensionDescriptions[e.name]||e.description||'—')+'</td><td>'+esc(e.version??'未解析')+'</td></tr>').join('')||'<tr><td colspan="4">'+(s?'尚未安装扩展。':'正在读取 Pi 扩展配置…')+'</td></tr>')+
    '</tbody></table></div><div class="control-plugin-footer"><span class="control-change '+(dirty?'dirty':'')+'">'+(dirty?'有未应用的修改':'当前 Extension 配置')+'</span><div class="actions"><button data-pi-reset '+((!dirty&&!piDraftStale)||locked?'disabled':'')+'>还原选择</button><button class="primary" data-agent-action="extensions" data-agent-kind="pi" '+(!dirty||locked||piDraftStale||startup.failed?'disabled':'')+'>'+(controlBusy?'处理中…':'应用配置')+'</button></div></div></section>'+
    '<section class="control-panel"><h2>测试记录<span class="control-state-small">'+completed.length+' 个批次</span></h2>'+(history||'<div class="control-section-note">还没有 Pi 评测记录。</div>')+
    (completed[0]?.events?.length?'<details class="control-config"><summary>最新执行记录</summary><pre class="control-logs">'+esc(completed[0].events.filter(e=>e.kind!=='stdout').map(e=>e.text).join('\n'))+'</pre></details>':'')+'</section></div>'+
    '<aside><section class="control-panel"><h2>实际评测配置</h2><p>Planner：'+esc(controlSnapshot?.evaluationModels?.planner?.model??'读取中…')+'</p><p>Judge：'+esc(controlSnapshot?.evaluationModels?.judge?.model??'读取中…')+'</p><p>复用现有测试集与评分标准。</p></section>'+
    '<section class="control-panel control-start-panel"><h2>开始评测</h2><div class="control-scale"><button class="primary" data-agent-action="run" data-agent-kind="pi" '+(canRun?'':'disabled')+'>评测配置</button></div></section>'+
    '<section class="control-panel"><h2>Agent</h2><div class="control-agent-id">'+esc('Pi'+selected.map(name=>' + '+name).join(''))+'</div><p class="control-section-note">已应用的 Extensions 用于下一轮测试，历史配置随批次保存。</p><details class="control-config"><summary>观测范围</summary>'+(s?.limitations??[]).map(x=>'<p>'+esc(x)+'</p>').join('')+'</details></section></aside></div>';
}
function langgraphConsoleView(){
  const snapshot=runtimeSnapshots.langgraph,targets=snapshot?.targets??[];
  const selected=targets.find(t=>t.id===runtimeSelected.langgraph)??targets[0];
  if(selected)runtimeSelected.langgraph=selected.id;
  const jobs=allControlJobs().filter(j=>jobAgentKind(j)==='langgraph').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const selectedJobs=jobs.filter(j=>j.targetId===selected?.id);
  const active=selectedJobs.find(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state));
  const locked=controlBusy||!!snapshot?.active||jobs.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state));
  const ready=!!selected?.evaluationReady;
  const state=runtimeErrors.langgraph?'连接待恢复':snapshot?.active?'评测进行中':ready?'已就绪':selected?.status==='NOT_INSTALLED'?'未安装':selected?'配置待检查':'连接中';
  const tools=selected?.toolSchemas??[],notice=runtimeErrors.langgraph||selected?.reasonCode;
  const history=jobs.map(j=>'<div class="control-job"><div><strong>'+esc(targets.find(t=>t.id===j.targetId)?.name??j.targetId)+' · '+esc(displayJob(j))+'</strong><span>'+esc(controlRoundLabel(j))+' · 已结束 '+(j.progress?.ended??0)+'/'+(j.progress?.total??'—')+' Case</span></div><div class="actions">'+
    (['STARTING','RUNNING','CANCELLING'].includes(j.state)?'<button data-agent-kind="langgraph" data-agent-cancel="'+esc(j.id)+'" '+(controlBusy||j.source==='external'||j.state==='CANCELLING'?'disabled':'')+'>结束本轮测试</button>':'')+
    '<button data-control-result="'+esc(j.id)+'">查看结果</button></div></div>').join('');
  return '<div class="titlebar"><div class="control-title"><h1>'+agentLogo('langgraph')+'LangGraph 控制台</h1><span class="control-state-small">本机 · Graph 事件流</span></div><button data-agent-refresh="langgraph">刷新状态</button></div>'+
    (notice?'<div class="control-message" role="status">'+esc(notice)+'</div>':'')+
    activeEvaluationBlocker('langgraph')+
    '<section class="control-panel"><div class="control-status-row"><div class="control-status '+(ready?'':'off')+'" role="status">● '+esc(state)+'</div><span class="control-state-small">'+targets.length+' 个可选 Agent</span></div>'+
    '<div class="graph-targets" role="group" aria-label="选择被测 Agent">'+targets.map(t=>'<button type="button" class="graph-target '+(t.id===selected?.id?'selected':'')+'" data-graph-target="'+esc(t.id)+'" aria-pressed="'+(t.id===selected?.id)+'"><strong>'+esc(t.name)+'</strong><span>'+esc(t.evaluationReady?'已就绪':'配置待检查')+' · '+esc(t.version??'版本未知')+'</span></button>').join('')+'</div>'+
    '<div class="control-facts">'+[['版本',selected?.version??'—'],['运行方式','按 Case 启动'],['声明工具',selected?tools.length+' 个':'—'],['Probe',selected?.probeReady?'Graph 事件流':'待连接']].map(([k,v])=>'<div><span>'+k+'</span><strong>'+esc(v)+'</strong></div>').join('')+'</div>'+
    '<details class="control-config"><summary>安装位置与工具声明</summary><div>安装目录：'+esc(selected?.installRoot??'读取中…')+'</div><div class="graph-meta">声明工具仅表示 Graph 可提供这些工具，不代表本轮已调用。</div>'+
    (tools.length?'<div class="graph-tools">'+tools.map(t=>'<span>'+esc(t.name)+'</span>').join('')+'</div>':'<div class="graph-meta">当前没有声明工具。</div>')+'</details></section>'+
    (selectedJobs[0]?controlRoundView(active??selectedJobs[0],true):'')+
    '<div class="control-layout"><div><section class="control-panel"><h2>测试记录<span class="control-state-small">'+jobs.length+' 个批次</span></h2>'+(history||'<p class="runtime-empty">暂无 LangGraph 评测记录。</p>')+'</section></div>'+
    '<aside><section class="control-panel"><h2>实际评测配置</h2><p>Planner：'+esc(controlSnapshot?.evaluationModels?.planner?.model??'读取中…')+'</p><p>Judge：'+esc(controlSnapshot?.evaluationModels?.judge?.model??'读取中…')+'</p><p class="control-section-note">复用现有测试集与评分标准。</p></section>'+
    '<section class="control-panel control-start-panel"><h2>开始评测</h2><div class="graph-action"><button class="primary" data-agent-action="run" data-agent-kind="langgraph" '+(ready&&!locked?'':'disabled')+'>评测配置</button></div></section>'+
    '<section class="control-panel"><h2>Agent</h2><div class="control-agent-id">'+esc(selected?.name??'等待读取')+'</div><p class="graph-meta">'+esc(selected?.id??'')+'</p><details class="control-config"><summary>观测范围</summary>'+(selected?.limitations??[]).map(x=>'<p>'+esc(x)+'</p>').join('')+'</details></section></aside></div>';
}
function runtimeConsoleView(kind){return ['hermes','openclaw'].includes(kind)?processConsoleView(kind):kind==='pi'?piConsoleView():kind==='langgraph'?langgraphConsoleView():officeConsoleView(kind);}
function runtimeEmptyPage(){
  const kind=currentAgentKind(),name=displayAgent(selectedAgent);
  return '<div class="shell">'+nav()+'<main class="main"><header class="topbar">被测 Agent / '+esc(name)+'</header><div class="page"><div class="titlebar"><h1>'+esc(name)+'</h1><button data-page="'+kind+'">打开控制台</button></div>'+runtimeRecordsView(kind,selectedAgent)+'</div></main></div>';
}
async function refreshRuntime(kind){
  if(runtimePending[kind])return runtimePending[kind];
  runtimePending[kind]=(async()=>{
  try{
    const response=await fetch('/api/control/'+kind+'/status',{cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(response.status===404&&['qwenwork','doubaowork'].includes(kind)){runtimeSnapshots[kind]={targets:[{id:kind,name:runtimeLabels[kind],status:'BACKEND_UPDATE_PENDING',evaluationReady:false}]};runtimeErrors[kind]='新适配已写入。工作台服务需要在当前评测结束后重新加载。';return;}
    if(!response.ok)throw Error('无法读取运行状态');
    const next=await response.json();if(kind==='pi')syncPiDraft(next);
    runtimeSnapshots[kind]=next;runtimeErrors[kind]='';ensureRuntimeEntries();
  }catch(error){runtimeErrors[kind]=error.message;}
  finally{runtimePending[kind]=null;if(page===kind)renderControlPreserved();}
  })();
  return runtimePending[kind];
}
function refreshRuntimes(){for(const kind of Object.keys(runtimeLabels))void refreshRuntime(kind);}
document.addEventListener('change',event=>{
  if(event.target.hasAttribute('data-pi-extension')){
    const name=event.target.dataset.piExtension;
    piDraft=event.target.checked?[...new Set([...(piDraft??[]),name])]:(piDraft??[]).filter(x=>x!==name);
    runtimeNotices.pi='';renderControlPreserved(true);return;
  }
  const kind=event.target.dataset.agentTarget;
  if(kind){runtimeSelected[kind]=event.target.value;render();}
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.piLocate){[...document.querySelectorAll('[data-pi-extension]')].find(e=>e.dataset.piExtension===button.dataset.piLocate)?.closest('tr')?.scrollIntoView({block:'center',behavior:'smooth'});return;}
  if(button.dataset.graphTarget){runtimeSelected.langgraph=button.dataset.graphTarget;renderControlPreserved(true);return;}
  if(button.hasAttribute('data-pi-reset')){piDraft=enabledPi(piTarget());piDraftBase=piKey(piTarget());piDraftStale=false;runtimeNotices.pi='';renderControlPreserved(true);return;}
  const refresh=button.dataset.agentRefresh??(runtimeLabels[button.dataset.page]?button.dataset.page:null);
  if(refresh){void refreshRuntime(refresh);return;}
  const kind=button.dataset.agentKind,action=button.hasAttribute('data-agent-cancel')?'cancel':button.dataset.agentAction;
  if(!runtimeLabels[kind]||!action||controlBusy)return;
  const body=action==='cancel'?{id:button.dataset.agentCancel}:{targetId:runtimeSelected[kind]};
  if(kind==='pi'&&['run','validate','extensions','preflight'].includes(action)&&piDraftStale)return;
  if(kind==='pi'&&['run','validate'].includes(action)&&piDirty())return;
  if(['extensions','preflight'].includes(action))body.extensions=[...(piDraft??[])];
  if(kind==='pi')piAction=action;
  controlBusy=true;runtimeErrors[kind]='';renderControlPreserved(true);
  try{
    const response=await fetch('/api/control/'+kind+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':controlSnapshot?.csrf??''},body:JSON.stringify(body)});
    const result=await response.json();
    if(kind==='pi'&&(result.preflight||action==='preflight'&&result.result)){piPreflight=result.preflight??result.result;piPreflightBase=piKey(piTarget());}
    if(!response.ok)throw Error(result.error??'操作失败');
    await runtimePending[kind];
    if(action==='extensions'){piDraft=null;piDraftStale=false;piPreflight=null;runtimeNotices.pi='启动预检通过，扩展配置已应用。';}
    await refreshRuntime(kind);await refreshControl(true);
  }catch(error){runtimeErrors[kind]=error.message;await refreshRuntime(kind);}
  finally{controlBusy=false;piAction=null;renderControlPreserved(true);}
});

function officeConsoleView(kind){
  const snapshot=runtimeSnapshots[kind],s=snapshot?.targets?.[0],name=runtimeLabels[kind];if(s)runtimeSelected[kind]=s.id;
  const jobs=allControlJobs().filter(j=>jobAgentKind(j)===kind),active=jobs.find(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state));
  const locked=controlBusy||!controlSnapshot||!!snapshot?.active;
  const states={BACKEND_UPDATE_PENDING:'等待工作台服务更新',READY:'已连接 · 可评测',LOGIN_REQUIRED:'请在虚拟机内登录',NOT_CONNECTED:'桌面应用待连接',NOT_INSTALLED:'未安装',INCOMPATIBLE:'应用版本需重新验证',RECOVERY_REQUIRED:'上一任务停止状态待确认',RUNTIME_NOT_READY:'本机执行环境未就绪'};
  const state=snapshot?.active?'评测进行中':states[s?.status]??'正在读取状态';
  return '<div class="titlebar"><div class="control-title"><h1>'+agentLogo(kind)+esc(name)+' 控制台</h1><span class="control-state-small">本机 · 桌面任务</span></div><button data-agent-refresh="'+kind+'">刷新状态</button></div>'+
    (runtimeErrors[kind]?'<div class="control-message" role="status">'+esc(runtimeErrors[kind])+'</div>':'')+activeEvaluationBlocker(kind)+
    '<section class="control-panel"><div class="control-status-row"><div class="control-status '+(s?.evaluationReady?'':'off')+'" role="status">● '+esc(state)+'</div><button data-agent-action="open" data-agent-kind="'+kind+'" '+(locked?'disabled':'')+'>打开应用</button></div><div class="control-facts">'+
    [['版本',s?.version??'—'],['Probe',s?.probeReady?'事件推送':'待连接'],['执行范围',kind==='doubaowork'?'本机 · 独立工作目录':'文本与工作目录'],['原生附件','暂不支持']].map(([k,v])=>'<div><span>'+k+'</span><strong>'+esc(v)+'</strong></div>').join('')+'</div>'+
    '<details class="control-config"><summary>安装与连接信息</summary>'+esc(s?.installRoot??'读取中…')+(s?.reasonCode?'<p>'+esc(s.reasonCode)+'</p>':'')+'</details></section>'+
    (active?controlRoundView(active,true):'')+
    '<div class="control-layout"><div>'+runtimeRecordsView(kind,s?.id,true)+'<section class="control-panel"><h2>观测与执行范围</h2>'+(s?.limitations??[]).map(x=>'<p class="control-section-note">'+esc(x)+'</p>').join('')+'</section></div>'+
    '<aside><section class="control-panel"><h2>实际评测配置</h2><p>Planner：'+esc(controlSnapshot?.evaluationModels?.planner?.model??'读取中…')+'</p><p>Judge：'+esc(controlSnapshot?.evaluationModels?.judge?.model??'读取中…')+'</p><p>复用测试集、评分标准和 all trace 格式。</p></section><section class="control-panel control-start-panel"><h2>开始评测</h2><button class="primary" data-agent-action="run" data-agent-kind="'+kind+'" '+(!locked&&s?.evaluationReady?'':'disabled')+'>评测配置</button><p class="control-section-note">'+(s?.status==='LOGIN_REQUIRED'?'请先完成应用登录，再刷新状态。':kind==='doubaowork'?'每题独立工作目录；等待后台任务完成后采集文件并评分。':'每题使用独立会话和工作目录。')+'</p></section></aside></div>';
}

function processConsoleView(kind){
  const snapshot=runtimeSnapshots[kind],s=snapshot?.targets?.[0],name=runtimeLabels[kind];
  if(s)runtimeSelected[kind]=s.id;
  const jobs=allControlJobs().filter(j=>jobAgentKind(j)===kind&&(!s?.id||j.targetId===s.id)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const active=jobs.find(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state)),completed=controlCompletedJobs(jobs);
  const locked=controlBusy||!controlSnapshot||!!snapshot?.active||!!active;
  const state=runtimeErrors[kind]?'连接待恢复':active||snapshot?.active?'评测进行中':s?.evaluationReady?'已就绪':s?.status==='NOT_INSTALLED'?'未安装':s?'配置待检查':'连接中';
  const notice=runtimeErrors[kind]||s?.reasonCode,tools=s?.toolSchemas??[];
  const descriptions={terminal:'执行终端命令',read_file:'读取文件',write_file:'写入文件',patch:'修改文件',read:'读取文件',write:'写入文件',edit:'修改文件',exec:'执行终端命令',process:'管理任务进程'};
  const version=(s?.version??'').replace(/^Hermes Agent v/,'').replace(/^OpenClaw /,'').split(' ')[0]||'—';
  const history=controlHistoryView(jobs);
  return '<div class="titlebar"><div class="control-title"><h1>'+agentLogo(kind)+esc(name)+' 控制台</h1><span class="control-state-small">本机 · CLI</span></div><button data-agent-refresh="'+kind+'">刷新状态</button></div>'+
    (notice?'<div class="control-message" role="status">'+esc(notice)+'</div>':'')+activeEvaluationBlocker(kind)+
    '<section class="control-panel"><div class="control-status-row"><div class="control-status '+(s?.evaluationReady?'':'off')+'" role="status">● '+esc(state)+'</div></div><div class="control-facts">'+
    [['版本',version],['运行方式','按 Case 启动'],['声明工具',s?tools.length+' 个':'—'],['Probe',s?.probeReady?(kind==='openclaw'?'结束触发':'事件推送'):'待连接']].map(([k,v])=>'<div><span>'+k+'</span><strong>'+esc(v)+'</strong></div>').join('')+
    '</div><details class="control-config"><summary>连接与安装位置</summary><div>工作环境：本机<br>安装目录：'+esc(s?.installRoot??'读取中…')+'</div></details></section>'+
    (active?controlRoundView(active,true):'')+
    '<div class="control-layout"><div><section class="control-panel"><h2>Tools<span class="control-state-small">'+tools.length+' 个声明工具</span></h2><div class="control-plugin-scroll" role="region" aria-label="'+esc(name)+' 工具列表" tabindex="0"><table class="control-plugins"><thead><tr><th>工具</th><th>功能</th><th>来源</th></tr></thead><tbody>'+
    (tools.map(t=>'<tr><td class="control-plugin-name">'+esc(t.name)+'</td><td class="control-plugin-function">'+esc(t.description||descriptions[t.name]||'—')+'</td><td>内置工具</td></tr>').join('')||'<tr><td colspan="3">'+(s?'当前没有声明工具。':'正在读取工具配置…')+'</td></tr>')+
    '</tbody></table></div><div class="control-plugin-footer"><span class="control-section-note">当前评测配置中的工具声明；实际调用以 Trace 为准。</span></div></section>'+
    '<section class="control-panel"><h2>测试记录<span class="control-state-small">'+completed.length+' 个批次</span></h2>'+(history||'<div class="control-section-note">还没有 '+esc(name)+' 评测记录。</div>')+
    (completed[0]?.events?.length?'<details class="control-config"><summary>最新执行记录</summary><pre class="control-logs">'+esc(completed[0].events.filter(e=>e.kind!=='stdout').map(e=>e.text).join('\n'))+'</pre></details>':'')+'</section></div>'+
    '<aside><section class="control-panel"><h2>实际评测配置</h2><p>Planner：'+esc(controlSnapshot?.evaluationModels?.planner?.model??'读取中…')+'</p><p>Judge：'+esc(controlSnapshot?.evaluationModels?.judge?.model??'读取中…')+'</p><p>复用现有测试集与评分标准。</p></section>'+
    '<section class="control-panel control-start-panel"><h2>开始评测</h2><div class="control-scale"><button class="primary" data-agent-action="run" data-agent-kind="'+kind+'" '+(!locked&&s?.evaluationReady?'':'disabled')+'>评测配置</button></div></section>'+
    '<section class="control-panel"><h2>Agent</h2><div class="control-agent-id">'+esc(s?.name??name)+'</div><p class="control-section-note">每题使用独立会话和工作目录，执行结束后回收进程。</p><details class="control-config"><summary>观测范围</summary>'+(s?.limitations??[]).map(v=>'<p>'+esc(v)+'</p>').join('')+'</details></section></aside></div>';
}
