import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,symlink,mkdir,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importLibrary} from '../../workbench/lib/library-workspace.mjs';
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
