import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,symlink,mkdir,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {importLibrary} from '../../desktop/workspace.mjs';
import {appSummary} from '../../workbench/lib/app-summary.mjs';
const repo=process.cwd();
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-desktop-'));t.after(()=>rm(root,{recursive:true,force:true}));await cp(path.join(repo,'dist'),path.join(root,'dist'),{recursive:true});await writeFile(path.join(root,'package.json'),'{"type":"module"}');await cp(path.join(repo,'datasets'),path.join(root,'datasets'),{recursive:true});return root;}
test('desktop summary isolates offline Agent and retains other Agent records',async()=>{
 const bad={status:async()=>{throw Error('offline');},jobs:{jobs:new Map()}};
 const good={status:async()=>({targets:[{id:'pi',evaluationReady:true}]}),records:async()=>({jobs:[{id:'j',createdAt:'2026-01-01',agentKind:'pi'}],runs:[]})};
 const result=await appSummary({control:bad,workbuddy:bad,agents:{pi:good}});
 assert.equal(result.agents.find(a=>a.kind==='pi').targets[0].evaluationReady,true);assert.equal(result.jobs[0].id,'j');assert.ok(result.agents.find(a=>a.kind==='dsh').error);
});
test('library import validates content, archives previous version and records digest',async t=>{
 const root=await fixture(t);const result=await importLibrary(path.join(repo,'datasets'),root);
 assert.equal(result.cases,1);assert.match(result.sha256,/^[a-f0-9]{64}$/);assert.equal((await readdir(path.join(root,'dataset-history'))).length,1);
 assert.equal(JSON.parse(await readFile(path.join(root,'datasets/evaldock-import.json'))).sha256,result.sha256);
});
test('invalid library and symlinks leave installed library untouched',async t=>{
 const root=await fixture(t),source=path.join(root,'incoming');await mkdir(source);await writeFile(path.join(source,'catalog.md'),'invalid');
 const previous=await readFile(path.join(root,'datasets/catalog.md'),'utf8');
 await assert.rejects(importLibrary(source,root));assert.equal(await readFile(path.join(root,'datasets/catalog.md'),'utf8'),previous);
 await symlink('/etc/hosts',path.join(source,'input.txt'));await assert.rejects(importLibrary(source,root),/符号链接/);
 assert.equal(await readFile(path.join(root,'datasets/catalog.md'),'utf8'),previous);
});
