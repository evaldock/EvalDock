import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {crc32,deflateRawSync} from 'node:zlib';
import {importLibraryArchive} from '../../desktop/library-archive.mjs';
import {libraryFingerprint} from '../../desktop/workspace.mjs';

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
