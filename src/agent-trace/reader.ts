/**
 * 文件职责：有界读取并解析 DSH Runtime Probe 的 JSONL 输出，记录关联、序列和边界问题，再把草稿绑定到已提交原始制品。
 * 核心流程：安全打开 Probe 文件并按字节/时间限额读取，逐行验证外部 Envelope 与序列，生成观察和采集状态草稿，提交原始字节后物化领域记录及失败草稿。
 * 与其他文件的真实交互：使用 core/models.ts 的作用域、摘要和不可变记录工具；实现身份被 observation/coordinator.ts 写入 SourceDescriptor；由 app/workflow.ts 驱动读取、解析、制品提交和物化。
 * 公开接口：Probe 线协议及解析类型、有界读取类型与函数、实现身份常量、parseProbeJsonl、materializeProbeCollection、probeIssueFailureDrafts。
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  ContractViolation,
  assertSameAttemptScope,
  digestBytes,
  digestEquals,
  validateIsoDateTime,
  validateScope,
  validateStableId,
  withContentDigest,
  type ArtifactRef,
  type CollectionStatus,
  type ContentDigest,
  type EvidenceCompleteness,
  type JsonObject,
  type JsonValue,
  type RawObservation,
  type Ref,
  type ScopeRef,
  type SourceDescriptor,
  type SourceTime,
} from "../core/models.js";
import type { FailureDraft, FailureRecord } from "../core/errors.js";

/** DSH Runtime Probe 输出的外部线协议；未知字段会原样保留。 */
export interface ProbeEnvelope {
  readonly schema: "dsh-eval.probe/v1";
  readonly runId: string;
  readonly probeSeq: number;
  readonly at: string;
  readonly monotonicNs: number | string;
  readonly pid: number;
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** 保留外部协议中的未知字段，避免采集层无意丢失原始信息。 */
  readonly [field: string]: unknown;
}

/** 表示单条 Probe 记录能否与冻结的 RunId 和可选 PID 关联。 */
export type ProbeAssociation = "MATCHED" | "UNRESOLVED";

/** Probe 解析、序列完整性和生命周期边界可能产生的问题代码。 */
export type ProbeIssueCode =
  | "BAD_JSON"
  | "INVALID_ENVELOPE"
  | "RUN_ID_MISMATCH"
  | "PID_MISMATCH"
  | "SEQUENCE_GAP"
  | "SEQUENCE_DUPLICATE"
  | "SEQUENCE_OUT_OF_ORDER"
  | "PROBE_START_MISSING"
  | "PROBE_START_DUPLICATE"
  | "PROBE_START_LATE"
  | "COMMITTED_TURN_MISSING"
  | "PROBE_STOP_MISSING"
  | "PROBE_STOP_DUPLICATE"
  | "PROBE_STOP_EARLY"
  | "PROBE_TRUNCATED"
  | "PROBE_CONTENT_RESTRICTED"
  | "ADAPTER_CAPTURE_INCOMPLETE"
  | "NATIVE_STOP_UNCONFIRMED"
  | "SESSION_SCOPE_UNRESOLVED"
  | "TURN_INCOMPLETE"
  | "TOOL_CALL_INCOMPLETE";

/** 带可选行号和序列号的单个 Probe 完整性问题。 */
export interface ProbeIssue {
  readonly code: ProbeIssueCode;
  readonly lineNumber?: number;
  readonly probeSeq?: number;
  readonly detail: string;
}

/** 解析器识别出的连续序列缺口及随后观察到的位置。 */
export interface ProbeSequenceGap {
  readonly kind: "GAP";
  readonly firstMissing: number;
  readonly lastMissing: number;
  readonly observedNext: number;
  readonly lineNumber: number;
}

/** 单条有效 JSONL 记录在已提交原始制品中的字节位置与摘要。 */
export interface ProbeLineLocation {
  readonly lineNumber: number;
  /** 在已提交 JSONL 制品中的起始字节偏移，包含该字节。 */
  readonly byteStart: number;
  /** 不包含 JSONL 换行符的结束字节偏移。 */
  readonly byteEnd: number;
  readonly lineDigest: ContentDigest;
}

/** 已验证 Envelope、关联结论和原始位置组成的解析记录。 */
export interface ParsedProbeRecord {
  readonly envelope: ProbeEnvelope;
  readonly association: ProbeAssociation;
  readonly location: ProbeLineLocation;
}

/** 解析阶段生成的观察草稿；待原始字节提交后再由物化函数补齐不可变记录元数据。 */
export interface ProbeRawObservationDraft {
  readonly observationId: string;
  readonly attemptId: string;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly externalEventType: string;
  readonly sourceTime: SourceTime;
  readonly payloadInline: ProbeEnvelope;
  readonly captureMetadata: {
    readonly lineNumber: number;
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly association: ProbeAssociation;
    readonly rawArtifactRef?: Ref<ArtifactRef>;
  };
  readonly rawDigest: ContentDigest;
}

/** 解析阶段汇总的 Probe 采集水位、缺口和完整性草稿。 */
export interface ProbeCollectionStatusDraft {
  readonly collectionStatusId: string;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly recordCount: number;
  readonly firstSourceSeq?: number;
  readonly lastSourceSeq?: number;
  readonly finalWatermark?: string;
  readonly gaps: readonly ProbeCollectionGapDraft[];
  readonly truncated: boolean;
  readonly health: "HEALTHY" | "DEGRADED" | "FAILED";
  readonly completeness: EvidenceCompleteness;
  readonly failureRefs: readonly Ref<FailureRecord>[];
}

/** 可写入 CollectionStatus 的规范化缺口描述。 */
export interface ProbeCollectionGapDraft {
  readonly kind: string;
  readonly firstMissingSeq?: number;
  readonly lastMissingSeq?: number;
  readonly reasonCode: string;
  readonly detail: JsonValue;
}

/** 解析 Probe 字节流所需的冻结关联身份、采集时间和可选限制标记。 */
export interface ProbeParseOptions {
  readonly expectedRunId: string;
  /** 已提交目标启动回执中的 PID（如果可用）。 */
  readonly expectedPid?: number;
  readonly attemptId: string;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly collectionStatusId: string;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly observedAt: string;
  readonly clockDomain?: string;
  readonly rawArtifactRef?: Ref<ArtifactRef>;
  readonly failureRefs?: readonly Ref<FailureRecord>[];
  readonly makeObservationId?: (lineNumber: number, probeSeq: number) => string;
  /** 标记采集器是否因冻结的字节或时间上限停止。 */
  readonly inputTruncated?: boolean;
  /** 标记原始字节因命中 Secret Canary 而只能作为 Restricted 制品保存。 */
  readonly contentRestricted?: boolean;
}

/** 一次有界 Probe 文件读取的精确字节及停止原因。 */
export interface BoundedProbeRead {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

/** 不跟随目标创建的符号链接，并按冻结限额读取 Probe 文件；由 app/workflow.ts 在 DRAINING 阶段调用。 */
export async function readProbeFileBounded(input: {
  readonly path: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}): Promise<BoundedProbeRead> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new ContractViolation("INVALID_INPUT", "Probe maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new ContractViolation("INVALID_INPUT", "Probe timeoutMs must be a positive safe integer");
  }
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(input.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bytes: Buffer.alloc(0), truncated: false, timedOut: false };
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ContractViolation("PATH_ESCAPE", "Probe output must be a regular non-symlink file");
  }
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const startedAt = Date.now();
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new ContractViolation("PATH_ESCAPE", "Probe output changed identity before bounded read");
    }
    const targetLength = Math.min(opened.size, input.maxBytes);
    const buffer = Buffer.alloc(targetLength);
    let offset = 0;
    let timedOut = false;
    while (offset < targetLength) {
      if (Date.now() - startedAt >= input.timeoutMs) {
        timedOut = true;
        break;
      }
      const result = await handle.read(buffer, offset, targetLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const closed = await handle.stat();
    const identityChanged = closed.dev !== opened.dev || closed.ino !== opened.ino;
    if (identityChanged) {
      throw new ContractViolation("PATH_ESCAPE", "Probe output changed identity during bounded read");
    }
    return {
      bytes: buffer.subarray(0, offset),
      truncated: timedOut || closed.size > offset,
      timedOut,
    };
  } finally {
    await handle.close();
  }
}

/** Probe 解析产生的原始字节、可信前缀、记录、草稿和完整性问题集合。 */
export interface ProbeParseResult {
  /** 采集器提供的精确字节，不做换行或编码规范化。 */
  readonly rawArtifactBytes: Uint8Array;
  /** 最长可信 JSONL 前缀；遇到畸形行即停止扩展。 */
  readonly validPrefixByteLength: number;
  readonly records: readonly ParsedProbeRecord[];
  readonly observations: readonly ProbeRawObservationDraft[];
  readonly collectionStatus: ProbeCollectionStatusDraft;
  readonly issues: readonly ProbeIssue[];
}

/** 原始 Probe 制品提交后物化观察和采集状态所需的输入。 */
export interface MaterializeProbeCollectionInput {
  readonly scope: ScopeRef;
  readonly parseResult: ProbeParseResult;
  readonly rawArtifact: ArtifactRef;
  readonly rawArtifactRef: Ref<ArtifactRef>;
  readonly createdAt: string;
  readonly producerVersion: string;
  readonly failureRefs?: readonly Ref<FailureRecord>[];
}

/** 可由仓储提交的 Probe RawObservation 列表与 CollectionStatus。 */
export interface MaterializedProbeCollection {
  readonly observations: readonly RawObservation[];
  readonly collectionStatus: CollectionStatus;
}

/** 当前解析器接受的外部 Probe Envelope Schema。 */
const PROBE_SCHEMA = "dsh-eval.probe/v1";

/** 写入 SourceDescriptor 的 Probe 实现稳定标识。 */
export const PROBE_IMPLEMENTATION_ID = "dsh-runtime-probe";
/** 写入 SourceDescriptor 的 Probe 实现版本。 */
export const PROBE_IMPLEMENTATION_VERSION = "1.0.0";
/** 冻结到观察计划中的 Probe 能力清单。 */
export const PROBE_CAPABILITIES = [
  "CONTENT_MODE_STRUCTURED",
  "CONTIGUOUS_SEQUENCE",
  "ONE_SHOT",
  "PROBE_START_STOP",
  "SESSION_LIFECYCLE",
  "SOURCE_RUN_ID",
  "TOOL_LIFECYCLE",
] as const;
/** PROBE_CAPABILITIES 的固定摘要，用于计划与运行实现之间的漂移检测。 */
export const PROBE_CAPABILITY_DIGEST: ContentDigest = {
  algorithm: "sha256",
  byteLength: 132,
  value: "11ab0f3b91fd3b28943640d97465e81d06d5baaa3af1eb1668014306e0506418",
};

/**
 * 高频 chunk 和 runtime/session 镜像也要留下逐事件索引，但不重复内嵌完整负载。
 * 精确原文仍由 captureMetadata 的字节范围和 rawDigest 指向原始 JSONL Artifact。
 */
function observationPayload(envelope: ProbeEnvelope): ProbeEnvelope {
  const event = isRecord(envelope.data.event) ? envelope.data.event : undefined;
  const payload = isRecord(envelope.data.payload) ? envelope.data.payload : undefined;
  const mirroredEventName = typeof payload?.eventName === "string"
    ? payload.eventName
    : typeof envelope.data.name === "string" ? envelope.data.name : undefined;
  const assistantChunk = envelope.kind === "session/event" && event?.type === "assistant/chunk";
  const sessionMirror = envelope.kind === "runtime/event" && mirroredEventName === "session/event";
  if (!assistantChunk && !sessionMirror) return envelope;
  return {
    schema: envelope.schema,
    runId: envelope.runId,
    probeSeq: envelope.probeSeq,
    at: envelope.at,
    monotonicNs: envelope.monotonicNs,
    pid: envelope.pid,
    kind: envelope.kind,
    data: {
      compactedDuplicate: true,
      ...(typeof envelope.data.sessionId === "string" ? { sessionId: envelope.data.sessionId } : {}),
      ...(event === undefined
        ? {}
        : {
            event: {
              ...(typeof event.type === "string" ? { type: event.type } : {}),
              ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
              ...(typeof event.time === "number" ? { time: event.time } : {}),
            },
          }),
      ...(mirroredEventName === undefined ? {} : { eventName: mirroredEventName }),
      ...(isRecord(envelope.data.native) ? { native: envelope.data.native } : {}),
    },
  };
}

/**
 * 解析冻结的 Probe JSONL 字节流并保留精确原文；由 app/workflow.ts 在原始制品提交前调用，内部校验 Envelope、序列及 start/turn/stop 边界。
 */
export function parseProbeJsonl(
  input: Uint8Array | string,
  options: ProbeParseOptions,
): ProbeParseResult {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const records: ParsedProbeRecord[] = [];
  const observations: ProbeRawObservationDraft[] = [];
  const issues: ProbeIssue[] = [];
  const gaps: ProbeSequenceGap[] = [];
  const seenSequences = new Set<number>();
  let expectedSequence = 0;
  let offset = 0;
  let lineNumber = 1;
  let validPrefixByteLength = 0;
  let malformed = false;

  if (options.contentRestricted === true) {
    issues.push({
      code: "PROBE_CONTENT_RESTRICTED",
      detail: "Probe content matched a configured Secret canary and was withheld from ordinary records",
    });
    offset = bytes.byteLength;
  }

  while (offset < bytes.byteLength) {
    const newlineIndex = bytes.indexOf(0x0a, offset);
    const hasNewline = newlineIndex !== -1;
    const rawEnd = hasNewline ? newlineIndex : bytes.byteLength;
    const contentEnd = rawEnd > offset && bytes[rawEnd - 1] === 0x0d ? rawEnd - 1 : rawEnd;
    const lineBytes = bytes.subarray(offset, contentEnd);

    let parsed: unknown;
    try {
      if (lineBytes.byteLength === 0) {
        throw new SyntaxError("empty JSONL line");
      }
      parsed = JSON.parse(lineBytes.toString("utf8"));
    } catch (error) {
      issues.push({
        code: "BAD_JSON",
        lineNumber,
        detail: error instanceof Error ? error.message : "Probe line is not valid JSON",
      });
      malformed = true;
      break;
    }

    if (!isProbeEnvelope(parsed)) {
      issues.push({
        code: "INVALID_ENVELOPE",
        lineNumber,
        detail: "Probe line does not satisfy dsh-eval.probe/v1 required fields",
      });
      malformed = true;
      break;
    }

    const location: ProbeLineLocation = {
      lineNumber,
      byteStart: offset,
      byteEnd: contentEnd,
      lineDigest: digestBytes(lineBytes),
    };
    const runMatches = parsed.runId === options.expectedRunId;
    const pidMatches = options.expectedPid === undefined || parsed.pid === options.expectedPid;
    const association: ProbeAssociation = runMatches && pidMatches ? "MATCHED" : "UNRESOLVED";
    if (!runMatches) {
      issues.push({
        code: "RUN_ID_MISMATCH",
        lineNumber,
        probeSeq: parsed.probeSeq,
        detail: `Expected frozen SourceRunId ${options.expectedRunId}; received ${parsed.runId}`,
      });
    }
    if (!pidMatches) {
      issues.push({
        code: "PID_MISMATCH",
        lineNumber,
        probeSeq: parsed.probeSeq,
        detail: `Expected committed Target PID ${options.expectedPid}; received ${parsed.pid}`,
      });
    }

    if (seenSequences.has(parsed.probeSeq)) {
      issues.push({
        code: "SEQUENCE_DUPLICATE",
        lineNumber,
        probeSeq: parsed.probeSeq,
        detail: `probeSeq ${parsed.probeSeq} was already observed`,
      });
    } else if (parsed.probeSeq < expectedSequence) {
      issues.push({
        code: "SEQUENCE_OUT_OF_ORDER",
        lineNumber,
        probeSeq: parsed.probeSeq,
        detail: `probeSeq ${parsed.probeSeq} arrived after sequence watermark ${expectedSequence - 1}`,
      });
    } else if (parsed.probeSeq > expectedSequence) {
      const gap: ProbeSequenceGap = {
        kind: "GAP",
        firstMissing: expectedSequence,
        lastMissing: parsed.probeSeq - 1,
        observedNext: parsed.probeSeq,
        lineNumber,
      };
      gaps.push(gap);
      issues.push({
        code: "SEQUENCE_GAP",
        lineNumber,
        probeSeq: parsed.probeSeq,
        detail: `Missing probeSeq ${gap.firstMissing}..${gap.lastMissing}`,
      });
      expectedSequence = parsed.probeSeq + 1;
    } else {
      expectedSequence += 1;
    }
    seenSequences.add(parsed.probeSeq);

    records.push({ envelope: parsed, association, location });
    observations.push({
        observationId:
          options.makeObservationId?.(lineNumber, parsed.probeSeq) ??
          `probe.${options.attemptId}.${lineNumber}`,
        attemptId: options.attemptId,
        sourceRef: options.sourceRef,
        externalEventType: parsed.kind,
        sourceTime: {
          wallTime: parsed.at,
          ...(toSafeInteger(parsed.monotonicNs) === undefined
            ? {}
            : { monotonicNs: toSafeInteger(parsed.monotonicNs) }),
          sourceSeq: parsed.probeSeq,
          observedAt: options.observedAt,
          clockDomain: options.clockDomain ?? "dsh-runtime-probe",
        },
        payloadInline: observationPayload(parsed),
        captureMetadata: {
          lineNumber,
          byteStart: offset,
          byteEnd: contentEnd,
          association,
          ...(options.rawArtifactRef === undefined ? {} : { rawArtifactRef: options.rawArtifactRef }),
        },
        rawDigest: location.lineDigest,
      });

    validPrefixByteLength = hasNewline ? rawEnd + 1 : rawEnd;
    offset = hasNewline ? rawEnd + 1 : rawEnd;
    lineNumber += 1;
  }

  validateProbeBoundaries(records, issues);
  validateSessionLifecycles(records, issues);
  const adapterTruncated = validateAdapterCapture(records, issues);
  if (options.inputTruncated === true || adapterTruncated) {
    issues.push({
      code: "PROBE_TRUNCATED",
      detail: "Probe collection reached its frozen byte or time bound",
    });
  }
  const sequences = records.map((record) => record.envelope.probeSeq);
  const stopRecords = records.filter((record) => record.envelope.kind === "probe/stop");
  const complete = issues.length === 0;
  const collectionGaps = issues.map((issue): ProbeCollectionGapDraft => {
    const sequenceGap =
      issue.code === "SEQUENCE_GAP"
        ? gaps.find(
            (gap) => gap.lineNumber === issue.lineNumber && gap.observedNext === issue.probeSeq,
          )
        : undefined;
    return {
      kind: issue.code,
      ...(sequenceGap === undefined
        ? {}
        : {
            firstMissingSeq: sequenceGap.firstMissing,
            lastMissingSeq: sequenceGap.lastMissing,
          }),
      reasonCode: probeIssueReasonCode(issue.code),
      detail: {
        ...(issue.lineNumber === undefined ? {} : { lineNumber: issue.lineNumber }),
        ...(issue.probeSeq === undefined ? {} : { probeSeq: issue.probeSeq }),
        message: issue.detail,
      },
    };
  });

  return {
    rawArtifactBytes: Uint8Array.from(bytes),
    validPrefixByteLength,
    records,
    observations,
    collectionStatus: {
      collectionStatusId: options.collectionStatusId,
      sourceRef: options.sourceRef,
      openedAt: options.openedAt,
      closedAt: options.closedAt,
      recordCount: records.length,
      ...(sequences.length === 0
        ? {}
        : {
            firstSourceSeq: sequences[0],
            lastSourceSeq: sequences[sequences.length - 1],
          }),
      ...(stopRecords.length === 1
        ? { finalWatermark: `probeSeq:${stopRecords[0]!.envelope.probeSeq}` }
        : {}),
      gaps: collectionGaps,
      truncated:
        malformed ||
        options.inputTruncated === true ||
        adapterTruncated ||
        options.contentRestricted === true ||
        validPrefixByteLength < bytes.byteLength,
      health: complete ? "HEALTHY" : "DEGRADED",
      completeness: complete ? "COMPLETE" : "PARTIAL",
      failureRefs: options.failureRefs ?? [],
    },
    issues,
  };
}

/** 在精确 JSONL 字节已提交后物化 Probe 观察与 CollectionStatus；由 app/workflow.ts 在 ArtifactStore 返回引用后调用。 */
export function materializeProbeCollection(
  input: MaterializeProbeCollectionInput,
): MaterializedProbeCollection {
  const scope = validateScope(input.scope);
  if (scope.attemptId === undefined) {
    throw new ContractViolation("INVALID_SCOPE", "Probe observations require Attempt Scope");
  }
  assertSameAttemptScope(scope, input.rawArtifact.scope);
  if (
    !digestEquals(digestBytes(input.parseResult.rawArtifactBytes), input.rawArtifact.artifactContentDigest) ||
    !digestEquals(input.rawArtifact.contentDigest, input.rawArtifactRef.digest) ||
    input.rawArtifact.artifactId !== input.rawArtifactRef.id
  ) {
    throw new ContractViolation(
      "EVIDENCE_INTEGRITY",
      "Committed Probe Artifact does not match the exact collected JSONL bytes",
    );
  }
  const observations = input.parseResult.observations.map((draft) => {
    if (draft.attemptId !== scope.attemptId) {
      throw new ContractViolation("SCOPE_MISMATCH", "Probe observation belongs to another Attempt");
    }
    const captureMetadata: JsonObject = {
      lineNumber: draft.captureMetadata.lineNumber,
      byteStart: draft.captureMetadata.byteStart,
      byteEnd: draft.captureMetadata.byteEnd,
      association: draft.captureMetadata.association,
      rawArtifactRef: refJson(input.rawArtifactRef),
    };
    return withContentDigest({
      schema: "evaldock.mvp.raw-observation/v1" as const,
      observationId: validateStableId<"ObservationId">(draft.observationId, "observationId"),
      scope,
      attemptId: scope.attemptId!,
      sourceRef: draft.sourceRef,
      externalEventType: draft.externalEventType,
      sourceTime: draft.sourceTime,
      payloadInline: draft.payloadInline as unknown as JsonValue,
      captureMetadata,
      rawDigest: draft.rawDigest,
      createdAt: input.createdAt,
      producerVersion: input.producerVersion,
    });
  });
  const draft = input.parseResult.collectionStatus;
  const finalWatermark = draft.finalWatermark?.startsWith("probeSeq:")
    ? { probeSeq: Number(draft.finalWatermark.slice("probeSeq:".length)) }
    : undefined;
  const collectionStatus = withContentDigest({
    schema: "evaldock.mvp.collection-status/v1" as const,
    collectionStatusId: validateStableId<"CollectionStatusId">(
      draft.collectionStatusId,
      "collectionStatusId",
    ),
    scope,
    sourceRef: draft.sourceRef,
    openedAt: draft.openedAt,
    closedAt: draft.closedAt,
    recordCount: draft.recordCount,
    ...(draft.firstSourceSeq === undefined ? {} : { firstSourceSeq: draft.firstSourceSeq }),
    ...(draft.lastSourceSeq === undefined ? {} : { lastSourceSeq: draft.lastSourceSeq }),
    ...(finalWatermark === undefined ? {} : { finalWatermark }),
    gaps: draft.gaps,
    truncated: draft.truncated,
    health: draft.health,
    completeness: draft.completeness,
    failureRefs: stableFailureRefs([...(draft.failureRefs ?? []), ...(input.failureRefs ?? [])]),
    createdAt: input.createdAt,
    producerVersion: input.producerVersion,
  });
  return { observations, collectionStatus };
}

/** 将采集完整性问题转换为可持久化的 Collector 失败草稿；由 app/workflow.ts 在物化 CollectionStatus 前调用。 */
export function probeIssueFailureDrafts(
  parseResult: ProbeParseResult,
  input: {
    readonly scope: ScopeRef;
    readonly occurredAt: string;
    readonly rawArtifactRef?: Ref<ArtifactRef>;
  },
): readonly FailureDraft[] {
  const scope = validateScope(input.scope);
  const uniqueCodes = [...new Set(parseResult.issues.map((issue) => issue.code))].sort();
  return uniqueCodes.map((code) => ({
    scope,
    category: "OBSERVATION_FAILURE" as const,
    origin: "EVALDOCK" as const,
    actor: "COLLECTOR" as const,
    phase: "PROBE_DRAIN",
    severity: "ERROR" as const,
    retryable: false as const,
    messageRedacted: `Runtime Probe collection is incomplete (${code})`,
    reasonCode: probeIssueReasonCode(code),
    evidenceRefs: [],
    artifactRefs: input.rawArtifactRef === undefined ? [] : [input.rawArtifactRef],
    occurredAt: validateIsoDateTime(input.occurredAt, "occurredAt"),
  }));
}

/** 将领域 Ref 转成可嵌入捕获元数据的 JSON；由 materializeProbeCollection 调用。 */
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


/** 适配器的源数据诊断随 Trace 字节持久化，二次解析时不能丢失。 */
function validateAdapterCapture(records: readonly ParsedProbeRecord[], issues: ProbeIssue[]): boolean {
  let truncated = false;
  for (const record of records) {
    const metadata = record.envelope.captureDiagnostics;
    if (metadata === undefined) continue;
    if (!isRecord(metadata) || metadata.schema !== "evaldock.trace-adapter-capture/v1" ||
      typeof metadata.truncated !== "boolean" || !Array.isArray(metadata.issues)) {
      issues.push({ code: "ADAPTER_CAPTURE_INCOMPLETE", detail: "Invalid adapter capture diagnostics" });
      continue;
    }
    truncated ||= metadata.truncated;
    for (const issue of metadata.issues) {
      issues.push({
        code: "ADAPTER_CAPTURE_INCOMPLETE",
        detail: isRecord(issue) && typeof issue.code === "string" && typeof issue.detail === "string"
          ? `${issue.code}: ${issue.detail}`
          : "Invalid adapter issue",
      });
    }
  }
  return truncated;
}

/** 以 Session 为作用域检查 Turn 与 Tool 配对；并行 Session 的相同 ID 不互相闭合。 */
function validateSessionLifecycles(records: readonly ParsedProbeRecord[], issues: ProbeIssue[]): void {
  const turns = new Set<string>();
  const tools = new Map<string, string>();
  for (const record of records) {
    const envelope = record.envelope;
    if (envelope.kind !== "session/event" || !isRecord(envelope.data.event)) continue;
    const event = envelope.data.event;
    if (!["turn/start", "turn/end", "tool/call", "tool/result"].includes(String(event.type))) continue;
    const sessionId = typeof envelope.data.sessionId === "string" ? envelope.data.sessionId : undefined;
    if (sessionId === undefined || sessionId.length === 0 || sessionId === "[unknown]") {
      issues.push({ code: "SESSION_SCOPE_UNRESOLVED", detail: "Lifecycle event has no reliable Session ID" });
      continue;
    }
    const data = isRecord(event.data) ? event.data : {};
    const turnKey = JSON.stringify([sessionId, data.turn ?? null]);
    if (event.type === "turn/start") {
      if (turns.has(turnKey)) issues.push({ code: "TURN_INCOMPLETE", detail: "Duplicate turn/start" });
      turns.add(turnKey);
    } else if (event.type === "turn/end") {
      if (!turns.delete(turnKey)) issues.push({ code: "TURN_INCOMPLETE", detail: "turn/end has no matching start" });
      if ([...tools.values()].includes(sessionId)) {
        issues.push({ code: "TOOL_CALL_INCOMPLETE", detail: "Turn ended before its Session tool calls completed" });
      }
    } else {
      const message = isRecord(data.message) ? data.message : {};
      const source = isRecord(message.source) ? message.source : {};
      const callId = typeof data.callId === "string" ? data.callId : source.callId;
      if (typeof callId !== "string" || callId.length === 0) {
        issues.push({ code: "TOOL_CALL_INCOMPLETE", detail: "Tool lifecycle event has no callId" });
        continue;
      }
      const key = JSON.stringify([sessionId, callId]);
      if (event.type === "tool/call") {
        if (tools.has(key)) issues.push({ code: "TOOL_CALL_INCOMPLETE", detail: "Duplicate unresolved tool/call" });
        tools.set(key, sessionId);
      } else if (!tools.delete(key)) {
        issues.push({ code: "TOOL_CALL_INCOMPLETE", detail: "tool/result has no matching Session tool/call" });
      }
    }
  }
  if (turns.size > 0) issues.push({ code: "TURN_INCOMPLETE", detail: `${turns.size} turn(s) have no end` });
  if (tools.size > 0) issues.push({ code: "TOOL_CALL_INCOMPLETE", detail: `${tools.size} tool call(s) have no result` });
}

/** 校验 probe/start、已提交 turn 与 probe/stop 的数量和相对顺序；由 parseProbeJsonl 在逐行解析后调用。 */
function validateProbeBoundaries(
  records: readonly ParsedProbeRecord[],
  issues: ProbeIssue[],
): void {
  const starts = records.filter((record) => record.envelope.kind === "probe/start");
  const stops = records.filter((record) => record.envelope.kind === "probe/stop");
  if (stops.some((record) => record.envelope.data.nativeStopObserved === false)) {
    issues.push({
      code: "NATIVE_STOP_UNCONFIRMED",
      detail: "Target process exit was observed, but Native Probe flush/stop was not confirmed",
    });
  }
  const committedTurns = records.filter(
    (record) =>
      record.envelope.kind === "session/event" &&
      isRecord(record.envelope.data.event) &&
      (record.envelope.data.event.type === "turn/start" ||
        record.envelope.data.event.type === "turn/end"),
  );

  if (starts.length === 0) {
    issues.push({ code: "PROBE_START_MISSING", detail: "probe/start was not observed" });
  } else if (starts.length > 1) {
    issues.push({ code: "PROBE_START_DUPLICATE", detail: "More than one probe/start was observed" });
  }
  if (committedTurns.length === 0) {
    issues.push({
      code: "COMMITTED_TURN_MISSING",
      detail: "No committed session turn boundary was observed",
    });
  }
  if (
    starts.length > 0 &&
    committedTurns.length > 0 &&
    starts[0]!.location.lineNumber >= committedTurns[0]!.location.lineNumber
  ) {
    issues.push({
      code: "PROBE_START_LATE",
      lineNumber: starts[0]!.location.lineNumber,
      probeSeq: starts[0]!.envelope.probeSeq,
      detail: "probe/start did not precede the first committed turn",
    });
  }

  if (stops.length === 0) {
    issues.push({ code: "PROBE_STOP_MISSING", detail: "probe/stop was not observed" });
  } else if (stops.length > 1) {
    issues.push({ code: "PROBE_STOP_DUPLICATE", detail: "More than one probe/stop was observed" });
  }
  if (
    stops.length > 0 &&
    committedTurns.length > 0 &&
    stops[stops.length - 1]!.location.lineNumber <=
      committedTurns[committedTurns.length - 1]!.location.lineNumber
  ) {
    const stop = stops[stops.length - 1]!;
    issues.push({
      code: "PROBE_STOP_EARLY",
      lineNumber: stop.location.lineNumber,
      probeSeq: stop.envelope.probeSeq,
      detail: "probe/stop did not follow the last committed turn boundary",
    });
  }
}

/** 对未知 JSON 值执行 ProbeEnvelope 结构守卫；由 parseProbeJsonl 逐行调用。 */
function isProbeEnvelope(value: unknown): value is ProbeEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.schema === PROBE_SCHEMA &&
    typeof value.runId === "string" &&
    Number.isSafeInteger(value.probeSeq) &&
    (value.probeSeq as number) >= 0 &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at)) &&
    isMonotonicNs(value.monotonicNs) &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.kind === "string" &&
    value.kind.length > 0 &&
    isRecord(value.data)
  );
}

/** 将解析问题代码规范化为失败记录的 PROBE_* 原因码；由采集状态和失败草稿生成路径调用。 */
function probeIssueReasonCode(code: ProbeIssueCode): string {
  return code.startsWith("PROBE_") ? code : `PROBE_${code}`;
}

/** 验证外部单调时钟值是非负安全整数或十进制字符串；由 isProbeEnvelope 调用。 */
function isMonotonicNs(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^\d+$/.test(value))
  );
}

/** 在不会丢失整数精度时转换单调时钟值；由 parseProbeJsonl 构造 SourceTime 时调用。 */
function toSafeInteger(value: number | string): number | undefined {
  const converted = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : undefined;
}

/** 判断未知值是否为普通对象；由 Envelope 与嵌套 Session 事件校验调用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按失败标识和摘要去重并排序引用；由 materializeProbeCollection 合并解析与调用方失败时使用。 */
function stableFailureRefs(refs: readonly Ref<FailureRecord>[]): readonly Ref<FailureRecord>[] {
  const unique = new Map(refs.map((ref) => [`${ref.id}\u0000${ref.digest.value}`, ref] as const));
  return [...unique.values()].sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
}
