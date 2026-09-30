/**
 * 文件功能：规定 EvalDock 各模块之间“怎样调用、怎样返回结果”。
 *
 * 可以把 Port 理解为模块接口。例如工作流只调用 RepositoryPort 的“保存记录”，
 * 不需要知道 FileRepository 怎样写 JSON 文件。所有接口统一返回 PortResult，明确区分
 * 成功、业务条件不满足、执行失败和用户取消，避免异常被当成成功结果。
 *
 * 主要交互：`app/bootstrap.ts` 为这些接口装配实际实现；planning、runtime、observation、
 * evaluation 调用它们；storage 实现数据保存和产物保存接口。
 *
 * 阅读重点：OperationContext 是一次调用携带的运行信息；PortResult 是统一返回格式；
 * RepositoryPort、ArtifactStorePort 和 EvaluationAssetMatchingPort 是三类主要模块接口。
 */
import type {
  ArtifactId,
  ArtifactReadPurpose,
  ArtifactRef,
  ConfigSnapshot,
  CaseExecutionInput,
  InspectionSnapshot,
  IsoDateTime,
  LifecycleProjectionBase,
  PlanBuildResult,
  Ref,
  ScopeRef,
  SensorAdapterDescriptor,
  StableId,
  StateTransition,
  TargetSnapshot,
} from "./models.js";
import type { FailureActor, FailureDraft } from "./errors.js";

/** 表示当前任务是否已被取消；耗时步骤可以随时检查它并停止执行。 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  throwIfCancellationRequested?(): void;
}

/** 一次模块调用附带的公共信息：调用编号、截止时间、取消状态、调用者和 Trace 编号。 */
export interface OperationContext {
  readonly operationId: StableId<"OperationId">;
  readonly idempotencyKey: string;
  readonly deadlineAt: IsoDateTime;
  readonly cancellationToken: CancellationToken;
  readonly actorRole: FailureActor;
  readonly traceId: StableId<"TraceId">;
}

/** VM 中用于降低进程权限的 Linux 命令路径。环境检查和 Agent 启动会共同使用它。 */
export const LINUX_SETPRIV_PATH = "/usr/bin/setpriv";

/** macOS 中通过受限 sudoers 规则切换到 Agent 身份的固定命令路径。 */
export const DARWIN_SUDO_PATH = "/usr/bin/sudo";

/**
 * 生成以受限用户启动 Agent 的命令参数。环境检查和运行时启动器都会调用；
 * 非法用户 ID、非绝对命令路径或危险的 NUL 字符会直接被拒绝。
 */
export function linuxSetprivArguments(
  uid: number,
  gid: number,
  executablePath: string,
  argv: readonly string[],
): readonly string[] {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("setpriv uid and gid must be non-negative safe integers");
  }
  if (!executablePath.startsWith("/") || executablePath.includes("\0")) {
    throw new Error("setpriv executable must be an absolute NUL-free Linux path");
  }
  if (argv.some((argument) => argument.includes("\0"))) {
    throw new Error("setpriv argv must be NUL-free");
  }
  return Object.freeze([
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--no-new-privs",
    "--",
    executablePath,
    ...argv,
  ]);
}

/**
 * 生成 macOS 受限身份启动参数。`-n` 禁止交互式口令，`-E` 仅保留调用方已经
 * 收窄过的 Agent 环境；部署时 sudoers 必须只授权固定的 DSH 启动命令。
 */
export function darwinSudoArguments(
  uid: number,
  gid: number,
  executablePath: string,
  argv: readonly string[],
): readonly string[] {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("sudo uid and gid must be non-negative safe integers");
  }
  if (!executablePath.startsWith("/") || executablePath.includes("\0")) {
    throw new Error("sudo executable must be an absolute NUL-free macOS path");
  }
  if (argv.some((argument) => argument.includes("\0"))) {
    throw new Error("sudo argv must be NUL-free");
  }
  return Object.freeze([
    "-n",
    "-H",
    "-E",
    "-u",
    `#${uid}`,
    "-g",
    `#${gid}`,
    "--",
    executablePath,
    ...argv,
  ]);
}

/** Linux/macOS 共用的受限身份启动命令选择器。 */
export function identityLaunchCommand(
  platform: NodeJS.Platform,
  uid: number,
  gid: number,
  executablePath: string,
  argv: readonly string[],
): Readonly<{ executablePath: string; argv: readonly string[] }> {
  if (platform === "linux") {
    return Object.freeze({
      executablePath: LINUX_SETPRIV_PATH,
      argv: linuxSetprivArguments(uid, gid, executablePath, argv),
    });
  }
  if (platform === "darwin") {
    return Object.freeze({
      executablePath: DARWIN_SUDO_PATH,
      argv: darwinSudoArguments(uid, gid, executablePath, argv),
    });
  }
  throw new Error(`formal identity launch is unsupported on ${platform}`);
}

/** 调用没有执行时的原因，例如输入错误、资源不存在或前置条件不满足。 */
export type RejectionCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "PRECONDITION_FAILED"
  | "STALE_REVISION"
  | "AUTHORIZATION_DENIED";

/** 不影响本次调用继续执行的安全提示；消息必须已经去除敏感信息。 */
export interface PortWarning {
  readonly code: string;
  readonly messageRedacted: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * 所有模块接口共用的返回格式。调用方根据 status 明确处理成功、条件不满足、
 * 系统失败或取消，并继续向上报告失败记录和提示。
 */
export type PortResult<T> =
  | {
      readonly status: "SUCCEEDED";
      readonly value: T;
      readonly failureDrafts: readonly FailureDraft[];
      readonly warnings: readonly PortWarning[];
    }
  | {
      readonly status: "REJECTED";
      readonly rejectionCode: RejectionCode;
      readonly failureDrafts: readonly FailureDraft[];
      readonly warnings: readonly PortWarning[];
    }
  | {
      readonly status: "FAILED";
      readonly failureDrafts: readonly [FailureDraft, ...FailureDraft[]];
      readonly warnings: readonly PortWarning[];
    }
  | {
      readonly status: "CANCELLED";
      readonly failureDrafts: readonly [FailureDraft, ...FailureDraft[]];
      readonly warnings: readonly PortWarning[];
    };

/** 把正常返回值包装成统一的成功结果。 */
export function succeeded<T>(value: T, warnings: readonly PortWarning[] = []): PortResult<T> {
  return Object.freeze({ status: "SUCCEEDED", value, failureDrafts: [], warnings });
}

/** 表示调用条件不满足，例如输入不合法或目标能力不足。 */
export function rejected<T = never>(
  rejectionCode: RejectionCode,
  failureDrafts: readonly FailureDraft[] = [],
  warnings: readonly PortWarning[] = [],
): PortResult<T> {
  return Object.freeze({ status: "REJECTED", rejectionCode, failureDrafts, warnings });
}

/** 表示执行过程中发生故障，并要求至少记录一个失败原因。 */
export function failed<T = never>(
  first: FailureDraft,
  ...rest: readonly FailureDraft[]
): PortResult<T> {
  const failureDrafts: readonly [FailureDraft, ...FailureDraft[]] = [first, ...rest];
  return Object.freeze({ status: "FAILED", failureDrafts, warnings: [] });
}

/** 表示操作被取消，并要求至少记录一个取消原因。 */
export function cancelled<T = never>(
  first: FailureDraft,
  ...rest: readonly FailureDraft[]
): PortResult<T> {
  const failureDrafts: readonly [FailureDraft, ...FailureDraft[]] = [first, ...rest];
  return Object.freeze({ status: "CANCELLED", failureDrafts, warnings: [] });
}

/**
 * 评测记录的保存和读取接口。它既保存创建后不再修改的事实记录，
 * 也通过追加状态变化来更新 Run、Attempt 等对象的当前状态。
 * `storage/repositories.ts` 提供文件系统实现，工作流是主要调用方。
 */
export interface RepositoryPort {
  putImmutable<T extends object>(
    context: OperationContext,
    record: T,
  ): Promise<PortResult<Readonly<Ref<T>>>>;

  createProjection<T extends LifecycleProjectionBase>(
    context: OperationContext,
    initialProjection: T,
  ): Promise<PortResult<Readonly<Ref<T> & { readonly revision: 0 }>>>;

  appendTransition<T extends LifecycleProjectionBase>(
    context: OperationContext,
    transition: StateTransition<T>,
  ): Promise<PortResult<Readonly<Ref<T> & { readonly revision: number }>>>;

  get<T>(context: OperationContext, ref: Ref<T>): Promise<PortResult<Readonly<T>>>;
}

/** 保存产物时必须同时记录的信息，例如产物 ID、所属运行、文件类型和脱敏状态。 */
export interface ArtifactCommitMetadata {
  readonly artifactId: ArtifactId;
  readonly scope: ScopeRef;
  readonly artifactType: string;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly producerVersion: string;
  readonly createdAt: IsoDateTime;
  readonly sensitivity: "EXPORTABLE" | "RESTRICTED";
  readonly redactionState: "NOT_REQUIRED" | "APPLIED" | "FAILED";
}

/**
 * 产物文件的保存和读取接口。读取时会校验摘要，确保文件没有被替换或损坏；
 * `storage/artifacts.ts` 提供文件系统实现。
 */
export interface ArtifactStorePort {
  commit(
    context: OperationContext,
    bytes: Uint8Array | string,
    metadata: ArtifactCommitMetadata,
  ): Promise<PortResult<Readonly<ArtifactRef>>>;

  readVerified(
    context: OperationContext,
    ref: ArtifactRef,
    scope: ScopeRef,
    purpose: ArtifactReadPurpose,
  ): Promise<PortResult<Uint8Array>>;
}

/** Planner 只需要“保存计划产物”这一项能力，因此使用这个较小的写入接口。 */
export interface PlanArtifactMaterializer {
  commit(
    context: OperationContext,
    bytes: Uint8Array | string,
    metadata: ArtifactCommitMetadata,
  ): Promise<PortResult<Readonly<ArtifactRef>>>;
}

/** Planner 选择评测内容时需要的全部输入：Agent 信息、数据集、配置及可用的观测器和 Judge。 */
export interface EvaluationAssetMatchingInput {
  readonly targetSnapshot: TargetSnapshot;
  readonly inspectionSnapshot: InspectionSnapshot;
  readonly caseInput: CaseExecutionInput;
  readonly configSnapshot: ConfigSnapshot;
  readonly sensors: readonly SensorAdapterDescriptor[];
}

/** 评测资产匹配接口；应用编排通过它生成冻结计划。 */
export interface EvaluationAssetMatchingPort {
  buildPlan(
    context: OperationContext,
    input: EvaluationAssetMatchingInput,
    artifactMaterializer: PlanArtifactMaterializer,
  ): Promise<PortResult<PlanBuildResult>>;
}
