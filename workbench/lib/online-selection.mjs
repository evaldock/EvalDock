import path from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {loadDatasetDescriptionCatalog} from '../../dist/src/datasets/catalog.js';
import {currentQuestionCases} from '../../dist/src/datasets/loader.js';
import {createDefaultDatasetMatcher} from '../../dist/src/planning/planner.js';
import {loadModelEnvironment} from '../../dist/src/platform/model-environment.js';
import {parseEvaluationConfig} from '../../dist/src/app/evaluation-config.js';

/** Match public directory metadata, then install only the Cases needed by the recommendation. */
export class OnlineSelection {
  constructor({root,library,inspectTarget,matcherFactory=createDefaultDatasetMatcher}){
    Object.assign(this,{root,library,inspectTarget,matcherFactory});
    this.value={state:'IDLE',phase:null,selectedDatasets:[],preparedCases:0,error:null};
  }
  status(){return {...this.value};}
  get busy(){return !!this.pending;}
  start(input){
    if(this.pending||this.library.pending||this.library.catalog.busy)throw Error('请等待当前题库准备结束后自动匹配');
    if(!input||Object.keys(input).some(key=>!['agentKind','targetId','evaluationConfig'].includes(key))||!['dsh','workbuddy','pi','hermes','openclaw','langgraph','qwenwork','doubaowork'].includes(input.agentKind)||typeof input.targetId!=='string')throw Error('请选择可评测的 Agent');
    const config=parseEvaluationConfig(input.evaluationConfig);
    if(!['STANDARD','COUNT'].includes(config.selection.kind))throw Error('线上匹配仅支持自动选题');
    const controller=new AbortController();this.controller=controller;
    this.value={state:'PREPARING',phase:'CATALOG',id:randomUUID(),agentKind:input.agentKind,targetId:input.targetId,selectedDatasets:[],preparedCases:0,error:null};
    this.pending=this.prepare(input,config,controller.signal).catch(error=>{
      this.value={...this.value,state:controller.signal.aborted?'CANCELLED':'FAILED',error:controller.signal.aborted?null:/^(题|本地|所选|请|无法|这个|没有)/.test(error.message)?error.message:'线上选题失败，请检查 Agent、模型配置或网络后重试。'};
    }).finally(()=>{this.pending=null;this.controller=null;});
    return this.status();
  }
  async cancel(){this.controller?.abort();await this.library.catalog.cancel();await this.pending;return this.status();}
  async prepare(input,config,signal){
    if(!await this.library.canInstall())throw Error('请等待评测或其他操作结束后自动匹配');
    const agentStaticInfo=await this.inspectTarget(input);
    signal.throwIfAborted();
    const catalog=this.library.catalog;
    catalog.load();await catalog.indexPending;signal.throwIfAborted();
    if(catalog.status().state!=='READY')throw Error(catalog.status().error??'无法读取线上目录');
    const datasetsRoot=path.join(this.root,'datasets');
    const local=[];
    for(const item of await loadDatasetDescriptionCatalog(path.join(datasetsRoot,'catalog.md'),{allowEmpty:true})){
      const files=await currentQuestionCases(datasetsRoot,item.datasetId);
      if(files.length)local.push({...item,availableCaseCount:files.length});
    }
    const candidates=[...local],remote=new Map();
    for(const group of catalog.groups.values()){
      if(!group.rows.length)continue;
      const known=local.find(item=>item.datasetId===group.id||item.datasetId.replace(/^dataset\.(?:harbor-)?/,'').replace(/\/v[1-9][0-9]*$/,'').toLowerCase()===group.name.toLowerCase());
      // An imported library with a legacy ID remains authoritative; do not replace it.
      if(known&&known.datasetId!==group.id)continue;
      const candidate={datasetId:group.id,name:group.name,description:'BenchDock 公开任务。文件交付与过程证据可采集；私有评分参考独立提供。运行条件：'+[...new Set(group.rows.map(row=>row.environment_status))].join('、')+'。外部服务、账号与工具需按题目要求另行准备。',labelIds:[...group.labels].sort().map(label=>'label.'+label+'/v1'),availableCaseCount:group.rows.length};
      const index=candidates.findIndex(item=>item.datasetId===group.id);
      if(index<0)candidates.push(candidate);else candidates[index]={...known,availableCaseCount:Math.max(known.availableCaseCount,group.rows.length)};
      remote.set(group.id,group);
    }
    if(!candidates.length)throw Error('没有可匹配的公开题目或本地题库');
    const env={...process.env};await loadModelEnvironment(env);
    env.EVALDOCK_PLANNER_PROMPT_ROOT=path.join(this.root,'planning/prompts');
    env.EVALDOCK_PLANNER_POLICY_FILE=path.join(this.root,'planning/policies.json');
    this.value.phase='MATCHING';
    const plan=await this.matcherFactory(env,this.root).select({profile:'STANDARD',signal,agentStaticInfo,availableDatasets:candidates,...config.selection.kind==='COUNT'?{testSize:{caseCount:config.selection.caseCount,...config.selection.datasetCount?{datasetCount:config.selection.datasetCount}:{}}}:{}});
    const seen=new Set();
    if(!plan.selectedDatasets?.length)throw Error('所选测试集为空');
    for(const selected of plan.selectedDatasets){
      const candidate=candidates.find(item=>item.datasetId===selected.datasetId);
      if(!candidate||seen.has(selected.datasetId)||!Number.isSafeInteger(selected.caseCount)||selected.caseCount<1||selected.caseCount>candidate.availableCaseCount)throw Error('所选测试集或题量无效');
      seen.add(selected.datasetId);
    }
    this.value={...this.value,phase:'DOWNLOADING',model:plan.model,selectedDatasets:plan.selectedDatasets.map(item=>({id:item.datasetId,name:candidates.find(candidate=>candidate.datasetId===item.datasetId).name,caseCount:item.caseCount,reason:item.reason}))};
    const requiredDownloads=[];
    for(const selected of plan.selectedDatasets){
      signal.throwIfAborted();
      const group=remote.get(selected.datasetId),known=local.find(item=>item.datasetId===selected.datasetId);
      const needed=selected.caseCount-(known?.availableCaseCount??0);
      if(needed<=0||!group)continue;
      const ids=new Set(known?await Promise.all((await currentQuestionCases(datasetsRoot,group.id)).map(async file=>JSON.parse(await readFile(file,'utf8')).id)):[]);
      const taskIds=group.rows.filter(row=>!ids.has(row.task_id)).slice(0,needed).map(row=>row.task_id);
      if(taskIds.length!==needed)throw Error('所选公开题目不足，请重新匹配');
      requiredDownloads.push({group,taskIds});
    }
    const requiredFiles=new Set();
    for(const {group,taskIds} of requiredDownloads){
      requiredFiles.add('LICENSE');requiredFiles.add('NOTICE.md');
      for(const row of group.rows.filter(row=>taskIds.includes(row.task_id))){for(const input of row.inputs)requiredFiles.add(input.path);for(const file of row.license_files)requiredFiles.add(file);}
    }
    if([...requiredFiles].reduce((sum,name)=>sum+(catalog.manifest.get(name)?.bytes??2*1024**3),0)>2*1024**3)throw Error('所选题目超过 2 GB 下载限制，请减少题量或导入已有题库');
    for(const {group,taskIds} of requiredDownloads){
      signal.throwIfAborted();
      catalog.startDownload(group.id,{taskIds,allowExisting:true});
      const abort=()=>{if(!catalog.installing)catalog.controller?.abort();};
      signal.addEventListener('abort',abort,{once:true});
      try{if(signal.aborted)abort();await catalog.pending;}finally{signal.removeEventListener('abort',abort);}
      signal.throwIfAborted();
      if(catalog.downloadStatus().state!=='READY')throw Error(catalog.downloadStatus().error??'无法准备所选题目');
      this.value.preparedCases+=taskIds.length;
    }
    signal.throwIfAborted();
    if(!await this.library.canInstall())throw Error('请等待当前评测结束后继续');
    await this.inspectTarget(input); // A prepared directory does not establish current Agent readiness.
    this.library.value={...this.library.value,automatic:false,state:'LOCAL',error:null};
    this.value={...this.value,state:'READY',phase:'COMPLETE'};
    const directory=path.join(this.root,'var/online-selection');await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(path.join(directory,this.value.id+'.json'),JSON.stringify({schema:'evaldock.online-selection/v1',createdAt:new Date().toISOString(),revision:catalog.profile.revision,evaluationConfig:config,...this.value},null,2)+'\n',{mode:0o600});
  }
}
