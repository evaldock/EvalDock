import type { ArtifactRef, CollectionStatus, ContentDigest, JsonValue, RawObservation, Ref, ScopeRef, SourceDescriptor } from "../core/models.js";
export interface SubmissionFile {
  readonly portablePath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly artifactRef?: Ref<ArtifactRef>;
  readonly representation: "JSON" | "TEXT" | "BASE64" | "INDEX_ONLY";
  readonly evaluationScope?: "CONTENT" | "EXISTENCE_ONLY";
  readonly contentOmittedReason?: "FILE_TOO_LARGE" | "CASE_CONTENT_BUDGET" | "RESTRICTED" | "ARCHIVE_LIMIT";
  readonly archiveStatus?: "ARCHIVED" | "NOT_ARCHIVED";
  readonly content: JsonValue;
  readonly contentTruncated: boolean;
  readonly contentRestricted: boolean;
}
export interface FinalResponse {
  readonly content: string;
  readonly artifactRef: Ref<ArtifactRef>;
  readonly capturedBytes: number;
  readonly captureTruncated: boolean;
  readonly contentTruncated: boolean;
  readonly contentRestricted: boolean;
  readonly completedAt: string;
}
export interface TraceEntry {
  readonly id: string;
  readonly layer: "AGENT" | "ENVIRONMENT" | "DELIVERY";
  readonly sourceId?: string;
  readonly observation?: RawObservation;
  readonly content: JsonValue;
}
/** 三层证据共用一份记录；coverage 与 integrity 只说明采集状态，不决定能否评分。 */
export interface AllTrace {
  readonly schema: "evaldock.all-trace/v1";
  readonly traceId: string;
  readonly scope: ScopeRef;
  readonly createdAt: string;
  readonly producerVersion: string;
  readonly entries: readonly TraceEntry[];
  readonly sources: readonly SourceDescriptor[];
  readonly coverage: readonly CollectionStatus[];
  readonly artifacts: readonly ArtifactRef[];
  readonly integrity: readonly { readonly code: string; readonly id: string }[];
  readonly contentDigest: ContentDigest;
}
