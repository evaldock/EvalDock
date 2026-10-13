import {readFile,writeFile,mkdir,rm,lstat,cp,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {importLibrary,libraryFingerprint} from '../../desktop/workspace.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const records=bytes=>bytes.toString('utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
const deliveryLabels=['artifact-delivery','efficiency-cost','reasoning-planning'];
const datasetId=subset=>'dataset.benchdock-'+sha(Buffer.from(subset)).slice(0,24)+'/v1';
function safePath(name){
  if(typeof name!=='string'||!name||/[\\:\x00-\x1f]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('题库文件路径无效');
  return name;
}
function publicFile(name){
  safePath(name);
  if(name.split('/').includes('private')||!name.startsWith('datasets/')&&!name.startsWith('licenses/')&&!['catalog.jsonl','LICENSE','NOTICE.md'].includes(name))throw Error('题库下载包含非公开运行资源');
  return name;
}
function manifestRecords(bytes){
  const manifest=new Map();
  for(const item of records(bytes)){
    safePath(item.path);
    if(manifest.has(item.path)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>2*1024**3||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('题库校验清单无效');
    manifest.set(item.path,item);
  }
  return manifest;
}
function environment(row,reviewed){
  if(reviewed)return reviewed.environment;
  const dependencies=[];
  if(row.environment_status==='inputs_bundled_python_required')dependencies.push('python3>=3.10');
  if(row.environment_status!=='inputs_bundled_python_required')dependencies.push('按任务要求准备外部依赖、服务或账号');
  return {platform:'portable',timeoutSeconds:1200,allowedEdits:['work/**','output/**'],dependencies};
}

/** A pinned online directory is cached locally; task installation is an explicit action. */
export class BenchDockCatalog {
  constructor({root,profile,fetchImpl,canInstall,onInstalled=()=>{}}){
    Object.assign(this,{root,profile,fetch:fetchImpl,canInstall,onInstalled});
    this.value={state:'IDLE',datasets:[],revision:profile.revision,error:null};
    this.transfer={state:'IDLE',datasetId:null,completedFiles:0,totalFiles:0,downloadedBytes:0,totalBytes:0,error:null};
    this.pending=null;this.indexPending=null;this.controller=null;this.indexController=null;
  }
  status(){return {...this.value};}
  downloadStatus(){return {...this.transfer};}
  get busy(){return !!this.pending;}
  get installing(){return this.transfer.state==='INSTALLING';}
  cacheFile(name){return path.join(this.root,'var/benchdock-cache',this.profile.revision,sha(Buffer.from(name)));}
  async cached(name,expected){
    try{
      const file=this.cacheFile(name),info=await lstat(file);
      if(info.isFile()&&!info.isSymbolicLink()&&info.size===expected.bytes){
        const bytes=await readFile(file);
        if(sha(bytes)===expected.sha256)return bytes;
      }
    }catch(error){if(error.code!=='ENOENT')throw error;}
    return null;
  }
  async saveCache(name,bytes){
    const file=this.cacheFile(name);
    await mkdir(path.dirname(file),{recursive:true,mode:0o700});
    const temporary=file+'.'+randomUUID();
    try{
      await writeFile(temporary,bytes,{mode:0o600});
      await rename(temporary,file);
    }finally{await rm(temporary,{force:true});}
  }
  async fetchBytes(name,limit,signal,onBytes=()=>{}){
    const response=await this.fetch(`https://huggingface.co/datasets/EvalDock/BenchDock/${limit<10*1024*1024?'raw':'resolve'}/${this.profile.revision}/${name.split('/').map(encodeURIComponent).join('/')}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
    if(!response.ok)throw Error('无法下载题库文件，请检查网络或系统代理后重试。');
    const chunks=[];let size=0;
    for await(const chunk of response.body){
      size+=chunk.length;if(size>limit)throw Error('题库文件大小超出校验清单');
      chunks.push(chunk);onBytes(chunk.length);
    }
    return Buffer.concat(chunks);
  }
  async obtain(name,signal,progress=false){
    publicFile(name);
    const expected=this.manifest.get(name);if(!expected)throw Error('题库文件未列入校验清单');
    const startingBytes=this.transfer.downloadedBytes;
    let bytes=await this.cached(name,expected);
    if(bytes&&progress){this.transfer.downloadedBytes+=expected.bytes;this.transfer.cachedBytes+=expected.bytes;}
    if(!bytes){
      for(let attempt=0;attempt<3;attempt++){
        signal.throwIfAborted();
        let received=0;
        try{
          bytes=await this.fetchBytes(name,expected.bytes,signal,n=>{received+=n;if(progress)this.transfer.downloadedBytes=startingBytes+received;});
          if(bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)throw Error('题库文件完整性校验失败');
          await this.saveCache(name,bytes);break;
        }catch(error){if(progress)this.transfer.downloadedBytes=startingBytes;signal.throwIfAborted();if(attempt===2)throw error;}
      }
    }
    if(progress){
      this.transfer.completedFiles++;
      if(this.transfer.completedFiles===this.transfer.totalFiles)this.transfer.phase='ASSEMBLING';
    }
    return bytes;
  }
  acceptCatalog(bytes){
    const groups=new Map(),ids=new Set(),reviewed=new Map(this.profile.tasks.map(task=>[task.task_id,task]));
    for(const row of records(bytes)){
      if(row.schema!=='benchdock.catalog/v1'||typeof row.subset!=='string'||!row.subset.trim()||!/^[A-Za-z0-9._-]+$/.test(row.task_id)||ids.has(row.task_id)||!['bundled','source_reference'].includes(row.distribution))throw Error('题库目录记录无效或重复');
      ids.add(row.task_id);
      const group=groups.get(row.subset)??{id:datasetId(row.subset),name:row.subset,rows:[],files:new Set(['LICENSE','NOTICE.md']),labels:new Set(),sourceOnlyCases:0};
      if(row.distribution==='bundled'){
        if(typeof row.prompt!=='string'||!row.prompt.trim()||typeof row.title!=='string'||!row.title.trim()||!Array.isArray(row.inputs)||!Array.isArray(row.license_files))throw Error('公开题目内容或输入声明无效');
        const destinations=new Set();
        for(const input of row.inputs){
          publicFile(input.path);safePath(input.destination);
          const expected=this.manifest.get(input.path);
          if(!input.path.startsWith('datasets/')||!input.destination.startsWith('input/')||destinations.has(input.destination)||!expected||input.bytes!==expected.bytes||input.sha256!==expected.sha256)throw Error('题目输入与目录校验信息不一致');
          destinations.add(input.destination);group.files.add(input.path);
        }
        for(const file of row.license_files){publicFile(file);if(!file.startsWith('licenses/')||!this.manifest.has(file))throw Error('题目许可证路径无效');group.files.add(file);}
        group.rows.push(row);
        (reviewed.get(row.task_id)?.capabilityLabels??deliveryLabels).forEach(label=>group.labels.add(label));
      }else group.sourceOnlyCases++;
      groups.set(row.subset,group);
    }
    this.groups=groups;this.catalogBytes=bytes;
    this.value={...this.value,state:'READY',error:null,datasets:[...groups.values()].map(group=>({id:group.id,name:group.name,caseCount:group.rows.length+group.sourceOnlyCases,downloadableCases:group.rows.length,sourceOnlyCases:group.sourceOnlyCases,labelIds:[...group.labels].sort().map(label=>'label.'+label+'/v1'),downloadBytes:[...group.files].reduce((sum,file)=>sum+(this.manifest.get(file)?.bytes??0),0)})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))};
  }
  async init(){
    // An immutable, fully verified cache can be browsed without a network request.
    try{
      const file=this.cacheFile('FILES.jsonl'),info=await lstat(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)return;
      const bytes=await readFile(file);if(sha(bytes)!==this.profile.manifest_sha256)return;
      this.manifest=manifestRecords(bytes);
      const expected=this.manifest.get('catalog.jsonl');if(!expected||expected.bytes>16*1024*1024)return;
      const catalog=await this.cached('catalog.jsonl',expected);if(catalog)this.acceptCatalog(catalog);
    }catch(error){if(error.code!=='ENOENT')this.value.error='本地目录缓存校验失败，将重新获取题库目录。';}
  }
  load(){
    if(this.indexPending||this.value.state==='READY')return this.status();
    const controller=new AbortController();this.indexController=controller;
    this.value={...this.value,state:'LOADING',error:null};
    this.indexPending=(async()=>{
      const bytes=await this.fetchBytes('FILES.jsonl',8*1024*1024,controller.signal);
      if(sha(bytes)!==this.profile.manifest_sha256)throw Error('题库版本校验失败，未修改本地题库。');
      this.manifest=manifestRecords(bytes);
      const expected=this.manifest.get('catalog.jsonl');if(!expected||expected.bytes>16*1024*1024)throw Error('题库目录大小无效');
      const catalog=await this.obtain('catalog.jsonl',controller.signal);
      this.acceptCatalog(catalog);await this.saveCache('FILES.jsonl',bytes);
    })().catch(error=>{this.value={...this.value,state:'FAILED',error:controller.signal.aborted?'题库目录加载已取消。':/^(题|公开|本地|无法)/.test(error.message)?error.message:'无法加载线上题库目录，请检查网络或系统代理后重试。'};}).finally(()=>{this.indexPending=null;this.indexController=null;});
    return this.status();
  }
  startDownload(id,{taskIds,allowExisting=false}={}){
    if(this.pending)throw Error('已有题库正在下载，请等待完成或取消后重试。');
    if(this.value.state!=='READY')throw Error('请等待题库目录加载完成后重试。');
    let group=[...this.groups.values()].find(item=>item.id===id);
    if(!group?.rows.length)throw Error('这个测试集仅提供来源信息，请从原始来源获取并导入完整题库。');
    if(taskIds!==undefined){
      if(!Array.isArray(taskIds)||!taskIds.length||new Set(taskIds).size!==taskIds.length||taskIds.some(id=>!group.rows.some(row=>row.task_id===id)))throw Error('所选公开题目不存在或重复');
      const rows=group.rows.filter(row=>taskIds.includes(row.task_id));
      const files=new Set(['LICENSE','NOTICE.md']);
      for(const row of rows){for(const input of row.inputs)files.add(input.path);for(const file of row.license_files)files.add(file);}
      group={...group,policyRows:group.rows,rows,files};
    }
    const totalBytes=[...group.files].reduce((sum,file)=>sum+(this.manifest.get(file)?.bytes??2*1024**3),0);
    if(totalBytes>2*1024**3)throw Error('所选测试集超过 2 GB 下载限制');
    const controller=new AbortController();this.controller=controller;
    this.transfer={state:'DOWNLOADING',phase:'PREPARING',datasetId:id,name:group.name,completedFiles:0,totalFiles:group.files.size,downloadedBytes:0,cachedBytes:0,totalBytes,error:null};
    this.pending=this.install(group,controller.signal,{allowExisting}).catch(error=>{this.transfer={...this.transfer,state:controller.signal.aborted?'CANCELLED':'FAILED',error:controller.signal.aborted?null:/^(题|公开|本地|所选|请|无法|这个)/.test(error.message)?error.message:'无法下载或安装测试集，请检查网络或系统代理后重试。'};}).finally(()=>{this.pending=null;this.controller=null;});
    return this.downloadStatus();
  }
  async cancel(){if(this.controller&&!this.installing)this.controller.abort();await this.pending;return this.downloadStatus();}
  async close(){this.indexController?.abort();await Promise.all([this.cancel(),this.indexPending]);}
  async install(group,signal,{allowExisting=false}={}){
    if(!await this.canInstall())throw Error('请等待评测或导入结束后下载题库。');
    const original=await libraryFingerprint(path.join(this.root,'datasets'));
    const {loadDatasetDescriptionCatalog}=await import('../../dist/src/datasets/catalog.js');
    const {currentQuestionCases}=await import('../../dist/src/datasets/loader.js');
    const descriptions=await loadDatasetDescriptionCatalog(path.join(this.root,'datasets/catalog.md'),{allowEmpty:true});
    const existing=descriptions.find(item=>item.datasetId===group.id||item.datasetId.replace(/^dataset\.(?:harbor-)?/,'').replace(/\/v[1-9][0-9]*$/,'').toLowerCase()===group.name.toLowerCase());
    if(existing&&(!allowExisting||existing.datasetId!==group.id))throw Error('所选测试集已在本地，保留已有题目；请直接选择题目。');
    const installedFiles=existing?await currentQuestionCases(path.join(this.root,'datasets'),group.id):[];
    const installedIds=new Set(await Promise.all(installedFiles.map(async file=>JSON.parse(await readFile(file,'utf8')).id)));
    const rows=group.rows.filter(row=>!installedIds.has(row.task_id));
    if(!rows.length)throw Error('所选题目已在本地，保留已有题目；请直接选择题目。');
    const work=path.join(this.root,'var/benchdock-cache','.download-'+randomUUID());
    const reviewed=new Map(this.profile.tasks.map(task=>[task.task_id,task]));
    const policyBytes=Buffer.from(JSON.stringify({schema:'evaldock.benchdock-delivery/v1',revision:this.profile.revision,subset:group.name,tasks:(group.policyRows??group.rows).map(row=>({task_id:row.task_id,capabilityLabels:reviewed.get(row.task_id)?.capabilityLabels??deliveryLabels,environment:environment(row,reviewed.get(row.task_id))}))}));
    if(existing){
      const slug=group.id.slice('dataset.'.length).replace(/\/v1$/,'');
      if(!(await readFile(path.join(this.root,'datasets',slug,'delivery-profile.json'))).equals(policyBytes))throw Error('本地题库运行配置已变化，保留已有文件；请导入完整题库或重新选择题目。');
    }
    try{
      const slug=group.id.slice('dataset.'.length).replace(/\/v1$/,'');
      if(!existing)try{await lstat(path.join(this.root,'datasets',slug));throw Error('本地题库已包含同名目录，未覆盖你的文件。');}catch(error){if(error.code!=='ENOENT')throw error;}
      await mkdir(work,{recursive:true,mode:0o700});
      await cp(path.join(this.root,'datasets'),work,{recursive:true});
      signal.throwIfAborted();this.transfer.phase='DOWNLOADING';
      const common=new Map();for(const name of ['LICENSE','NOTICE.md'])common.set(name,await this.obtain(name,signal,true));
      const obtained=new Set(common.keys());
      for(const row of rows){
        signal.throwIfAborted();
        const directory=path.join(work,slug,sha(Buffer.from(row.task_id)).slice(0,24));await mkdir(directory,{recursive:true,mode:0o700});
        const inputs=[];
        for(const input of row.inputs){
          const bytes=await this.obtain(input.path,signal,!obtained.has(input.path));obtained.add(input.path);
          const file=path.join(directory,input.destination);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,bytes,{mode:0o600});
          inputs.push({source:input.destination,destination:input.destination,delivery:'workspace',sha256:input.sha256});
        }
        for(const [name,bytes] of common)await writeFile(path.join(directory,name),bytes,{mode:0o600});
        for(const name of row.license_files){
          const bytes=await this.obtain(name,signal,!obtained.has(name));obtained.add(name);
          const file=path.join(directory,name);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,bytes,{mode:0o600});
        }
        // The source record comes from the hash-verified catalog; the original text is retained.
        const record=Buffer.from(JSON.stringify(row));
        const question={schema:'evaldock.question/v1',version:this.profile.revision,id:row.task_id,title:row.title,task:{instructions:row.prompt},capabilityLabels:reviewed.get(row.task_id)?.capabilityLabels??deliveryLabels,environment:environment(row,reviewed.get(row.task_id)),inputs,grading:{mode:'unavailable',reason:'PRIVATE_EVALUATOR_NOT_DISTRIBUTED'},benchdock:{repo_id:this.profile.repo_id,revision:this.profile.revision,manifest_sha256:this.profile.manifest_sha256,catalog_sha256:sha(this.catalogBytes),task_id:row.task_id,task_record_sha256:sha(record),profile_sha256:sha(policyBytes)}};
        await writeFile(path.join(directory,'question.json'),JSON.stringify(question,null,2)+'\n',{mode:0o600});
        await writeFile(path.join(directory,'PROVENANCE.json'),record,{mode:0o600});
      }
      const dataset={datasetId:group.id,name:group.name,description:'BenchDock 公开任务。按任务要求准备执行环境；保留文件交付和过程证据，私有评分参考另行提供。',...existing,labelIds:[...new Set([...(existing?.labelIds??[]),...[...group.labels].map(label=>'label.'+label+'/v1')])].sort(),availableCaseCount:installedFiles.length+rows.length};
      const catalog={schema:'evaldock.dataset-planner-catalog/v1',version:this.profile.revision,datasets:[...descriptions.filter(item=>item.datasetId!==group.id),dataset]};
      await writeFile(path.join(work,'catalog.md'),'# 本地题库\n\n```json evaldock-dataset-catalog\n'+JSON.stringify(catalog,null,2)+'\n```\n',{mode:0o600});
      await writeFile(path.join(work,slug,'delivery-profile.json'),policyBytes,{mode:0o600});
      signal.throwIfAborted();
      if(!await this.canInstall())throw Error('请等待评测结束后重试安装题库。');
      this.transfer.state='INSTALLING';this.transfer.phase='CHECKING';
      if(await libraryFingerprint(path.join(this.root,'datasets'))!==original)throw Error('本地题库已变化，未覆盖你的修改；请重新下载。');
      if(!await this.canInstall())throw Error('请等待评测结束后重试安装题库。');
      await importLibrary(work,this.root,{onProgress:({phase,...installation})=>{this.transfer.phase=phase;this.transfer.installation=installation;}});
      this.transfer={...this.transfer,state:'READY',phase:'COMPLETE',cases:group.rows.length,error:null};this.onInstalled();
    }finally{await rm(work,{recursive:true,force:true});}
  }
}
