let settingsAttempted=false;
let modelSettings=null,settingsLoading=false,settingsSaving=false,settingsMessage='',settingsFailed=false,settingsToken='';
function apiSettingsView(){
 if(!modelSettings&&!settingsLoading&&!settingsAttempted)queueMicrotask(loadApiSettings);
 const card=role=>{const s=modelSettings?.[role],name=role==='planner'?'Planner':'Judge';return '<section class="control-panel api-settings-card"><h2>'+name+'<span class="api-key-status">'+(s?.keyConfigured?'已配置密钥':'未配置密钥')+'</span></h2><p class="control-section-note">'+(role==='planner'?'用于选择测试集和生成评测计划。':'用于根据测试证据评分。')+'</p><label>模型名称<input name="'+role+'-model" value="'+esc(s?.model??'deepseek-flash')+'" required autocomplete="off"></label><label>接口地址<input name="'+role+'-endpoint" type="url" value="'+esc(s?.endpoint??'https://api.deepseek.com/chat/completions')+'" required autocomplete="off"><small>填写完整的 Chat Completions 地址。</small></label><label>API Key<input name="'+role+'-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="'+(s?.keyConfigured?'已配置；留空保留，填写可替换':'请输入 API Key')+'"></label></section>';};
 return '<div class="titlebar"><h1>系统设置</h1><button data-settings-reload '+(settingsLoading||settingsSaving?'disabled':'')+'>重新读取</button></div><p class="api-settings-intro">配置 EvalDock 的评测模型。密钥仅保存在服务端，保存后用于新启动的评测。</p>'+(settingsMessage?'<div class="control-message '+(settingsFailed?'api-settings-error':'')+'" role="status">'+esc(settingsMessage)+'</div>':'')+(settingsLoading?'<p role="status">正在读取配置…</p>':'')+'<form id="api-settings-form"><fieldset '+(!modelSettings||settingsSaving?'disabled':'')+'><div class="api-settings-grid">'+card('planner')+card('judge')+'</div><div class="api-settings-actions"><label class="api-settings-reuse"><input type="checkbox" name="reuse-planner">Judge 使用 Planner 的模型、接口和密钥</label><button class="primary" type="submit">'+(settingsSaving?'保存中…':'保存配置')+'</button></div></fieldset></form><p class="control-section-note">此处配置 Planner 和 Judge。被测 Agent 的 API 或账号仍由各自的运行环境管理。保存配置不代表已验证模型连接。</p>';
}
async function loadApiSettings(){
 if(settingsLoading||settingsSaving)return;settingsLoading=true;settingsAttempted=true;settingsFailed=false;
 try{const r=await fetch('/api/control/model-settings',{cache:'no-store',signal:AbortSignal.timeout(10000)});const body=await r.json();if(!r.ok)throw Error(body.error||'无法读取配置');modelSettings=body.settings;settingsToken=body.csrf;settingsMessage='';}
 catch{settingsFailed=true;settingsMessage='无法读取模型配置，请确认工作台服务已启动后重试。';}
 finally{settingsLoading=false;if(page==='settings')render();}
}
document.addEventListener('click',e=>{if(e.target.closest('[data-settings-reload]'))void loadApiSettings();});
document.addEventListener('change',e=>{if(e.target.name==='reuse-planner')for(const input of document.querySelectorAll('[name^="judge-"]'))input.disabled=e.target.checked;});
document.addEventListener('submit',async e=>{
 if(e.target.id!=='api-settings-form')return;e.preventDefault();if(settingsSaving)return;
 const form=e.target,data=new FormData(form),reuse=data.get('reuse-planner')==='on',body={reusePlannerForJudge:reuse};
 for(const role of ['planner','judge']){if(role==='judge'&&reuse)continue;body[role]={model:data.get(role+'-model'),endpoint:data.get(role+'-endpoint')};const key=data.get(role+'-key');if(key?.trim())body[role].apiKey=key.trim();}
 settingsSaving=true;settingsMessage='';form.querySelector('fieldset').disabled=true;
 try{
  const r=await fetch('/api/control/model-settings',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':settingsToken},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const out=await r.json();if(!r.ok)throw Error(out.error||'保存失败');modelSettings=out.settings;settingsMessage='配置已保存，新评测将使用更新后的配置。';settingsFailed=false;
  void refreshControl(true);
 }catch(error){settingsFailed=true;settingsMessage=error.name==='TimeoutError'?'保存结果尚未确认，请重新读取配置检查。':error.message==='Failed to fetch'?'无法连接工作台，请重试。':error.message;}
 finally{for(const role of ['planner','judge'])if(body[role])delete body[role].apiKey;settingsSaving=false;if(page==='settings')render();}
});
