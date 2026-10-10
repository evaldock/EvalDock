import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import audit from '../../scripts/audit-desktop-runtime.cjs';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-release-'));t.after(()=>rm(root,{recursive:true,force:true}));await cp('examples/datasets/minimal',path.join(root,'datasets'),{recursive:true});await mkdir(path.join(root,'dist'));return root;}
test('release audit accepts synthetic content and web URLs and emits byte digests',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'dist/demo.js'),'// https://example.org/en/'+'home/'+'tables/example.html');
 const files=audit.auditDesktopRuntime(root);assert.ok(files.length);assert.ok(files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)));
});
test('release audit rejects nested history, secrets, home paths and external links',async t=>{
 for(const [name,content] of [['reports/history.json','{}'],['.env','SECRET=value'],['local.js','const home="'+path.join('/Users','fixture-person','data')+'"'],['credential.txt','-----BEGIN PRIVATE KEY-----']]){
  const root=await fixture(t),file=path.join(root,'dist',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);assert.throws(()=>audit.auditDesktopRuntime(root),/publication boundary failed/);
 }
 const root=await fixture(t);await symlink('/etc/hosts',path.join(root,'dist/linked'));assert.throws(()=>audit.auditDesktopRuntime(root),/not a regular/);
});
test('release audit rejects modified demo answers and additional user configuration',async t=>{
 const root=await fixture(t);await writeFile(path.join(root,'datasets/basic-file-delivery/case-001/private/final.json'),'{}');assert.throws(()=>audit.auditDesktopRuntime(root),/differs from the synthetic demo/);
 const second=await fixture(t);await mkdir(path.join(second,'config'));await writeFile(path.join(second,'config/agents.json'),'{}');assert.throws(()=>audit.auditDesktopRuntime(second),/not a public config template/);
});
