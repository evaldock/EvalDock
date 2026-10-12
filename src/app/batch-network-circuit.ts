/** Model transport failures are infrastructure, never free-form Agent tool output. */
import type {WorkflowSummary} from "./workflow.js";
export type ModelNetworkFailureKind="DSH_MODEL_TRANSPORT"|"JUDGE_ALL_LABEL_TRANSPORT";
export interface ModelNetworkFailureEvidence {readonly kind:ModelNetworkFailureKind;readonly transportCodes:readonly string[]}
export interface BatchNetworkDispatchStop {
  readonly schema:"evaldock.batch-network-dispatch-stop/v1";
  readonly reasonCode:"BATCH_MODEL_NETWORK_UNAVAILABLE";
  readonly threshold:3;
  readonly detectedAt:string;
  readonly completionOrder:readonly {caseId:string;executionRunId:string;evidence:ModelNetworkFailureEvidence}[];
  readonly unstartedCaseIds:readonly string[];
}
const networkCodes=new Set(["ENOTFOUND","EAI_AGAIN","ENETUNREACH","EHOSTUNREACH","ECONNREFUSED","ECONNRESET","ENETDOWN","EHOSTDOWN","EPIPE","ETIMEDOUT","UND_ERR_CONNECT_TIMEOUT","UND_ERR_SOCKET"]);
export function modelNetworkFailureEvidence(summary:Pick<WorkflowSummary,"reasonCodes"|"scores">,expectedLabelIds:readonly string[]=[]):ModelNetworkFailureEvidence|undefined {
  // This reason is emitted only from a top-level DSH model TRANSPORT termination.
  if(summary.reasonCodes.includes("MODEL_TRANSPORT_ERROR"))return {kind:"DSH_MODEL_TRANSPORT",transportCodes:[]};
  const scores=summary.scores??[],expected=new Set(expectedLabelIds);
  if(!summary.reasonCodes.includes("LABEL_JUDGE_ERROR")||!expected.size||scores.length!==expected.size||new Set(scores.map(score=>score.labelId)).size!==expected.size||scores.some(score=>!expected.has(score.labelId)))return;
  if(!scores.length||!scores.every(score=>score.status==="ERROR"&&["JUDGE_NETWORK_ERROR","JUDGE_RESPONSE_READ_FAILED"].includes(score.reason)&&typeof score.diagnostics?.transportCode==="string"&&networkCodes.has(score.diagnostics.transportCode)))return;
  return {kind:"JUDGE_ALL_LABEL_TRANSPORT",transportCodes:[...new Set(scores.map(score=>score.diagnostics!.transportCode!))].sort()};
}
export class ModelNetworkCircuitBreaker {
  readonly threshold=3 as const;
  private failures:{caseId:string;executionRunId:string;evidence:ModelNetworkFailureEvidence}[]=[];
  private stopped:BatchNetworkDispatchStop|undefined;
  observe(input:{caseId:string;executionRunId:string;summary:Pick<WorkflowSummary,"reasonCodes"|"scores">;expectedLabelIds:readonly string[];unstartedCaseIds:readonly string[]}):BatchNetworkDispatchStop|undefined {
    if(this.stopped)return;
    const evidence=modelNetworkFailureEvidence(input.summary,input.expectedLabelIds);
    if(!evidence){this.failures=[];return;}
    this.failures.push({caseId:input.caseId,executionRunId:input.executionRunId,evidence});
    if(this.failures.length<this.threshold)return;
    this.stopped={schema:"evaldock.batch-network-dispatch-stop/v1",reasonCode:"BATCH_MODEL_NETWORK_UNAVAILABLE",threshold:this.threshold,detectedAt:new Date().toISOString(),completionOrder:[...this.failures],unstartedCaseIds:[...input.unstartedCaseIds]};
    return this.stopped;
  }
}
