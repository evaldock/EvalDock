/**
 * 将 Native Probe 转换为兼容 Trace，同时保留原序列、原始哈希与采集缺口。
 * 合并排序只改变索引顺序，不能作为原始采集完整性的证明。
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

interface NativeTraceEnvelope {
  readonly schema: "evaldock.trace/v1";
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly monotonicNs: string;
  readonly kind: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly correlation: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
  readonly integrity?: Readonly<Record<string, unknown>>;
}

export interface NativeProbeTraceInput {
  readonly probeOutputPath: string;
  readonly sourceRunId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly maxBytes: number;
}

export interface NativeProbeTraceResult {
  readonly bytes: Buffer;
  readonly sourcePaths: readonly string[];
  readonly eventCount: number;
  readonly truncated: boolean;
}

export function nativeProbeRunDirectory(probeOutputPath: string, sourceRunId: string): string {
  return path.join(path.dirname(probeOutputPath), sourceRunId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compatibleKind(record: NativeTraceEnvelope): { kind: string; data: Record<string, unknown> } {
  const payload = isRecord(record.data.payload) ? record.data.payload : {};
  const native = {
    seq: record.seq,
    kind: record.kind,
    source: record.source,
    correlation: record.correlation,
    capture: record.data.capture ?? {},
    integrity: record.integrity ?? {},
  };
  if (record.kind === "probe.start") {
    return { kind: "probe/start", data: { ...payload, source: "EVALDOCK_NATIVE_PROBE", native } };
  }
  if (record.kind === "probe.stop") {
    return { kind: "probe/stop", data: { ...payload, source: "EVALDOCK_NATIVE_PROBE", native } };
  }
  if (record.kind === "session.event") return { kind: "session/event", data: { ...payload, native } };
  if (record.kind === "runtime.log") return { kind: "runtime/log", data: { ...payload, native } };
  return { kind: "runtime/event", data: { eventName: record.kind, payload, native } };
}

/** 在分配缓冲区前限制原始文件读取量；不跟随文件符号链接。 */
async function readNativeFile(file: string, maxBytes: number): Promise<{
  bytes: Buffer; truncated: boolean;
} | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Native Probe source must be a regular file");
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    return {
      bytes: buffer.subarray(0, offset),
      truncated: info.size !== after.size || offset < info.size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * RunWriter 的 events/logs 共用全局 seq 和哈希链。先逐流验证顺序，再合并校验；
 * 不去掉重复记录，不用兼容序号掩盖源序列缺口。已存在但损坏/空的 Native 输入
 * 必须保留失败事实，不能伪装成“不存在”并静默回退。
 */
export async function readNativeProbeTrace(input: NativeProbeTraceInput): Promise<NativeProbeTraceResult | undefined> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error("maxBytes must be positive");
  const runDirectory = nativeProbeRunDirectory(input.probeOutputPath, input.sourceRunId);
  const sourcePaths: string[] = [];
  const records: NativeTraceEnvelope[] = [];
  const rejected: Array<{ stream: string; lineNumber: number; rawLine: string }> = [];
  const issues = new Map<string, string>();
  const issue = (code: string, detail: string): void => { if (!issues.has(code)) issues.set(code, detail); };
  let remaining = input.maxBytes;
  let truncated = false;
  for (const stream of ["events.jsonl", "logs.jsonl"]) {
    const file = path.join(runDirectory, stream);
    const loaded = await readNativeFile(file, remaining);
    if (loaded === undefined) continue;
    sourcePaths.push(file);
    remaining -= loaded.bytes.byteLength;
    truncated ||= loaded.truncated;
    let previousSeq = 0;
    for (const [index, line] of loaded.bytes.toString("utf8").split(/\r?\n/u).entries()) {
      if (line.length === 0) continue;
      let value: unknown;
      try { value = JSON.parse(line) as unknown; } catch { value = undefined; }
      if (!isRecord(value) || value.schema !== "evaldock.trace/v1" ||
        value.runId !== input.sourceRunId || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1 ||
        typeof value.ts !== "string" || !Number.isFinite(Date.parse(value.ts)) ||
        typeof value.monotonicNs !== "string" || !/^\d+$/u.test(value.monotonicNs) ||
        typeof value.kind !== "string" || !isRecord(value.source) ||
        !isRecord(value.correlation) || !isRecord(value.data)) {
        issue("NATIVE_RECORD_INVALID", "Malformed or foreign Native record retained as diagnostic data");
        rejected.push({ stream, lineNumber: index + 1, rawLine: line });
        continue;
      }
      const record = value as unknown as NativeTraceEnvelope;
      if (record.seq <= previousSeq) issue("NATIVE_STREAM_ORDER_INVALID", "Native stream sequence is not increasing");
      previousSeq = record.seq;
      records.push(record);
    }
  }
  if (sourcePaths.length === 0) return undefined;
  if (records.length === 0) issue("NATIVE_RECORDS_MISSING", "Native files contain no valid records");
  records.sort((left, right) => left.seq - right.seq);
  let expectedSeq = 1;
  let previousHash = "0".repeat(64);
  for (const record of records) {
    if (record.seq !== expectedSeq) {
      issue(record.seq < expectedSeq ? "NATIVE_SEQUENCE_DUPLICATE" : "NATIVE_SEQUENCE_GAP",
        "Native global sequence is not contiguous from one");
    }
    expectedSeq = Math.max(expectedSeq, record.seq + 1);
    const { integrity, ...body } = record;
    if (integrity?.algorithm !== "sha256-chain-v1" ||
      typeof integrity.previous !== "string" || !/^[a-f0-9]{64}$/u.test(integrity.previous) ||
      typeof integrity.hash !== "string" || !/^[a-f0-9]{64}$/u.test(integrity.hash)) {
      issue("NATIVE_HASH_INVALID", "Native hash-chain metadata is missing or invalid");
    } else {
      const hash = createHash("sha256").update(integrity.previous).update("\n").update(JSON.stringify(body)).digest("hex");
      if (integrity.previous !== previousHash || integrity.hash !== hash) {
        issue("NATIVE_HASH_INVALID", "Native record content or hash-chain linkage failed verification");
      }
    }
    previousHash = typeof integrity?.hash === "string" ? integrity.hash : "";
    if (record.kind === "collector.dropped" || record.kind === "capture.error" || record.data.$type === "oversize-record") {
      issue("NATIVE_CAPTURE_LOSS", "Native writer reported dropped, failed or oversized capture");
    }
    const capture = isRecord(record.data.capture) ? record.data.capture : {};
    if (typeof capture.truncated === "number" && capture.truncated > 0) {
      issue("NATIVE_CAPTURE_TRUNCATED", "Native serializer reached a configured depth, breadth, string or node limit");
    }
    const payload = isRecord(record.data.payload) ? record.data.payload : {};
    if (record.kind === "probe.stop" && payload.writerFailure != null) {
      issue("NATIVE_WRITER_FAILURE", "Native writer reported failure at shutdown");
    }
  }
  const envelopes: Array<Record<string, unknown>> = records.map((record, probeSeq) => ({
    schema: "dsh-eval.probe/v1", runId: input.sourceRunId, probeSeq,
    at: record.ts, monotonicNs: record.monotonicNs, pid: input.pid, ...compatibleKind(record),
  }));
  for (const raw of rejected) {
    envelopes.push({
      schema: "dsh-eval.probe/v1", runId: input.sourceRunId, probeSeq: envelopes.length,
      at: input.endedAt, monotonicNs: records.at(-1)?.monotonicNs ?? "0", pid: input.pid,
      kind: "runtime/event", data: { eventName: "adapter.invalid-record", payload: raw },
    });
  }
  if (!records.some((record) => record.kind === "probe.stop")) {
    // 这是独立的进程退出事实，不是 Native flush/stop 的替代证明。
    envelopes.push({
      schema: "dsh-eval.probe/v1", runId: input.sourceRunId, probeSeq: envelopes.length,
      at: input.endedAt, monotonicNs: records.at(-1)?.monotonicNs ?? "0", pid: input.pid,
      kind: "probe/stop",
      data: { reason: "target-process-exit", source: "EVALDOCK_NATIVE_ADAPTER", nativeStopObserved: false },
    });
  }
  envelopes[0] = {
    ...envelopes[0]!,
    captureDiagnostics: {
      schema: "evaldock.trace-adapter-capture/v1",
      source: "EVALDOCK_NATIVE_PROBE",
      truncated,
      issues: [...issues].map(([code, detail]) => ({ code, detail })),
    },
  };
  return {
    bytes: Buffer.from(envelopes.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8"),
    sourcePaths: Object.freeze(sourcePaths), eventCount: envelopes.length, truncated,
  };
}
