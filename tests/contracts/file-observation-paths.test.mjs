import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,symlink} from 'node:fs/promises';
import {temporary,trace} from './support.mjs';
import {validatePortablePath,validateObservedPortablePath} from '../../dist/src/core/models.js';
import {captureFileSnapshot,materializeFileSnapshot,buildFileDiff,materializeFileDiff} from '../../dist/observer-lab/adapters/filesystem/sensor.js';

test('observed filenames are literal while configured paths remain strict',()=>{
 for(const name of ['work/[Content_Types].xml','work/a?.txt','work/*.csv','work/${HOME}.txt','work/%TEMP%.txt']){
  assert.equal(validateObservedPortablePath(name),name);
  assert.throws(()=>validatePortablePath(name));
 }
 for(const name of ['../secret','work/../../secret','/etc/passwd','C:\\secret','work\\secret','a//b','a/./b','a/../b','a\0b','']){
  assert.throws(()=>validateObservedPortablePath(name));
  assert.throws(()=>validatePortablePath(name));
 }
 assert.throws(()=>validateObservedPortablePath('.'));
 assert.equal(validateObservedPortablePath('.','readError',{allowDot:true}),'.');
});

test('unzipped XLSX names survive snapshot and diff without following outside symlinks',async t=>{
 const root=await temporary(t),workspace=path.join(root,'workspace');await mkdir(workspace);
 const metadata={scope:trace().scope,createdAt:'2026-10-09T00:00:00Z',producerVersion:'contract'};
 const options={attemptId:metadata.scope.attemptId,rootPath:workspace,rootBinding:'workspace',maxFileBytes:1024};
 const before=await captureFileSnapshot({...options,snapshotId:'snapshot.before',phase:'BEFORE'});
 await writeFile(path.join(workspace,'[Content_Types].xml'),'<Types/>');
 await writeFile(path.join(root,'secret.txt'),'outside');await symlink(path.join(root,'secret.txt'),path.join(workspace,'[outside]'));
 const after=await captureFileSnapshot({...options,snapshotId:'snapshot.after',phase:'AFTER'});
 const b=materializeFileSnapshot(before,metadata),a=materializeFileSnapshot(after,metadata);
 assert.equal(a.entries.find(e=>e.portablePath==='[Content_Types].xml').byteLength,8);
 const link=a.entries.find(e=>e.portablePath==='[outside]');assert.equal(link.entryType,'SYMLINK');assert.equal(link.resolvedWithinRoot,false);assert.equal(link.contentDigest,undefined);
 const ref=x=>({schema:x.schema,id:x.snapshotId,digest:x.contentDigest});
 const diff=materializeFileDiff(buildFileDiff({diffId:'diff.contract',beforeSnapshot:before,afterSnapshot:after,beforeSnapshotRef:ref(b),afterSnapshotRef:ref(a)}),metadata);
 assert.ok(diff.added.some(e=>e.portablePath==='[Content_Types].xml'));
});
