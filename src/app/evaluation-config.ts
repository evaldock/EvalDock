/** Workbench and CLI share one explicit evaluation choice per run. */
export type EvaluationConfig = Readonly<{
  mode:"EFFECT"|"FULL";
  selection:
    | Readonly<{kind:"STANDARD"}>
    | Readonly<{kind:"COUNT";caseCount:number;datasetCount?:number}>
    | Readonly<{kind:"ALL";casesPerDataset?:number}>
    | Readonly<{kind:"SELECTED";items:readonly Readonly<{datasetId:string;caseIndices:readonly number[]}>[]}>;
}>;
const positive=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=1&&Number(value)<=10000;
export function parseEvaluationConfig(value:unknown):EvaluationConfig {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid evaluation config");
  const root=value as Record<string,unknown>;
  if(Object.keys(root).some(k=>!["mode","selection"].includes(k))||!(["EFFECT","FULL"] as unknown[]).includes(root.mode))throw new Error("Invalid evaluation mode");
  if(!root.selection||typeof root.selection!=="object"||Array.isArray(root.selection))throw new Error("Invalid evaluation selection");
  const selection=root.selection as Record<string,unknown>;
  if(selection.kind==="STANDARD"&&Object.keys(selection).length===1)return {mode:root.mode as "EFFECT"|"FULL",selection:{kind:"STANDARD"}};
  if(selection.kind==="COUNT"&&Object.keys(selection).every(k=>["kind","caseCount","datasetCount"].includes(k))&&positive(selection.caseCount)&&
    (selection.datasetCount===undefined||positive(selection.datasetCount)&&Number(selection.datasetCount)<=Number(selection.caseCount)))
    return {mode:root.mode as "EFFECT"|"FULL",selection:{kind:"COUNT",caseCount:Number(selection.caseCount),...(selection.datasetCount===undefined?{}:{datasetCount:Number(selection.datasetCount)})}};
  if(selection.kind==="ALL"&&Object.keys(selection).every(k=>["kind","casesPerDataset"].includes(k))&&(selection.casesPerDataset===undefined||positive(selection.casesPerDataset)))
    return {mode:root.mode as "EFFECT"|"FULL",selection:{kind:"ALL",...(selection.casesPerDataset===undefined?{}:{casesPerDataset:Number(selection.casesPerDataset)})}};
  if(selection.kind==="SELECTED"&&Object.keys(selection).every(k=>["kind","items"].includes(k))&&Array.isArray(selection.items)&&selection.items.length>0&&selection.items.length<=10000){
    const items=selection.items.map(raw=>{
      if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Invalid selected dataset");
      const item=raw as Record<string,unknown>;
      if(Object.keys(item).some(k=>!["datasetId","caseIndices"].includes(k))||typeof item.datasetId!=="string"||!Array.isArray(item.caseIndices)||!item.caseIndices.length||
        !item.caseIndices.every(i=>Number.isSafeInteger(i)&&i>=0&&i<10000)||new Set(item.caseIndices).size!==item.caseIndices.length)throw new Error("Invalid selected Cases");
      return {datasetId:item.datasetId,caseIndices:item.caseIndices as number[]};
    });
    if(new Set(items.map(item=>item.datasetId)).size!==items.length)throw new Error("Duplicate selected Dataset");
    return {mode:root.mode as "EFFECT"|"FULL",selection:{kind:"SELECTED",items}};
  }
  throw new Error("Invalid evaluation selection");
}
