import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as runtime from '../../workbench/runtime.mjs';

test('core runtime exports the client interface without a desktop dependency',async()=>{
  for(const name of ['startControlServer','BenchDockLibrary','OnlineSelection','plannerTargetInfo','importLibrary','libraryFingerprint','isBundledLibrary'])assert.equal(typeof runtime[name],'function',name);
  const pkg=JSON.parse(await readFile('package.json','utf8'));
  assert.equal(pkg.main,undefined);assert.equal(pkg.build,undefined);
  assert.equal(pkg.devDependencies.electron,undefined);
  assert.ok(!Object.keys(pkg.scripts).some(name=>name.startsWith('desktop')));
  assert.throws(()=>execFileSync(process.execPath,['scripts/export-runtime.mjs','src'],{stdio:'pipe'}),/Choose an output directory/);
});

test('exported runtime contains the built core and public resources without client or test code',async t=>{
  const parent=await mkdtemp(path.join(os.tmpdir(),'evaldock-runtime-contract-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const out=path.join(parent,'runtime');
  execFileSync(process.execPath,['scripts/export-runtime.mjs',out],{stdio:'pipe'});
  const manifest=JSON.parse(await readFile(path.join(out,'core-runtime.json'),'utf8'));
  assert.equal(manifest.schema,'evaldock.core-runtime/v1');
  assert.equal(manifest.commit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
  for(const file of ['workbench/runtime.mjs','workbench/lib/library-workspace.mjs','dist/src/app/cli.js','adapters/shared/factory.mjs','node_modules/undici/index.js'])await access(path.join(out,file));
  const roots=await readdir(out);assert.ok(!roots.includes('desktop'));assert.ok(!roots.includes('tests'));
  await assert.rejects(access(path.join(out,'dist/tests')));
  await assert.rejects(access(path.join(out,'workbench/design-prototypes/app.html')));
  await assert.rejects(access(path.join(out,'workbench/lib/model-settings.test.mjs')));
  await assert.rejects(access(path.join(out,'config/agents.json')));
});
