import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,symlink,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
export function dshPreflightError(check){const error=new Error(check.issues.map(i=>i.message).join(' ')||'DSH 启动预检未通过');error.preflight=check;return error;}
export async function preflightDsh({descriptor,profile,plugins,revision,secrets=[],timeoutMs=30000}){
  const started=Date.now(),selected=profile.dsh.profile.bundles;
  const result={schema:'evaldock.dsh-startup-check/v1',revision,plugins:[...selected],checkedAt:new Date().toISOString(),scope:'PLUGIN_LOAD_AND_WEB_STARTUP'};
  const scratch=await mkdtemp(path.join(tmpdir(),'evaldock-dsh-preflight-')),home=path.join(scratch,'.dsh'),folder=path.join(home,'profiles',descriptor.profile),original=path.join(descriptor.dshHome,'profiles',descriptor.profile);
  let child;
  const clean=value=>{let s=String(value).replace(/\x1b\[[0-9;]*m/g,'').replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]');for(const secret of secrets)if(typeof secret==='string'&&secret.length>=8)s=s.split(secret).join('[REDACTED]');return s;};
  try{
    await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'package.json'),JSON.stringify(profile),{mode:0o600});
    for(const name of ['cordis.patch.yml','cordis.yml'])await copyFile(path.join(original,name),path.join(folder,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await copyFile(path.join(descriptor.dshHome,'cordis.patch.yml'),path.join(home,'cordis.patch.yml')).catch(e=>{if(e.code!=='ENOENT')throw e;});
    for(const name of selected){
      let packageRoot;
      for(const base of [original,descriptor.sourceRoot]){try{packageRoot=await realpath(path.join(base,'node_modules',name));break;}catch(e){if(e.code!=='ENOENT')throw e;}}
      if(!packageRoot)return {...result,status:'FAILED',durationMs:Date.now()-started,issues:[{code:'DSH_PLUGIN_MISSING',plugins:[name],message:'插件未安装：'+name}]};
      const link=path.join(folder,'node_modules',name);await mkdir(path.dirname(link),{recursive:true});await symlink(packageRoot,link);
    }
    let output='',diagnostic='',reply,timedOut=false,startFailed=false;
    const decoder=new StringDecoder('utf8');
    const env={PATH:process.env.PATH??'/opt/homebrew/bin:/usr/bin:/bin',HOME:scratch,DSH_HOME:home,DEEPSEEK_API_KEY:'preflight-no-api-call',DSH_TELEMETRY_DISABLED:'1',CI:'1'};
    child=spawn(process.execPath,[fileURLToPath(new URL('./dsh-preflight-worker.mjs',import.meta.url)),descriptor.sourceRoot,descriptor.profile],{cwd:folder,env,detached:true,stdio:['ignore','pipe','pipe']});
    const kill=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
    child.stdout.on('data',chunk=>{
      output+=decoder.write(chunk);if(Buffer.byteLength(output)>131072){output=output.slice(-32768);}
      let end;while((end=output.indexOf('\n'))>=0){const line=output.slice(0,end);output=output.slice(end+1);if(line.startsWith('EVALDOCK_PREFLIGHT '))try{reply=JSON.parse(line.slice(19));}catch{}}
    });
    child.stderr.on('data',chunk=>{if(diagnostic.length<16384)diagnostic+=chunk.toString('utf8').slice(0,16384-diagnostic.length);});
    const code=await new Promise(resolve=>{child.once('error',()=>{startFailed=true;resolve(null);});child.once('close',resolve);});
    clearTimeout(timer);kill();
    const alive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
    for(let i=0;i<30&&alive();i++)await new Promise(resolve=>setTimeout(resolve,50));
    if(reply?.ready&&code===0&&!timedOut&&!alive())return {...result,status:'PASSED',durationMs:Date.now()-started,issues:[]};
    const detail=clean([reply?.error,diagnostic].filter(Boolean).join('\n')).trim(),owners=plugins.filter(p=>selected.includes(p.name)&&detail.includes(p.name)).map(p=>p.name);
    const diagnosticLine=detail.split('\n').find(line=>/fatal load failure|Error:|conflict|duplicate|already (?:registered|exists)/i.test(line));
    const concise=diagnosticLine?((owners.length?owners.join('、')+'：':'')+diagnosticLine.replace(/^dsh: fatal load failure: /,'')):detail;
    const reason=timedOut?'DSH 启动预检超时。':startFailed?'DSH 预检进程无法启动。':alive()?'DSH 预检进程未完成清理。':concise||'DSH 未能正常启动。';
    return {...result,status:'FAILED',durationMs:Date.now()-started,issues:[{code:timedOut?'DSH_PREFLIGHT_TIMEOUT':/conflict|duplicate|already (?:registered|exists)/i.test(detail)?'DSH_PLUGIN_CONFLICT':'DSH_STARTUP_FAILED',plugins:owners,message:reason.slice(0,1800)}]};
  }catch(error){return {...result,status:'FAILED',durationMs:Date.now()-started,issues:[{code:'DSH_PREFLIGHT_FAILED',plugins:[],message:clean(error.message).slice(0,1000)}]};}
  finally{if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}await rm(scratch,{recursive:true,force:true});}
}
