import {projectPaths} from './paths.mjs';
import path from 'node:path';
import {readdir,stat,readFile,open} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {recordCaseProgress,runProgress} from './run-progress.mjs';
const exec=promisify(execFile),safe=s=>typeof s==='string'&&/^[a-zA-Z0-9._-]+$/.test(s);
const dirs=async p=>{try{return (await readdir(p,{withFileTypes:true})).filter(d=>d.isDirectory()&&safe(d.name)).map(d=>d.name);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const key=j=>j.targetId+'::'+j.runId;
export class ExternalRuns {
  constructor(root,results){this.root=root;this.results=results;this.archivePaths=[];this.nextScan=0;}
  async archives(){
    if(Date.now()<this.nextScan)return this.archivePaths;
    const found=[],root=path.join(this.results.root,'agents');
    for(const agent of await dirs(root))for(const runId of await dirs(path.join(root,agent,'runs'))){
      try{const m=await stat(path.join(root,agent,'runs',runId,'run.json'));if(m.isFile())found.push({targetId:agent,runId,mtime:m.mtimeMs});}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    this.archivePaths=found.sort((a,b)=>b.mtime-a.mtime).slice(0,40);this.nextScan=Date.now()+15000;return this.archivePaths;
  }
  async active(descriptor){
    const root=path.join(descriptor.dshHome,'evaldock-control',descriptor.profile,'runs'),found=[];
    let files;try{files=await readdir(root,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
    for(const f of files){if(!f.isFile()||!safe(f.name)||!f.name.endsWith('.json'))continue;
      try{
        const lease=JSON.parse(await readFile(path.join(root,f.name),'utf8'));if(!Number.isSafeInteger(lease.pid)||lease.pid<1||!safe(lease.agentId))continue;
        const command=(await exec('/bin/ps',['-p',String(lease.pid),'-o','command='])).stdout;
        if(!/\bdist\/src\/app\/cli\.js\s+run\s/.test(command))continue;
        const runId=command.match(/(?:^|\s)--run-id\s+([a-zA-Z0-9._-]+)(?=\s|$)/)?.[1];if(!runId)continue;
        const count=name=>Number(command.match(new RegExp('(?:^|\\s)--'+name+'\\s+(\\d+)(?=\\s|$)'))?.[1])||undefined;
        found.push({targetId:lease.agentId,runId,active:true,mtime:(await stat(path.join(root,f.name))).mtimeMs,scale:{datasetCount:count('dataset-count'),caseCount:count('case-count')}});
      }catch(e){if(e.code===1||e.code==='ENOENT'||e instanceof SyntaxError)continue;throw e;}
    }return found;
  }
  async get(owned,descriptor){
    const ownedKeys=new Set(owned.map(key)),active=await this.active(descriptor);
    const candidates=new Map((await this.archives()).map(p=>[key(p),p]));for(const p of active)candidates.set(key(p),p);
    const jobs=[];
    for(const p of candidates.values()){
      if(ownedKeys.has(key(p)))continue;
      try{
        const base='agents/'+p.targetId+'/runs/'+p.runId;
        let summary=await this.results.json(base+'/run.json');
        const events=[];const job={id:'external-'+createHash('sha256').update(key(p)).digest('hex').slice(0,24),targetId:p.targetId,runId:p.runId,source:'external',events,
          state:p.active?'RUNNING':summary?.status==='COMPLETED'?'SUCCEEDED':summary?.status==='CANCELLED'?'CANCELLED':'FAILED',
          createdAt:new Date(p.mtime).toISOString(),scale:p.scale??{datasetCount:summary?.selectedDatasets?.length,caseCount:summary?.totalCaseCount}};
        if(p.active){
          // Read only a bounded log tail and retain structured batch progress lines.
          let handle;try{handle=await open(path.join(projectPaths(this.root).logs,p.runId+'.stderr.log'),'r').catch(e=>{if(e.code!=='ENOENT')throw e;return open(path.join(this.root,'var/run-logs',p.runId+'.stderr.log'),'r');});const size=(await handle.stat()).size,buf=Buffer.alloc(Math.min(size,256*1024));await handle.read(buf,0,buf.length,Math.max(0,size-buf.length));
            for(const text of buf.toString().split('\n'))if(/^\[evaldock:batch\] (starting|finished) /.test(text)){events.push({kind:'stderr',text});recordCaseProgress(job,text);}
          }catch(e){if(e.code!=='ENOENT')throw e;}finally{await handle?.close();}
          if(!summary){const caseResults=[],groups=new Map();
            for(const caseId of await dirs(path.join(this.results.root,base,'cases'))){const r=await this.results.json(base+'/cases/'+caseId+'/report.json');if(!r)continue;
              const cp=r.plan?.casePlan,datasetId=cp?.datasetId;
              caseResults.push({caseId,datasetId,status:r.failures?.some(f=>f.severity==='ERROR')?'FAILED':'COMPLETED',scores:r.scores??[],reportHtml:true});
              if(datasetId){const g=groups.get(datasetId)??{datasetId,caseCount:0,evaluationLabelIds:cp.labelIds??[]};g.caseCount++;groups.set(datasetId,g);}
            }
            summary={status:'RUNNING',totalCaseCount:job.scale.caseCount,caseResults,selectedDatasets:[...groups.values()]};
          }
        }
        if(!summary&&!p.active)continue;
        job.agentKind=summary?.agentKind??'dsh';
        job.summary=summary;job.progress=runProgress(job);if(!p.active)job.endedAt=new Date(p.mtime).toISOString();
        jobs.push(job);
      }catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)continue;throw e;}
    }
    return jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
}
