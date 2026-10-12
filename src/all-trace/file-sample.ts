/** Stream a regular file once; retain only bounded windows and a digest of the original. */
import {constants} from "node:fs";
import {lstat,open,realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";

export interface FileSample {readonly start:number;readonly end:number;readonly bytes:Buffer;}
export async function sampleFileWithDigest(sourcePath:string,sourceRoot:string,maxBytes:number,sampleBytes:number) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(sampleBytes)||sampleBytes<1||sampleBytes>16384)
    throw new Error("Invalid file preview limit");
  const root=await realpath(sourceRoot),candidate=await realpath(sourcePath),relative=path.relative(root,candidate);
  if(!relative||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error("File preview resolves outside source root");
  const before=await lstat(sourcePath,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink())throw new Error("File preview requires a regular file");
  const handle=await open(sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev||await realpath(sourcePath)!==candidate)
      throw new Error("File changed while opening preview");
    const size=Number(opened.size);
    if(!Number.isSafeInteger(size)||size>maxBytes)throw new Error("FILE_PREVIEW_SIZE_LIMIT");
    const samples:FileSample[]=[...new Set([0,Math.max(0,Math.floor((size-sampleBytes)/2)),Math.max(0,size-sampleBytes)])]
      .map(start=>({start,end:Math.min(size,start+sampleBytes),bytes:Buffer.alloc(Math.min(sampleBytes,size-start))}));
    const buffer=Buffer.allocUnsafe(Math.min(64*1024,Math.max(1,size))),hash=createHash("sha256");
    let offset=0;
    while(offset<size) {
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-offset),offset);
      if(!bytesRead)throw new Error("File changed while reading preview");
      const bytes=buffer.subarray(0,bytesRead);hash.update(bytes);
      for(const sample of samples) {
        const start=Math.max(offset,sample.start),end=Math.min(offset+bytesRead,sample.end);
        if(end>start)sample.bytes.set(bytes.subarray(start-offset,end-offset),start-sample.start);
      }
      offset+=bytesRead;
    }
    const after=await handle.stat({bigint:true});
    if(opened.size!==after.size||opened.mtimeNs!==after.mtimeNs||opened.ctimeNs!==after.ctimeNs||await realpath(sourcePath)!==candidate)
      throw new Error("File changed while reading preview");
    return {source:{byteLength:size,sha256:hash.digest("hex")},samples};
  } finally {await handle.close();}
}
