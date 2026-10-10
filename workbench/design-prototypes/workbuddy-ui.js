let workbuddySnapshot=null,workbuddyError='',workbuddyPending=false;
function resultAgentKind(value){return value?.agentKind??value?.run?.agentKind??value?.target?.agentKind??'dsh';}
function jobAgentKind(job){return job.agentKind??historicalAgents.find(a=>a.id===job.targetId)?.agentKind??'dsh';}
function currentAgentKind(){return activeRun?.agentKind??resourceSnapshot.agents.find(a=>a.id===selectedAgent)?.agentKind??'dsh';}
function agentControlPage(){return ({workbuddy:'workbuddy',pi:'pi',langgraph:'langgraph',qwenwork:'qwenwork',doubaowork:'doubaowork',hermes:'hermes',openclaw:'openclaw'}[currentAgentKind()]??'control');}
function ensureWorkBuddyEntry(){
  if(!resourceSnapshot.agents.some(a=>a.agentKind==='workbuddy'))resourceSnapshot.agents.push({id:'workbuddy',name:'WorkBuddy',agentKind:'workbuddy',placeholder:true});
}
function workbuddyActiveRound(){
  const job=allControlJobs().find(j=>jobAgentKind(j)==='workbuddy'&&['STARTING','RUNNING','CANCELLING'].includes(j.state));
  return job?controlRoundView(job,true):'';
}
function workbuddyRecordsView(){
  const jobs=allControlJobs().filter(j=>jobAgentKind(j)==='workbuddy');
  return '<section class="control-panel"><h2>测试记录<span class="control-state-small">'+controlCompletedJobs(jobs).length+' 个批次</span></h2>'+controlHistoryView(jobs)+'</section>';
}
function workbuddyView(){
  const s=workbuddySnapshot;
  const locked=controlBusy||!!s?.active;
  const state=workbuddyError?'连接待恢复':s?.active?'评测进行中':({NOT_INSTALLED:'未检测到安装',INSTALLED:'已安装 · 等待连接',LOGIN_REQUIRED:'请在虚拟机中登录 WorkBuddy',READY:'已连接 · 可以评测',INCOMPATIBLE:'版本待验证',RECOVERY_REQUIRED:'上次运行需要收尾',UNVERIFIED:'安装状态待确认'}[s?.status]??'正在读取虚拟机…');
  return '<div class="titlebar"><div class="control-title"><h1>'+agentLogo('workbuddy')+'WorkBuddy 控制台</h1><span class="control-state-small">本机 · 完整 Agent</span></div><button data-workbuddy-refresh>刷新状态</button></div>'+
    (workbuddyError||s?.error?'<div class="control-message" role="status">'+esc(workbuddyError||s.error)+'</div>':'')+
    activeEvaluationBlocker('workbuddy')+
    '<section class="control-panel"><div class="control-status-row"><div class="control-status off" role="status">● '+esc(state)+'</div></div><div class="control-facts">'+
    [['版本',s?.version??'—'],['测试对象','WorkBuddy'],['执行连接',s?.executionReady?'桌面会话已连接':'未连接'],['Probe',s?.probeReady?'已接入 · 有限观测':'未连接']].map(([k,v])=>'<div><span>'+k+'</span><strong>'+esc(v)+'</strong></div>').join('')+
    '</div><details class="control-config"><summary>连接与安装位置</summary><div>工作环境：本机<br>安装目录：'+esc(s?.installRoot??'未检测到')+'</div></details></section>'+
    workbuddyActiveRound()+
    '<div class="control-layout"><div>'+workbuddyRecordsView()+'</div><aside><section class="control-panel"><h2>评测配置</h2><p>Planner：'+esc(controlSnapshot?.evaluationModels?.planner?.model??'等待读取')+'</p><p>Judge：'+esc(controlSnapshot?.evaluationModels?.judge?.model??'等待读取')+'</p><p class="control-section-note">复用现有测试集与评分标准。</p></section>'+
    '<section class="control-panel control-start-panel"><h2>开始评测</h2><button class="primary" data-workbuddy-run '+(!s?.evaluationReady||locked?'disabled':'')+'>评测配置</button></section></aside></div>';
}
function workbuddyEmptyPage(){
  return '<div class="shell">'+nav()+'<main class="main"><header class="topbar"><span>工作台 / <strong>被测 Agent / WorkBuddy</strong></span><span class="prototype">本机</span></header><div class="page"><div class="titlebar"><h1>WorkBuddy</h1><button data-page="workbuddy">打开 WorkBuddy 控制台</button></div>'+workbuddyActiveRound()+workbuddyRecordsView()+'</div></main></div>';
}
async function refreshWorkBuddy(){
  if(workbuddyPending)return;workbuddyPending=true;
  try{
    const response=await fetch('/api/control/workbuddy/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('unavailable');
    workbuddySnapshot=await response.json();workbuddyError='';
  }catch{workbuddyError='无法读取 本机 中的 WorkBuddy 状态，请刷新重试。';}
  finally{workbuddyPending=false;if(page==='workbuddy')renderControlPreserved();}
}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-workbuddy-refresh')||b.dataset.page==='workbuddy')void refreshWorkBuddy();});

document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
  const action=b.hasAttribute('data-workbuddy-validate')?'validate':b.hasAttribute('data-workbuddy-run')?'run':b.hasAttribute('data-workbuddy-open')?'open':b.hasAttribute('data-workbuddy-recover')?'recover':b.hasAttribute('data-workbuddy-cancel')?'cancel':null;
  if(!action||controlBusy)return;controlBusy=true;workbuddyError='';renderControlPreserved();
  try{const r=await fetch('/api/control/workbuddy/'+action,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':controlSnapshot?.csrf??''},body:JSON.stringify(action==='cancel'?{id:b.dataset.workbuddyCancel}:{})});const value=await r.json();if(!r.ok)throw new Error(value.error);await refreshControl(true);await refreshWorkBuddy();}
  catch(err){workbuddyError=err.message;}finally{controlBusy=false;renderControlPreserved();}
});
