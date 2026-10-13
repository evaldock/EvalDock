'use strict';
const D=JSON.parse(document.getElementById('graph-data').textContent),$=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const txt=x=>typeof x==='string'?x:JSON.stringify(x,null,2),cut=(s,n=55)=>{s=txt(s??'').replace(/\s+/g,' ');return s.length>n?s.slice(0,n-1)+'…':s};
const nodes=D.nodes.map(n=>({...n})),byId=new Map(nodes.map(n=>[n.id,n])),edges=D.edges;
const typeNames={CONTAINS:'包含',CAPTURE_NEXT:'记录先后',NEXT_RECORDED:'记录先后',CALL_RESULT:'调用返回',RESULT_OF:'返回对应',TARGETS:'操作目标',OBSERVES:'观测',STATE_OF:'状态归属',VERSION_OF:'版本归属',CONTENT_MATCH:'内容一致',FINAL_RESPONSE:'最终回复',PRODUCES:'产生',CONSUMES:'使用',SPAWNS:'派生执行'};
const kindNames={scope:'执行范围',action:'动作',observation:'工具返回',environment:'环境观测',completion:'会话结束',message:'消息',resource:'对象',state:'对象状态',unknown:'未知事件'};
const levelNames={direct:'直接记录',derived:'规则重建',hypothesis:'候选关系'};
const actionNodes=nodes.filter(n=>n.subtype==='action');
const pairs=new Map();
for(const e of edges.filter(e=>['CALL_RESULT','RESULT_OF'].includes(e.type))){const a=byId.get(e.source),b=byId.get(e.target);if(a?.subtype==='action')pairs.set(a.id,b.id);else if(b?.subtype==='action')pairs.set(b.id,a.id)}
const owner=new Map([...pairs].map(([a,b])=>[b,a]));
const stateOwner=new Map(nodes.filter(n=>n.kind==='state').map(n=>[n.id,n.resourceId||edges.find(e=>['STATE_OF','VERSION_OF'].includes(e.type)&&e.source===n.id)?.target]));
const assessments=D.reportAssessments||[],scoreNames={'artifact-delivery':'交付','efficiency-cost':'效率','reasoning-planning':'规划','tool-data':'工具','tool-code':'代码','loop':'闭环'};
const previousReviews=new Map((D.previousAssessments||[]).map(a=>[a.nodeId+'|'+a.dimension,a]));
const stepReviews=new Map((D.assessments||[]).map(a=>[a.nodeId+'|'+a.dimension,a]));
const dimensions=D.scoring?.dimensions||[{id:'relevance',name:'目标相关性'},{id:'appropriateness',name:'动作合理性'},{id:'progress',name:'有效进展'},{id:'feedback',name:'反馈处理'},{id:'efficiency',name:'执行效率'}];
const dimensionShort={relevance:'目标',appropriateness:'合理',progress:'进展',feedback:'反馈',efficiency:'效率'};
const importance=new Map((D.impact?.nodes||[]).map(n=>[n.nodeId,n]));
let scoreDimension='appropriateness',layoutGroups=[],activeGroup=null,groupingMode=D.presentation?.grouping==='llm'?'preset':'records';
const largeGraph=actionNodes.length>20||!!D.presentation?.stages?.length;
function stepReview(n,d=scoreDimension){return stepReviews.get(n.id+'|'+d)}
function scoreText(a){return a?.status==='scored'?String(a.value):a?.status==='not_applicable'?'N/A':a?.status==='insufficient_evidence'?'?':a?.status==='error'?'!':'—'}
function scoreColor(a){return a?.verdict==='error'?'#d82c36':a?.status==='scored'?`hsl(148 37% ${65-a.value*.34}%)`:'#aab9b0'}
function hasReviewError(n){return dimensions.some(d=>stepReview(n,d.id)?.verdict==='error')}
function rings(n){if(!stepReviews.size)return '';const size=shapeSize(n),w=n.w||size.w,h=n.h||size.h;return `<g class="step-rings"><path class="card-divider" d="M${-w/2},${h/2-77} H${w/2}"/>${dimensions.map((d,i)=>{const a=stepReview(n,d.id),x=(i-2)*51,color=scoreColor(a);return `<g data-step-dimension="${d.id}" data-step-owner="${n.id}" transform="translate(${x},${h/2-46})" role="button" tabindex="0" aria-label="${esc(d.name+' '+scoreText(a))}"><rect x="-23" y="-24" width="46" height="64" rx="2" fill="transparent"/><circle r="18" fill="none" stroke="#e0e8e3" stroke-width="2.5"/><circle r="18" fill="none" stroke="${color}" stroke-width="2.5" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${a?.status==='scored'?100-a.value:100}" transform="rotate(-90)"/><text text-anchor="middle" y="4" fill="${color}" font-size="12" font-weight="600">${esc(scoreText(a))}</text><text class="ring-name" text-anchor="middle" y="33" fill="#647080" font-size="12">${dimensionShort[d.id]}</text></g>`}).join('')}</g>`}

function comparisonPanel(n){if(!previousReviews.size)return '';return `<h3>评分升级 · 新旧对照</h3><p>新版按 0 / 25 / 50 / 75 / 100 五档评分；原分数保留。档位改变不等于准确性已提升。</p><table class="matrix"><thead><tr><th>维度</th><th>旧版</th><th>新版</th></tr></thead><tbody>${dimensions.map(d=>{const old=previousReviews.get(n.id+'|'+d.id),now=stepReview(n,d.id);return `<tr><td>${esc(d.name)}</td><td>${esc(scoreText(old))}</td><td>${esc(scoreText(now))}</td></tr>`}).join('')}</tbody></table>`;}
function stepPanel(n){if(!stepReviews.size)return `<h3>五维步骤评审</h3><div class="five-score-panel">${['目标','合理','进展','反馈','效率'].map(x=>`<div><b>—</b>${x}</div>`).join('')}</div><p>当前归档仅有整题标签分；没有逐步五维评审记录。</p>`;
 const a=stepReview(n),d=dimensions.find(d=>d.id===scoreDimension),role=importance.get(n.id);return `${comparisonPanel(n)}<h3>五维步骤初评 · 满分 100</h3><div class="five-score-panel">${dimensions.map(d=>{const a=stepReview(n,d.id);return `<button data-step-dimension="${d.id}" data-step-owner="${n.id}" class="${d.id===scoreDimension?'active':''}"><b style="color:${scoreColor(a)};border-color:${scoreColor(a)}">${esc(scoreText(a))}</b><span>${esc(dimensionShort[d.id]||d.name)}</span></button>`}).join('')}</div><strong>${esc(d.name)} · ${esc(scoreText(a))}</strong><p>${esc(a?.reason||'无评审记录')}</p><p>${esc(a?.judge||D.scoring?.review?.judge||'')} · ${esc(a?.rubricVersion||'')}</p>${a?.phase?`<p class="note">${a.phase==='decision'?'决策判断 · 仅行动前记录与当前参数':'效果判断 · 含返回及后续相关证据'} · ${a.evidenceValidation==='passed'?'引用校验通过':'未完成评审'}</p><p>反证：${esc(a.counterEvidence||'未提供')}</p><div>${(a.evidenceNodeIds||[]).map(id=>`<button class="evidence-button" data-jump="${esc(id)}">${esc(id)} · ${esc(nodeTitle(byId.get(id)||{}))}</button>`).join('')}</div><details><summary>旧版该维度理由</summary><p>${esc(previousReviews.get(n.id+'|'+d.id)?.reason||'无旧版记录')}</p></details>`:''}${a?.limitations?`<details><summary>评审范围与限制</summary><p>${esc(a.limitations)}</p></details>`:''}<details><summary>评分证据</summary>${sourceHTML(a?.sourceRefs||a?.evidence)}<pre>${esc(txt(a))}</pre></details>${role?`<h3>步骤重要性 · 初评</h3><p>${esc(({critical:'关键',supporting:'支撑',exploratory:'探查',off_task:'偏离'})[role.level]||role.level)}：${esc(role.reason)}</p>`:''}`}
function applyScoreDimension(id){scoreDimension=id;const s=$('scoreDimension');if(s)s.value=id;for(const el of svg.querySelectorAll('[data-node]')){const n=byId.get(el.dataset.node),old=el.querySelector('.step-rings');if(old)old.outerHTML=rings(n)}if(selected)selectNode(selected,detailTab)}
function renderGroupNav(){const nav=$('groupNav');nav.hidden=!largeGraph||mode==='resources';nav.innerHTML='<button class="advanced-control" id="groupingInfo">分组依据 ↗</button>';$('groupingInfo').onclick=showGroupingInfo;}

function showGroupingInfo(){openPanel('分组依据',`<h2>${groupingMode==='preset'?'LLM 内容分组':'记录分段'}</h2><p>程序提取每条记录的关键信息，由 ${esc(D.presentation?.model)} 按执行内容分组。${groupingMode==='preset'?'覆盖全部记录；'+pairs.size+' 组原生调用与返回没有拆开。':'分组请求未完成或记录量超出单次输入上限，使用顺序分段；事实关系保留。'}分组是阅读建议，不代表依赖关系。${D.presentation?.policy?`当前 ${D.presentation.stages?.length||0} 组，上限 ${D.presentation.policy.maxGroups} 组；过小的相邻组由规则合并。`:""}</p><table class="matrix"><tr><th>分组</th><th>依据</th></tr>${(D.presentation?.stages||[]).map(g=>`<tr><td>${esc(g.title)}<br>${g.recordIds.length} 条记录</td><td>${esc(g.reason)}${g.sourceGroups?.length>1?`<br>原分组：${g.sourceGroups.map(s=>esc(s.title)).join("、")}`:""}</td></tr>`).join('')}</table><p>对象跟随关联最密集的组，跨组关系保留。启动配置和重复消息在执行视图收起，在“全部记录”中可查看。</p>${sourceHTML(D.presentation?.sourceRefs)}<details><summary>模型调用与校验</summary><pre>${esc(txt(D.presentation?.provenance))}</pre></details>`)}
function focusGroup(id){const g=layoutGroups.find(g=>String(g.id)===String(id));if(!g)return;activeGroup=id;if($('groupPicker'))$('groupPicker').value=id;selected=null;selectedEdge=null;$('inspector').hidden=true;highlight();const b=svg.getBoundingClientRect();scale=Math.min((b.width-80)/g.w,(b.height-70)/g.h,1.12);tx=(b.width-g.w*scale)/2-g.x*scale;ty=(b.height-g.h*scale)/2-g.y*scale;transform();document.querySelectorAll('#groupNav [data-group]').forEach(n=>n.classList.toggle('active',n.dataset.group===String(id)));}

let mode='records',expanded=false,showSequence=true,showCandidates=true,selected=null,selectedEdge=null,detailTab='relations';
let visible=[],displayEdges=[],positions=new Map(),bounds={x:0,y:0,w:100,h:100},scale=1,tx=0,ty=0,drag=null,moved=false,searchMatches=[],matchAt=0;
const svg=$('graph');
function rawEvent(n){const r=n.raw||n.original||D.records?.find(r=>r.id===n.recordId||r.id===n.id);return r?.content?.data?.event?.data||r?.data?.event?.data||n.arguments&&{arguments:n.arguments}||r||{}}
function resultOf(n){const r=rawEvent(n);if(typeof r.result==='string'){try{return JSON.parse(r.result)}catch{return {output:r.result}}}return n.result||r}
function index(n){return n.index??n.recordIndex??null}
function nodeKind(n){return n.kind==='event'?(n.subtype||'unknown'):n.kind}
function resourceStates(id){return nodes.filter(n=>n.kind==='state'&&stateOwner.get(n.id)===id)}
function isMetadata(n){return n.kind==='state'&&!n.hash}
function nodeTitle(n){if(n.kind==='resource')return (n.path||n.label||'').split('/').pop();if(n.kind==='state')return n.hash?'内容快照':'环境状态';if(n.subtype==='action')return n.tool||rawEvent(n).name||n.label;if(n.subtype==='observation')return n.observationKind==='archive'||n.tool==='archive'||/归档|archive/i.test(n.label)?'归档文件':'工具返回';return n.label||kindNames[nodeKind(n)]}
function excerpt(n){const r=rawEvent(n),args=n.arguments||r.arguments||{};if(n.subtype==='action'){if(args.path)return args.path;if(args.command)return args.command.replace(/^cd\s+\S+\s*&&\s*/,'');return n.detail||''}if(n.kind==='resource')return n.path||n.detail||'';if(n.kind==='state')return n.content!=null?txt(n.content):txt(n.metadata||n.detail||{});const q=resultOf(n);return q.output||q.content||q.error||n.detail||n.content||''}
function nodeTime(n){const t=n.at||n.timestamp;return t?String(t).split('T')[1]?.replace(/\.\d+Z$/,'Z')||t:''}
function edgeLabel(e){if(e.projectionViaCandidate)return '候选返回 · '+(typeNames[e.type]||e.type);if(e.type==='TARGETS'){const op=e.operation||e.intent||e.op;return ({read:'读取请求',write:'写入请求',execute:'执行请求',patch:'修改请求',reference:'引用'})[op]||'操作目标'}return typeNames[e.type]||e.type}
function isSeq(e){return ['CAPTURE_NEXT','NEXT_RECORDED'].includes(e.type)}
function isContains(e){return e.type==='CONTAINS'}
function shapeSize(n){return n.subtype==='action'?{w:280,h:stepReviews.size?210:132}:{w:280,h:118}}
function buildProjection(){
 const hidden=new Set(nodes.filter(n=>n.kind==='scope').map(n=>n.id));
 if(mode==='execution'){
  for(const n of nodes)if(n.auxiliary)hidden.add(n.id);
  if(!expanded)for(const id of owner.keys()){const n=byId.get(id),r=resultOf(n);if(!n.isError&&!r.error&&!r.stale_write_blocked&&!(typeof r.exit_code==='number'&&r.exit_code!==0))hidden.add(id);}
  for(const n of nodes)if(n.kind==='state')hidden.add(n.id);
  for(const n of nodes)if(n.subtype==='observation'&&!owner.has(n.id)&&n.stateIds?.some(id=>byId.get(id)?.observationKind==='archive'))hidden.add(n.id);
 }else if(mode==='resources'){
  for(const n of nodes)if(n.kind==='event'&&n.subtype!=='environment')hidden.add(n.id);
 }
 visible=nodes.filter(n=>!hidden.has(n.id)).map(n=>({...n,...shapeSize(n)}));
 const displayId=id=>{if(!hidden.has(id))return id;if(mode==='execution'){if(owner.has(id))return owner.get(id);if(stateOwner.has(id))return stateOwner.get(id)}return null};
 const seen=new Map();displayEdges=[];
 for(const e of edges){if(isContains(e)||isSeq(e)&&!showSequence||e.evidenceStatus==='hypothesis'&&!showCandidates)continue;
  if(isSeq(e)&&(hidden.has(e.source)||hidden.has(e.target)))continue;
  const a=displayId(e.source),b=displayId(e.target);if(!a||!b||a===b||!visible.some(n=>n.id===a)||!visible.some(n=>n.id===b))continue;
  const key=[a,b,e.type,e.evidenceStatus].join('|');if(seen.has(key)){seen.get(key).members.push(e);continue}
  const viaCandidate=(owner.has(e.source)&&hidden.has(e.source)&&byId.get(e.source)?.pairEvidenceStatus==='hypothesis')||(owner.has(e.target)&&hidden.has(e.target)&&byId.get(e.target)?.pairEvidenceStatus==='hypothesis');
  if(viaCandidate&&!showCandidates)continue;
  const v={...e,a,b,members:[e],projected:a!==e.source||b!==e.target,projectionViaCandidate:viaCandidate,renderStatus:viaCandidate?'hypothesis':e.evidenceStatus};displayEdges.push(v);seen.set(key,v);
 }
 // If ordinary returns are folded, show the source sequence between visible events.
 if(mode==='execution'&&!expanded&&showSequence){
  const eventList=nodes.filter(n=>n.kind==='event'&&visible.some(v=>v.id===n.id)).sort((a,b)=>(index(a)||999)-(index(b)||999));
  for(let i=0;i<eventList.length-1;i++){const a=eventList[i],b=eventList[i+1];if(displayEdges.some(e=>isSeq(e)&&e.a===a.id&&e.b===b.id))continue;
   const path=[];let cur=a.id,guard=0;while(cur!==b.id&&guard++<nodes.length){const e=edges.find(e=>isSeq(e)&&e.source===cur);if(!e)break;path.push(e);cur=e.target;if(cur!==b.id&&visible.some(n=>n.id===cur))break}
   if(cur===b.id&&path.length)displayEdges.push({id:'projection:'+a.id+':'+b.id,type:'CAPTURE_NEXT',a:a.id,b:b.id,source:a.id,target:b.id,evidenceStatus:'derived',projected:true,members:path,sourceRefs:path.flatMap(e=>e.sourceRefs||[]),rule:'仅折叠同源连续记录，非执行依赖'});
  }
 }
}
function layout(){
 positions.clear();layoutGroups=[];
 if(!visible.length){bounds={x:0,y:0,w:100,h:100};return;}
 if(largeGraph&&mode!=='resources'&&typeof layoutLargeTAG==='function'){const result=layoutLargeTAG(visible,displayEdges,groupingMode==='preset'?(D.presentation||{}):{recordCount:D.meta.recordCount||D.records?.length});layoutGroups=result.groups;for(const n of visible)positions.set(n.id,n);bounds=result.bounds;return;}
 if(mode==='resources'){
  const resources=visible.filter(n=>n.kind==='resource'),wide=resources.length>9;
  const cols=Math.min(wide?6:3,resources.length),pitch=wide?580:620;
  // Keep each object's states directly below it; avoid a very tall three-column graph.
  if(wide)resources.sort((a,b)=>resourceStates(b.id).length-resourceStates(a.id).length||a.id.localeCompare(b.id));
  let rowY=100;
  for(let start=0;start<resources.length;start+=cols){const row=resources.slice(start,start+cols);let rowBottom=rowY+64;
   row.forEach((r,col)=>{r.x=col*pitch+220;r.y=rowY;const states=visible.filter(n=>stateOwner.get(n.id)===r.id);
    states.forEach((s,j)=>{s.x=r.x+(j%2===0?-1:1)*(states.length>1?135:0);s.y=r.y+215+Math.floor(j/2)*165;rowBottom=Math.max(rowBottom,s.y+s.h/2)});
   });rowY=wide?rowBottom+180:rowY+460;
  }
  const rest=visible.filter(n=>n.kind!=='state'&&n.kind!=='resource');rest.forEach((n,i)=>{n.x=wide?(cols-1)*pitch/2+220:cols*620+130;n.y=wide?-160-i*210:330+i*210});
 }else{
  const events=visible.filter(n=>n.kind==='event').sort((a,b)=>(index(a)||999)-(index(b)||999));
  const actions=events.filter(n=>n.subtype==='action'),cols=Math.min(4,Math.ceil(Math.sqrt(actions.length*1.8))||4);
  actions.forEach((n,i)=>{const row=Math.floor(i/cols),k=i%cols,col=row%2?cols-1-k:k;n.x=col*480+230;n.y=row*380+210+Math.sin(i*1.7)*40});
  const positioned=new Set(actions.map(n=>n.id));
  events.filter(n=>!positioned.has(n.id)).forEach((n,i)=>{const a=visible.find(v=>v.id===owner.get(n.id));if(a){n.x=a.x+85;n.y=a.y+220}else{n.x=cols*480+190;n.y=150+(i%5)*205+Math.floor(i/5)*120}positioned.add(n.id)});
  const resources=visible.filter(n=>n.kind==='resource');
  resources.forEach((n,i)=>{const linked=displayEdges.filter(e=>(e.a===n.id||e.b===n.id)&&!isSeq(e)).map(e=>visible.find(x=>x.id===(e.a===n.id?e.b:e.a))).filter(x=>x?.subtype==='action');const a=linked[0];n.x=a?a.x+(i%2?-90:100):(i%4)*440+240;n.y=a?a.y+(i<3?-215:215):1350+Math.floor(i/4)*240});
  visible.filter(n=>n.kind==='state').forEach((n,i)=>{const r=visible.find(r=>r.id===stateOwner.get(n.id));const sib=visible.filter(x=>stateOwner.get(x.id)===stateOwner.get(n.id));n.x=(r?.x||0)+(sib.indexOf(n)%2?135:-135);n.y=(r?.y||0)+210+Math.floor(sib.indexOf(n)/2)*160});
 }
 // Stable collision relaxation. No stochastic seed or case-specific phase positions.
 const initial=new Map(visible.map(n=>[n.id,{x:n.x,y:n.y}]));
 for(let k=0;k<260;k++){
  for(const n of visible){const a=initial.get(n.id);n.x+=(a.x-n.x)*.014;n.y+=(a.y-n.y)*.014}
  for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++){const a=visible[i],b=visible[j],dx=b.x-a.x||.001,dy=b.y-a.y||.001,ox=(a.w+b.w)/2+64-Math.abs(dx),oy=(a.h+b.h)/2+62-Math.abs(dy);if(ox>0&&oy>0){if(ox<oy){const push=Math.sign(dx)*ox*.51;a.x-=push;b.x+=push}else{const push=Math.sign(dy)*oy*.51;a.y-=push;b.y+=push}}}
 }
 for(const n of visible)positions.set(n.id,n);
 const x=Math.min(...visible.map(n=>n.x-n.w/2))-70,y=Math.min(...visible.map(n=>n.y-n.h/2))-70;
 bounds={x,y,w:Math.max(...visible.map(n=>n.x+n.w/2))-x+70,h:Math.max(...visible.map(n=>n.y+n.h/2))-y+70};
}
let pathCache=new Map();
function routeAll(){
 pathCache.clear();
 const pairs=new Map(),ports=new Map(),point=p=>p.map(v=>Math.round(v*100)/100).join(' ');
 const pairKey=e=>[e.a,e.b].sort().join('\u0000');
 for(const e of displayEdges){const key=pairKey(e);if(!pairs.has(key))pairs.set(key,[]);pairs.get(key).push(e)}
 for(const list of pairs.values())list.sort((a,b)=>String(a.type).localeCompare(String(b.type))||String(a.id).localeCompare(String(b.id)));
 // Clip along the actual tangent to the rounded card. Ports are not fixed to
 // opposite sides: that was responsible for U-turns when cards were diagonal.
 function inside(n,x,y,inset=0){
  const hw=n.w/2-inset,hh=n.h/2-inset,dx=x-n.x,dy=y-n.y;
  if(Math.abs(dx)>hw||Math.abs(dy)>hh)return false;
  const radius=0;
  return Math.hypot(Math.max(0,Math.abs(dx)-hw+radius),Math.max(0,Math.abs(dy)-hh+radius))<=radius;
 }
 function boundary(n,toward){
  const dx=toward[0]-n.x,dy=toward[1]-n.y,d=Math.hypot(dx,dy)||1,ux=dx/d,uy=dy/d;
  let lo=0,hi=Math.hypot(n.w,n.h);
  for(let i=0;i<28;i++){const m=(lo+hi)/2;if(inside(n,n.x+ux*m,n.y+uy*m))lo=m;else hi=m}
  return [n.x+ux*(hi+1.5),n.y+uy*(hi+1.5)];
 }
 function segmentHits(a,b,n){
  const pad=8,x0=n.x-n.w/2-pad,x1=n.x+n.w/2+pad,y0=n.y-n.h/2-pad,y1=n.y+n.h/2+pad;
  if(Math.max(a[0],b[0])<x0||Math.min(a[0],b[0])>x1||Math.max(a[1],b[1])<y0||Math.min(a[1],b[1])>y1)return false;
  let low=0,high=1;const d=[b[0]-a[0],b[1]-a[1]];
  for(const [p,q] of [[-d[0],a[0]-x0],[d[0],x1-a[0]],[-d[1],a[1]-y0],[d[1],y1-a[1]]]){
   if(Math.abs(p)<1e-9){if(q<0)return false;continue}
   const r=q/p;if(p<0)low=Math.max(low,r);else high=Math.min(high,r);if(low>high)return false;
  }
  return true;
 }
 const distance=e=>{const a=positions.get(e.a),b=positions.get(e.b);return a&&b?Math.hypot(a.x-b.x,a.y-b.y):Infinity};
 const ordered=[...displayEdges].sort((a,b)=>distance(a)-distance(b)||Number(isSeq(a))-Number(isSeq(b))||String(a.id).localeCompare(String(b.id)));
 for(const e of ordered){
  const a=positions.get(e.a),b=positions.get(e.b);if(!a||!b||a===b)continue;
  const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,nx=-dy/d,ny=dx/d,mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
  const peers=pairs.get(pairKey(e)),slot=peers.indexOf(e)-(peers.length-1)/2,sign=String(e.a)<String(e.b)?1:-1;
  const lane=slot*28*sign,base=lane+(isSeq(e)?Math.min(28,d*.035)*sign:0),limit=Math.min(340,Math.max(100,d*.23));
  const candidates=[base,...[38,76,125,190,270,340,limit].filter(v=>v<=limit).flatMap(v=>[base+v,base-v])];
  const seen=new Set();let best=null;
  for(const bend of candidates){
   if(Math.abs(bend)>limit+Math.abs(base)||seen.has(bend))continue;seen.add(bend);
   const c=[mx+nx*bend,my+ny*bend],s=boundary(a,c),t=boundary(b,c),steps=Math.max(18,Math.min(100,Math.ceil(d/55))),samples=[];
   let length=0,invalid=false;
   for(let i=0;i<=steps;i++){const u=i/steps,v=1-u,p=[v*v*s[0]+2*v*u*c[0]+u*u*t[0],v*v*s[1]+2*v*u*c[1]+u*u*t[1]];
    if(i>0&&i<steps&&(inside(a,p[0],p[1],.5)||inside(b,p[0],p[1],.5))){invalid=true;break}
    if(i)length+=Math.hypot(p[0]-samples[i-1][0],p[1]-samples[i-1][1]);samples.push(p);
   }
   if(invalid)continue;
   const minX=Math.min(s[0],t[0],c[0]),maxX=Math.max(s[0],t[0],c[0]),minY=Math.min(s[1],t[1],c[1]),maxY=Math.max(s[1],t[1],c[1]);
   let hits=0;
   for(const n of visible){
    if(n===a||n===b||n.id===a.id||n.id===b.id||n.x+n.w/2+8<minX||n.x-n.w/2-8>maxX||n.y+n.h/2+8<minY||n.y-n.h/2-8>maxY)continue;
    for(let i=1;i<samples.length;i++)if(segmentHits(samples[i-1],samples[i],n)){hits++;break}
   }
   const portKey=n=>n.id+':'+Math.round(Math.atan2(c[1]-n.y,c[0]-n.x)*6/Math.PI);
   const keys=[portKey(a),portKey(b)],crowding=keys.reduce((sum,key)=>sum+(ports.get(key)||0),0);
   const cost=hits*100000+Math.abs(bend-base)*.2+Math.abs(bend)*.07+length*.04+crowding*.7;
   if(!best||cost<best.cost)best={s,t,c,bend,cost,hits,keys};
   // An unobstructed direct link or its small parallel lane is always clearest.
   if(bend===base&&!hits)break;
  }
  if(!best){const s=boundary(a,[b.x,b.y]),t=boundary(b,[a.x,a.y]);best={s,t,c:[mx,my],bend:0,keys:[]}}
  for(const key of best.keys)ports.set(key,(ports.get(key)||0)+1);
  // One straight segment or one bounded quadratic arc: never grid detours,
  // rectangular loops, artificial waypoints, or a change to graph semantics.
  pathCache.set(e.id,Math.abs(best.bend)<.01?`M ${point(best.s)} L ${point(best.t)}`:`M ${point(best.s)} Q ${point(best.c)} ${point(best.t)}`);
 }
}
function edgePath(e){return pathCache.get(e.id)||''}
const cardIcons={action:'<path d="m5 4 5 5-5 5M12 14h4"/>',observation:'<path d="M4 3h12v11H9l-4 3v-3H4z"/>',error:'<path d="M10 2 19 17H1zM10 7v4M10 14h.01"/>',resource:'<path d="M5 2h7l4 4v12H5zM12 2v5h4"/>',state:'<path d="m10 2 8 4-8 4-8-4zM2 10l8 4 8-4M2 14l8 4 8-4"/>',message:'<path d="M2 3h16v11H8l-5 4v-4H2zM6 7h8M6 10h5"/>',lifecycle:'<circle cx="10" cy="10" r="7"/><path d="M10 5v5l3 2"/>'};
function cardError(n){const r=resultOf(n);return !!(n.isError||r.error||r.stale_write_blocked||(typeof r.exit_code==='number'&&r.exit_code!==0))}
function cardText(value,width,font){let out='',used=0;for(const c of txt(value??'').replace(/\s+/g,' ')){used+=c.charCodeAt(0)>255?font:font*.61;if(used>width-font)return out+'…';out+=c}return out}
function shape(n){const x=-n.w/2,y=-n.h/2;return `<rect class="node-body" x="${x}" y="${y}" width="${n.w}" height="${n.h}"/><rect class="node-header-bg" x="${x+.5}" y="${y+.5}" width="${n.w-1}" height="39.5"/><path class="card-divider" d="M${x},${y+40} H${-x}"/>`}
function glyph(n){const x=-n.w/2+14,y=-n.h/2,k=nodeKind(n),error=cardError(n),r=resultOf(n);let label=({action:'工具动作',observation:'工具返回',resource:'文件对象',state:n.hash?'内容快照':'环境状态',message:'Agent 消息',completion:'执行结束',environment:'环境观测'})[k]||'步骤事件';if(error&&k==='observation')label='错误返回';if(k==='message'&&n.eventType!=='assistant/message')label=n.label||'消息';
 let title=nodeTitle(n),brief=excerpt(n);
 if(k==='observation'){title=error?(String(r.output||r.error||'').match(/\b[A-Za-z]+Error\b/)?.[0]||'工具执行错误'):(n.tool?n.tool+' 返回':title);brief=error?(String(r.output||r.error||'').split('\n').find(l=>/\b[A-Za-z]+Error:/.test(l))||brief):brief;}
 if(k==='state'){title=(n.path||byId.get(stateOwner.get(n.id))?.path||title).split('/').pop();brief=n.hash?'SHA-256 '+String(n.hash).slice(0,12):cardText(brief,252,13);}
 const icon=error?'error':cardIcons[k]?k:'lifecycle';
 let s=shape(n)+`<g class="card-icon" transform="translate(${x},${y+10})" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${cardIcons[icon]}</g><text class="node-tag" x="${x+27}" y="${y+26}">${esc(cardText(label,165,13))}</text><text class="node-tag card-id" x="${n.w/2-14}" y="${y+26}" text-anchor="end">${index(n)?'#'+index(n):k==='resource'?'文件':''}</text><text class="node-title" x="${x}" y="${y+72}">${esc(cardText(title,n.w-28,18))}</text><text class="node-copy" x="${x}" y="${y+98}">${esc(cardText(brief,n.w-28,13))}</text>`;
 if(k==='action'){const ret=byId.get(pairs.get(n.id));if(ret&&!visible.some(v=>v.id===ret.id))s+=`<g class="folded-return" data-return="${esc(ret.id)}" role="button" tabindex="0"><text class="return-text" x="${x}" y="${y+120}">↳ #${index(ret)} 工具返回</text></g>`;s+=rings(n)}return s;
}

function isCrossGroup(e){const a=positions.get(e.a),b=positions.get(e.b);return !!(a?.groupId&&b?.groupId&&a.groupId!==b.groupId)}
function render(fit=true){buildProjection();layout();routeAll();svg.innerHTML=`<defs>${[['normal','#4c896a'],['hypothesis','#b18a4f'],['sequence','#a0aeb4'],['version','#618aa4']].map(([id,c])=>`<marker id="arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="${c}"/></marker>`).join('')}</defs><g id="world"><g id="groupLayer">${layoutGroups.map(g=>`<g data-group="${g.id}" role="button" tabindex="0" aria-label="阅读分组 ${esc(g.title)}"><text class="group-title" x="${g.x+g.w/2}" y="${g.y+38}" text-anchor="middle">${esc(g.title.slice(0,12))}${g.title.length>12?`<tspan x="${g.x+g.w/2}" dy="1.12em">${esc(g.title.slice(12))}</tspan>`:''}</text></g>`).join('')}</g><g id="edgeLayer">${displayEdges.map(e=>{const cls=isSeq(e)?'sequence':(e.renderStatus||e.evidenceStatus)==='hypothesis'?'hypothesis':/STATE_OF|VERSION_OF|CONTENT_MATCH/.test(e.type)?'version':'normal';return `<g data-edge="${esc(e.id)}"><path class="edge ${cls}${!isSeq(e)&&isCrossGroup(e)?' cross-group':''}" d="${edgePath(e)}" marker-end="url(#arrow-${cls})"/><path class="edge-hit" d="${edgePath(e)}"/><title>${esc(edgeLabel(e)+' · '+(levelNames[e.evidenceStatus]||'')+(e.projected?' · 折叠投影':''))}</title></g>`}).join('')}</g><g id="nodeLayer">${visible.map(n=>`<g class="node ${esc(nodeKind(n))}${hasReviewError(n)?' judged-error':''}${n.isError||resultOf(n)?.error||resultOf(n)?.stale_write_blocked||(typeof resultOf(n)?.exit_code==='number'&&resultOf(n).exit_code!==0)?' exception':''}" data-node="${esc(n.id)}" transform="translate(${n.x},${n.y})" tabindex="0" role="button" aria-label="${esc((index(n)?'#'+index(n)+' ':'')+nodeTitle(n))}">${glyph(n)}<g class="overview-label"><text text-anchor="middle" y="-10">${index(n)?'#'+index(n):''}</text><text text-anchor="middle" y="45">${esc(cut(nodeTitle(n),12))}</text></g></g>`).join('')}</g></g>`;
 $('visibleCount').textContent=`${visible.length} / ${nodes.length} 节点 · ${D.records?.length||D.meta.recordCount} 条记录`;
 $('caption').textContent=mode==='resources'?'同一对象的观测状态 · 内容一致不等于因果已证实':mode==='records'?'全部原始记录已展开 · 灰线只表示采集顺序':'实线看局部 · 绿虚线跨组 · 灰点线看顺序 · 点击节点突出关联';
 if(fit)fitAll();else transform();highlight();renderMini();renderGroupNav();
}
function transform(){const world=$('world');if(world)world.setAttribute('transform',`translate(${tx},${ty}) scale(${scale})`);$('zoomValue').textContent=Math.round(scale*100)+'%';svg.classList.toggle('overview',scale<.68);svg.classList.toggle('far-overview',scale<.29);for(const t of svg.querySelectorAll('.group-title'))t.style.fontSize=Math.min(65,Math.max(24,14/scale))+'px';updateViewport()}
function fitAll(){const box=svg.getBoundingClientRect();scale=Math.min((box.width-70)/bounds.w,(box.height-65)/bounds.h,1.1);tx=(box.width-bounds.w*scale)/2-bounds.x*scale;ty=(box.height-bounds.h*scale)/2-bounds.y*scale;transform()}
function zoomTo(f,cx,cy){const b=svg.getBoundingClientRect();cx=cx??b.width/2;cy=cy??b.height/2;const next=Math.max(.12,Math.min(2.6,scale*f));tx=cx-(cx-tx)*next/scale;ty=cy-(cy-ty)*next/scale;scale=next;transform()}
function focusNode(id){let n=positions.get(id)||positions.get(owner.get(id))||positions.get(stateOwner.get(id));if(!n)return;const box=svg.getBoundingClientRect();scale=Math.min(1.08,box.width/520);tx=box.width*.38-n.x*scale;ty=box.height*.46-n.y*scale;transform()}
function renderMini(){$('minimap').setAttribute('viewBox',`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);$('minimap').innerHTML=visible.map(n=>`<rect x="${n.x-n.w/2}" y="${n.y-n.h/2}" width="${n.w}" height="${n.h}" rx="12" fill="${n.kind==='resource'?'#79a68b':n.kind==='state'?'#92b6cc':'#c2cfcb'}"/>`).join('')+'<rect id="viewport" fill="#4d887813" stroke="#8cab9b" stroke-width="6"/>';updateViewport()}
function updateViewport(){const v=$('viewport');if(!v)return;const b=svg.getBoundingClientRect();v.setAttribute('x',-tx/scale);v.setAttribute('y',-ty/scale);v.setAttribute('width',b.width/scale);v.setAttribute('height',b.height/scale)}
function highlight(){const around=new Set(selected?[selected]:[]);if(selected)for(const e of edges)if(e.source===selected||e.target===selected){around.add(e.source);around.add(e.target)};const vSelected=selected&&(positions.has(selected)?selected:owner.get(selected)||stateOwner.get(selected));if(vSelected)around.add(vSelected);
 for(const el of svg.querySelectorAll('[data-node]')){const id=el.dataset.node;el.classList.toggle('selected',id===vSelected);el.classList.toggle('dim',!!selected&&!around.has(id));el.classList.toggle('match',searchMatches.includes(id))}
 for(const el of svg.querySelectorAll('[data-edge]')){const e=displayEdges.find(x=>x.id===el.dataset.edge);const near=selected&&(e.a===vSelected||e.b===vSelected);const path=el.querySelector('.edge');path.classList.toggle('dim',!!selected&&!near);path.classList.toggle('selected',!!near||selectedEdge===e.id)}
 svg.querySelectorAll('.edge-label').forEach(n=>n.remove());if(selected||selectedEdge)for(const e of displayEdges){if(e.id===selectedEdge||e.a===vSelected||e.b===vSelected){const a=positions.get(e.a),b=positions.get(e.b),t=document.createElementNS('http://www.w3.org/2000/svg','text');t.classList.add('edge-label');t.setAttribute('x',(a.x+b.x)/2);t.setAttribute('y',(a.y+b.y)/2-8);t.textContent=edgeLabel(e);$('edgeLayer').append(t)}}
}
function sourceHTML(refs){return (refs||[]).map(r=>`<div class="source-item"><a href="${esc(r.file||'data/trace.json')}" target="_blank" rel="noopener">${esc(r.file||r.source||'trace.json')} ↗</a><br>${esc(r.pointer||r.recordId||txt(r))}${r.sha256?'<br>SHA256 '+esc(r.sha256):''}</div>`).join('')||'<p>此视图聚合原始节点，证据见对应节点。</p>'}
function openPanel(title,content){$('panelTitle').textContent=title;$('detail').innerHTML=content;$('inspector').hidden=false}
function relatedHTML(n){const related=edges.filter(e=>!isContains(e)&&!isSeq(e)&&(e.source===n.id||e.target===n.id));return related.map(e=>{const other=byId.get(e.source===n.id?e.target:e.source);return `<button class="relation" data-jump="${esc(other.id)}"><span class="rel-key">${e.source===n.id?'→':'←'} ${esc(edgeLabel(e))}</span><span>${index(other)?'#'+index(other)+' ':''}${esc(cut(nodeTitle(other),23))}</span><small>${e.evidenceStatus==='hypothesis'?'候选':e.evidenceStatus==='derived'?'规则':''}</small></button>`}).join('')||'<p>没有可证实的对象关系。</p>'}
function statePanel(n){const ss=n.kind==='resource'?resourceStates(n.id):[];return ss.length?`<h3>已观测状态 · ${ss.length}</h3>${ss.map(s=>`<button class="relation" data-jump="${esc(s.id)}"><span>${s.hash?'内容快照':'环境元数据'}</span><small>${s.hash?String(s.hash).slice(0,12):'无内容哈希'} →</small></button>`).join('')}`:''}
function structuredResult(n){let v=resultOf(n);try{if(typeof v.output==='string')v=JSON.parse(v.output)}catch{}if(!Array.isArray(v?.rows)||!Array.isArray(v?.columns))return '';return `<table class="matrix"><thead><tr>${v.columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${v.rows.slice(0,30).map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`}
function selectNode(id,tab='relations'){const n=byId.get(id);if(!n)return;selected=id;selectedEdge=null;detailTab=tab;highlight();const k=nodeKind(n);let content=`<h2>${index(n)?'#'+index(n)+' ':''}${esc(nodeTitle(n))}</h2><div class="tags"><span class="tag">${esc(kindNames[k]||k)}</span>${n.hash?'<span class="tag">SHA-256 已核验</span>':''}${n.subtype==='action'?'<span class="tag">'+(stepReviews.size?(esc(D.scoring?.review?.judge||'配置模型')+' 初评'):'步骤评分未执行')+'</span>':''}</div><div class="detail-tabs">${[['relations','关系与状态'],['raw','原始内容'],['source','来源证据']].map(([key,t])=>`<button data-tab="${key}" class="${tab===key?'active':''}">${t}</button>`).join('')}</div>`;
 if(tab==='raw')content+=`<pre>${esc(txt(n.kind==='event'?(n.raw||n.original||n):n.content??n.metadata??n))}</pre>`;
 else if(tab==='source')content+=sourceHTML(n.sourceRefs)+`<details><summary>完整节点</summary><pre>${esc(txt(n))}</pre></details>`;
 else{content+=`${structuredResult(n)}<pre>${esc(txt(excerpt(n)))}</pre>`;
  if(n.kind==='state')content+=`<dl class="facts"><dt>内容哈希</dt><dd>${esc(n.hash||'未记录')}</dd><dt>字节数</dt><dd>${esc(n.byteLength??'未记录')}</dd><dt>状态类型</dt><dd>${esc(n.observationKind||n.stateType||'观测快照')}</dd></dl>`;
  if(n.kind==='resource')content+=`<dl class="facts"><dt>对象标识</dt><dd>${esc(n.path||n.label)}</dd><dt>环境范围</dt><dd>${esc(n.environmentId||n.namespace||'以本次执行范围限定')}</dd></dl>`;
  content+=statePanel(n)+`<h3>关联关系</h3>${relatedHTML(n)}`;
  if(n.subtype==='action'){content+=stepPanel(n);const linked=assessments.filter(a=>(a.evidenceIds||[]).includes(n.recordId)|| (a.evidenceIds||[]).includes(n.raw?.id));if(linked.length)content+=`<h3>引用此记录的原报告评审</h3>${linked.map(a=>`<button class="evidence-button" data-assessment="${assessments.indexOf(a)}">${scoreName(a)} · ${a.score}</button>`).join('')}`;}
  if(n.subtype==='environment')content+='<div class="note">环境前后变化已记录；归档明确标记 causality: NOT_PROVEN，不能归因到某一次动作。</div>';
  const seq=edges.filter(e=>isSeq(e)&&(e.source===id||e.target===id));if(seq.length)content+=`<details><summary>记录先后 · 非执行依赖</summary>${seq.map(e=>{const x=byId.get(e.source===id?e.target:e.source);return `<button class="relation" data-jump="${x.id}">${e.source===id?'后一条':'前一条'} #${index(x)} ${esc(nodeTitle(x))}</button>`}).join('')}</details>`;
 }
 openPanel(kindNames[k]||'TAG 节点',content);
 if(window.contextDebug)contextSelectNode(id);
}
function selectEdge(id){const e=displayEdges.find(x=>x.id===id)||edges.find(x=>x.id===id);if(!e)return;selected=null;selectedEdge=id;highlight();openPanel('关系证据',`<h2>${esc(edgeLabel(e))}</h2><div class="tags"><span class="tag ${e.evidenceStatus==='hypothesis'?'candidate':''}">${esc(levelNames[e.evidenceStatus])}</span>${e.projected?'<span class="tag">折叠视图投影</span>':''}${isCrossGroup(e)&&!isSeq(e)?'<span class="tag">跨组关联 · 虚线仅为显示样式</span>':''}${e.projectionViaCandidate?'<span class="tag candidate">经过候选配对折叠</span>':''}</div>${[e.source||e.a,e.target||e.b].map((id,i)=>{const n=byId.get(id);return n?`<button class="relation" data-jump="${id}">${i?'到':'从'} · ${index(n)?'#'+index(n)+' ':''}${esc(nodeTitle(n))}</button>`:''}).join('')}<p>${esc(txt(e.rule||e.method||e.description||'关系来自已归档字段，详细规则和证据如下。'))}</p>${isSeq(e)?'<div class="note">仅表示同一采集流的记录先后，不能证明步骤依赖或串行执行。</div>':''}${e.type==='CONTENT_MATCH'?'<div class="note">内容相等不证明该动作产生了最终文件，也不证明执行时文件版本。</div>':''}${e.projectionViaCandidate?'<div class="note">原始关系属于工具返回；画面通过候选调用配对将它折叠到动作上。虚线表示此投影不构成已确认的动作因果。</div>':''}<h3>来源证据</h3>${sourceHTML(e.sourceRefs)}<details><summary>完整关系${e.members?.length>1?' · '+e.members.length+' 条原始边':''}</summary><pre>${esc(txt(e))}</pre></details>`)}
function scoreName(a){const k=String(a.labelId||a.dimension||'').replace(/^label\./,'').replace(/\/v\d+$/,'');return scoreNames[k]||k}
function showAssessment(i){const a=assessments[i];if(!a)return;selected=null;highlight();openPanel('原报告评审',`<h2>${esc(scoreName(a))}</h2><div class="model"><div class="score-large">${esc(a.score)} <small style="font-size:14px">/ ${a.scale?.max||100}</small></div><p>${esc(a.model)} · 整题标签分</p></div><p>${esc(a.reason)}</p><div class="note">原始评审意见保留原文；其引用与判断不自动成为事实关系，也不代表每个步骤都获得此分。</div><h3>引用记录</h3>${(a.evidenceIds||[]).map(r=>{const n=nodes.find(n=>n.recordId===r||n.raw?.id===r);return n?`<button class="evidence-button" data-jump="${n.id}">#${index(n)} ${esc(nodeTitle(n))}</button>`:`<span class="no-data">${esc(r)} · 未匹配</span>`}).join('')}<details><summary>完整评分记录</summary><pre>${esc(txt(a))}</pre></details>`)}
function showAbout(){const counts=Object.fromEntries(['scope','event','resource','state'].map(k=>[k,nodes.filter(n=>n.kind===k).length]));const pairs=edges.filter(e=>e.type==='CALL_RESULT');openPanel('TAG · 模型与证据',`<h2>事实、状态、评审分开</h2><table class="matrix"><tr><th>类型</th><th>当前 Case</th></tr>${[['scope','执行范围'],['event','事件'],['resource','对象'],['state','对象状态']].map(([k,name])=>`<tr><td>${name}</td><td>${counts[k]}</td></tr>`).join('')}</table><h3>关系可信度</h3><p>绿色实线：组内关联；绿色长虚线：跨组关联；灰色点线：记录先后；金色短虚线：候选关系。跨组虚线只用于减少视觉干扰，不降低原有证据可信度。</p><p>${pairs.filter(e=>e.evidenceStatus==='hypothesis').length} 组候选配对。${nodes.filter(n=>n.eventType==='tool/result'&&!owner.has(n.id)).length} 条工具返回未配对，保留独立节点。</p><h3>已观测状态</h3><p>${nodes.filter(n=>n.kind==='state'&&n.hash).length} 个内容快照；${nodes.filter(n=>n.kind==='state'&&!n.hash).length} 个仅元数据状态。没有内容哈希时，不编造中间版本。</p><h3>评分来源</h3><p>事实图由规则转换，未调用 LLM。原报告 ${assessments.length} 项整题评分独立保留。${stepReviews.size?'已有 '+stepReviews.size+' 项五维初评，未经人工复核。':'五维逐步评分尚未执行。'}</p>${largeGraph?`<p>${groupingMode==='preset'?'LLM 内容分组':'\u6bcf 20 \u6761\u8bb0\u5f55\u5206\u6bb5'} \u00b7 \u4ec5\u4f9b\u9605\u8bfb\uff0c\u975e\u4efb\u52a1\u9636\u6bb5</p>`:''}<h3>证据缺口</h3>${(D.gaps||[]).map(g=>`<details><summary>${esc(g.title||g.code)}</summary><p>${esc(g.detail||'')}</p></details>`).join('')}<details><summary>完整元数据</summary><pre>${esc(txt(D.meta))}</pre></details>`)}
function init(){
 document.querySelector('.pill').textContent=(D.assessments||[]).some(a=>a.status==='error')?'TAG 评分未完成':'TAG 评测';$('caseTitle').textContent=D.meta.title;document.querySelector('.task h1').textContent=D.meta.title;document.querySelector('.task .eyebrow').textContent='EvalDock · TAG';document.querySelector('.task p').textContent='';
 if(stepReviews.size){$('reviewBar').hidden=false;$('reviewBar').innerHTML=`<span>五维百分制 · ${D.previousAssessments?'MVP 新版 · 五档':(esc(D.scoring?.review?.judge||'配置模型')+' 初评')}</span><span><i class="red-dot"></i>错误初判</span><span>? 证据不足 · N/A 不适用</span><button id="reviewInfo">评分来源 ↗</button>`;$('reviewInfo').onclick=()=>openPanel('评分来源',`<h2>本次五维步骤评分</h2>${D.scoring?.comparisonStats?`<p>MVP 新版 · ${D.scoring.comparisonStats.calls} 次调用 · ${D.scoring.comparisonStats.usage.total_tokens.toLocaleString()} Token · ${D.scoring.comparisonStats.changed} 项数值或状态变化</p><p>旧版 ${D.scoring.comparisonStats.baselineUsage?.total_tokens?.toLocaleString()||'—'} Token；新版含失败重试，耗时 ${D.scoring.comparisonStats.wallSeconds||'—'} 秒。</p><p>逐动作隔离决策证据，效果批量评审；未人工校准，尚不能认定优于旧版。</p>`:''}<p>本次调用运行时配置的 Judge，依据任务、TAG 关系和原始工具证据逐动作评分。分组仅用于阅读，未将原报告整题分分配给动作。</p><pre>${esc(txt(D.scoring?.review||D.sourceReview))}</pre>`);}

 $('recordCount').textContent=`${D.meta.recordCount||D.records?.length} 条记录 · ${actionNodes.length} 次动作`;
 const duration=D.meta.execution?.durationMs; $('elapsed').textContent=typeof duration==='number'?(duration/1000).toFixed(3)+' s':'耗时未记录';
 const answer=nodes.find(n=>n.kind==='state'&&n.observationKind==='archive'&&/output\/(answer\.txt|solution\.py)$/.test(n.path||''));$('archiveAnswer').textContent=(answer?answer.path.split('/').pop():null)||(nodes.filter(n=>n.kind==='state'&&n.observationKind==='archive').length+' 个文件');if(!answer)$('archiveLabel').textContent='归档交付';
 $('integrity').textContent=`归档核验 · ${D.meta.verifiedFileCount||0} 个文件`;
 $('scores').innerHTML=assessments.map((a,i)=>`<button class="report-score" data-assessment="${i}"><svg viewBox="0 0 60 60"><circle class="score-track" cx="30" cy="30" r="25"/><circle class="score-value" cx="30" cy="30" r="25" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100-a.score}" transform="rotate(-90 30 30)"/><text class="score-number" x="30" y="36" text-anchor="middle">${a.score}</text></svg><span>${esc(scoreName(a))}</span></button>`).join('');render();
}
$('sequence').onchange=e=>{showSequence=e.target.checked;render(false)};$('candidates').onchange=e=>{showCandidates=e.target.checked;render(false)};$('expand').onchange=e=>{expanded=e.target.checked;render()};
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{mode=b.dataset.view;selected=null;selectedEdge=null;$('inspector').hidden=true;document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));render()};
$('minus').onclick=()=>zoomTo(.8);$('plus').onclick=()=>zoomTo(1.25);$('fit').onclick=fitAll;$('read').onclick=()=>focusNode(selected||actionNodes[0]?.id);
$('close').onclick=()=>{$('inspector').hidden=true;selected=null;selectedEdge=null;highlight()};$('about').onclick=showAbout;
$('taskInfo').onclick=()=>openPanel('任务原文',`<h2>${esc(D.meta.title)}</h2><pre>${esc(D.meta.task||D.task||'任务原文见 report.json')}</pre>${sourceHTML([{file:'../report.json',pointer:'/execution/task'}])}`);
$('coverage').onclick=()=>openPanel('采集覆盖',`<h2>PARTIAL · 已归档范围</h2><p>所有归档记录都可从图中追溯。内部推理、未暴露事件和超出工具输出长度上限的内容不补造。</p><pre>${esc(txt(D.meta.coverage||{}))}</pre><h3>采集源</h3><pre>${esc(txt(D.meta.sources||D.sources||{}))}</pre>`);
$('answerFocus').onclick=()=>{const n=nodes.find(n=>n.kind==='resource'&&/output\/(answer\.txt|solution\.py)$/.test(n.path||n.detail||''));if(n){selectNode(n.id);focusNode(n.id)}else{document.querySelector('[data-view="resources"]').click();}};
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(D,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=D.meta.displayCase+'-TAG.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
document.addEventListener('click',e=>{const dim=e.target.closest('[data-step-dimension]');if(dim){scoreDimension=dim.dataset.stepDimension;selectNode(dim.dataset.stepOwner);applyScoreDimension(scoreDimension);return}const g=e.target.closest('[data-group]');if(g){focusGroup(g.dataset.group);return}if(e.target.closest('[data-group-fit]')){fitAll();return}const a=e.target.closest('[data-assessment]');if(a)showAssessment(+a.dataset.assessment);const j=e.target.closest('[data-jump]');if(j)selectNode(j.dataset.jump);const t=e.target.closest('[data-tab]');if(t&&selected)selectNode(selected,t.dataset.tab)});
svg.addEventListener('click',e=>{if(moved)return;if(e.target.closest('[data-step-dimension],[data-group]'))return;const r=e.target.closest('[data-return]');if(r){selectNode(r.dataset.return);return}const n=e.target.closest('[data-node]');if(n){selectNode(n.dataset.node);return}const edge=e.target.closest('[data-edge]');if(edge){selectEdge(edge.dataset.edge);return}selected=null;selectedEdge=null;highlight()});
svg.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const n=e.target.closest('[data-node]');if(n){e.preventDefault();selectNode(n.dataset.node)}}});
svg.addEventListener('wheel',e=>{e.preventDefault();const b=svg.getBoundingClientRect();zoomTo(Math.exp(-e.deltaY*.0013),e.clientX-b.left,e.clientY-b.top)},{passive:false});
svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,tx,ty,p:e.pointerId};moved=false;if(!e.target.closest('[data-node],[data-edge]'))svg.setPointerCapture(e.pointerId)});
svg.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>4){moved=true;if(!svg.hasPointerCapture(e.pointerId))svg.setPointerCapture(e.pointerId);svg.classList.add('dragging');tx=drag.tx+dx;ty=drag.ty+dy;transform()}});
svg.addEventListener('pointerup',()=>{drag=null;svg.classList.remove('dragging');setTimeout(()=>moved=false,0)});svg.addEventListener('pointercancel',()=>{drag=null;svg.classList.remove('dragging')});
$('search').oninput=()=>{const q=$('search').value.trim().toLowerCase();searchMatches=q?nodes.filter(n=>n.kind!=='scope'&&JSON.stringify(n).toLowerCase().includes(q)).map(n=>n.id):[];matchAt=0;$('searchCount').textContent=q?searchMatches.length+' 项':'';highlight()};
$('find').onclick=()=>{if(searchMatches.length){const id=searchMatches[matchAt++%searchMatches.length];selectNode(id);focusNode(id)}};$('search').onkeydown=e=>{if(e.key==='Enter')$('find').click()};
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('close').click()});
let panelDrag=null;$('panelHandle').addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;const panel=$('inspector'),b=panel.getBoundingClientRect(),parent=panel.parentElement.getBoundingClientRect();panelDrag={x:e.clientX,y:e.clientY,left:b.left-parent.left,top:b.top-parent.top};e.target.setPointerCapture(e.pointerId)});$('panelHandle').addEventListener('pointermove',e=>{if(!panelDrag)return;const p=$('inspector');p.style.right='auto';p.style.left=Math.max(0,Math.min(p.parentElement.clientWidth-p.clientWidth,panelDrag.left+e.clientX-panelDrag.x))+'px';p.style.top=Math.max(0,Math.min(p.parentElement.clientHeight-50,panelDrag.top+e.clientY-panelDrag.y))+'px'});$('panelHandle').addEventListener('pointerup',()=>panelDrag=null);
$('minimap').onclick=e=>{const b=$('minimap').getBoundingClientRect(),x=bounds.x+(e.clientX-b.left)/b.width*bounds.w,y=bounds.y+(e.clientY-b.top)/b.height*bounds.h,box=svg.getBoundingClientRect();tx=box.width/2-x*scale;ty=box.height/2-y*scale;transform()};
window.addEventListener('resize',fitAll);
window.tagDebug={data:D,get visible(){return visible},get edges(){return displayEdges},get scale(){return scale},selectNode,selectEdge,focusNode,fitAll,get bounds(){return bounds},get groups(){return layoutGroups},focusGroup};init();
