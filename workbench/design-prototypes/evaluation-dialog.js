(() => {
  let active=null, catalog=null;
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const selectedCount=state=>[...state.selected.values()].reduce((n,set)=>n+set.size,0);
  const datasetHtml=state=>!catalog?'<p>正在读取测试集…</p>':catalog.datasets.map(d=>{
    const indices=state.selected.get(d.id),checked=!!indices?.size;
    return '<div class="evaluation-dataset"><label><input type="checkbox" data-eval-dataset="'+escapeHtml(d.id)+'" '+(checked?'checked':'')+'><span>'+escapeHtml(d.name)+'</span><small>'+d.cases.length+' 题'+(checked?' · 已选 '+indices.size:'')+'</small></label><details '+(checked?'open':'')+'><summary>选择具体 Case</summary><div class="evaluation-cases">'+d.cases.map(c=>'<label><input type="checkbox" data-eval-case="'+escapeHtml(d.id)+'" data-case-index="'+c.index+'" '+(indices?.has(c.index)?'checked':'')+'><span>'+escapeHtml(c.title)+' <small>['+escapeHtml(c.id)+']</small></span></label>').join('')+'</div></details></div>';
  }).join('');
  const card=(group,value,title,description,checked)=>'<label class="evaluation-choice"><input type="radio" name="'+group+'" value="'+value+'" '+(checked?'checked':'')+'><strong>'+title+'</strong><small>'+description+'</small></label>';
  const agentName={dsh:'DSH',workbuddy:'WorkBuddy',pi:'Pi',langgraph:'LangGraph',qwenwork:'千问办公',doubaowork:'豆包办公',hermes:'Hermes',openclaw:'OpenClaw'};
  const modeName={EFFECT:'效果测试',FULL:'完整流程'};
  const scopeName={STANDARD:'标准评测',COUNT:'指定题量',ALL:'全部数据集',SELECTED:'指定数据集 / Case'};
  function summary(s){
    let detail=scopeName[s.scope];
    if(s.scope==='COUNT')detail+=' · '+(s.caseCount||0)+' 题';
    if(s.scope==='ALL'&&catalog)detail+=' · 预计 '+catalog.datasets.reduce((n,d)=>n+d.cases.length,0)+' 题';
    if(s.scope==='SELECTED')detail+=' · 已选 '+selectedCount(s)+' 题';
    return modeName[s.mode]+' · '+detail;
  }
  function render(){
    if(!active)return;
    const s=active,root=s.root;
    const bodyTop=root.querySelector('.evaluation-body')?.scrollTop??0;
    const listTop=root.querySelector('.evaluation-datasets')?.scrollTop??0;
    const focus=document.activeElement;
    const focusName=focus?.name,focusValue=focus?.value;
    const focusAttribute=['data-eval-count','data-eval-dataset-count','data-eval-dataset','data-eval-case'].find(key=>focus?.hasAttribute(key));
    const fields=s.scope==='COUNT'
      ?'<div class="evaluation-input-row"><label>目标 Case 数<input type="number" min="1" max="10000" value="'+s.caseCount+'" data-eval-count></label><label>数据集数 <em>可选</em><input type="number" min="1" max="10000" placeholder="由 Planner 决定" value="'+escapeHtml(s.datasetCount)+'" data-eval-dataset-count></label></div><p>Planner 按目标数量选题；实际题量取决于可用题目和规划约束。</p>'
      :s.scope==='ALL'
      ?'<p class="evaluation-estimate">'+(catalog?'共 '+catalog.datasets.reduce((n,d)=>n+d.cases.length,0)+' 题，执行全部数据集中的全部题目。':'正在计算题量…')+'</p>'
      :s.scope==='SELECTED'
      ?'<p class="evaluation-selection-hint">已选 <strong>'+selectedCount(s)+'</strong> 题。勾选数据集可选择全部题目，也可展开逐题调整。</p><div class="evaluation-datasets">'+datasetHtml(s)+'</div>'
      :'<p class="evaluation-standard-note">由 Planner 按内置标准策略选择测试集和题目。</p>';
    root.innerHTML='<div class="evaluation-dialog" role="dialog" aria-modal="true" aria-labelledby="evaluation-title">'
      +'<header class="evaluation-header"><div><span class="evaluation-eyebrow">新建评测</span><h2 id="evaluation-title">评测配置</h2><p>选择本轮评测方式和测试范围</p></div><div class="evaluation-header-actions"><span class="evaluation-agent">'+escapeHtml(agentName[s.kind]||s.kind)+'</span><button type="button" class="evaluation-close" data-eval-close aria-label="关闭弹窗">×</button></div></header>'
      +'<div class="evaluation-body"><fieldset><legend><span class="evaluation-step">01</span>评测类型</legend><div class="evaluation-choices">'
      +card('evaluationMode','EFFECT','效果测试','仅看最终回答与交付文件；无法判断的维度不计分。',s.mode==='EFFECT')
      +card('evaluationMode','FULL','完整流程','使用 All Trace、环境观测与完整 Judge 流程。',s.mode==='FULL')
      +'</div></fieldset><fieldset><legend><span class="evaluation-step">02</span>测试范围</legend><div class="evaluation-choices scope">'
      +card('evaluationScope','STANDARD','标准评测','由 Planner 按内置策略选题。',s.scope==='STANDARD')
      +card('evaluationScope','COUNT','指定题量','输入目标 Case 数。',s.scope==='COUNT')
      +card('evaluationScope','ALL','全部数据集','覆盖所有有题目的数据集。',s.scope==='ALL')
      +card('evaluationScope','SELECTED','指定数据集 / Case','精确勾选要执行的题目。',s.scope==='SELECTED')
      +'</div></fieldset><div class="evaluation-fields">'+fields+'</div></div>'
      +'<footer><div class="evaluation-footer-copy"><span>本轮设置</span><strong>'+escapeHtml(summary(s))+'</strong><p class="evaluation-error" role="alert">'+escapeHtml(s.error)+'</p></div><div class="evaluation-footer-actions"><button type="button" data-eval-close>取消</button><button type="button" class="primary" data-eval-submit '+(s.loading?'disabled':'')+'>'+(s.loading?'启动中…':'开始评测')+'</button></div></footer></div>';
    root.querySelector('.evaluation-body').scrollTop=bodyTop;
    if(root.querySelector('.evaluation-datasets'))root.querySelector('.evaluation-datasets').scrollTop=listTop;
    if(focus?.isConnected===false){
      let next=null;
      if(focusName&&['evaluationMode','evaluationScope'].includes(focusName))next=[...root.querySelectorAll('input[name="'+focusName+'"]')].find(input=>input.value===focusValue);
      else if(focusAttribute){next=[...root.querySelectorAll('['+focusAttribute+']')].find(input=>input.getAttribute(focusAttribute)===focus.getAttribute(focusAttribute)&&(!focus.hasAttribute('data-case-index')||input.getAttribute('data-case-index')===focus.getAttribute('data-case-index')));}
      next?.focus({preventScroll:true});
    }
  }
  async function open(kind,targetId){
    if(active)return;
    const root=document.createElement('div');root.className='evaluation-overlay';document.body.append(root);
    active={root,kind,targetId,mode:'FULL',scope:'STANDARD',caseCount:12,datasetCount:'',selected:new Map(),error:'',loading:false};
    render();root.querySelector('input[name=evaluationMode]:checked')?.focus();
    try{if(!catalog){const response=await fetch('/api/control/evaluation-catalog',{cache:'no-store'});if(!response.ok)throw Error('无法读取测试集目录');catalog=await response.json();}if(active?.root===root)render();}
    catch(error){if(active?.root===root){active.error=error.message;render();}}
  }
  function close(){if(!active||active.loading)return;active.root.remove();active=null;}
  function config(s){
    if(s.scope==='STANDARD')return {mode:s.mode,selection:{kind:'STANDARD'}};
    if(s.scope==='COUNT'){
      if(!Number.isSafeInteger(s.caseCount)||s.caseCount<1||s.caseCount>10000)throw Error('请输入 1–10000 的 Case 数');
      const count=s.datasetCount===''?undefined:Number(s.datasetCount);
      if(count!==undefined&&(!Number.isSafeInteger(count)||count<1||count>s.caseCount))throw Error('数据集数不能大于 Case 数');
      return {mode:s.mode,selection:{kind:'COUNT',caseCount:s.caseCount,...count?{datasetCount:count}:{}}};
    }
    if(s.scope==='ALL'){
      if(!catalog)throw Error('测试集目录尚未加载');
      return {mode:s.mode,selection:{kind:'ALL'}};
    }
    if(!catalog)throw Error('测试集目录尚未加载');
    const items=catalog.datasets.filter(d=>s.selected.get(d.id)?.size).map(d=>({datasetId:d.id,caseIndices:[...s.selected.get(d.id)].sort((a,b)=>a-b)}));
    if(!items.length)throw Error('至少选择一道 Case');
    return {mode:s.mode,selection:{kind:'SELECTED',items}};
  }
  async function submit(){const s=active;if(!s||s.loading)return;let evaluationConfig;
    try{evaluationConfig=config(s);}catch(error){s.error=error.message;render();return;}
    s.loading=true;s.error='';render();
    try{
      if(s.kind==='dsh'){
        closeAfterDsh(s);
        await controlPost('run',{revision:controlSnapshot.revision,evaluationConfig});
      }else{
        controlBusy=true;renderControlPreserved(true);
        const route=s.kind==='workbuddy'?'workbuddy/run':s.kind+'/run';
        const body=s.kind==='workbuddy'?{evaluationConfig}:{targetId:s.targetId,evaluationConfig};
        const response=await fetch('/api/control/'+route,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':controlSnapshot?.csrf??''},body:JSON.stringify(body)});
        const value=await response.json();if(!response.ok)throw Error(value.error||'评测未启动');
        s.root.remove();active=null;
        await refreshControl(true);
        if(s.kind==='workbuddy')await refreshWorkBuddy();else await refreshRuntime(s.kind);
      }
    }catch(error){if(active===s){s.error=error.message;s.loading=false;render();}else controlError=error.message;}
    finally{if(s.kind!=='dsh'){controlBusy=false;renderControlPreserved(true);}}
  }
  function closeAfterDsh(s){s.root.remove();active=null;}
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    const kind=button.hasAttribute('data-control-run')?'dsh':button.hasAttribute('data-workbuddy-run')?'workbuddy':button.dataset.agentAction==='run'?button.dataset.agentKind:null;
    if(!kind)return;
    event.preventDefault();event.stopImmediatePropagation();
    void open(kind,kind==='pi'||kind==='langgraph'?runtimeSelected[kind]:undefined);
  },true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&active){event.preventDefault();close();}});
  document.addEventListener('click',event=>{if(!active)return;if(event.target===active.root||event.target.closest('[data-eval-close]'))close();if(event.target.closest('[data-eval-submit]'))void submit();});
  document.addEventListener('change',event=>{const s=active;if(!s)return;const e=event.target;
    if(e.name==='evaluationMode')s.mode=e.value;
    else if(e.name==='evaluationScope')s.scope=e.value;
    else if(e.hasAttribute('data-eval-count'))s.caseCount=Number(e.value);
    else if(e.hasAttribute('data-eval-dataset-count'))s.datasetCount=e.value;
    else if(e.hasAttribute('data-eval-dataset')){const d=catalog?.datasets.find(d=>d.id===e.dataset.evalDataset);if(d){if(e.checked)s.selected.set(d.id,new Set(d.cases.map(c=>c.index)));else s.selected.delete(d.id);}}
    else if(e.hasAttribute('data-eval-case')){const d=e.dataset.evalCase,set=s.selected.get(d)??new Set();if(e.checked)set.add(Number(e.dataset.caseIndex));else set.delete(Number(e.dataset.caseIndex));if(set.size)s.selected.set(d,set);else s.selected.delete(d);}
    else return;
    s.error='';render();
  });
})();
