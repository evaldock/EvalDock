let controlPreflight=null;
let controlSnapshot=null,controlToken='',controlEtag='',controlDraft=null,controlRevision='',controlBusy=false,controlError='',controlNotice='',controlTimer=null,controlPending=false;
let controlRestoration=null;try{controlRestoration=JSON.parse(sessionStorage.getItem('evaldock.workbench.ui.v2')||'null');}catch{}
let controlConnectionError='';
let controlRefreshWaiters=[];
let archiveSnapshot={jobs:[],runs:[]},archiveError='',archiveCheckedAt=0;
function allControlJobs(){const live=controlSnapshot?.jobs??[],ids=new Set(live.map(j=>j.id));return [...live,...archiveSnapshot.jobs.filter(j=>!ids.has(j.id))];}
async function refreshArchiveHistory(force=false){
  if(!force&&Date.now()-archiveCheckedAt<30000)return;
  archiveCheckedAt=Date.now();
  try{
    const response=await fetch('/archive/api/history',{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('archive unavailable');
    archiveSnapshot=await response.json();archiveError='';applyControlRuns(archiveSnapshot.runs);
  }catch{archiveError='硬盘历史结果暂时无法读取；已加载的记录仍保留。';}
}
const controlPluginDescriptions={
  '@deepseek-ai/dsh-base':'DSH 基础运行环境与内置工具',
  '@deepseek-ai/dsh-web-app':'Web 界面、会话交互与服务接口',
  '@dsheval/dsh-top100-plugin':'浏览、安装和管理 DSH-Eval Top100 插件与 Skills',
  'dsh-context':'查看上下文组成、占用与变化，管理会话上下文',
  'dsh-doublecheck':'任务执行过程中的复核与检查',
  'dsh-memory-evolve':'跨会话记忆积累与更新',
  '@yolk_vat-y/dsh-project-memory':'管理项目知识与项目记忆',
  '@xmanrui/dsh-im':'接入即时通讯渠道',
  'dsh-univer-office':'查看与编辑电子表格、文档等办公内容'
};
function controlDirty(){return !!controlSnapshot&&JSON.stringify([...(controlDraft??[])].sort())!==JSON.stringify(controlSnapshot.plugins.filter(p=>p.enabled).map(p=>p.name).sort());}
function controlJobState(s){return ({STARTING:'启动中',RUNNING:'运行中',CANCELLING:'正在停止',SUCCEEDED:'已完成',FAILED:'评测异常',PLUGIN_START_FAILED:'插件启动失败 · 未产生评分',CANCELLED:'已停止',INTERRUPTED:'运行状态待确认'})[s]||s;}
function controlRoundLabel(job){const run=historicalAgents.find(a=>a.id===job.targetId)?.runs.find(r=>r.id===job.runId);return job.state==='FAILED'&&job.summary?.command==='plan'?'规划失败 · Case 尚未执行':run&&judgeOnlyFailure(run)?runResultState(run).text:job.progress?.label||controlJobState(job.state);}
function caseFailureText(code){
  return ({AGENT_LOCAL_INPUT_UNSUPPORTED:'该次运行的适配版本未支持本地输入文件；未提交到客户端',AGENT_FILE_OUTPUT_UNSUPPORTED:'该次运行的适配版本未支持文件交付；未提交到客户端',AGENT_BACKGROUND_TASK_UNSUPPORTED:'该次运行已提交任务，但当时的适配未跟踪后台委派；原始评分无效，测试后台任务已停止',AGENT_CLEANUP_UNCONFIRMED:'任务停止状态未确认，评测未完成',AGENT_RESPONSE_EMPTY:'未采集到可评分的最终回复',AGENT_TASK_TIMEOUT:'任务超时'})[code]??code??'';
}
function controlCaseRows(job){
  const p=job.progress,rows=p?.cases??[];
  if(!rows.length)return p?.active?'<p class="control-section-note">正在规划，确定题目后自动展示 Case 列表。</p>':'';
  const names={QUEUED:'排队中',RUNNING:'执行 / 评分中',PREPARING:'准备环境',EXECUTING:'Agent 执行中',COLLECTING:'整理证据',JUDGING:'Judge 评分中',REPORTING:'保存报告',COMPLETED:'完成',FAILED:'异常',CANCELLED:'已取消',NOT_FINISHED:'未完成',UNKNOWN:'状态待确认'};
  const elapsed=row=>{if(!row.startedAt)return '—';const end=row.endedAt??(p.active?new Date().toISOString():job.endedAt);const sec=Math.max(0,Math.floor((Date.parse(end)-Date.parse(row.startedAt))/1000));return Number.isFinite(sec)?(sec>=60?Math.floor(sec/60)+' 分 '+sec%60+' 秒':sec+' 秒'):'—';};
  return '<details class="control-case-details" data-live-key="cases-'+esc(job.id)+'" '+(p.active?'open':'')+'><summary>Case 运行明细 · '+rows.length+' 题'+(p.active?' · 每 5 秒刷新':'')+'</summary><div class="control-case-scroll" data-case-scroll="'+esc(job.id)+'"><table class="control-case-table"><thead><tr><th>Case</th><th>当前阶段</th><th>用时</th><th>说明</th></tr></thead><tbody>'+rows.map(row=>{
    const phase=row.phase??row.status??'UNKNOWN',running=!['QUEUED','COMPLETED','FAILED','CANCELLED','NOT_FINISHED','UNKNOWN'].includes(phase),note=row.reasonCode?caseFailureText(row.reasonCode):phase==='JUDGING'?(row.labelId??'')+' · '+row.labelIndex+'/'+row.labelCount:row.sessionId?'会话 '+row.sessionId:'';
    return '<tr data-case-id="'+esc(row.caseId)+'" class="'+(running?'is-running':'')+'"><td><strong>'+esc(row.caseId)+'</strong>'+(row.datasetId?'<small>'+esc(row.datasetId)+'</small>':'')+'</td><td><span class="case-phase '+(phase==='FAILED'?'warning':running?'running':'')+'">'+esc(phase==='FAILED'&&['AGENT_LOCAL_INPUT_UNSUPPORTED','AGENT_FILE_OUTPUT_UNSUPPORTED','AGENT_BACKGROUND_TASK_UNSUPPORTED'].includes(row.reasonCode)?'适配未支持':names[phase]??phase)+'</span></td><td>'+elapsed(row)+'</td><td>'+esc(note)+'</td></tr>';
  }).join('')+'</tbody></table></div></details>';
}
function controlRoundView(job, featured=false, heading){
  const p=job.progress;if(!p)return '';
  const remaining=p.remaining===null?'—':p.remaining;
  const started=Date.parse(job.startedAt||job.createdAt),ended=Date.parse(job.endedAt);
  const seconds=Number.isFinite(started)?Math.max(0,Math.floor(((Number.isFinite(ended)?ended:Date.now())-started)/1000)):0;
  const duration=job.source==='external'&&!job.startedAt?'—':seconds>=60?Math.floor(seconds/60)+' 分 '+seconds%60+' 秒':seconds+' 秒';
  return '<section class="control-panel control-round '+esc(p.tone)+(featured?' featured':'')+'">'+
    '<div class="control-round-heading"><div><h2>'+esc(heading??(featured?'本轮测试':'测试记录'))+'</h2><div class="control-round-id">'+esc(displayJob(job))+(job.source==='external'?' · 后台启动':'')+'</div></div><div class="actions">'+
    (p.active?'<button class="control-end" '+(jobAgentKind(job)==='workbuddy'?'data-workbuddy-cancel':['pi','langgraph','qwenwork','doubaowork','hermes','openclaw'].includes(jobAgentKind(job))?'data-agent-kind="'+jobAgentKind(job)+'" data-agent-cancel':'data-control-cancel')+'="'+esc(job.id)+'" '+(controlBusy||job.source==='external'||job.state==='CANCELLING'?'disabled':'')+'>'+(job.source==='external'?'后台运行中':job.state==='CANCELLING'?'正在结束…':'结束本轮测试')+'</button>':'')+
    '<button data-control-result="'+esc(job.id)+'">'+(p.active?'查看运行详情':'查看结果')+'</button></div></div>'+
    '<div class="control-round-status"><strong role="status">'+esc(controlRoundLabel(job))+'</strong><span>已结束 <b>'+p.ended+' / '+(p.total??'—')+'</b> Case</span><span>用时 '+duration+'</span></div>'+
    '<div class="control-progress-track" role="progressbar" aria-label="Case 已结束进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+p.percent+'" aria-valuetext="已结束 '+p.ended+' / '+(p.total??'未知')+' 个 Case"><div style="width:'+p.percent+'%"></div></div>'+
    '<div class="control-round-counts"><span>正常 <b>'+p.normal+'</b></span><span class="'+(p.failed?'has-errors':'')+'">异常 <b>'+p.failed+'</b></span><span>取消 <b>'+p.cancelled+'</b></span><span>'+(p.active?'剩余':'未结束')+' <b>'+remaining+'</b></span>'+(p.unknown?'<span>状态未知 <b>'+p.unknown+'</b></span>':'')+'<span>datasets <b>'+esc(job.scale?.datasetCount??'—')+'</b></span></div>'+
    controlCaseRows(job)+
    (job.state==='FAILED'&&job.summary?.reasonCodes?.length?'<div class="control-round-current">本轮未完成原因：'+[...new Set(job.summary.reasonCodes)].map(code=>esc(caseFailureText(code))+' <small>'+esc(code)+'</small>').join('；')+'</div>':'')+
    (job.state==='CANCELLING'?'<div class="control-round-current">正在取消当前 Case 并保存结果，收尾完成后本轮结束。</div>':'')+
    (!p.countsComplete?'<div class="control-round-current">早期进度记录不完整，等待最终汇总。</div>':'')+'</section>';
}
function controlCompletedJobs(jobs){
  return jobs.filter(j=>!['STARTING','RUNNING','CANCELLING'].includes(j.state)).sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??''));
}
function controlHistoryView(jobs){
  const completed=controlCompletedJobs(jobs);
  if(!completed.length)return '<p class="control-section-note">暂无已结束的测试记录。</p>';
  return '<div class="control-history">'+completed.map((j,i)=>{
    if(i===0&&j.progress)return controlRoundView(j,true,'最近一轮测试');
    return '<div class="control-job"><div><strong>'+esc(displayJob(j))+(j.source==='archive'?' · 硬盘归档':'')+'</strong><span>'+esc(controlRoundLabel(j))+' · 已结束 '+(j.progress?.ended??'—')+'/'+(j.progress?.total??j.scale?.caseCount??'—')+' · datasets: '+esc(j.scale?.datasetCount??j.summary?.selectedDatasets?.length??'—')+' · case: '+esc(j.progress?.total??j.scale?.caseCount??'—')+'</span></div><div class="actions"><button data-control-result="'+esc(j.id)+'">查看结果</button></div></div>';
  }).join('')+'</div>';
}
function activeEvaluationJob(){return controlSnapshot?.jobs?.find(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state));}
function activeEvaluationBlocker(){return '';}
function controlSessionsView(s){
  if(!s?.activeSessions?.length)return '';
  const evalActive=s.externalEval||s.jobs.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state));
  return '<section class="control-panel control-sessions"><h2>当前 DSH 任务<span class="control-state-small">'+s.activeSessions.length+' 个运行中</span></h2>'+s.activeSessions.map(session=>
    '<div class="control-session"><div><strong>'+esc(session.title)+'</strong><span>'+esc(session.cwd)+'</span></div><button class="control-end" data-control-session-cancel="'+esc(session.id)+'" '+(controlBusy||evalActive||session.cancelling?'disabled':'')+'>'+(session.cancelling?'正在结束…':evalActive?'由 Eval 管理':'结束当前 DSH 任务')+'</button></div>'
  ).join('')+'<div class="control-session-note">'+(evalActive?'评测任务请通过“结束本轮测试”停止。':'此任务独立于下方历史评测；结束后可切换 Plugins 或开始新测试。')+'</div></section>';
}
function startupCheckPanel(title,button,issues,failed,check,key){
  const body=failed&&issues?'<details class="preflight-details" data-live-key="'+esc(key)+'"><summary><strong>'+title+'</strong><span>查看原因</span></summary><ul>'+issues+'</ul></details><div class="preflight-recheck">'+button+'</div>':'<div class="pi-preflight-heading"><strong>'+title+'</strong>'+button+'</div>';
  return '<div class="pi-preflight '+(failed?'failed':check?'passed':'')+'" role="status">'+body+'</div>';
}
function dshStartupView(s,locked){
  const matches=check=>check&&check.revision===controlRevision&&JSON.stringify([...(check.plugins??[])].sort())===JSON.stringify([...(controlDraft??[])].sort());
  const check=matches(controlPreflight)?controlPreflight:matches(s?.preflight)?s.preflight:null,failed=check?.status==='FAILED';
  const issues=(check?.issues??[]).map(issue=>'<li>'+esc(issue.message)+(issue.plugins?.length?'<div class="pi-conflict-links">'+issue.plugins.map(name=>'<button data-dsh-locate="'+esc(name)+'">定位 '+esc(name)+'</button>').join('')+'</div>':'')+'</li>').join('');
  const button='<button data-control-preflight '+(locked||!s?'disabled':'')+'>'+(controlBusy&&s?.busy==='PREFLIGHT'?'检查中…':failed?'重新检查':'检查启动')+'</button>';
  return {check,failed,html:startupCheckPanel(failed?'启动预检未通过':check?'启动预检通过':'启动预检',button,issues,failed,check,'dsh-preflight-'+(check?.checkedAt??''))};
}
function controlView(){
  const s=controlSnapshot?{...controlSnapshot,jobs:controlSnapshot.jobs.filter(j=>jobAgentKind(j)==='dsh')}:null,dirty=controlDirty(),active=s?.jobs.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state));
  const jobs=allControlJobs().filter(j=>jobAgentKind(j)==='dsh'),completed=controlCompletedJobs(jobs);
  const locked=controlBusy||!!s?.busy||!!s?.error||active||s?.externalEval||s?.runningSessions>0;
  const startup=dshStartupView(s,locked),conflicts=new Set((startup.check?.issues??[]).flatMap(i=>i.plugins??[]));
  const disabled=locked?' disabled':'',state=s?.status==='RUNNING'?'运行中':s?.status==='STOPPED'?'已停止':s?'连接待确认':'连接中';
  const notice=controlError||controlConnectionError||s?.error||(s?.externalEval?'VMmac 中有其他 Eval 正在运行。':s?.runningSessions>0?'DSH 有正在运行的任务，请在下方查看或手动结束。':'');
  return '<div class="titlebar"><div class="control-title"><h1>'+agentLogo('dsh')+'DSH 控制台</h1><span class="control-state-small">VMmac · Web</span></div><button data-control-refresh>刷新状态</button></div>'+
    (notice?'<div class="control-message" role="status">'+esc(notice)+'</div>':controlNotice?'<div class="control-message success" role="status">'+esc(controlNotice)+'</div>':'')+
    activeEvaluationBlocker('dsh')+
    '<section class="control-panel"><div class="control-status-row"><div class="control-status '+(s?.status==='RUNNING'?'':'off')+'">● '+state+(s?.needsRestart?' · 配置待重启':'')+'</div><div class="actions"><button data-control-service="start" '+(locked||!s||s.status!=='STOPPED'?'disabled':'')+'>启动 DSH</button><button data-control-service="restart" '+(locked||!s||s.status!=='RUNNING'?'disabled':'')+'>重启</button><button data-control-service="stop" '+(locked||!s||s.status!=='RUNNING'?'disabled':'')+'>停止</button></div></div><div class="control-facts">'+[['版本',s?.version||'—'],['进程 PID',s?.pid??'—'],['Profile',s?.profile||'web'],['Plugins',(s?.plugins.filter(p=>p.enabled).length??'—')+' 个']].map(([k,v])=>'<div><span>'+k+'</span><strong>'+esc(v)+'</strong></div>').join('')+'</div><details class="control-config"><summary>连接与安装位置</summary><div>服务：'+esc(s?.endpoint||'—')+'<br>安装目录：'+esc(s?.installRoot||'—')+'<br>DSH Home：'+esc(s?.home||'—')+'</div></details></section>'+
    (active?'':controlSessionsView(s))+
    (active?controlRoundView(s.jobs.find(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state)),true):'')+
    '<div class="control-layout"><div><section class="control-panel"><h2>Plugins<span class="control-state-small">'+(controlDraft?.length??0)+' 个已选择</span></h2>'+startup.html+'<div class="control-plugin-scroll" role="region" aria-label="Plugins 列表" tabindex="0"><table class="control-plugins"><thead><tr><th>启用</th><th>插件</th><th>功能</th><th>版本</th></tr></thead><tbody>'+(s?.plugins.map(p=>'<tr class="'+(conflicts.has(p.name)?'pi-plugin-conflict':'')+'"><td><input type="checkbox" data-control-plugin="'+esc(p.name)+'" aria-label="启用 '+esc(p.name)+'" '+(controlDraft?.includes(p.name)?'checked':'')+' '+(locked||p.required||!p.version?'disabled':'')+'></td><td class="control-plugin-name" title="'+esc(p.description)+'">'+esc(p.name)+'</td><td class="control-plugin-function">'+esc(controlPluginDescriptions[p.name]||p.description||'—')+'</td><td>'+esc(p.version||'未解析')+'</td></tr>').join('')||'<tr><td colspan="4">正在读取 VMmac 插件配置…</td></tr>')+'</tbody></table></div><div class="control-plugin-footer"><span class="control-change '+(dirty?'dirty':'')+'">'+(dirty?'有未应用的修改':'当前 Profile 配置')+'</span><div class="actions"><button data-control-reset '+(!dirty||locked?'disabled':'')+'>还原选择</button><button class="primary" data-control-apply '+(!dirty||locked?'disabled':'')+'>'+(controlBusy?'处理中…':s?.status==='STOPPED'?'应用配置':'应用并重启')+'</button></div></div></section>'+
    '<section class="control-panel"><h2>测试记录<span class="control-state-small">当前与硬盘归档 · 自动更新</span></h2>'+(archiveError?'<div class="control-section-note">'+esc(archiveError)+'</div>':'')+controlHistoryView(jobs)+
    (completed[0]?.events?.length?'<details class="control-config"><summary>最新执行记录</summary><pre class="control-logs">'+esc(completed[0].events.filter(e=>e.kind!=='stdout').map(e=>e.text).join('\n'))+'</pre></details>':'')+'</section></div>'+
    '<aside><section class="control-panel"><h2>实际评测配置</h2><p>Planner：'+esc(s?.evaluationModels?.planner?.model||'读取中…')+'</p><p>Judge：'+esc(s?.evaluationModels?.judge?.model||'读取中…')+'</p><p>凭据：'+(s?.evaluationModels?.separateAgentKey?'评测与 DSH 分开配置':'读取中或未分离')+'</p><button data-control-inspect>查看当前静态观测</button></section><section class="control-panel control-start-panel"><h2>开始评测</h2><div class="control-scale"><button class="primary" data-control-run '+(locked||dirty||startup.failed||!s||!['RUNNING','STOPPED'].includes(s.status)||!s.modelReady?'disabled':'')+'>评测配置</button></div></section><section class="control-panel"><h2>Agent</h2><div class="control-agent-id">'+esc(dirty?'应用插件后确定新组合':s?.agent.id?displayAgent(s.agent.id):'读取中…')+'</div><p class="control-section-note">相同插件及版本归入同一 Agent；变更后建立新 Agent。</p></section></aside></div>';
}
function renderControlPreserved(force=false){
  if(page==='settings')return; // Background status refresh must not replace a user's API form.
  if(!force&&(window.getSelection()?.toString()||document.activeElement?.matches('input:not([type=checkbox]),select,textarea')))return;
  const nodes=[...document.querySelectorAll('.page details')];
  const opened=nodes.map((d,i)=>d.open?i:-1),liveOpen=new Map(nodes.filter(d=>d.dataset.liveKey).map(d=>[d.dataset.liveKey,d.open]));
  const positions=[...document.querySelectorAll('.live-panel pre')].map(p=>p.scrollTop);
  const caseScroll=new Map([...document.querySelectorAll('[data-case-scroll]')].map(n=>[n.dataset.caseScroll,n.scrollTop]));
  const pluginScroll=document.querySelector('.control-plugin-scroll')?.scrollTop??0;
  const focusPlugin=document.activeElement?.getAttribute('data-control-plugin');
  const focusPi=document.activeElement?.getAttribute('data-pi-extension');
  render();document.querySelectorAll('.page details').forEach((d,i)=>{if(d.dataset.liveKey){if(liveOpen.has(d.dataset.liveKey))d.open=liveOpen.get(d.dataset.liveKey);}else if(opened.includes(i))d.open=true;});
  document.querySelectorAll('.live-panel pre').forEach((p,i)=>{p.scrollTop=positions[i]||0;});
  document.querySelectorAll('[data-case-scroll]').forEach(n=>{n.scrollTop=caseScroll.get(n.dataset.caseScroll)??0;});
  const list=document.querySelector('.control-plugin-scroll');if(list)list.scrollTop=pluginScroll;
  if(focusPlugin)[...document.querySelectorAll('[data-control-plugin]')].find(e=>e.dataset.controlPlugin===focusPlugin)?.focus({preventScroll:true});
  if(focusPi)[...document.querySelectorAll('[data-pi-extension]')].find(e=>e.dataset.piExtension===focusPi)?.focus({preventScroll:true});
}
async function refreshControl(force=false){
  clearTimeout(controlTimer);if(controlPending){if(force)return new Promise(resolve=>controlRefreshWaiters.push(resolve)).then(()=>refreshControl(true));controlTimer=setTimeout(()=>refreshControl(),5000);return;}
  if(document.hidden&&!force)return;
  controlPending=true;
  try{
    void refreshWorkBuddy();void refreshRuntimes();
    await refreshArchiveHistory(force);
    await refreshLiveObservation();
    const r=await fetch('/api/control/status',{headers:!force&&controlEtag?{'If-None-Match':controlEtag}:{},signal:AbortSignal.timeout(20000)});
    if(r.status===304){applyControlRuns(liveUpdatesFor([]));const recovered=!!controlConnectionError;controlConnectionError='';if(['control','workbuddy','pi','langgraph','qwenwork','doubaowork','hermes','openclaw','tasks'].includes(page))renderControlPreserved();return;}
    if(!r.ok)throw new Error('无法连接 VMmac 控制服务');
    const data=await r.json();controlConnectionError='';const wasDirty=controlDirty(),changed=data.revision!==controlSnapshot?.revision;
    controlSnapshot=data;if(controlNotice==='评测已启动。'&&data.jobs?.[0]&&!['STARTING','RUNNING','CANCELLING'].includes(data.jobs[0].state))controlNotice='';controlToken=data.csrf;controlEtag=r.headers.get('etag')||'';
    if(!controlDraft||(!wasDirty&&changed)){controlDraft=data.plugins.filter(p=>p.enabled).map(p=>p.name);controlRevision=data.revision;}
    if(wasDirty&&changed)controlError='VMmac 插件配置已变化，请还原选择后重新编辑。';
    applyControlRuns(liveUpdatesFor(data.runs||[]));
    if(['control','workbuddy','pi','langgraph','qwenwork','doubaowork','hermes','openclaw','tasks'].includes(page)||data.runs?.length)renderControlPreserved();
  }catch(error){controlConnectionError='无法连接 VMmac 控制服务，请刷新重试。';if(page==='control')renderControlPreserved();}
  finally{controlPending=false;for(const resolve of controlRefreshWaiters.splice(0))resolve();if(!document.hidden)controlTimer=setTimeout(()=>refreshControl(),controlSnapshot?.jobs.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state))||controlSnapshot?.runningSessions>0?5000:30000);}
}
async function controlPost(route,body){
  if(controlBusy)return;const serviceWasRunning=controlSnapshot?.status==='RUNNING';controlBusy=true;controlError='';controlNotice='';renderControlPreserved();
  try{
    const request=async(action,payload)=>{
      const response=await fetch('/api/control/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':controlToken},body:JSON.stringify(payload),signal:AbortSignal.timeout(90000)});
      const result=await response.json();if(!response.ok){if(result.preflight)controlPreflight=result.preflight;throw new Error(result.preflight?'启动预检未通过，请查看插件列表。':result.error||'操作未完成');}return result;
    };
    if(route==='run'){
      await refreshControl(true);
      if(body.revision!==controlSnapshot?.revision)throw new Error('插件配置已变化，请确认后重新开始测试。');
      const service=controlSnapshot.status==='STOPPED'?'start':controlSnapshot.needsRestart?'restart':null;
      if(service)await request('service',{action:service});
    }
    const out=await request(route,body);
    if(route==='preflight')controlPreflight=out.result;
    if(route==='plugins'){controlDraft=null;controlNotice=serviceWasRunning?'插件配置已应用，DSH 已重启。':'插件配置已应用，下次启动 DSH 时生效。';}
    if(route==='run')controlNotice='评测已启动。';
    if(route==='cancel'){const job=controlSnapshot?.jobs.find(j=>j.id===body.id);if(job&&out.result)Object.assign(job,out.result);controlNotice='已提交结束请求，正在等待后端收尾。';}
    if(route==='session-cancel'){const session=controlSnapshot?.activeSessions?.find(s=>s.id===body.sessionId);if(session)session.cancelling=true;controlNotice='已提交结束请求，等待 DSH 结束任务。';}
    if(route==='service')controlNotice=({start:'DSH 已启动。',restart:'DSH 已重启。',stop:'DSH 已停止。'})[body.action]||'DSH 操作已完成。';
    await refreshControl(true);
  }catch(error){controlError=error.name==='TimeoutError'?'操作仍可能在进行，请刷新状态后确认。':error.message;}
  finally{controlBusy=false;renderControlPreserved();}
}
function applyControlRuns(items){
  for(const n of items){let a=historicalAgents.find(a=>a.id===n.agentId);if(!a){a={id:n.agentId,runs:[]};historicalAgents.unshift(a);resourceSnapshot.agents.unshift({id:a.id,name:a.id});}
    const kind=resultAgentKind(n);a.agentKind=kind;n.run.agentKind=kind;n.run.agentName??=({workbuddy:'WorkBuddy',pi:'Pi',langgraph:'LangGraph',qwenwork:'千问办公',doubaowork:'豆包办公',hermes:'Hermes',openclaw:'OpenClaw'}[kind]??'DSH');
    const entry=resourceSnapshot.agents.find(x=>x.id===a.id);Object.assign(entry,{agentKind:kind,placeholder:false});
    if(kind!=='dsh'){entry.name=n.run.agentName+(n.run.target?.agentVersion?' / '+n.run.target.agentVersion:'');resourceSnapshot.agents=resourceSnapshot.agents.filter(x=>!x.placeholder||x.id!==a.id);}
    const old=a.runs.findIndex(r=>r.id===n.run.id);
    if(old>=0&&['STARTING','RUNNING','CANCELLING'].includes(n.run.status)){
      if(!n.run.target?.toolDetails?.length&&a.runs[old].target?.toolDetails?.length)n.run.target={...n.run.target,toolDetails:a.runs[old].target.toolDetails,toolNames:a.runs[old].target.toolNames,toolSource:a.runs[old].target.toolSource};
      const merged=new Map(a.runs[old].cases.map(c=>[c.id,c]));for(const c of n.run.cases)merged.set(c.id,c);
      n.run.cases=[...merged.values()].sort((a,b)=>(a.ordinal??9999)-(b.ordinal??9999));
      n.run.dimensions=[...new Set([...a.runs[old].dimensions,...n.run.dimensions])];
    }
    if(old>=0)a.runs[old]=n.run;else a.runs.unshift(n.run);
    observationPlanSnapshot.plans[a.id]??={};if(n.plan?.datasets?.length||!observationPlanSnapshot.plans[a.id][n.run.id]?.datasets?.length)observationPlanSnapshot.plans[a.id][n.run.id]=n.plan;
    caseDetailSnapshot[a.id+'::'+n.run.id]={...caseDetailSnapshot[a.id+'::'+n.run.id],...n.details};for(const [key,value] of Object.entries(n.runtime))caseRuntimeSnapshot[key]={...caseRuntimeSnapshot[key],...value};
    for(const p of n.reportPaths)archivedReportPaths.add(p);
    if(activeRun?.id===n.run.id&&selectedAgent===a.id){const caseId=liveFollowRun===n.run.id?(controlSnapshot?.jobs.find(j=>j.runId===n.run.id)?.progress?.current?.caseId??cases[selectedCase]?.id):cases[selectedCase]?.id;activeRun=n.run;cases.splice(0,cases.length,...structuredClone(n.run.cases));dimensions.splice(0,dimensions.length,...n.run.dimensions);selectedCase=Math.max(0,cases.findIndex(c=>c.id===caseId));}
  }
  if(controlRestoration?.currentInspection){controlRestoration=null;}
  if(controlRestoration?.selectedAgent&&historicalAgents.some(a=>a.id===controlRestoration.selectedAgent)){const wanted=controlRestoration;controlRestoration=null;selectAgent(wanted.selectedAgent,wanted.lastRuns?.[wanted.selectedAgent]);page=wanted.page||'tasks';}
}
document.addEventListener('change',e=>{const name=e.target.dataset.controlPlugin;if(name){controlDraft=controlDraft.filter(n=>n!==name);if(e.target.checked)controlDraft.push(name);renderControlPreserved(true);}});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-control-inspect')){stopPlayback();drawerMode=null;reportOpen=false;activeRun=null;selectedAgent=controlSnapshot.agent.id;page='tasks';stage=0;render();return;}
  if(b.hasAttribute('data-control-refresh')){controlError='';refreshControl(true);}
  if(b.hasAttribute('data-control-reset')){controlDraft=controlSnapshot.plugins.filter(p=>p.enabled).map(p=>p.name);controlRevision=controlSnapshot.revision;controlError='';renderControlPreserved(true);}
  if(b.dataset.controlService)controlPost('service',{action:b.dataset.controlService});
  if(b.hasAttribute('data-control-preflight'))controlPost('preflight',{revision:controlRevision,plugins:controlDraft});
  if(b.dataset.dshLocate){const row=[...document.querySelectorAll('[data-control-plugin]')].find(e=>e.dataset.controlPlugin===b.dataset.dshLocate)?.closest('tr');row?.scrollIntoView({block:'center',behavior:'smooth'});}
  if(b.hasAttribute('data-control-apply'))controlPost('plugins',{revision:controlRevision,plugins:controlDraft});
  if(b.hasAttribute('data-control-run')){
    controlPost('run',{revision:controlSnapshot.revision});
  }
  if(b.dataset.controlSessionCancel)controlPost('session-cancel',{sessionId:b.dataset.controlSessionCancel});
  if(b.dataset.controlCancel)controlPost('cancel',{id:b.dataset.controlCancel});
  if(b.dataset.controlResult){const j=allControlJobs().find(j=>j.id===b.dataset.controlResult);if(j){liveFollowRun=j.progress?.active?j.runId:null;selectAgent(j.targetId,j.runId);stage=j.source==='archive'?3:2;const idx=cases.findIndex(c=>c.id===j.progress?.current?.caseId);if(idx>=0)selectedCase=idx;render();}}
  if(b.dataset.page==='control')refreshControl();
});
document.addEventListener('visibilitychange',()=>{clearTimeout(controlTimer);if(!document.hidden)refreshControl();});
window.addEventListener('DOMContentLoaded',()=>refreshControl());
