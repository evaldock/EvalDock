import path from 'node:path';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {loadDatasetDescriptionCatalog} from '../../dist/src/datasets/catalog.js';
import {currentQuestionCases} from '../../dist/src/datasets/loader.js';
import {readEvidenceFile} from '../../dist/src/all-trace/store.js';
import {validatePortablePath} from '../../dist/src/core/models.js';
import {createHash} from 'node:crypto';

const referenceCache=new Map();
async function scoringState(file,question){
  if(question.grading?.mode==='unavailable')return 'UNAVAILABLE';
  if(question.grading?.mode!==undefined&&question.grading.mode!=='reference')return 'INVALID';
  try{
    const reference=question.grading?.reference??'private/final.json';
    if(typeof reference!=='string'||!reference.startsWith('private/'))return 'INVALID';
    const info=await lstat(path.resolve(path.dirname(file),reference));
    const privateRoot=await realpath(path.join(path.dirname(file),'private'));
    const canonical=await realpath(path.resolve(path.dirname(file),reference));
    if(info.isSymbolicLink()||!info.isFile()||!canonical.startsWith(privateRoot+path.sep))return 'INVALID';
    const key=canonical+':'+info.mtimeMs+':'+info.ctimeMs+':'+info.size;
    if(referenceCache.has(key))return referenceCache.get(key);
    const value=JSON.parse((await readEvidenceFile(path.dirname(file),reference,10*1024*1024)).toString('utf8'));
    const state=value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length?'READY':'INVALID';
    referenceCache.set(key,state);if(referenceCache.size>5000)referenceCache.delete(referenceCache.keys().next().value);
    return state;
  }catch(error){return error.code==='ENOENT'?'MISSING':'INVALID';}
}

const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function publicInputs(inputs){
  return (Array.isArray(inputs)?inputs:[]).flatMap(input=>{
    try{
      const source=validatePortablePath(input.source),destination=validatePortablePath(input.destination??input.source);
      if(source.split('/').includes('private')||destination.split('/').includes('private'))return [];
      return [{source,destination,delivery:input.delivery==='chat-attachment'?'chat-attachment':'workspace',.../^[a-f0-9]{64}$/i.test(input.sha256??'')?{sha256:input.sha256}:{}}];
    }catch{return [];}
  });
}
export async function evaluationCatalog(root){
  const datasetsRoot=path.resolve(root,process.env.EVALDOCK_DATASETS_ROOT??'datasets');
  const descriptions=await loadDatasetDescriptionCatalog(path.join(datasetsRoot,'catalog.md'),{allowEmpty:true});
  const datasets=[];
  for(const item of descriptions){
    const files=await currentQuestionCases(datasetsRoot,item.datasetId);
    if(!files.length)continue;
    const slug=String(item.datasetId).replace(/^dataset\./,'').replace(/\/v[1-9][0-9]*$/,'');
    const cases=await Promise.all(files.map(async(file,index)=>{
      const question=JSON.parse(await readFile(file,'utf8'));
      return {index,id:slug+'.case-'+(index+1),title:String(question.title??question.id??('Case '+(index+1))).slice(0,160),version:String(question.version??''),instructions:String(question.task?.instructions??'').slice(0,12000),platform:question.environment?.platform,timeoutSeconds:question.environment?.timeoutSeconds,dependencies:(question.environment?.dependencies??[]).map(d=>typeof d==='string'?d:String(d.name??d.id??'外部依赖')),inputs:publicInputs(question.inputs),labelIds:(question.capabilityLabels??[]).map(l=>'label.'+l+'/v1'),scoringState:await scoringState(file,question)};
    }));
    datasets.push({id:item.datasetId,name:item.name,description:item.description,labelIds:item.labelIds,cases});
  }
  const cases=datasets.flatMap(d=>d.cases),ready=cases.filter(c=>c.scoringState==='READY');
  return {schema:'evaldock.workbench.evaluation-catalog/v1',datasets,scoring:{readyCases:ready.length,totalCases:cases.length,unavailableCases:cases.length-ready.length,labelIds:[...new Set(ready.flatMap(c=>c.labelIds))]}};
}
/** The advanced view uses the same public library as selection, never task references. */
export async function questionInventory(root){
  const catalog=await evaluationCatalog(root);
  const {labels}=JSON.parse(await readFile(path.join(root,'workbench/design-prototypes/question-inventory/index.json'),'utf8'));
  const cases=new Map(),datasets=catalog.datasets.map(dataset=>({...dataset,datasetId:dataset.id,cases:dataset.cases.map(c=>{
    const record={question:{schema:'evaldock.public-question/v1',id:c.id,title:c.title,version:c.version,task:{instructions:c.instructions},environment:{platform:c.platform,timeoutSeconds:c.timeoutSeconds,dependencies:c.dependencies},inputs:c.inputs,capabilityLabels:c.labelIds.map(id=>id.slice(6,-3))},scoringState:c.scoringState,documents:{},files:c.inputs.map(input=>({path:input.source,sha256:input.sha256,delivery:input.delivery}))};
    const file=createHash('sha256').update(JSON.stringify([dataset.id,record])).digest('hex')+'.json';cases.set(file,record);
    return {id:c.id,caseId:c.id,caseIndex:c.index,title:c.title,description:c.instructions,labels:c.labelIds,version:c.version,scoringState:c.scoringState,file};
  })}));
  const revision=createHash('sha256').update(JSON.stringify({datasets,labels})).digest('hex');
  return {index:{schema:'evaldock.workbench.question-inventory/v1',revision,capturedAt:new Date().toISOString(),datasets,labels},cases};
}
export async function validateEvaluationConfig(root,value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['mode','selection'].includes(k)))throw Error('无效评测配置');
  if(!['EFFECT','FULL'].includes(value.mode))throw Error('请选择评测类型');
  const selection=value.selection;
  if(!selection||typeof selection!=='object'||Array.isArray(selection))throw Error('请选择测试方案');
  const kind=selection.kind;
  if(kind==='STANDARD'){
    if(Object.keys(selection).length!==1)throw Error('标准评测参数无效');
    return {mode:value.mode,selection:{kind}};
  }
  if(kind==='COUNT'){
    if(Object.keys(selection).some(k=>!['kind','caseCount','datasetCount'].includes(k))||!integer(selection.caseCount,1,10000)||selection.datasetCount!==undefined&&!integer(selection.datasetCount,1,10000)||selection.datasetCount>selection.caseCount)throw Error('测试数量无效');
    return {mode:value.mode,selection:{kind,caseCount:selection.caseCount,...selection.datasetCount?{datasetCount:selection.datasetCount}:{}}};
  }
  const catalog=await evaluationCatalog(root);
  if(kind==='ALL'){
    if(Object.keys(selection).some(k=>!['kind','casesPerDataset'].includes(k))||(selection.casesPerDataset!==undefined&&!integer(selection.casesPerDataset,1,10000)))throw Error('每个数据集的题数无效');
    return {mode:value.mode,selection:{kind,...(selection.casesPerDataset===undefined?{}:{casesPerDataset:selection.casesPerDataset})}};
  }
  if(kind==='SELECTED'){
    if(Object.keys(selection).some(k=>!['kind','items'].includes(k))||!Array.isArray(selection.items)||!selection.items.length||selection.items.length>catalog.datasets.length)throw Error('请指定数据集和 Case');
    const found=new Set(),items=[];
    for(const item of selection.items){
      if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['datasetId','caseIndices'].includes(k)))throw Error('指定 Case 格式无效');
      const dataset=catalog.datasets.find(d=>d.id===item.datasetId);
      if(!dataset||found.has(item.datasetId)||!Array.isArray(item.caseIndices)||!item.caseIndices.length)throw Error('指定数据集或 Case 不存在');
      const indices=[...new Set(item.caseIndices)];
      if(indices.length!==item.caseIndices.length||indices.some(i=>!integer(i,0,dataset.cases.length-1)))throw Error('指定 Case 不存在或重复');
      found.add(item.datasetId);items.push({datasetId:item.datasetId,caseIndices:indices.sort((a,b)=>a-b)});
    }
    return {mode:value.mode,selection:{kind,items}};
  }
  throw Error('未知测试方案');
}
