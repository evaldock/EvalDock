import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {temporary,json} from './support.mjs';
import {Jobs} from '../../workbench/lib/jobs.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';
import {ControlResults} from '../../workbench/lib/control-results.mjs';
test('historical jobs remain readable without writing copies into the new state directory',async t=>{
 const root=await temporary(t),legacy=path.join(root,'old'),next=path.join(root,'var/workbench/jobs');
 const job={id:'job',state:'SUCCEEDED',events:[]};await json(path.join(legacy,'job.json'),job);
 const jobs=new Jobs({stateRoot:next,legacyRoots:[legacy]});await jobs.init();
 assert.equal(jobs.get('job').state,'SUCCEEDED');assert.deepEqual(await readdir(next),[]);
 assert.deepEqual(JSON.parse(await readFile(path.join(legacy,'job.json'),'utf8')),job);
});
test('workbench routes canonical reports and generated cache while rejecting cross-origin mutations',async t=>{
 const root=await temporary(t);await mkdir(path.join(root,'workbench/design-prototypes'),{recursive:true});
 await writeFile(path.join(root,'workbench/design-prototypes/index.html'),'<html>workbench</html>');
 await json(path.join(root,'var/workbench/cache/live-observation.json'),{source:'canonical'});
 const report=path.join(root,'var/evaluation-results/agents/agent/runs/run/report.html');await mkdir(path.dirname(report),{recursive:true});await writeFile(report,'report-original-style');
 const controller={activity:async()=>({active:false,revision:'idle'}),status:async()=>({status:'STOPPED'}),action:async()=>{throw Error('must not mutate');}};
 const {server}=await startControlServer({root,port:0,controller});t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 await mkdir(path.join(root,'workbench/design-prototypes/reports/agent/run'),{recursive:true});await writeFile(path.join(root,'workbench/design-prototypes/reports/agent/run/report.html'),'stale copy');
 assert.equal(await(await fetch(base+'/reports/agent/run/report.html')).text(),'report-original-style');
 assert.equal((await(await fetch(base+'/live-observation.json')).json()).source,'canonical');
 assert.equal((await fetch(base+'/api/control/service',{method:'POST',headers:{origin:'https://outside.invalid','content-type':'application/json'},body:'{"action":"start"}'})).status,403);
 assert.equal((await fetch(base+'/api/control/status')).status,200);
 assert.deepEqual(await(await fetch(base+'/api/control/activity')).json(),{active:false,revision:'idle'});
});
test('workbench uses stored Case weights and arbitrary labels',async t=>{
 const root=await temporary(t),run='agents/agent/runs/run';
 await json(path.join(root,'var/evaluation-results',run,'run.json'),{caseResults:[{caseId:'case',status:'COMPLETED'}]});
 await json(path.join(root,'var/evaluation-results',run,'cases/case/report.json'),{scores:[{labelId:'label.new-capability/v1',score:8,weight:3,status:'SCORED',scale:{min:0,max:10}}],case:{grading:{weight:3}},timeline:[],target:{}});
 const result=await new ControlResults(root).get({targetId:'agent',runId:'run',state:'SUCCEEDED',events:[]});
 assert.equal(result.run.cases[0].weight,3);assert.ok(result.run.dimensions.includes('label.new-capability/v1'));
});

test('CLI help is an inert documented entry point',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const {stdout}=await promisify(execFile)(process.execPath,['dist/src/app/cli.js','--help']);
 assert.deepEqual(JSON.parse(stdout).commands,['inspect','plan','run','report']);
});

test('any historical Case serves verified Trace and plugin attribution through its own HTTP route',async t=>{
 const {trace}=await import('./support.mjs');const {writeTraceDirectory}=await import('../../dist/src/all-trace/store.js');
 const root=await temporary(t),base=path.join(root,'var/evaluation-results/agents/agent/runs/older'),directory=path.join(base,'cases/case');
 const source=trace([{id:'call',layer:'AGENT',content:{data:{sessionId:'session',event:{type:'tool/call',data:{name:'plugin_tool',callId:'id',arguments:'{}'}}}}}]);
 const ref=await writeTraceDirectory({caseDirectory:directory,trace:source,maxBytes:1024*1024});
 const inspection={toolSchemas:[{name:'plugin_tool',attribution:{kind:'TESTED_PLUGIN',plugins:['tested-plugin'],basis:'STATIC_REGISTRATION',evidence:[{file:'index.js',line:1}]}}]};
 await json(path.join(directory,'report.json'),{allTraceRef:ref,inspection,scores:[],timeline:[],target:{}});
 await json(path.join(base,'run.json'),{caseResults:[{caseId:'case',status:'COMPLETED'}]});
 const results=new ControlResults(root);const view=await results.get({targetId:'agent',runId:'older',state:'SUCCEEDED',events:[]});
 assert.equal(view.runtime['agent::older::case'].traceDetailPath,'api/control/trace/agent/older/case');
 const {server}=await startControlServer({root,port:0,controller:{results}});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/'+view.runtime['agent::older::case'].traceDetailPath);assert.equal(response.status,200);
 const detail=await response.json();assert.equal(detail.trace.pluginToolCallCount,1);assert.equal(detail.trace.toolCalls[0].attribution.plugins[0],'tested-plugin');assert.equal(detail.trace.verified,true);
});

test('frozen static inspection is visible before any Case report exists',async t=>{
 const root=await temporary(t),base=path.join(root,'var/evaluation-results/agents/agent/runs/new');
 await json(path.join(base,'inspection.json'),{toolSchemas:[{name:'plugin_tool',attribution:{kind:'TESTED_PLUGIN',plugins:['plugin'],basis:'STATIC_REGISTRATION',evidence:[]}}],pluginCatalog:[{packageName:'plugin',version:'1'}]});
 const view=await new ControlResults(root).get({targetId:'agent',runId:'new',state:'RUNNING',events:[]});
 assert.deepEqual(view.run.target.toolNames,['plugin_tool']);assert.equal(view.run.target.toolDetails[0].attribution.kind,'TESTED_PLUGIN');
});

test('ordinary API jobs cannot reintroduce saved workbench sizing arguments',async t=>{
 const root=await temporary(t),config=path.join(root,'config.json'),cli=path.join(root,'fake-cli.mjs');await json(config,{});
 await writeFile(cli,'console.log(JSON.stringify({schema:"evaldock.test/v1",args:process.argv.slice(2),status:"COMPLETED"}));');
 const jobs=new Jobs({repoRoot:root,stateRoot:path.join(root,'jobs'),targets:[{id:'real',descriptor:'/target',config,fixture:false}],cliPath:cli,cliPrefix:[cli],nodePath:process.execPath,maxConcurrentJobs:1});await jobs.init();t.after(()=>jobs.shutdown());
 const view=await jobs.start({action:'run',targetId:'real',datasetCount:1,caseCount:1,casesPerDataset:1,allDatasets:true,maxCases:1});
 const record=jobs.get(view.id);assert.deepEqual(record.request,{action:'run',targetId:'real'});
 for(let n=0;n<100&&jobs.children.size;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(!record.summary.args.includes('--case-count'));assert.ok(!record.summary.args.includes('--all-datasets'));
});

test('static view without a run uses current VM inspection, never the bundled example snapshot',async()=>{
 const {default:vm}=await import('node:vm');const html=await readFile('workbench/design-prototypes/index.html','utf8');
 const source=html.slice(html.indexOf('function staticView(){'),html.indexOf('\nfunction planReason'));
 const context=vm.createContext({activeRun:null,controlSnapshot:{staticInspection:{plugins:[{name:'CURRENT_PLUGIN'}],target:{dshVersion:'CURRENT_VERSION',toolNames:['CURRENT_TOOL'],toolDetails:[]}}},observationPlanSnapshot:{web:{version:'STALE_VERSION',tools:['STALE_TOOL']}},esc:v=>String(v??''),metaTable:JSON.stringify,observedPluginList:JSON.stringify,observedToolList:JSON.stringify,section:(_title,body)=>body});
 vm.runInContext(source,context);const result=vm.runInContext('staticView()',context);
 assert.ok(result.includes('CURRENT_TOOL'));assert.ok(result.includes('CURRENT_PLUGIN'));assert.ok(!result.includes('STALE_TOOL'));assert.ok(!result.includes('STALE_VERSION'));
 context.currentAgentName=()=> 'historical';context.activeRun={target:{},staticPlugins:undefined};
 const historical=vm.runInContext('staticView()',context);
 assert.ok(!historical.includes('CURRENT_TOOL'));assert.ok(!historical.includes('CURRENT_PLUGIN'));
});

test('current inspection page cannot display demo status, Case execution or results',async()=>{
 const {default:vm}=await import('node:vm');const html=await readFile('workbench/design-prototypes/index.html','utf8');
 const source=html.slice(html.indexOf('function currentInspectionPage(){'),html.indexOf('\nfunction renderUI(){'));
 const context=vm.createContext({controlSnapshot:{staticInspection:{plugins:[{},{}],target:{profile:'web'}}},nav:()=>'',staticView:()=>'<section>current tools</section>',esc:String});
 vm.runInContext(source,context);const result=vm.runInContext('currentInspectionPage()',context);
 assert.ok(result.includes('2 个插件声明'));assert.ok(result.includes('current tools'));
 assert.ok(!result.includes('示例-'));assert.ok(!result.includes('data-full-report'));assert.ok(!result.includes('data-stage'));assert.ok(!result.includes('执行与评分中'));
});
