import {readFile,writeFile,mkdir,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {ProxyAgent} from 'undici';
import {importLibrary,libraryFingerprint} from './library-workspace.mjs';
import {BenchDockCatalog} from './benchdock-catalog.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const exec=promisify(execFile);
const lines=bytes=>bytes.toString('utf8').split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));
function safePath(name){
  if(typeof name!=='string'||!name||/[\\:\x00-\x1f]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('题库文件路径无效');
  return name;
}

/** Use the user's existing proxy; never change system settings or send model credentials. */
export function publicDatasetFetch(){
  let dispatcher,initialized=false;
  return async(url,options)=>{
    if(!initialized){
      initialized=true;
      let proxy=process.env.HTTPS_PROXY??process.env.https_proxy??process.env.HTTP_PROXY??process.env.http_proxy;
      if(!proxy&&process.platform==='darwin'){
        try{
          const {stdout}=await exec('/usr/sbin/scutil',['--proxy'],{timeout:3000});
          if(/HTTPSEnable\s*:\s*1/.test(stdout)){
            const host=stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1],port=stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
            if(host&&port)proxy=`http://${host}:${port}`;
          }
        }catch{}
      }
      if(proxy)dispatcher=new ProxyAgent(proxy);
    }
    return fetch(url,{...options,...dispatcher?{dispatcher}:{}});
  };
}

/** Download only reviewed public tasks. Installation retains the desktop import transaction. */
export class BenchDockLibrary {
  constructor({root,automatic=false,fetchImpl=publicDatasetFetch(),canInstall=async()=>true}){
    this.root=root;this.fetch=fetchImpl;this.canInstall=canInstall;
    this.value={automatic,state:automatic?'IDLE':'LOCAL',completedFiles:0,totalFiles:0,downloadedBytes:0,cases:0,error:null};
    this.pending=null;this.controller=null;
    this.completed=new Set();
  }
  status(){return {...this.value,...this.catalog?{catalog:this.catalog.status(),download:this.catalog.downloadStatus()}:{},...this.selection?{selection:this.selection.status()}:{}};}
  get installing(){return this.value.state==='INSTALLING'||!!this.catalog?.installing;}
  get busy(){return !!this.pending||!!this.catalog?.busy||!!this.selection?.busy;}
  get ready(){return ['READY','LOCAL'].includes(this.value.state);}
  get canEvaluateLocally(){return this.ready||this.value.state==='IDLE'&&!this.pending&&!this.catalog?.busy&&!this.selection?.busy;}
  async init(){
    this.profileBytes=await readFile(path.join(this.root,'config/benchdock-pilot.json'));
    this.profile=JSON.parse(this.profileBytes);
    const p=this.profile;
    if(p.schema!=='evaldock.benchdock-profile/v1'||p.repo_id!=='EvalDock/BenchDock'||!/^[a-f0-9]{40}$/.test(p.revision)||!/^[a-f0-9]{64}$/.test(p.manifest_sha256)||!Array.isArray(p.tasks)||!p.tasks.length)throw Error('自动题库配置无效');
    const ids=new Set();
    for(const task of p.tasks){
      safePath(task.task_path);
      if(!/^[A-Za-z0-9._-]+$/.test(task.task_id)||ids.has(task.task_id))throw Error('自动题库任务标识无效');
      ids.add(task.task_id);
    }
    this.value.revision=p.revision;this.value.availableCases=p.tasks.length;
    try{
      const receipt=JSON.parse(await readFile(path.join(this.root,'datasets/benchdock-import.json'),'utf8'));
      if(receipt.revision===p.revision&&receipt.profile_sha256===sha(this.profileBytes)){
        this.value.automatic=true;
        const {loadDatasetDescriptionCatalog}=await import('../../dist/src/datasets/catalog.js');
        const {currentQuestionCases,loadDatasetCase}=await import('../../dist/src/datasets/loader.js');
        let cases=0;
        const descriptions=await loadDatasetDescriptionCatalog(path.join(this.root,'datasets/catalog.md'));
        let pilotCases=0;
        for(const d of descriptions){
          const files=await currentQuestionCases(path.join(this.root,'datasets'),d.datasetId);
          for(let i=0;i<files.length;i++)await loadDatasetCase({datasetsRoot:path.join(this.root,'datasets'),datasetId:d.datasetId,labelIds:d.labelIds,caseIndex:i});
          cases+=files.length;
          if(d.datasetId==='dataset.benchdock-public/v1')pilotCases=files.length;
        }
        if(pilotCases!==p.tasks.length)throw Error('自动题库题量与导入记录不一致');
        this.value={...this.value,automatic:descriptions.length===1,state:descriptions.length===1?'READY':'LOCAL',cases};
      }
    }catch(error){
      if(error.code!=='ENOENT')this.value={...this.value,state:'FAILED',error:'本地自动题库校验失败，请重新下载或导入题库。'};
    }
    if(this.value.automatic&&!this.ready)this.originalLibrary=await libraryFingerprint(path.join(this.root,'datasets'));
    this.catalog=new BenchDockCatalog({root:this.root,profile:p,fetchImpl:this.fetch,canInstall:this.canInstall,onInstalled:()=>{this.value={...this.value,automatic:false,state:'LOCAL',error:null};}});
    await this.catalog.init();
    return this.status();
  }
  loadCatalog(){this.catalog.load();return this.status();}
  downloadDataset(id){
    if(this.pending||this.selection?.busy)throw Error('请等待当前题库准备结束后下载。');
    this.catalog.startDownload(id);return this.status();
  }
  async cancelDownload(){await this.catalog.cancel();return this.status();}
  async close(){await this.selection?.cancel();await Promise.all([this.cancel(),this.catalog?.close()]);}
  start(){
    if(this.selection?.busy)throw Error('请等待线上匹配结束后开始自动选题。');
    if(this.catalog?.busy)throw Error('请等待测试集下载结束后开始自动选题。');
    if(this.pending||this.ready)return this.status();
    if(!this.value.automatic)return this.status();
    this.controller=new AbortController();
    this.completed.clear();
    this.value={...this.value,state:'DOWNLOADING',completedFiles:0,totalFiles:0,downloadedBytes:0,error:null};
    this.pending=this.prepare(this.controller.signal).catch(error=>{
      this.value={...this.value,state:this.controller.signal.aborted?'CANCELLED':'FAILED',error:this.controller.signal.aborted?null:/^(题|自动|本地|所选|请|无法)/.test(error.message)?error.message:'无法连接 Hugging Face，请检查网络或系统代理后重试。'};
    }).finally(()=>{this.pending=null;this.controller=null;});
    return this.status();
  }
  async cancel(){if(this.controller&&!this.installing)this.controller.abort();await this.pending;return this.status();}
  complete(name){this.completed.add(name);this.value.completedFiles=this.completed.size;}
  async download(name,expected,signal){
    safePath(name);
    const cache=path.join(this.root,'var/benchdock-cache',this.profile.revision,sha(Buffer.from(name)));
    try{
      const info=await lstat(cache);
      if(info.isFile()&&!info.isSymbolicLink()){
        const bytes=await readFile(cache);
        if(bytes.length===expected.bytes&&sha(bytes)===expected.sha256){this.complete(name);return bytes;}
      }
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const url=`https://huggingface.co/datasets/EvalDock/BenchDock/${expected.bytes<10*1024*1024?'raw':'resolve'}/${this.profile.revision}/${name.split('/').map(encodeURIComponent).join('/')}`;
    let bytes;
    for(let attempt=0;attempt<3;attempt++){
      signal.throwIfAborted();
      try{
        const response=await this.fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
        if(!response.ok)throw Error('Hugging Face 下载返回 HTTP '+response.status);
        const chunks=[];let size=0;
        for await(const chunk of response.body){
          size+=chunk.length;
          if(size>expected.bytes)throw Error('题库文件大小超出校验清单');
          chunks.push(chunk);this.value.downloadedBytes+=chunk.length;
        }
        bytes=Buffer.concat(chunks);
        if(bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)throw Error('题库文件完整性校验失败：'+name);
        break;
      }catch(error){
        signal.throwIfAborted();
        if(attempt===2)throw Error('无法下载或校验题库文件，请检查网络或系统代理后重试：'+name,{cause:error});
      }
    }
    await mkdir(path.dirname(cache),{recursive:true,mode:0o700});
    await writeFile(cache,bytes,{mode:0o600});this.complete(name);return bytes;
  }
  async prepare(signal){
    const p=this.profile,work=path.join(this.root,'var/benchdock-cache','.import-'+randomUUID());
    await mkdir(work,{recursive:true,mode:0o700});
    try{
      // The manifest's size is bounded, and its hash is pinned in the shipped profile.
      const response=await this.fetch(`https://huggingface.co/datasets/EvalDock/BenchDock/raw/${p.revision}/FILES.jsonl`,{signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
      if(!response.ok)throw Error('无法获取 Hugging Face 题库目录，请检查网络或系统代理后重试。');
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw Error('题库校验清单过大');chunks.push(chunk);}
      const manifestBytes=Buffer.concat(chunks);
      if(sha(manifestBytes)!==p.manifest_sha256)throw Error('题库版本校验失败，未修改本地题库。');
      const manifest=new Map();
      for(const item of lines(manifestBytes)){
        safePath(item.path);
        if(manifest.has(item.path)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>2*1024**3||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('题库校验清单无效');
        manifest.set(item.path,item);
      }
      const get=async name=>{
        const expected=manifest.get(safePath(name));if(!expected)throw Error('题库文件未列入校验清单：'+name);
        return this.download(name,expected,signal);
      };
      this.value.totalFiles=1;
      const catalogBytes=await get('catalog.jsonl'),rows=lines(catalogBytes),catalog=new Map(rows.map(r=>[r.task_id,r]));
      if(catalog.size!==rows.length)throw Error('题库目录包含重复任务');
      this.value.catalogRecords=rows.length;
      const selections=[],files=new Set(['catalog.jsonl','LICENSE','NOTICE.md']);
      for(const spec of p.tasks){
        const row=catalog.get(spec.task_id);
        if(!row||row.schema!=='benchdock.catalog/v1'||row.distribution!=='bundled'||typeof row.prompt!=='string')throw Error('所选题目没有可下载的公开任务内容');
        if(!Array.isArray(row.inputs)||!Array.isArray(row.license_files))throw Error('题目输入声明无效');
        for(const input of row.inputs){safePath(input.path);safePath(input.destination);if(!input.destination.startsWith('input/'))throw Error('题目输入必须放在 input 目录');files.add(input.path);}
        for(const file of row.license_files){safePath(file);if(!file.startsWith('licenses/'))throw Error('题目许可证路径无效');files.add(file);}
        files.add(spec.task_path);selections.push({spec,row});
      }
      this.value.totalFiles=files.size;
      const total=[...files].reduce((n,f)=>n+(manifest.get(f)?.bytes??2*1024**3),0);
      if(total>2*1024**3)throw Error('所选题目超过 2 GB 导入限制');
      const common=new Map();for(const name of ['LICENSE','NOTICE.md'])common.set(name,await get(name));
      const allLabels=new Set();
      for(const {spec,row} of selections){
        const taskBytes=await get(spec.task_path);
        if(!isDeepStrictEqual(JSON.parse(taskBytes),row))throw Error('题目内容与目录不一致');
        const labels=spec.capabilityLabels,environment=spec.environment;
        if(!Array.isArray(labels)||!labels.length||new Set(labels).size!==labels.length||labels.some(l=>!/^[a-z][a-z0-9-]*$/.test(l))||!['portable','darwin'].includes(environment?.platform)||!Number.isSafeInteger(environment.timeoutSeconds)||environment.timeoutSeconds<1||environment.timeoutSeconds>86400||!isDeepStrictEqual(environment.allowedEdits,['work/**','output/**'])||!Array.isArray(environment.dependencies))throw Error('题目缺少已核对的运行配置');
        labels.forEach(l=>allLabels.add(l));
        const directory=path.join(work,'benchdock-public',sha(Buffer.from(row.task_id)).slice(0,24));await mkdir(directory,{recursive:true,mode:0o700});
        const inputs=[],destinations=new Set();
        for(const input of row.inputs){
          if(destinations.has(input.destination))throw Error('题目输入路径重复');destinations.add(input.destination);
          const bytes=await get(input.path);
          if(bytes.length!==input.bytes||sha(bytes)!==input.sha256)throw Error('题目输入与目录校验信息不一致');
          const file=path.join(directory,input.destination);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,bytes,{mode:0o600});
          inputs.push({source:input.destination,destination:input.destination,delivery:'workspace',sha256:input.sha256});
        }
        for(const [name,bytes] of common)await writeFile(path.join(directory,name),bytes,{mode:0o600});
        for(const name of row.license_files){const file=path.join(directory,name);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,await get(name),{mode:0o600});}
        const origin={repo_id:p.repo_id,revision:p.revision,manifest_sha256:p.manifest_sha256,catalog_sha256:sha(catalogBytes),task_id:row.task_id,task_record_sha256:sha(taskBytes),profile_sha256:sha(this.profileBytes)};
        const question={schema:'evaldock.question/v1',version:p.revision,id:row.task_id,title:row.title,task:{instructions:row.prompt},capabilityLabels:labels,environment,inputs,grading:{mode:'unavailable',reason:'PRIVATE_EVALUATOR_NOT_DISTRIBUTED'},benchdock:origin};
        await writeFile(path.join(directory,'question.json'),JSON.stringify(question,null,2)+'\n',{mode:0o600});
        await writeFile(path.join(directory,'PROVENANCE.json'),taskBytes,{mode:0o600});
      }
      const description={schema:'evaldock.dataset-planner-catalog/v1',version:p.revision,datasets:[{datasetId:'dataset.benchdock-public/v1',name:'BenchDock 公开试点',description:'已核对运行配置的公开任务，覆盖代码、推理及文件交付；保留执行与轨迹，私有评分材料独立提供。',labelIds:[...allLabels].sort().map(l=>'label.'+l+'/v1'),availableCaseCount:selections.length}]};
      await writeFile(path.join(work,'catalog.md'),'# BenchDock\n\n```json evaldock-dataset-catalog\n'+JSON.stringify(description,null,2)+'\n```\n',{mode:0o600});
      await writeFile(path.join(work,'benchdock-import.json'),JSON.stringify({schema:'evaldock.benchdock-import/v1',repo_id:p.repo_id,revision:p.revision,manifest_sha256:p.manifest_sha256,profile_sha256:sha(this.profileBytes),imported_tasks:p.tasks.map(t=>t.task_id),scoring:'PRIVATE_EVALUATOR_NOT_DISTRIBUTED',environment_execution_verified:false}),{mode:0o600});
      signal.throwIfAborted();
      if(!await this.canInstall())throw Error('请等待评测结束后重试准备题库。');
      this.value.state='INSTALLING';
      if(await libraryFingerprint(path.join(this.root,'datasets'))!==this.originalLibrary)throw Error('本地题库已变化，未覆盖你的修改；请重新打开 App。');
      if(!await this.canInstall())throw Error('请等待评测结束后重试准备题库。');
      const result=await importLibrary(work,this.root);
      this.value={...this.value,state:'READY',cases:result.cases,error:null};
    }finally{await rm(work,{recursive:true,force:true});}
  }
}
