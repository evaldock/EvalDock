/**
 * 文件职责：构造观察来源与 ObservationSession，并以统一规则推进基线、激活、排空、封存或失败状态。
 * 核心流程：冻结 Probe/File 来源描述，创建双来源 Session，校验每次状态迁移，封存时验证六项完成账本和已提交的采集状态。
 * 与其他文件的真实交互：读取 agent-trace/reader.ts 与 observer-lab/adapters/filesystem/sensor.ts 的实现身份；依赖 core/models.ts 构造摘要和状态迁移；由 app/workflow.ts 持久化返回结果。
 * 公开接口：来源与 Session 输入类型、来源/Session 构造函数、生命周期迁移函数、迟到记录诊断，以及完成账本构造函数。
 */
import {
  ContractViolation,
  assertLegalTransition,
  refForProjection,
  validateIsoDateTime,
  validateScope,
  validateStableId,
  withContentDigest,
  withProjectionDigest,
  type AgentTracePlan,
  type CollectionStatus,
  type CompletionLedger,
  type CompletionLedgerItem,
  type FileSnapshot,
  type ObservationPlan,
  type ObservationSession,
  type ObservationSessionState,
  type Ref,
  type ScopeRef,
  type SourceDescriptor,
  type StateTransition,
} from "../core/models.js";
import type { FailureDraft, FailureRecord } from "../core/errors.js";
import {
  FILE_SENSOR_CAPABILITY_DIGEST,
  FILE_SENSOR_IMPLEMENTATION_ID,
  FILE_SENSOR_IMPLEMENTATION_VERSION,
} from "../../observer-lab/adapters/filesystem/sensor.js";
import {
  PROCESS_SENSOR_CAPABILITY_DIGEST,
  PROCESS_SENSOR_IMPLEMENTATION_ID,
  PROCESS_SENSOR_IMPLEMENTATION_VERSION,
} from "../../observer-lab/adapters/process/sensor.js";
import {
  PROBE_CAPABILITY_DIGEST,
  PROBE_IMPLEMENTATION_ID,
  PROBE_IMPLEMENTATION_VERSION,
} from "../agent-trace/reader.js";

/** MVP 封存协议要求的六项完成证明及其规范顺序。 */
const LEDGER_ORDER = [
  "TARGET_TERMINATION",
  "TOOL_CALLS",
  "SESSION_FLUSH",
  "PROBE_WATERMARK",
  "STABLE_WINDOW",
  "FINAL_FILE_SNAPSHOT",
] as const satisfies readonly CompletionLedgerItem["kind"][];

/** 创建 Probe 或文件 SourceDescriptor 时共享的冻结来源参数。 */
export interface SourceDescriptorInput {
  readonly sourceId: string;
  readonly scope: ScopeRef;
  readonly resourceBinding: string;
  readonly contentMode: string;
  readonly watermarkDefinition: SourceDescriptor["watermarkDefinition"];
  readonly knownBlindSpots?: readonly string[];
  readonly createdAt: string;
  readonly producerVersion: string;
}

/** 使用 runtime.ts 暴露的 Probe 实现身份创建协作型来源描述；由 app/workflow.ts 在 Session 建立前调用。 */
export function createProbeSourceDescriptor(input: SourceDescriptorInput): SourceDescriptor {
  return withContentDigest({
    schema: "evaldock.mvp.source/v1" as const,
    sourceId: validateStableId<"SourceId">(input.sourceId, "sourceId"),
    scope: validateScope(input.scope),
    sourceType: "DSH_PROBE" as const,
    externalSchema: "dsh-eval.probe/v1",
    collectorName: PROBE_IMPLEMENTATION_ID,
    collectorVersion: PROBE_IMPLEMENTATION_VERSION,
    collectorCapabilityDigest: PROBE_CAPABILITY_DIGEST,
    trust: "COOPERATIVE" as const,
    resourceBinding: input.resourceBinding,
    sequenceMode: "CONTIGUOUS_FROM_ZERO",
    watermarkDefinition: input.watermarkDefinition,
    contentMode: input.contentMode,
    knownBlindSpots: input.knownBlindSpots ?? ["COOPERATIVE_IN_PROCESS_SOURCE"],
    createdAt: validateIsoDateTime(input.createdAt, "createdAt"),
    producerVersion: input.producerVersion,
  });
}

/** 使用文件传感器身份创建独立来源描述；由 app/workflow.ts 在 Session 建立前调用。 */
export function createFileSourceDescriptor(input: SourceDescriptorInput): SourceDescriptor {
  return withContentDigest({
    schema: "evaldock.mvp.source/v1" as const,
    sourceId: validateStableId<"SourceId">(input.sourceId, "sourceId"),
    scope: validateScope(input.scope),
    sourceType: "FILESYSTEM" as const,
    externalSchema: "evaldock.mvp.file-snapshot/v1",
    collectorName: FILE_SENSOR_IMPLEMENTATION_ID,
    collectorVersion: FILE_SENSOR_IMPLEMENTATION_VERSION,
    collectorCapabilityDigest: FILE_SENSOR_CAPABILITY_DIGEST,
    trust: "INDEPENDENT" as const,
    resourceBinding: input.resourceBinding,
    sequenceMode: "SNAPSHOT_PHASE",
    watermarkDefinition: input.watermarkDefinition,
    contentMode: input.contentMode,
    knownBlindSpots: input.knownBlindSpots ?? ["BLOCKED_ACCESS_ATTEMPTS_NOT_OBSERVED"],
    createdAt: validateIsoDateTime(input.createdAt, "createdAt"),
    producerVersion: input.producerVersion,
  });
}

/** 使用 macOS 进程传感器身份创建独立来源描述。 */
export function createProcessSourceDescriptor(input: SourceDescriptorInput): SourceDescriptor {
  return withContentDigest({
    schema: "evaldock.mvp.source/v1" as const,
    sourceId: validateStableId<"SourceId">(input.sourceId, "sourceId"),
    scope: validateScope(input.scope),
    sourceType: "PROCESS" as const,
    externalSchema: "evaldock.mvp.process-snapshot/v1",
    collectorName: PROCESS_SENSOR_IMPLEMENTATION_ID,
    collectorVersion: PROCESS_SENSOR_IMPLEMENTATION_VERSION,
    collectorCapabilityDigest: PROCESS_SENSOR_CAPABILITY_DIGEST,
    trust: "INDEPENDENT" as const,
    resourceBinding: input.resourceBinding,
    sequenceMode: "SNAPSHOT_PHASE",
    watermarkDefinition: input.watermarkDefinition,
    contentMode: input.contentMode,
    knownBlindSpots: input.knownBlindSpots ?? ["SHORT_LIVED_PROCESSES_BETWEEN_SNAPSHOTS"],
    createdAt: validateIsoDateTime(input.createdAt, "createdAt"),
    producerVersion: input.producerVersion,
  });
}

/** 创建初始 ObservationSession 所需的 Attempt 作用域、计划及两条来源引用。 */
export interface CreateObservationSessionInput {
  readonly observationSessionId: string;
  readonly attemptId: string;
  readonly scope: ScopeRef;
  readonly agentTracePlanRef: Ref<AgentTracePlan>;
  readonly observationPlanRef: Ref<ObservationPlan>;
  readonly sourceRefs: readonly Ref<SourceDescriptor>[];
  readonly createdAt: string;
  readonly failureRefs?: readonly Ref<FailureRecord>[];
}

/** 校验来源唯一性和 Attempt 归属后创建 PLANNED Session；由 app/workflow.ts 在采集基线前调用。 */
export function createObservationSession(input: CreateObservationSessionInput): ObservationSession {
  const scope = validateScope(input.scope);
  const attemptId = validateStableId<"AttemptId">(input.attemptId, "attemptId");
  if (scope.attemptId !== attemptId) {
    throw new ContractViolation("SCOPE_MISMATCH", "ObservationSession Attempt must match its Scope");
  }
  if (
    input.sourceRefs.length === 0 ||
    new Set(input.sourceRefs.map((ref) => String(ref.id))).size !== input.sourceRefs.length
  ) {
    throw new ContractViolation(
      "INVALID_OBSERVATION_SOURCES",
      "ObservationSession requires one or more unique Sources",
    );
  }
  const sessionId = validateStableId<"ObservationSessionId">(
    input.observationSessionId,
    "observationSessionId",
  );
  const createdAt = validateIsoDateTime(input.createdAt, "createdAt");
  return withProjectionDigest({
    schema: "evaldock.mvp.observation-session/v1" as const,
    aggregateId: sessionId,
    observationSessionId: sessionId,
    attemptId,
    scope,
    agentTracePlanRef: input.agentTracePlanRef,
    observationPlanRef: input.observationPlanRef,
    state: "PLANNED" as const,
    revision: 0,
    sourceRefs: stableRefs(input.sourceRefs),
    collectionStatusRefs: [],
    failureRefs: input.failureRefs ?? [],
    createdAt,
    updatedAt: createdAt,
  });
}

/** 所有 Session 状态迁移共享的时间、原因和证据引用。 */
export interface ObservationTransitionInput {
  readonly occurredAt: string;
  readonly reasonCode: string;
  readonly supportingRefs?: readonly Ref[];
  readonly failureRefs?: readonly Ref<FailureRecord>[];
}

/** 将 Session 从 PLANNED 推进到 BASELINING 并记录开始时间；由 app/workflow.ts 在文件基线捕获前调用。 */
export function beginBaseline(
  current: ObservationSession,
  input: ObservationTransitionInput,
): StateTransition<ObservationSession> {
  return transitionSession(current, "BASELINING", input, {
    baselineStartedAt: validateIsoDateTime(input.occurredAt),
  });
}

/** 确认基线已开始并将 Session 推进到 BASELINED；由 app/workflow.ts 在 BEFORE 快照提交后调用。 */
export function completeBaseline(
  current: ObservationSession,
  input: ObservationTransitionInput & {
    readonly beforeSnapshotRef: Ref<FileSnapshot>;
  },
): StateTransition<ObservationSession> {
  if (current.baselineStartedAt === undefined) {
    throw new ContractViolation("BASELINE_NOT_STARTED", "Baseline cannot complete before it starts");
  }
  return transitionSession(current, "BASELINED", input, {
    baselinedAt: validateIsoDateTime(input.occurredAt),
  });
}

/** 在基线提交后将 Session 激活；由 app/workflow.ts 紧邻目标启动阶段调用。 */
export function activateObservation(
  current: ObservationSession,
  input: ObservationTransitionInput,
): StateTransition<ObservationSession> {
  if (current.baselinedAt === undefined) {
    throw new ContractViolation("BASELINE_NOT_COMMITTED", "ACTIVE requires a committed baseline");
  }
  return transitionSession(current, "ACTIVE", input, {
    activeAt: validateIsoDateTime(input.occurredAt),
  });
}

/** 在目标终止时间之后进入 DRAINING 并冻结排空起点；由 app/workflow.ts 在读取 Probe 与最终快照前调用。 */
export function beginDrain(
  current: ObservationSession,
  input: ObservationTransitionInput & {
    readonly targetTerminatedAt: string;
  },
): StateTransition<ObservationSession> {
  const targetTerminatedAt = validateIsoDateTime(input.targetTerminatedAt, "targetTerminatedAt");
  const drainStartedAt = validateIsoDateTime(input.occurredAt, "drainStartedAt");
  if (Date.parse(drainStartedAt) < Date.parse(targetTerminatedAt)) {
    throw new ContractViolation(
      "DRAIN_BEFORE_TERMINATION",
      "Probe drain cannot start before Target termination is recorded",
    );
  }
  return transitionSession(current, "DRAINING", input, {
    targetTerminatedAt,
    drainStartedAt,
  });
}

/** 封存 Session 所需的双来源采集状态、完成账本与原始制品提交确认。 */
export interface SealObservationInput extends ObservationTransitionInput {
  readonly collectionStatusRefs: readonly Ref<CollectionStatus>[];
  readonly completionLedger: CompletionLedger;
  readonly allRawArtifactsCommitted: boolean;
}

/** 验证排空、原始制品和完整账本后生成不可变 SEALED 迁移；由 app/workflow.ts 在全部观察证据提交后调用。 */
export function sealObservation(
  current: ObservationSession,
  input: SealObservationInput,
): StateTransition<ObservationSession> {
  if (current.targetTerminatedAt === undefined || current.drainStartedAt === undefined) {
    throw new ContractViolation(
      "TERMINATION_NOT_RECORDED",
      "Observation cannot Seal before bounded drain after Target termination",
    );
  }
  if (!input.allRawArtifactsCommitted) {
    throw new ContractViolation(
      "RAW_ARTIFACT_NOT_COMMITTED",
      "Observation cannot Seal before every captured raw Artifact is committed",
    );
  }
  if (input.collectionStatusRefs.length !== current.sourceRefs.length) {
    throw new ContractViolation(
      "COLLECTION_STATUS_MISSING",
      "Every planned Source requires a committed CollectionStatus before Seal",
    );
  }
  validateCompletionLedger(input.completionLedger);
  return transitionSession(current, "SEALED", input, {
    sealedAt: validateIsoDateTime(input.occurredAt, "sealedAt"),
    collectionStatusRefs: stableRefs(input.collectionStatusRefs),
    completionLedger: input.completionLedger,
  });
}

/** 将尚未终结的 Session 标记为 FAILED；由 app/workflow.ts 在基线等观察阶段失败时调用。 */
export function failObservation(
  current: ObservationSession,
  input: ObservationTransitionInput,
): StateTransition<ObservationSession> {
  if (current.state === "SEALED" || current.state === "FAILED") {
    throw new ContractViolation("OBSERVATION_IMMUTABLE", "Terminal ObservationSession is immutable");
  }
  return transitionSession(current, "FAILED", input, {});
}

/** 对封存后到达的记录生成诊断失败草稿；工作流或测试可调用，返回值不会修改已封存 Session。 */
export function rejectPostSealObservation(
  session: ObservationSession,
  input: {
    readonly occurredAt: string;
    readonly diagnosticArtifactRefs?: readonly Ref[];
  },
): FailureDraft {
  if (session.state !== "SEALED") {
    throw new ContractViolation(
      "SESSION_NOT_SEALED",
      "POST_SEAL_OBSERVATION applies only to a sealed Session",
    );
  }
  return {
    scope: session.scope,
    category: "OBSERVATION_FAILURE",
    origin: "EVALDOCK",
    actor: "COLLECTOR",
    phase: "OBSERVATION_POST_SEAL",
    severity: "WARNING",
    retryable: false,
    messageRedacted: "Observation arrived after the immutable Session seal",
    reasonCode: "POST_SEAL_OBSERVATION",
    evidenceRefs: [],
    artifactRefs: (input.diagnosticArtifactRefs ?? []) as FailureDraft["artifactRefs"],
    occurredAt: validateIsoDateTime(input.occurredAt),
  };
}

/** 统一校验 Session 状态机、时间顺序和引用排序并构造下一投影；由本文件所有生命周期入口调用。 */
function transitionSession(
  current: ObservationSession,
  toState: ObservationSessionState,
  input: ObservationTransitionInput,
  fields: Partial<ObservationSession>,
): StateTransition<ObservationSession> {
  assertLegalTransition(current.schema, current.state, toState);
  const occurredAt = validateIsoDateTime(input.occurredAt, "occurredAt");
  if (Date.parse(occurredAt) < Date.parse(current.updatedAt)) {
    throw new ContractViolation("TIME_ORDER_INVALID", "Session transition time moved backwards");
  }
  const mergedFailureRefs = stableRefs([
    ...current.failureRefs,
    ...(input.failureRefs ?? []),
  ]);
  const { projectionDigest: _discardedDigest, ...currentWithoutDigest } = current;
  const nextProjection = withProjectionDigest({
    ...currentWithoutDigest,
    ...fields,
    state: toState,
    revision: current.revision + 1,
    updatedAt: occurredAt,
    failureRefs: mergedFailureRefs,
  }) as ObservationSession;
  return {
    aggregateRef: refForProjection(current),
    expectedRevision: current.revision,
    fromState: current.state,
    toState,
    reasonCode: input.reasonCode,
    supportingRefs: stableRefs(input.supportingRefs ?? []),
    failureRefs: input.failureRefs ?? [],
    occurredAt,
    nextProjection,
  };
}

/** 校验封存账本恰含六个必需且顺序固定的项目；由 sealObservation 调用。 */
function validateCompletionLedger(ledger: CompletionLedger): void {
  if (ledger.length !== LEDGER_ORDER.length) {
    throw new ContractViolation(
      "INVALID_COMPLETION_LEDGER",
      "CompletionLedger must contain exactly the six MVP items",
    );
  }
  for (const [index, expectedKind] of LEDGER_ORDER.entries()) {
    const item = ledger[index];
    if (item?.kind !== expectedKind || item.required !== true) {
      throw new ContractViolation(
        "INVALID_COMPLETION_LEDGER",
        `CompletionLedger item ${index} must be required ${expectedKind}`,
      );
    }
    if (item.reasonCodes.some((code) => code.length === 0)) {
      throw new ContractViolation(
        "INVALID_COMPLETION_LEDGER",
        `${expectedKind} contains an empty reasonCode`,
      );
    }
  }
}

/** 按完整引用身份去重并稳定排序；由 Session、迁移和账本构造路径调用以保证摘要确定性。 */
function stableRefs<T extends Ref>(refs: readonly T[]): readonly T[] {
  const byIdentity = new Map<string, T>();
  for (const ref of refs) {
    const key = `${ref.schema}\u0000${ref.id}\u0000${ref.revision ?? ""}\u0000${ref.digest.value}`;
    byIdentity.set(key, ref);
  }
  return [...byIdentity.values()].sort((left, right) => {
    const leftKey = `${left.schema}\u0000${left.id}\u0000${left.revision ?? ""}`;
    const rightKey = `${right.schema}\u0000${right.id}\u0000${right.revision ?? ""}`;
    return leftKey.localeCompare(rightKey, "en");
  });
}

/** 创建单项完成证明并稳定化原因与支撑引用；由 app/workflow.ts 组装封存账本时调用。 */
export function ledgerItem(
  kind: CompletionLedgerItem["kind"],
  status: CompletionLedgerItem["status"],
  options: {
    readonly reasonCodes?: readonly string[];
    readonly supportingRefs?: readonly Ref[];
  } = {},
): CompletionLedgerItem {
  return {
    kind,
    required: true,
    status,
    reasonCodes: [...(options.reasonCodes ?? [])].sort(),
    supportingRefs: stableRefs(options.supportingRefs ?? []),
  };
}

/** 按 LEDGER_ORDER 将六项证明组装为 CompletionLedger；由 app/workflow.ts 在 sealObservation 前调用。 */
export function completionLedger(
  items: Readonly<Record<CompletionLedgerItem["kind"], CompletionLedgerItem>>,
): CompletionLedger {
  return LEDGER_ORDER.map((kind) => items[kind]) as unknown as CompletionLedger;
}
