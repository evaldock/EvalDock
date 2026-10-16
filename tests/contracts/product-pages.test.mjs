import test from 'node:test';
import assert from 'node:assert/strict';
import {filterJobs,reportHref,selectedItems,renderRun,renderDatasets} from '../../workbench/design-prototypes/product-pages.js';
import {evaluationCatalog} from '../../workbench/lib/evaluation-config.mjs';
import {ControlResults} from '../../workbench/lib/control-results.mjs';
import {temporary,json} from './support.mjs';
import path from 'node:path';
import {readFile,writeFile,mkdir,rm,symlink,truncate} from 'node:fs/promises';

test('selection submits only indices that still exist in the catalog',()=>{
 const catalog={datasets:[{id:'a',cases:[{index:0},{index:2}]}]};
 assert.deepEqual(selectedItems(catalog,new Map([['a',new Set([2,9])],['removed',new Set([0])]])),[{datasetId:'a',caseIndices:[2]}]);
});
test('record filters distinguish active, completed and cancelled jobs',()=>{
 const jobs=['RUNNING','SUCCEEDED','FAILED','CANCELLED'].map((state,i)=>({state,id:String(i),agentKind:'pi'}));
 assert.deepEqual(filterJobs(jobs,'Pi','active').map(j=>j.state),['RUNNING']);
 assert.equal(filterJobs(jobs,'','issues').length,2);
 assert.equal(filterJobs(jobs,'missing','done').length,0);
});
test('report links remain within report routes',()=>{
 assert.equal(reportHref('reports/pi/run-1/report.html'),'/reports/pi/run-1/report.html');
 for(const invalid of ['https://evil/report.html','reports/pi/../report.html','reports/pi/run/cases/../report.html','javascript:alert(1)'])assert.equal(reportHref(invalid),null);
});
test('result rendering preserves zero and escapes untrusted answers and reasons',()=>{
 const html=renderRun({id:'j',runId:'r',state:'SUCCEEDED',events:[]},{run:{cases:[{id:'c',scores:{a:{state:'scored',value:0,scale:{max:10},reason:'<script>bad</script>'},b:{state:'null'}},finalAnswer:'<img src=x onerror=bad>'}]},reportPaths:[]});
 assert.match(html,/0 \/ 10/);assert.match(html,/证据不足/);
 assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;img/);
});
test('catalog exposes public task details without grading references',async()=>{
 const catalog=await evaluationCatalog(process.cwd());
 assert.ok(catalog.datasets.length);const c=catalog.datasets[0].cases[0];
 assert.ok(c.instructions);assert.ok(Array.isArray(c.dependencies));
 assert.equal(c.grading,undefined);assert.equal(c.reference,undefined);
 const html=renderDatasets({catalog,ui:{selection:new Map(),datasetId:catalog.datasets[0].id,datasetQuery:''}});
 assert.match(html,/查看任务要求/);
});

test('home always offers evaluation without repeating connection setup',async()=>{
 const {renderHome,friendlyMessage}=await import('../../workbench/design-prototypes/product-pages.js');
 const data={summary:{agents:[],jobs:[],runs:[]},catalog:{datasets:[]},settings:{},discovery:{agents:[]}};
 assert.match(renderHome(data),/开始评测/);assert.doesNotMatch(renderHome(data),/去连接助手|还差|步准备/);
 data.summary.agents=[{targets:[{evaluationReady:true}]}];
 assert.match(renderHome(data),/开始评测/);
 data.catalog.datasets=[{cases:[{index:0}]}];
 assert.match(renderHome(data),/开始评测/);
 data.settings={judge:{keyConfigured:true},planner:{keyConfigured:true}};
 assert.match(renderHome(data),/data-start/);
 assert.doesNotMatch(friendlyMessage('AGENT_VERSION_UNVERIFIED'),/AGENT_VERSION/);
 assert.match(friendlyMessage('AGENT_VERSION_UNVERIFIED'),/重新检查接口/);
 assert.match(friendlyMessage('AGENT_INTERFACE_CHANGED'),/接口不可用/);
 assert.match(friendlyMessage('AGENT_LOCAL_RUNTIME_UNAVAILABLE'),/执行环境尚未就绪/);
});

test('concrete Graph names remain distinct in report headings and searches',()=>{
 const jobs=[{id:'a',targetName:'DeepAgents',agentKind:'langgraph',state:'SUCCEEDED'},{id:'b',targetName:'Toolkit files',agentKind:'langgraph',state:'SUCCEEDED'}];
 assert.deepEqual(filterJobs(jobs,'DeepAgents','all').map(j=>j.id),['a']);
 const html=renderRun({...jobs[1],targetName:'Toolkit <files>',events:[]},{reportPaths:[]});
 assert.match(html,/Toolkit &lt;files&gt; 的评测/);assert.doesNotMatch(html,/<files>/);
});

test('run detail separates unknown outcomes and unfinished cases from cases not run',()=>{
 const job={id:'synthetic-job',runId:'synthetic-run',state:'RUNNING',events:[],progress:{total:6,ended:3,normal:1,failed:1,cancelled:0,unknown:1,remaining:3,countsComplete:true,cases:[{caseId:'synthetic-live',phase:'JUDGING'}]}};
 const html=renderRun(job,{run:{cases:[{id:'synthetic-live',status:'running',scores:{}}]},reportPaths:[]});
 assert.match(html,/3 \/ 6 题已结束/);
 assert.match(html,/结果未知\s*<b>1<\/b>/);
 assert.match(html,/未结束\s*<b>3<\/b>/);
 assert.doesNotMatch(html,/未运行\s*<b>3<\/b>/);
 assert.match(html,/评分中/);
});

test('run detail does not present incomplete or missing counts as exact completion',()=>{
 for(const progress of [undefined,{total:5,ended:5,normal:5,failed:0,cancelled:0,unknown:0,remaining:0,countsComplete:false}]){
  const html=renderRun({id:'synthetic-job',runId:'synthetic-run',state:'SUCCEEDED',events:[],progress},{reportPaths:[]});
  assert.match(html,/计数未确认/);
  assert.match(html,/正常完成\s*<b>—<\/b>/);
  assert.doesNotMatch(html,/5 \/ 5 题已结束|0 题已结束|value="5"/);
 }
});

test('run detail keeps execution, evidence, scoring and cleanup independent',()=>{
 const job={id:'synthetic-job',targetId:'synthetic-target',runId:'synthetic-run',state:'RUNNING',events:[],progress:{cases:[{caseId:'synthetic-case',phase:'JUDGING'}]}};
 const result={run:{cases:[{id:'synthetic-case',status:'running',scores:{zero:{state:'scored',value:0,scale:{max:100}},missing:{state:'null'},broken:{state:'error'}}}]},runtime:{'synthetic-target::synthetic-run::synthetic-case':{execution:{exitCode:0},traceLoadState:'available',cleanupState:'PENDING',reset:{result:'MATCH'}}},reportPaths:[]};
 const before=JSON.stringify({job,result}),html=renderRun(job,result);
 assert.match(html,/执行<\/strong><b>已结束（退出码 0）/);
 assert.match(html,/采集<\/strong><b>证据已归档（完整性未确认）/);
 assert.match(html,/评分<\/strong><b>评分中/);
 assert.match(html,/清理<\/strong><b>待确认/);
 assert.match(html,/环境恢复<\/strong><b>核验一致/);
 assert.match(html,/0 \/ 100/);assert.match(html,/证据不足/);assert.match(html,/评分失败/);
 assert.equal(JSON.stringify({job,result}),before);
});

test('cancelled and legacy cases without cleanup receipts stay unconfirmed',()=>{
 for(const state of ['CANCELLED','SUCCEEDED']){
  const html=renderRun({id:'synthetic-job',targetId:'synthetic-target',runId:'synthetic-run',state,events:[]},{run:{cases:[{id:'synthetic-case',status:state==='CANCELLED'?'CANCELLED':'done',scores:{}}]},runtime:{'synthetic-target::synthetic-run::synthetic-case':{execution:{exitCode:0}}},reportPaths:[]});
  assert.match(html,/清理<\/strong><b>未确认/);
  assert.match(html,/评分<\/strong><b>未确认/);
  assert.doesNotMatch(html,/清理完成|环境恢复<\/strong><b>核验一致/);
 }
});

test('cleanup display only trusts a receipt for the archived run, case and Agent session',async t=>{
 const root=await temporary(t),dir=path.join(root,'var/evaluation-results/agents/synthetic-target/runs/synthetic-run'),caseDir=path.join(dir,'cases/synthetic-case');
 await json(path.join(dir,'run.json'),{fixture:true,status:'COMPLETED',totalCaseCount:1,caseResults:[{caseId:'synthetic-case',status:'COMPLETED'}]});
 const report=path.join(caseDir,'report.json'),session=path.join(caseDir,'session.json');
 await json(report,{fixture:true,execution:{exitCode:0,agentSessionIds:['synthetic-session']},scores:[]});
 const original=await readFile(report),job={id:'synthetic-job',targetId:'synthetic-target',runId:'synthetic-run',agentKind:'pi',state:'SUCCEEDED',events:[]};
 const valid={schema:'evaldock.agent-session/v1',runId:'synthetic-run',caseId:'synthetic-case',sessionId:'synthetic-session',cleanup:'STOPPED'};
 for(const [receipt,want] of [[valid,'所属 Agent 资源已停止'],[{...valid,cleanup:'UNKNOWN'},'未确认'],[{...valid,cleanup:'CONFIRMED'},'未确认'],[{...valid,runId:'other-run'},'未确认'],[{...valid,caseId:'other-case'},'未确认'],[{...valid,sessionId:'other-session'},'未确认'],[{...valid,cleanup:'<script>bad</script>'},'未确认']]){
  await json(session,receipt);const sessionBefore=await readFile(session),result=await new ControlResults(root).get(job),html=renderRun(job,result);
  assert.match(html,new RegExp('清理</strong><b>'+want));
  assert.doesNotMatch(html,/<script>bad<\/script>/);
  assert.deepEqual(await readFile(report),original);assert.deepEqual(await readFile(session),sessionBefore);
 }
});

test('optional cleanup files cannot hide an otherwise readable report',async t=>{
 const root=await temporary(t),dir=path.join(root,'var/evaluation-results/agents/synthetic-target/runs/synthetic-run'),caseDir=path.join(dir,'cases/synthetic-case');
 await json(path.join(dir,'run.json'),{fixture:true,totalCaseCount:1,caseResults:[{caseId:'synthetic-case',status:'COMPLETED'}]});
 const report=path.join(caseDir,'report.json'),session=path.join(caseDir,'session.json');
 await json(report,{fixture:true,execution:{exitCode:0,agentSessionIds:['synthetic-session']},scores:[]});
 const before=await readFile(report),job={id:'synthetic-job',targetId:'synthetic-target',runId:'synthetic-run',agentKind:'pi',state:'SUCCEEDED',events:[]};
 for(const badFile of ['directory','outside-symlink','oversized']){
  if(badFile==='directory')await mkdir(session);
  if(badFile==='outside-symlink'){await json(path.join(root,'outside.json'),{cleanup:'STOPPED'});await symlink(path.join(root,'outside.json'),session);}
  if(badFile==='oversized'){await writeFile(session,'');await truncate(session,64*1024*1024+1);}
  const result=await new ControlResults(root).get(job),html=renderRun(job,result);
  assert.match(html,/清理<\/strong><b>未确认/);assert.match(html,/打开单题报告/);
  assert.deepEqual(await readFile(report),before);
  await rm(session,{recursive:true,force:true});
 }
});

test('a damaged cleanup receipt cannot reuse an earlier confirmed state',async t=>{
 const root=await temporary(t),dir=path.join(root,'var/evaluation-results/agents/synthetic-target/runs/synthetic-run'),caseDir=path.join(dir,'cases/synthetic-case');
 await json(path.join(dir,'run.json'),{fixture:true,totalCaseCount:1,caseResults:[{caseId:'synthetic-case',status:'COMPLETED'}]});
 await json(path.join(caseDir,'report.json'),{fixture:true,execution:{exitCode:0,agentSessionIds:['synthetic-session']},scores:[]});
 const session=path.join(caseDir,'session.json'),job={id:'synthetic-job',targetId:'synthetic-target',runId:'synthetic-run',agentKind:'pi',state:'SUCCEEDED',events:[]},results=new ControlResults(root);
 await json(session,{schema:'evaldock.agent-session/v1',runId:'synthetic-run',caseId:'synthetic-case',sessionId:'synthetic-session',cleanup:'STOPPED'});
 assert.match(renderRun(job,await results.get(job)),/清理<\/strong><b>所属 Agent 资源已停止/);
 await writeFile(session,'{broken');
 const html=renderRun(job,await results.get(job));
 assert.match(html,/清理<\/strong><b>未确认/);assert.doesNotMatch(html,/所属 Agent 资源已停止/);
});
