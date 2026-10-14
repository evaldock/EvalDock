import {renderHome,renderDatasets,renderReports,selectedItems,friendlyMessage} from './product-pages.js';
import {renderAgentCards} from './agent-cards.js';
import {appEvaluationConfig,startAppEvaluation} from './app-evaluation.js';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={dsh:'DSH',workbuddy:'WorkBuddy',pi:'Pi',langgraph:'LangGraph',qwenwork:'千问办公',doubaowork:'豆包办公',hermes:'Hermes',openclaw:'OpenClaw'};
const pages={home:'概览',agents:'我的 Agent',datasets:'测试集',reports:'评测记录',settings:'设置'};
let summary={agents:[],jobs:[],runs:[]},catalog={datasets:[]},settings,library={automatic:false,state:'LOCAL'},csrf='',discovery={agents:[],errors:[]},scanning=false;
let agentModelSettings={keyConfigured:false};
const pendingConnections=new Set();
const ui={datasetQuery:'',datasetFilter:'all',reportQuery:'',reportFilter:'all',datasetId:null,jobId:null,selection:new Map()};
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
 const brands=agentCatalog.flatMap(brand=>brand.kind==='langgraph'&&configured.some(t=>t.kind==='langgraph')?configured.filter(t=>t.kind==='langgraph').map(t=>({...brand,name:t.name,targetId:t.id})): [brand]);
 return renderAgentCards({brands,targets:configured,discovery,pendingConnections});
}

function agentModelForm(){
 return `<form id="agent-model-form" class="card"><h2>被测 Agent 模型</h2><p>Pi、Hermes、OpenClaw 和 LangGraph 的任务执行使用 DeepSeek，需要单独配置密钥。办公 Agent 请在原应用中完成登录。</p><label>DeepSeek API Key<input id="agent-api-key" name="apiKey" type="password" autocomplete="off" placeholder="${agentModelSettings.keyConfigured?'已配置；留空保留':'尚未配置'}"></label><p>密钥仅保存在本机，保存后返回「我的 Agent」查看运行条件。</p><button class="primary">保存 Agent 密钥</button></form>`;
}

let lastRenderedHtml;
function render(){
 const current=page();$('#breadcrumb').textContent='工作空间 / '+pages[current];document.querySelectorAll('[data-page]').forEach(a=>a.classList.toggle('active',a.dataset.page===current));
 let html='';
 if(current==='home')html=renderHome({summary,catalog,settings,discovery,library});
 if(current==='agents')html=heading('我的 Agent','全部 Agent 与本机安装状态', `<div><button data-graph-setup>＋ 接入 LangGraph</button> <button data-scan ${scanning?'disabled':''}>${scanning?'正在扫描…':'↻ 重新扫描'}</button></div>`)+`<div class="note agent-scan-note">${agentCatalog.length} 类 Agent · 已发现 ${new Set(discovery.agents.map(d=>d.kind)).size} 类本地安装 · ${discovery.scannedAt?'上次扫描 '+escape(new Date(discovery.scannedAt).toLocaleTimeString('zh-CN')):'正在扫描本机'}${discovery.errors.length?'<br>'+discovery.errors.map(escape).join('；'):''}</div><div class="agent-grid">${agentCards()}</div>`;
 if(current==='datasets')html=renderDatasets({catalog,ui,library});
 if(current==='reports')html=renderReports({summary,ui});
 if(current==='settings')html=heading('设置','配置评分服务和本地工作空间。')+`<div class="settings"><form id="model-form" class="card"><h2>评测模型</h2><p>Planner 负责选题，Judge 负责评分。API Key 仅保存在本机，留空保留已有值。</p>${['planner','judge'].map(role=>`<fieldset><legend>${role==='planner'?'Planner · 选题':'Judge · 评分'}</legend><label>模型名称<input name="${role}-model" required value="${escape(settings?.[role]?.model)}"></label><label>接口地址<input name="${role}-endpoint" required type="url" value="${escape(settings?.[role]?.endpoint)}"></label><label>API Key<input name="${role}-apiKey" type="password" autocomplete="off" placeholder="${settings?.[role]?.keyConfigured?'已配置；留空保留':'尚未配置'}"></label></fieldset>`).join('')}<button class="primary">保存模型设置</button></form>${agentModelForm()}<section class="card"><h2>本地工作空间</h2><p>题库、运行记录和配置保存在本机。模型密钥沿用 ~/.config/evaldock/models.env。</p><button data-open-data>打开数据目录</button> <button data-configure>打开 Agent 配置目录</button></section></div>`;
 if(html===lastRenderedHtml)return;
 lastRenderedHtml=html;
 const focus=document.activeElement,focusId=focus?.id,position=focus?.selectionStart;
 const opened=new Set([...document.querySelectorAll('details[data-preserve][open]')].map(d=>d.dataset.preserve));
 $('#content').className=current==='agents'?'agents-page':'product-page';$('#content').innerHTML=html;
 for(const detail of document.querySelectorAll('details[data-preserve]'))if(opened.has(detail.dataset.preserve))detail.open=true;
 if(['dataset-search','report-search'].includes(focusId)){const next=document.getElementById(focusId);next?.focus();try{next?.setSelectionRange(position,position);}catch{}}
}
let refreshPending;
function refresh(){
 if(refreshPending)return refreshPending;
 refreshPending=(async()=>{try{const [s,c,m,d,l,a]=await Promise.all([api('app'),api('evaluation-catalog'),api('model-settings'),api('discovery'),api('library'),api('agent-model-settings')]);agentModelSettings=a.settings;library=l;discovery=d;summary=s;catalog=c;settings=m.settings;csrf=m.csrf;if(page()!=='settings'||!$('#model-form'))render();if(s.errors?.length)notice(s.errors.join('；'));}catch(e){notice('无法读取本地服务：'+e.message);}finally{refreshPending=null;}})();
 return refreshPending;
}
function syncSelectionMode(){
 const manual=$('#selection-kind').value==='SELECTED';
 $('#manual-selection').hidden=!manual;$('#manual-selection').disabled=!manual;
 $('#automatic-selection-note').hidden=manual;$('#automatic-source').hidden=manual;
 $('#small-selection').hidden=$('#selection-kind').value!=='COUNT';$('#case-count').disabled=$('#selection-kind').value!=='COUNT';
}
async function openEvaluation(targetId,datasetId,items){
 await refresh();
 if(!settings?.planner?.keyConfigured||!settings?.judge?.keyConfigured){notice('开始前请配置 Planner 和 Judge 的模型密钥。');location.hash='settings';return;}
 const available=targets().filter(t=>t.evaluationReady&&!t.active);
 if(!catalog.datasets.length){notice('请先导入测试集。');location.hash='datasets';return;}
 $('#agent-select').innerHTML=targets().map(t=>`<option value="${escape(t.kind+':'+t.id)}" ${t.id===targetId&&t.evaluationReady&&!t.active?'selected':''} ${!t.evaluationReady||t.active?'disabled':''}>${escape(t.name||names[t.kind])}${t.active?' · 正在评测':!t.evaluationReady?' · '+escape(t.reasonCode?friendlyMessage(t.reasonCode):'暂不可用'):''}</option>`).join('');
 $('#selection-progress').hidden=true;$('#evaluation-error').textContent='';$('#selection-kind').value=items||datasetId?'SELECTED':'COUNT';$('#case-count').value='1';$('#selection-source').value='LOCAL';$('#selection-source').querySelector('[value=ONLINE]').disabled=!window.evaldockDesktop;syncSelectionMode();
 $('#dataset-selection').innerHTML=catalog.datasets.map(d=>{const selected=items?items.find(item=>item.datasetId===d.id)?.caseIndices??[]:(datasetId&&d.id===datasetId)?d.cases.map(c=>c.index):[];return `<details class="eval-case-group" ${selected.length?'open':''}><summary>${escape(d.name)} · ${d.cases.length} 题</summary><label><input type="checkbox" data-eval-all="${escape(d.id)}" ${selected.length===d.cases.length?'checked':''}>全选</label>${d.cases.map(c=>`<label><input type="checkbox" data-eval-case="${escape(d.id)}" value="${c.index}" ${selected.includes(c.index)?'checked':''}>${escape(c.title)}</label>`).join('')}</details>`;}).join('');$('#evaluation-error').textContent=available.length?'':'目前没有已就绪且空闲的 Agent，请前往「我的 Agent」查看连接、版本或运行状态。';$('#submit-evaluation').disabled=!available.length;$('#evaluation-agent-setup').hidden=!!available.length;if(available.length&&!available.some(t=>t.id===targetId))$('#agent-select').value=available[0].kind+':'+available[0].id;$('#evaluation').showModal();
}
$('#close-dialog').onclick=()=>$('#evaluation').close();
$('#evaluation-agent-setup').onclick=()=>{$('#evaluation').close();location.hash='agents';};
let evaluationSubmitting=false;
$('#evaluation-form').onsubmit=async event=>{
 event.preventDefault();if(evaluationSubmitting)return;
 const button=$('#submit-evaluation');button.disabled=true;evaluationSubmitting=true;
 const controls=[...$('#evaluation-form').querySelectorAll('select,input')].map(element=>({element,disabled:element.disabled}));
 try{
  const items=catalog.datasets.flatMap(d=>{const indices=[...document.querySelectorAll('[data-eval-case]:checked')].filter(input=>input.dataset.evalCase===d.id).map(input=>Number(input.value));return indices.length?[{datasetId:d.id,caseIndices:indices}]:[];});
  const config=appEvaluationConfig({mode:$('#mode-select').value,selectionKind:$('#selection-kind').value,caseCount:$('#case-count').value,items});
  const [agentKind,targetId]=$('#agent-select').value.split(':'),source=$('#selection-source').value;
  for(const {element} of controls)element.disabled=true;
  const started=await startAppEvaluation({agentKind,targetId,source,config},{api,prepareOnline:prepareOnlineSelection});
  ui.jobId=started.result?.id??null;$('#evaluation').close();location.hash='reports';notice('评测已启动。');await refresh();
 }catch(e){$('#evaluation-error').textContent=friendlyMessage(e.message);}
 finally{for(const {element,disabled} of controls)element.disabled=disabled;button.disabled=false;evaluationSubmitting=false;}
};
let preparingOnline=false;
async function prepareOnlineSelection(agentKind,targetId,evaluationConfig){
 preparingOnline=true;$('#selection-progress').hidden=false;$('#cancel-selection').hidden=false;$('#close-dialog').disabled=true;
 try{
  let selection=await api('library/select',{agentKind,targetId,evaluationConfig});
  while(selection.state==='PREPARING'){
   $('#selection-progress').textContent=({CATALOG:'正在校验线上目录…',MATCHING:'Planner 正在匹配测试集…',DOWNLOADING:'正在准备所需题目…'})[selection.phase]||'正在准备…';
   await new Promise(resolve=>setTimeout(resolve,500));library=await api('library');selection=library.selection;
  }
  if(selection.state!=='READY')throw Error(selection.error||'线上准备已取消');
  $('#selection-progress').textContent=`已准备 ${selection.preparedCases} 道新题目，即将从本地题库执行正式选题。`;
  await refresh();
 }finally{preparingOnline=false;$('#cancel-selection').hidden=true;$('#close-dialog').disabled=false;}
}
$('#cancel-selection').onclick=async()=>{try{await api('library/selection-cancel',{});}catch(e){$('#evaluation-error').textContent=e.message;}};
$('#evaluation').addEventListener('cancel',event=>{if(preparingOnline)event.preventDefault();});
async function desktop(method){if(!window.evaldockDesktop)throw Error('此功能需要在 Mac App 中使用');return window.evaldockDesktop[method]();}
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;try{
 if(button.hasAttribute('data-dismiss-notice'))notice('');
 if(button.hasAttribute('data-run-detail')){ui.jobId=button.dataset.runDetail;location.hash='reports';render();}
 if(button.hasAttribute('data-reports-back')){ui.jobId=null;render();}
 if(button.hasAttribute('data-report-filter')){ui.reportFilter=button.dataset.reportFilter;render();}
 if(button.hasAttribute('data-refresh-records'))await refresh();
 if(button.hasAttribute('data-refresh-agent')){button.disabled=true;await refresh();}
 if(button.hasAttribute('data-agent-records')){location.hash='reports';render();}
 if(button.hasAttribute('data-dataset-detail')){ui.datasetId=button.dataset.datasetDetail;render();}
 if(button.hasAttribute('data-dataset-filter')){ui.datasetFilter=button.dataset.datasetFilter;render();}
 if(button.hasAttribute('data-datasets-back')){ui.datasetId=null;render();}
 if(button.hasAttribute('data-clear-selection')){ui.selection.clear();render();}
 if(button.hasAttribute('data-start-selection'))await openEvaluation(undefined,undefined,selectedItems(catalog,ui.selection));
 if(button.hasAttribute('data-scan')){scanning=true;render();try{discovery=await api('discovery/scan',{});notice(`扫描完成，发现 ${discovery.agents.length} 个安装入口。`);}finally{scanning=false;render();}}
 if(button.hasAttribute('data-open-agent')){
  const key=`${button.dataset.kind}:${button.dataset.openAgent}`;if(pendingConnections.has(key))return;pendingConnections.add(key);
  const label=button.textContent;button.disabled=true;button.textContent='正在连接…';
  if(button.dataset.kind==='qwenwork')notice('正在连接千问；若千问询问是否退出，请确认，随后会重新打开。');
  try{
   const response=await api(button.dataset.kind+'/open',button.dataset.kind==='workbuddy'?{}:{targetId:button.dataset.openAgent});
   notice(response.result?.status==='LOGIN_REQUIRED'?'已连接助手，请在助手应用中完成登录后继续。':response.result?.probeReady?'助手已连接，状态已更新。':'已请求启动 Agent，连接状态会自动更新；如需登录，请在 Agent 应用中完成。');
   await refresh();
  }finally{pendingConnections.delete(key);button.disabled=false;button.textContent=label;if(page()==='agents')render();}
 }
 if(button.hasAttribute('data-agent-model')){location.hash='settings';render();$('#agent-api-key')?.focus();}
 if(button.hasAttribute('data-graph-setup')){applyGraphPreset();$('#graph-error').textContent='';$('#graph-setup').showModal();}
 if(button.hasAttribute('data-connect')){button.disabled=true;await api('discovery/connect',{id:button.dataset.connect});notice('已接入，正在检查运行条件。');await refresh();}
 if(button.hasAttribute('data-start'))await openEvaluation(button.dataset.target,button.dataset.dataset);
 if(button.hasAttribute('data-library-prepare')){library=await api('library/prepare',{});render();}
 if(button.hasAttribute('data-library-cancel')){library=await api('library/cancel',{});render();}
 if(button.hasAttribute('data-library-catalog')){library=await api('library/catalog',{});render();}
 if(button.hasAttribute('data-library-download')){library=await api('library/download',{datasetId:button.dataset.libraryDownload});render();}
 if(button.hasAttribute('data-library-download-cancel')){library=await api('library/download-cancel',{});render();}
 if(button.hasAttribute('data-import')){button.disabled=true;const result=await desktop('importLibrary');if(result){notice(`已导入 ${result.datasets} 个测试集，共 ${result.cases} 题。`);await refresh();}}
 if(button.hasAttribute('data-configure')){await desktop('configureAgents');notice('在 agents.json 添加目标（参考同目录 agents.example.json）；DSH 修改 targets/real-dsh.json。保存后重新打开 App。');}
 if(button.hasAttribute('data-open-data'))await desktop('openData');
 if(button.hasAttribute('data-cancel')){await api((button.dataset.kind==='dsh'?'':button.dataset.kind+'/')+'cancel',{id:button.dataset.cancel});await refresh();}
 }catch(e){notice(e.message);}finally{button.disabled=false;}});
document.addEventListener('submit',async event=>{
 if(event.target.id!=='model-form')return;
 event.preventDefault();const form=event.target,button=form.querySelector('button');button.disabled=true;
 try{
  const values=Object.fromEntries(['planner','judge'].map(role=>[role,Object.fromEntries(['model','endpoint','apiKey'].map(field=>[field,form.elements[role+'-'+field].value]))]));
  settings=(await api('model-settings',values)).settings;
  for(const role of ['planner','judge']){
   for(const field of ['model','endpoint'])form.elements[role+'-'+field].value=settings[role][field];
   const key=form.elements[role+'-apiKey'];key.value='';key.placeholder=settings[role].keyConfigured?'已配置；留空保留':'尚未配置';
  }
  notice('模型设置已保存。');
 }catch(error){notice(error.message);}finally{button.disabled=false;}
});
document.addEventListener('submit',async event=>{
 if(event.target.id!=='agent-model-form')return;
 event.preventDefault();const form=event.target,button=form.querySelector('button'),input=form.elements.apiKey;button.disabled=true;
 try{
  agentModelSettings=(await api('agent-model-settings',{apiKey:input.value})).settings;
  input.value='';input.placeholder='已配置；留空保留';notice('被测 Agent 的模型密钥已保存，请返回「我的 Agent」检查状态。');await refresh();
 }catch(error){notice(error.message);}finally{button.disabled=false;}
});
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

setInterval(async()=>{
 if(!(['DOWNLOADING','INSTALLING'].includes(library.state)||library.catalog?.state==='LOADING'||['DOWNLOADING','INSTALLING'].includes(library.download?.state)))return;
 try{library=await api('library');if(library.state==='READY'||library.download?.state==='READY')await refresh();else render();}catch{}
},1000);
