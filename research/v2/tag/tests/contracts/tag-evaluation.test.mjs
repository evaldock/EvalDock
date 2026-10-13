import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {temporary,trace,question,json,judgeInput} from './support.mjs';
import {buildTag} from '../../dist/src/evaluation/tag/graph.js';
import {packet,validateScores} from '../../dist/src/evaluation/tag/judge.js';
import {runTagEvaluation,verifyTagArtifacts} from '../../dist/src/evaluation/tag/pipeline.js';
import {parseEvaluationConfig} from '../../dist/src/app/evaluation-config.js';
import {validateEvaluationConfig} from '../../workbench/lib/evaluation-config.mjs';
import {runEvaluation} from '../../adapters/shared/evaluation.mjs';
import {compactPresentation,groupingBudget} from '../../dist/src/evaluation/tag/grouping.js';
import {startControlServer} from '../../workbench/control-server.mjs';
const event=(seq,type,data,sessionId='one')=>({id:'record-'+sessionId+'-'+seq,sourceId:'source',layer:'AGENT',content:{kind:'session/event',data:{sessionId,event:{seq,type,data}}}});
const fixture=()=>trace([event(1,'user/message',{message:{content:'Do task'}}),event(2,'assistant/message',{message:{content:[{type:'tool-call',id:'a',name:'read',arguments:'{"path":"a.py"}'}]}}),event(3,'tool/call',{name:'read',callId:'a',arguments:{evidenceRef:{seq:2,path:'/data/message/content/0/arguments'}}}),event(4,'tool/result',{callId:'a',result:'ok'}),event(5,'tool/call',{name:'write',callId:'b',arguments:{path:'a.py',content:'changed'}}),event(6,'tool/result',{callId:'b',result:'ok'})]);
test('group budget merges sparse neighbouring groups without losing records or splitting source groups',()=>{
 assert.equal(groupingBudget(115).maxGroups,5);assert.equal(groupingBudget(1000).maxGroups,7);
 for(const count of [1,7,20,115,152,1000]){
  const stages=Array.from({length:Math.ceil(count/5)},(_,i)=>({id:'g'+i,title:'阶段'+i,reason:'source',from:i*5+1,to:Math.min(count,i*5+5),recordIds:Array.from({length:Math.min(5,count-i*5)},(_,j)=>'e'+(i*5+j+1))}));
  const source={grouping:'llm',stages},before=JSON.stringify(source),out=compactPresentation(source,count);
  assert.ok(out.stages.length<=groupingBudget(count).maxGroups);
  assert.ok(out.stages.length===1||out.stages.every(g=>g.recordIds.length>=8));
  assert.deepEqual(out.stages.flatMap(g=>g.recordIds),stages.flatMap(g=>g.recordIds));
  for(const original of stages)assert.ok(out.stages.some(g=>original.recordIds.every(id=>g.recordIds.includes(id))));
  assert.equal(JSON.stringify(source),before);assert.deepEqual(compactPresentation(out,count),out);
 }
});

test('workbench TAG view renders current presentation without mutating the archived artifacts',async t=>{
 const root=await temporary(t),directory=path.join(root,'var/evaluation-results/agents/agent/runs/run/cases/case');
 const result=await runTagEvaluation({trace:fixture(),task:'Task',grading:{},title:'Title',caseDirectory:directory,judge:fake(),env:{}});
 await json(path.join(directory,'report.json'),{tagEvaluation:result});
 const original=await readFile(path.join(directory,'tag/index.html'),'utf8');
 const {server}=await startControlServer({root,port:0,controller:{}});t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/reports/agent/run/cases/case/tag/index.html';
 const embedded=await fetch(url+'?view=workbench');assert.equal(embedded.status,200);assert.ok((await embedded.text()).includes('<body class="embedded-tag">'));
 assert.ok(!(await(await fetch(url+'?view=tag')).text()).includes('<body class="embedded-tag">'));
 assert.equal(await(await fetch(url)).text(),original);await verifyTagArtifacts(directory,result);
 await writeFile(path.join(directory,'tag/data/graph.json'),'{}');assert.equal((await fetch(url+'?view=workbench')).status,409);
});
function fake(){const calls=[];return {model:'contract-fixture',calls,async call(input){calls.push(input);return {value:input.purpose?{groups:[{title:'执行任务',reason:'Fixture grouping',recordIds:input.records.map(r=>r.id)}]}:{nodeId:input.packet.targetActionId,dimensions:Object.fromEntries(Object.keys(input.rubric).map(d=>[d,{status:d==='feedback'?'not_applicable':'scored',band:d==='feedback'?null:3,value:d==='feedback'?null:75,verdict:'acceptable',reason:'Fixture only',counterEvidence:'None',limitations:'Not a real model score',evidenceNodeIds:[input.packet.targetActionId]}]))},usage:{total_tokens:1}};}};}
test('TAG preserves every record, resolves native references, and uses session-scoped exact pairs',()=>{
 const x=fixture();const {graph,context}=buildTag(x,'Task','Title');assert.equal(graph.records.length,6);assert.equal(graph.nodes.filter(n=>n.kind==='event').length,6);assert.equal(graph.nodes.find(n=>n.id==='e3').arguments.path,'a.py');assert.equal(graph.edges.filter(e=>e.type==='CALL_RESULT').length,2);assert.equal(context.frames[0].inputTotal,null);
 const ambiguous=buildTag(trace([...x.entries,event(7,'tool/call',{name:'read',callId:'a'}),event(8,'tool/call',{name:'read',callId:'a'},'two'),event(9,'tool/result',{callId:'a'},'two')]),'Task','Title').graph;
 assert.equal(ambiguous.edges.filter(e=>e.type==='CALL_RESULT').length,2);assert.ok(ambiguous.gaps.some(g=>g.code==='UNPAIRED_RETURN'));
 const future=buildTag(trace([event(1,'tool/call',{arguments:{evidenceRef:{seq:2,path:'/data/secret'}}}),event(2,'tool/result',{secret:'future'})]),'Task','Title').graph;
 assert.ok(future.gaps.some(g=>g.code==='UNRESOLVED_REFERENCE'));assert.ok(!JSON.stringify(future.nodes[0].arguments).includes('future'));
});
test('decision packets exclude later outcomes; invented citations and invalid scores are rejected',()=>{
 const g=buildTag(fixture(),'Task','Title').graph,a=g.nodes.find(n=>n.id==='e3'),p=packet(g,a,'decision');assert.ok(p.evidence.every(e=>e.index<=3));assert.ok(!p.evidence.some(e=>e.id==='e4'));
 assert.throws(()=>validateScores({nodeId:'e3',dimensions:{relevance:{status:'scored',band:3,value:75,verdict:'acceptable',reason:'x',counterEvidence:'x',limitations:'x',evidenceNodeIds:['e3','e4']}}},p,['relevance']),/EVIDENCE/);
});
test('TAG artifacts, five-dimensional scores, caching and relocation integrity',async t=>{
 const dir=await temporary(t),judge=fake(),input={trace:fixture(),task:'Task </script>',grading:{},title:'Title',caseDirectory:dir,judge,env:{}};
 const result=await runTagEvaluation(input);assert.equal(result.status,'COMPLETE');assert.equal(result.actions,2);assert.equal(result.scored,8);assert.equal(result.notApplicable,2);assert.equal(judge.calls.length,5);await verifyTagArtifacts(dir,result);
 const page=await readFile(path.join(dir,'tag/index.html'),'utf8');assert.ok(page.includes('context-data'));assert.ok(!page.includes('Task </script>'));assert.ok(!page.includes('deepseek-flash'));
 const cached=await runTagEvaluation(input);assert.equal(cached.status,'COMPLETE');assert.equal(judge.calls.length,5);
 await writeFile(path.join(dir,'tag/data/graph.json'),'{}');await assert.rejects(()=>verifyTagArtifacts(dir,cached),/DIGEST/);
});
test('group failure only falls back to reading groups; Judge failure never fabricates zero or legacy scores',async t=>{
 const dir=await temporary(t),good=fake();const judge={model:'fake',async call(input){if(input.purpose)throw Error('TAG_GROUP_INVALID');return good.call(input);}};
 const r=await runTagEvaluation({trace:fixture(),task:'Task',grading:{},title:'T',caseDirectory:dir,judge,env:{}});assert.equal(r.status,'COMPLETE');assert.equal(r.grouping,'records');
 const failed=await runTagEvaluation({trace:fixture(),task:'Task',grading:{},title:'T',caseDirectory:await temporary(t),judge:{model:'failed',async call(){throw Error('TAG_JUDGE_NETWORK_OR_TIMEOUT');}},env:{}});assert.equal(failed.status,'ERROR');assert.equal(failed.scored,0);assert.equal(failed.errorCount,10);
});
test('cancelled and no-action evaluations remain explicit; credentials are not persisted',async t=>{
 const judge=fake(),base={trace:fixture(),task:'T',grading:{},title:'T',judge,env:{}};
 const r=await runTagEvaluation({...base,caseDirectory:await temporary(t),signal:AbortSignal.abort()});assert.equal(r.status,'ERROR');assert.equal(judge.calls.length,0);
 const empty=await runTagEvaluation({...base,trace:trace([]),caseDirectory:await temporary(t)});assert.equal(empty.status,'NO_ACTIONS');
 const secret=await runTagEvaluation({...base,grading:{key:'test-secret-123456789'},env:{EVALDOCK_JUDGE_API_KEY:'test-secret-123456789'},caseDirectory:await temporary(t)});assert.equal(secret.reason,'TAG_CREDENTIAL_IN_EVIDENCE');
});
test('workbench and CLI accept TAG mode; adapter TAG path never constructs legacy Judge',async t=>{
 const root=await temporary(t);await question(path.join(root,'datasets'));const label=judgeInput().label;await json(path.join(root,'labels/contract.json'),label);
 await writeFile(path.join(root,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Example',description:'Fixture',availableCaseCount:1,labelIds:[label.labelId]}]})+'\n```');
 const config={mode:'TAG',selection:{kind:'SELECTED',items:[{datasetId:'dataset.example/v1',caseIndices:[0]}]}};assert.deepEqual(parseEvaluationConfig(config),config);assert.deepEqual(await validateEvaluationConfig(root,config),config);
 let tagCalls=0;const adapter={kind:'hermes',name:'Fixture',targetId:'agent.fixture',trace:{kind:'hermes',sourceType:'HERMES_PROBE',externalSchema:'hermes/events',blindSpots:[],normalizeEvent:r=>r},staticInfo:()=>({}),inspect:async()=>({evaluationReady:true,version:'fixture',installRoot:root,limitations:[]}),prepare:async()=>({}),run:async()=>({sessionId:'fixture-session',queue:[],seen:0,final:'Done',error:null,cleanup:'VERIFIED',result:{stopReason:'done'}}),dispose:async()=>{}};
 const result=await runEvaluation({root,runId:'tag.fixture',adapter,evaluationConfig:config,onProgress:()=>{},judgeFactory:()=>{throw Error('Legacy Judge must not be constructed');},tagEvaluator:async input=>{tagCalls++;return runTagEvaluation({...input,judge:fake(),env:{}});}});
 if(result.status!=='COMPLETED'){for(const f of await readdir(root,{recursive:true}))if(f.endsWith('failure.json'))console.error(f,await readFile(path.join(root,f),'utf8'));}
 assert.equal(result.status,'COMPLETED',JSON.stringify(result)+' '+await readFile(path.join(root,'var/evaluation-results/agent.fixture/runs/tag.fixture/cases/example.case-1/failure.json'),'utf8').catch(()=>''));assert.equal(tagCalls,1);assert.equal(result.scores.length,0);assert.equal(result.caseResults[0].tagEvaluation.status,'NO_ACTIONS');
});

test('DSH batch carries TAG selection and separate TAG summary to every Case',async t=>{
 const {runEvaluationBatch}=await import('../../dist/src/app/batch.js');
 const root=await temporary(t),target=path.join(root,'target');await mkdir(target);await question(path.join(root,'datasets'));
 await writeFile(path.join(root,'datasets/catalog.md'),'```json evaldock-dataset-catalog\n'+JSON.stringify({schema:'evaldock.dataset-planner-catalog/v1',version:'1',datasets:[{datasetId:'dataset.example/v1',name:'Example',description:'Fixture',labelIds:['label.contract/v1'],availableCaseCount:1}]})+'\n```');
 const base={schema:'evaldock.mvp.cli-summary/v1',command:'run',fixture:true,status:'COMPLETED',exitCode:0,operationalHealth:'HEALTHY',failureGroups:[],reasonCodes:[],recordsPath:'unused',scores:[]};let called=0;
 const config={mode:'TAG',selection:{kind:'SELECTED',items:[{datasetId:'dataset.example/v1',caseIndices:[0]}]}};
 const result=await runEvaluationBatch({cwd:root,runId:'tag.dsh',descriptor:{targetId:'agent.fixture',sourceRoot:target},evaluationConfig:config,workflowRunner:async input=>{
  assert.equal(input.evaluationMode,'TAG');if(input.stopAfter==='PLAN')return {...base,runId:input.runId,datasetTestProfile:'STANDARD',selectedDatasets:input.precomputedDatasetSelection.selectedDatasets,totalCaseCount:1,datasetMatchModel:'explicit-cases',datasetMatchDurationMs:0};
  const frozen=JSON.parse(await readFile(path.join(root,'var/evaluation-results/agents/agent.fixture/runs/tag.dsh/plan.json'),'utf8'));
  assert.deepEqual(frozen.evaluationConfig,config);
  called++;const tagEvaluation=await runTagEvaluation({trace:fixture(),task:'Task',grading:{},title:'Fixture',caseDirectory:path.join(root,'tag-output'),judge:fake(),env:{}});return {...base,runId:input.runId,tagEvaluation};
 }});
 assert.equal(called,1);assert.equal(result.caseResults[0].tagEvaluation.status,'COMPLETE');assert.equal(result.scores.length,0);
});

test('TAG cannot silently combine with ReAct label judging',async()=>{
 const config={mode:'TAG',judge:'REACT',selection:{kind:'STANDARD'}};
 assert.throws(()=>parseEvaluationConfig(config),/TAG/);
 await assert.rejects(()=>validateEvaluationConfig(process.cwd(),config),/TAG/);
 await assert.rejects(()=>runEvaluation({root:process.cwd(),runId:'must-not-create',adapter:{kind:'pi',targetId:'pi',name:'Pi'},evaluationConfig:config}),/TAG_REACT/);
});
