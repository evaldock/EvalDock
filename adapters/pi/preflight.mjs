import path from 'node:path';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {piLaunch} from './launch.mjs';

export function piConfigurationKey(inspection){
  return createHash('sha256').update(JSON.stringify([inspection.version,inspection.installRoot,inspection.permissionPreset??'PI_DEFAULT_TOOLS',(inspection.extensions??[]).filter(e=>e.enabled).map(e=>[e.name,e.version,e.path,e.entries]).sort((a,b)=>a[0].localeCompare(b[0]))])).digest('hex');
}
export function startupIssues(stderr,extensions){
  const owner=value=>extensions.find(e=>value===e.path||value.startsWith(e.path+path.sep))?.name;
  const clean=String(stderr).replace(/\x1b\[[0-9;]*m/g,'').replace(/sk-[a-zA-Z0-9_-]+/g,'[REDACTED]');
  const issues=[];
  for(const line of clean.split('\n')){
    const load=line.match(/Failed to load extension "([^"]+)": (.*)/);
    if(!load)continue;
    const conflict=load[2].match(/(Tool|Flag) "([^"]+)" conflicts with (.+)/);
    const names=[...new Set([owner(load[1]),conflict?owner(conflict[3].trim()):null].filter(Boolean))];
    issues.push(conflict?{code:'PI_EXTENSION_CONFLICT',kind:conflict[1],name:conflict[2],extensions:names,message:(conflict[1]==='Tool'?'工具 ':'参数 ')+conflict[2]+' 被 '+names.join(' 与 ')+' 重复注册。'}:{code:'PI_EXTENSION_LOAD_FAILED',extensions:names,message:(names[0]??'扩展')+' 加载失败：'+load[2].slice(0,300)});
  }
  return issues.slice(0,16);
}
export function preflightError(result){
  const error=new Error(result.issues?.map(i=>i.message).join(' ')||'Pi 启动预检未通过');
  error.preflight=result;return error;
}

// RPC get_state loads the runtime and its extensions without submitting a prompt.
export async function preflightPi(target,inspection,{timeoutMs=15000}={}){
  const started=Date.now(),extensions=(inspection.extensions??[]).filter(e=>e.enabled);
  const base={schema:'evaldock.pi-startup-check/v1',targetId:target.id,configurationKey:piConfigurationKey(inspection),extensions:extensions.map(e=>e.name).sort(),checkedAt:new Date().toISOString(),scope:'EXTENSION_LOAD_AND_RUNTIME_STARTUP'};
  if(!inspection.evaluationReady)return {...base,status:'FAILED',durationMs:0,issues:[{code:inspection.reasonCode??'PI_CONFIGURATION_UNAVAILABLE',extensions:[],message:'Pi 安装或模型配置不完整，无法启动。'}]};
  const home=await mkdtemp(path.join(tmpdir(),'evaldock-pi-preflight-'));
  let child;
  try{
    const cwd=path.join(home,'workspace');await mkdir(cwd);
    const env=Object.fromEntries(['PATH','LANG','TMPDIR','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const launch=await piLaunch(target,inspection,home,{mode:'rpc',env:{...env,DEEPSEEK_API_KEY:'preflight-no-api-call'}});
    let stderr='',buffer='',ready=false,timedOut=false,startFailed=false,overflow=false;
    const decoder=new StringDecoder('utf8');
    child=spawn(launch.command,launch.args,{cwd,env:launch.env,detached:true,stdio:['pipe','pipe','pipe']});
    const kill=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
    child.stdin.on('error',()=>{});
    child.once('spawn',()=>child.stdin.write(JSON.stringify({id:'evaldock-preflight',type:'get_state'})+'\n'));
    child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)<65536)stderr+=chunk.toString('utf8').slice(0,65536-Buffer.byteLength(stderr));});
    child.stdout.on('data',chunk=>{
      buffer+=decoder.write(chunk);
      if(Buffer.byteLength(buffer)>65536){overflow=true;kill();return;}
      let end;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try{const row=JSON.parse(line);if(row.id==='evaldock-preflight'&&row.type==='response'&&row.command==='get_state'){
          ready=row.success===true&&!!row.data?.model;child.stdin.end();
        }}catch{}
      }
    });
    const exitCode=await new Promise(resolve=>{child.once('error',()=>{startFailed=true;resolve(null);});child.once('close',resolve);});
    clearTimeout(timer);kill();
    const alive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
    for(let i=0;i<20&&alive();i++)await new Promise(resolve=>setTimeout(resolve,50));
    const issues=startupIssues(stderr,extensions);
    if(!issues.length&&(!ready||exitCode!==0||timedOut||startFailed||overflow||alive()))issues.push({code:timedOut?'PI_PREFLIGHT_TIMEOUT':startFailed?'PI_PROCESS_START_FAILED':alive()?'PI_PREFLIGHT_CLEANUP_FAILED':'PI_STARTUP_FAILED',extensions:[],message:timedOut?'Pi 启动预检超时。':startFailed?'Pi 进程无法启动。':alive()?'Pi 预检进程未完成清理。':'Pi 未能返回正常就绪状态，请检查运行环境与扩展配置。'});
    return {...base,status:issues.length?'FAILED':'PASSED',durationMs:Date.now()-started,issues};
  }finally{
    if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
    await rm(home,{recursive:true,force:true});
  }
}
