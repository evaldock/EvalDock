/**
 * 文件职责：管理单 VM 全局 Run Lease，并检查本地持久化服务是否可安全使用。
 *
 * 核心流程：在 runRoot 原子创建唯一 Lease；启动时检查各 Root 的原子写能力，遍历
 * 已有 Run 分区并验证记录摘要、生命周期和终态；安全结束后只释放当前进程的 Lease。
 *
 * 与其他文件的交互：`app/bootstrap.ts` 调用 checkLocalServices；`app/workflow.ts`
 * 调用 acquireLease/releaseLease 并把返回事实保存为领域 LeaseRecord。
 *
 * 公开接口：LeaseFact、HealthCheckResult、acquireLease、releaseLease、checkLocalServices。
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { FileHandle } from "node:fs/promises";

import {
  assertDigestEquals,
  assertLegalTransition,
  digestValue,
  validateContentDigest,
} from "../core/models.js";

/** 平台锁文件中的最小 Lease 事实。 */
export interface LeaseFact {
  leaseId: string;
  runId: string;
  slotId: "vm-global";
  state: "ACTIVE" | "RELEASED";
  ownerPid: number;
  ownerProcessStartToken: string;
  acquiredAt: string;
  releasedAt?: string;
}

/** Bootstrap 使用的本地 Root 和启动恢复健康结果。 */
export interface HealthCheckResult {
  status: "HEALTHY" | "FAILED";
  checks: readonly {
    name: string;
    status: "PASS" | "FAIL";
    detail: string;
  }[];
}

/** 当前 Controller 进程的稳定所有者标记及本地 ID 语法。 */
const PROCESS_START_TOKEN = `${process.pid}-${process.hrtime.bigint().toString(10)}`;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 在平台路径操作前校验 Run ID 等外部标识。 */
function assertStableId(value: string, label: string): void {
  if (!STABLE_ID.test(value)) throw new Error(`${label} must be a StableId`);
}

/** 建立或验证一个本地服务 Root，并返回 canonical path。 */
async function safeServiceRoot(rootInput: string, label: string): Promise<string> {
  if (!path.isAbsolute(rootInput) || rootInput.includes("\0")) {
    throw new Error(`${label} must be an absolute NUL-free path`);
  }
  const root = path.resolve(rootInput);
  if (root === path.parse(root).root || root === os.homedir()) {
    throw new Error(`${label} must not be a filesystem or user-home root`);
  }
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpath(root);
}

/** 建立受约束的 locks 目录并返回唯一活动锁路径。 */
async function lockPath(runRoot: string): Promise<string> {
  const root = await safeServiceRoot(runRoot, "runRoot");
  const directory = path.join(root, "locks");
  const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) await mkdir(directory, { mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("lease lock path must be a real directory");
  }
  return path.join(await realpath(directory), "active-run.lock");
}

/** fsync 目录元数据，配合原子文件创建和重命名。 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 原子创建 vm-global Lease；已存在或来源不明的锁一律报告冲突。 */
export async function acquireLease(runRoot: string, runId: string): Promise<LeaseFact> {
  assertStableId(runId, "runId");
  const target = await lockPath(runRoot);
  const lease: LeaseFact = {
    leaseId: `lease-${randomUUID()}`,
    runId,
    slotId: "vm-global",
    state: "ACTIVE",
    ownerPid: process.pid,
    ownerProcessStartToken: PROCESS_START_TOKEN,
    acquiredAt: new Date().toISOString(),
  };
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
    await handle.sync();
    await syncDirectory(path.dirname(target));
    return lease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("LEASE_CONFLICT: vm-global already has an active or unconfirmed lease");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** 仅在 Run、PID 和进程启动标记全部匹配时释放当前 Lease。 */
export async function releaseLease(
  runRoot: string,
  activeLease: LeaseFact,
): Promise<LeaseFact> {
  if (activeLease.state !== "ACTIVE") {
    if (activeLease.state === "RELEASED") return activeLease;
    throw new Error("lease is not active");
  }
  const target = await lockPath(runRoot);
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("LEASE_INTEGRITY: active lease is not a regular file");
  }
  const persisted = JSON.parse(await readFile(target, "utf8")) as Partial<LeaseFact>;
  if (
    persisted.leaseId !== activeLease.leaseId ||
    persisted.runId !== activeLease.runId ||
    persisted.ownerPid !== process.pid ||
    persisted.ownerProcessStartToken !== PROCESS_START_TOKEN
  ) {
    throw new Error("LEASE_OWNERSHIP_MISMATCH: refusing to release another process lease");
  }
  await unlink(target);
  await syncDirectory(path.dirname(target));
  return { ...activeLease, state: "RELEASED", releasedAt: new Date().toISOString() };
}

/** 实测指定 Root 是否支持安全 staging、fsync 和原子 rename。 */
async function checkWritableAtomicRoot(root: string): Promise<string> {
  const safeRoot = await safeServiceRoot(root, "health root");
  const metadata = await stat(safeRoot);
  if (!metadata.isDirectory()) throw new Error("root is not a directory");
  const token = `.health-${process.pid}-${randomUUID()}`;
  const staged = path.join(safeRoot, `${token}.tmp`);
  const committed = path.join(safeRoot, token);
  try {
    await writeFile(staged, "health", { flag: "wx", mode: 0o600 });
    await rename(staged, committed);
    const fileSystem = await statfs(safeRoot);
    const availableBytes = fileSystem.bavail * fileSystem.bsize;
    if (availableBytes < 16 * 1024 * 1024) throw new Error("less than 16 MiB available");
    return `${availableBytes} bytes available; atomic rename succeeded`;
  } finally {
    await unlink(staged).catch(() => undefined);
    await unlink(committed).catch(() => undefined);
  }
}

/** 解析一个已提交 JSON 记录并要求顶层为对象。 */
function parseRecordObject(bytes: Buffer, location: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`STARTUP_RECOVERY_REQUIRED: invalid JSON at ${location}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`STARTUP_RECOVERY_REQUIRED: non-object JSON at ${location}`);
  }
  return parsed as Record<string, unknown>;
}

/** 递归验证 Run 分区内没有 symlink、临时残留或越界条目。 */
async function validatePartitionTree(
  partition: string,
  directory: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const location = path.relative(partition, candidate).split(path.sep).join("/");
    if (entry.name.startsWith(".tmp-") || entry.name.endsWith(".partial")) {
      throw new Error(`STARTUP_RECOVERY_REQUIRED: uncommitted path at ${location}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`STARTUP_RECOVERY_REQUIRED: symlink in records partition at ${location}`);
    }
    if (entry.isDirectory()) {
      await validatePartitionTree(partition, candidate);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`STARTUP_RECOVERY_REQUIRED: special file in records partition at ${location}`);
    }
    if (entry.name.endsWith(".json")) {
      parseRecordObject(await readFile(candidate), location);
      continue;
    }
    if (entry.name.endsWith(".jsonl")) {
      const text = await readFile(candidate, "utf8");
      if (text.length > 0 && !text.endsWith("\n")) {
        throw new Error(`STARTUP_RECOVERY_REQUIRED: incomplete JSONL at ${location}`);
      }
      for (const [index, line] of text.split("\n").entries()) {
        if (line.length === 0) continue;
        parseRecordObject(Buffer.from(line, "utf8"), `${location}:${index + 1}`);
      }
    }
  }
}

/** 验证最新 Run Projection 的 Schema、摘要、revision 和状态语义。 */
function validateRunProjection(
  record: Record<string, unknown>,
  expectedRunId: string,
  expectedRevision?: number,
): { readonly state: string; readonly revision: number; readonly digest: string } {
  if (
    record.schema !== "evaldock.mvp.run/v1" ||
    record.runId !== expectedRunId ||
    record.aggregateId !== expectedRunId
  ) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection identity is invalid");
  }
  const scope = record.scope;
  if (
    scope === null ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    (scope as Record<string, unknown>).runId !== expectedRunId
  ) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection scope is invalid");
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection revision is invalid");
  }
  const revision = Number(record.revision);
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection revision filename is inconsistent");
  }
  const states = new Set([
    "CREATED",
    "PREFLIGHTING",
    "RUNNING",
    "FINALIZING",
    "FINISHED",
    "FAILED",
    "CANCELLED",
  ]);
  if (typeof record.state !== "string" || !states.has(record.state)) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection state is invalid");
  }
  const declared = validateContentDigest(record.projectionDigest, "projectionDigest");
  assertDigestEquals(
    digestValue(record, ["projectionDigest"]),
    declared,
    "STARTUP_RUN_PROJECTION_INTEGRITY",
  );
  return { state: record.state, revision, digest: declared.value };
}

/** 将一个已有 Run 分区分类为仅规划事实或已安全终止。 */
async function inspectRunPartition(partition: string, runId: string): Promise<"PLANNING_ONLY" | "TERMINAL"> {
  await validatePartitionTree(partition, partition);
  const records = path.join(partition, "records");
  const recordsMetadata = await lstat(records).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (recordsMetadata === undefined) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: records partition has no records directory");
  }
  if (!recordsMetadata.isDirectory() || recordsMetadata.isSymbolicLink()) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: partition records path is not a real directory");
  }
  const runDirectory = path.join(records, "run");
  const runMetadata = await lstat(runDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (runMetadata === undefined) return "PLANNING_ONLY";
  if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection path is not a real directory");
  }

  const entries = await readdir(runDirectory, { withFileTypes: true });
  const revisionFiles = new Map<number, string>();
  let currentFile: string | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection directory has a non-file entry");
    }
    if (entry.name === `${runId}.json`) {
      currentFile = path.join(runDirectory, entry.name);
      continue;
    }
    const match = /^(.+)\.r([0-9]+)\.json$/u.exec(entry.name);
    if (match?.[1] !== runId || match[2] === undefined) {
      throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection filename is invalid");
    }
    const revision = Number(match[2]);
    if (!Number.isSafeInteger(revision) || revisionFiles.has(revision)) {
      throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection revision set is invalid");
    }
    revisionFiles.set(revision, path.join(runDirectory, entry.name));
  }
  if (currentFile === undefined) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection has no current record");
  }
  const current = validateRunProjection(
    parseRecordObject(await readFile(currentFile), path.relative(partition, currentFile)),
    runId,
  );
  if (revisionFiles.size !== current.revision + 1) {
    throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection revision history is incomplete");
  }
  let priorState: string | undefined;
  for (let revision = 0; revision <= current.revision; revision += 1) {
    const file = revisionFiles.get(revision);
    if (file === undefined) {
      throw new Error("STARTUP_RECOVERY_REQUIRED: Run projection revision history has a gap");
    }
    const saved = validateRunProjection(
      parseRecordObject(await readFile(file), path.relative(partition, file)),
      runId,
      revision,
    );
    if (revision === 0 && saved.state !== "CREATED") {
      throw new Error("STARTUP_RECOVERY_REQUIRED: Run revision zero is not CREATED");
    }
    if (priorState !== undefined) {
      assertLegalTransition("evaldock.mvp.run/v1", priorState, saved.state);
    }
    priorState = saved.state;
    if (revision === current.revision && saved.digest !== current.digest) {
      throw new Error("STARTUP_RECOVERY_REQUIRED: current Run projection differs from latest revision");
    }
  }
  if (!new Set(["FINISHED", "FAILED", "CANCELLED"]).has(current.state)) {
    throw new Error(`UNFINISHED_RUN: ${runId} remains ${current.state}`);
  }
  return "TERMINAL";
}

/** 遍历 runRoot，拒绝损坏分区或另一个未完成 Run，并返回恢复摘要。 */
async function checkStartupRecovery(runRootInput: string, currentRunId?: string): Promise<string> {
  const runRoot = await safeServiceRoot(runRootInput, "runRoot");
  if (currentRunId !== undefined) assertStableId(currentRunId, "currentRunId");
  const entries = await readdir(runRoot, { withFileTypes: true });
  let planningOnly = 0;
  let terminal = 0;
  for (const entry of entries) {
    const candidate = path.join(runRoot, entry.name);
    if (entry.name === "locks") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("STARTUP_RECOVERY_REQUIRED: locks path is not a real directory");
      }
      await validatePartitionTree(candidate, candidate);
      continue;
    }
    if (!STABLE_ID.test(entry.name)) {
      throw new Error("STARTUP_RECOVERY_REQUIRED: recordsRoot contains an invalid partition name");
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`STARTUP_RECOVERY_REQUIRED: ${entry.name} is not a real Run partition`);
    }
    const partition = await realpath(candidate);
    if (entry.name === currentRunId) {
      await validatePartitionTree(partition, partition);
      continue;
    }
    const state = await inspectRunPartition(partition, entry.name);
    if (state === "PLANNING_ONLY") planningOnly += 1;
    else terminal += 1;
  }
  return `${terminal} terminal and ${planningOnly} planning-only prior partitions verified`;
}

/**
 * 对 Repository、Artifact、Report、Workspace、Runtime Home 和启动恢复执行健康检查。
 */
export async function checkLocalServices(
  roots: Readonly<Record<"run" | "artifact" | "report" | "workspace" | "runtimeHome", string>> &
    Readonly<Partial<Record<"result", string>>>,
  options: { readonly currentRunId?: string } = {},
): Promise<HealthCheckResult> {
  const checks: Array<{
    name: string;
    status: "PASS" | "FAIL";
    detail: string;
  }> = [];
  for (const [name, root] of Object.entries(roots)) {
    try {
      checks.push({ name, status: "PASS", detail: await checkWritableAtomicRoot(root) });
    } catch (error) {
      checks.push({
        name,
        status: "FAIL",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    checks.push({
      name: "startup-recovery",
      status: "PASS",
      detail: await checkStartupRecovery(roots.run, options.currentRunId),
    });
  } catch (error) {
    checks.push({
      name: "startup-recovery",
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    status: checks.every((check) => check.status === "PASS") ? "HEALTHY" : "FAILED",
    checks,
  };
}
