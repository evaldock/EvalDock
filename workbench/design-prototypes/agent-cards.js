import {friendlyMessage} from './product-pages.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function matchesInstallation(target,installation) {
  const roots=[installation.path,installation.resolvedPath,installation.target?.sourceRoot,installation.target?.appPath].filter(Boolean);
  // Config paths can change while the discovery-generated target ID stays fixed.
  if(target.installRoot)return roots.includes(target.installRoot);
  return target.id==='local-'+installation.kind+'-'+installation.id;
}

function claudeCard(brand,installed) {
  const found=installed.length>0;
  const names={cli:'Claude Code（CLI）',app:'Claude（桌面）'};
  const types=new Set(installed.map(item=>item.type));
  const title=types.size===1?(names[installed[0].type]??'Claude Code / Claude'):'Claude Code / Claude';
  const entries=[...installed].sort((a,b)=>String(a.type).localeCompare(String(b.type))||String(a.id).localeCompare(String(b.id)));
  const versions=entries.map(item=>`<p class="agent-installation"><strong>${esc(names[item.type]??item.name)}</strong> · ${esc(item.version??'版本未读取')}${item.metadataError?`<br><span>${esc(item.metadataError)}</span>`:''}</p>`).join('');
  return `<article class="agent-card agent-card-claude ${found?'is-discovered':''}"><div class="agent-card-heading"><img src="assets/agents/${brand.kind}.${brand.format}" width="28" height="28" alt=""><h3>${esc(title)}</h3><span class="pill ${found?'discovered':''}">${found?'已发现 · 待适配':'待安装'}</span></div><p class="agent-description">评测适配器待接入</p>${versions}<div class="agent-card-footer"><span>${found?installed.length+' 个安装':'计划接入'}</span><div class="agent-card-actions"><button data-scan>重新扫描</button></div></div></article>`;
}

export function renderAgentCards({brands,targets,discovery,pendingConnections=new Set()}) {
  return brands.map(brand=>{
    const installed=discovery.agents.filter(d=>d.kind===brand.kind);
    if(brand.kind==='claude')return claudeCard(brand,installed);
    const configured=targets.filter(t=>t.kind===brand.kind);
    const target=configured.find(t=>t.evaluationReady===true)??configured[0];
    const installation=target?installed.find(d=>matchesInstallation(target,d)):installed[0];
    const ready=target?.evaluationReady===true;
    const found=!!installed.length;
    const state=ready?'可评测':found?(brand.planned?'已发现 · 待适配':'已发现'):'待安装';
    const version=target?.version??installation?.version;
    const versionText=version?String(version)+(target&&!target.version?'（扫描）':''):target||found?'版本未读取':brand.planned?'计划接入':'已支持';
    const reason=ready?null:target?.reasonCode;
    const description=reason?friendlyMessage(reason):brand.description;
    const available=installed.find(d=>d.target&&!configured.some(t=>
      t.id==='local-'+d.kind+'-'+d.id||matchesInstallation(t,d)));
    const launchable=brand.kind==='workbuddy'?reason==='WORKBUDDY_NOT_CONNECTED':['qwenwork','doubaowork'].includes(brand.kind)&&reason==='AGENT_NOT_CONNECTED';
    const connecting=pendingConnections.has(`${brand.kind}:${target?.id}`);
    const needsLogin=['WORKBUDDY_LOGIN_REQUIRED','AGENT_LOGIN_REQUIRED'].includes(reason);
    const cleanup=['WORKBUDDY_CLEANUP_REQUIRED','AGENT_CLEANUP_REQUIRED','AGENT_CLEANUP_REVIEW_REQUIRED','AGENT_COMPATIBILITY_BUSY_OR_INTERRUPTED'].includes(reason);
    let action='';
    if(ready)action=`<button data-start data-target="${esc(target.id)}" ${target.active?'disabled':''}>${target.active?'正在评测':'开始评测'}</button>`;
    else if(launchable)action=`<button data-open-agent="${esc(target.id)}" data-kind="${brand.kind}" ${connecting?'disabled':''}>${connecting?'正在连接…':'启动连接'}</button>`;
    else if(reason==='AGENT_MODEL_KEY_MISSING')action='<button data-agent-model>配置模型</button>';
    else if(cleanup)action='<button data-agent-records>查看评测记录</button><button data-refresh-agent>重新检查</button>';
    else {
      if(target)action=`<button data-refresh-agent>${needsLogin?'登录后重新检查':'重新检查'}</button>`;
      if(available)action+=`<button data-connect="${esc(available.id)}" title="${esc(available.path)}">${target?'接入新安装':'接入评测'}</button>`;
    }
    const details=target?`<details class="agent-diagnostics" data-preserve="agent-${esc(brand.kind)}-${esc(target.id)}"><summary>查看检查详情</summary><dl><dt>当前目标</dt><dd>${esc(target.name??brand.name)} · ${esc(target.id)}</dd><dt>检查状态</dt><dd>${esc(target.status??(ready?'READY':'待检查'))}</dd><dt>版本</dt><dd>${esc(versionText)}</dd>${reason?`<dt>原因</dt><dd><code>${esc(reason)}</code></dd>`:''}${target.checkedAt?`<dt>检查时间</dt><dd>${esc(target.checkedAt)}</dd>`:''}</dl></details>`:'';
    return `<article class="agent-card ${ready?'is-ready':found?'is-discovered':''}"><div class="agent-card-heading"><img src="assets/agents/${brand.kind}.${brand.format}" width="28" height="28" alt=""><h3>${brand.name}</h3><span class="pill ${ready?'ready':found?'discovered':''}">${state}</span></div><p class="agent-description">${esc(description)}</p>${details}<div class="agent-card-footer"><span>${esc(versionText)}${installed.length>1?' · '+installed.length+' 个安装':''}</span><div class="agent-card-actions">${action}</div></div></article>`;
  }).join('');
}
