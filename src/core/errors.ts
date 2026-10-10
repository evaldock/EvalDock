/**
 * 文件功能：统一描述“哪里失败了、为什么失败、应该归谁处理”。
 *
 * 执行模块发现问题时先创建 FailureDraft。工作流准备保存时，为它补上 ID、版本和摘要，
 * 得到 FailureRecord。报告页面再把记录归为 Agent 失败、采集失败、Judge 失败或基础设施失败。
 * 这样不同故障不会被混成一句笼统的“评测失败”。
 *
 * 主要交互：各执行模块产生 FailureDraft；`contracts.ts` 把它放进统一返回结果；
 * `storage/repositories.ts` 保存正式记录；`evaluation/report.ts` 按失败类型展示。
 */
import { createHash } from "node:crypto";
import {
  ContractViolation,
  type ArtifactRef,
  type ContentDigest,
  type IsoDateTime,
  type Ref,
  type ScopeRef,
  type StableId,
  validateScope,
  validateStableId,
  withContentDigest,
} from "./models.js";

/** 问题来自哪里：用户输入、被测 Agent、EvalDock、运行环境或外部服务。 */
export type FailureOrigin =
  | "USER"
  | "TARGET"
  | "EVALDOCK"
  | "ENVIRONMENT"
  | "EXTERNAL_DEPENDENCY"
  | "UNKNOWN";

/** 问题发生在哪一类环节，例如计划、执行、观测、Judge、保存或清理。 */
export type FailureCategory =
  | "INPUT_VALIDATION"
  | "TARGET_RESOLUTION"
  | "TARGET_INTEGRITY"
  | "PLAN_UNSATISFIABLE"
  | "PLATFORM_SECURITY_FAILURE"
  | "ENVIRONMENT_FAILURE"
  | "TARGET_EXECUTION"
  | "TIMEOUT"
  | "CANCELLED"
  | "OBSERVATION_FAILURE"
  | "EVIDENCE_INCOMPLETE"
  | "EVIDENCE_INTEGRITY"
  | "JUDGE_FAILURE"
  | "TARGET_SECURITY_VIOLATION"
  | "PERSISTENCE_FAILURE"
  | "REPORT_FAILURE"
  | "CLEANUP_FAILURE"
  | "INTERNAL_INVARIANT";

/** 问题的严重程度。 */
export type FailureSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/** 由哪个模块发现或产生了问题。 */
export type FailureActor =
  | "APP"
  | "PLANNING"
  | "RUNTIME"
  | "ENVIRONMENT_CONTROLLER"
  | "COLLECTOR"
  | "EVIDENCE_PROCESSOR"
  | "JUDGE"
  | "STORAGE"
  | "PLATFORM"
  | "REPORTER"
  | "EXPORTER"
  | "TARGET"
  | "USER"
  | "UNKNOWN";

/** 刚发现问题时创建的失败信息；已经脱敏，但还没有正式记录 ID 和摘要。 */
export interface FailureDraft {
  readonly scope: ScopeRef;
  readonly category: FailureCategory;
  readonly origin: FailureOrigin;
  readonly actor: FailureActor;
  readonly phase: string;
  readonly severity: FailureSeverity;
  readonly retryable: false;
  readonly messageRedacted: string;
  readonly diagnostics?: SafeErrorDiagnostics;
  readonly reasonCode: string;
  readonly evidenceRefs: readonly Ref[];
  readonly artifactRefs: readonly Ref<ArtifactRef>[];
  readonly occurredAt: IsoDateTime;
}

/** 可以保存的正式失败记录：在 FailureDraft 基础上增加 ID、版本和内容摘要。 */
export interface FailureRecord extends FailureDraft {
  readonly schema: "evaldock.mvp.failure/v1";
  readonly failureId: StableId<"FailureId">;
  readonly producerVersion: string;
  readonly contentDigest: ContentDigest;
}

/** 报告页面面向用户展示的六类失败分组。 */
export type FailureDisplayGroup =
  | "plan_conflict"
  | "infrastructure_error"
  | "collector_error"
  | "agent_failure"
  | "judge_error"
  | "CANCELLED";

/** 保存前检查失败信息是否完整，以及它是否属于正确的 Run/Case/Attempt。 */
export function validateFailureDraft(draft: FailureDraft): FailureDraft {
  validateScope(draft.scope);
  if (draft.retryable !== false) {
    throw new ContractViolation("INVALID_FAILURE", "MVP failures must set retryable=false");
  }
  if (draft.messageRedacted.length === 0 || draft.reasonCode.length === 0 || draft.phase.length === 0) {
    throw new ContractViolation(
      "INVALID_FAILURE",
      "failure phase, reasonCode and redacted message must be non-empty",
    );
  }
  return draft;
}

/** 给失败草稿补上正式 ID、版本和摘要，生成可以保存的失败记录。 */
export function commitFailureDraft(
  draft: FailureDraft,
  failureId: StableId<"FailureId"> | string,
  producerVersion: string,
): Readonly<FailureRecord> {
  validateFailureDraft(draft);
  const recordWithoutDigest = {
    schema: "evaldock.mvp.failure/v1" as const,
    failureId: validateStableId<"FailureId">(failureId, "failureId"),
    ...draft,
    producerVersion,
  };
  return withContentDigest(recordWithoutDigest);
}

/** 把内部失败类型转换成报告中的 Agent、采集、Judge、计划或基础设施分组。 */
export function failureDisplayGroup(failure: FailureDraft): FailureDisplayGroup {
  if (failure.category === "CANCELLED") return "CANCELLED";
  if (failure.category === "JUDGE_FAILURE" || failure.actor === "JUDGE") return "judge_error";
  if (
    failure.category === "OBSERVATION_FAILURE" ||
    failure.category === "EVIDENCE_INCOMPLETE" ||
    failure.category === "EVIDENCE_INTEGRITY" ||
    failure.actor === "COLLECTOR" ||
    failure.actor === "EVIDENCE_PROCESSOR"
  ) {
    return "collector_error";
  }
  if (
    failure.category === "INPUT_VALIDATION" ||
    failure.category === "TARGET_RESOLUTION" ||
    failure.category === "TARGET_INTEGRITY" ||
    failure.category === "PLAN_UNSATISFIABLE"
  ) {
    return "plan_conflict";
  }
  if (
    failure.origin === "TARGET" &&
    (failure.category === "TARGET_EXECUTION" ||
      failure.category === "TIMEOUT" ||
      failure.category === "TARGET_SECURITY_VIOLATION")
  ) {
    return "agent_failure";
  }
  return "infrastructure_error";
}

export interface SafeErrorDiagnostics {
  readonly exceptionType: string;
  readonly code?: string;
  readonly messageHash: string;
  readonly frames: readonly string[];
  readonly cause?: SafeErrorDiagnostics;
}
/** Preserve actionable locations/codes, never arbitrary exception messages or absolute paths. */
export function safeErrorDiagnostics(error: unknown, depth = 0): SafeErrorDiagnostics {
  const e = error instanceof Error ? error : new Error("Non-Error exception");
  const value = e as Error & {code?: unknown; cause?: unknown};
  const code = typeof value.code === "string" && /^(E[A-Z0-9_]{1,35}|UND_ERR_[A-Z_]{1,40}|DSH_[A-Z_]{1,60})$/.test(value.code) ? value.code : undefined;
  const frames = (e.stack ?? "").split("\n").slice(1).flatMap(line => {
    const match = line.match(/(?:\/|\\)([a-zA-Z0-9_.-]+\.(?:js|ts|mjs)):(\d+):(\d+)\)?$/);
    return match ? [match[1]+":"+match[2]+":"+match[3]] : [];
  }).slice(0,8);
  return {exceptionType:["Error","TypeError","RangeError","SyntaxError","AbortError","TimeoutError"].includes(e.name)?e.name:"Error",
    ...(code ? {code} : {}),messageHash:createHash("sha256").update(e.message).digest("hex"),frames,
    ...(depth < 2 && value.cause !== undefined && value.cause !== error ? {cause:safeErrorDiagnostics(value.cause,depth+1)} : {})};
}

/**
 * 把未预料到的程序异常转换成安全的失败记录草稿。
 * 原始异常可能含路径或密钥，所以报告只保留固定的脱敏说明。
 */
export function internalFailureDraft(
  scope: ScopeRef,
  phase: string,
  occurredAt: IsoDateTime,
  options: {
    readonly actor?: FailureActor;
    readonly reasonCode?: string;
    readonly messageRedacted?: string;
    readonly cause?: unknown;
  } = {},
): FailureDraft {
  // unknown 异常文本可能包含路径或密钥，因此这里只使用调用方提供或固定的脱敏消息。
  const diagnostics = options.cause === undefined ? undefined : safeErrorDiagnostics(options.cause);
  const baseMessage = options.messageRedacted ?? "An unexpected EvalDock invariant failed";
  const messageRedacted = diagnostics ? baseMessage + " [" + [diagnostics.exceptionType,diagnostics.code,...diagnostics.frames.slice(0,2)].filter(Boolean).join(" · ") + "]" : baseMessage;
  const draft: FailureDraft = {
    scope: validateScope(scope),
    category: "INTERNAL_INVARIANT",
    origin: "EVALDOCK",
    actor: options.actor ?? "APP",
    phase,
    severity: "ERROR",
    retryable: false,
    messageRedacted,
    ...(diagnostics ? {diagnostics} : {}),
    reasonCode: options.reasonCode ?? "UNEXPECTED_INTERNAL_ERROR",
    evidenceRefs: [],
    artifactRefs: [],
    occurredAt,
  };
  if (options.cause === undefined) return draft;
  return Object.freeze(draft);
}
