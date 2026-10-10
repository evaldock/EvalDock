/**
 * 文件职责：以独立、只读和确定性的方式扫描 Workspace，构造文件快照、差异与重置验证草稿，并序列化可提交的快照制品。
 * 核心流程：在根目录和挂载边界内遍历文件树，拒绝跟随符号链接，稳定读取并哈希普通文件，再按 UTF-8 路径排序、计算清单摘要并比较不同阶段。
 * 与其他文件的真实交互：使用 core/models.ts 的文件领域模型和摘要规则；由 observer-lab/adapters/filesystem/binding.ts 的 FileEnvironmentSensor 调用捕获与摘要函数；app/workflow.ts 物化和提交草稿。
 * 公开接口：传感器实现身份常量、快照/差异/重置草稿及选项类型、IncompleteFileSnapshotError，以及捕获、比较、物化、验证和制品序列化函数。
 */
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  canonicalJson,
  digestBytes,
  digestEquals,
  digestValue,
  validatePortablePath,
  validateScope,
  validateStableId,
  withContentDigest,
  type ContentDigest,
  type EvidenceCompleteness,
  type FileDiff,
  type FileEntry,
  type FileSnapshot,
  type Ref,
  type ResetVerification,
  type ScopeRef,
} from "../../../src/core/models.js";

/** 写入 SensorAdapterDescriptor 的文件传感器稳定标识。 */
export const FILE_SENSOR_IMPLEMENTATION_ID = "evaldock.file-sensor";
/** 写入 SensorAdapterDescriptor 的文件传感器实现版本。 */
export const FILE_SENSOR_IMPLEMENTATION_VERSION = "1.0.0";
/** 冻结到观察计划中的文件传感器能力清单。 */
export const FILE_SENSOR_CAPABILITIES = [
  "FILE_TYPE",
  "READ_ERRORS",
  "READ_ONLY",
  "SHA256",
  "SNAPSHOT_AFTER",
  "SNAPSHOT_BEFORE",
  "SNAPSHOT_POST_RESET",
  "STABLE_WINDOW",
  "SYMLINK_BOUNDARY",
] as const;
/** FILE_SENSOR_CAPABILITIES 的固定摘要，用于计划和运行实现的漂移检测。 */
export const FILE_SENSOR_CAPABILITY_DIGEST: ContentDigest = {
  algorithm: "sha256",
  byteLength: 140,
  value: "166aa91b9f679a4085d090a650e238b244c3f317f0bca923bb13b944db4a5dd4",
};

/** 文件快照对应的目标执行前、执行后或重置后阶段。 */
export type SnapshotPhase = "BEFORE" | "AFTER" | "POST_RESET";

/** 扫描过程中保留便携路径和脱敏原因的单个读取错误。 */
export interface FileScanError {
  readonly portablePath: string;
  readonly reasonCode:
    | "ROOT_NOT_DIRECTORY"
    | "ROOT_IS_SYMLINK"
    | "ROOT_REALPATH_MISMATCH"
    | "PATH_OUTSIDE_ROOT"
    | "MOUNT_BOUNDARY"
    | "LIST_FAILED"
    | "LSTAT_FAILED"
    | "REALPATH_FAILED"
    | "READ_FAILED"
    | "FILE_TOO_LARGE"
    | "FILE_CHANGED_DURING_SCAN"
    | "SYMLINK_READ_FAILED";
  readonly messageRedacted: string;
}

/** 尚未附加仓储不可变元数据的文件快照草稿。 */
export interface FileSnapshotDraft {
  readonly snapshotId: string;
  readonly attemptId: string;
  readonly phase: SnapshotPhase;
  readonly rootBinding: string;
  readonly scanStartedAt: string;
  readonly scanCompletedAt: string;
  readonly entries: readonly FileEntry[];
  readonly readErrors: readonly FileScanError[];
  readonly completeness: EvidenceCompleteness;
  /** 规范化清单摘要，与记录标识和墙上时钟无关。 */
  readonly snapshotDigest: ContentDigest;
}

/** 捕获一次文件快照所需的逻辑身份、本地根路径、大小上限和可注入时钟。 */
export interface CaptureFileSnapshotOptions {
  readonly snapshotId: string;
  readonly attemptId: string;
  readonly phase: SnapshotPhase;
  /** 仅供独立读取器使用的宿主路径，不写入记录。 */
  readonly rootPath: string;
  /** 持久化到 Snapshot 的冻结逻辑 Binding。 */
  readonly rootBinding: string;
  /** Legacy content budget; hashing has a separate bounded streaming limit. */
  readonly maxFileBytes: number;
  readonly maxHashBytes?: number;
  readonly now?: () => string;
}

/** 同类型路径在 BEFORE 与 AFTER 之间的变化分类。 */
export type FileModificationKind =
  | "CONTENT_CHANGED"
  | "METADATA_CHANGED"
  | "SYMLINK_CHANGED"
  | "UNREADABLE";

/** 仅存在于一个快照中的新增或删除路径。 */
export interface FileAddedOrRemoved {
  readonly portablePath: string;
  readonly kind: "ADDED" | "REMOVED";
  readonly before?: FileEntry;
  readonly after?: FileEntry;
}

/** 文件类型不变但内容、元数据、链接目标或可读性发生变化的路径。 */
export interface FileModification {
  readonly portablePath: string;
  readonly kind: FileModificationKind;
  readonly before: FileEntry;
  readonly after: FileEntry;
}

/** 同一路径的文件实体类型发生变化的记录。 */
export interface FileTypeChange {
  readonly portablePath: string;
  readonly kind: "TYPE_CHANGED";
  readonly before: FileEntry;
  readonly after: FileEntry;
}

/** 尚未附加不可变记录元数据的文件差异草稿。 */
export interface FileDiffDraft {
  readonly diffId: string;
  readonly beforeSnapshotRef: Ref<FileSnapshot>;
  readonly afterSnapshotRef: Ref<FileSnapshot>;
  readonly added: readonly FileAddedOrRemoved[];
  readonly removed: readonly FileAddedOrRemoved[];
  readonly modified: readonly FileModification[];
  readonly typeChanged: readonly FileTypeChange[];
  readonly unchangedCount: number;
  readonly diffDigest: ContentDigest;
}

/** 比较 BEFORE/AFTER 快照时所需的草稿、引用和诊断模式开关。 */
export interface BuildFileDiffOptions {
  readonly diffId: string;
  readonly beforeSnapshot: FileSnapshotDraft;
  readonly afterSnapshot: FileSnapshotDraft;
  readonly beforeSnapshotRef: Ref<FileSnapshot>;
  readonly afterSnapshotRef: Ref<FileSnapshot>;
  /** 允许将部分清单用于诊断；部分清单不能证明“未变化”。 */
  readonly allowDiagnosticPartial?: boolean;
}

/** 将 POST_RESET 快照与预期空清单比较后得到的重置验证草稿。 */
export interface ResetVerificationDraft {
  readonly verificationId: string;
  readonly environmentInstanceRef: Ref<unknown>;
  readonly resetGeneration: number;
  readonly expectedCleanDigest: ContentDigest;
  readonly postResetSnapshotRef: Ref<FileSnapshot>;
  readonly collectionStatusRef: Ref<unknown>;
  readonly result: "MATCH" | "MISMATCH" | "UNAVAILABLE";
  readonly differenceSummary: {
    readonly expectedDigest: string;
    readonly actualDigest?: string;
    readonly entryCount: number;
    readonly readErrorCount: number;
    readonly reasonCode: "DIGEST_MATCH" | "DIGEST_MISMATCH" | "SNAPSHOT_PARTIAL";
  };
}

/** 构造重置验证所需的环境、代次、预期摘要和已提交快照引用。 */
export interface VerifyResetOptions {
  readonly verificationId: string;
  readonly environmentInstanceRef: Ref<unknown>;
  readonly resetGeneration: number;
  readonly expectedCleanDigest: ContentDigest;
  readonly postResetSnapshot: FileSnapshotDraft;
  readonly postResetSnapshotRef: Ref<FileSnapshot>;
  readonly collectionStatusRef: Ref<unknown>;
}

/** buildFileDiff 在结论模式收到部分快照时抛出的显式错误。 */
export class IncompleteFileSnapshotError extends Error {
  /** 保存稳定错误类型名；由 buildFileDiff 构造，调用方可据此区分证据不完整。 */
  public constructor(message: string) {
    super(message);
    this.name = "IncompleteFileSnapshotError";
  }
}

/** 仓储物化文件观察记录时统一附加的作用域与生产者元数据。 */
export interface ImmutableObservationMetadata {
  readonly scope: ScopeRef;
  readonly createdAt: string;
  readonly producerVersion: string;
}

/** 校验快照草稿的 Attempt、路径顺序和清单摘要后生成 FileSnapshot；由 app/workflow.ts 在每次捕获后调用。 */
export function materializeFileSnapshot(
  draft: FileSnapshotDraft,
  metadata: ImmutableObservationMetadata,
): FileSnapshot {
  const scope = validateScope(metadata.scope);
  if (scope.attemptId === undefined || scope.attemptId !== draft.attemptId) {
    throw new TypeError("FileSnapshot Attempt must match immutable record Scope");
  }
  const entries = draft.entries.map((entry) => ({
    ...entry,
    portablePath: validatePortablePath(entry.portablePath),
  }));
  assertUniqueSortedPaths(entries.map((entry) => entry.portablePath), "FileSnapshot.entries");
  const readErrors = draft.readErrors.map((error) => ({
    ...error,
    portablePath: validatePortablePath(error.portablePath, "readError.portablePath", {
      allowDot: true,
    }),
  }));
  const expectedDigest = digestValue({
    rootBinding: draft.rootBinding,
    entries,
    readErrors,
    completeness: draft.completeness,
  });
  if (!digestEquals(expectedDigest, draft.snapshotDigest)) {
    throw new TypeError("FileSnapshot manifest digest is invalid");
  }
  return withContentDigest({
    schema: "evaldock.mvp.file-snapshot/v1" as const,
    snapshotId: validateStableId<"FileSnapshotId">(draft.snapshotId, "snapshotId"),
    scope,
    attemptId: scope.attemptId,
    phase: draft.phase,
    rootBinding: draft.rootBinding,
    scanStartedAt: draft.scanStartedAt,
    scanCompletedAt: draft.scanCompletedAt,
    entries,
    readErrors,
    completeness: draft.completeness,
    snapshotDigest: draft.snapshotDigest,
    createdAt: metadata.createdAt,
    producerVersion: metadata.producerVersion,
  });
}

/** 规范化差异路径并附加作用域和内容摘要；由 app/workflow.ts 在 buildFileDiff 后调用。 */
export function materializeFileDiff(
  draft: FileDiffDraft,
  metadata: ImmutableObservationMetadata,
): FileDiff {
  const scope = validateScope(metadata.scope);
  if (scope.attemptId === undefined) throw new TypeError("FileDiff requires Attempt Scope");
  const added = draft.added.map((change) => ({
    portablePath: validatePortablePath(change.portablePath),
    kind: "ADDED" as const,
    after: change.after!,
  }));
  const removed = draft.removed.map((change) => ({
    portablePath: validatePortablePath(change.portablePath),
    kind: "REMOVED" as const,
    before: change.before!,
  }));
  const modified = draft.modified.map((change) => ({
    portablePath: validatePortablePath(change.portablePath),
    kind: change.kind,
    before: change.before,
    after: change.after,
  }));
  const typeChanged = draft.typeChanged.map((change) => ({
    portablePath: validatePortablePath(change.portablePath),
    kind: "TYPE_CHANGED" as const,
    before: change.before,
    after: change.after,
  }));
  const diffDigest = digestValue({
    added,
    removed,
    modified,
    typeChanged,
    unchangedCount: draft.unchangedCount,
  });
  return withContentDigest({
    schema: "evaldock.mvp.file-diff/v1" as const,
    diffId: validateStableId<"FileDiffId">(draft.diffId, "diffId"),
    scope,
    beforeSnapshotRef: draft.beforeSnapshotRef,
    afterSnapshotRef: draft.afterSnapshotRef,
    added,
    removed,
    modified,
    typeChanged,
    unchangedCount: draft.unchangedCount,
    diffDigest,
    createdAt: metadata.createdAt,
    producerVersion: metadata.producerVersion,
  });
}

/** 为重置验证草稿附加不可变记录元数据；由 app/workflow.ts 在 POST_RESET 比较后调用。 */
export function materializeResetVerification(
  draft: ResetVerificationDraft,
  metadata: ImmutableObservationMetadata,
): ResetVerification {
  return withContentDigest({
    schema: "evaldock.mvp.reset-verification/v1" as const,
    verificationId: validateStableId<"ResetVerificationId">(
      draft.verificationId,
      "verificationId",
    ),
    scope: validateScope(metadata.scope),
    environmentInstanceRef: draft.environmentInstanceRef as ResetVerification["environmentInstanceRef"],
    resetGeneration: draft.resetGeneration,
    expectedCleanDigest: draft.expectedCleanDigest,
    postResetSnapshotRef: draft.postResetSnapshotRef,
    collectionStatusRef: draft.collectionStatusRef as ResetVerification["collectionStatusRef"],
    result: draft.result,
    differenceSummary: draft.differenceSummary,
    createdAt: metadata.createdAt,
    producerVersion: metadata.producerVersion,
  });
}

/** 计算指定逻辑 Binding 下“完整且为空”的规范清单摘要；由 app/workflow.ts 作为重置期望值。 */
export function emptyWorkspaceManifestDigest(rootBinding: string): ContentDigest {
  return digestValue({
    rootBinding,
    entries: [],
    readErrors: [],
    completeness: "COMPLETE",
  });
}

/**
 * 捕获稳定只读文件清单；由 FileEnvironmentSensor 和测试调用，内部不跟随目录符号链接，并以 O_NOFOLLOW 打开普通文件后计算摘要。
 */
export async function captureFileSnapshot(
  options: CaptureFileSnapshotOptions,
): Promise<FileSnapshotDraft> {
  if (!path.isAbsolute(options.rootPath)) {
    throw new TypeError("File Sensor rootPath must be absolute");
  }
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0) {
    throw new TypeError("maxFileBytes must be a non-negative safe integer");
  }

  const maxHashBytes = options.maxHashBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxHashBytes) || maxHashBytes < 0) throw new TypeError("Invalid maxHashBytes");
  const now = options.now ?? (() => new Date().toISOString());
  const scanStartedAt = now();
  const configuredRoot = path.resolve(options.rootPath);
  const entries: FileEntry[] = [];
  const readErrors: FileScanError[] = [];

  let rootStats: BigIntStats;
  let canonicalRoot: string;
  try {
    rootStats = await lstat(configuredRoot, { bigint: true });
    if (rootStats.isSymbolicLink()) {
      readErrors.push(errorFor("", "ROOT_IS_SYMLINK", "Workspace root must not be a symbolic link"));
      return finishSnapshot(options, scanStartedAt, now(), entries, readErrors);
    }
    if (!rootStats.isDirectory()) {
      readErrors.push(errorFor("", "ROOT_NOT_DIRECTORY", "Workspace root is not a directory"));
      return finishSnapshot(options, scanStartedAt, now(), entries, readErrors);
    }
    canonicalRoot = await realpath(configuredRoot);
  } catch (error) {
    readErrors.push(errorFor("", "LSTAT_FAILED", redactFsError(error)));
    return finishSnapshot(options, scanStartedAt, now(), entries, readErrors);
  }

  await walkDirectory({
    absoluteDirectory: canonicalRoot,
    portableDirectory: "",
    canonicalRoot,
    rootDevice: rootStats.dev,
    maxHashBytes,
    entries,
    readErrors,
  });

  entries.sort((left, right) => compareUtf8(left.portablePath, right.portablePath));
  readErrors.sort((left, right) => compareUtf8(left.portablePath, right.portablePath));
  return finishSnapshot(options, scanStartedAt, now(), entries, readErrors);
}

/** 比较同一 Attempt 的 BEFORE/AFTER 草稿并分类路径变化；由 app/workflow.ts 在最终文件快照提交后调用。 */
export function buildFileDiff(options: BuildFileDiffOptions): FileDiffDraft {
  if (
    !options.allowDiagnosticPartial &&
    (options.beforeSnapshot.completeness !== "COMPLETE" ||
      options.afterSnapshot.completeness !== "COMPLETE")
  ) {
    throw new IncompleteFileSnapshotError(
      "A conclusive FileDiff requires COMPLETE Before and After snapshots",
    );
  }
  if (
    options.beforeSnapshot.attemptId !== options.afterSnapshot.attemptId ||
    options.beforeSnapshot.attemptId === ""
  ) {
    throw new TypeError("Before and After snapshots must belong to the same Attempt");
  }
  if (options.beforeSnapshot.phase !== "BEFORE" || options.afterSnapshot.phase !== "AFTER") {
    throw new TypeError("FileDiff requires BEFORE followed by AFTER");
  }
  if (options.beforeSnapshot.rootBinding !== options.afterSnapshot.rootBinding) {
    throw new TypeError("Before and After root bindings must match");
  }

  const beforeByPath = new Map(
    options.beforeSnapshot.entries.map((entry) => [entry.portablePath, entry] as const),
  );
  const afterByPath = new Map(
    options.afterSnapshot.entries.map((entry) => [entry.portablePath, entry] as const),
  );
  const allPaths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(compareUtf8);
  const added: FileAddedOrRemoved[] = [];
  const removed: FileAddedOrRemoved[] = [];
  const modified: FileModification[] = [];
  const typeChanged: FileTypeChange[] = [];
  let unchangedCount = 0;

  for (const portablePath of allPaths) {
    const before = beforeByPath.get(portablePath);
    const after = afterByPath.get(portablePath);
    if (before === undefined) {
      added.push({ portablePath, kind: "ADDED", after: after! });
      continue;
    }
    if (after === undefined) {
      removed.push({ portablePath, kind: "REMOVED", before });
      continue;
    }
    if (before.entryType !== after.entryType) {
      typeChanged.push({ portablePath, kind: "TYPE_CHANGED", before, after });
      continue;
    }
    const modificationKind = classifyModification(before, after);
    if (modificationKind === undefined) {
      unchangedCount += 1;
    } else {
      modified.push({ portablePath, kind: modificationKind, before, after });
    }
  }

  const digestPayload = { added, removed, modified, typeChanged, unchangedCount };
  return {
    diffId: options.diffId,
    beforeSnapshotRef: options.beforeSnapshotRef,
    afterSnapshotRef: options.afterSnapshotRef,
    ...digestPayload,
    diffDigest: digestCanonical(digestPayload),
  };
}

/** 将新鲜 POST_RESET 快照与预期空清单比较为重置事实；由 app/workflow.ts 在环境重置后调用。 */
export function verifyResetSnapshot(options: VerifyResetOptions): ResetVerificationDraft {
  if (options.postResetSnapshot.phase !== "POST_RESET") {
    throw new TypeError("Reset verification requires a POST_RESET snapshot");
  }
  const unavailable = options.postResetSnapshot.completeness !== "COMPLETE";
  const matches =
    !unavailable && digestsEqual(options.expectedCleanDigest, options.postResetSnapshot.snapshotDigest);

  return {
    verificationId: options.verificationId,
    environmentInstanceRef: options.environmentInstanceRef,
    resetGeneration: options.resetGeneration,
    expectedCleanDigest: options.expectedCleanDigest,
    postResetSnapshotRef: options.postResetSnapshotRef,
    collectionStatusRef: options.collectionStatusRef,
    result: unavailable ? "UNAVAILABLE" : matches ? "MATCH" : "MISMATCH",
    differenceSummary: {
      expectedDigest: options.expectedCleanDigest.value,
      ...(!unavailable ? { actualDigest: options.postResetSnapshot.snapshotDigest.value } : {}),
      entryCount: options.postResetSnapshot.entries.length,
      readErrorCount: options.postResetSnapshot.readErrors.length,
      reasonCode: unavailable
        ? "SNAPSHOT_PARTIAL"
        : matches
          ? "DIGEST_MATCH"
          : "DIGEST_MISMATCH",
    },
  };
}

/** 递归扫描共享的根边界、文件上限及结果累加器。 */
interface WalkContext {
  readonly absoluteDirectory: string;
  readonly portableDirectory: string;
  readonly canonicalRoot: string;
  readonly rootDevice: bigint;
  readonly maxHashBytes: number;
  readonly entries: FileEntry[];
  readonly readErrors: FileScanError[];
}

/** 以 UTF-8 顺序递归遍历真实目录并分派实体捕获；由 captureFileSnapshot 从规范根开始调用，也会递归调用自身。 */
async function walkDirectory(context: WalkContext): Promise<void> {
  let names: string[];
  try {
    names = await readdir(context.absoluteDirectory);
  } catch (error) {
    context.readErrors.push(
      errorFor(context.portableDirectory, "LIST_FAILED", redactFsError(error)),
    );
    return;
  }
  names.sort(compareUtf8);

  for (const name of names) {
    const portablePath = context.portableDirectory === "" ? name : `${context.portableDirectory}/${name}`;
    const absolutePath = path.join(context.absoluteDirectory, name);
    if (!isWithinRoot(context.canonicalRoot, absolutePath)) {
      context.readErrors.push(
        errorFor(portablePath, "PATH_OUTSIDE_ROOT", "Directory entry resolved outside Workspace root"),
      );
      continue;
    }

    let stats: BigIntStats;
    try {
      stats = await lstat(absolutePath, { bigint: true });
    } catch (error) {
      context.readErrors.push(errorFor(portablePath, "LSTAT_FAILED", redactFsError(error)));
      continue;
    }

    const mode = Number(stats.mode & 0o7777n);
    if (stats.isSymbolicLink()) {
      await captureSymlink(context, absolutePath, portablePath, mode);
      continue;
    }

    if (stats.dev !== context.rootDevice) {
      const readError = "Entry crosses the frozen Workspace mount boundary";
      context.entries.push({
        portablePath,
        entryType: "OTHER",
        mode,
        resolvedWithinRoot: true,
        readError,
      });
      context.readErrors.push(errorFor(portablePath, "MOUNT_BOUNDARY", readError));
      continue;
    }

    if (stats.isDirectory()) {
      let canonicalDirectory: string;
      try {
        canonicalDirectory = await realpath(absolutePath);
      } catch (error) {
        const readError = redactFsError(error);
        context.entries.push({
          portablePath,
          entryType: "DIRECTORY",
          mode,
          resolvedWithinRoot: false,
          readError,
        });
        context.readErrors.push(errorFor(portablePath, "REALPATH_FAILED", readError));
        continue;
      }
      const withinRoot = isWithinRoot(context.canonicalRoot, canonicalDirectory);
      context.entries.push({
        portablePath,
        entryType: "DIRECTORY",
        mode,
        resolvedWithinRoot: withinRoot,
        ...(!withinRoot ? { readError: "Directory resolves outside Workspace root" } : {}),
      });
      if (!withinRoot) {
        context.readErrors.push(
          errorFor(portablePath, "PATH_OUTSIDE_ROOT", "Directory resolves outside Workspace root"),
        );
        continue;
      }
      await walkDirectory({ ...context, absoluteDirectory: canonicalDirectory, portableDirectory: portablePath });
      continue;
    }

    if (stats.isFile()) {
      await captureRegularFile(context, absolutePath, portablePath, stats, mode);
      continue;
    }

    context.entries.push({
      portablePath,
      entryType: "OTHER",
      mode,
      resolvedWithinRoot: true,
    });
  }
}

/** 记录符号链接文本目标和根内解析结论但不跟随读取内容；由 walkDirectory 调用。 */
async function captureSymlink(
  context: WalkContext,
  absolutePath: string,
  portablePath: string,
  mode: number,
): Promise<void> {
  try {
    const linkTarget = await readlink(absolutePath);
    const lexicalTarget = path.resolve(path.dirname(absolutePath), linkTarget);
    let resolvedTarget = lexicalTarget;
    try {
      resolvedTarget = await realpath(absolutePath);
    } catch {
      // 悬空链接仍有确定的词法目标；扫描器只记录它而不跟随。
    }
    context.entries.push({
      portablePath,
      entryType: "SYMLINK",
      mode,
      linkTarget,
      resolvedWithinRoot:
        isWithinRoot(context.canonicalRoot, lexicalTarget) &&
        isWithinRoot(context.canonicalRoot, resolvedTarget),
    });
  } catch (error) {
    const readError = redactFsError(error);
    context.entries.push({
      portablePath,
      entryType: "SYMLINK",
      mode,
      resolvedWithinRoot: false,
      readError,
    });
    context.readErrors.push(errorFor(portablePath, "SYMLINK_READ_FAILED", readError));
  }
}

/** 在大小、身份和扫描期间稳定性校验下读取并哈希普通文件；由 walkDirectory 调用。 */
async function captureRegularFile(
  context: WalkContext,
  absolutePath: string,
  portablePath: string,
  before: BigIntStats,
  mode: number,
): Promise<void> {
  const byteLength = Number(before.size);
  if (!Number.isSafeInteger(byteLength) || byteLength > context.maxHashBytes) {
    const readError = "File exceeds the independent streaming hash limit";
    context.entries.push({
      portablePath,
      entryType: "FILE",
      mode,
      ...(Number.isSafeInteger(byteLength) ? { byteLength } : {}),
      resolvedWithinRoot: true,
      readError,
    });
    context.readErrors.push(errorFor(portablePath, "FILE_TOO_LARGE", readError));
    return;
  }

  let handle;
  try {
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new FileChangedDuringScanError();
    }

    const hash = createHash("sha256");
    let bytesReadTotal = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, byteLength)));
    while (bytesReadTotal < byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, byteLength - bytesReadTotal),
        bytesReadTotal,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      bytesReadTotal !== byteLength ||
      !sameFileIdentity(opened, after) ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      opened.size !== after.size
    ) {
      throw new FileChangedDuringScanError();
    }
    context.entries.push({
      portablePath,
      entryType: "FILE",
      mode,
      byteLength,
      contentDigest: {
        algorithm: "sha256",
        value: hash.digest("hex"),
        byteLength,
      },
      resolvedWithinRoot: true,
    });
  } catch (error) {
    const changed = error instanceof FileChangedDuringScanError;
    const reasonCode = changed ? "FILE_CHANGED_DURING_SCAN" : "READ_FAILED";
    const readError = changed ? "File changed while the snapshot was being captured" : redactFsError(error);
    context.entries.push({
      portablePath,
      entryType: "FILE",
      mode,
      byteLength,
      resolvedWithinRoot: true,
      readError,
    });
    context.readErrors.push(errorFor(portablePath, reasonCode, readError));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** captureRegularFile 用于区分扫描竞态与普通读取失败的内部标记错误。 */
class FileChangedDuringScanError extends Error {}

/** 比较两次 stat 是否仍指向同一文件实体和类型；由 captureRegularFile 的打开前后校验调用。 */
function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** 根据累积条目和错误计算完整性及清单摘要；由 captureFileSnapshot 的正常与提前返回路径调用。 */
function finishSnapshot(
  options: CaptureFileSnapshotOptions,
  scanStartedAt: string,
  scanCompletedAt: string,
  entries: readonly FileEntry[],
  readErrors: readonly FileScanError[],
): FileSnapshotDraft {
  const completeness: EvidenceCompleteness = readErrors.length === 0 ? "COMPLETE" : "PARTIAL";
  const manifest = {
    rootBinding: options.rootBinding,
    entries,
    readErrors,
    completeness,
  };
  return {
    snapshotId: options.snapshotId,
    attemptId: options.attemptId,
    phase: options.phase,
    rootBinding: options.rootBinding,
    scanStartedAt,
    scanCompletedAt,
    entries,
    readErrors,
    completeness,
    snapshotDigest: digestCanonical(manifest),
  };
}

/** 为同路径同类型条目判定变化种类；由 buildFileDiff 逐项调用。 */
function classifyModification(before: FileEntry, after: FileEntry): FileModificationKind | undefined {
  if (before.readError !== undefined || after.readError !== undefined) return "UNREADABLE";
  if (before.entryType === "SYMLINK") {
    if (
      before.linkTarget !== after.linkTarget ||
      before.resolvedWithinRoot !== after.resolvedWithinRoot
    ) {
      return "SYMLINK_CHANGED";
    }
  }
  if (!digestsEqualOptional(before.contentDigest, after.contentDigest)) return "CONTENT_CHANGED";
  if (before.mode !== after.mode || before.byteLength !== after.byteLength) return "METADATA_CHANGED";
  return undefined;
}

/** 计算结构值的规范摘要；由快照与差异草稿生成路径调用。 */
function digestCanonical(value: unknown): ContentDigest {
  return digestValue(value);
}

/** 比较两个可缺省摘要；由 classifyModification 处理非文件条目时调用。 */
function digestsEqualOptional(left?: ContentDigest, right?: ContentDigest): boolean {
  if (left === undefined || right === undefined) return left === right;
  return digestsEqual(left, right);
}

/** 使用核心摘要语义比较两个必有摘要；由可选摘要比较和重置验证调用。 */
function digestsEqual(left: ContentDigest, right: ContentDigest): boolean {
  return digestEquals(left, right);
}

/** 进行不解析链接的词法根边界判断；由目录遍历和符号链接记录调用。 */
function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** 按 UTF-8 字节序稳定比较路径；由扫描、差异和唯一性校验复用。 */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** 将内部扫描错误规范化为带“.”根路径的 FileScanError；由各捕获分支调用。 */
function errorFor(
  portablePath: string,
  reasonCode: FileScanError["reasonCode"],
  messageRedacted: string,
): FileScanError {
  return { portablePath: portablePath === "" ? "." : portablePath, reasonCode, messageRedacted };
}

/** 将 FileSnapshot 编码为带末尾换行的规范 JSON 制品字节；由 app/workflow.ts 提交原始文件快照时调用。 */
export function serializeFileSnapshotArtifact(snapshot: FileSnapshot): string {
  return `${canonicalJson(snapshot)}\n`;
}

/** 计算规范 FileSnapshot 制品的内容摘要；由 observer-lab/adapters/filesystem/binding.ts 复核已提交原始制品。 */
export function fileSnapshotArtifactDigest(snapshot: FileSnapshot): ContentDigest {
  return digestBytes(serializeFileSnapshotArtifact(snapshot));
}

/** 断言路径列表按 UTF-8 字节序严格递增且无重复；由 materializeFileSnapshot 调用。 */
function assertUniqueSortedPaths(paths: readonly string[], label: string): void {
  for (let index = 0; index < paths.length; index += 1) {
    if (index > 0 && compareUtf8(paths[index - 1]!, paths[index]!) >= 0) {
      throw new TypeError(`${label} must contain unique UTF-8-sorted portable paths`);
    }
  }
}

/** 仅保留文件系统错误码，避免宿主绝对路径进入记录；由扫描异常分支调用。 */
function redactFsError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "UNKNOWN");
    return `Filesystem operation failed (${code})`;
  }
  return "Filesystem operation failed (UNKNOWN)";
}
