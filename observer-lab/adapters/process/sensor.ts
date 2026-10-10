/**
 * 文件职责：只读采集 macOS 进程表并生成可复现的目标用户进程快照草稿。
 * MVP 边界：仅保留进程身份、父子关系、状态、启动时间和 executable；不采集参数、环境变量或文件句柄。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  digestValue,
  type ContentDigest,
  type EvidenceCompleteness,
  type ProcessEntry,
} from "../../../src/core/models.js";

const execFileAsync = promisify(execFile);

export const PROCESS_SENSOR_IMPLEMENTATION_ID = "evaldock.macos-process-sensor";
export const PROCESS_SENSOR_IMPLEMENTATION_VERSION = "1.0.0";
export const PROCESS_SENSOR_CAPABILITIES = [
  "EXECUTABLE",
  "PROCESS_ID",
  "PROCESS_PARENT",
  "PROCESS_STATE",
  "READ_ERRORS",
  "READ_ONLY",
  "SNAPSHOT_AFTER",
  "SNAPSHOT_BEFORE",
  "SNAPSHOT_POST_RESET",
  "START_TIME",
  "USER_ID",
] as const;
export const PROCESS_SENSOR_CAPABILITY_DIGEST: ContentDigest = {
  algorithm: "sha256",
  byteLength: 166,
  value: "d579f56ba73da27609209bf62bec95ad1edc1a112eeb4a1d33ce3755bd282b53",
};

export type ProcessSnapshotPhase = "BEFORE" | "AFTER" | "POST_RESET";

export interface ProcessSnapshotDraft {
  readonly processSnapshotId: string;
  readonly attemptId: string;
  readonly phase: ProcessSnapshotPhase;
  readonly resourceBinding: string;
  readonly observedUid: number;
  readonly scanStartedAt: string;
  readonly scanCompletedAt: string;
  readonly entries: readonly ProcessEntry[];
  readonly readErrors: readonly string[];
  readonly completeness: EvidenceCompleteness;
  readonly snapshotDigest: ContentDigest;
}

export interface CaptureProcessSnapshotOptions {
  readonly processSnapshotId: string;
  readonly attemptId: string;
  readonly phase: ProcessSnapshotPhase;
  readonly resourceBinding: string;
  readonly observedUid: number;
  readonly now?: () => string;
  readonly runPs?: () => Promise<string>;
}

/** 解析固定列宽之外的 ps 行；lstart 固定占五个 token，剩余内容为 executable。 */
export function parseMacosProcessList(stdout: string, observedUid: number): readonly ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const tokens = rawLine.trim().split(/\s+/u);
    if (tokens.length < 11) continue;
    const [pidText, parentText, uidText, gidText, state, ...tail] = tokens;
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    const uid = Number(uidText);
    const gid = Number(gidText);
    if (![pid, parentPid, uid, gid].every(Number.isSafeInteger) || uid !== observedUid) continue;
    const startedAt = tail.slice(0, 5).join(" ");
    const executable = tail.slice(5).join(" ");
    if (startedAt.length === 0 || executable.length === 0) continue;
    entries.push({ pid, parentPid, uid, gid, state: state!, startedAt, executable });
  }
  return Object.freeze(entries.sort((left, right) => left.pid - right.pid));
}

async function defaultRunPs(): Promise<string> {
  const result = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,uid=,gid=,state=,lstart=,comm="],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  return result.stdout;
}

/** 运行只读 ps，并将失败显式降级为 PARTIAL 快照，避免把“未观测到”当作“没有进程”。 */
export async function captureProcessSnapshot(
  options: CaptureProcessSnapshotOptions,
): Promise<ProcessSnapshotDraft> {
  if (!Number.isSafeInteger(options.observedUid) || options.observedUid < 0) {
    throw new TypeError("observedUid must be a non-negative integer");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const scanStartedAt = now();
  let entries: readonly ProcessEntry[] = [];
  let readErrors: readonly string[] = [];
  try {
    entries = parseMacosProcessList(await (options.runPs ?? defaultRunPs)(), options.observedUid);
  } catch {
    readErrors = Object.freeze(["PROCESS_LIST_READ_FAILED"]);
  }
  const scanCompletedAt = now();
  const completeness: EvidenceCompleteness = readErrors.length === 0 ? "COMPLETE" : "PARTIAL";
  return Object.freeze({
    processSnapshotId: options.processSnapshotId,
    attemptId: options.attemptId,
    phase: options.phase,
    resourceBinding: options.resourceBinding,
    observedUid: options.observedUid,
    scanStartedAt,
    scanCompletedAt,
    entries,
    readErrors,
    completeness,
    snapshotDigest: digestValue({
      resourceBinding: options.resourceBinding,
      observedUid: options.observedUid,
      entries,
      readErrors,
      completeness,
    }),
  });
}
