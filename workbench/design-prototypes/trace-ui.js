function pluginAttributionBadge(a){
 if(typeof activeRun!=='undefined'&&activeRun?.agentKind==='workbuddy')return '';
 a??={kind:'UNKNOWN',plugins:[],evidence:[]};
 const labels={TESTED_PLUGIN:'被测插件',BASELINE:'DSH 基础工具',AMBIGUOUS:'多来源 · 归属待确认',UNKNOWN:'归属未记录'};
 const kind=Object.hasOwn(labels,a.kind)?a.kind:'UNKNOWN';
 const badge='<span class="plugin-origin plugin-origin-'+kind.toLowerCase()+'">'+esc(labels[kind])+'</span>';
 if(!a.plugins?.length)return badge;
 return '<details class="plugin-origin-detail"><summary>'+badge+'<span>'+esc(a.plugins.join(' · '))+'</span></summary><p>依据所显示配置的工具注册声明标注来源；调用是否发生以 Trace 为准，不据此归因其他工具或环境变化。</p><pre class="textblock">'+esc(JSON.stringify(a.evidence??[],null,2))+'</pre></details>';
}
const archivedTraceCache=new Map();
function caseRuntimeDetails(key){
 const base=caseRuntimeSnapshot[key];if(!base?.traceDetailPath)return base;
 const url=base.traceDetailPath;
 if(!/^runtime-details\/[a-f0-9]{64}\.json$/.test(url)&&!/^api\/control\/trace\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(url)&&!/^\/archive\/trace\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(url))return {...base,traceLoadState:'error',traceError:'Trace 路径无效'};
 let cached=archivedTraceCache.get(url);
 if(!cached){
  cached={state:'loading'};archivedTraceCache.set(url,cached);
  fetch(url.startsWith('/')?url:'/'+url,{signal:AbortSignal.timeout(20000)}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(value=>{
   cached.value=value;cached.state='loaded';if(archivedTraceCache.size>8)archivedTraceCache.delete(archivedTraceCache.keys().next().value);
   if(page==='tasks'&&runKey()+'::'+cases[selectedCase]?.id===key)renderControlPreserved();
  }).catch(e=>{cached.state='error';cached.error=e.message;if(page==='tasks')renderControlPreserved();});
 }
 return {...base,...cached.value,tracePreviewState:cached.state,tracePreviewError:cached.error};
}
function evidenceText(value){
 if(value==null)return '未记录';let v=value;
 if(typeof v==='string'){try{v=JSON.parse(v);}catch{return v;}}
 if(Array.isArray(v)&&v.every(x=>x?.type==='text'))return v.map(x=>x.text).join('\n');
 return typeof v==='string'?v:JSON.stringify(v,null,2);
}
function detailedTraceView(d){
 const t=d?.trace;if(!t)return '<div class="runtime-empty">'+esc(d?.traceLoadState==='error'?'Trace 读取失败：'+d.traceError:d?.traceLoadState==='missing'?'本题归档未包含 Trace 引用':'Trace 正在归档或读取')+'</div>';
 const facts=runtimeFacts([['Agent 事件',t.eventCount],['工具调用',t.toolCallCount??t.toolCalls?.length],...(activeRun?.agentKind&&activeRun.agentKind!=='dsh'?[]:[['被测插件调用',t.pluginToolCallCount??(t.toolCalls??[]).filter(c=>c.attribution?.kind==='TESTED_PLUGIN').length]]),['Session',t.sessionIds?.length],['Model',t.model],['Provider',t.provider]]);

 const loading=d.tracePreviewState==='loading'?'<div class="runtime-empty">正在读取调用参数与返回结果…</div>':d.tracePreviewState==='error'?'<div class="runtime-empty">'+esc('Trace 明细读取失败：'+d.tracePreviewError)+'</div>':'';
 const rows=(t.toolCalls??[]).map(traceCallRow);
 return facts+'<h3>工具调用</h3>'+loading+(rows.length?'<div class="runtime-tool-scroll detailed-trace-table">'+runtimeTable(['调用','操作 / 参数','返回结果','状态'],rows)+'</div>':'')+(t.truncated?'<span class="badge">显示前 '+rows.length+' 次调用，完整内容见报告</span>':'')+traceEventStats(t.eventTypeCounts??[])+runtimeDetails('Session 与证据来源',{sessions:t.sessionIds,traceId:t.traceId,source:t.source,manifestSHA256:t.manifestDigest,verified:t.verified,sources:d.observationSources??[]});
}
function caseScoreReason(label,r,c){
 return '<section class="runtime-grade-reason"><div tabindex="0" role="region" aria-label="评分理由与证据">'+esc(typeof r.reason==='string'?r.reason:r.reason?JSON.stringify(r.reason,null,2):r.state==='scored'?'本题未记录评分理由':'等待评分结果')+'</div></section>';
}
function traceTokenUsage(t){
 if(!t)return '';
 return '<div class="execution-token-usage"><h3>Token usage</h3>'+runtimeFacts([['Input',t.usage?.inputTokens],['Output',t.usage?.outputTokens],['Reasoning',t.usage?.reasoningTokens],['Cache read',t.usage?.cacheReadTokens]])+'</div>';
}
function traceEventStats(entries){
 return '<section class="trace-event-stats"><h3>事件类型统计</h3>'+(entries.length?'<dl>'+entries.map(e=>'<div><dt>'+esc(e.type)+'</dt><dd>'+esc(e.count)+'</dd></div>').join('')+'</dl>':'<div class="runtime-empty">未记录事件类型统计</div>')+'</section>';
}

function observedToolList(tools,details=[]){
 const byName=new Map(details.map(t=>[t.name,t]));
 return '<div class="subsection tool-section"><h3 class="subheading">Tools <span>'+tools.length+' 项</span></h3><div class="compact-tool-list">'+[...tools].sort((a,b)=>Number(byName.get(b)?.attribution?.kind==='TESTED_PLUGIN')-Number(byName.get(a)?.attribution?.kind==='TESTED_PLUGIN')).map(name=>{
  const t=byName.get(name),description=t?.description||toolPurpose[name]||'用途未记录';
  return '<details class="compact-tool" data-live-key="tool:'+esc(name)+'"><summary><strong>'+esc(name)+'</strong>'+(activeRun?.agentKind!=='workbuddy'&&t?.attribution?.kind==='TESTED_PLUGIN'?'<span class="plugin-origin plugin-origin-tested_plugin">被测插件</span>':'')+'</summary>'+pluginAttributionBadge(t?.attribution)+'<div class="tool-full-description">'+esc(description)+'</div>'+(t?.parameters?'<details class="runtime-details"><summary>参数 Schema</summary><pre class="textblock">'+esc(evidenceText(t.parameters))+'</pre></details>':'')+'</details>';
 }).join('')+'</div>'+(!tools.length?'<div class="runtime-empty">本批次尚未记录工具声明</div>':'')+'</div>';
}
function observedPluginList(plugins,recorded=true){
 const native={
 '@deepseek-ai/dsh-base':{role:'基础运行环境',description:'提供 DSH 核心运行环境，通过 Profile 配置加载内置插件。',features:['核心运行环境','Profile 基础配置','内置插件声明']},
 '@deepseek-ai/dsh-web-app':{role:'Web 会话界面',description:'在基础环境上提供 Web 页面、会话交互和运行衔接，包括页面服务、会话提示与 Bash 环境信息。',features:['Web 页面服务','会话交互','运行环境信息']}
 };
 return '<div class="subsection plugin-section"><h3 class="subheading">Plugins <span>'+plugins.length+' 项</span></h3>'+(recorded?'<div class="observed-plugins">'+plugins.map(p=>{
  const n=native[p.name],desc=n?.description||controlPluginDescriptions[p.name]||p.function||p.description||'本批次未记录功能说明';
  const metadata={name:p.name,version:p.version||'未记录',status:p.status||'已声明',function:p.function||p.description||'未记录'};
  for(const k of ['description','config','configuration','options','source','path','installed','enabled'])if(p[k]!==undefined)metadata[k]=p[k];
  return '<article class="observed-plugin"><header><strong>'+esc(p.name)+'</strong><span class="badge">'+esc(p.version||'版本未记录')+'</span></header><div class="plugin-role">'+esc(n?.role||'扩展插件')+'<span>'+esc(p.status||'已声明')+'</span></div><p>'+esc(desc)+'</p>'+(n?'<div class="plugin-features">'+n.features.map(f=>'<span>'+esc(f)+'</span>').join('')+'</div>':'')+'<details class="runtime-details" data-live-key="plugin:'+esc(p.name)+'"><summary>插件声明与配置</summary><pre class="textblock">'+esc(evidenceText(metadata))+'</pre></details></article>';
 }).join('')+'</div>':'<div class="runtime-empty">本批次未记录插件信息</div>')+'</div>';
}


function archivedEnvironmentView(summary){
 const names={filesystem:'文件',network:'网络',process:'进程',browser:'浏览器',desktop:'桌面',database:'数据库',clipboard:'剪贴板',application:'应用',system:'系统',external_api:'外部 API'};
 const rows=(summary.changes||[]).map(c=>[esc(names[c.component]||c.component),esc(({ADD:'新增',REMOVE:'删除',CHANGE:'修改',MODIFY:'修改'})[c.op]||c.op),esc(c.path||'—'),c.bytes!==undefined?esc(c.bytes)+' B':c.value!==undefined?runtimeDetails('详情',c.value):'—']);
 return runtimeTable(['组件','变化','路径','详情'],rows)+(summary.omittedChanges?'<span class="badge">归档摘要省略 '+esc(summary.omittedChanges)+' 项变化</span>':'')+runtimeDetails('环境观测摘要',summary);
}

function traceValue(value){
 if(typeof value==='string'){try{return JSON.parse(value);}catch{}}
 return value;
}
function traceReadable(value){
 let v=traceValue(value);
 if(Array.isArray(v)&&v.every(x=>x?.type==='text'))v=v.map(x=>x.text).join('\n');
 else if(v&&typeof v==='object'&&Array.isArray(v.content))return traceReadable(v.content);
 let text=typeof v==='string'?v:JSON.stringify(v,null,2)??'未记录';
 // Some archived text blocks retain escaped newlines. Raw data remains available below.
 if(!text.includes('\n')&&text.includes('\\n'))text=text.replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\"/g,'"');
 return text;
}
function traceResultPreview(value){
 if(value==null)return '<div class="trace-preview-empty">未记录返回</div>';
 let text=traceReadable(value),data=traceValue(text);
 if(data&&Array.isArray(data.columns)&&Array.isArray(data.rows)&&data.columns.length){
  const cols=data.columns,rows=data.rows;
  return '<div class="trace-data-preview"><table><thead><tr>'+cols.map(c=>'<th>'+esc(String(c))+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map((_,i)=>'<td>'+esc(evidenceText(r[i]))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div><span class="trace-preview-count">'+data.rows.length+' 行'+'</span>';
 }
 const content=text.match(/<content>\s*([\s\S]*?)<\/content>/);
 if(content)text=content[1];
 if(!text.trim())return '<div class="trace-preview-empty">（空输出）</div>';
 return '<pre class="trace-inline-preview">'+esc(text)+'</pre>';
}
function traceArgumentPreview(value){
 const a=traceValue(value);
 if(!a||typeof a!=='object')return '<pre class="trace-inline-preview">'+esc(traceReadable(value))+'</pre>';
 const primary=a.command??a.file_path??a.path??a.pattern??a.query??a.url??a.name;
 const description=a.description?'<div class="trace-action-description">'+esc(String(a.description))+'</div>':'';
 const content=primary!==undefined?String(primary):JSON.stringify(a,null,2);
 return description+'<pre class="trace-inline-preview trace-command">'+esc(content)+'</pre>';
}
function traceCallRow(call,i){
 const status=call.status??(call.completed===true?'COMPLETED':call.completed===false?'ERROR':'UNKNOWN');
 return [
  '<div class="trace-call-name"><span>'+String(i+1).padStart(2,'0')+'</span><strong>'+esc(call.toolName)+'</strong></div>'+pluginAttributionBadge(call.attribution)+'<time title="'+esc(call.at||'')+'">'+esc(call.at?new Date(call.at).toLocaleTimeString('zh-CN',{hour12:false}):'—')+'</time>',
  '<div class="trace-scroll-content" tabindex="0">'+traceArgumentPreview(call.argumentsCaptured)+'</div>',
  '<div class="trace-scroll-content" tabindex="0">'+traceResultPreview(call.result)+'</div>',
  '<span class="trace-result '+(status==='ERROR'?'error':'')+'">'+esc(({COMPLETED:'已返回',ERROR:'错误',UNKNOWN:'未记录'})[status]||status)+'</span>'
 ];
}
