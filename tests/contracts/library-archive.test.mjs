import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {readdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {crc32,deflateRawSync} from 'node:zlib';
import {importLibraryArchive} from '../../desktop/library-archive.mjs';
import {libraryFingerprint,importLibrary} from '../../desktop/workspace.mjs';

function archive(entries){
  const locals=[],central=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name),data=Buffer.from(entry.data??''),body=entry.deflate?deflateRawSync(data):data;
    const checksum=entry.badCrc?0:crc32(data),flags=0x800|(entry.encrypted?1:0),method=entry.deflate?8:0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(entry.size??data.length,22);local.writeUInt16LE(name.length,26);
    const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50);header.writeUInt16LE(0x314,4);header.writeUInt16LE(20,6);header.writeUInt16LE(flags,8);header.writeUInt16LE(method,10);header.writeUInt32LE(checksum,16);header.writeUInt32LE(body.length,20);header.writeUInt32LE(entry.size??data.length,24);header.writeUInt16LE(name.length,28);header.writeUInt32LE(((entry.mode??0o100600)*65536)>>>0,38);header.writeUInt32LE(offset,42);
    locals.push(local,name,body);central.push(header,name);offset+=local.length+name.length+body.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-zip-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await cp('dist',path.join(root,'dist'),{recursive:true});await cp('datasets',path.join(root,'datasets'),{recursive:true});await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  const entries=[];
  async function visit(directory,relative=''){
    for(const item of await readdir(directory,{withFileTypes:true})){
      const name=relative+item.name,file=path.join(directory,item.name);
      if(item.isDirectory())await visit(file,name+'/');else entries.push({name,data:await readFile(file),deflate:true});
    }
  }
  await visit('datasets');
  const source=path.join(root,'incoming.zip'),before=await libraryFingerprint(path.join(root,'datasets'));
  return {root,entries,source,before};
}
test('root and wrapped ZIP libraries use validation, backup and import receipts',async t=>{
  for(const prefix of ['', '合成题库/']){
    const f=await fixture(t),progress=[];
    await writeFile(f.source,archive(f.entries.map(entry=>({...entry,name:prefix+entry.name}))));
    const result=await importLibraryArchive(f.source,f.root,{onProgress:value=>progress.push(value)});
    assert.equal(result.cases,1);assert.equal((await readdir(path.join(f.root,'dataset-history'))).length,1);
    assert.equal(JSON.parse(await readFile(path.join(f.root,'datasets/evaldock-import.json'))).sha256,result.sha256);
    assert.ok(progress.some(value=>value.phase==='EXTRACTING'));assert.equal(progress.at(-1).phase,'COMMITTING');
    assert.equal((await readdir(f.root)).some(name=>name.startsWith('.dataset-zip-')),false);
  }
});
test('unsafe ZIP entries, corruption, limits and missing catalogs preserve the installed library',async t=>{
  const badEntries=[
    [{name:'../escape',data:'bad'}],[{name:'/absolute',data:'bad'}],[{name:'C:/absolute',data:'bad'}],
    [{name:'link',data:'target',mode:0o120777}],[{name:'file',data:'bad',encrypted:true}],
    [{name:'answer',data:'one'},{name:'ANSWER',data:'two'}],
    [{name:'data',data:'bad',badCrc:true}],[{name:'data',data:'bad',deflate:true,size:1}],
    [{name:'missing.txt',data:'no catalog'}],
  ];
  for(const entries of badEntries){
    const f=await fixture(t);await writeFile(f.source,archive(entries));
    await assert.rejects(importLibraryArchive(f.source,f.root));
    assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),f.before);
    assert.equal((await readdir(f.root)).some(name=>name.startsWith('.dataset-zip-')),false);
  }
  const f=await fixture(t);await writeFile(f.source,archive(f.entries));
  await assert.rejects(importLibraryArchive(f.source,f.root,{archiveLimits:{bytes:10,files:100000}}),/超过导入限制/);
  const signal=AbortSignal.abort();await assert.rejects(importLibraryArchive(f.source,f.root,{signal}));
  assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),f.before);
});
test('ZIP commit failure restores the original library after it was moved to backup',async t=>{
  const f=await fixture(t);await writeFile(f.source,archive(f.entries));let injected=false;
  await assert.rejects(importLibraryArchive(f.source,f.root,{onProgress:progress=>{
    if(progress.phase==='COMMITTING'){
      // Remove only this test's staged payload: the first rename can succeed,
      // then switching the now-missing payload fails and must restore the backup.
      const staged=readdirSync(f.root).filter(name=>name.startsWith('.dataset-import-'));
      assert.equal(staged.length,1);rmSync(path.join(f.root,staged[0]),{recursive:true});injected=true;
    }
  }}),{code:'ENOENT'});
  assert.equal(injected,true);assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),f.before);
  assert.deepEqual(await readdir(path.join(f.root,'dataset-history')),[]);
  assert.equal((await readdir(f.root)).some(name=>/^\.dataset-(zip|import)-/.test(name)),false);
});
test('a successful replacement retains a complete backup that the existing importer can restore',async t=>{
  const f=await fixture(t),replacement=f.entries.map(entry=>entry.name.endsWith('/question.json')?{...entry,data:JSON.stringify({...JSON.parse(entry.data),title:'Synthetic replacement title'})}:entry);
  await writeFile(path.join(f.root,'user-state.txt'),'synthetic user data');
  await writeFile(f.source,archive(replacement));await importLibraryArchive(f.source,f.root);
  const [backupName]=await readdir(path.join(f.root,'dataset-history')),backup=path.join(f.root,'dataset-history',backupName);
  assert.equal(await libraryFingerprint(backup),f.before);
  const question=replacement.find(entry=>entry.name.endsWith('/question.json')).name;
  assert.equal(JSON.parse(await readFile(path.join(f.root,'datasets',question))).title,'Synthetic replacement title');
  const restored=await importLibrary(backup,f.root);assert.equal(restored.cases,1);
  for(const entry of f.entries)assert.deepEqual(await readFile(path.join(f.root,'datasets',entry.name)),entry.data);
  assert.equal(await libraryFingerprint(backup),f.before);assert.equal((await readdir(path.join(f.root,'dataset-history'))).length,2);
  assert.equal(JSON.parse(await readFile(path.join(f.root,'datasets/evaldock-import.json'))).sha256,restored.sha256);
  assert.equal(await readFile(path.join(f.root,'user-state.txt'),'utf8'),'synthetic user data');
  assert.equal((await readdir(f.root)).some(name=>/^\.dataset-(zip|import)-/.test(name)),false);
});
test('cancellation after extraction starts and the file-count limit leave no partial library',async t=>{
  const f=await fixture(t);await writeFile(f.source,archive(f.entries));const controller=new AbortController();let extracted=0;
  await assert.rejects(importLibraryArchive(f.source,f.root,{signal:controller.signal,onProgress:progress=>{
    if(progress.phase==='EXTRACTING'){extracted++;controller.abort();}
  }}),{name:'AbortError'});
  assert.equal(extracted,1);
  await assert.rejects(importLibraryArchive(f.source,f.root,{archiveLimits:{bytes:4*1024**3,files:1}}),/超过导入限制/);
  assert.equal(await libraryFingerprint(path.join(f.root,'datasets')),f.before);
  assert.equal((await readdir(f.root)).some(name=>/^\.dataset-(zip|import)-/.test(name)),false);
});
