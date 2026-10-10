/**
 * 将选定 Case、环境与 Probe 配置冻结为执行计划。
 * SourceRequirements 来自环境组件和 Probe，不从标签推导。
 * 不定义评分标准，不创建证据契约，不调用 Judge。
 */
import {
  cancelled,
  failed,
  rejected,
  succeeded,
} from "../core/contracts.js";
import type {
  ArtifactCommitMetadata,
  EvaluationAssetMatchingInput,
  EvaluationAssetMatchingPort,
  OperationContext,
  PlanArtifactMaterializer,
  PortResult,
} from "../core/contracts.js";
import type { FailureDraft, FailureOrigin } from "../core/errors.js";
import {
  ContractViolation,
  assertDigestEquals,
  canonicalize,
  digestBytes,
  digestEquals,
  digestValue,
  validateContentDigest,
  validateIsoDateTime,
  validatePortablePath,
  validateStableId,
  validateVersionedAssetId,
} from "../core/models.js";
import type {
  AgentTracePlan,
  ArtifactRef,
  AssetIdentifier,
  CasePlan,
  ConfigSnapshot,
  ContentDigest,
  EvaluationPlan,
  CaseExecutionInput,
  InspectionSnapshot,
  IsoDateTime,
  JsonValue,
  ObservationPlan,
  PlanBuildResult,
  PlanGap,
  Ref,
  ScopeRef,
  SensorAdapterDescriptor,
  SourceRequirement,
  StableId,
  TargetSnapshot,
} from "../core/models.js";

/** V0.1 Planner 接受并要求已配置的 Runtime Probe schema。 */
const REQUIRED_PROBE_SCHEMA = "dsh-eval.probe/v1";

/** 平台 Preflight 向 Planner 声明的安全、持久化和 Observer 能力集合。 */
export interface PlanningCapabilities {
  readonly observerReadOnly: boolean;
  readonly identitySeparation: boolean;
  readonly atomicArtifactCommit: boolean;
  readonly pathIsolation: boolean;
  readonly networkDefaultDeny: boolean;
  readonly targetHiddenRootsDenied: boolean;
  readonly probeArmedBeforeHeadless: boolean;
  readonly observerOperations: readonly ("READ" | "SNAPSHOT" | "DRAIN")[];
}

/** 任务文本和公开输入提交后的 Ref 与内容摘要。 */
interface MaterializedTask {
  readonly taskRef: Ref<ArtifactRef>;
  readonly visibleInputRefs: readonly Ref<ArtifactRef>[];
  readonly taskContentDigest: ContentDigest;
  readonly inputContentDigests: readonly ContentDigest[];
}

/** 将 Case/配置中的未知字段窄化为 JSON 对象。 */
function asObject(value: unknown, fieldName: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation("INVALID_PLAN_INPUT", `${fieldName} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

/** 将 Case/配置中的未知字段窄化为 JSON 数组。 */
function asArray(value: unknown, fieldName: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new ContractViolation("INVALID_PLAN_INPUT", `${fieldName} must be an array`);
  }
  return value;
}

/** 读取规划输入中的必填非空字符串。 */
function asString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractViolation("INVALID_PLAN_INPUT", `${fieldName} must be a non-empty string`);
  }
  return value;
}

/** 读取规划输入中的正安全整数预算。 */
function asPositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ContractViolation("INVALID_PLAN_INPUT", `${fieldName} must be a positive integer`);
  }
  return Number(value);
}

/** 从 schema、稳定 ID 和摘要创建冻结 Ref，供各专用 Ref helper 复用。 */
function refFor<T>(schema: string, id: StableId, digest: ContentDigest): Ref<T> {
  return Object.freeze({ schema, id, digest });
}

/** 把已提交 ArtifactRef 转换为计划关系使用的轻量 Ref。 */
function artifactRefFor(artifact: ArtifactRef): Ref<ArtifactRef> {
  return refFor(artifact.schema, artifact.artifactId, artifact.contentDigest);
}

/** 为 EvaluationPlan 构造 TargetSnapshot 引用。 */
function snapshotRef(snapshot: TargetSnapshot): Ref<TargetSnapshot> {
  return refFor(snapshot.schema, snapshot.targetSnapshotId, snapshot.contentDigest);
}

/** 为 EvaluationPlan 构造 InspectionSnapshot 引用。 */
function inspectionRef(inspection: InspectionSnapshot): Ref<InspectionSnapshot> {
  return refFor(inspection.schema, inspection.inspectionId, inspection.contentDigest);
}

/** 为 EvaluationPlan 构造 CaseExecutionInput 引用。 */
function executionInputRef(pack: CaseExecutionInput): Ref<CaseExecutionInput> {
  return refFor(pack.schema, pack.inputId, pack.contentDigest);
}

/** 创建 PLAN 阶段脱敏 FailureDraft，供 Planner 的取消、拒绝和异常路径复用。 */
function failureDraft(
  scope: ScopeRef,
  occurredAt: IsoDateTime,
  reasonCode: string,
  messageRedacted: string,
  category: FailureDraft["category"] = "PLAN_UNSATISFIABLE",
  origin: FailureOrigin = "EVALDOCK",
): FailureDraft {
  return Object.freeze({
    scope,
    category,
    origin,
    actor: "PLANNING" as const,
    phase: "PLAN",
    severity: "ERROR" as const,
    retryable: false as const,
    messageRedacted,
    reasonCode,
    evidenceRefs: Object.freeze([]),
    artifactRefs: Object.freeze([]),
    occurredAt,
  });
}

/** 创建结构化 PlanGap，供所有能力与输入匹配 helper 返回。 */
function gap(
  code: string,
  messageRedacted: string,
  affectedIds: readonly AssetIdentifier[] = [],
): PlanGap {
  return Object.freeze({ code, messageRedacted, affectedIds: Object.freeze([...affectedIds]) });
}

/** 重算并验证一项冻结输入的 contentDigest。 */
function validateFrozenDigest(record: object, label: string): void {
  const source = record as Record<string, unknown>;
  const declared = validateContentDigest(source.contentDigest, `${label}.contentDigest`);
  assertDigestEquals(digestValue(source, ["contentDigest"]), declared, `${label.toUpperCase()}_DIGEST_MISMATCH`);
}

/** 从 Inspector JSON 事实读取状态字段。 */
function inspectionStatus(value: JsonValue, field: string): string | undefined {
  const object = asObject(value, field);
  return typeof object.status === "string" ? object.status : undefined;
}

/** 从 Inspector 的 DSH 版本事实读取已确认版本。 */
function inspectionVersion(value: JsonValue): string | undefined {
  const object = asObject(value, "inspection.dshVersionStatus");
  return typeof object.version === "string" ? object.version : undefined;
}

/**
 * 将 执行输入的每项 SourceRequirement 与 Sensor 注册表精确匹配，并检查注册项规范性；
 * findPlanGaps 调用并合并返回的缺口。
 */
export function registryGapForSensors(
  requirements: readonly SourceRequirement[],
  sensors: readonly SensorAdapterDescriptor[],
): PlanGap[] {
  const gaps: PlanGap[] = [];
  const sensorKeys = sensors.map((sensor) => `${sensor.sourceType}:${sensor.implementationId}`);
  if (new Set(sensorKeys).size !== sensorKeys.length) {
    gaps.push(gap("SENSOR_REGISTRY_AMBIGUOUS", "Sensor registry contains duplicate source/ID entries"));
  }
  for (const sensor of sensors) {
    const sortedCapabilities = [...sensor.capabilities].sort();
    if (
      new Set(sortedCapabilities).size !== sortedCapabilities.length ||
      sortedCapabilities.some((capability, index) => capability !== sensor.capabilities[index])
    ) {
      gaps.push(
        gap(
          "SENSOR_CAPABILITIES_NON_CANONICAL",
          `Sensor ${sensor.implementationId} capabilities are not a stable sorted set`,
          [sensor.implementationId],
        ),
      );
      continue;
    }
    const calculated = digestValue(sortedCapabilities);
    if (!digestEquals(calculated, sensor.capabilityDigest)) {
      gaps.push(
        gap(
          "SENSOR_CAPABILITY_DIGEST_INVALID",
          `Sensor ${sensor.implementationId} capability digest is invalid`,
          [sensor.implementationId],
        ),
      );
    }
  }
  for (const requirement of requirements) {
    const exact = sensors.find(
      (sensor) =>
        sensor.sourceType === requirement.sourceType &&
        sensor.implementationId === requirement.sensorImplementationId &&
        sensor.implementationVersion === requirement.sensorImplementationVersion &&
        (requirement.requiredCapabilities === undefined
          ? digestEquals(sensor.capabilityDigest, requirement.sensorCapabilityDigest)
          : digestEquals(digestValue([...requirement.requiredCapabilities].sort()), requirement.sensorCapabilityDigest) &&
            requirement.requiredCapabilities.every((capability) => sensor.capabilities.includes(capability))),
    );
    if (exact === undefined) {
      gaps.push(
        gap(
          "MANDATORY_SENSOR_UNAVAILABLE",
          `Mandatory ${requirement.sourceType} Sensor triple is unavailable`,
          [requirement.sourceRequirementId, requirement.sensorImplementationId],
        ),
      );
    }
  }
  return gaps;
}

/** 检查平台是否提供 V0.1 运行所需的全部隔离、提交、网络和 Observer 能力。 */
function capabilityGaps(
  capabilities: PlanningCapabilities,
  sessionTraceFallback: boolean,
): PlanGap[] {
  const gaps: PlanGap[] = [];
  /** 必须由平台 Preflight 全部确认的布尔能力注册表。 */
  const requiredBooleans = [
    ["observerReadOnly", capabilities.observerReadOnly],
    ["identitySeparation", capabilities.identitySeparation],
    ["atomicArtifactCommit", capabilities.atomicArtifactCommit],
    ["pathIsolation", capabilities.pathIsolation],
    ["networkDefaultDeny", capabilities.networkDefaultDeny],
    ["targetHiddenRootsDenied", capabilities.targetHiddenRootsDenied],
    ...(
      sessionTraceFallback
        ? []
        : [["probeArmedBeforeHeadless", capabilities.probeArmedBeforeHeadless] as const]
    ),
  ] as const;
  for (const [name, available] of requiredBooleans) {
    if (!available) {
      gaps.push(
        gap(
          `VM_${name.replaceAll(/([A-Z])/gu, "_$1").toUpperCase()}_UNAVAILABLE`,
          `Required VM planning capability ${name} is unavailable`,
        ),
      );
    }
  }
  const operations = [...new Set(capabilities.observerOperations)].sort();
  if (
    operations.length !== 3 ||
    operations[0] !== "DRAIN" ||
    operations[1] !== "READ" ||
    operations[2] !== "SNAPSHOT"
  ) {
    gaps.push(
      gap(
        "VM_OBSERVER_OPERATIONS_INVALID",
        "Observer must have exactly READ, SNAPSHOT and DRAIN operations",
      ),
    );
  }
  return gaps;
}

/** 检查冻结 Config 的截止时间、稳定窗口、产物预算和隔离等级能否满足 Case。 */
function configGaps(config: ConfigSnapshot, pack: CaseExecutionInput): PlanGap[] {
  const gaps: PlanGap[] = [];
  const scenarioExecution = asObject(pack.scenario.execution, "scenario.execution");
  const scenarioDeadline = asPositiveInteger(
    scenarioExecution.deadlineMs,
    "scenario.execution.deadlineMs",
  );
  const stableWindow = asPositiveInteger(
    scenarioExecution.stableWindowMs,
    "scenario.execution.stableWindowMs",
  );
  if (config.caseDeadlineMs < scenarioDeadline || config.runDeadlineMs < config.caseDeadlineMs) {
    gaps.push(
      gap("DEADLINE_INSUFFICIENT", "Frozen Config deadlines cannot satisfy the selected Case"),
    );
  }
  if (config.stableWindowMs < stableWindow || config.stableMaxWaitMs < config.stableWindowMs) {
    gaps.push(
      gap(
        "STABLE_WINDOW_INSUFFICIENT",
        "Frozen Config stable-window budget cannot satisfy the pack",
      ),
    );
  }
  const largestSource = Math.max(...pack.sourceRequirements.map((requirement) => requirement.maxBytes));
  if (config.maxArtifactBytes < largestSource) {
    gaps.push(
      gap("ARTIFACT_BUDGET_INSUFFICIENT", "Frozen artifact byte budget is below source requirements"),
    );
  }
  if (
    config.minimumIsolationLevel !== "AGENT_SEPARATED" &&
    config.minimumIsolationLevel !== "SESSION_SEPARATED"
  ) {
    gaps.push(gap("ISOLATION_LEVEL_UNSUPPORTED", "The configured isolation level is unsupported"));
  }
  return gaps;
}

/**
 * 对全部冻结输入与显式能力做确定性匹配，汇总、去重并排序 PlanGap；
 * ExecutionPlanCompiler.buildPlan 在提交任务产物前调用，测试也直接验证此纯匹配结果。
 */
export function findPlanGaps(
  input: EvaluationAssetMatchingInput,
  capabilities: PlanningCapabilities,
): readonly PlanGap[] {
  const { targetSnapshot, inspectionSnapshot, caseInput, configSnapshot } = input;
  const gaps: PlanGap[] = [];
  try {
    validateFrozenDigest(targetSnapshot, "target snapshot");
    validateFrozenDigest(inspectionSnapshot, "inspection snapshot");
    validateFrozenDigest(caseInput, "case execution input");
    validateFrozenDigest(configSnapshot, "config snapshot");
  } catch {
    gaps.push(gap("FROZEN_INPUT_DIGEST_INVALID", "A frozen Planning input failed digest validation"));
  }

  const runtimeTargetKind = (targetSnapshot as unknown as Record<string, unknown>).targetType;
  if (runtimeTargetKind !== undefined && runtimeTargetKind !== "FULL_AGENT") {
    gaps.push(gap("UNSUPPORTED_TARGET_KIND", "MVP supports only FULL_AGENT targets"));
  }
  if (
    inspectionSnapshot.targetSnapshotRef.id !== targetSnapshot.targetSnapshotId ||
    !digestEquals(inspectionSnapshot.targetSnapshotRef.digest, targetSnapshot.contentDigest)
  ) {
    gaps.push(gap("INSPECTION_TARGET_MISMATCH", "Inspection is not bound to the frozen target"));
  }
  const status = inspectionStatus(
    inspectionSnapshot.dshVersionStatus,
    "inspection.dshVersionStatus",
  );
  const inspectedVersion = inspectionVersion(inspectionSnapshot.dshVersionStatus);
  if (
    !targetSnapshot.dshPackageVersion ||
    status !== "KNOWN" ||
    inspectedVersion !== targetSnapshot.dshPackageVersion
  ) {
    gaps.push(
      gap(
        "DSH_VERSION_UNSATISFIED",
        `DSH package version must be frozen and match the Inspector`,
      ),
    );
  }
  const sessionTraceFallback = configSnapshot.minimumIsolationLevel === "SESSION_SEPARATED";
  if (!sessionTraceFallback) {
    if (inspectionSnapshot.probeConfigured !== true) {
      gaps.push(gap("PROBE_NOT_CONFIRMED", "Runtime Probe configuration is not confirmed"));
    }
    if (inspectionSnapshot.probeSchema !== REQUIRED_PROBE_SCHEMA) {
      gaps.push(gap("PROBE_SCHEMA_UNSATISFIED", `Runtime Probe schema is missing or incompatible`));
    }
    if (inspectionSnapshot.probeOrderStatus !== "VALID") {
      gaps.push(gap("PROBE_ORDER_UNSATISFIED", `Runtime Probe must be armed before Headless`));
    }
  }
  if (inspectionSnapshot.headlessDriverStatus !== "COMPATIBLE") {
    gaps.push(gap("HEADLESS_DRIVER_UNSATISFIED", `Frozen Headless Driver is incompatible`));
  }
  if (inspectionSnapshot.permissionPreset === "UNKNOWN" || inspectionSnapshot.sandboxMode === "UNKNOWN") {
    gaps.push(
      gap("PERMISSION_FACTS_UNKNOWN", `Permission preset and sandbox mode must be explicitly known`),
    );
  }
  for (const limitation of inspectionSnapshot.limitations) {
    const record = limitation === null || typeof limitation !== "object" || Array.isArray(limitation)
      ? undefined
      : limitation as Record<string, JsonValue>;
    const code = typeof record?.code === "string" ? record.code : undefined;
    if (
      !sessionTraceFallback &&
      code !== undefined &&
      code.startsWith("PROBE_") &&
      (record?.status === "UNKNOWN" || record?.status === "ABSENT")
    ) {
      gaps.push(gap(code, "A mandatory Runtime Probe capability is unknown or absent"));
    }
  }
  gaps.push(...registryGapForSensors(caseInput.sourceRequirements, input.sensors));
  gaps.push(...capabilityGaps(capabilities, sessionTraceFallback));
  gaps.push(...configGaps(configSnapshot, caseInput));

  if (caseInput.sourceRequirements.length === 0 ||
      new Set(caseInput.sourceRequirements.map((source) => source.sourceRequirementId)).size !==
        caseInput.sourceRequirements.length) {
    gaps.push(gap("SOURCE_SET_INVALID", "Case input must declare at least one uniquely identified observation source"));
  }

  const unique = new Map<string, PlanGap>();
  for (const current of gaps) {
    const key = `${current.code}:${current.affectedIds.join(",")}`;
    if (!unique.has(key)) unique.set(key, current);
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) =>
      `${left.code}:${left.affectedIds.join(",")}`.localeCompare(
        `${right.code}:${right.affectedIds.join(",")}`,
        "en",
      ),
    ),
  );
}

/** 从 TargetSnapshot 构造规划与规划产物使用的目标快照级作用域。 */
function planningScope(target: TargetSnapshot): ScopeRef {
  return Object.freeze({
    targetId: target.targetId,
    targetSnapshotId: target.targetSnapshotId,
  });
}

/** 调用受限 Materializer 提交规划产物，并验证返回 ArtifactRef 与请求元数据和字节一致。 */
async function commitPlanningArtifact(
  context: OperationContext,
  materializer: PlanArtifactMaterializer,
  metadata: ArtifactCommitMetadata,
  bytes: Uint8Array,
): Promise<PortResult<ArtifactRef>> {
  const result = await materializer.commit(context, bytes, metadata);
  if (result.status !== "SUCCEEDED") return result;
  const artifact = result.value;
  if (
    artifact.schema !== "evaldock.mvp.artifact/v1" ||
    artifact.state !== "COMMITTED" ||
    artifact.artifactId !== metadata.artifactId ||
    artifact.scope.targetId !== metadata.scope.targetId ||
    artifact.scope.targetSnapshotId !== metadata.scope.targetSnapshotId ||
    artifact.byteLength !== bytes.byteLength ||
    !digestEquals(artifact.artifactContentDigest, digestBytes(bytes))
  ) {
    return failed(
      failureDraft(
        metadata.scope,
        metadata.createdAt,
        "PLAN_ARTIFACT_COMMIT_INVALID",
        "Artifact materializer returned an invalid committed reference",
        "PERSISTENCE_FAILURE",
      ),
    );
  }
  return result;
}

/** 用冻结 Config 补全规划产物的身份、作用域、媒体、版本和脱敏元数据。 */
function artifactMetadata(
  id: string,
  scope: ScopeRef,
  artifactType: string,
  logicalName: string,
  mediaType: string,
  config: ConfigSnapshot,
): ArtifactCommitMetadata {
  return Object.freeze({
    artifactId: validateStableId<"ArtifactId">(id, "artifactId"),
    scope,
    artifactType,
    logicalName,
    mediaType,
    producerVersion: config.evaldockVersion,
    createdAt: validateIsoDateTime(config.createdAt, "ConfigSnapshot.createdAt"),
    sensitivity: "EXPORTABLE" as const,
    redactionState: "NOT_REQUIRED" as const,
  });
}

/** 将产物提交的非成功结果转换到调用方所需泛型，同时保留原始失败语义。 */
function propagateArtifactFailure<T>(
  result: Exclude<PortResult<ArtifactRef>, { readonly status: "SUCCEEDED" }>,
): PortResult<T> {
  if (result.status === "REJECTED") {
    return rejected(result.rejectionCode, result.failureDrafts, result.warnings);
  }
  if (result.status === "CANCELLED") {
    return Object.freeze({ ...result });
  }
  return Object.freeze({ ...result });
}

/**
 * 从 Scenario 提取目标可见任务和输入，检查隐藏规则泄漏与预算，逐项提交产物；
 * ExecutionPlanCompiler.buildPlan 在匹配成功后调用。
 */
async function materializeTask(
  context: OperationContext,
  input: EvaluationAssetMatchingInput,
  materializer: PlanArtifactMaterializer,
): Promise<PortResult<MaterializedTask>> {
  const { targetSnapshot, caseInput, configSnapshot } = input;
  const scope = planningScope(targetSnapshot);
  const scenario = caseInput.scenario;
  const task = asString(scenario.agentTask, "scenario.agentTask");
  const publicInputs = asArray(scenario.publicInputs, "scenario.publicInputs")
    .map((item, index) => ({ index, value: asObject(item, `publicInputs[${index}]`) }))
    .sort((left, right) =>
      asString(left.value.portablePath, "public input path").localeCompare(
        asString(right.value.portablePath, "public input path"),
        "en",
      ),
    );
  const targetVisible = canonicalize({ task, publicInputs: publicInputs.map((inputItem) => inputItem.value) });
  const hiddenTokens: string[] = [];
  hiddenTokens.push(
    configSnapshot.artifactRoot,
    configSnapshot.reportRoot,
    configSnapshot.resultRoot,
    configSnapshot.runRoot,
  );
  if (hiddenTokens.some((token) => token.length > 0 && targetVisible.includes(token))) {
    return rejected(
      "INVALID_INPUT",
      [
        failureDraft(
          scope,
          configSnapshot.createdAt,
          "TARGET_VISIBLE_HIDDEN_RULE",
          "Target-visible task material contains hidden Judge or management data",
          "INPUT_VALIDATION",
          "USER",
        ),
      ],
    );
  }

  const taskBytes = Buffer.from(task, "utf8");
  if (taskBytes.byteLength > configSnapshot.maxArtifactBytes) {
    return rejected(
      "INVALID_INPUT",
      [
        failureDraft(
          scope,
          configSnapshot.createdAt,
          "AGENT_TASK_TOO_LARGE",
          "Agent task exceeds the frozen artifact budget",
          "INPUT_VALIDATION",
          "USER",
        ),
      ],
    );
  }
  const taskContentDigest = digestBytes(taskBytes);
  const taskId = `agent-task.${digestValue({
    targetSnapshotDigest: targetSnapshot.contentDigest,
    executionInputDigest: caseInput.contentDigest,
    taskContentDigest,
  }).value.slice(0, 24)}`;
  const taskResult = await commitPlanningArtifact(
    context,
    materializer,
    artifactMetadata(
      taskId,
      scope,
      "AGENT_TASK",
      "agent-task.txt",
      "text/plain; charset=utf-8",
      configSnapshot,
    ),
    taskBytes,
  );
  if (taskResult.status !== "SUCCEEDED") return propagateArtifactFailure(taskResult);

  const visibleInputRefs: Ref<ArtifactRef>[] = [];
  const inputContentDigests: ContentDigest[] = [];
  for (const { index, value } of publicInputs) {
    if (context.cancellationToken.isCancellationRequested) {
      return cancelled(
        failureDraft(
          scope,
          configSnapshot.createdAt,
          "PLAN_CANCELLED",
          "Planning was cancelled while materializing public inputs",
          "CANCELLED",
          "USER",
        ),
      );
    }
    if (value.encoding !== "utf8") {
      return rejected(
        "UNSUPPORTED",
        [
          failureDraft(
            scope,
            configSnapshot.createdAt,
            "PUBLIC_INPUT_ENCODING_UNSUPPORTED",
            "Only UTF-8 public inputs are supported by the MVP",
            "INPUT_VALIDATION",
            "USER",
          ),
        ],
      );
    }
    const content = asString(value.content, `publicInputs[${index}].content`);
    const portablePath = validatePortablePath(
      value.portablePath,
      `publicInputs[${index}].portablePath`,
    );
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > configSnapshot.maxArtifactBytes) {
      return rejected(
        "INVALID_INPUT",
        [
          failureDraft(
            scope,
            configSnapshot.createdAt,
            "PUBLIC_INPUT_TOO_LARGE",
            "A public input exceeds the frozen artifact budget",
            "INPUT_VALIDATION",
            "USER",
          ),
        ],
      );
    }
    const contentDigest = digestBytes(bytes);
    const id = `visible-input.${digestValue({ portablePath, contentDigest }).value.slice(0, 24)}`;
    const committed = await commitPlanningArtifact(
      context,
      materializer,
      artifactMetadata(
        id,
        scope,
        "VISIBLE_INPUT",
        asString(value.logicalName, `publicInputs[${index}].logicalName`),
        asString(value.mediaType, `publicInputs[${index}].mediaType`),
        configSnapshot,
      ),
      bytes,
    );
    if (committed.status !== "SUCCEEDED") return propagateArtifactFailure(committed);
    visibleInputRefs.push(artifactRefFor(committed.value));
    inputContentDigests.push(contentDigest);
  }
  return succeeded(
    Object.freeze({
      taskRef: artifactRefFor(taskResult.value),
      visibleInputRefs: Object.freeze(visibleInputRefs),
      taskContentDigest,
      inputContentDigests: Object.freeze(inputContentDigests),
    }),
  );
}

/** 从 Scenario pathPolicy 提取并校验稳定排序的允许与禁止路径列表。 */
function pathLists(pack: CaseExecutionInput): {
  readonly allowedPaths: CasePlan["allowedPaths"];
  readonly forbiddenPaths: CasePlan["forbiddenPaths"];
} {
  const policy = asObject(pack.scenario.pathPolicy, "scenario.pathPolicy");
  const allowedPaths = asArray(policy.allowedChanges, "pathPolicy.allowedChanges")
    .map((value, index) =>
      validatePortablePath(
        asObject(value, `allowedChanges[${index}]`).portablePath,
        `allowedChanges[${index}].portablePath`,
      ),
    )
    .sort();
  const forbiddenPaths = asArray(policy.forbiddenChanges, "pathPolicy.forbiddenChanges")
    .map((value, index) =>
      validatePortablePath(
        asObject(value, `forbiddenChanges[${index}]`).portablePath,
        `forbiddenChanges[${index}].portablePath`,
      ),
    )
    .sort();
  return Object.freeze({
    allowedPaths: Object.freeze(allowedPaths),
    forbiddenPaths: Object.freeze(forbiddenPaths),
  });
}

/**
 * 将已匹配输入和已提交任务编译为 EvaluationPlan、AgentTracePlan、环境 ObservationPlan 与证据契约；
 * ExecutionPlanCompiler.buildPlan 的成功路径调用并返回 FROZEN PlanBuildResult。
 */
function compileFrozenPlan(
  input: EvaluationAssetMatchingInput,
  capabilities: PlanningCapabilities,
  materialized: MaterializedTask,
): PlanBuildResult {
  const { targetSnapshot, inspectionSnapshot, caseInput, configSnapshot } = input;
  const scope = planningScope(targetSnapshot);
  const execution = asObject(caseInput.scenario.execution, "scenario.execution");
  const scenarioId = validateVersionedAssetId<"ScenarioId">(
    caseInput.scenario.scenarioId,
    "scenarioId",
  );
  const environmentId = validateVersionedAssetId<"EnvironmentDefinitionId">(
    caseInput.environment.environmentId,
    "environmentId",
  );
  const pathPolicy = pathLists(caseInput);
  const semanticSeed = digestValue({
    targetSnapshotId: targetSnapshot.targetSnapshotId,
    targetFacts: {
      dshEntrypointDigest: targetSnapshot.dshEntrypointDigest,
      dshPackageVersion: targetSnapshot.dshPackageVersion ?? "UNKNOWN",
      profile: targetSnapshot.profile,
      driverFingerprint: targetSnapshot.driverFingerprint,
      platform: targetSnapshot.platform,
      secretRefNames: [...targetSnapshot.secretRefNames].sort(),
      frozenArtifactIds: [
        targetSnapshot.sourceManifestRef.id,
        targetSnapshot.dshHomeManifestRef.id,
        targetSnapshot.profileManifestRef.id,
        targetSnapshot.lockfileRef.id,
        targetSnapshot.effectiveConfigRef.id,
      ].map(String).sort(),
    },
    inspectionFacts: {
      dshVersionStatus: inspectionSnapshot.dshVersionStatus,
      profile: inspectionSnapshot.profile,
      pluginCatalog: inspectionSnapshot.pluginCatalog,
      probeConfigured: inspectionSnapshot.probeConfigured,
      probeSchema: inspectionSnapshot.probeSchema,
      probeOrderStatus: inspectionSnapshot.probeOrderStatus,
      headlessDriverStatus: inspectionSnapshot.headlessDriverStatus,
      toolSchemas: inspectionSnapshot.toolSchemas,
      toolDelta: inspectionSnapshot.toolDelta,
      permissionPreset: inspectionSnapshot.permissionPreset,
      sandboxMode: inspectionSnapshot.sandboxMode,
      limitations: inspectionSnapshot.limitations,
      sourceArtifactIds: inspectionSnapshot.sourceArtifactRefs.map((ref) => String(ref.id)).sort(),
    },
    executionInputDigest: caseInput.contentDigest,
    executionConfig: {
      runDeadlineMs: configSnapshot.runDeadlineMs,
      caseDeadlineMs: configSnapshot.caseDeadlineMs,
      stableWindowMs: configSnapshot.stableWindowMs,
      stableMaxWaitMs: configSnapshot.stableMaxWaitMs,
      maxArtifactBytes: configSnapshot.maxArtifactBytes,
      contentMode: configSnapshot.contentMode,
      allowedModelEndpoints: [...configSnapshot.allowedModelEndpoints].sort(),
      minimumIsolationLevel: configSnapshot.minimumIsolationLevel,
    },
    sensorRegistry: [...input.sensors]
      .sort((left, right) => left.implementationId.localeCompare(right.implementationId, "en"))
      .map((sensor) => ({
        implementationId: sensor.implementationId,
        implementationVersion: sensor.implementationVersion,
        sourceType: sensor.sourceType,
        capabilityDigest: sensor.capabilityDigest,
      })),
    capabilities: {
      ...capabilities,
      observerOperations: [...capabilities.observerOperations].sort(),
    },
    taskContentDigest: materialized.taskContentDigest,
    inputContentDigests: materialized.inputContentDigests,
  });
  const casePlanId = validateStableId<"CasePlanId">(
    `case-plan.${semanticSeed.value.slice(0, 24)}`,
    "casePlanId",
  );
  const casePlan: CasePlan = Object.freeze({
    casePlanId,
    order: 1,
    scenarioId,
    datasetId: caseInput.datasetId,
    labelIds: caseInput.labelIds,
    environmentId,
    environmentObserverSourceRequirementId:
      caseInput.environmentObserverSourceRequirementId,
    runtimeSourceRequirementId: caseInput.runtimeSourceRequirementId,
    agentTaskArtifactRef: materialized.taskRef,
    visibleInputArtifactRefs: materialized.visibleInputRefs,
    seedSpec: asObject(caseInput.environment.seedSpec, "environment.seedSpec"),
    allowedPaths: pathPolicy.allowedPaths,
    forbiddenPaths: pathPolicy.forbiddenPaths,
    deadlineMs: asPositiveInteger(execution.deadlineMs, "scenario.execution.deadlineMs"),
    stableWindowMs: asPositiveInteger(
      execution.stableWindowMs,
      "scenario.execution.stableWindowMs",
    ),
    maxAttempts: 1,
  });
  const planSemanticDigest = digestValue({
    semanticSeed,
    casePlan: {
      casePlanId,
      scenarioId,
      datasetId: casePlan.datasetId,
      labelIds: casePlan.labelIds,
      environmentId,
      environmentObserverSourceRequirementId: casePlan.environmentObserverSourceRequirementId,
      runtimeSourceRequirementId: casePlan.runtimeSourceRequirementId,
      taskContentDigest: materialized.taskContentDigest,
      inputContentDigests: materialized.inputContentDigests,
      seedSpec: casePlan.seedSpec,
      allowedPaths: casePlan.allowedPaths,
      forbiddenPaths: casePlan.forbiddenPaths,
      deadlineMs: casePlan.deadlineMs,
      stableWindowMs: casePlan.stableWindowMs,
      maxAttempts: 1,
    },
  });
  const evaluationPlanId = validateStableId<"EvaluationPlanId">(
    `evaluation-plan.${planSemanticDigest.value.slice(0, 24)}`,
    "evaluationPlanId",
  );
  const evaluationWithoutDigest = {
    schema: "evaldock.mvp.evaluation-plan/v1" as const,
    evaluationPlanId,
    scope,
    createdAt: validateIsoDateTime(configSnapshot.createdAt),
    producerVersion: configSnapshot.evaldockVersion,
    targetSnapshotRef: snapshotRef(targetSnapshot),
    inspectionRef: inspectionRef(inspectionSnapshot),
    inputRef: executionInputRef(caseInput),
    casePlan,
    budget: Object.freeze({
      runDeadlineMs: configSnapshot.runDeadlineMs,
      caseDeadlineMs: casePlan.deadlineMs,
      maxArtifactBytes: configSnapshot.maxArtifactBytes,
      maxAttempts: 1,
    }),
    exclusions: Object.freeze([
      "PLUGIN_TARGET",
      "MULTI_CASE",
      "RETRY",
      "MULTI_ENVIRONMENT",
    ]),
    semanticDigest: planSemanticDigest,
    status: "FROZEN" as const,
  };
  const evaluationPlan: EvaluationPlan = Object.freeze({
    ...evaluationWithoutDigest,
    contentDigest: digestValue(evaluationWithoutDigest),
  });

  const agentTraceSourceRequirements = Object.freeze(
    caseInput.sourceRequirements.filter(
      (requirement) =>
        requirement.sourceRequirementId === casePlan.runtimeSourceRequirementId,
    ),
  );
  const environmentSourceRequirements = Object.freeze(
    caseInput.sourceRequirements.filter(
      (requirement) =>
        requirement.sourceRequirementId !== casePlan.runtimeSourceRequirementId,
    ),
  );

  const agentTraceSemanticDigest = digestValue({
    evaluationPlanSemanticDigest: evaluationPlan.semanticDigest,
    casePlanId,
    sourceRequirements: agentTraceSourceRequirements,
    lifecyclePolicy: {
      armedBeforeTargetStart: true,
      drainAfterTargetTermination: true,
    },
    contentPolicy: {
      contentMode: configSnapshot.contentMode,
      maxBytes: configSnapshot.maxArtifactBytes,
      digestAlgorithm: "sha256",
    },
  });
  const agentTracePlanId = validateStableId<"AgentTracePlanId">(
    `agent-trace-plan.${agentTraceSemanticDigest.value.slice(0, 24)}`,
    "agentTracePlanId",
  );
  const agentTraceWithoutDigest = {
    schema: "evaldock.mvp.agent-trace-plan/v1" as const,
    agentTracePlanId,
    scope,
    createdAt: validateIsoDateTime(configSnapshot.createdAt),
    producerVersion: configSnapshot.evaldockVersion,
    evaluationPlanRef: refFor<EvaluationPlan>(
      evaluationPlan.schema,
      evaluationPlan.evaluationPlanId,
      evaluationPlan.contentDigest,
    ),
    casePlanId,
    sourceRequirements: agentTraceSourceRequirements,
    lifecyclePolicy: Object.freeze({
      armedBeforeTargetStart: true,
      drainAfterTargetTermination: true,
    }),
    contentPolicy: Object.freeze({
      contentMode: configSnapshot.contentMode,
      maxBytes: configSnapshot.maxArtifactBytes,
      digestAlgorithm: "sha256",
    }),
    semanticDigest: agentTraceSemanticDigest,
  };
  const agentTracePlan: AgentTracePlan = Object.freeze({
    ...agentTraceWithoutDigest,
    contentDigest: digestValue(agentTraceWithoutDigest),
  });

  const observationSemanticDigest = digestValue({
    evaluationPlanSemanticDigest: evaluationPlan.semanticDigest,
    casePlanId,
    sourceRequirements: environmentSourceRequirements,
    boundaryPolicy: {
      baselineBeforeTargetStart: true,
      targetTerminationBeforeAfter: true,
    },
    stablePolicy: {
      quietWindowMs: casePlan.stableWindowMs,
      maxWaitMs: configSnapshot.stableMaxWaitMs,
    },
    contentPolicy: {
      contentMode: configSnapshot.contentMode,
      maxBytes: configSnapshot.maxArtifactBytes,
      digestAlgorithm: "sha256",
    },
  });
  const observationPlanId = validateStableId<"ObservationPlanId">(
    `observation-plan.${observationSemanticDigest.value.slice(0, 24)}`,
    "observationPlanId",
  );
  const observationWithoutDigest = {
    schema: "evaldock.mvp.observation-plan/v1" as const,
    observationPlanId,
    scope,
    createdAt: validateIsoDateTime(configSnapshot.createdAt),
    producerVersion: configSnapshot.evaldockVersion,
    evaluationPlanRef: refFor<EvaluationPlan>(
      evaluationPlan.schema,
      evaluationPlan.evaluationPlanId,
      evaluationPlan.contentDigest,
    ),
    casePlanId,
    sourceRequirements: environmentSourceRequirements,
    boundaryPolicy: Object.freeze({
      baselineBeforeTargetStart: true,
      targetTerminationBeforeAfter: true,
    }),
    stablePolicy: Object.freeze({
      quietWindowMs: casePlan.stableWindowMs,
      maxWaitMs: configSnapshot.stableMaxWaitMs,
    }),
    contentPolicy: Object.freeze({
      contentMode: configSnapshot.contentMode,
      maxBytes: configSnapshot.maxArtifactBytes,
      digestAlgorithm: "sha256",
    }),
    semanticDigest: observationSemanticDigest,
  };
  const observationPlan: ObservationPlan = Object.freeze({
    ...observationWithoutDigest,
    contentDigest: digestValue(observationWithoutDigest),
  });
  return Object.freeze({
    status: "FROZEN" as const,
    evaluationPlan,
    agentTracePlan,
    observationPlan,
  });
}

/** MVP 的 EvaluationAssetMatchingPort 实现；只消费 Catalog 已选定的 Dataset 内容。 */
export class ExecutionPlanCompiler implements EvaluationAssetMatchingPort {
  readonly #capabilities: PlanningCapabilities;

  /** 冻结平台能力快照，后续每次 buildPlan 使用同一组匹配条件。 */
  public constructor(capabilities: PlanningCapabilities) {
    this.#capabilities = Object.freeze({
      ...capabilities,
      observerOperations: Object.freeze([...capabilities.observerOperations]),
    });
  }

  /**
   * 执行完整规划工作流：响应取消、返回 UNSATISFIABLE 缺口，或提交目标可见产物并编译冻结计划；
   * `app/bootstrap.ts` 通过 EvaluationAssetMatchingPort 调用。
   */
  public async buildPlan(
    context: OperationContext,
    input: EvaluationAssetMatchingInput,
    artifactMaterializer: PlanArtifactMaterializer,
  ): Promise<PortResult<PlanBuildResult>> {
    const scope = planningScope(input.targetSnapshot);
    const occurredAt = validateIsoDateTime(input.configSnapshot.createdAt);
    if (context.cancellationToken.isCancellationRequested) {
      return cancelled(
        failureDraft(
          scope,
          occurredAt,
          "PLAN_CANCELLED",
          "Planning was cancelled before matching",
          "CANCELLED",
          "USER",
        ),
      );
    }
    try {
      const gaps = findPlanGaps(input, this.#capabilities);
      if (gaps.length > 0) {
        const drafts = gaps.map((currentGap) =>
          failureDraft(
            scope,
            occurredAt,
            currentGap.code,
            currentGap.messageRedacted,
            "PLAN_UNSATISFIABLE",
            currentGap.code.startsWith("DSH_") || currentGap.code.startsWith("PROBE_")
              ? "TARGET"
              : "EVALDOCK",
          ),
        );
        return succeeded(
          Object.freeze({
            status: "UNSATISFIABLE" as const,
            gaps,
            failureDrafts: Object.freeze(drafts),
          }),
        );
      }
      const materialized = await materializeTask(context, input, artifactMaterializer);
      if (materialized.status !== "SUCCEEDED") return materialized;
      return succeeded(compileFrozenPlan(input, this.#capabilities, materialized.value));
    } catch (error) {
      return failed(
        failureDraft(
          scope,
          occurredAt,
          "PLANNER_INTERNAL_INVARIANT",
          "Planner failed an internal invariant without producing a partial Plan",
          "INTERNAL_INVARIANT",
          "EVALDOCK",
        ),
      );
    }
  }
}
