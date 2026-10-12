import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
const exec=promisify(execFile);

/** Custom-scheme renderers cannot identify their .app by URL; bind the listener to it. */
export async function assertDesktopOwner(endpoint,appPath,{execCommand=exec,resolvePath=realpath}={}){
 const url=new URL(endpoint);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('AGENT_INVALID_ENDPOINT');
 const options={timeout:3000,maxBuffer:65536};
 let pids;
 try{const {stdout}=await execCommand('/usr/sbin/lsof',['-nP','-iTCP:'+(url.port||80),'-sTCP:LISTEN','-Fp'],options);pids=[...new Set(stdout.split('\n').filter(s=>/^p[1-9]\d*$/.test(s)).map(s=>s.slice(1)))];}
 catch{throw Error('AGENT_NOT_CONNECTED');}
 if(!pids.length||pids.length>8)throw Error('AGENT_ENDPOINT_OWNER_UNCONFIRMED');
 const app=await resolvePath(appPath);
 for(const pid of pids){
  let executable;
  try{const {stdout}=await execCommand('/bin/ps',['-ww','-p',pid,'-o','comm='],options);executable=await resolvePath(stdout.trim());}
  catch{throw Error('AGENT_ENDPOINT_OWNER_UNCONFIRMED');}
  if(!executable.startsWith(app+'/Contents/'))throw Error('AGENT_ENDPOINT_APP_MISMATCH');
 }
}
