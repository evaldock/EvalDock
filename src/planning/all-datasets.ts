import type {DatasetSelectionInput,DatasetSelectionPlan} from "./planner.js";
/** Explicit full-catalog coverage requested by the operator; no model-based subset selection. */
export function selectAllDatasets(input:DatasetSelectionInput):DatasetSelectionPlan {
 input.signal?.throwIfAborted();
 const limit=input.testSize?.casesPerDataset;
 if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>10000))throw new Error("Invalid per-Dataset limit");
 if(input.availableDatasets.length===0)throw new Error("Dataset catalog is empty");
 if(input.testSize?.datasetCount!==undefined&&input.testSize.datasetCount!==input.availableDatasets.length)throw new Error("Dataset catalog changed; refresh test scope");
 const selectedDatasets=input.availableDatasets.map(d=>{
  if(!Number.isSafeInteger(d.availableCaseCount)||d.availableCaseCount<1)throw new Error("Dataset has no local Cases: "+d.datasetId);
  return Object.freeze({datasetId:d.datasetId,evaluationLabelIds:d.labelIds,caseCount:limit===undefined?d.availableCaseCount:Math.min(limit,d.availableCaseCount),reason:limit===undefined?"用户指定全部数据集及全部现有题目。":"用户指定全测试集覆盖，每集最多 "+limit+" 题；不足时使用现有全部题目。"});
 });
 const totalCaseCount=selectedDatasets.reduce((n,d)=>n+d.caseCount,0);
 if(input.testSize?.maxCases!==undefined&&totalCaseCount>input.testSize.maxCases)throw new Error("All-Dataset coverage exceeds Case limit");
 return Object.freeze({schema:"evaldock.mvp.unified-planner-result/v1",profile:input.profile,selectedDatasets:Object.freeze(selectedDatasets),evaluationLabelIds:Object.freeze([...new Set(selectedDatasets.flatMap(d=>d.evaluationLabelIds))]),totalCaseCount,model:"explicit-all-datasets",durationMs:0});
}
