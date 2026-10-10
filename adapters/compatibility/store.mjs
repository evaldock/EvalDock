import {mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {hash} from './identity.mjs';
export const dataRoot=root=>path.join(root,'var/compatibility');
export async function atomic(file,value){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,file);}
export async function readJSON(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
// Machine-wide across worktrees, keyed by the actual desktop application / configured target.
export function leaseKey(adapter){if(adapter.kind.startsWith('dsh-'))return hash({kind:adapter.kind,endpoint:adapter.configuration.webEndpoint,home:adapter.configuration.dshHome,profile:adapter.configuration.profile});return ['qwenwork','doubaowork','workbuddy'].includes(adapter.kind)?adapter.kind:hash({kind:adapter.kind,configuration:Object.keys(adapter.configuration??{}).length?adapter.configuration:adapter.targetId});}
const machineRoot=()=>path.join(os.tmpdir(),'evaldock-compatibility-'+(process.getuid?.()??'user'));
export const machineBlock=adapter=>path.join(machineRoot(),'blocked',leaseKey(adapter)+'.json');
export async function acquire(adapter){
  if(await readJSON(machineBlock(adapter)))throw Error('AGENT_CLEANUP_REVIEW_REQUIRED');
  const dir=path.join(machineRoot(),leaseKey(adapter));
  await mkdir(path.dirname(dir),{recursive:true,mode:0o700});
  try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('AGENT_COMPATIBILITY_BUSY_OR_INTERRUPTED');throw e;}
  await atomic(path.join(dir,'owner.json'),{pid:process.pid,targetId:adapter.targetId,startedAt:new Date().toISOString()});
  // Interrupted owners deliberately require inspection: never steal a possibly live Agent session.
  return async()=>rm(dir,{recursive:true,force:true});
}
export async function quarantine(root,adapter,reason){const record={targetId:adapter.targetId,reason,at:new Date().toISOString()};await atomic(path.join(dataRoot(root),'blocked',hash(adapter.targetId)+'.json'),record);await atomic(machineBlock(adapter),record);}
export async function invalidate(root,adapter){await rm(path.join(dataRoot(root),'receipts',hash(adapter.targetId)+'.json'),{force:true});}
export async function assertNotQuarantined(root,adapter){if(await readJSON(path.join(dataRoot(root),'blocked',hash(adapter.targetId)+'.json')))throw Error('AGENT_CLEANUP_REVIEW_REQUIRED');}
