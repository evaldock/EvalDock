/**
 * 文件职责：把独立文件传感器接入冻结观察计划，并将文件快照及采集完整性转换为可提交的领域记录和失败草稿。
 * 核心流程：登记传感器能力，校验执行请求与只读 Binding，按 BEFORE/AFTER/POST_RESET 捕获快照，再绑定已提交制品并生成 CollectionStatus。
 * 与其他文件的真实交互：调用 observer-lab/adapters/filesystem/sensor.ts 扫描与计算快照制品摘要；使用 core/models.ts 校验作用域和内容摘要；由 app/bootstrap.ts 实例化、app/workflow.ts 调用和持久化结果。
 * 公开接口：文件传感器描述与注册表摘要、捕获上下文/结果/接口、物化输入与函数、失败草稿函数、FileEnvironmentSensor、validateCaptureContext。
 */
import {
  ContractViolation,
  assertSameAttemptScope,
  digestEquals,
  digestValue,
  validateIsoDateTime,
  validateScope,
  validateStableId,
  withContentDigest,
  type ArtifactRef,
  type CollectionStatus,
  type ContentDigest,
  type FileSnapshot,
  type JsonObject,
  type ObservationExecutionRequest,
  type PreparedObserverBinding,
  type RawObservation,
  type Ref,
  type ScopeRef,
  type SensorAdapterDescriptor,
  type SourceDescriptor,
  type SourceRequirement,
} from "../../../src/core/models.js";
import type { FailureDraft, FailureRecord } from "../../../src/core/errors.js";
import {
  captureFileSnapshot,
  FILE_SENSOR_CAPABILITIES,
  FILE_SENSOR_CAPABILITY_DIGEST,
  FILE_SENSOR_IMPLEMENTATION_ID,
  FILE_SENSOR_IMPLEMENTATION_VERSION,
  fileSnapshotArtifactDigest,
  type FileSnapshotDraft,
} from "./sensor.js";

/** 将文件传感器实现身份、版本和能力冻结为观察计划可引用的适配器描述。 */
export const FILE_SENSOR_DESCRIPTOR: SensorAdapterDescriptor = Object.freeze({
  implementationId: validateStableId<"SensorImplementationId">(FILE_SENSOR_IMPLEMENTATION_ID),
  implementationVersion: FILE_SENSOR_IMPLEMENTATION_VERSION,
  capabilityDigest: FILE_SENSOR_CAPABILITY_DIGEST,
  sourceType: "FILESYSTEM",
  capabilities: FILE_SENSOR_CAPABILITIES,
});

/** MVP Bootstrap 使用的单项静态传感器注册表摘要，用于运行期漂移校验。 */
export const FILE_SENSOR_REGISTRY_DIGEST: ContentDigest = digestValue([FILE_SENSOR_DESCRIPTOR]);

/** 文件传感器在一次 Attempt 生命周期中的三个采集时点。 */
export type EnvironmentCaptureKind = "BEFORE" | "AFTER" | "POST_RESET";

/** 工作流交给文件传感器的冻结请求、Binding 选择键和本地读取参数。 */
export interface EnvironmentCaptureContext {
  readonly request: ObservationExecutionRequest;
  readonly sourceRequirementId: string;
  readonly expectedSensorRegistryDigest: ContentDigest;
  readonly rootPath: string;
  readonly snapshotId: string;
  readonly attemptId: string;
  readonly maxFileBytes: number;
  readonly now?: () => string;
}

/** 一次捕获返回的快照草稿及经验证的来源和 Binding 身份。 */
export interface EnvironmentCapture {
  readonly snapshot: FileSnapshotDraft;
  readonly sourceRequirement: SourceRequirement;
  /** 仅保留 Binding 标识；读取令牌始终停留在进程内。 */
  readonly bindingId: string;
}

/** Bootstrap 注册的环境观察端口，按生命周期阶段暴露三种只读捕获。 */
export interface EnvironmentSensor {
  readonly descriptor: SensorAdapterDescriptor;
  /** 捕获目标运行前基线；工作流的基线阶段调用。 */
  captureBefore(context: EnvironmentCaptureContext): Promise<EnvironmentCapture>;
  /** 捕获目标终止后的最终状态；工作流的排空阶段调用。 */
  captureAfter(context: EnvironmentCaptureContext): Promise<EnvironmentCapture>;
  /** 捕获重置后的验证状态；工作流的清理阶段调用。 */
  verifyReset(context: EnvironmentCaptureContext): Promise<EnvironmentCapture>;
}

/** 将已提交 FileSnapshot 及其原始制品绑定为 RawObservation 的输入。 */
export interface MaterializeFileObservationInput {
  readonly observationId: string;
  readonly scope: ScopeRef;
  readonly snapshot: FileSnapshot;
  readonly snapshotRef: Ref<FileSnapshot>;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly snapshotArtifact: ArtifactRef;
  readonly snapshotArtifactRef: Ref<ArtifactRef>;
  readonly createdAt: string;
  readonly producerVersion: string;
}

/** 将 FileSnapshot 绑定回已提交的原始清单制品；由 app/workflow.ts 在每个文件采集阶段调用。 */
export function materializeFileObservation(
  input: MaterializeFileObservationInput,
): RawObservation {
  const scope = validateScope(input.scope);
  if (scope.attemptId === undefined || input.snapshot.attemptId !== scope.attemptId) {
    throw new ContractViolation("SCOPE_MISMATCH", "File observation requires matching Attempt Scope");
  }
  assertSameAttemptScope(scope, input.snapshot.scope, input.snapshotArtifact.scope);
  if (
    !digestEquals(input.snapshot.contentDigest, input.snapshotRef.digest) ||
    input.snapshot.snapshotId !== input.snapshotRef.id ||
    !digestEquals(input.snapshotArtifact.contentDigest, input.snapshotArtifactRef.digest) ||
    input.snapshotArtifact.artifactId !== input.snapshotArtifactRef.id ||
    !digestEquals(
      input.snapshotArtifact.artifactContentDigest,
      fileSnapshotArtifactDigest(input.snapshot),
    )
  ) {
    throw new ContractViolation(
      "EVIDENCE_INTEGRITY",
      "File Snapshot or raw Artifact does not match its committed Ref",
    );
  }
  const captureMetadata: JsonObject = {
    snapshotRef: refJson(input.snapshotRef),
    phase: input.snapshot.phase,
    entryCount: input.snapshot.entries.length,
    rootBinding: input.snapshot.rootBinding,
  };
  return withContentDigest({
    schema: "evaldock.mvp.raw-observation/v1" as const,
    observationId: validateStableId<"ObservationId">(input.observationId, "observationId"),
    scope,
    attemptId: scope.attemptId,
    sourceRef: input.sourceRef,
    externalEventType: `file/snapshot/${input.snapshot.phase}`,
    sourceTime: {
      observedAt: input.snapshot.scanCompletedAt,
      clockDomain: "evaldock-file-sensor",
    },
    payloadArtifactRef: input.snapshotArtifactRef,
    captureMetadata,
    rawDigest: input.snapshotArtifact.artifactContentDigest,
    createdAt: input.createdAt,
    producerVersion: input.producerVersion,
  });
}

/** 汇总一次文件来源采集状态所需的快照集合、必需阶段与稳定窗口结果。 */
export interface MaterializeFileCollectionStatusInput {
  readonly collectionStatusId: string;
  readonly scope: ScopeRef;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly snapshots: readonly FileSnapshot[];
  readonly openedAt: string;
  readonly closedAt: string;
  readonly requiredPhases: readonly ("BEFORE" | "AFTER" | "POST_RESET")[];
  readonly stableWindowComplete?: boolean;
  readonly failureRefs?: readonly Ref<FailureRecord>[];
  readonly createdAt: string;
  readonly producerVersion: string;
}

/** 根据缺失阶段、部分快照和稳定窗口生成 CollectionStatus；由 app/workflow.ts 在基线、排空和重置采集后调用。 */
export function materializeFileCollectionStatus(
  input: MaterializeFileCollectionStatusInput,
): CollectionStatus {
  const scope = validateScope(input.scope);
  for (const snapshot of input.snapshots) {
    assertSameAttemptScope(scope, snapshot.scope);
  }
  const phaseSet = new Set(input.snapshots.map((snapshot) => snapshot.phase));
  if (
    phaseSet.size !== input.snapshots.length ||
    input.snapshots.some((snapshot) => !input.requiredPhases.includes(snapshot.phase))
  ) {
    throw new ContractViolation(
      "FILE_PHASE_SET_INVALID",
      "File CollectionStatus requires one Snapshot for each requested phase and no extra phase",
    );
  }
  const missingPhases = input.requiredPhases.filter((phase) => !phaseSet.has(phase));
  const partialSnapshots = input.snapshots.filter(
    (snapshot) => snapshot.completeness !== "COMPLETE",
  );
  const stableIncomplete = input.stableWindowComplete === false;
  const gaps = [
    ...missingPhases.map((phase) => ({
      kind: "MISSING_PHASE",
      reasonCode: `FILE_${phase}_MISSING`,
      detail: { phase },
    })),
    ...partialSnapshots.map((snapshot) => ({
      kind: "PARTIAL_SNAPSHOT",
      reasonCode: `FILE_${snapshot.phase}_PARTIAL`,
      detail: { snapshotId: String(snapshot.snapshotId) },
    })),
    ...(stableIncomplete
      ? [
          {
            kind: "STABLE_WINDOW",
            reasonCode: "STABLE_WINDOW_INCOMPLETE",
            detail: { complete: false },
          },
        ]
      : []),
  ];
  const completeness = gaps.length === 0 ? "COMPLETE" : "PARTIAL";
  return withContentDigest({
    schema: "evaldock.mvp.collection-status/v1" as const,
    collectionStatusId: validateStableId<"CollectionStatusId">(
      input.collectionStatusId,
      "collectionStatusId",
    ),
    scope,
    sourceRef: input.sourceRef,
    openedAt: input.openedAt,
    closedAt: input.closedAt,
    recordCount: input.snapshots.length,
    finalWatermark: {
      phases: input.snapshots.map((snapshot) => snapshot.phase).sort(),
      stableWindowComplete: !stableIncomplete,
    },
    gaps,
    truncated: false,
    health: completeness === "COMPLETE" ? "HEALTHY" : "DEGRADED",
    completeness,
    failureRefs: input.failureRefs ?? [],
    createdAt: input.createdAt,
    producerVersion: input.producerVersion,
  });
}

/** 将文件来源的不完整原因去重并转换为持久化失败草稿；由 app/workflow.ts 在生成 CollectionStatus 前调用。 */
export function fileCollectionFailureDrafts(input: {
  readonly scope: ScopeRef;
  readonly snapshots: readonly FileSnapshot[];
  readonly requiredPhases: readonly ("BEFORE" | "AFTER" | "POST_RESET")[];
  readonly stableWindowComplete?: boolean;
  readonly occurredAt: string;
  readonly artifactRefs?: readonly Ref<ArtifactRef>[];
}): readonly FailureDraft[] {
  const scope = validateScope(input.scope);
  const phases = new Set(input.snapshots.map((snapshot) => snapshot.phase));
  const reasonCodes = [
    ...input.requiredPhases
      .filter((phase) => !phases.has(phase))
      .map((phase) => `FILE_${phase}_MISSING`),
    ...input.snapshots
      .filter((snapshot) => snapshot.completeness !== "COMPLETE")
      .map((snapshot) => `FILE_${snapshot.phase}_PARTIAL`),
    ...(input.stableWindowComplete === false ? ["STABLE_WINDOW_INCOMPLETE"] : []),
  ];
  return [...new Set(reasonCodes)].sort().map((reasonCode) => ({
    scope,
    category: "OBSERVATION_FAILURE" as const,
    origin: "EVALDOCK" as const,
    actor: "COLLECTOR" as const,
    phase: "FILE_DRAIN",
    severity: "ERROR" as const,
    retryable: false as const,
    messageRedacted: `Independent File collection is incomplete (${reasonCode})`,
    reasonCode,
    evidenceRefs: [],
    artifactRefs: input.artifactRefs ?? [],
    occurredAt: validateIsoDateTime(input.occurredAt, "occurredAt"),
  }));
}

/**
 * MVP 的文件系统 EnvironmentSensor 实现；由 app/bootstrap.ts 注册，方法先验证只读 Binding，再委托 sensors/file.ts 捕获快照。
 */
export class FileEnvironmentSensor implements EnvironmentSensor {
  public readonly descriptor = FILE_SENSOR_DESCRIPTOR;

  /** 执行 BEFORE 捕获；由 app/workflow.ts 基线阶段通过 EnvironmentSensor 端口调用。 */
  public async captureBefore(context: EnvironmentCaptureContext): Promise<EnvironmentCapture> {
    return this.capture("BEFORE", context);
  }

  /** 执行 AFTER 捕获；由 app/workflow.ts 在目标终止后的稳定窗口阶段调用。 */
  public async captureAfter(context: EnvironmentCaptureContext): Promise<EnvironmentCapture> {
    return this.capture("AFTER", context);
  }

  /** 执行 POST_RESET 捕获；由 app/workflow.ts 在环境重置后调用。 */
  public async verifyReset(context: EnvironmentCaptureContext): Promise<EnvironmentCapture> {
    return this.capture("POST_RESET", context);
  }

  /** 统一校验阶段与 Binding 并调用 captureFileSnapshot；由三个公开捕获方法复用。 */
  private async capture(
    kind: EnvironmentCaptureKind,
    context: EnvironmentCaptureContext,
  ): Promise<EnvironmentCapture> {
    const { requirement, binding } = validateCaptureContext(kind, context, this.descriptor);
    const snapshot = await captureFileSnapshot({
      snapshotId: context.snapshotId,
      attemptId: context.attemptId,
      phase: kind,
      rootPath: context.rootPath,
      rootBinding: requirement.resourceBinding,
      maxFileBytes: Math.min(context.maxFileBytes, requirement.maxBytes),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
    return {
      snapshot,
      sourceRequirement: requirement,
      bindingId: binding.bindingId,
    };
  }
}

/**
 * 校验注册表摘要、请求阶段、Attempt/代次、来源实现和只读授权；由 FileEnvironmentSensor.capture 调用，测试也直接验证其契约。
 */
export function validateCaptureContext(
  kind: EnvironmentCaptureKind,
  context: EnvironmentCaptureContext,
  descriptor: SensorAdapterDescriptor = FILE_SENSOR_DESCRIPTOR,
  expectedSourceType = "FILESYSTEM",
  requireWorkspaceBinding = true,
): { readonly requirement: SourceRequirement; readonly binding: PreparedObserverBinding } {
  if (!digestEquals(context.request.sensorRegistryDigest, context.expectedSensorRegistryDigest)) {
    throw new ContractViolation(
      "SENSOR_REGISTRY_DRIFT",
      "Runtime Sensor registry digest differs from the frozen registry digest",
    );
  }
  if (kind === "POST_RESET" && context.request.kind !== "POST_RESET") {
    throw new ContractViolation(
      "INVALID_OBSERVATION_REQUEST",
      "POST_RESET capture requires a POST_RESET ObservationExecutionRequest",
    );
  }
  if (kind !== "POST_RESET" && context.request.kind !== "CASE_RUN") {
    throw new ContractViolation(
      "INVALID_OBSERVATION_REQUEST",
      `${kind} capture requires a CASE_RUN ObservationExecutionRequest`,
    );
  }
  if (context.request.environment.attemptId !== context.attemptId) {
    throw new ContractViolation("SCOPE_MISMATCH", "Capture Attempt does not match Environment");
  }
  if (
    context.request.observationPlan.scope.attemptId !== undefined &&
    context.request.observationPlan.scope.attemptId !== context.request.environment.attemptId
  ) {
    throw new ContractViolation("SCOPE_MISMATCH", "ObservationPlan and Environment Attempts differ");
  }

  const requirement = context.request.observationPlan.sourceRequirements.find(
    (candidate) => candidate.sourceRequirementId === context.sourceRequirementId,
  );
  if (requirement === undefined || requirement.sourceType !== expectedSourceType) {
    throw new ContractViolation(
      "SOURCE_REQUIREMENT_MISMATCH",
      `Frozen ${expectedSourceType} SourceRequirement was not found`,
    );
  }
  const matchingBindings = context.request.preparedBindings.filter(
    (candidate) => candidate.sourceRequirementId === requirement.sourceRequirementId,
  );
  if (matchingBindings.length !== 1) {
    throw new ContractViolation(
      "OBSERVER_BINDING_MISMATCH",
      "Exactly one prepared Binding is required for the frozen SourceRequirement",
    );
  }
  const binding = matchingBindings[0]!;
  if (
    binding.environmentInstanceId !== context.request.environment.environmentInstanceId ||
    binding.resetGeneration !== context.request.environment.resetGeneration ||
    (context.request.kind === "POST_RESET" &&
      binding.resetGeneration !== context.request.resetGeneration)
  ) {
    throw new ContractViolation(
      "OBSERVER_BINDING_GENERATION_MISMATCH",
      "Prepared Binding does not belong to the current Environment generation",
    );
  }
  if (
    binding.resourceBinding !== requirement.resourceBinding ||
    (requireWorkspaceBinding &&
      binding.resourceBinding !== context.request.environment.workspaceBinding)
  ) {
    throw new ContractViolation(
      "OBSERVER_RESOURCE_MISMATCH",
      "Binding, SourceRequirement and Environment resource bindings must match",
    );
  }
  if (
    binding.sensorImplementationId !== descriptor.implementationId ||
    binding.sensorImplementationId !== requirement.sensorImplementationId ||
    binding.sensorImplementationVersion !== descriptor.implementationVersion ||
    binding.sensorImplementationVersion !== requirement.sensorImplementationVersion ||
    !digestEquals(binding.sensorCapabilityDigest, descriptor.capabilityDigest) ||
    !digestEquals(binding.sensorCapabilityDigest, requirement.sensorCapabilityDigest)
  ) {
    throw new ContractViolation(
      "SENSOR_IMPLEMENTATION_DRIFT",
      "Runtime File Sensor identity differs from the frozen SourceRequirement",
    );
  }

  const requiredOperations = kind === "AFTER" ? ["READ", "SNAPSHOT", "DRAIN"] : ["READ", "SNAPSHOT"];
  if (
    binding.allowedOperations.some(
      (operation) => operation !== "READ" && operation !== "SNAPSHOT" && operation !== "DRAIN",
    ) ||
    requiredOperations.some((operation) => !binding.allowedOperations.includes(operation as never))
  ) {
    throw new ContractViolation(
      "OBSERVER_GRANT_NOT_READ_ONLY",
      `Prepared Binding lacks the read-only operations required for ${kind}`,
    );
  }
  if (binding.readCapabilityToken.length === 0) {
    throw new ContractViolation("OBSERVER_TOKEN_MISSING", "Prepared Binding has no read capability token");
  }
  if (Date.parse(binding.expiresAt) <= Date.now()) {
    throw new ContractViolation("OBSERVER_GRANT_EXPIRED", "Prepared Binding has expired");
  }

  const expectedGrantDigest = digestValue(binding, ["grantDigest", "readCapabilityToken"]);
  if (!digestEquals(binding.grantDigest, expectedGrantDigest)) {
    throw new ContractViolation("OBSERVER_GRANT_INVALID", "Prepared Binding grant digest is invalid");
  }
  return { requirement, binding };
}

/** 将领域 Ref 转换为可嵌入 RawObservation 元数据的 JSON；由 materializeFileObservation 调用。 */
function refJson(ref: Ref): JsonObject {
  return {
    schema: ref.schema,
    id: String(ref.id),
    digest: {
      algorithm: ref.digest.algorithm,
      value: ref.digest.value,
      byteLength: ref.digest.byteLength,
    },
    ...(ref.revision === undefined ? {} : { revision: ref.revision }),
  };
}
