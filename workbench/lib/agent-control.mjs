import path from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {Jobs} from './jobs.mjs';
import {ControlResults} from './control-results.mjs';
import {projectPaths} from './paths.mjs';
import {atomic} from '../../adapters/shared/evaluation.mjs';
import {piConfigurationKey,preflightError} from '../../adapters/pi/preflight.mjs';
import {loadTargets} from '../../adapters/shared/registry.mjs';
import {createAdapter} from '../../adapters/shared/run.mjs';
import {loadModelEnvironment} from '../../dist/src/platform/model-environment.js';

/** Shared controller for configured process/graph Agents. Runtime failures stay local. */
export class AgentControl {
  constructor({root,kind}){this.root=root;this.kind=kind;this.starting=false;this.cacheUntil=0;this.preflights=new Map();}
  async init(){
    const state=path.join(projectPaths(this.root).workbench,this.kind+'-control');
    const config=path.join(state,'config.json');
    await atomic(config,{runRoot:projectPaths(this.root).results});
    this.targets=(await loadTargets(this.root)).filter(t=>t.kind===this.kind);
    const targets=[];
    for(const t of this.targets){
      const descriptor=path.join(state,t.id+'.json');await atomic(descriptor,{agentKind:t.kind,targetId:t.id});
      targets.push({id:t.id,name:t.name,config,descriptor,fixture:false});
    }
    const environment={...process.env,EVALDOCK_AGENT_OWNER_PID:String(process.pid),EVALDOCK_PLANNER_TIMEOUT_MS:'240000'};
    await loadModelEnvironment(environment);
    const script=path.join(this.root,'adapters/shared/run.mjs');
    this.jobs=new Jobs({repoRoot:this.root,stateRoot:path.join(state,'jobs'),targets,maxConcurrentJobs:1,
      cliPath:script,cliPrefix:[script],nodePath:process.execPath,environment,
      secrets:Object.entries(environment).filter(([k])=>/KEY|TOKEN|SECRET|PASSWORD/.test(k)).map(([,v])=>v)});
    this.results=new ControlResults(this.root);await this.jobs.init();
  }
  get active(){return this.starting||!!this.jobs?.children.size;}
  async refreshTargets(){
    if(this.active)throw Error('请等待该 Agent 的评测结束后接入');
    const state=path.join(projectPaths(this.root).workbench,this.kind+'-control');
    const targets=(await loadTargets(this.root)).filter(t=>t.kind===this.kind),jobs=[];
    for(const target of targets){
      const descriptor=path.join(state,target.id+'.json');
      await atomic(descriptor,{agentKind:this.kind,targetId:target.id});
      jobs.push({id:target.id,name:target.name,config:path.join(state,'config.json'),descriptor,fixture:false});
    }
    this.targets=targets;this.jobs.targets=jobs;this.cacheUntil=0;
  }
  async pendingCleanup(){
    const targets=new Set();
    for(const job of this.jobs?.jobs.values()??[]){
      if(['STARTING','RUNNING','CANCELLING'].includes(job.state))continue;
      const base=path.join(projectPaths(this.root).results,'agents',job.targetId,'runs',job.runId,'cases');
      for(const item of await readdir(base,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
        if(!item.isDirectory()||!/^[a-zA-Z0-9._-]+$/.test(item.name))continue;
        let session;
        try{session=JSON.parse(await readFile(path.join(base,item.name,'session.json'),'utf8'));}
        catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(session.runId===job.runId&&session.caseId===item.name&&['PENDING','UNKNOWN'].includes(session.cleanup))targets.add(job.targetId);
      }
    }
    return targets;
  }
  async status(force=false){
    if(!force&&this.cacheUntil>Date.now())return {...this.cached,active:this.active};
    const targets=await Promise.all(this.targets.map(async t=>{
      try{return {id:t.id,...await (await createAdapter(this.root,t.id)).inspect()};}
      catch{return {id:t.id,name:t.name,status:'UNAVAILABLE',evaluationReady:false,reasonCode:'AGENT_INITIALIZATION_FAILED'};}
    }));
    if(this.kind==='pi')for(const target of targets){
      const check=this.preflights.get(target.id);
      if(check?.configurationKey===piConfigurationKey(target)){
        target.preflight=check;
        if(check.status!=='PASSED')Object.assign(target,{status:'STARTUP_FAILED',evaluationReady:false,reasonCode:check.issues[0]?.code??'PI_STARTUP_FAILED'});
      }
    }
    const pending=await this.pendingCleanup();
    for(const target of targets)if(pending.has(target.id))Object.assign(target,{status:'RECOVERY_REQUIRED',evaluationReady:false,reasonCode:'AGENT_CLEANUP_REQUIRED'});
    this.cached={agentKind:this.kind,targets,active:this.active,checkedAt:new Date().toISOString()};
    this.cacheUntil=Date.now()+5000;return this.cached;
  }
  async records(){
    const owned=[...this.jobs.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
    const runs=await Promise.all(owned.map(j=>this.results.get({...j,agentKind:this.kind})));
    return {jobs:owned.map(j=>({...this.jobs.view(j),agentKind:this.kind,targetName:j.targetName??this.targets.find(t=>t.id===j.targetId)?.name,events:j.events.slice(-35)})),runs};
  }
  async run({targetId,smoke=false,datasetCount=1,caseCount=1,datasetIds,evaluationConfig}={}){
    if(this.active)throw Error('该 Agent 已有评测正在执行');
    targetId??=this.targets[0]?.id;
    if(!this.targets.some(t=>t.id===targetId))throw Error('AGENT_TARGET_NOT_FOUND');
    let validation;
    if(smoke){
      if(!Number.isSafeInteger(datasetCount)||datasetCount<1||datasetCount>10||!Number.isSafeInteger(caseCount)||caseCount<datasetCount||caseCount>70)throw Error('AGENT_INVALID_VALIDATION_SIZE');
      if(datasetIds!==undefined&&(!Array.isArray(datasetIds)||datasetIds.length!==datasetCount||new Set(datasetIds).size!==datasetIds.length||datasetIds.some(id=>typeof id!=='string'||!/^dataset\.[a-zA-Z0-9._-]+\/v\d+$/.test(id))))throw Error('AGENT_INVALID_VALIDATION_DATASETS');
      validation={testSize:{datasetCount,caseCount},validationDatasetIds:datasetIds??(datasetCount===1&&caseCount===1?['dataset.memory-accurate-recall/v1']:undefined)};
    }
    this.starting=true;
    try{
      let startup;
      if(this.kind==='pi'){
        startup=await this.preflight({targetId},true);
        if(startup.status!=='PASSED')throw preflightError(startup);
      }
      const status=(await this.status(true)).targets.find(t=>t.id===targetId);
      if(startup&&piConfigurationKey(status??{})!==startup.configurationKey)throw Error('Pi 配置在检查期间发生变化，请重新检查启动。');
      if(!status?.evaluationReady)throw Error(status?.reasonCode??'AGENT_NOT_READY');
      const prefix=this.jobs.cliPrefix;
      let job;
      try{
        this.jobs.cliPrefix=[...prefix,'--target-id',targetId,...validation?['--validation-config',JSON.stringify(validation)]:[],...evaluationConfig?['--evaluation-config',JSON.stringify(evaluationConfig)]:[]];
        job=await this.jobs.start({action:'run',targetId});
      }finally{this.jobs.cliPrefix=prefix;}
      const record=this.jobs.get(job.id);Object.assign(record,{agentKind:this.kind,targetName:this.targets.find(t=>t.id===targetId)?.name,validationOnly:smoke,...validation?{validationConfig:validation}:{},...evaluationConfig?{evaluationConfig}:{}});
      await this.jobs.persist(record);return this.jobs.view(record);
    }finally{this.starting=false;}
  }
  async open({targetId}={}){
    if(this.active)throw Error('AGENT_CONFIGURATION_BUSY');
    targetId??=this.targets[0]?.id;if(!this.targets.some(t=>t.id===targetId))throw Error('AGENT_TARGET_NOT_FOUND');
    const adapter=await createAdapter(this.root,targetId);if(!adapter.launch)throw Error('AGENT_LAUNCH_UNSUPPORTED');
    const result=await adapter.launch();this.cacheUntil=0;return result;
  }
  async preflight({targetId,extensions}={},internal=false){
    if(this.kind!=='pi')throw Error('该 Agent 暂不支持启动预检');
    if(this.active&&!internal)throw Error('评测正在执行，请结束后检查启动配置');
    targetId??=this.targets[0]?.id;
    const target=(await loadTargets(this.root)).find(t=>t.id===targetId&&t.kind==='pi');
    if(!target)throw Error('AGENT_TARGET_NOT_FOUND');
    if(extensions!==undefined&&(!Array.isArray(extensions)||new Set(extensions).size!==extensions.length||extensions.some(name=>!target.extensionCatalog.some(e=>e.name===name))))throw Error('AGENT_INVALID_EXTENSIONS');
    const result=await (await createAdapter(this.root,targetId)).preflight({extensions});
    this.preflights.set(targetId,result);this.cacheUntil=0;return result;
  }
  async extensions({targetId,extensions}){
    if(this.kind!=='pi'||this.active)throw Error('AGENT_CONFIGURATION_BUSY');
    if(!Array.isArray(extensions)||new Set(extensions).size!==extensions.length)throw Error('AGENT_INVALID_EXTENSIONS');
    const file=path.join(this.root,'config/agents.json'),original=await readFile(file,'utf8'),document=JSON.parse(original);
    const target=document.targets.find(t=>t.id===targetId&&t.kind==='pi');
    if(!target||extensions.some(name=>!target.extensionCatalog.some(e=>e.name===name)))throw Error('AGENT_INVALID_EXTENSIONS');
    const check=await this.preflight({targetId,extensions});if(check.status!=='PASSED')throw preflightError(check);
    if(await readFile(file,'utf8')!==original)throw Error('Agent 配置在检查期间发生变化，请刷新后重新应用。');
    target.extensions=extensions;await atomic(file,document);this.cacheUntil=0;return {targetId,extensions};
  }
}

export async function initializeAgentControllers(root){
  const controllers={};
  for(const kind of ['pi','langgraph','qwenwork','doubaowork','hermes','openclaw']){
    const controller=new AgentControl({root,kind});
    try{await controller.init();controllers[kind]=controller;}
    catch{controllers[kind]={active:false,status:async()=>({agentKind:kind,targets:[],status:'UNAVAILABLE',reasonCode:'AGENT_INITIALIZATION_FAILED'}),records:async()=>({jobs:[],runs:[]}),jobs:{shutdown:async()=>{}}};}
  }
  return controllers;
}
