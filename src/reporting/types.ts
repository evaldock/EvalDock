/** 一份规范记录，同时用于 JSON 持久化和 HTML；不包含评分算法。 */
import type { ContentDigest, ScopeRef, TargetSnapshot, InspectionSnapshot, EvaluationPlan, ArtifactRef, ResetVerification } from "../core/models.js";
import type { FailureRecord } from "../core/errors.js";
import type { AllTrace } from "../all-trace/types.js";
import type { LabelDefinition } from "../labels/catalog.js";
import type { DatasetCase } from "../datasets/loader.js";
import type { LabelScore, DimensionScore } from "../evaluation/types.js";
export type WorkflowStepStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";

/** 单个工作流步骤的展示投影，关联对象、故障分组和排障提示。 */
export interface WorkflowStepView {
  readonly number: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  readonly label: string;
  readonly status: WorkflowStepStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly objectRefs: readonly string[];
  readonly failureGroups: readonly string[];
  readonly hintCode?: string;
}

export interface ExecutionDataView {
  readonly inputDelivery?: import("../runtime/input-delivery.js").InputDeliveryReceipt;
  readonly task: string;
  readonly terminationKind?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutCapturedBytes?: number;
  readonly stderrCapturedBytes?: number;
  readonly stdoutCaptureTruncated?: boolean;
  readonly stderrCaptureTruncated?: boolean;
  readonly stdoutReportTruncated?: boolean;
  readonly stderrReportTruncated?: boolean;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly dshSessionIds?: readonly string[];
}


export interface ResultData {
  readonly evaluationMode?: "EFFECT" | "FULL";
  readonly evaluationScope?: ScopeRef;
  readonly runId: string;
  readonly scope: ScopeRef;
  readonly currentPhase: string;
  readonly runState: string;
  readonly operationalHealth: string;
  readonly fixture: boolean;
  readonly securityIsolation: string;
  readonly target: TargetSnapshot;
  readonly inspection?: InspectionSnapshot;
  readonly plan?: Omit<EvaluationPlan,'casePlan'> & {readonly casePlan:Omit<EvaluationPlan['casePlan'],'seedSpec'>};
  readonly case?: Omit<DatasetCase,'seedEntries'>;
  readonly labels: readonly LabelDefinition[];
  readonly execution?: ExecutionDataView;
  readonly allTrace?: AllTrace;
  readonly allTraceRef?: import("../all-trace/store.js").TraceDirectoryRef;
  readonly scores: readonly LabelScore[];
  readonly dimensions: readonly DimensionScore[];
  readonly reset?: ResetVerification;
  readonly environmentState: string;
  readonly failures: readonly FailureRecord[];
  readonly timeline: readonly WorkflowStepView[];
  readonly artifacts: readonly ArtifactRef[];
}
export interface EvaluationResult extends ResultData {
  readonly schema:"evaldock.result/v1";
  readonly reportId:string;
  readonly createdAt:string;
  readonly producerVersion:string;
  readonly contentDigest:ContentDigest;
}
