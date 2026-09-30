/** Control the actual VM DSH Web profile, never a copied Target. */
import { agentEnvironment } from "../platform/model-environment.js";
import {createHash,randomUUID} from "node:crypto";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile,writeFile,mkdir,rm,readdir,realpath,open} from "node:fs/promises";
import path from "node:path";
import {withContentDigest,type TargetDescriptor} from "../core/models.js";
import {inspectWebTarget,liveIdentity,rpc} from "./web-target.js";
import {resolvePlugins} from "../app/plugins.js";

const exec=promisify(execFile);
const baseBundles=new Set(["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]);
const hash=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const profileDir=(d:TargetDescriptor)=>path.join(d.dshHome,"profiles",d.profile);
const controlDir=(d:TargetDescriptor)=>path.join(d.dshHome,"evaldock-control",d.profile);
async function manifest(d:TargetDescriptor){return JSON.parse(await readFile(path.join(profileDir(d),"package.json"),"utf8"));}
function bundles(m:any):string[]{
  const list=m.dsh?.profile?.bundles;
  if(!Array.isArray(list)||list.some(x=>typeof x!=="string"))throw new Error("DSH_PROFILE_BUNDLES_INVALID");
  return [...new Set(list)] as string[];
}
function validNames(names:readonly string[]):string[]{
  if(!Array.isArray(names)||names.length>100||names.some(n=>typeof n!=="string"||!n.trim()||n.length>256||/[\s\0,]/.test(n)))throw new Error("DSH_PLUGIN_SELECTION_INVALID");
  return [...new Set(names)].sort();
}
export function pluginAgentId(plugins:readonly {name:string;version:string;digest:string}[],profileDigest:string):string{
  return "vm.dsh."+hash({plugins:[...plugins].sort((a,b)=>a.name.localeCompare(b.name)),profileDigest}).slice(0,24);
}
async function packageInfo(d:TargetDescriptor,name:string){
  if(!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))throw new Error("DSH_PLUGIN_NAME_INVALID");
  for(const root of [profileDir(d),d.sourceRoot]){
    try {
      const dir=await realpath(path.join(root,"node_modules",name));
      const bytes=await readFile(path.join(dir,"package.json"));
      const pkg=JSON.parse(bytes.toString());
      let patchDigest="";
      if(typeof pkg.dsh?.bundle?.patch==="string"){
        const patch=await realpath(path.resolve(dir,pkg.dsh.bundle.patch));
        if(!patch.startsWith(dir+path.sep))throw new Error("DSH_PLUGIN_PATCH_ESCAPE");
        patchDigest=createHash("sha256").update(await readFile(patch)).digest("hex");
      }
      return {name,version:String(pkg.version??"unknown"),digest:hash({manifest:bytes.toString(),patchDigest}),bundle:!!pkg.dsh?.bundle};
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  throw new Error("DSH_PLUGIN_NOT_INSTALLED: "+name);
}
export async function dshConfiguration(d:TargetDescriptor){
  if(!d.webEndpoint)throw new Error("DSH_WEB_TARGET_REQUIRED");
  const m=await manifest(d),active=bundles(m);
  const plugins=await Promise.all(active.map(name=>packageInfo(d,name)));
  const patch=await readFile(path.join(profileDir(d),"cordis.patch.yml")).catch(e=>{if(e.code==="ENOENT")return Buffer.alloc(0);throw e;});
  const engine=JSON.parse(await readFile(path.join(d.sourceRoot,"package.json"),"utf8"));
  const profileDigest=hash({engine:engine.version,patch:patch.toString()});
  return {agentId:pluginAgentId(plugins,profileDigest),plugins:plugins.map(p=>({...p,required:baseBundles.has(p.name)})),
    selectedPlugins:active.filter(n=>!baseBundles.has(n)),installedPlugins:Object.keys(m.dependencies??{}).sort(),
    profile:d.profile,dshHome:d.dshHome,endpoint:d.webEndpoint,profileDigest};
}
async function listener(d:TargetDescriptor):Promise<number|undefined>{
  if(!d.webEndpoint)throw new Error("DSH_WEB_TARGET_REQUIRED");
  const u=new URL(d.webEndpoint);
  if(u.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(u.hostname))throw new Error("DSH_LOCAL_ENDPOINT_REQUIRED");
  let output:string;
  try{output=(await exec("/usr/sbin/lsof",["-nP","-t","-iTCP:"+(u.port||"80"),"-sTCP:LISTEN"])).stdout;}
  catch(e){if((e as {code?:number}).code===1)return undefined;throw e;}
  if(!output.trim())return undefined;
  return (await liveIdentity(d)).pid;
}
async function runningSessions(d:TargetDescriptor){
  const result=await rpc(d.webEndpoint!,"session.list",{});
  if(!Array.isArray(result.items))throw new Error("DSH_SESSION_STATE_UNKNOWN");
  return result.items.filter((x:any)=>x.running===true).map((x:any)=>x.sessionId) as string[];
}
export async function dshStatus(d:TargetDescriptor){
  const config=await dshConfiguration(d);
  const pid=await listener(d);
  const activeSessions=pid===undefined?[]:await runningSessions(d);
  return {...config,activeEvaluations:(await leases(d)).length,status:pid===undefined?"STOPPED":activeSessions.length?"BUSY":"RUNNING",pid:pid??null,activeSessions,
    inspection:pid===undefined?null:await inspectWebTarget(d)};
}
/** A short configuration gate plus shared run leases: concurrent Cases are allowed, changing their profile is not. */
async function gate<T>(d:TargetDescriptor,fn:()=>Promise<T>):Promise<T>{
  const root=controlDir(d),lock=path.join(root,"mutation");
  await mkdir(root,{recursive:true,mode:0o700});
  try{await mkdir(lock);}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    const owner=await readFile(path.join(lock,"owner.json"),"utf8").then(JSON.parse).catch(()=>undefined);
    if(owner && Number.isSafeInteger(owner.pid) && owner.pid>0){
      try{process.kill(owner.pid,0);}
      catch(error){
        if((error as NodeJS.ErrnoException).code==="ESRCH"){await rm(lock,{recursive:true,force:true});return gate(d,fn);}
      }
    }
    throw new Error("DSH_CONFIGURATION_BUSY");
  }
  await writeFile(path.join(lock,"owner.json"),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  try{return await fn();}finally{await rm(lock,{recursive:true,force:true});}
}
async function leases(d:TargetDescriptor):Promise<string[]>{
  const root=path.join(controlDir(d),"runs");await mkdir(root,{recursive:true,mode:0o700});
  const live:string[]=[];
  for(const name of await readdir(root)){
    const file=path.join(root,name);const lease=JSON.parse(await readFile(file,"utf8"));
    try{process.kill(lease.pid,0);live.push(file);}
    catch(e){if((e as NodeJS.ErrnoException).code==="ESRCH")await rm(file);else throw e;}
  }
  return live;
}
async function assertIdle(d:TargetDescriptor){
  if((await leases(d)).length)throw new Error("DSH_EVALUATION_ACTIVE");
  if(await listener(d)!==undefined&&(await runningSessions(d)).length)throw new Error("DSH_SESSION_ACTIVE");
}
async function stop(d:TargetDescriptor){
  const pid=await listener(d);if(pid===undefined)return;
  process.kill(pid,"SIGTERM");
  for(let i=0;i<100;i++){try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==="ESRCH")return;throw e;}await delay(200);}
  throw new Error("DSH_STOP_TIMEOUT");
}
async function start(d:TargetDescriptor){
  if(await listener(d)!==undefined)return;
  const root=controlDir(d);await mkdir(root,{recursive:true,mode:0o700});
  const log=await open(path.join(root,"service.log"),"a",0o600);
  const envFile=path.join(d.dshHome,".env");
  const envArgs=await readFile(envFile).then(()=>["--env-file="+envFile]).catch(e=>{if(e.code==="ENOENT")return [];throw e;});
  const child=spawn(process.execPath,[...envArgs,path.resolve(d.sourceRoot,d.dshExecutable),"--profile",d.profile],{
    cwd:profileDir(d),env:{...agentEnvironment(),DSH_HOME:d.dshHome},stdio:["ignore",log.fd,log.fd],detached:true,shell:false});
  let failed=false;child.once("error",()=>{failed=true;});child.unref();await log.close();
  for(let i=0;i<150;i++){
    if(failed||child.exitCode!==null)throw new Error("DSH_START_FAILED: inspect service.log");
    try{if(await listener(d)!==undefined)return;}catch{/* Profile is still booting; verify identity before accepting. */}
    await delay(200);
  }
  throw new Error("DSH_START_TIMEOUT: inspect service.log");
}
export async function controlDsh(d:TargetDescriptor,action:"start"|"stop"|"restart"){
  if(!["start","stop","restart"].includes(action))throw new Error("DSH_CONTROL_ACTION_INVALID");
  return gate(d,async()=>{await assertIdle(d);if(action!=="start")await stop(d);if(action!=="stop")await start(d);return dshStatus(d);});
}
async function install(d:TargetDescriptor,spec:string){
  const logPath=path.join(controlDir(d),"plugin-install.log");
  const chunks:string[]=[];let size=0,timedOut=false;
  const child=spawn(process.execPath,[path.resolve(d.sourceRoot,d.dshExecutable),"plugin","--profile",d.profile,"add",spec],
    {cwd:profileDir(d),env:{...agentEnvironment(),DSH_HOME:d.dshHome,CI:"1"},detached:true,shell:false,stdio:["ignore","pipe","pipe"]});
  const capture=(chunk:Buffer)=>{if(size<2*1024*1024){chunks.push(chunk.toString());size+=chunk.length;}};
  child.stdout.on("data",capture);child.stderr.on("data",capture);
  const killGroup=(signal:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}};
  let force:NodeJS.Timeout|undefined;
  const timer=setTimeout(()=>{timedOut=true;killGroup("SIGTERM");force=setTimeout(()=>killGroup("SIGKILL"),5000);},300000);
  const result=await new Promise<number|null>(resolve=>{child.once("error",()=>resolve(null));child.once("close",code=>resolve(code));});
  clearTimeout(timer);if(force)clearTimeout(force);
  let text=chunks.join("");
  for(const [key,value] of Object.entries(process.env))if(/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&value&&value.length>=6)text=text.split(value).join("[REDACTED]");
  await writeFile(logPath,text,{mode:0o600});
  if(result!==0||timedOut)throw new Error("DSH_PLUGIN_INSTALL_FAILED: "+spec+" (see plugin-install.log)");
}
/** Exact active optional plugin set. Installed but disabled packages remain available for later switching. */
async function apply(d:TargetDescriptor,names:readonly string[]){
  const wanted=validNames(names),before=await manifest(d);
  const active=bundles(before).filter(n=>!baseBundles.has(n)).sort();
  if(JSON.stringify(active)===JSON.stringify(wanted))return;
  await assertIdle(d);
  const available=new Set(Object.keys(before.dependencies??{}));
  const requested:{input:string;spec:string}[]=[];
  for(const name of wanted){
    if(baseBundles.has(name))continue;
    if(available.has(name))requested.push({input:name,spec:name});
    else{
      const selection=await resolvePlugins([name]);
      const plugin=selection.plugins[0];if(!plugin)throw new Error("DSH_PLUGIN_UNRESOLVED");
      let spec=plugin.packageName;
      if(spec.startsWith("github:") && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(plugin.name)){
        // Prefer a published release only when npm declares the exact catalog repository and a DSH bundle.
        try{
          const response=await fetch("https://registry.npmjs.org/"+encodeURIComponent(plugin.name)+"/latest",{signal:AbortSignal.timeout(10000)});
          if(response.ok){
            const pkg=await response.json() as {name?:string;version?:string;repository?:{url?:string}|string;dsh?:{bundle?:unknown}};
            const repository=typeof pkg.repository==="string"?pkg.repository:pkg.repository?.url??"";
            const repo=repository.replace(/^git\+/,"").replace(/\.git$/,"").replace(/^https?:\/\/github.com\//,"").toLowerCase();
            if(pkg.name===plugin.name && repo===plugin.fullName.toLowerCase() && pkg.dsh?.bundle && /^[0-9][a-z0-9.+-]*$/i.test(pkg.version??""))spec=pkg.name+"@"+pkg.version;
          }
        }catch{/* Catalog's original install target remains the fallback. */}
      }
      requested.push({input:name,spec});
    }
  }
  const backup=new Map<string,Buffer|undefined>();
  for(const f of ["package.json","pnpm-lock.yaml","pnpm-workspace.yaml"])
    backup.set(f,await readFile(path.join(profileDir(d),f)).catch(e=>{if(e.code==="ENOENT")return undefined;throw e;}));
  const wasRunning=await listener(d)!==undefined;
  if(wasRunning)await stop(d);
  try{
    const selected:string[]=[];
    for(const item of requested){
      if(available.has(item.input)){selected.push(item.input);continue;}
      const prior=await manifest(d);
      await install(d,item.spec);
      const after=await manifest(d);
      const added=Object.keys(after.dependencies??{}).filter(n=>!Object.hasOwn(prior.dependencies??{},n));
      const named=item.spec.replace(/@[^@/]+$/,"");
      const actual=added.length===1?added[0]:Object.hasOwn(after.dependencies??{},named)?named:undefined;
      if(!actual||(await packageInfo(d,actual)).bundle!==true)throw new Error("DSH_PLUGIN_NOT_A_BUNDLE: "+item.input);
      selected.push(actual);
    }
    const next=await manifest(d);
    next.dsh.profile.bundles=[...bundles(before).filter(n=>baseBundles.has(n)),...new Set(selected.sort())];
    await writeFile(path.join(profileDir(d),"package.json"),JSON.stringify(next,null,2)+"\n");
    await dshConfiguration(d);
    if(wasRunning)await start(d);
  }catch(error){
    if(wasRunning)await stop(d).catch(()=>{});
    // Keep downloaded packages cached, restore the previous active profile and lock metadata.
    for(const [f,bytes] of backup){const p=path.join(profileDir(d),f);if(bytes)await writeFile(p,bytes);else await rm(p,{force:true});}
    if(wasRunning){try{await start(d);}catch(recovery){throw new AggregateError([error,recovery],"DSH_PLUGIN_ROLLBACK_RESTART_FAILED");}}
    throw error;
  }
}
export async function selectDshPlugins(d:TargetDescriptor,names:readonly string[]){
  return gate(d,async()=>{await apply(d,names);return dshStatus(d);});
}
/** Reserve the actual plugin identity across inspect/Planner/Case/Judge, while allowing another run of that identity. */
export async function prepareRealDshTarget(d:TargetDescriptor,names?:readonly string[]){
  return gate(d,async()=>{
    if(names!==undefined)await apply(d,names);
    await start(d);
    const config=await dshConfiguration(d);
    if(names===undefined && String(d.targetId).startsWith("vm.dsh.") && d.targetId!==config.agentId)throw new Error("DSH_AGENT_CONFIGURATION_CHANGED");
    const root=path.join(controlDir(d),"runs");await mkdir(root,{recursive:true,mode:0o700});
    const file=path.join(root,randomUUID()+".json");
    await writeFile(file,JSON.stringify({pid:process.pid,agentId:config.agentId}),{flag:"wx",mode:0o600});
    const {contentDigest:_digest,...rest}=d;
    return {descriptor:withContentDigest({...rest,targetId:config.agentId}) as TargetDescriptor,
      configuration:config,cleanup:async()=>{await rm(file,{force:true});}};
  });
}
