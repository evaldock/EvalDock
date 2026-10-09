import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {loadDatasetDescriptionCatalog} from '../../dist/src/datasets/catalog.js';
import {currentQuestionCases} from '../../dist/src/datasets/loader.js';

const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
export async function evaluationCatalog(root){
  const datasetsRoot=path.resolve(root,process.env.EVALDOCK_DATASETS_ROOT??'datasets');
  const descriptions=await loadDatasetDescriptionCatalog(path.join(datasetsRoot,'catalog.md'));
  const datasets=[];
  for(const item of descriptions){
    const files=await currentQuestionCases(datasetsRoot,item.datasetId);
    if(!files.length)continue;
    const slug=String(item.datasetId).replace(/^dataset\./,'').replace(/\/v[1-9][0-9]*$/,'');
    const cases=await Promise.all(files.map(async(file,index)=>{
      const question=JSON.parse(await readFile(file,'utf8'));
      return {index,id:slug+'.case-'+(index+1),title:String(question.title??question.id??('Case '+(index+1))).slice(0,160),version:String(question.version??''),instructions:String(question.task?.instructions??'').slice(0,12000),timeoutSeconds:question.environment?.timeoutSeconds,dependencies:(question.environment?.dependencies??[]).map(d=>typeof d==='string'?d:String(d.name??d.id??'外部依赖'))};
    }));
    datasets.push({id:item.datasetId,name:item.name,description:item.description,labelIds:item.labelIds,cases});
  }
  return {schema:'evaldock.workbench.evaluation-catalog/v1',datasets};
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
