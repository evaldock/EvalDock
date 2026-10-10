import {cp,mkdir,access,readFile,writeFile,readdir,lstat,rename,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const exists=async file=>access(file).then(()=>true,()=>false);
/** Code is refreshed on launch; user configuration, datasets and results are preserved. */
export async function prepareWorkspace(source,root){
  await mkdir(root,{recursive:true,mode:0o700});
  for(const name of ['dist','adapters','workbench','labels','planning','trace','observer-lab','src','desktop','node_modules']){
    await rm(path.join(root,name),{recursive:true,force:true});
    await cp(path.join(source,name),path.join(root,name),{recursive:true});
  }
  await cp(path.join(source,'package.json'),path.join(root,'package.json'));
  for(const name of ['config','datasets','environments'])if(!await exists(path.join(root,name)))await cp(path.join(source,name),path.join(root,name),{recursive:true});
  const file=path.join(root,'config/targets/real-dsh.json');
  const descriptor=JSON.parse(await readFile(file,'utf8'));
  if(descriptor.dshHome==='/Users/your-user/.dsh'){
    descriptor.dshHome=path.join(homedir(),'.dsh');
    await writeFile(file,JSON.stringify(descriptor,null,2)+'\n',{mode:0o600});
  }
  const targets=path.join(root,'config/agents.json');
  if(!await exists(targets))await writeFile(targets,JSON.stringify({schema:'evaldock.agent-targets/v1',targets:[]},null,2)+'\n',{mode:0o600});
}

/** Import a complete library transactionally; retain the previous library for recovery. */
export async function importLibrary(source,root){
  const canonical=await realpath(source),destinationRoot=await realpath(root);
  if(canonical===destinationRoot||destinationRoot.startsWith(canonical+path.sep))throw Error('请选择独立的题库文件夹，不能导入整个工作空间');
  const staging=path.join(root,'.dataset-import-'+randomUUID());
  const digest=createHash('sha256');let bytes=0,files=0;
  async function copy(relative=''){
    const from=path.join(source,relative),to=path.join(staging,relative),info=await lstat(from);
    if(info.isSymbolicLink())throw Error('题库不能包含符号链接');
    if(info.isDirectory()){
      await mkdir(to,{recursive:true,mode:0o700});
      for(const name of (await readdir(from)).sort())await copy(path.join(relative,name));
    }else if(info.isFile()){
      bytes+=info.size;files++;
      if(bytes>2*1024**3||files>100000)throw Error('题库超过导入限制（2 GB / 100000 个文件）');
      const content=await readFile(from);digest.update(relative+'\0');digest.update(content);await writeFile(to,content,{mode:0o600});
    }else throw Error('题库只能包含普通文件和目录');
  }
  try{
    await copy();
    const {loadDatasetDescriptionCatalog}=await import(pathToFileURL(path.join(root,'dist/src/datasets/catalog.js')));
    const {currentQuestionCases,loadDatasetCase}=await import(pathToFileURL(path.join(root,'dist/src/datasets/loader.js')));
    const catalog=await loadDatasetDescriptionCatalog(path.join(staging,'catalog.md'));
    let cases=0;
    for(const d of catalog){
      const questions=await currentQuestionCases(staging,d.datasetId);
      if(!questions.length)throw Error(d.name+' 没有可运行题目');
      for(let i=0;i<questions.length;i++)await loadDatasetCase({datasetsRoot:staging,datasetId:d.datasetId,labelIds:d.labelIds,caseIndex:i});
      cases+=questions.length;
    }
    const manifest={importedAt:new Date().toISOString(),sha256:digest.digest('hex'),datasets:catalog.length,cases};
    await writeFile(path.join(staging,'evaldock-import.json'),JSON.stringify(manifest,null,2));
    const destination=path.join(root,'datasets'),backup=path.join(root,'dataset-history',randomUUID());
    await mkdir(path.dirname(backup),{recursive:true,mode:0o700});
    await rename(destination,backup);
    try{await rename(staging,destination);}catch(error){await rename(backup,destination);throw error;}
    return manifest;
  }finally{await rm(staging,{recursive:true,force:true});}
}
