import {realpath} from 'node:fs/promises';
import {inspectionEnvironment} from './cli-interface.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const applicationProcesses=`ObjC.import('AppKit');var apps=$.NSWorkspace.sharedWorkspace.runningApplications;var result=[];for(var i=0;i<apps.count;i++){var a=apps.objectAtIndex(i);try{var app=ObjC.unwrap(a.bundleURL.path),executable=ObjC.unwrap(a.executableURL.path);if(typeof app==='string'&&typeof executable==='string')result.push({pid:Number(a.processIdentifier),app:app,executable:executable});}catch{}}JSON.stringify(result);`;
const requestApplicationQuit=`ObjC.import('AppKit');function run(argv){var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));if(ObjC.unwrap(a.bundleURL.path)!==argv[1]||ObjC.unwrap(a.executableURL.path)!==argv[2])throw Error('PROCESS_CHANGED');return JSON.stringify({accepted:Boolean(a.terminate)});}`;

/** Request native quit, then stop only verified leftover helpers from that instance. */
export async function stopDesktopInstallation(app,executable,{execCommand,resolvePath=realpath,signalProcess=process.kill.bind(process),pause=sleep,now=Date.now,stopTimeoutMs=30000}={}){
 const canonicalApp=await resolvePath(app),canonicalExecutable=await resolvePath(executable);
 if(!canonicalExecutable.startsWith(canonicalApp+'/Contents/'))throw Error('AGENT_APP_ID_MISMATCH');
 const processes=async()=>{
  let stdout;try{({stdout}=await execCommand('/bin/ps',['-ww','-axo','pid=,ppid=,comm='],{timeout:3000,maxBuffer:1024*1024}));}catch{throw Error('AGENT_LAUNCH_PROCESS_UNAVAILABLE');}
  const rows=stdout.split('\n').flatMap(line=>{const match=line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);return match?[{pid:Number(match[1]),ppid:Number(match[2]),comm:match[3]}]:[];});
  return (await Promise.all(rows.map(async row=>{try{return {...row,executable:await resolvePath(row.comm)};}catch{return null;}}))).filter(Boolean);
 };
 const before=await processes(),candidates=before.filter(p=>p.executable===canonicalExecutable);
 if(!candidates.length)return;
 // Electron's Node workers share the main executable and can survive their parent.
 // AppKit identifies GUI instances; ps still verifies identity and limits descendants.
 let applications;
 try{
  const {stdout}=await execCommand('/usr/bin/osascript',['-l','JavaScript','-e',applicationProcesses],{timeout:3000,maxBuffer:1024*1024});
  applications=JSON.parse(stdout);
  if(!Array.isArray(applications)||applications.some(p=>!Number.isSafeInteger(p.pid)||p.pid<=0||typeof p.app!=='string'||typeof p.executable!=='string'))throw Error();
 }catch{throw Error('AGENT_LAUNCH_PROCESS_UNAVAILABLE');}
 const selected=(await Promise.all(applications.map(async p=>{try{return {...p,app:await resolvePath(p.app),executable:await resolvePath(p.executable)};}catch{return null;}}))).filter(p=>p?.app===canonicalApp);
 if(selected.some(p=>p.executable!==canonicalExecutable))throw Error('AGENT_APP_ID_MISMATCH');
 const roots=selected.map(p=>candidates.find(candidate=>candidate.pid===p.pid));
 if(roots.some(p=>!p))throw Error('AGENT_LAUNCH_PROCESS_UNAVAILABLE');
 if(roots.length>1)throw Error('AGENT_LAUNCH_INSTANCE_AMBIGUOUS');
 if(!roots.length)return;
 const owned=new Map([[roots[0].pid,roots[0].executable]]);
 let changed=true;
 while(changed){changed=false;for(const p of before)if(owned.has(p.ppid)&&!owned.has(p.pid)&&p.executable.startsWith(canonicalApp+'/Contents/')){owned.set(p.pid,p.executable);changed=true;}}
 const terminate=pid=>{try{signalProcess(pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw Error('AGENT_LAUNCH_STOP_FAILED');}};
 // Let the application finish its own shutdown before stopping leftover helpers.
 // Killing a renderer first can leave Electron waiting forever during quit.
 // Qwen asks the user to confirm quit. Bring that selected app's dialog forward.
 await execCommand('/usr/bin/open',['-a',canonicalApp],{timeout:3000,env:inspectionEnvironment()}).catch(()=>{});
 const deadline=now()+stopTimeoutMs;
 // Qwen handles a second SIGTERM as forced exit, even after a cancelled quit.
 // A normal Quit request preserves its own confirmation and cancellation behavior.
 let quit;
 try{
  const {stdout}=await execCommand('/usr/bin/osascript',['-l','JavaScript','-e',requestApplicationQuit,'--',String(roots[0].pid),canonicalApp,canonicalExecutable],{timeout:stopTimeoutMs,maxBuffer:65536,env:inspectionEnvironment()});
  quit=JSON.parse(stdout);if(typeof quit.accepted!=='boolean')throw Error();
 }catch{throw Error('AGENT_LAUNCH_STOP_FAILED');}
 if(!quit.accepted)throw Error('AGENT_LAUNCH_STOP_CANCELLED');
 let rootStopped=false;
 do{
  if(!(await processes()).some(p=>p.pid===roots[0].pid&&p.executable===canonicalExecutable)){rootStopped=true;break;}
  await pause(100);
 }while(now()<deadline);
 if(!rootStopped)throw Error('AGENT_LAUNCH_STOP_TIMEOUT');
 for(const p of await processes())if(p.pid!==roots[0].pid&&owned.get(p.pid)===p.executable)terminate(p.pid);
 do{
  const remaining=(await processes()).filter(p=>owned.get(p.pid)===p.executable);
  if(!remaining.length)return;
  await pause(100);
 }while(now()<deadline);
 throw Error('AGENT_LAUNCH_STOP_TIMEOUT');
}

/** A launch is successful only after inspection confirms transport or a login boundary. */
export async function waitForDesktopConnection(inspect,{pause=sleep,now=Date.now,launchTimeoutMs=15000}={}){
 const deadline=now()+launchTimeoutMs;
 let status;
 do{
  status=await inspect();
  if(status.probeReady||status.status==='LOGIN_REQUIRED'||status.status==='RUNTIME_NOT_READY')return status;
  await pause(250);
 }while(now()<deadline);
 if(status.reasonCode&&!['AGENT_NOT_CONNECTED','AGENT_WINDOW_NOT_READY'].includes(status.reasonCode))throw Error(status.reasonCode);
 throw Error('AGENT_LAUNCH_CONNECTION_TIMEOUT');
}
