import {projectPaths} from './paths.mjs';
import path from 'node:path';
import {readFile,writeFile,mkdir,rename,stat,realpath,access,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {Jobs} from './jobs.mjs';
import {ControlResults} from './control-results.mjs';
import {ExternalRuns} from './external-runs.mjs';
import {preflightDsh,dshPreflightError} from './dsh-preflight.mjs';
import {mandatoryPlugins,selectedBundles} from './control-model.mjs';
const exec=promisify(execFile);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const atomic=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,file);};
export class DshControl {
  constructor(root){this.root=root;this.stateRoot=path.join(projectPaths(root).workbench,'control');this.busy=null;this.results=new ControlResults(root);this.externalRuns=new ExternalRuns(root,this.results);this.cached=null;this.cacheUntil=0;this.statusPending=null;this.cancellingSessions=new Set();}
  async init(){
    await mkdir(this.stateRoot,{recursive:true,mode:0o700});
    this.descriptor=await json(path.join(this.root,'config/targets/real-dsh.json'));
    const d=this.descriptor,u=new URL(d.webEndpoint);
    if(d.profile!=='web'||u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/'||u.search||u.hash)throw new Error('需要真实的本机 DSH Web 配置');
    this.profilePath=path.join(d.dshHome,'profiles',d.profile,'package.json');
    this.env={...process.env,PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',DSH_HOME:d.dshHome};
    try{Object.assign(this.env,parseEnv(await readFile(path.join(d.dshHome,'.env'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
    const {loadModelEnvironment}=await import(pathToFileURL(path.join(this.root,'dist/src/platform/model-environment.js')));
    await loadModelEnvironment(this.env);
    const {loadDatasetTestPolicy}=await import(pathToFileURL(path.join(this.root,'dist/src/planning/planner.js')));
    this.testPolicy=await loadDatasetTestPolicy(path.join(this.root,'planning/policies.json'),'STANDARD');
    this.collectTools=(await import(pathToFileURL(path.join(this.root,'dist/src/planning/tool-provenance.js')))).collectToolProvenance;
    this.attributeTool=(await import(pathToFileURL(path.join(this.root,'dist/src/reporting/tool-attribution.js')))).toolAttribution;
    this.env.DSH_HOME=d.dshHome;
    this.env.EVALDOCK_PLANNER_TIMEOUT_MS??='240000';
    const runner=path.join(this.root,'dist/src/app/cli.js');
    this.core=await import(pathToFileURL(path.join(this.root,'dist/src/runtime/dsh-control.js')));
    this.jobs=new Jobs({repoRoot:this.root,stateRoot:path.join(this.stateRoot,'jobs'),targets:[],maxConcurrentJobs:1,cliPath:runner,cliPrefix:[runner],nodePath:process.execPath,environment:this.env,secrets:Object.entries(this.env).filter(([k])=>/KEY|TOKEN|SECRET|PASSWORD/.test(k)).map(([,v])=>v)});
    this.jobs.legacyRoots=[path.join(this.root,'workbench/var/control/jobs')];await this.jobs.init();
    ({inspectWebTarget:this.inspect}=await import(pathToFileURL(path.join(this.root,'dist/src/runtime/web-target.js'))));
    // Preserve bundle layer order across disabling/re-enabling and server restarts.
    try{this.order=await json(path.join(this.stateRoot,'plugin-order.json'));}catch(e){if(e.code!=='ENOENT')throw e;try{this.order=await json(path.join(this.root,'workbench/var/control/plugin-order.json'));}catch(old){if(old.code!=='ENOENT')throw old;this.order=[];}}
  }
  async activity(){
    const owned=[...this.jobs.jobs.values()];
    const external=await this.externalRuns.active(this.descriptor);
    const archives=await this.externalRuns.archives();
    return {active:owned.some(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state))||external.length>0,
      revision:hash(JSON.stringify({owned:owned.map(j=>[j.id,j.state,j.endedAt,j.events.at(-1)]),external,archives}))};
  }
  async plugins(){
    const raw=await readFile(this.profilePath,'utf8'),profile=JSON.parse(raw),enabled=profile.dsh.profile.bundles;
    const names=[...new Set([...this.order,...enabled,...Object.keys(profile.dependencies??{})])];
    const catalog=[];
    for(const name of names){
      if(!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))continue;
      let pkg;
      for(const root of [path.dirname(this.profilePath),this.descriptor.sourceRoot]){
        try{pkg=await json(path.join(root,'node_modules',name,'package.json'));break;}catch(e){if(e.code!=='ENOENT')throw e;}
      }
      if(!pkg?.dsh?.bundle&&!enabled.includes(name))continue;
      catalog.push({name,version:pkg?.version??null,description:pkg?.description??'',enabled:enabled.includes(name),required:mandatoryPlugins.includes(name)});
    }
    if(JSON.stringify(names)!==JSON.stringify(this.order)){this.order=names;await atomic(path.join(this.stateRoot,'plugin-order.json'),names);}
    return {catalog,profile,revision:hash(raw+JSON.stringify(catalog.map(p=>[p.name,p.version])))};
  }
  async rpc(method,payload={}){
    const r=await fetch(this.descriptor.webEndpoint+'/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload}),signal:AbortSignal.timeout(8000)});
    const body=await r.json();if(!r.ok||!body.result?.ok)throw new Error('DSH 接口暂不可用');return body.result.value;
  }
  async foreignEval(){
    // Only leases for this actual DSH Profile matter; unrelated VM tasks remain independent.
    const state=await this.core.dshStatus(this.descriptor);
    return state.activeEvaluations>this.jobs.children.size;
  }
  async status(fresh=false){
    if(!fresh&&this.cached&&Date.now()<this.cacheUntil)return {...this.cached,busy:this.busy};
    if(this.statusPending)return this.statusPending;
    this.statusPending=this.readStatus().finally(()=>{this.statusPending=null;});return this.statusPending;
  }
  async currentInspection(configuration,live){
    const key=configuration.agentId;
    if(this.inspectionCache?.key===key&&Date.now()<this.inspectionCache.until)return this.inspectionCache.value;
    const schemas=await this.collectTools(this.descriptor.sourceRoot,path.dirname(this.profilePath),configuration.plugins.map(p=>p.name));
    const toolNames=[...new Set(schemas.map(t=>t.name))];
    const value={source:'CURRENT_CONFIGURATION',agentId:key,observedAt:new Date().toISOString(),
      plugins:configuration.plugins.map(p=>({...p,status:'已配置'})),
      target:{profile:this.descriptor.profile,installRoot:this.descriptor.sourceRoot,dshVersion:live?.dshVersion,
        permissionPreset:live?.permissionPreset,sandboxMode:live?.sandboxMode,recordSource:'当前已应用配置 · 尚非评测结果',
        toolSource:'当前插件包注册声明',toolNames,toolDetails:toolNames.map(name=>({...schemas.find(t=>t.name===name),attribution:this.attributeTool(name,schemas)}))}};
    this.inspectionCache={key,value,until:Date.now()+60000};return value;
  }
  async readStatus(){
    const p=await this.plugins(),configuration=await this.core.dshConfiguration(this.descriptor);let live=null,error=null,runningSessions=null,activeSessions=[],listener=false;
    try{const found=await exec('/usr/sbin/lsof',['-nP','-t','-iTCP:'+new URL(this.descriptor.webEndpoint).port,'-sTCP:LISTEN']);listener=!!found.stdout.trim();}catch(e){if(e.code!==1)error='无法检查 DSH 进程';}
    if(listener){try{live=await this.inspect(this.descriptor);activeSessions=(await this.rpc('session.list')).items.filter(s=>s.running).map(s=>({id:s.sessionId,title:s.projections?.values?.title||'未命名任务',cwd:s.cwd||'',cancelling:this.cancellingSessions.has(s.sessionId)}));runningSessions=activeSessions.length;for(const id of this.cancellingSessions)if(!activeSessions.some(s=>s.id===id))this.cancellingSessions.delete(id);}catch{error='DSH 服务身份或会话状态未确认';}}
    // DSH transport failure must not hide other Agents or archived results.
    // Keep its state unknown so DSH mutations still fail closed in idle().
    let externalEval=null;
    try{externalEval=await this.foreignEval();}
    catch{error??='DSH 评测状态未确认，请检查服务连接或登录状态';}
    let needsRestart=false;
    if(live){const started=Date.parse((await exec('/bin/ps',['-p',String(live.web.pid),'-o','lstart='])).stdout.trim());needsRestart=Number.isFinite(started)&&(await stat(this.profilePath)).mtimeMs>started+1500;}
    const staticInspection=await this.currentInspection(configuration,live);
    const snapshot={staticInspection,evaluationModels:{planner:{model:this.env.EVALDOCK_PLANNER_MODEL??'deepseek-flash',keyConfigured:!!(this.env.EVALDOCK_PLANNER_API_KEY||this.env.DEEPSEEK_API_KEY)},judge:{model:this.env.EVALDOCK_JUDGE_MODEL??'deepseek-flash',keyConfigured:!!(this.env.EVALDOCK_JUDGE_API_KEY||this.env.DEEPSEEK_API_KEY)},separateAgentKey:!!this.env.DEEPSEEK_API_KEY&&this.env.EVALDOCK_PLANNER_API_KEY!==this.env.DEEPSEEK_API_KEY&&this.env.EVALDOCK_JUDGE_API_KEY!==this.env.DEEPSEEK_API_KEY},testPolicy:this.testPolicy,caseConcurrency:3,revision:p.revision+':'+configuration.agentId,plugins:p.catalog,agent:{id:configuration.agentId,plugins:configuration.plugins,profileDigest:configuration.profileDigest},endpoint:this.descriptor.webEndpoint,profile:this.descriptor.profile,home:this.descriptor.dshHome,installRoot:this.descriptor.sourceRoot,
      needsRestart,status:live?'RUNNING':listener?'UNVERIFIED':'STOPPED',pid:live?.web?.pid??null,version:live?.dshVersion??p.catalog.find(p=>p.name===mandatoryPlugins[0])?.version,model:live?.web?.model??null,runningSessions,activeSessions,externalEval,error,busy:this.busy,
      modelReady:!!(this.env.EVALDOCK_PLANNER_API_KEY||this.env.DEEPSEEK_API_KEY)&&!!(this.env.EVALDOCK_JUDGE_API_KEY||this.env.DEEPSEEK_API_KEY),jobs:[...this.jobs.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30).map(j=>({...this.jobs.view(j),events:j.events.slice(-35)}))};
    const owned=[...this.jobs.jobs.values()];
    const external=await this.externalRuns.get(owned,this.descriptor);
    const combined=[...owned,...external].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const visible=[...combined.filter(j=>['STARTING','RUNNING','CANCELLING'].includes(j.state)),...combined.filter(j=>!['STARTING','RUNNING','CANCELLING'].includes(j.state))].slice(0,40);
    snapshot.jobs=visible.map(j=>j.source==='external'?{...j,events:j.events.slice(-35)}:{...this.jobs.view(j),events:j.events.slice(-35)});
    snapshot.runs=await Promise.all(visible.map(j=>this.results.get(j)));
    for(const job of snapshot.jobs){const result=snapshot.runs.find(r=>r.agentId===job.targetId&&r.run.id===job.runId);if(result?.plan.status==='FROZEN')job.scale={datasetCount:result.plan.datasets.length,caseCount:result.run.planned};}
    snapshot.preflight=this.lastPreflight?.revision===snapshot.revision&&JSON.stringify(this.lastPreflight.plugins)===JSON.stringify(p.profile.dsh.profile.bundles)?this.lastPreflight:null;
    this.cached=snapshot;this.cacheUntil=Date.now()+4500;return snapshot;
  }
  async exclusive(label,fn){
    if(this.busy)throw new Error('另一项操作正在进行');this.busy=label;this.cacheUntil=0;
    try{return await fn();}finally{this.busy=null;this.cacheUntil=0;}
  }
  async idle(){
    const s=await this.status(true);
    if(this.jobs.children.size||s.externalEval||s.runningSessions>0)throw new Error('DSH 或 Eval 正在执行任务，请等待结束');
    if(s.status==='UNVERIFIED'||s.error)throw new Error(s.error||'DSH 身份未确认');return s;
  }
  async cancelSession(sessionId){return this.exclusive('CANCELLING_SESSION',async()=>{
    if(typeof sessionId!=='string'||!/^session-[a-zA-Z0-9-]{1,100}$/.test(sessionId))throw new Error('无效的 DSH 会话');
    const state=await this.status(true);
    if(this.jobs.children.size||state.externalEval)throw new Error('Eval 正在运行，请使用“结束本轮测试”');
    if(state.status!=='RUNNING'||state.error)throw new Error('DSH 服务状态未确认，请刷新后重试');
    const session=state.activeSessions.find(s=>s.id===sessionId);
    if(!session)return {sessionId,state:'ENDED'};
    if(!this.cancellingSessions.has(sessionId)){
      await this.rpc('session.cancel',{sessionId});this.cancellingSessions.add(sessionId);
    }
    return {sessionId,state:'CANCELLING'};
  });}
  async checkStartup(input,snapshot,{allowLive=true}={}){
    const s=snapshot??await this.idle(),p=await this.plugins();
    if(input.revision!==s.revision)throw new Error('插件配置已变化，请刷新后重新检查');
    const selected=selectedBundles(input.plugins??p.profile.dsh.profile.bundles,p.catalog),saved=p.profile.dsh.profile.bundles;
    const same=JSON.stringify([...selected].sort())===JSON.stringify([...saved].sort());
    const names=same?[...saved]:selected;
    let check;
    if(allowLive&&same&&s.status==='RUNNING'&&!s.needsRestart){
      await this.inspect(this.descriptor);
      check={schema:'evaldock.dsh-startup-check/v1',revision:s.revision,plugins:names,checkedAt:new Date().toISOString(),scope:'LIVE_SERVICE',status:'PASSED',durationMs:0,issues:[]};
    }else{
      const profile=structuredClone(p.profile);profile.dsh.profile.bundles=names;
      check=await preflightDsh({descriptor:this.descriptor,profile,plugins:p.catalog,revision:s.revision,secrets:Object.entries(this.env).filter(([k])=>/KEY|TOKEN|SECRET|PASSWORD/.test(k)).map(([,v])=>v)});
    }
    const latest=await this.plugins(),configuration=await this.core.dshConfiguration(this.descriptor);
    if(latest.revision+':'+configuration.agentId!==s.revision)throw new Error('检查期间插件配置已变化，请重新检查');
    this.lastPreflight=check;this.cacheUntil=0;return check;
  }
  async preflight(input){return this.exclusive('PREFLIGHT',async()=>this.checkStartup(input,await this.idle()));}
  async requireStartup(input,snapshot,options){const check=await this.checkStartup(input,snapshot,options);if(check.status!=='PASSED')throw dshPreflightError(check);return check;}
  async action(action){return this.exclusive(action,async()=>{
    if(!['start','stop','restart'].includes(action))throw new Error('未知 DSH 操作');
    const s=await this.idle();if(action!=='stop')await this.requireStartup({revision:s.revision},s);return this.core.controlDsh(this.descriptor,action);
  });}
  async apply(input){return this.exclusive('APPLYING',async()=>{
    const s=await this.idle();const p=await this.plugins();
    if(input.revision!==s.revision)throw new Error('插件配置已被其他操作修改，请刷新后重试');
    const names=selectedBundles(input.plugins,p.catalog).filter(n=>!mandatoryPlugins.includes(n));
    await this.requireStartup(input,s);
    return this.core.selectDshPlugins(this.descriptor,names);
  });}
  async run(input){return this.exclusive('STARTING_EVAL',async()=>{
    const s=await this.idle();
    if(s.status!=='RUNNING')throw new Error('请先启动 DSH');
    if(s.needsRestart)throw new Error('插件配置在启动后发生变化，请先重启 DSH');
    if(!s.modelReady)throw new Error('本机 尚未配置 Planner / Judge API Key');
    const p=await this.plugins();if(input.revision!==s.revision)throw new Error('插件配置已变化，请刷新后再开始');
    await this.requireStartup({revision:input.revision},s);
    const configuration=await this.core.dshConfiguration(this.descriptor),agent={id:configuration.agentId,plugins:configuration.plugins,profileDigest:configuration.profileDigest},folder=path.join(this.stateRoot,'requests',randomUUID());
    const target=path.join(folder,'target.json'),config=path.join(folder,'config.json');
    await atomic(target,{...this.descriptor,targetId:agent.id});
    await atomic(config,await json(path.join(this.root,'config/macos-vm.json')));

    await atomic(path.join(folder,'selection.json'),{...agent,testPolicy:this.testPolicy,caseConcurrency:3,profile:this.descriptor.profile,revision:s.revision,createdAt:new Date().toISOString()});
    this.jobs.targets=[{id:agent.id,name:agent.id,descriptor:target,config,fixture:false}];
    this.jobs.environment={...this.env};
    const job=await this.jobs.start({action:'run',targetId:agent.id,...input.evaluationConfig?{evaluationConfig:input.evaluationConfig}:{}});
    const record=this.jobs.get(job.id);record.testPolicy=this.testPolicy;record.pluginSelection=agent.plugins;await this.jobs.persist(record);return this.jobs.view(record);
  });}
}
