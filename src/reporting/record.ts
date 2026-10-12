/** 保存和验证统一记录，不计算分数，也不生成展示字段。 */
import { digestValue, digestEquals } from "../core/models.js";
import type { EvaluationResult, ResultData } from "./types.js";
import { publicCaseMetadata } from "./public-case.js";
export function buildResult(data:ResultData,producerVersion:string):EvaluationResult {
  const {contentDigest:_previousDigest,...body}=data as ResultData & {contentDigest?:unknown};
  const projected={...body};
  if(data.case){
    projected.case=publicCaseMetadata(data.case);
  }
  if(data.plan){
    const {seedSpec: _seeds,...casePlan}=data.plan.casePlan as typeof data.plan.casePlan & {seedSpec?:unknown};
    projected.plan={...data.plan,casePlan};
  }
  const record={schema:"evaldock.result/v1" as const,reportId:"report."+data.runId,
    createdAt:new Date().toISOString(),producerVersion,...projected};
  return {...record,contentDigest:digestValue(record)};
}
/** Old records remain unchanged on disk; HTTP clients receive a public projection. */
export function publicReportDocument(data:EvaluationResult):EvaluationResult {
  const body={...data,...(data.case?{case:publicCaseMetadata(data.case)}:{})};
  if(digestEquals(data.contentDigest,digestValue(body,["contentDigest"])))return data;
  const projected={...body,sourceReportDigest:data.contentDigest};
  return {...projected,contentDigest:digestValue(projected,["contentDigest"])};
}
export function parseVerifiedReportDocument(text:string):EvaluationResult {
  const data=JSON.parse(text);
  if(data.schema!=="evaldock.result/v1" || typeof data.runId!=="string" ||
    data.scope?.runId!==data.runId || !data.target || !Array.isArray(data.scores) ||
    !Array.isArray(data.dimensions) || !Array.isArray(data.timeline) || !Array.isArray(data.artifacts) ||
    !digestEquals(data.contentDigest,digestValue(data,["contentDigest"]))) throw new Error("Invalid evaluation result or digest");
  return data;
}
export function serializeReportDocument(data:EvaluationResult):string { return JSON.stringify(data,null,2)+"\n"; }
