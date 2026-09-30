/**
 * 文件职责：把 DSH 自身落盘的 Session 日志转换为 EvalDock 的 Agent Trace 线协议。
 * 该适配只读取 Agent Session，不属于 Environment Observer。
 */
import { createSessionEvidenceCompactor } from "../agent-trace/native-probe/src/evidence-events.js";
import { spawn } from "node:child_process";
import { eventFingerprint, reduceSessionEvents, mergeRemainingStreams, sequenceSpan, type SessionRecord } from "../agent-trace/native-probe/src/session-events.js";

interface DshSessionRecord {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly time?: unknown;
  readonly data?: unknown;
  readonly id?: unknown;
  readonly [field: string]: unknown;
}

export interface DshSessionTraceInput {
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly jsonl: string;
    readonly truncated?: boolean;
  }[];
  readonly sourceRunId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endedAt: string;
}

/** 读取 Session 首记录中的工作目录，用于并发 Case 精确归属。 */
export function dshSessionCwd(jsonl: string): string | undefined {
  const firstLine = jsonl.split(/\r?\n/u).find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;
  try {
    const record = JSON.parse(firstLine) as DshSessionRecord;
    return record.type === "session" && typeof record.cwd === "string" ? record.cwd : undefined;
  } catch {
    return undefined;
  }
}

function eventTime(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

/** 保留语义事件原文；验证归档序列后，删除有完整提交逐字覆盖的流式片段。 */
export function dshSessionsToProbeJsonl(input: DshSessionTraceInput): Buffer {
  const envelopes: Array<Record<string, unknown>> = [];
  const issues = new Map<string, string>();
  const issue = (code: string, detail: string): void => { if (!issues.has(code)) issues.set(code, detail); };
  const sessionIds = new Set<string>();
  const filtering: Array<Record<string, unknown>> = [];
  if (input.sessions.length === 0) issue("SESSION_ARCHIVE_EMPTY", "No Session archive was captured");
  const emit = (kind: string, data: Record<string, unknown>, at: string): void => {
    const probeSeq = envelopes.length;
    envelopes.push({
      schema: "dsh-eval.probe/v1",
      runId: input.sourceRunId,
      probeSeq,
      at,
      monotonicNs: String(probeSeq * 1_000_000),
      pid: input.pid,
      kind,
      data,
    });
  };
  emit("probe/start", {
    source: "DSH_SESSION_ARCHIVE",
    sessionIds: input.sessions.map((session) => session.sessionId),
    filtering: { policy: "session-semantic-v2", sessions: filtering },
  }, input.startedAt);
  for (const session of input.sessions) {
    if (sessionIds.has(session.sessionId)) issue("SESSION_ARCHIVE_DUPLICATE", "Session archive supplied more than once");
    sessionIds.add(session.sessionId);
    let headerSeen = false;
    let firstRecord = true;
    let expectedSeq: number | undefined;
    const records: SessionRecord[] = [];
    const seen = new Map<string, string>();
    let duplicates = 0;
    for (const line of session.jsonl.split(/\r?\n/u)) {
      if (line.length === 0) continue;
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch { value = undefined; }
      if (value === null || typeof value !== "object" || Array.isArray(value) ||
        typeof (value as DshSessionRecord).type !== "string") {
        issue("SESSION_RECORD_INVALID", "Malformed Session record retained as diagnostic data");
        emit("runtime/event", { eventName: "adapter.invalid-record", sessionId: session.sessionId, rawLine: line }, input.startedAt);
        firstRecord = false;
        continue;
      }
      const record = value as DshSessionRecord;
      if (record.type === "session") {
        if (!firstRecord || headerSeen || record.id !== session.sessionId) {
          issue("SESSION_HEADER_INVALID", "Session header is duplicate, misplaced or belongs to another Session");
        }
        headerSeen = true;
        firstRecord = false;
        continue;
      }
      firstRecord = false;
      const span = sequenceSpan(record);
      if (span === undefined) {
        issue("SESSION_SEQUENCE_INVALID", "Session event or packed chunk row has no valid sequence/shape");
      } else {
        const key = `${span.first}:${span.last}`;
        const digest = eventFingerprint(record);
        if (seen.get(key) === digest) { duplicates++; continue; }
        if (seen.has(key)) issue("SESSION_SEQUENCE_CONFLICT", "Same sequence has different contents; both retained");
        seen.set(key, digest);
        if (expectedSeq !== undefined && span.first !== expectedSeq) {
          issue("SESSION_SEQUENCE_GAP_OR_DUPLICATE", "Session events are not contiguous in archive order");
        }
        expectedSeq = span.last + 1;
      }
      records.push(record);
    }
    const reduced = reduceSessionEvents(records);
    filtering.push({ sessionId: session.sessionId, ...reduced.stats,
      inputRecords: reduced.stats.inputRecords + duplicates, duplicateRecords: duplicates });
    const compactor = createSessionEvidenceCompactor();
    const semantic = reduced.stats.conflictingSequences ? reduced.records : mergeRemainingStreams(reduced.records);
    for (const original of semantic) {
      const event = reduced.stats.conflictingSequences ? original : compactor.accept(original);
      if (!event) continue;
      emit("session/event", { sessionId: session.sessionId, event }, eventTime(event.time ?? event.time0, input.startedAt));
    }
    Object.assign(filtering[filtering.length-1]!, compactor.stats);
    if (!headerSeen) issue("SESSION_HEADER_MISSING", "Session archive does not contain its header");
  }
  emit("probe/stop", { source: "DSH_SESSION_ARCHIVE", boundaryBasis: "PERSISTED_ARCHIVE_READ" }, input.endedAt);
  envelopes[0] = {
    ...envelopes[0]!,
    captureDiagnostics: {
      schema: "evaldock.trace-adapter-capture/v1",
      source: "DSH_SESSION_ARCHIVE",
      truncated: input.sessions.some((session) => session.truncated === true),
      issues: [...issues].map(([code, detail]) => ({ code, detail })),
    },
  };
  return Buffer.from(`${envelopes.map((envelope) => JSON.stringify(envelope)).join("\n")}\n`, "utf8");
}

/** 使用 macOS VM 已安装的 zstd 有界解压一份 DSH Session Archive。 */
export async function readDshSessionArchive(
  archivePath: string,
  maxBytes: number,
): Promise<{ readonly jsonl: string; readonly truncated: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("zstd", ["-dc", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let accepted = 0;
    let truncated = false;
    child.stdout.on("data", (value: Buffer) => {
      const remaining = Math.max(0, maxBytes - accepted);
      if (remaining > 0) {
        const chunk = value.subarray(0, remaining);
        chunks.push(chunk);
        accepted += chunk.byteLength;
      }
      if (value.byteLength > remaining) truncated = true;
    });
    let errorBytes = 0;
    child.stderr.on("data", (value: Buffer) => {
      const chunk = value.subarray(0, Math.max(0, 4096 - errorBytes));
      errorBytes += chunk.length;
      if (chunk.length > 0) errors.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`DSH Session archive decompression failed: ${Buffer.concat(errors).toString("utf8").slice(0, 256)}`));
        return;
      }
      const bytes = Buffer.concat(chunks);
      const completeBytes = truncated
        ? bytes.subarray(0, Math.max(0, bytes.lastIndexOf(0x0a) + 1))
        : bytes;
      resolve({ jsonl: completeBytes.toString("utf8"), truncated });
    });
  });
}
