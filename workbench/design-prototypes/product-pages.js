import {renderRunRadar} from './score-radar.js';
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const agentNames={dsh:'DSH',pi:'Pi',openclaw:'OpenClaw',hermes:'Hermes',workbuddy:'WorkBuddy',qwenwork:'千问办公',doubaowork:'豆包办公',langgraph:'LangGraph'};
export const isActive=j=>['STARTING','RUNNING','CANCELLING'].includes(j.state);
const states={STARTING:'准备中',RUNNING:'评测中',CANCELLING:'取消中',CANCELLED:'已取消',SUCCEEDED:'已完成',COMPLETED:'已完成',FAILED:'失败',INTERRUPTED:'已中断'};
const phases={QUEUED:'等待执行',PREPARING:'准备中',EXECUTING:'执行中',COLLECTING:'采集证据',JUDGING:'评分中',REPORTING:'生成报告',COMPLETED:'已完成',FAILED:'失败',CANCELLED:'已取消',NOT_FINISHED:'未完成',running:'执行中',done:'已完成',error:'异常'};
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const heading=(title,copy,action='')=>`<div class="page-heading"><div><h1>${title}</h1><p>${copy}</p></div>${action}</div>`;
const start='<button class="primary" data-start>＋ 开始评测</button>';
const empty=(title,copy,action='')=>`<div class="empty"><span class="empty-symbol">◇</span><h3>${title}</h3><p>${copy}</p>${action}</div>`;
const stat=(label,value,copy='')=>`<div class="stat"><span>${label}</span><strong>${value}</strong>${copy?`<small>${copy}</small>`:''}</div>`;
const jobName=j=>j.targetName||agentNames[j.agentKind]||j.targetId||'Agent';
const tag=j=>`<span class="status-tag ${isActive(j)?'running':j.state==='SUCCEEDED'?'done':'neutral'}">${esc(states[j.state]||j.state)}</span>`;
export function reportHref(value){return typeof value==='string'&&/^reports\/[a-zA-Z0-9._-]+\/[^/]+\/(?:cases\/[a-zA-Z0-9._-]+\/)?report\.html$/.test(value)&&!value.split('/').some(x=>x==='..'||x==='.')?'/'+value.split('/').map(encodeURIComponent).join('/'):null;}
export function filterJobs(jobs,query='',filter='all'){
 return jobs.filter(j=>(filter==='all'||filter==='active'&&isActive(j)||filter==='done'&&j.state==='SUCCEEDED'||filter==='issues'&&['FAILED','INTERRUPTED','CANCELLED'].includes(j.state))&&[jobName(j),j.runId,j.id].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
}
function progress(j){const p=j.progress??{},total=Number.isFinite(p.total)&&p.total>0?p.total:0,ended=Math.max(0,p.ended??0);return `<div class="run-progress"><progress max="${total||1}" value="${Math.min(total,ended)}" aria-label="已结束题目"></progress><small>${esc(p.label|| (isActive(j)?'正在准备评测':'评测已结束'))} · ${total?`${ended} / ${total} 题`:'题量待确认'}</small></div>`;}
function jobRow(j){return `<div class="record-row"><div><strong>${esc(jobName(j))}</strong><small>${date(j.createdAt)} · ${esc(j.evaluationConfig?.mode==='FULL'?'完整流程':'结果评测')}</small></div><div>${tag(j)}${progress(j)}</div><button data-run-detail="${esc(j.id)}">查看详情 →</button></div>`;}
export function renderLibrary(library){
 if(!library?.automatic||library.state==='IDLE'||library.download&&['DOWNLOADING','INSTALLING'].includes(library.download.state))return '';
 const busy=['DOWNLOADING','INSTALLING'].includes(library.state);
 const title=library.state==='READY'?'自动题库已就绪':busy?'正在自动准备题库':library.state==='FAILED'?'题库准备失败':library.state==='CANCELLED'?'题库下载已取消':'即将自动准备题库';
 const copy=library.state==='READY'?`已下载并校验 ${library.cases} 道 BenchDock 试点题；开始评测后由 Planner 自动选题。公开题缺少私有评分参考时显示无法评分。`:library.state==='INSTALLING'?'正在校验并安装题库，旧题库会保留备份。':library.state==='DOWNLOADING'?`从 Hugging Face 下载已核对的题目与输入文件${library.totalFiles?' · '+Math.min(library.completedFiles,library.totalFiles)+' / '+library.totalFiles+' 个文件':''}，无需手动下载或导入。`:library.error||'自动准备已核对的 BenchDock 试点题，不安装题目依赖。';
 return `<section class="library-preparation" role="status"><div><strong>${title}</strong><p>${esc(copy)}</p></div>${busy?`<button data-library-cancel ${library.state==='INSTALLING'?'disabled':''}>${library.state==='INSTALLING'?'正在安装':'取消下载'}</button>`:library.state!=='READY'?'<button data-library-prepare>重试准备题库</button>':''}</section>`;
}
export function renderHome({summary,catalog,settings,discovery,library}){
 const jobs=summary.jobs,active=jobs.filter(isActive),ready=summary.agents.flatMap(a=>a.targets).filter(t=>t.evaluationReady).length,count=catalog.datasets.reduce((n,d)=>n+d.cases.length,0);
 const recent=jobs.filter(j=>!isActive(j)).slice(0,3);
 return renderLibrary(library)+`<section class="home-intro home-intro-single"><div class="intro-copy"><h1>Agent 评测概览</h1><p>选择已接入的 Agent，运行真实任务，查看交付文件、执行过程与评分报告。</p><div class="intro-actions"><button class="primary" data-start>开始评测 <span>→</span></button></div></div></section><div class="home-metrics"><a href="#agents"><strong>${ready}</strong><span>就绪 Agent</span><b>查看 Agent →</b></a><a href="#datasets"><strong>${count}</strong><span>测试题</span><b>浏览题库 →</b></a><a href="#reports"><strong>${jobs.length}</strong><span>评测记录</span><b>查看记录 →</b></a></div>${active.length?`<div class="section-heading"><h2>进行中 <span class="count-label">${active.length}</span></h2></div>${active.map(jobRow).join('')}`:''}<div class="section-heading"><h2>最近评测</h2><a href="#reports">全部记录 →</a></div>${recent.length?recent.map(j=>`<article class="home-record"><div class="record-emblem">${j.state==='SUCCEEDED'?'✓':'!'}</div><div class="home-record-title"><strong>${esc(jobName(j))}</strong><small>${date(j.createdAt)} · ${j.progress?.total??'—'} 道题</small></div>${tag(j)}<button data-run-detail="${esc(j.id)}">查看结果 →</button></article>`).join(''):`<div class="home-first"><h3>暂无评测记录</h3></div>`}`;
}
export function friendlyMessage(message){
 const value=String(message??'');
 const translations={WORKBUDDY_CLEANUP_REQUIRED:'上次 WorkBuddy 任务尚未确认清理，请查看评测记录。',AGENT_CLEANUP_REQUIRED:'上次任务尚未确认清理，请查看评测记录。',WORKBUDDY_APP_ID_MISMATCH:'安装的应用标识与 WorkBuddy 不符，请核对安装。',WORKBUDDY_INSPECTION_FAILED:'WorkBuddy 接口检查失败，请重新检查连接。',WORKBUDDY_WINDOW_NOT_READY:'请等待 WorkBuddy 窗口加载完成后重新检查。',AGENT_LAUNCH_STOP_CANCELLED:'已取消助手退出，请确认退出后重新连接。',AGENT_LAUNCH_STOP_TIMEOUT:'助手没有退出，请在助手的退出确认框中确认，再重试连接。',AGENT_LAUNCH_PROCESS_UNAVAILABLE:'无法确认助手的运行进程，请重新连接。',AGENT_LAUNCH_STOP_FAILED:'无法重启助手，请在应用中正常退出后重试。',AGENT_LAUNCH_INSTANCE_AMBIGUOUS:'检测到助手有多个运行实例，请关闭多余实例后重试。',AGENT_LAUNCH_CONNECTION_TIMEOUT:'助手启动后仍未连通，请查看应用窗口并重试。',AGENT_COMPATIBILITY_BUSY_OR_INTERRUPTED:'助手正在评测或上次任务尚未收尾，请先查看评测记录。',AGENT_CLEANUP_REVIEW_REQUIRED:'助手上次任务的清理尚未确认，请先查看评测记录。',AGENT_CLI_INTERFACE_UNAVAILABLE:'无法检查 Agent 的命令行接口，请检查可执行文件与运行环境。',AGENT_CLI_INTERFACE_CHANGED:'Agent 命令行缺少评测需要的参数，暂时无法运行。',LANGGRAPH_INTERFACE_UNAVAILABLE:'Graph 无法加载或缺少 stream / astream 接口，请检查入口与运行环境。',AGENT_MODEL_KEY_MISSING:'请配置被测 Agent 使用的模型密钥。',PI_STARTUP_FAILED:'Pi 未能通过 RPC 就绪检查，请检查运行环境与扩展。',PI_EXTENSION_CONFLICT:'Pi 扩展存在工具或参数冲突，请调整扩展配置。',PI_EXTENSION_LOAD_FAILED:'Pi 扩展加载失败，请检查扩展配置。',WORKBUDDY_NOT_CONNECTED:'尚未连接 WorkBuddy，请在「我的 Agent」启动连接。',WORKBUDDY_LOGIN_REQUIRED:'请打开 WorkBuddy 完成登录后重试。',WORKBUDDY_INTERFACE_CHANGED:'WorkBuddy 调用接口不可用，需要检查适配。',WORKBUDDY_EVENT_TRANSPORT_UNAVAILABLE:'WorkBuddy 事件传输接口不可用，暂时无法采集评测过程。',AGENT_VERSION_UNVERIFIED:'这是旧版的版本检查结果，请刷新状态以重新检查接口。',WORKBUDDY_VERSION_UNVERIFIED:'这是旧版的版本检查结果，请刷新状态以重新检查接口。',AGENT_INTERFACE_CHANGED:'Agent 调用或事件接口不可用，需要检查适配。',AGENT_APP_ID_MISMATCH:'安装的应用标识与目标 Agent 不符。',AGENT_LOCAL_RUNTIME_UNAVAILABLE:'Agent 的本机执行环境尚未就绪。',AGENT_INSPECTION_FAILED:'Agent 接口检查失败，请重新检查连接。',AGENT_RPC_REJECTED:'Agent 接口调用失败，请检查连接与运行状态。',AGENT_NOT_CONNECTED:'还没有连接到助手。请到「我的 Agent」点击「启动连接」。',AGENT_LOGIN_REQUIRED:'助手需要先登录。请打开对应应用完成登录，再回来继续。',AGENT_WINDOW_NOT_READY:'助手正在启动，请稍等片刻后重试。',AGENT_NOT_READY:'助手还没准备好。请到「我的 Agent」检查连接和登录状态。'};
 for(const [code,text] of Object.entries(translations))if(value.includes(code))return text;
 return /^[A-Z][A-Z0-9_]+$/.test(value)?'这次操作没有完成，请重试或检查运行状态。':value;
}
export function selectedItems(catalog,selection){return catalog.datasets.flatMap(d=>{const indices=d.cases.filter(c=>selection.get(d.id)?.has(c.index)).map(c=>c.index);return indices.length?[{datasetId:d.id,caseIndices:indices}]:[];});}
export function selectionCount(catalog,selection){return selectedItems(catalog,selection).reduce((n,d)=>n+d.caseIndices.length,0);}
const labelName=id=>({'label.artifact-delivery/v1':'产物交付','label.efficiency-cost/v1':'成本效率','label.reasoning-planning/v1':'推理规划','label.tool-code/v1':'代码工具','label.collaboration/v1':'协作委派','label.efficiency-reliability/v1':'效率稳定性','label.loop/v1':'执行闭环','label.memory/v1':'记忆','label.multimodal/v1':'多模态','label.retrieval-grounding/v1':'检索依据','label.safety-boundary/v1':'安全边界','label.tool-data/v1':'数据工具','label.tool-document/v1':'文档工具','label.tool-external/v1':'API 工具','label.tool-web/v1':'浏览器工具'}[id]||id.replace(/^label\./,'').replace(/\/v\d+$/,''));
const scoringNames={READY:'评分参考已就绪',UNAVAILABLE:'公开题 · 未接入评分参考',MISSING:'评分参考缺失',INVALID:'评分参考无效'};
const scoringTag=c=>c.scoringState?`<span class="pill ${c.scoringState==='READY'?'ready':'neutral'}">${esc(scoringNames[c.scoringState]||'评分参考待检查')}</span>`:'';
export function datasetDirectory(catalog,library){
 const local=new Map(catalog.datasets.map(dataset=>[dataset.id,dataset]));
 const subset=id=>id.replace(/^dataset\.(?:harbor-)?/,'').replace(/\/v[1-9][0-9]*$/,'').toLowerCase();
 const directory=(library?.catalog?.datasets??[]).map(dataset=>{
  const installed=local.get(dataset.id)??[...local.values()].find(item=>subset(item.id)===dataset.name.toLowerCase());
  if(installed)local.delete(installed.id);
  return {...dataset,id:installed?.id??dataset.id,name:installed?.name??dataset.name,caseCount:Math.max(dataset.caseCount,installed?.cases.length??0),labelIds:installed?.labelIds??dataset.labelIds,description:installed?.description??'',cases:installed?.cases??[],local:!!installed,remote:true};
 });
 return [...local.values()].map(dataset=>({...dataset,local:true,caseCount:dataset.cases.length})).concat(directory);
}
function renderDirectoryStatus(library){
 const directory=library?.catalog;if(!directory||directory.state==='READY')return '';
 const failed=directory.state==='FAILED';
 return `<section class="library-preparation" role="status"><div><strong>${failed?'题库目录加载失败':'正在加载题库目录'}</strong><p>${esc(failed?directory.error:'获取可用测试集列表，题库内容在点击下载后准备。')}</p></div>${failed?'<button data-library-catalog>重试加载目录</button>':''}</section>`;
}
function byteSize(value){
 const bytes=Math.max(0,Number(value)||0);
 if(bytes<1024)return Math.floor(bytes)+' B';
 const power=Math.min(3,Math.floor(Math.log(bytes)/Math.log(1024)));
 return (bytes/1024**power).toFixed(1)+' '+['B','KB','MB','GB'][power];
}
function downloadProgress(transfer){
 const installing=transfer.state==='INSTALLING',phase=transfer.phase||(installing?'CHECKING':'DOWNLOADING');
 const titles={PREPARING:'正在准备下载',DOWNLOADING:'正在下载题库',ASSEMBLING:'正在整理题目',CHECKING:'正在检查本地题库',COPYING:'正在准备安装',VALIDATING:'正在校验题目',COMMITTING:'正在保存题库'};
 const installation=transfer.installation??{};
 let fraction=null,detail='';
 if(phase==='DOWNLOADING'){
  fraction=transfer.totalBytes>0?transfer.downloadedBytes/transfer.totalBytes:transfer.totalFiles>0?transfer.completedFiles/transfer.totalFiles:null;
  detail=(transfer.totalBytes>0?`${byteSize(transfer.downloadedBytes)} / ${byteSize(transfer.totalBytes)} · `:'')+`${transfer.completedFiles??0} / ${transfer.totalFiles??0} 个文件`;
  if(transfer.cachedBytes>0)detail+=` · 含缓存 ${byteSize(transfer.cachedBytes)}`;
 }else if(phase==='VALIDATING'){
  fraction=installation.total>0?installation.completed/installation.total:null;
  detail=installation.total>0?`${installation.completed} / ${installation.total} 题已校验`:'正在读取题目，确认校验数量';
 }else if(phase==='COPYING')detail=`已复制 ${installation.completed??0} 个文件，正在准备本地安装`;
 else if(phase==='PREPARING')detail='正在保留现有题库并准备下载文件';
 else if(phase==='ASSEMBLING')detail='下载完成，正在整理公开题目与输入文件';
 else if(phase==='COMMITTING')detail='校验完成，正在保存题库与备份';
 else detail='下载完成，正在检查现有题库';
 const percent=fraction===null?null:Math.min(100,Math.max(0,Math.floor((Number(fraction)||0)*100)));
 const activeStep=installing||phase==='ASSEMBLING'?1:0;
 const label=installing?'题库安装进度':'题库下载进度';
 return `<div class="dataset-download-progress"><div class="dataset-progress-heading" role="status"><strong>${titles[phase]||'正在安装题库'}</strong>${percent===null?'<span class="dataset-progress-spinner" aria-hidden="true"></span>':`<b>${percent}%</b>`}</div><div class="dataset-progress-track ${percent===null?'indeterminate':''}"><progress ${percent===null?'':`max="100" value="${percent}"`} aria-label="${label}"></progress>${percent===null?'<span aria-hidden="true"></span>':''}</div><small>${esc(detail)}</small><ol class="dataset-progress-steps">${['下载文件','校验安装','完成'].map((name,index)=>`<li class="${index<activeStep?'complete':index===activeStep?'current':''}"><span>${index<activeStep?'✓':index+1}</span>${index===0&&activeStep>0?'下载完成':name}</li>`).join('')}</ol></div>`;
}
function datasetCard(dataset,ui,library){
 const download=library?.download,transfer=download?.datasetId===dataset.id?download:null,busy=transfer&&['DOWNLOADING','INSTALLING'].includes(transfer.state);
 const state=dataset.local?dataset.cases.length<dataset.caseCount?'部分在本地':'已在本地':busy?transfer.state==='INSTALLING'?'正在安装':'下载中':transfer?.state==='FAILED'?'下载失败':transfer?.state==='CANCELLED'?'已取消':dataset.downloadableCases?'待下载':'仅来源信息';
 const pending=download&&['DOWNLOADING','INSTALLING'].includes(download.state);
 const size=dataset.downloadBytes>=1024**2?(dataset.downloadBytes/1024**2).toFixed(1)+' MB':Math.ceil((dataset.downloadBytes??0)/1024)+' KB';
 const action=dataset.local?`<button data-dataset-detail="${esc(dataset.id)}">选择题目 →</button>`:busy?`<button data-library-download-cancel ${transfer.state==='INSTALLING'?'disabled':''}>${transfer.state==='INSTALLING'?'正在安装':'取消下载'}</button>`:dataset.downloadableCases?`<button data-library-download="${esc(dataset.id)}" ${pending?'disabled':''}>${transfer?.state==='FAILED'||transfer?.state==='CANCELLED'?'重新下载':'下载题库'} ↓</button>`:'<button disabled>仅提供来源</button>';
 const detail=dataset.local?`${dataset.remote?` · 本地 ${dataset.cases.length} 题`:''}${dataset.cases.some(c=>c.scoringState)?' · '+dataset.cases.filter(c=>c.scoringState==='READY').length+' 题评分参考已就绪':''}${ui.selection.get(dataset.id)?.size?' · 已选 '+ui.selection.get(dataset.id).size:''}`:dataset.downloadableCases?` · 可下载 ${dataset.downloadableCases} 题 · ${size}`:' · 需从原始来源获取';
 return `<article class="dataset-card"><div class="dataset-card-head"><span class="dataset-symbol">▦</span><span class="pill ${dataset.local?'ready':busy?'discovered':'neutral'}">${state}</span></div><h3>${esc(dataset.name)}</h3><div class="label-chips">${(dataset.labelIds??[]).map(id=>`<span>${esc(labelName(id))}</span>`).join('')}${dataset.sourceOnlyCases?`<span>线上 ${dataset.sourceOnlyCases} 题仅来源信息</span>`:''}</div>${busy?downloadProgress(transfer):transfer?.state==='FAILED'?`<p class="dataset-download-error" role="status">${esc(transfer.error)}</p>`:''}<div class="dataset-card-foot"><span>${dataset.caseCount} 题${esc(detail)}</span>${action}</div></article>`;
}
export function renderDatasets({catalog,ui,library}){
 const count=selectionCount(catalog,ui.selection),selected=catalog.datasets.find(d=>d.id===ui.datasetId);
 const action='<button data-import>＋ 导入题库</button>';
 const selectionBar=`<div class="selection-bar"><span>已选 <strong>${count}</strong> 题</span><div><button data-clear-selection ${count?'':'disabled'}>清空选择</button> <button class="primary" data-start-selection ${count?'':'disabled'}>评测所选题目 →</button></div></div>`;
 if(selected)return `<button class="back-link" data-datasets-back>← 全部测试集</button>`+heading(esc(selected.name),`${selected.cases.length} 题 · ${esc(selected.id.split('/').at(-1))} · 已在本地`)+`<div class="dataset-detail-toolbar"><label><input type="checkbox" data-select-dataset="${esc(selected.id)}" ${selected.cases.every(c=>ui.selection.get(selected.id)?.has(c.index))?'checked':''}> 全选本测试集</label><span class="muted">展开题目查看任务要求</span></div><div class="case-picker">${selected.cases.map(c=>`<article class="case-pick-row"><label><input type="checkbox" data-select-case="${esc(selected.id)}" data-index="${c.index}" ${ui.selection.get(selected.id)?.has(c.index)?'checked':''}><strong>${esc(c.title)}</strong></label><div class="case-meta">${esc(c.version?'版本 '+c.version:c.id)}${c.timeoutSeconds?' · 最长 '+c.timeoutSeconds+' 秒':''} ${scoringTag(c)}</div><details data-preserve="case-${esc(selected.id)}-${c.index}"><summary>查看任务要求</summary><p class="task-preview">${esc(c.instructions||'题目内容暂不可用，请重新加载服务。')}</p><p class="muted">${c.dependencies?.length?'声明依赖：'+c.dependencies.map(esc).join('、'):'未声明额外依赖'} · 实际运行条件在执行前检查</p></details></article>`).join('')}</div>`+selectionBar;
 const query=ui.datasetQuery.trim().toLowerCase(),directory=datasetDirectory(catalog,library),filter=ui.datasetFilter??'all';
 const visible=directory.filter(dataset=>(filter==='all'||filter==='local'&&dataset.local||filter==='download'&&!dataset.local&&dataset.downloadableCases>0)&&[dataset.name,dataset.description,dataset.id,...dataset.cases.map(c=>c.title)].join(' ').toLowerCase().includes(query));
 const localCases=catalog.datasets.reduce((sum,dataset)=>sum+dataset.cases.length,0);
 return heading('测试集','浏览题库目录，下载需要的测试集后选择题目。',action)+renderDirectoryStatus(library)+renderLibrary(library)+`<div class="library-summary"><span><strong>${directory.length}</strong> 个测试集</span><span><strong>${directory.reduce((sum,dataset)=>sum+dataset.caseCount,0)}</strong> 道题目</span><span>已在本地 <strong>${localCases}</strong> 题</span>${catalog.scoring?`<span>本地评分参考 <strong>${catalog.scoring.readyCases} / ${catalog.scoring.totalCases}</strong> 题已就绪</span><span>可评分题目覆盖 <strong>${catalog.scoring.labelIds.length}</strong> 个维度</span>`:''}</div><div class="page-toolbar dataset-catalog-toolbar"><input id="dataset-search" type="search" placeholder="搜索测试集或本地题目" aria-label="搜索测试集或本地题目" value="${esc(ui.datasetQuery)}"><div class="filter-tabs">${Object.entries({all:'全部',download:'待下载',local:'已在本地'}).map(([key,name])=>`<button data-dataset-filter="${key}" class="${filter===key?'selected':''}" aria-pressed="${filter===key}">${name}</button>`).join('')}</div><span class="muted">${visible.length} 个结果</span></div><div class="dataset-grid">${visible.map(dataset=>datasetCard(dataset,ui,library)).join('')}</div>${!visible.length?empty(query?'没有匹配的测试集':filter==='download'?'暂无待下载的测试集':'暂无测试集',query?'试试其他名称或清空搜索。':filter==='download'?'目录加载完成后，可在这里选择需要下载的测试集。':'下载目录中的测试集，或导入包含 catalog.md 的完整题库文件夹。'):''}<p class="library-note">目录和已下载题目可离线浏览。下载只准备公开任务与输入文件，执行环境按题目要求另行准备；仅提供来源信息的题目需从原始来源获取。公开题不包含私有评分参考，评分状态以本地实际材料为准。下载保留已有题库，导入完整题库会切换并保留备份。</p>`+selectionBar;
}
export function renderReports({summary,ui}){
 const j=summary.jobs.find(j=>j.id===ui.jobId);
 if(j)return renderRun(j,summary.runs.find(r=>r.agentId===j.targetId&&r.run.id===j.runId));
 const jobs=filterJobs(summary.jobs,ui.reportQuery,ui.reportFilter),counts={all:summary.jobs.length,active:summary.jobs.filter(isActive).length,done:summary.jobs.filter(j=>j.state==='SUCCEEDED').length,issues:summary.jobs.filter(j=>['FAILED','CANCELLED','INTERRUPTED'].includes(j.state)).length};
 return heading('评测记录','跟踪执行进度，查看每一题的交付和评分依据。','<button data-refresh-records>↻ 刷新记录</button>')+`<div class="page-toolbar reports-toolbar"><div class="filter-tabs">${Object.entries({all:'全部',active:'进行中',done:'已完成',issues:'异常 / 取消'}).map(([key,label])=>`<button data-report-filter="${key}" class="${ui.reportFilter===key?'selected':''}" aria-pressed="${ui.reportFilter===key}">${label} <span>${counts[key]}</span></button>`).join('')}</div><input id="report-search" type="search" placeholder="搜索 Agent 或运行编号" aria-label="搜索评测记录" value="${esc(ui.reportQuery)}"></div>${jobs.length?`<div class="record-list">${jobs.map(jobRow).join('')}</div>`:empty(summary.jobs.length?'没有符合条件的记录':'第一份报告，从一次评测开始',summary.jobs.length?'更换筛选条件或搜索关键词。':'选择一个 Agent，自动选题并开始评测，完成后回来查看真实结果。',summary.jobs.length?'':start)}<p class="library-note">显示已加载的最近记录。不同题库、评分标准或评分量表的结果不直接合并比较。</p>`;
}
function caseStages(job,c,result){
 const runtime=result?.runtime?.[job.targetId+'::'+job.runId+'::'+c.id]??{},phase=c.phase??c.status,scores=Object.values(c.scores??{});
 const exitCode=runtime.execution?.exitCode;
 const execution=Number.isSafeInteger(exitCode)?`${exitCode===0?'已结束':'失败'}（退出码 ${exitCode}）`:({QUEUED:'等待执行',PREPARING:'准备中',EXECUTING:'执行中'}[phase]??'未确认');
 const collection=phase==='COLLECTING'?'采集中':runtime.traceLoadState==='available'?'证据已归档（完整性未确认）':'未确认';
 const scoring=phase==='JUDGING'?'评分中':scores.some(s=>s.state==='error')?'存在评分失败':scores.some(s=>s.state==='null')?'存在证据不足':scores.length?'已有评分':'未确认（暂无评分记录）';
 const cleanup={STOPPED:'所属 Agent 资源已停止',PENDING:'待确认',NOT_STARTED:'未开始'}[runtime.cleanupState]??'未确认';
 const rows=[['执行',execution],['采集',collection],['评分',scoring],['清理',cleanup]];
 if(runtime.reset)rows.push(['环境恢复',{MATCH:'核验一致',MISMATCH:'核验不一致',UNAVAILABLE:'未确认（核验不可用）'}[runtime.reset.result]??'未确认']);
 return `<div class="score-table" aria-label="题次阶段状态">${rows.map(([name,value])=>`<div><strong>${name}</strong><b>${esc(value)}</b></div>`).join('')}</div>`;
}
export function renderRun(job,result){
 const p=job.progress??{},run=result?.run,allCases=new Map((p.cases??[]).map(c=>[c.caseId,{id:c.caseId,title:c.caseId,status:c.phase??c.status,phase:c.phase??c.status}]));
 for(const c of run?.cases??[])allCases.set(c.id,{...allCases.get(c.id),...c});
 const links=(result?.reportPaths??[]).map(reportHref).filter(Boolean);
 const count=value=>p.countsComplete===true&&Number.isSafeInteger(value)&&value>=0?value:'—';
 const completed=count(p.ended),total=p.total??run?.planned??0;
 const countsKnown=completed!=='—',quantity=countsKnown&&total?completed+' / '+total+' 题已结束':'计数未确认';
 const runProgress=countsKnown?progress(job):'<div class="run-progress"><progress aria-label="已结束题目，计数未确认"></progress><small>进度记录不完整，计数未确认。</small></div>';
 return `<button class="back-link" data-reports-back>← 全部评测记录</button>`+heading(esc(jobName(job))+' 的评测',`${date(job.createdAt)} · ${esc(job.runId)}`,isActive(job)?`<button data-cancel="${esc(job.id)}" data-kind="${esc(job.agentKind||'dsh')}" ${job.state==='CANCELLING'?'disabled':''}>${job.state==='CANCELLING'?'正在取消…':'取消评测'}</button>`:'')+`<section class="run-overview"><div class="run-summary-line">${tag(job)}<span>${esc(job.evaluationConfig?.mode==='FULL'?'完整流程':'结果评测')}</span><span>${esc(quantity)}</span></div>${runProgress}<div class="run-counts"><span>正常完成 <b>${count(p.normal)}</b></span><span>异常 <b>${count(p.failed)}</b></span><span>取消 <b>${count(p.cancelled)}</b></span></div><div class="run-counts"><span>结果未知 <b>${count(p.unknown)}</b></span><span>未结束 <b>${count(p.remaining)}</b></span></div><p class="muted">未结束包含进行中的题，不能据此确定未运行题量；任务结束、评分和清理分别确认。</p></section>${renderRunRadar(run)}${(run?.failureCodes??[]).length?`<div class="note">运行问题：${run.failureCodes.map(esc).join('、')}</div>`:''}<div class="section-heading"><h2>逐题结果</h2><span class="muted">保留原始评分量表</span></div>${allCases.size?[...allCases.values()].map(c=>{const scores=Object.entries(c.scores??{}),caseReport=links.find(link=>link.includes('/cases/'+encodeURIComponent(c.id)+'/')),phase=c.phase??c.status;
 return `<details class="result-case" data-preserve="result-${esc(job.id)}-${esc(c.id)}"><summary><strong>${esc(c.title||c.id)}</strong><span>${esc(phases[phase]||phase||'阶段未确认')} · ${esc(c.time||'—')}</span></summary><div class="result-case-body">${caseStages(job,c,result)}${scores.length?`<div class="score-table">${scores.map(([id,s])=>{const scale=s.scale??run?.scoreScale;const numeric=s.state==='scored'&&Number.isFinite(s.value);return `<div><strong>${esc(run?.labelNames?.[id]||labelName(id))}</strong><b>${numeric?`${s.value}${scale?.max?' / '+scale.max:''}`:s.state==='error'?'评分失败':'证据不足'}</b><p>${esc(s.reason||'暂无评分说明')}</p></div>`;}).join('')}</div>`:'<p class="muted">尚无有效评分。执行和评分进度以当前任务状态为准。</p>'}${c.finalAnswer?`<h3>最终回答</h3><pre>${esc(c.finalAnswer.slice(0,12000))}</pre>${c.answerTruncated||c.finalAnswer.length>12000?'<p class="muted">此处为截断预览，完整内容见报告。</p>':''}`:''}${caseReport?`<a class="text-link" href="${esc(caseReport)}" target="_blank" rel="noopener">打开单题报告 ↗</a>`:''}</div></details>`;}).join(''):empty(isActive(job)?'正在准备题目':'暂无单题结果',isActive(job)?'完成选题后，进度会自动显示在这里。':'检查运行日志了解是否在执行前失败。')}<details class="run-log" data-preserve="log-${esc(job.id)}"><summary>运行日志与诊断</summary><pre>${esc((job.events??[]).slice(-25).map(e=>`${date(e.time)} ${e.text??e.kind??''}`).join('\n')||'暂无日志。')}</pre></details>${links.length?`<div class="report-links"><h3>已归档报告</h3>${links.map((link,i)=>`<a href="${esc(link)}" target="_blank" rel="noopener">${link.includes('/cases/')?'单题报告 '+(i+1):'完整报告'} ↗</a>`).join('')}</div>`:''}`;
}
