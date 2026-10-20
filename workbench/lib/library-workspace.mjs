import {mkdir,readFile,writeFile,readdir,lstat,rename,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function libraryFingerprint(directory){
  const digest=createHash('sha256');
  async function visit(relative=''){
    const file=path.join(directory,relative),info=await lstat(file);
    if(info.isSymbolicLink())throw Error('题库不能包含符号链接');
    digest.update(relative+'\0');
    if(info.isDirectory())for(const name of (await readdir(file)).sort())await visit(path.join(relative,name));
    else if(info.isFile())digest.update(await readFile(file));else throw Error('题库只能包含普通文件和目录');
  }
  await visit();return digest.digest('hex');
}
/** Only the unchanged initial library may be replaced automatically. */
export async function isBundledLibrary(source,root){
  async function files(directory,relative=''){
    const result=[];
    for(const name of (await readdir(path.join(directory,relative))).sort()){
      if(!relative&&name==='README.md')continue;
      if(!relative&&name==='evaldock-import.json'){
        try{const receipt=JSON.parse(await readFile(path.join(directory,name),'utf8'));if(receipt.datasets===1&&receipt.cases===1&&/^[a-f0-9]{64}$/.test(receipt.sha256))continue;}catch{}
      }
      const file=path.join(relative,name),info=await lstat(path.join(directory,file));
      if(info.isSymbolicLink())return null;
      if(info.isDirectory()){const children=await files(directory,file);if(!children)return null;result.push(...children);}
      else if(info.isFile())result.push(file);else return null;
    }
    return result;
  }
  const bundled=path.join(source,'datasets'),installed=path.join(root,'datasets');
  const expected=await files(bundled),actual=await files(installed);
  if(!expected||!actual||JSON.stringify(expected)!==JSON.stringify(actual))return false;
  for(const file of expected)if(!(await readFile(path.join(bundled,file))).equals(await readFile(path.join(installed,file))))return false;
  return true;
}
/** Import a complete library transactionally; retain the previous library for recovery. */
export async function importLibrary(source,root,{onProgress=()=>{}}={}){
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
      if(bytes>4*1024**3||files>100000)throw Error('题库超过导入限制（4 GB / 100000 个文件）');
      const content=await readFile(from);digest.update(relative+'\0');digest.update(content);await writeFile(to,content,{mode:0o600});
      onProgress({phase:'COPYING',completed:files});
    }else throw Error('题库只能包含普通文件和目录');
  }
  try{
    onProgress({phase:'COPYING',completed:0});
    await copy();
    const {loadDatasetDescriptionCatalog}=await import(pathToFileURL(path.join(root,'dist/src/datasets/catalog.js')));
    const {currentQuestionCases,loadDatasetCase}=await import(pathToFileURL(path.join(root,'dist/src/datasets/loader.js')));
    const catalog=await loadDatasetDescriptionCatalog(path.join(staging,'catalog.md'));
    onProgress({phase:'VALIDATING',completed:0});
    const datasets=[];let cases=0;
    for(const d of catalog){
      const questions=await currentQuestionCases(staging,d.datasetId);
      if(!questions.length)throw Error(d.name+' 没有可运行题目');
      datasets.push({dataset:d,count:questions.length});
      cases+=questions.length;
    }
    let validated=0;onProgress({phase:'VALIDATING',completed:validated,total:cases});
    for(const {dataset:d,count} of datasets)for(let i=0;i<count;i++){
      await loadDatasetCase({datasetsRoot:staging,datasetId:d.datasetId,labelIds:d.labelIds,caseIndex:i});
      onProgress({phase:'VALIDATING',completed:++validated,total:cases});
    }
    const manifest={importedAt:new Date().toISOString(),sha256:digest.digest('hex'),datasets:catalog.length,cases};
    await writeFile(path.join(staging,'evaldock-import.json'),JSON.stringify(manifest,null,2));
    onProgress({phase:'COMMITTING',completed:0});
    const destination=path.join(root,'datasets'),backup=path.join(root,'dataset-history',randomUUID());
    await mkdir(path.dirname(backup),{recursive:true,mode:0o700});
    await rename(destination,backup);
    try{await rename(staging,destination);}catch(error){await rename(backup,destination);throw error;}
    return manifest;
  }finally{await rm(staging,{recursive:true,force:true});}
}
