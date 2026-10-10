import {readFile,writeFile,rename,mkdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

export const pollInterval = running => running ? 5000 : 30000;
function contentKey(value) {
  const {observedAt,...rest}=value;
  if(rest.live){const {observedAt,...live}=rest.live;rest.live=live;}
  if(rest.liveCases)rest.liveCases=rest.liveCases.map(({observedAt,...live})=>live);
  return JSON.stringify(rest);
}
/** Persist content changes only; liveness is delivered over IPC, not by touching the file. */
export function observationWriter(file) {
  let previous,initialized=false;
  return async value=>{
    if(!initialized){
      try{previous=contentKey(JSON.parse(await readFile(file,'utf8')));}
      catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
      initialized=true;
    }
    const next=contentKey(value);if(next===previous)return false;
    await mkdir(path.dirname(file),{recursive:true});
    await writeFile(file+'.tmp',JSON.stringify(value));await rename(file+'.tmp',file);
    previous=next;return true;
  };
}
/** Keep the inode: daemons may still have it open with O_APPEND. */
export async function trimLog(file,{maxBytes=5*1024*1024,keepBytes=1024*1024}={}) {
  if(!Number.isSafeInteger(maxBytes)||!Number.isSafeInteger(keepBytes)||keepBytes<1||keepBytes>=maxBytes)throw new Error('Invalid log bounds');
  let handle;
  try{
    handle=await open(file,constants.O_RDWR|constants.O_NOFOLLOW);
    const info=await handle.stat();if(!info.isFile()||info.size<=maxBytes)return false;
    const tail=Buffer.alloc(keepBytes);const {bytesRead}=await handle.read(tail,0,tail.length,info.size-keepBytes);
    await handle.truncate(0);await handle.write(tail,0,bytesRead,0);return true;
  }catch(e){if(e.code==='ENOENT')return false;throw e;}
  finally{await handle?.close();}
}
export async function trimLogs(files){for(const file of files)await trimLog(file);}
