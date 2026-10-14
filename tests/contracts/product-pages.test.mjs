import test from 'node:test';
import assert from 'node:assert/strict';
import {filterJobs,reportHref,selectedItems,renderRun,renderDatasets} from '../../workbench/design-prototypes/product-pages.js';
import {evaluationCatalog} from '../../workbench/lib/evaluation-config.mjs';

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
