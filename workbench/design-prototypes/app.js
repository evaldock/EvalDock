import {renderHome,renderDatasets,renderReports,selectedItems,friendlyMessage} from './product-pages.js';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={dsh:'DSH',workbuddy:'WorkBuddy',pi:'Pi',langgraph:'LangGraph',qwenwork:'千问办公',doubaowork:'豆包办公',hermes:'Hermes',openclaw:'OpenClaw'};
const pages={home:'概览',agents:'我的 Agent',datasets:'测试集',reports:'评测记录',settings:'设置'};
let summary={agents:[],jobs:[],runs:[]},catalog={datasets:[]},settings,csrf='',loading=false,discovery={agents:[],errors:[]},scanning=false;
const ui={datasetQuery:'',reportQuery:'',reportFilter:'all',datasetId:null,jobId:null,selection:new Map()};
const active=job=>['STARTING','RUNNING','CANCELLING'].includes(job.state);
const targets=()=>summary.agents.flatMap(a=>a.targets.map(t=>({...t,kind:a.kind,advanced:a.advanced,active:a.active})));
const page=()=>pages[location.hash.slice(1)]?location.hash.slice(1):'home';
const notice=message=>{const text=friendlyMessage(message);$('#notice').innerHTML=message?`<div class="notice-copy"><span>${escape(text)}</span>${text!==message?`<details><summary>查看详细原因</summary><code>${escape(message)}</code></details>`:''}</div><button data-dismiss-notice aria-label="关闭提示">×</button>`:'';$('#notice').hidden=!message;};
async function api(route,body){const response=await fetch('/api/control/'+route,{method:body?'POST':'GET',headers:body?{'content-type':'application/json','x-workbench-token':csrf}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败');return data;}
function heading(title,description,action=''){return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;}
const startButton='<button class="primary" data-start>＋ 开始评测</button>';
const agentCatalog=[
 {kind:'dsh',name:'DSH',format:'svg',description:'任务执行与插件评测'},
 {kind:'pi',name:'Pi',format:'svg',description:'CLI 执行与扩展评测'},
 {kind:'openclaw',name:'OpenClaw',format:'svg',description:'CLI 执行与会话记录'},
 {kind:'hermes',name:'Hermes',format:'png',description:'CLI 执行与事件流'},
 {kind:'workbuddy',name:'WorkBuddy',format:'svg',description:'桌面任务与交付评测'},
 {kind:'qwenwork',name:'千问办公',format:'png',description:'桌面办公任务评测'},
 {kind:'doubaowork',name:'豆包办公',format:'png',description:'桌面任务与后台执行'},
 {kind:'langgraph',name:'LangGraph',format:'svg',description:'自定义 Graph 与工具评测'},
 {kind:'codex',name:'Codex',format:'png',description:'评测适配器待接入',planned:true},
 {kind:'claude',name:'Claude Code',format:'png',description:'评测适配器待接入',planned:true},
];
function agentCards(){
 const configured=targets();
 const cards=agentCatalog.flatMap(brand=>brand.kind==='langgraph'&&configured.some(t=>t.kind==='langgraph')?configured.filter(t=>t.kind==='langgraph').map(t=>({...brand,name:t.name,targetId:t.id})): [brand]);
 return cards.map(brand=>{
   const installed=discovery.agents.filter(d=>d.kind===brand.kind);
   const connected=configured.filter(t=>t.kind===brand.kind&&(!brand.targetId||t.id===brand.targetId));
   const ready=connected.filter(t=>t.evaluationReady);
   const state=ready.length?'可评测':installed.length?(brand.planned?'已发现 · 待适配':'已发现'):connected.length?'已接入 · 待检查':brand.kind==='langgraph'?'待接入':'待安装';
   const version=installed.find(d=>d.version)?.version||connected.find(t=>t.version)?.version;
   const waiting=connected.find(t=>!t.evaluationReady);
   const descriptions={AGENT_NOT_CONNECTED:'已接入，启动连接后即可检查登录状态',AGENT_LOGIN_REQUIRED:'请在 Agent 应用中完成登录',AGENT_WINDOW_NOT_READY:'等待 Agent 窗口加载完成',WORKBUDDY_NOT_CONNECTED:'尚未连接 WorkBuddy，请启动连接',WORKBUDDY_LOGIN_REQUIRED:'请在 WorkBuddy 中完成登录',WORKBUDDY_WINDOW_NOT_READY:'等待 WorkBuddy 窗口加载完成',WORKBUDDY_INTERFACE_CHANGED:'WorkBuddy 调用接口不可用，需检查适配',WORKBUDDY_EVENT_TRANSPORT_UNAVAILABLE:'WorkBuddy 事件传输接口不可用',WORKBUDDY_APP_ID_MISMATCH:'安装的应用标识与 WorkBuddy 不符',WORKBUDDY_INSPECTION_FAILED:'WorkBuddy 接口检查失败，请重新检查连接'};
   const description=descriptions[waiting?.reasonCode]||(waiting?.reasonCode?friendlyMessage(waiting.reasonCode):brand.description);
   const available=installed.find(d=>d.target&&!connected.some(t=>t.id==='local-'+d.kind+'-'+d.id||t.installRoot===d.path||d.target?.sourceRoot&&t.installRoot===d.target.sourceRoot));
   const launchable=['qwenwork','doubaowork'].includes(brand.kind)&&waiting?.reasonCode==='AGENT_NOT_CONNECTED'||brand.kind==='workbuddy'&&waiting?.reasonCode==='WORKBUDDY_NOT_CONNECTED';
   const action=ready.length?`<button data-start data-target="${escape(ready[0].id)}">开始评测</button>`:launchable?`<button data-open-agent="${escape(waiting.id)}" data-kind="${brand.kind}">启动连接</button>`:available?`<button data-connect="${escape(available.id)}">接入评测</button>`:'';

   return `<article class="agent-card ${ready.length?'is-ready':installed.length?'is-discovered':''}"><div class="agent-card-heading"><img src="assets/agents/${brand.kind}.${brand.format}" width="28" height="28" alt=""><h3>${escape(brand.name)}</h3><span class="pill ${ready.length?'ready':installed.length?'discovered':''}">${state}</span></div><p class="agent-description">${escape(description)}</p><div class="agent-card-footer"><span>${escape(version|| (installed.length?'版本未读取':brand.planned?'计划接入':'已支持'))}${installed.length>1?' · '+installed.length+' 个安装':''}</span>${action}</div></article>`;
 }).join('');
}

let lastRenderedHtml;
function render(){
 const current=page();$('#breadcrumb').textContent='工作空间 / '+pages[current];document.querySelectorAll('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===current));
 let html='';
 if(current==='home')html=renderHome({summary,catalog,settings,discovery});
 if(current==='agents')html=heading('我的 Agent','全部 Agent 与本机安装状态', `<div><button data-graph-setup>＋ 接入 LangGraph</button> <button data-scan ${scanning?'disabled':''}>${scanning?'正在扫描…':'↻ 重新扫描'}</button></div>`)+`<div class="note agent-scan-note">${agentCatalog.length} 类 Agent · 已发现 ${new Set(discovery.agents.map(d=>d.kind)).size} 类本地安装 · ${discovery.scannedAt?'上次扫描 '+escape(new Date(discovery.scannedAt).toLocaleTimeString('zh-CN')):'正在扫描本机'}${discovery.errors.length?'<br>'+discovery.errors.map(escape).join('；'):''}</div><div class="agent-grid">${agentCards()}</div>`;
 if(current==='datasets')html=renderDatasets({catalog,ui});
 if(current==='reports')html=renderReports({summary,ui});
 if(current==='settings')html=heading('设置','配置评分服务和本地工作空间。')+`<div class="settings"><form id="model-form" class="card"><h2>评测模型</h2><p>Planner 负责选题，Judge 负责评分。API Key 仅保存在本机，留空保留已有值。</p>${['planner','judge'].map(role=>`<fieldset><legend>${role==='planner'?'Planner · 选题':'Judge · 评分'}</legend><label>模型名称<input name="${role}-model" required value="${escape(settings?.[role]?.model)}"></label><label>接口地址<input name="${role}-endpoint" required type="url" value="${escape(settings?.[role]?.endpoint)}"></label><label>API Key<input name="${role}-apiKey" type="password" autocomplete="off" placeholder="${settings?.[role]?.keyConfigured?'已配置；留空保留':'尚未配置'}"></label></fieldset>`).join('')}<button class="primary">保存模型设置</button></form><section class="card"><h2>本地工作空间</h2><p>题库、运行记录和配置保存在本机。模型密钥沿用 ~/.config/evaldock/models.env。</p><button data-open-data>打开数据目录</button> <button data-configure>打开 Agent 配置目录</button></section></div>`;
 if(html===lastRenderedHtml)return;
 lastRenderedHtml=html;
 const focus=document.activeElement,focusId=focus?.id,position=focus?.selectionStart;
 const opened=new Set([...document.querySelectorAll('details[data-preserve][open]')].map(d=>d.dataset.preserve));
 $('#content').className=current==='agents'?'agents-page':'product-page';$('#content').innerHTML=html;
 for(const detail of document.querySelectorAll('details[data-preserve]'))if(opened.has(detail.dataset.preserve))detail.open=true;
 if(['dataset-search','report-search'].includes(focusId)){const next=document.getElementById(focusId);next?.focus();try{next?.setSelectionRange(position,position);}catch{}}
}
async function refresh(){if(loading)return;loading=true;try{const [s,c,m,d]=await Promise.all([api('app'),api('evaluation-catalog'),api('model-settings'),api('discovery')]);discovery=d;summary=s;catalog=c;settings=m.settings;csrf=m.csrf; if(page()!=='settings'||!$('#model-form'))render();if(s.errors?.length)notice(s.errors.join('；'));}catch(e){notice('无法读取本地服务：'+e.message);}finally{loading=false;}}
function syncSelectionMode(){
 const manual=$('#selection-kind').value==='SELECTED';
 $('#manual-selection').hidden=!manual;$('#manual-selection').disabled=!manual;
 $('#automatic-selection-note').hidden=manual;
}
function openEvaluation(targetId,datasetId,items){
 const available=targets().filter(t=>t.evaluationReady&&!t.active);
 if(!settings?.planner?.keyConfigured||!settings?.judge?.keyConfigured){notice('开始前请配置 Planner 和 Judge 的模型密钥。');location.hash='settings';return;}
 if(!catalog.datasets.length){notice('请先导入测试集。');location.hash='datasets';return;}
 $('#agent-select').innerHTML=targets().map(t=>`<option value="${escape(t.kind+':'+t.id)}" ${t.id===targetId&&t.evaluationReady&&!t.active?'selected':''} ${!t.evaluationReady||t.active?'disabled':''}>${escape(t.name||names[t.kind])}${t.active?' · 正在评测':!t.evaluationReady?' · '+escape(t.reasonCode?friendlyMessage(t.reasonCode):'暂不可用'):''}</option>`).join('');
 $('#selection-kind').value=items||datasetId?'SELECTED':'STANDARD';syncSelectionMode();
 $('#dataset-selection').innerHTML=catalog.datasets.map(d=>{const selected=items?items.find(item=>item.datasetId===d.id)?.caseIndices??[]:(datasetId&&d.id===datasetId)?d.cases.map(c=>c.index):[];return `<details class="eval-case-group" ${selected.length?'open':''}><summary>${escape(d.name)} · ${d.cases.length} 题</summary><label><input type="checkbox" data-eval-all="${escape(d.id)}" ${selected.length===d.cases.length?'checked':''}>全选</label>${d.cases.map(c=>`<label><input type="checkbox" data-eval-case="${escape(d.id)}" value="${c.index}" ${selected.includes(c.index)?'checked':''}>${escape(c.title)}</label>`).join('')}</details>`;}).join('');$('#evaluation-error').textContent=available.length?'':'目前没有已就绪且空闲的 Agent，请前往「我的 Agent」查看连接、版本或运行状态。';$('#submit-evaluation').disabled=!available.length;$('#evaluation-agent-setup').hidden=!!available.length;if(available.length&&!available.some(t=>t.id===targetId))$('#agent-select').value=available[0].kind+':'+available[0].id;$('#evaluation').showModal();
}
$('#close-dialog').onclick=()=>$('#evaluation').close();
$('#evaluation-agent-setup').onclick=()=>{$('#evaluation').close();location.hash='agents';};
$('#evaluation-form').onsubmit=async event=>{event.preventDefault();const button=$('#submit-evaluation');button.disabled=true;try{const chosen=catalog.datasets.flatMap(d=>{const indices=[...document.querySelectorAll('[data-eval-case]:checked')].filter(input=>input.dataset.evalCase===d.id).map(input=>Number(input.value));return indices.length?[{datasetId:d.id,caseIndices:indices}]:[];});const manual=$('#selection-kind').value==='SELECTED';if(manual&&!chosen.length)throw Error('请至少选择一道题目');const [kind,targetId]=$('#agent-select').value.split(':');const identity=kind==='dsh'?{revision:(await api('status')).revision}:kind==='workbuddy'?{}:{targetId};const started=await api(kind==='dsh'?'run':kind+'/run',{...identity,evaluationConfig:{mode:$('#mode-select').value,selection:manual?{kind:'SELECTED',items:chosen}:{kind:'STANDARD'}}});ui.jobId=started.result?.id??null;$('#evaluation').close();location.hash='reports';notice('评测已启动。');await refresh();}catch(e){$('#evaluation-error').textContent=friendlyMessage(e.message);}finally{button.disabled=false;}};
async function desktop(method){if(!window.evaldockDesktop)throw Error('此功能需要在 Mac App 中使用');return window.evaldockDesktop[method]();}
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;try{
 if(button.hasAttribute('data-dismiss-notice'))notice('');
 if(button.hasAttribute('data-run-detail')){ui.jobId=button.dataset.runDetail;location.hash='reports';render();}
 if(button.hasAttribute('data-reports-back')){ui.jobId=null;render();}
 if(button.hasAttribute('data-report-filter')){ui.reportFilter=button.dataset.reportFilter;render();}
 if(button.hasAttribute('data-refresh-records'))await refresh();
 if(button.hasAttribute('data-dataset-detail')){ui.datasetId=button.dataset.datasetDetail;render();}
 if(button.hasAttribute('data-datasets-back')){ui.datasetId=null;render();}
 if(button.hasAttribute('data-clear-selection')){ui.selection.clear();render();}
 if(button.hasAttribute('data-start-selection'))openEvaluation(undefined,undefined,selectedItems(catalog,ui.selection));
 if(button.hasAttribute('data-scan')){scanning=true;render();try{discovery=await api('discovery/scan',{});notice(`扫描完成，发现 ${discovery.agents.length} 个安装入口。`);}finally{scanning=false;render();}}
 if(button.hasAttribute('data-open-agent')){button.disabled=true;await api(button.dataset.kind+'/open',button.dataset.kind==='workbuddy'?{}:{targetId:button.dataset.openAgent});notice('已请求启动 Agent，连接状态会自动更新；如需登录，请在 Agent 应用中完成。');await refresh();}
 if(button.hasAttribute('data-graph-setup')){applyGraphPreset();$('#graph-error').textContent='';$('#graph-setup').showModal();}
 if(button.hasAttribute('data-connect')){button.disabled=true;await api('discovery/connect',{id:button.dataset.connect});notice('已接入，正在检查运行条件。');await refresh();}
 if(button.hasAttribute('data-start'))openEvaluation(button.dataset.target,button.dataset.dataset);
 if(button.hasAttribute('data-import')){button.disabled=true;const result=await desktop('importLibrary');if(result){notice(`已导入 ${result.datasets} 个测试集，共 ${result.cases} 题。`);await refresh();}}
 if(button.hasAttribute('data-configure')){await desktop('configureAgents');notice('在 agents.json 添加目标（参考同目录 agents.example.json）；DSH 修改 targets/real-dsh.json。保存后重新打开 App。');}
 if(button.hasAttribute('data-open-data'))await desktop('openData');
 if(button.hasAttribute('data-cancel')){await api((button.dataset.kind==='dsh'?'':button.dataset.kind+'/')+'cancel',{id:button.dataset.cancel});await refresh();}
 }catch(e){notice(e.message);}finally{button.disabled=false;}});
document.addEventListener('submit',async event=>{if(event.target.id!=='model-form')return;event.preventDefault();const form=event.target,button=form.querySelector('button');button.disabled=true;try{const values=Object.fromEntries(['planner','judge'].map(role=>[role,Object.fromEntries(['model','endpoint','apiKey'].map(field=>[field,form.elements[role+'-'+field].value]))]));settings=(await api('model-settings',values)).settings;notice('模型设置已保存。');render();}catch(e){notice(e.message);}finally{button.disabled=false;}});
window.addEventListener('hashchange',render);const initialNotice=new URLSearchParams(location.search).get('notice');if(initialNotice)notice(initialNotice);void refresh();setInterval(()=>{if(!$('#evaluation').open&&!$('#graph-setup').open&&page()!=='settings')void refresh();},10000);

document.addEventListener('input',event=>{if(event.target.id==='dataset-search'){ui.datasetQuery=event.target.value;render();}if(event.target.id==='report-search'){ui.reportQuery=event.target.value;render();}});
document.addEventListener('change',event=>{
 const e=event.target;
 if(e.id==='selection-kind')syncSelectionMode();
 if(e.hasAttribute('data-eval-all')){for(const input of document.querySelectorAll('[data-eval-case]'))if(input.dataset.evalCase===e.dataset.evalAll)input.checked=e.checked;}
 if(e.hasAttribute('data-eval-case')){const all=[...document.querySelectorAll('[data-eval-case]')].filter(i=>i.dataset.evalCase===e.dataset.evalCase),toggle=[...document.querySelectorAll('[data-eval-all]')].find(i=>i.dataset.evalAll===e.dataset.evalCase);toggle.checked=all.every(i=>i.checked);toggle.indeterminate=!toggle.checked&&all.some(i=>i.checked);}
 if(e.hasAttribute('data-select-dataset')){const d=catalog.datasets.find(d=>d.id===e.dataset.selectDataset);if(d){if(e.checked)ui.selection.set(d.id,new Set(d.cases.map(c=>c.index)));else ui.selection.delete(d.id);render();}}
 if(e.hasAttribute('data-select-case')){const id=e.dataset.selectCase,set=ui.selection.get(id)??new Set();if(e.checked)set.add(Number(e.dataset.index));else set.delete(Number(e.dataset.index));ui.selection.set(id,set);render();}
});

function applyGraphPreset(){
 const preset=$('#graph-preset').value,isDeep=preset==='deepagents',isFiles=preset==='toolkit-files';
 const root=preset==='custom'?'':isDeep?'~/Agents/langgraph/deepagents':'~/Agents/langgraph/agent-service-toolkit';
 $('#graph-name').value=preset==='custom'?'':isDeep?'DeepAgents':isFiles?'Agent Service Toolkit · 文件工具 Graph':'Agent Service Toolkit · 原始聊天 Graph';
 $('#graph-root').value=root;$('#graph-python').value=root?root+'/.venv/bin/python':'';
 $('#graph-entry').value=root?root+(isFiles?'/evaldock_files_entry.py:create_graph':'/evaldock_entry.py:create_graph'):'';
 $('#graph-tools').value=isDeep?'shell, read_file, write_file, edit_file, ls, glob, grep, write_todos, task':isFiles?'read_file, write_file':'';
 $('#graph-paths').value=isDeep?'virtual-root':'host';
 $('#graph-note').textContent=isDeep?'使用本机已准备的 DeepAgents 适配入口，请核对实际路径与工具。':isFiles?'单独的文件工具 Graph，需已存在 evaldock_files_entry.py；不会替换原始聊天 Graph。':preset==='toolkit'?'原始 chatbot 未配置文件工具，能执行对话不代表能交付文件。':'填写可返回 stream / astream Graph 的工厂函数。';
}
$('#graph-preset').onchange=applyGraphPreset;
$('#close-graph').onclick=()=>$('#graph-setup').close();
$('#graph-form').onsubmit=async event=>{
 event.preventDefault();const button=$('#save-graph');button.disabled=true;$('#graph-error').textContent='';
 try{
  const result=await api('langgraph/connect',{name:$('#graph-name').value,sourceRoot:$('#graph-root').value.trim(),python:$('#graph-python').value.trim(),entrypoint:$('#graph-entry').value.trim(),model:$('#graph-model').value.trim(),tools:$('#graph-tools').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean),workspacePaths:$('#graph-paths').value});
  $('#graph-setup').close();location.hash='agents';notice(result.existing?'此 Graph 已接入，保留原配置并重新检查。':'Graph 已保存，运行条件将显示在对应卡片中。');await refresh();
 }catch(e){$('#graph-error').textContent=friendlyMessage(e.message);}finally{button.disabled=false;}
};
