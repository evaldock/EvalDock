/**
 * 文件职责：组装一次 EvalDock 调用所需的真实服务。
 *
 * 核心流程：读取并校验 TargetDescriptor，冻结配置，创建 Repository、ArtifactStore、
 * Sensor 与 Planner，执行本地服务健康检查，最后返回 Workflow 可直接使用的服务集合。
 *
 * 与其他文件的交互：CLI 读取 Target 描述并调用本文件；`app/workflow.ts` 使用
 * ApplicationServices；具体实现来自 planning、observation、platform 和 storage。
 *
 * 公开接口：版本号、Bootstrap 输入/服务类型、两类边界错误、Port 结果转换、
 * Run ID/TargetDescriptor 构造、应用组装。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  EvaluationAssetMatchingPort,
  OperationContext,
  PortResult,
} from "../core/contracts.js";
import type { FailureActor, FailureDraft } from "../core/errors.js";
import {
  assertDigestEquals,
  type ConfigSnapshot,
  type IsoDateTime,
  type SensorAdapterDescriptor,
  type StableId,
  type TargetDescriptor,
  validateIsoDateTime,
  validateStableId,
  withContentDigest,
} from "../core/models.js";
import {
  FILE_SENSOR_DESCRIPTOR,
  FileEnvironmentSensor,
  type EnvironmentSensor,
} from "../../observer-lab/adapters/filesystem/binding.js";
import {loadObserverRegistry,type ObserverRegistration} from "../observation/registry.js";
import {
  PROBE_CAPABILITIES,
  PROBE_CAPABILITY_DIGEST,
  PROBE_IMPLEMENTATION_ID,
  PROBE_IMPLEMENTATION_VERSION,
} from "../agent-trace/reader.js";
import {
  ExecutionPlanCompiler,
  type PlanningCapabilities,
} from "../runtime/evaluation-plan-compiler.js";
import { freezeConfig, type MvpConfigValues } from "../platform/config.js";
import { checkLocalServices, type HealthCheckResult } from "../platform/services.js";
import { FileArtifactStore } from "../storage/artifacts.js";
import { FileRepository } from "../storage/repositories.js";

/** 写入配置、记录和 Artifact 元数据的当前实现版本。 */
export const EVALDOCK_VERSION = "0.1.0";

/** TargetDescriptor 允许出现的完整字段集合，供严格 JSON 校验使用。 */
const TARGET_FIELDS = new Set([
  "schema",
  "targetId",
  "targetType",
  "sourceRoot",
  "dshExecutable",
  "dshHome",
  "webEndpoint",
  "profile",
  "targetIdentity",
  "contentDigest",
]);

/** 一次应用组装的调用级输入，由 CLI 或测试提供。 */
export interface BootstrapInput {
  readonly cwd: string;
  readonly runId: string;
  readonly descriptor: TargetDescriptor;
  readonly createdAt: string;
  readonly configFile?: string;
  readonly configOverrides?: Partial<MvpConfigValues>;
  /** 真实评测时注册外部 Label Judge；Fixture 和底层集成测试可省略。 */
  readonly signal?: AbortSignal;
}

/** Workflow 的依赖集合；所有外部 I/O 实现只在 Bootstrap 中实例化。 */
export interface ApplicationServices {
  readonly config: ConfigSnapshot;
  readonly repository: FileRepository;
  readonly artifacts: FileArtifactStore;
  readonly health: HealthCheckResult;
  readonly sensors: readonly SensorAdapterDescriptor[];
  /** 将已选 Dataset/Label/Environment 冻结为运行期对象；不调用 LLM，也不做选集决策。 */
  readonly planCompiler: EvaluationAssetMatchingPort;
  readonly fileSensor: EnvironmentSensor;
  readonly observers: readonly ObserverRegistration[];
  readonly operation: (actor: FailureActor, label: string) => OperationContext;
}

/** 将非成功 PortResult 保留原始结构并转换为可抛出的应用边界错误。 */
export class PortOperationError extends Error {
  public readonly result: Exclude<PortResult<unknown>, { readonly status: "SUCCEEDED" }>;

  /** 由 requireSucceeded 创建，operation 用于指出失败的 Port 调用。 */
  public constructor(
    operation: string,
    result: Exclude<PortResult<unknown>, { readonly status: "SUCCEEDED" }>,
  ) {
    super(`${operation} returned ${result.status}`);
    this.name = "PortOperationError";
    this.result = result;
  }
}

/** CLI 请求非 FULL_AGENT Target 时使用的稳定规划错误。 */
export class UnsupportedTargetKindError extends Error {
  public readonly reasonCode = "UNSUPPORTED_TARGET_KIND" as const;

  /** 由 TargetDescriptor 解析在类型不受支持时创建。 */
  public constructor() {
    super("EvalDock MVP supports only FULL_AGENT targets");
    this.name = "UnsupportedTargetKindError";
  }
}

/** 解包成功的 PortResult；失败时抛出含原始结果的 PortOperationError。 */
export function requireSucceeded<T>(operation: string, result: PortResult<T>): T {
  if (result.status === "SUCCEEDED") return result.value;
  throw new PortOperationError(operation, result);
}

/** 从 PortOperationError 恢复 FailureDraft，供 Workflow 持久化准确归因。 */
export function failureDraftsFrom(error: unknown): readonly FailureDraft[] {
  return error instanceof PortOperationError ? error.result.failureDrafts : [];
}

/** 为未显式指定 ID 的 CLI Run 生成满足 StableId 契约的唯一标识。 */
export function createRunId(prefix = "run"): StableId<"RunId"> {
  const time = Date.now().toString(36);
  const random = randomUUID().replaceAll("-", "").slice(0, 16);
  return validateStableId<"RunId">(`${prefix}-${time}-${random}`, "runId");
}

/**
 * 读取并严格校验 TargetDescriptor JSON，解析相对 sourceRoot，并验证可选摘要。
 * `app/cli.ts` 在 inspect、plan、run 三条命令进入 Workflow 前调用。
 */
export async function loadTargetDescriptor(file: string): Promise<TargetDescriptor> {
  const descriptorPath = path.resolve(file);
  const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("target descriptor must be a JSON object");
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.targetType !== undefined && raw.targetType !== "FULL_AGENT") {
    throw new UnsupportedTargetKindError();
  }
  const unknown = Object.keys(raw).filter((field) => !TARGET_FIELDS.has(field)).sort();
  if (unknown.length > 0) {
    throw new Error(`target descriptor contains unknown fields: ${unknown.join(", ")}`);
  }
  if (
    raw.schema !== "evaldock.mvp.target-descriptor/v1" ||
    raw.targetType !== "FULL_AGENT"
  ) {
    throw new Error("target descriptor must declare the MVP FULL_AGENT schema");
  }
  for (const field of [
    "sourceRoot",
    "dshExecutable",
    "dshHome",
    "profile",
    "targetIdentity",
  ] as const) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      throw new Error(`target descriptor ${field} must be a non-empty string`);
    }
  }
  const sourceRoot = path.resolve(path.dirname(descriptorPath), raw.sourceRoot as string);
  const withoutDigest = {
    schema: "evaldock.mvp.target-descriptor/v1" as const,
    targetId: validateStableId<"TargetId">(raw.targetId, "targetId"),
    targetType: "FULL_AGENT" as const,
    sourceRoot,
    dshExecutable: raw.dshExecutable as string,
    dshHome: raw.dshHome as string,
    ...(raw.webEndpoint === undefined ? {} : {webEndpoint: String(raw.webEndpoint)}),
    profile: raw.profile as string,
    targetIdentity: raw.targetIdentity as string,
  };
  const descriptor = withContentDigest(withoutDigest) as TargetDescriptor;
  if (raw.contentDigest !== undefined) {
    if (!path.isAbsolute(raw.sourceRoot as string)) {
      throw new Error("a descriptor with contentDigest must use an absolute sourceRoot");
    }
    assertDigestEquals(
      descriptor.contentDigest,
      raw.contentDigest as TargetDescriptor["contentDigest"],
      "TARGET_DESCRIPTOR_DIGEST_MISMATCH",
    );
  }
  return descriptor;
}

/**
 * 应用唯一组合根。CLI/Workflow 调用它取得冻结配置和全部具体服务实现；
 * 它调用 freezeConfig、checkLocalServices，并实例化文件存储、Sensor 与 Planner。
 */
export async function bootstrapApplication(input: BootstrapInput): Promise<ApplicationServices> {
  const createdAt = validateIsoDateTime(input.createdAt, "createdAt");
  const runId = validateStableId<"RunId">(input.runId, "runId");
  const config = await freezeConfig({
    cwd: path.resolve(input.cwd),
    configId: `config.${runId}`,
    invocationId: `invocation.${runId}`,
    createdAt,
    evaldockVersion: EVALDOCK_VERSION,
    ...(input.configFile === undefined ? {} : { configFile: input.configFile }),
    cli: {
      ...(input.configOverrides ?? {}),
      targetRoot: input.descriptor.sourceRoot,
    },
  });
  const scope = Object.freeze({ targetId: input.descriptor.targetId });
  const repository = new FileRepository({
    runRoot: config.runRoot,
    runId,
    scope,
    producerVersion: EVALDOCK_VERSION,
  });
  const artifacts = new FileArtifactStore({
    artifactRoot: config.artifactRoot,
    runRoot: config.runRoot,
    runId,
    scope,
    maxArtifactBytes: config.maxArtifactBytes,
  });
  const health = await checkLocalServices({
    run: config.runRoot,
    artifact: config.artifactRoot,
    report: config.reportRoot,
    result: config.resultRoot,
    workspace: config.workspaceRoot,
    runtimeHome: config.runtimeDshHomeRoot,
  });

  const startupRecovery = health.checks.find((check) => check.name === "startup-recovery");
  if (startupRecovery?.status === "FAIL") {
    throw new Error(`STARTUP_RECOVERY_REQUIRED: ${startupRecovery.detail}`);
  }
  const probeDescriptor: SensorAdapterDescriptor = Object.freeze({
    implementationId: validateStableId<"SensorImplementationId">(PROBE_IMPLEMENTATION_ID),
    implementationVersion: PROBE_IMPLEMENTATION_VERSION,
    capabilityDigest: PROBE_CAPABILITY_DIGEST,
    sourceType: "DSH_PROBE",
    capabilities: PROBE_CAPABILITIES,
  });

  let operationCounter = 0;
  /** 将调用方 AbortSignal 暴露为 Planning Port 使用的取消令牌。 */
  const requestedCancellationToken = {
    /** Planning Port 每次检查时读取最新 AbortSignal 状态。 */
    get isCancellationRequested(): boolean {
      return input.signal?.aborted ?? false;
    },
    /** Planning Port 在安全检查点主动终止已取消操作。 */
    throwIfCancellationRequested(): void {
      if (input.signal?.aborted === true) throw new Error("operation cancelled");
    },
  };
  /** 收尾写入使用的固定非取消令牌，保证已形成事实能够落盘。 */
  const finalizationCancellationToken = Object.freeze({
    isCancellationRequested: false,
    /** 最终化操作始终允许执行，因此该检查保持为空操作。 */
    throwIfCancellationRequested(): void {},
  });
  /** 为每次 Port 调用生成唯一 OperationContext，并按 Actor 选择取消语义。 */
  const operation = (actor: FailureActor, label: string): OperationContext => {
    operationCounter += 1;
    const safeLabel = label.replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 48) || "operation";
    const operationId = validateStableId<"OperationId">(
      `op.${runId}.${operationCounter}.${safeLabel}`.slice(0, 128),
      "operationId",
    );
    return Object.freeze({
      operationId,
      idempotencyKey: `${runId}:${operationCounter}:${safeLabel}`,
      deadlineAt: new Date(Date.now() + config.runDeadlineMs).toISOString() as IsoDateTime,
      cancellationToken:
        actor === "PLANNING" ? requestedCancellationToken : finalizationCancellationToken,
      actorRole: actor,
      traceId: validateStableId<"TraceId">(`trace.${runId}`, "traceId"),
    });
  };

  const observers = await loadObserverRegistry(input.cwd);
  const planningCapabilities: PlanningCapabilities = Object.freeze({
    observerReadOnly: true,
    identitySeparation: true,
    atomicArtifactCommit: true,
    pathIsolation: true,
    networkDefaultDeny: true,
    targetHiddenRootsDenied: true,
    probeArmedBeforeHeadless: true,
    observerOperations: Object.freeze(["READ", "SNAPSHOT", "DRAIN"] as const),
  });

  return {
    config,
    repository,
    artifacts,
    health,
    sensors: Object.freeze([probeDescriptor, FILE_SENSOR_DESCRIPTOR, ...observers.filter(item=>item.enabled && item.sourceType!==FILE_SENSOR_DESCRIPTOR.sourceType)]),
    planCompiler: new ExecutionPlanCompiler(planningCapabilities),
    fileSensor: new FileEnvironmentSensor(),
    observers,
    operation,
  };
}

