import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,symlink,mkdir,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importLibrary,prepareWorkspace,isBundledLibrary} from '../../desktop/workspace.mjs';
import {appSummary} from '../../workbench/lib/app-summary.mjs';
import {evaluationCatalog} from '../../workbench/lib/evaluation-config.mjs';
import {ControlResults} from '../../workbench/lib/control-results.mjs';
import {buildResult,serializeReportDocument,parseVerifiedReportDocument} from '../../dist/src/reporting/record.js';
import {renderReportHtml} from '../../dist/src/reporting/html.js';
import {createHash} from 'node:crypto';
const repo=process.cwd();
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-desktop-'));t.after(()=>rm(root,{recursive:true,force:true}));await cp(path.join(repo,'dist'),path.join(root,'dist'),{recursive:true});await writeFile(path.join(root,'package.json'),'{"type":"module"}');await cp(path.join(repo,'datasets'),path.join(root,'datasets'),{recursive:true});return root;}
test('desktop summary isolates offline Agent and retains other Agent records',async()=>{
 const bad={status:async()=>{throw Error('offline');},jobs:{jobs:new Map()}};
 const good={status:async()=>({targets:[{id:'pi',evaluationReady:true}]}),records:async()=>({jobs:[{id:'j',createdAt:'2026-01-01',agentKind:'pi'}],runs:[]})};
 const result=await appSummary({control:bad,workbuddy:bad,agents:{pi:good}});
 assert.equal(result.agents.find(a=>a.kind==='pi').targets[0].evaluationReady,true);assert.equal(result.jobs[0].id,'j');assert.ok(result.agents.find(a=>a.kind==='dsh').error);
});
test('desktop summary merges disk archives and controller records by target and run',async()=>{
 const archived={id:'external-synthetic',targetId:'pi-a',runId:'same-run',agentKind:'pi',createdAt:'2026-01-01'};
 const current={...archived,id:'controller-synthetic',state:'SUCCEEDED'},other={...current,id:'other-synthetic',targetId:'pi-b'};
 const run=agentId=>({agentId,agentKind:'pi',run:{id:'same-run'}});
 const control={status:async()=>{throw Error('DSH profile missing');},records:async()=>({jobs:[archived],runs:[run('pi-a')]})};
 const quiet={status:async()=>({}),records:async()=>({jobs:[],runs:[]})};
 const pi={...quiet,records:async()=>({jobs:[current,other],runs:[run('pi-a'),run('pi-b')]})};
 const summary=await appSummary({control,workbuddy:quiet,agents:{pi}});
 assert.deepEqual(summary.jobs.map(j=>j.id),['controller-synthetic','other-synthetic']);
 assert.deepEqual(summary.runs.map(r=>r.agentId),['pi-a','pi-b']);
});
test('library import validates content, archives previous version and records digest',async t=>{
 const root=await fixture(t),progress=[];const result=await importLibrary(path.join(repo,'datasets'),root,{onProgress:value=>progress.push(value)});
 assert.equal(result.cases,1);assert.match(result.sha256,/^[a-f0-9]{64}$/);assert.equal((await readdir(path.join(root,'dataset-history'))).length,1);
 assert.equal(JSON.parse(await readFile(path.join(root,'datasets/evaldock-import.json'))).sha256,result.sha256);
 assert.ok(progress.some(value=>value.phase==='COPYING'&&value.completed>0));
 assert.deepEqual(progress.filter(value=>value.phase==='VALIDATING'&&value.total),[{phase:'VALIDATING',completed:0,total:1},{phase:'VALIDATING',completed:1,total:1}]);
 assert.equal(progress.at(-1).phase,'COMMITTING');
});
test('invalid library and symlinks leave installed library untouched',async t=>{
 const root=await fixture(t),source=path.join(root,'incoming');await mkdir(source);await writeFile(path.join(source,'catalog.md'),'invalid');
 const previous=await readFile(path.join(root,'datasets/catalog.md'),'utf8');
 await assert.rejects(importLibrary(source,root));assert.equal(await readFile(path.join(root,'datasets/catalog.md'),'utf8'),previous);
 await symlink('/etc/hosts',path.join(source,'input.txt'));await assert.rejects(importLibrary(source,root),/符号链接/);
 assert.equal(await readFile(path.join(root,'datasets/catalog.md'),'utf8'),previous);
});
test('first workspace setup and later code upgrades preserve user config, library and results',async t=>{
 const root=await fixture(t),source=path.join(root,'runtime');await mkdir(source);
 for(const name of ['dist','adapters','workbench','labels','planning','trace','observer-lab','src','desktop','node_modules','config','datasets','environments']){
  await mkdir(path.join(source,name));await writeFile(path.join(source,name,'version.txt'),'first');
 }
 await mkdir(path.join(source,'config/targets'));await writeFile(path.join(source,'config/targets/real-dsh.json'),JSON.stringify({dshHome:'/Users/your-user/.dsh'}));
 await writeFile(path.join(source,'package.json'),'{"type":"module"}');
 // Existing fixture data is deliberately retained during first workspace preparation.
 await prepareWorkspace(source,root);await writeFile(path.join(root,'config/agents.json'),'{"targets":[{"id":"synthetic-user-target"}]}');
 await mkdir(path.join(root,'var/evaluation-results'),{recursive:true});await writeFile(path.join(root,'var/evaluation-results/receipt.json'),'synthetic result');
 const config=await readFile(path.join(root,'config/agents.json')),catalog=await readFile(path.join(root,'datasets/catalog.md'));
 await writeFile(path.join(source,'adapters/version.txt'),'second');await writeFile(path.join(source,'config/version.txt'),'second');
 await prepareWorkspace(source,root);
 assert.equal(await readFile(path.join(root,'adapters/version.txt'),'utf8'),'second');assert.equal(await readFile(path.join(root,'config/version.txt'),'utf8'),'first');
 assert.deepEqual(await readFile(path.join(root,'config/agents.json')),config);assert.deepEqual(await readFile(path.join(root,'datasets/catalog.md')),catalog);
 assert.equal(await readFile(path.join(root,'var/evaluation-results/receipt.json'),'utf8'),'synthetic result');
});
test('workspace upgrade preserves complete user files and readable historical scales, zero, unassessable and errors',async t=>{
 const root=await fixture(t),source=path.join(root,'runtime');await mkdir(source);
 for(const name of ['dist','adapters','workbench','labels','planning','trace','observer-lab','src','desktop','node_modules','config','datasets','environments'])await mkdir(path.join(source,name));
 await mkdir(path.join(root,'config/targets'),{recursive:true});
 await writeFile(path.join(root,'config/targets/real-dsh.json'),JSON.stringify({dshHome:path.join(root,'synthetic-home')}));
 await writeFile(path.join(root,'config/agents.json'),'{"targets":[{"id":"synthetic-user-target"}]}');
 await cp(path.join(repo,'desktop/empty-library'),path.join(source,'datasets'),{recursive:true});
 await writeFile(path.join(source,'package.json'),'{"type":"module"}');
 await writeFile(path.join(source,'adapters/version.txt'),'new-code');
 const labelId='label.contract/v1',scale={min:0,max:10},targetId='synthetic-upgrade',runId='legacy-run';
 const oldLabel={labelId,scoringStandard:{label:'Frozen legacy label',scoring_scale:scale}};
 await writeFile(path.join(source,'labels/contract.json'),JSON.stringify({labelId,scoringStandard:{label:'New label',scoring_scale:{min:0,max:100}}}));
 const runDirectory=path.join(root,'var/evaluation-results/agents',targetId,'runs',runId),caseResults=[];
 for(const status of ['SCORED','UNASSESSABLE','ERROR']){
  const caseId='synthetic-'+status.toLowerCase(),directory=path.join(runDirectory,'cases',caseId);await mkdir(directory,{recursive:true});
  const scores=[{labelId,status,score:status==='SCORED'?0:null,reason:'Synthetic historical '+status,scale,evidenceIds:[],model:'synthetic',createdAt:'2026-01-01T00:00:00Z'}];
  const record=buildResult({runId,scope:{runId,targetId,caseId},target:{agentKind:'pi'},case:{caseId,question:{title:caseId},task:'Synthetic old task',labelIds:[labelId]},labels:[oldLabel],scores,dimensions:[],timeline:[],artifacts:[],execution:{exitCode:0,durationMs:1,stdout:'Synthetic old result'},currentPhase:'REPORTED',runState:'COMPLETED',fixture:true,failures:[]},'synthetic-legacy');
  await writeFile(path.join(directory,'report.json'),serializeReportDocument(record));
  await writeFile(path.join(directory,'report.html'),renderReportHtml(record));
  await mkdir(path.join(directory,'output'));await writeFile(path.join(directory,'output/result.txt'),'synthetic deliverable');
  caseResults.push({caseId,datasetId:'synthetic-history',status:'COMPLETED',scores});
 }
 await writeFile(path.join(runDirectory,'run.json'),JSON.stringify({runId,targetId,status:'COMPLETED',caseResults}));
 async function snapshot(){
  const files={};
  async function visit(relative){for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
   const file=path.join(relative,entry.name);if(entry.isDirectory())await visit(file);
   else files[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
  }}
  for(const name of ['config','datasets','var'])await visit(name);return files;
 }
 const before=await snapshot();await prepareWorkspace(source,root);
 assert.equal(await readFile(path.join(root,'adapters/version.txt'),'utf8'),'new-code');
 assert.deepEqual(await snapshot(),before);
 const view=await new ControlResults(root).get({targetId,runId,state:'SUCCEEDED',events:[]});
 assert.deepEqual(view.run.scoreScale,scale);assert.equal(view.run.labelNames[labelId],'Frozen legacy label');
 assert.deepEqual(view.run.cases.map(c=>c.scores[labelId].state),['scored','null','error']);
 assert.deepEqual(view.run.cases.map(c=>c.scores[labelId].value),[0,null,null]);
 for(const {caseId} of caseResults){
  const record=parseVerifiedReportDocument(await readFile(path.join(runDirectory,'cases',caseId,'report.json'),'utf8'));
  assert.deepEqual(record.scores[0].scale,scale);assert.ok(renderReportHtml(record).includes(caseId));
 }
 assert.deepEqual(await snapshot(),before,'reading old reports must not rewrite them');
});
test('a new workspace starts with zero tasks, empty Agent targets and no evaluation history',async t=>{
 const root=await fixture(t),source=path.join(root,'runtime'),fresh=path.join(root,'fresh');await mkdir(source);
 for(const name of ['dist','adapters','workbench','labels','planning','trace','observer-lab','src','desktop','node_modules','config','environments'])await mkdir(path.join(source,name));
 await cp(path.join(repo,'dist'),path.join(source,'dist'),{recursive:true});
 await cp(path.join(repo,'desktop/empty-library'),path.join(source,'datasets'),{recursive:true});
 await mkdir(path.join(source,'config/targets'));await writeFile(path.join(source,'config/targets/real-dsh.json'),JSON.stringify({dshHome:'/Users/your-user/.dsh'}));
 await writeFile(path.join(source,'package.json'),'{"type":"module"}');
 await prepareWorkspace(source,fresh);
 assert.deepEqual(JSON.parse(await readFile(path.join(fresh,'config/agents.json'),'utf8')),{schema:'evaldock.agent-targets/v1',targets:[]});
 assert.equal((await readdir(fresh)).includes('var'),false);
 assert.equal((await readdir(fresh)).includes('dataset-history'),false);
 assert.deepEqual(await readFile(path.join(fresh,'datasets/catalog.md')),await readFile(path.join(repo,'desktop/empty-library/catalog.md')));
 assert.deepEqual(await evaluationCatalog(fresh),{schema:'evaldock.workbench.evaluation-catalog/v1',datasets:[],scoring:{readyCases:0,totalCases:0,unavailableCases:0,labelIds:[]}});
 assert.equal(await isBundledLibrary(source,fresh),true);
 // Upgrading an existing user must retain the previous library, including old demos.
 const previous=await readFile(path.join(root,'datasets/catalog.md'));
 await prepareWorkspace(source,root);assert.deepEqual(await readFile(path.join(root,'datasets/catalog.md')),previous);
 await assert.rejects(importLibrary(path.join(repo,'desktop/empty-library'),root),/at least one Dataset/);
 assert.deepEqual(await readFile(path.join(root,'datasets/catalog.md')),previous);
});
