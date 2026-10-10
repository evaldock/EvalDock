import path from 'node:path';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectWorkBuddy,APP} from '../../adapters/workbuddy/status.mjs';
import {Desktop} from '../../adapters/workbuddy/desktop.mjs';
import {atomic} from '../../adapters/workbuddy/run.mjs';
import {Jobs} from './jobs.mjs';
import {ControlResults} from './control-results.mjs';
import {projectPaths} from './paths.mjs';
import {loadModelEnvironment} from '../../dist/src/platform/model-environment.js';
const exec=promisify(execFile);
export class WorkBuddyControl {
  constructor({root=process.cwd(),inspect=inspectWorkBuddy}={}){this.root=root;this.inspect=inspect;this.starting=false;}
  async init(){
    const state=path.join(projectPaths(this.root).workbench,'workbuddy-control');await mkdir(state,{recursive:true,mode:0o700});
    const config=path.join(state,'config.json'),target=path.join(state,'target.json');
    await atomic(config,{runRoot:projectPaths(this.root).results});await atomic(target,{agentKind:'workbuddy',targetId:'workbuddy'});
    const env={...process.env,EVALDOCK_WORKBUDDY_OWNER_PID:String(process.pid)};await loadModelEnvironment(env);
    const script=path.join(this.root,'adapters/workbuddy/run.mjs');
    this.jobs=new Jobs({repoRoot:this.root,stateRoot:path.join(state,'jobs'),targets:[{id:'workbuddy',name:'WorkBuddy',descriptor:target,config,fixture:false}],maxConcurrentJobs:1,cliPath:script,cliPrefix:[script],nodePath:process.execPath,environment:env,secrets:Object.entries(env).filter(([k])=>/KEY|TOKEN|SECRET|PASSWORD/.test(k)).map(([,v])=>v)});
    this.results=new ControlResults(this.root);await this.jobs.init();
  }
  get active(){return this.starting||!!this.jobs?.children.size;}
  async pendingCleanup(){
    const found=[];
    for(const job of this.jobs?.jobs.values()??[]){if(['STARTING','RUNNING','CANCELLING'].includes(job.state))continue;
      const base=path.join(projectPaths(this.root).results,'agents/workbuddy/runs',job.runId,'cases');
      for(const d of await readdir(base,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
        if(!d.isDirectory()||! /^[a-zA-Z0-9._-]+$/.test(d.name))continue;
        const file=path.join(base,d.name,'session.json');let s;try{s=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(s.runId===job.runId&&s.caseId===d.name&&['PENDING','UNKNOWN'].includes(s.cleanup)&&/^[a-zA-Z0-9._-]{1,200}$/.test(s.sessionId))found.push({file,session:s});
      }
    }return found;
  }
  async status(){const value=await this.inspect();const pending=await this.pendingCleanup();if(pending.length){value.status='RECOVERY_REQUIRED';value.evaluationReady=false;value.reasonCode='WORKBUDDY_CLEANUP_REQUIRED';value.pendingCleanup=pending.length;}value.active=this.active;return value;}
  async records(){if(!this.jobs)return {jobs:[],runs:[]};const owned=[...this.jobs.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30);const runs=await Promise.all(owned.map(j=>this.results.get({...j,agentKind:'workbuddy'})));return {jobs:owned.map(j=>{const result=runs.find(r=>r.run.id===j.runId);return {...this.jobs.view(j),agentKind:'workbuddy',scale:{datasetCount:result?.plan.datasets.length||undefined,caseCount:result?.run.planned||undefined},events:j.events.slice(-35)};}),runs};}
  async run({smoke=false,datasetCount=1,caseCount=1,datasetIds,evaluationConfig}={}){
    let validation;
    if(smoke){
      if(!Number.isSafeInteger(datasetCount)||datasetCount<1||datasetCount>10||!Number.isSafeInteger(caseCount)||caseCount<datasetCount||caseCount>70)throw new Error('WORKBUDDY_INVALID_VALIDATION_SIZE');
      if(datasetIds!==undefined&&(!Array.isArray(datasetIds)||datasetIds.length!==datasetCount||new Set(datasetIds).size!==datasetIds.length||datasetIds.some(id=>typeof id!=='string'||!/^dataset\.[a-zA-Z0-9._-]+\/v\d+$/.test(id))))throw new Error('WORKBUDDY_INVALID_VALIDATION_DATASETS');
      validation={testSize:{datasetCount,caseCount},validationDatasetIds:datasetIds??(datasetCount===1&&caseCount===1?['dataset.memory-accurate-recall/v1']:undefined)};
    }
    if(this.active)throw new Error('WorkBuddy 评测正在执行');this.starting=true;
    try{const s=await this.status();if(!s.evaluationReady)throw new Error(s.reasonCode??'WORKBUDDY_NOT_READY');const prefix=this.jobs.cliPrefix;let job;try{this.jobs.cliPrefix=[...prefix,...smoke?['--validation-config',JSON.stringify(validation)]:[],...evaluationConfig?['--evaluation-config',JSON.stringify(evaluationConfig)]:[]];job=await this.jobs.start({action:'run',targetId:'workbuddy'});}finally{this.jobs.cliPrefix=prefix;}const record=this.jobs.get(job.id);record.agentKind='workbuddy';record.validationOnly=smoke;if(validation)record.validationConfig=validation;if(evaluationConfig)record.evaluationConfig=evaluationConfig;await this.jobs.persist(record);return this.jobs.view(record);}finally{this.starting=false;}
  }
  async open(){await exec('/usr/bin/open',['-a',APP,'--args','--remote-debugging-port=18491','--remote-debugging-address=127.0.0.1'],{timeout:5000});return {status:'OPEN_REQUESTED'};}
  async recover(){if(this.active)throw new Error('请先结束当前 WorkBuddy 评测');const pending=await this.pendingCleanup(),desktop=await Desktop.connect();try{for(const {file,session} of pending){await desktop.invoke('session:cancel',session.sessionId);await desktop.invoke('session:destroy',session.sessionId);if(!await desktop.confirmStopped(session.sessionId))throw Error('WORKBUDDY_CLEANUP_UNCONFIRMED');await atomic(file,{...session,cleanup:'STOPPED',recoveredAt:new Date().toISOString()});}}finally{desktop.close();}return {recovered:pending.length};}
}
