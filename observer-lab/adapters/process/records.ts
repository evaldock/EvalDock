/**
 * 文件职责：把 Process Sensor 草稿整理成 EvalDock 标准不可变记录，并计算 BEFORE/AFTER 差异。
 */
import {
  assertSameAttemptScope,
  canonicalJson,
  ContractViolation,
  digestEquals,
  digestValue,
  validateScope,
  validateStableId,
  withContentDigest,
  type ProcessDiff,
  type ProcessEntry,
  type ProcessSnapshot,
  type ArtifactRef,
  type CollectionStatus,
  type JsonObject,
  type RawObservation,
  type SourceDescriptor,
  type Ref,
  type ScopeRef,
} from "../../../src/core/models.js";
import type { ProcessSnapshotDraft } from "./sensor.js";

export interface ProcessRecordMetadata {
  readonly scope: ScopeRef;
  readonly createdAt: string;
  readonly producerVersion: string;
}

export function materializeProcessSnapshot(
  draft: ProcessSnapshotDraft,
  metadata: ProcessRecordMetadata,
): ProcessSnapshot {
  const scope = validateScope(metadata.scope);
  if (scope.attemptId === undefined || scope.attemptId !== draft.attemptId) {
    throw new ContractViolation("SCOPE_MISMATCH", "ProcessSnapshot Attempt must match Scope");
  }
  const expected = digestValue({
    resourceBinding: draft.resourceBinding,
    observedUid: draft.observedUid,
    entries: draft.entries,
    readErrors: draft.readErrors,
    completeness: draft.completeness,
  });
  if (!digestEquals(expected, draft.snapshotDigest)) {
    throw new ContractViolation("DIGEST_MISMATCH", "ProcessSnapshot digest is invalid");
  }
  return withContentDigest({
    schema: "evaldock.mvp.process-snapshot/v1" as const,
    processSnapshotId: validateStableId<"ProcessSnapshotId">(draft.processSnapshotId),
    scope,
    attemptId: scope.attemptId,
    phase: draft.phase,
    resourceBinding: draft.resourceBinding,
    observedUid: draft.observedUid,
    scanStartedAt: draft.scanStartedAt,
    scanCompletedAt: draft.scanCompletedAt,
    entries: draft.entries,
    readErrors: draft.readErrors,
    completeness: draft.completeness,
    snapshotDigest: draft.snapshotDigest,
    createdAt: metadata.createdAt,
    producerVersion: metadata.producerVersion,
  });
}

function identity(entry: ProcessEntry): string {
  return `${entry.pid}:${entry.startedAt}`;
}

export function materializeProcessDiff(input: {
  readonly processDiffId: string;
  readonly before: ProcessSnapshot;
  readonly beforeRef: Ref<ProcessSnapshot>;
  readonly after: ProcessSnapshot;
  readonly afterRef: Ref<ProcessSnapshot>;
  readonly metadata: ProcessRecordMetadata;
}): ProcessDiff {
  const scope = validateScope(input.metadata.scope);
  if (input.before.phase !== "BEFORE" || input.after.phase !== "AFTER") {
    throw new ContractViolation("PROCESS_PHASE_SET_INVALID", "Process diff requires BEFORE and AFTER");
  }
  const before = new Map(input.before.entries.map((entry) => [identity(entry), entry]));
  const after = new Map(input.after.entries.map((entry) => [identity(entry), entry]));
  const started = input.after.entries.filter((entry) => !before.has(identity(entry)));
  const exited = input.before.entries.filter((entry) => !after.has(identity(entry)));
  const persisted = input.after.entries.filter((entry) => before.has(identity(entry)));
  const diffDigest = digestValue({ started, exited, persisted });
  return withContentDigest({
    schema: "evaldock.mvp.process-diff/v1" as const,
    processDiffId: validateStableId<"ProcessDiffId">(input.processDiffId),
    scope,
    beforeSnapshotRef: input.beforeRef,
    afterSnapshotRef: input.afterRef,
    started,
    exited,
    persisted,
    diffDigest,
    createdAt: input.metadata.createdAt,
    producerVersion: input.metadata.producerVersion,
  });
}

/** Process Snapshot 的规范 JSON 制品；工作流先提交制品，再建立 RawObservation。 */
export function serializeProcessSnapshotArtifact(snapshot: ProcessSnapshot): Uint8Array {
  return Buffer.from(canonicalJson(snapshot), "utf8");
}

export function materializeProcessObservation(input: {
  readonly observationId: string;
  readonly scope: ScopeRef;
  readonly snapshot: ProcessSnapshot;
  readonly snapshotRef: Ref<ProcessSnapshot>;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly artifact: ArtifactRef;
  readonly artifactRef: Ref<ArtifactRef>;
  readonly createdAt: string;
  readonly producerVersion: string;
}): RawObservation {
  const scope = validateScope(input.scope);
  assertSameAttemptScope(scope, input.snapshot.scope, input.artifact.scope);
  if (
    !digestEquals(input.snapshot.contentDigest, input.snapshotRef.digest) ||
    !digestEquals(input.artifact.contentDigest, input.artifactRef.digest)
  ) {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "Process Snapshot refs are invalid");
  }
  return withContentDigest({
    schema: "evaldock.mvp.raw-observation/v1" as const,
    observationId: validateStableId<"ObservationId">(input.observationId),
    scope,
    attemptId: scope.attemptId!,
    sourceRef: input.sourceRef,
    externalEventType: `process/snapshot/${input.snapshot.phase}`,
    sourceTime: {
      observedAt: input.snapshot.scanCompletedAt,
      clockDomain: "evaldock-macos-process-sensor",
    },
    payloadArtifactRef: input.artifactRef,
    captureMetadata: {
      snapshotRef: {
        schema: input.snapshotRef.schema,
        id: input.snapshotRef.id,
        digest: {
          algorithm: input.snapshotRef.digest.algorithm,
          value: input.snapshotRef.digest.value,
          byteLength: input.snapshotRef.digest.byteLength,
        },
      } as JsonObject,
      phase: input.snapshot.phase,
      processCount: input.snapshot.entries.length,
      observedUid: input.snapshot.observedUid,
    },
    rawDigest: input.artifact.artifactContentDigest,
    createdAt: input.createdAt,
    producerVersion: input.producerVersion,
  });
}

export function materializeProcessCollectionStatus(input: {
  readonly collectionStatusId: string;
  readonly scope: ScopeRef;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly snapshots: readonly ProcessSnapshot[];
  readonly requiredPhases: readonly ProcessSnapshot["phase"][];
  readonly createdAt: string;
  readonly producerVersion: string;
}): CollectionStatus {
  const scope = validateScope(input.scope);
  const phases = new Set(input.snapshots.map((snapshot) => snapshot.phase));
  const gaps = [
    ...input.requiredPhases.filter((phase) => !phases.has(phase)).map((phase) => ({
      kind: "PROCESS_SNAPSHOT",
      reasonCode: `PROCESS_${phase}_MISSING`,
    })),
    ...input.snapshots.filter((snapshot) => snapshot.completeness !== "COMPLETE").map((snapshot) => ({
      kind: "PROCESS_SNAPSHOT",
      reasonCode: `PROCESS_${snapshot.phase}_PARTIAL`,
    })),
  ];
  const openedAt = input.snapshots[0]?.scanStartedAt ?? input.createdAt;
  const closedAt = input.snapshots.at(-1)?.scanCompletedAt ?? input.createdAt;
  return withContentDigest({
    schema: "evaldock.mvp.collection-status/v1" as const,
    collectionStatusId: validateStableId<"CollectionStatusId">(input.collectionStatusId),
    scope,
    sourceRef: input.sourceRef,
    openedAt,
    closedAt,
    recordCount: input.snapshots.length,
    finalWatermark: { phases: [...phases].sort() },
    gaps,
    truncated: false,
    health: gaps.length === 0 ? "HEALTHY" as const : "DEGRADED" as const,
    completeness: gaps.length === 0 ? "COMPLETE" as const : "PARTIAL" as const,
    failureRefs: [],
    createdAt: input.createdAt,
    producerVersion: input.producerVersion,
  });
}
