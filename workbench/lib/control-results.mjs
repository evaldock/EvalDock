import {archivedRuntime} from './trace-preview.mjs';
import {runProgress} from './run-progress.mjs';
import {toolAttribution} from '../../dist/src/reporting/tool-attribution.js';
import {projectPaths} from './paths.mjs';
import path from 'node:path';
import {readFile,stat,readdir} from 'node:fs/promises';
import {confined,token} from './files.mjs';
export class ControlResults {
  constructor(root){this.root=projectPaths(root).results;this.labelsRoot=path.join(root,'labels');this.cache=new Map();}
  async labelNames(){
    this.labelCatalog??=readdir(this.labelsRoot).catch(e=>{if(e.code==='ENOENT')return [];throw e;}).then(async files=>{
      const labels=await Promise.all(files.filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(path.join(this.labelsRoot,f),'utf8'))));
      return Object.fromEntries(labels.filter(l=>typeof l.labelId==='string'&&typeof l.scoringStandard?.label==='string').map(l=>[l.labelId,l.scoringStandard.label]));
    });
    return this.labelCatalog;
  }
  async json(relative){
    let file;
    try{file=await confined(this.root,relative);const s=await stat(file),key=s.mtimeMs+':'+s.size;
      if(this.cache.get(file)?.key===key)return this.cache.get(file).value;
      // Never load an embedded, multi-megabyte all trace on the polling path.
      if(s.size>64*1024*1024)throw new Error('REPORT_SIZE_LIMIT');
      const value=JSON.parse(await readFile(file,'utf8'));this.cache.set(file,{key,value});
      if(this.cache.size>120)this.cache.delete(this.cache.keys().next().value);return value;
    }catch(e){if(e instanceof SyntaxError)return this.cache.get(file)?.value??null;if(e.code==='ENOENT')return null;throw e;}
  }
  async trace(targetId,runId,caseId){
    for(const value of [targetId,runId,caseId])token(value);
    const relative='agents/'+targetId+'/runs/'+runId+'/cases/'+caseId;
    const report=await this.json(relative+'/report.json');
    if(!report)return {traceLoadState:'missing',traceError:'本题报告尚未归档'};
    const value=await archivedRuntime(path.resolve(this.root,'../..'),path.join(this.root,relative),report);
    if(!value.traceDetailPath)return value;
    const cache=path.join(projectPaths(path.resolve(this.root,'../..')).workbench,'cache');
    return {...JSON.parse(await readFile(await confined(cache,value.traceDetailPath),'utf8')),traceLoadState:'available'};
  }
  async get(job){
    token(job.targetId);token(job.runId);
    const base='agents/'+job.targetId+'/runs/'+job.runId;
    const frozenPlan=await this.json(base+'/plan.json');
    const frozenInspection=await this.json(base+'/inspection.json');
    const resultSummary=await this.json(base+'/run.json')??job.summary;
    const summary={...resultSummary,totalCaseCount:resultSummary?.totalCaseCount??frozenPlan?.totalCaseCount,selectedDatasets:resultSummary?.selectedDatasets??frozenPlan?.selectedDatasets};
    // Display metadata only; legacy records without a kind remain DSH records.
    let identity={...frozenInspection?.target,...frozenInspection,...resultSummary?.target,...resultSummary};

    const details={},runtime={},reportPaths=[],selected=summary?.selectedDatasets??[];
    const scoreScale=summary?.scores?.find(s=>s.scale)?.scale??summary?.caseResults?.flatMap(c=>c.scores??[]).find(s=>s.scale)?.scale??{min:0,max:5};
    const run={id:job.runId,labelNames:{...await this.labelNames()},scoreScale,status:['STARTING','RUNNING','CANCELLING'].includes(job.state)?job.state:summary?.status??job.state,planned:job.scale?.caseCount??summary?.totalCaseCount??0,cases:[],dimensions:[],targetSummary:'Profile web',failureCodes:summary?.reasonCodes??[],startedAt:job.startedAt,updatedAt:job.endedAt??job.events.at(-1)?.time,
      target:{profile:'web',recordSource:'本次运行',toolNames:[]},staticPlugins:job.pluginSelection?.map(p=>({...p,function:'',status:'已配置'}))??[]};
    if(frozenInspection){
      const schemas=frozenInspection.toolSchemas??[],toolNames=[...new Set(schemas.filter(t=>typeof t.name==='string'&&t.name!=='UNKNOWN').map(t=>t.name))];
      Object.assign(run.target,{toolNames,toolDetails:toolNames.map(name=>({...schemas.find(t=>t.name===name),attribution:toolAttribution(name,schemas)})),recordSource:'本批次冻结的静态观测',toolSource:'inspection.json'});
      run.staticPlugins=(frozenInspection.pluginCatalog??[]).map(p=>({...p,name:p.packageName??p.id}));
    }
    for(const cr of summary?.caseResults??[]){
      token(cr.caseId);const r=await this.json(base+'/cases/'+cr.caseId+'/report.json');
      const scores=r?.scores??cr.scores??[];
      const scoreEntries=Array.isArray(scores)?scores:[];
      // Historical reports retain the canonical label name frozen with their scoring standard.
      for(const l of r?.labels??[])if(typeof l.labelId==='string'&&typeof l.scoringStandard?.label==='string')run.labelNames[l.labelId]=l.scoringStandard.label;
      const c={id:cr.caseId,title:r?.case?.question?.title??cr.caseId,dataset:cr.datasetId,status:r?.execution?.exitCode===0?'done':cr.status==='COMPLETED'?'done':'error',time:r?.execution?.durationMs!==undefined?(r.execution.durationMs/1000).toFixed(1)+' s':'—',evidence:0,evidenceUnit:'条已加载证据',weight:scoreEntries[0]?.weight??r?.case?.grading?.weight??1,scores:Object.fromEntries(scoreEntries.map(s=>[String(s.labelId),{state:s.status==='ERROR'?'error':typeof s.score==='number'?'scored':'null',value:s.score,reason:s.reason,scale:s.scale,standardDigest:s.labelDigest?.value}])),events:(r?.timeline??[]).map(t=>({text:t.label,detail:t.status})),files:[],file:'',finalAnswer:r?.execution?.stdout??'',answerTruncated:r?.execution?.stdoutTruncated??false};
      run.cases.push(c);
      if(r){
        identity={...identity,...r.target};
        details[c.id]={task:r.execution?.task??r.case?.task,inputs:r.case?.inputs?.map(i=>i.destination)??[],output:r.case?.allowedPaths??[],labels:r.case?.labelIds??[],environment:r.plan?.casePlan?.environmentId,deadline:r.case?.deadlineMs,reference:r.case?.grading?.reference?.rubric,source:'report.json'};
        runtime[job.targetId+'::'+job.runId+'::'+c.id]={execution:r.execution,observers:[],files:[],failures:r.failures??[],reset:r.reset?{...r.reset,environmentState:r.environmentState}:null,allTraceEntryCount:r.allTraceRef?.entryCount??null,traceLoadState:r.allTraceRef?'available':'missing',...(r.allTraceRef?{traceDetailPath:'api/control/trace/'+job.targetId+'/'+job.runId+'/'+c.id}:{})};
        Object.assign(run.target,{dshVersion:r.target?.dshPackageVersion,profile:r.target?.profile,driverStatus:r.inspection?.headlessDriverStatus,permissionPreset:r.inspection?.permissionPreset,sandboxMode:r.inspection?.sandboxMode,recordSource:'report.json',toolNames:[...new Set((r.inspection?.toolSchemas??[]).filter(t=>typeof t.name==='string'&&t.name!=='UNKNOWN').map(t=>t.name))],toolDetails:[...new Set((r.inspection?.toolSchemas??[]).filter(t=>typeof t.name==='string'&&t.name!=='UNKNOWN').map(t=>t.name))].map(name=>({...r.inspection.toolSchemas.find(t=>t.name===name),attribution:toolAttribution(name,r.inspection.toolSchemas)}))});
        run.targetSummary='Profile web / '+(r.target?.dshPackageVersion??'—');
        if(r.inspection?.pluginCatalog)run.staticPlugins=r.inspection.pluginCatalog.map(p=>({...p,name:p.packageName||p.id,version:p.version,function:p.description||'',status:'已声明'}));
      }
      if(cr.reportHtml||r)reportPaths.push('reports/'+job.targetId+'/'+job.runId+'/cases/'+c.id+'/report.html');
    }
    for(const current of (job.progress??runProgress(job)).currentCases??[]) {
      if(!run.cases.some(c=>c.id===current.caseId))run.cases.push({id:current.caseId,ordinal:current.ordinal,title:current.caseId,dataset:'',status:'running',time:'执行中',evidence:0,weight:1,scores:{},events:[],files:[],file:'',finalAnswer:''});
    }
    run.dimensions=[...new Set([...selected.flatMap(d=>d.evaluationLabelIds??[]),...run.cases.flatMap(c=>Object.keys(c.scores))])];
    run.agentKind=job.agentKind??identity.agentKind??'dsh';
    run.agentName=identity.agentName??({workbuddy:'WorkBuddy',pi:'Pi',langgraph:'LangGraph',qwenwork:'千问办公',doubaowork:'豆包办公',hermes:'Hermes',openclaw:'OpenClaw'}[run.agentKind]??'DSH');
    Object.assign(run.target,{agentKind:run.agentKind,agentVersion:identity.agentVersion??identity.version??run.target.dshVersion,installRoot:identity.installRoot});
    if(run.agentKind!=='dsh'){
      delete run.target.dshVersion;delete run.target.profile;delete run.staticPlugins;
      run.components=identity.components??[];
      run.targetSummary=run.agentName+(run.target.agentVersion?' / '+run.target.agentVersion:'');
    }
    try{if((await stat(await confined(this.root,base+'/report.html'))).isFile())reportPaths.push('reports/'+job.targetId+'/'+job.runId+'/report.html');}catch(e){if(e.code!=='ENOENT')throw e;}
    return {source:job.source??'control',agentId:job.targetId,agentKind:run.agentKind,agentName:run.agentName,run,details,runtime,reportPaths,plan:{status:selected.length?'FROZEN':'PENDING',source:(frozenPlan?.model??resultSummary?.datasetMatchModel)==='explicit-all-datasets'?'全测试集计划':'Planner',model:frozenPlan?.model??resultSummary?.datasetMatchModel,createdAt:frozenPlan?.createdAt,datasets:selected.map(d=>({id:d.datasetId,caseCount:d.caseCount,labels:d.evaluationLabelIds,reason:d.reason,capabilities:d.targetCapabilities}))}};
  }
}
