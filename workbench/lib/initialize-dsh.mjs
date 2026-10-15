import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {DshControl} from './dsh-control.mjs';
import {Jobs} from './jobs.mjs';
import {ControlResults} from './control-results.mjs';
import {projectPaths} from './paths.mjs';

/** A missing/unsupported DSH must not take down settings, other Agents or saved reports. */
export async function initializeDshController(root,{platform=process.platform}={}){
  const control=new DshControl(root);
  if(platform!=='win32'){
    try{
      await control.init();
      const profile=JSON.parse(await readFile(control.profilePath,'utf8'));
      if(!Array.isArray(profile?.dsh?.profile?.bundles))throw Error('DSH profile is unavailable');
      return control;
    }catch{/* Keep a history-only controller below. */}
  }
  const env={...process.env};
  const jobs=control.jobs??new Jobs({repoRoot:root,stateRoot:path.join(projectPaths(root).workbench,'control/jobs'),environment:env,targets:[],maxConcurrentJobs:0});
  let historyError=false;
  jobs.legacyRoots=[path.join(root,'workbench/var/control/jobs')];
  try{await jobs.init();}catch{historyError=true;}
  const results=control.results??new ControlResults(root);
  const reason=platform==='win32'?'DSH 控制器尚未支持 Windows；可使用设置、题库及历史记录。':'DSH 配置不可用；请检查本机配置后重启，其他功能仍可使用。';
  const unavailable=async()=>{throw Error(reason);};
  jobs.start=unavailable;jobs.cancel=unavailable;
  const records=async()=>{
    if(historyError)throw Error('DSH 历史记录无法读取');
    const owned=[...jobs.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,40);
    return {jobs:owned.map(job=>({...jobs.view(job),agentKind:'dsh',events:job.events?.slice(-35)??[]})),runs:await Promise.all(owned.map(job=>results.get(job)))};
  };
  return {env,jobs,results,active:false,busy:null,records,
    status:async()=>({status:'UNAVAILABLE',error:reason,reasonCode:platform==='win32'?'DSH_PLATFORM_UNSUPPORTED':'DSH_INITIALIZATION_FAILED',modelReady:false,plugins:[],activeSessions:[],runningSessions:null,externalEval:null,busy:null,...await records()}),
    activity:async()=>({active:false,revision:createHash('sha256').update(JSON.stringify([...jobs.jobs.values()].map(j=>[j.id,j.state,j.sequence]))).digest('hex')}),
    preflight:unavailable,action:unavailable,apply:unavailable,run:unavailable,cancelSession:unavailable};
}
