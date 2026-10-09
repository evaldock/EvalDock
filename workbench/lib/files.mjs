
import {realpath, stat, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
export class HttpError extends Error {
  constructor(status,code,message=code){super(message);this.status=status;this.code=code;}
}
export function token(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new HttpError(400,'INVALID_ID');
  return value;
}
export async function confined(root,relative) {
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(x=>x==='..'||x==='.')) throw new HttpError(400,'INVALID_PATH');
  const base=await realpath(root), full=await realpath(path.resolve(base,relative));
  if(full!==base&&!full.startsWith(base+path.sep)) throw new HttpError(403,'PATH_ESCAPE');
  return full;
}
export async function readBounded(root,relative,max=64*1024*1024) {
  const full=await confined(root,relative), info=await stat(full);
  if(!info.isFile()) throw new HttpError(404,'FILE_NOT_FOUND');
  if(info.size>max) throw new HttpError(413,'FILE_TOO_LARGE');
  return readFile(full);
}
export async function jsonFile(root,relative){return JSON.parse((await readBounded(root,relative)).toString());}
export async function dirs(root) {
  try{return (await readdir(root,{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).map(x=>x.name).sort();}
  catch(e){if(e.code==='ENOENT')return [];throw e;}
}
