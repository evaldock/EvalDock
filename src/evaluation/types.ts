import type { ContentDigest, ScopeRef } from "../core/models.js";
import type { LabelDefinition } from "../labels/catalog.js";
import type { AllTrace } from "../all-trace/types.js";
import type { DatasetCase } from "../datasets/loader.js";
export interface JudgeInput {
  readonly label: LabelDefinition;
  readonly case: DatasetCase;
  /** Same complete Case trace for every label; no label-specific filtering or truncation. */
  readonly allTrace: AllTrace;
  /** EFFECT exposes only the final answer and delivered files to Judge. */
  readonly evaluationMode?: "EFFECT" | "FULL";
}
export interface LabelScore {
  readonly weight?: number;
  readonly schema: "evaldock.label-score/v1";
  readonly scoreId: string;
  readonly scope:ScopeRef;
  readonly producerVersion:string;
  readonly labelId: string;
  readonly labelDigest: ContentDigest;
  readonly caseDigest: ContentDigest;
  readonly allTraceDigest: ContentDigest;
  readonly status: "SCORED" | "UNASSESSABLE" | "ERROR";
  readonly score: number | null;
  readonly scale: { readonly min: number; readonly max: number };
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  /** Recoverable response normalization, separate from the model rationale. */
  readonly warnings?: readonly string[];
  readonly diagnostics?: { readonly httpStatus?: number; readonly finishReason?: string; readonly attempts?: number; readonly providerCategory?: string; readonly providerBodyTruncated?: boolean; readonly requestBytes?: number; readonly traceBytes?: number; readonly transportCode?: string };
  readonly model: string;
  readonly createdAt: string;
  readonly contentDigest: ContentDigest;
}
export interface LabelJudge { evaluate(input: JudgeInput): Promise<LabelScore>; }
export interface DimensionScore {
  readonly labelId: string;
  readonly score: number | null;
  readonly min: number; readonly max: number;
  readonly scoredCases: number; readonly unassessableCases: number; readonly errorCases: number;
}
