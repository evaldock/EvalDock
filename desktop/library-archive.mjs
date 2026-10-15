import {mkdir,open,readdir,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {crc32} from 'node:zlib';
import yauzl from 'yauzl';
import {importLibrary} from './workspace.mjs';
import {LibraryPaths} from './library-paths.mjs';

const limits={bytes:4*1024**3,files:100000};
function entryPath(entry){
  const name=entry.fileName.replace(/\/$/,'');
  if(!name||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('ZIP 包含无效文件路径');
  const type=(entry.externalFileAttributes>>>16)&0o170000;
  if(type&&type!==0o100000&&type!==0o040000)throw Error('ZIP 只能包含普通文件和目录，不能包含符号链接');
  if(entry.isEncrypted())throw Error('不支持加密 ZIP 题库');
  const directory=entry.fileName.endsWith('/');
  if(type===0o040000&&!directory||type===0o100000&&directory)throw Error('ZIP 文件类型与路径不一致');
  return {name,directory};
}

/** Expand into a disposable directory; the existing importer owns validation and switching. */
export async function importLibraryArchive(source,root,{onProgress=()=>{},signal,archiveLimits=limits,platform=process.platform}={}){
  const info=await lstat(source);
  if(!info.isFile()||info.isSymbolicLink()||!source.toLowerCase().endsWith('.zip'))throw Error('请选择普通 ZIP 题库文件');
  const temporary=path.join(root,'.dataset-zip-'+randomUUID());
  let zip;
  try{
    await mkdir(temporary,{recursive:true,mode:0o700});
    zip=await yauzl.openPromise(source,{strictFileNames:true,validateEntrySizes:true});
    const names=new LibraryPaths({platform});let bytes=0,files=0;
    if(zip.entryCount>archiveLimits.files*2)throw Error('ZIP 条目数量超过导入限制');
    for await(const entry of zip.eachEntry()){
      signal?.throwIfAborted();
      const {name,directory}=entryPath(entry);names.add(name,{directory});
      const destination=path.join(temporary,name);
      if(directory){await mkdir(destination,{recursive:true,mode:0o700});continue;}
      bytes+=entry.uncompressedSize;files++;
      if(bytes>archiveLimits.bytes||files>archiveLimits.files)throw Error('题库超过导入限制（4 GB / 100000 个文件）');
      await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
      const output=await open(destination,'wx',0o600);let stream;
      let written=0,checksum=0;
      try{
        stream=await zip.openReadStreamPromise(entry);
        for await(const chunk of stream){
          signal?.throwIfAborted();written+=chunk.length;
          if(written>entry.uncompressedSize)throw Error('ZIP 解压大小与清单不一致');
          checksum=crc32(chunk,checksum);await output.writeFile(chunk);
        }
        if(written!==entry.uncompressedSize||checksum!==entry.crc32)throw Error('ZIP 文件完整性校验失败');
      }finally{stream?.destroy();await output.close();}
      onProgress({phase:'EXTRACTING',completed:files});
    }
    signal?.throwIfAborted();
    let library=temporary;
    // Accept catalog.md at the root or one enclosing directory, as common ZIP tools produce.
    const entries=(await readdir(temporary,{withFileTypes:true})).filter(entry=>entry.name!=='__MACOSX'&&entry.name!=='.DS_Store');
    if(!entries.some(entry=>entry.name==='catalog.md'&&entry.isFile())){
      if(entries.length!==1||!entries[0].isDirectory())throw Error('ZIP 根目录或单层文件夹中必须包含 catalog.md');
      library=path.join(temporary,entries[0].name);
    }else{
      for(const name of ['__MACOSX','.DS_Store'])await rm(path.join(temporary,name),{recursive:true,force:true});
    }
    return await importLibrary(library,root,{onProgress,signal,platform});
  }finally{zip?.close();await rm(temporary,{recursive:true,force:true});}
}
