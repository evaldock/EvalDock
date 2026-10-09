/**
 * 文件职责：实现 ArtifactStorePort，把大字节产物按 Run 分区保存，并以不可变 ArtifactRef 索引和验证读取保护证据完整性。
 * 核心流程：提交时校验元数据并原子创建对象、追加索引；读取时校验用途/Scope/索引/文件身份和摘要；初始化及显式检查时扫描恢复问题。
 * 真实交互：应用编排层通过 core/contracts.ts 的 ArtifactStorePort 调用；复用 repositories.ts 的安全目录、原子写和 JSONL 追加原语，验证结果再交给 evaluation/evidence.ts。
 * 公开接口：FileArtifactStoreOptions、ArtifactRecoveryIssue、FileArtifactStore。
 */
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  cancelled,
  failed,
  rejected,
  succeeded,
  type ArtifactCommitMetadata,
  type ArtifactStorePort,
  type OperationContext,
  type PortResult,
} from "../core/contracts.js";
import type { FailureDraft } from "../core/errors.js";
import {
  assertDigestEquals,
  assertSameScope,
  ContractViolation,
  digestBytes,
  digestEquals,
  digestValue,
  type ArtifactReadPurpose,
  type ArtifactRef,
  type ContentDigest,
  type IsoDateTime,
  type RunId,
  type ScopeRef,
  validateContentDigest,
  validateIsoDateTime,
  validatePortablePath,
  validateScope,
  validateStableId,
  withContentDigest,
} from "../core/models.js";
import {
  appendCanonicalJsonLine,
  assertAbsoluteStorageRoot,
  atomicCreateImmutable,
  atomicReplace,
  ensureSafeDirectory,
} from "./repositories.js";

/** 创建文件 ArtifactStore 所需的两个存储根、Run 分区锚点与单文件大小上限。 */
export interface FileArtifactStoreOptions {
  readonly artifactRoot: string;
  readonly runRoot: string;
  /** Preallocated partition key; it does not imply that EvaluationRun has been created. */
  readonly runId: RunId | string;
  readonly scope: ScopeRef;
  readonly maxArtifactBytes: number;
}

/** 恢复扫描发现的索引、对象或临时文件异常。 */
export interface ArtifactRecoveryIssue {
  readonly code:
    | "STALE_TEMP_FILE"
    | "BAD_INDEX"
    | "DUPLICATE_ARTIFACT_ID"
    | "MISSING_ARTIFACT"
    | "ORPHAN_ARTIFACT"
    | "ARTIFACT_INTEGRITY";
  readonly portableLocation: string;
  readonly detail: string;
}

/** ArtifactStorePort 允许的读取目的白名单，用于敏感度授权判断。 */
const PURPOSES = new Set<ArtifactReadPurpose>([
  "TASK_INPUT",
  "INSPECTION",
  "EVIDENCE_CAPTURE",
  "JUDGE_INPUT",
  "REPORT_INPUT",
]);

/** 已提交 ArtifactRef 允许出现的精确字段集合，拒绝未纳入摘要语义的扩展字段。 */
const ARTIFACT_REF_FIELDS = new Set([
  "schema",
  "artifactId",
  "scope",
  "artifactType",
  "logicalName",
  "mediaType",
  "portablePath",
  "byteLength",
  "artifactContentDigest",
  "producerVersion",
  "createdAt",
  "sensitivity",
  "redactionState",
  "state",
  "contentDigest",
]);

/** 从 Node 文件系统异常中安全提取 code，供缺失文件与真实 I/O 故障分流。 */
function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** 判断解析后的候选路径是否仍位于指定根目录内。 */
function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

/** 确认操作 Scope 与 Store 创建时的非空锚点字段兼容。 */
function assertScopeAnchored(anchor: ScopeRef, candidate: ScopeRef): void {
  const expected = validateScope(anchor, "artifact store scope");
  const actual = validateScope(candidate, "artifact scope");
  const fields = ["targetId", "targetSnapshotId", "runId", "caseId", "attemptId"] as const;
  for (const field of fields) {
    if (expected[field] !== undefined && actual[field] !== undefined && expected[field] !== actual[field]) {
      throw new ContractViolation("SCOPE_MISMATCH", `artifact ${field} belongs to another partition`);
    }
  }
}

/** 提交、读取和索引解析共用的 ArtifactRef 结构、取值、路径及 contentDigest 校验。 */
function verifyArtifactRefMetadata(ref: ArtifactRef): void {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "ArtifactRef must be an object");
  }
  const unknownFields = Object.keys(ref).filter((field) => !ARTIFACT_REF_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "ArtifactRef contains unknown fields");
  }
  if (ref.schema !== "evaldock.mvp.artifact/v1" || ref.state !== "COMMITTED") {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "ArtifactRef is not a committed MVP artifact");
  }
  validateStableId(ref.artifactId, "artifactId");
  validateScope(ref.scope, "artifact scope");
  validatePortablePath(ref.portablePath, "portablePath");
  validateContentDigest(ref.artifactContentDigest, "artifactContentDigest");
  validateIsoDateTime(ref.createdAt, "createdAt");
  validateStableId(ref.artifactType, "artifactType");
  if (
    typeof ref.logicalName !== "string" ||
    ref.logicalName.length === 0 ||
    ref.logicalName.length > 256 ||
    ref.logicalName.includes("/") ||
    ref.logicalName.includes("\\") ||
    ref.logicalName.includes("\0") ||
    typeof ref.mediaType !== "string" ||
    ref.mediaType.length === 0 ||
    ref.mediaType.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(ref.mediaType) ||
    typeof ref.producerVersion !== "string" ||
    ref.producerVersion.length === 0 ||
    ref.producerVersion.includes("\0") ||
    !["EXPORTABLE", "RESTRICTED"].includes(ref.sensitivity) ||
    !["NOT_REQUIRED", "APPLIED", "FAILED"].includes(ref.redactionState)
  ) {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "ArtifactRef metadata values are invalid");
  }
  const declared = validateContentDigest(ref.contentDigest, "contentDigest");
  const actual = digestValue(ref, ["contentDigest"]);
  assertDigestEquals(actual, declared);
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "ArtifactRef byteLength is invalid");
  }
  if (ref.portablePath !== `objects/${ref.artifactId}`) {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "ArtifactRef portablePath is not canonical");
  }
  if (ref.sensitivity === "EXPORTABLE" && ref.redactionState === "FAILED") {
    throw new ContractViolation("EVIDENCE_INTEGRITY", "failed redaction cannot be exportable");
  }
}

/** 解析 append-only index.jsonl，拒绝破损尾部、非法 Ref 和重复 ArtifactId。 */
function parseIndex(text: string): readonly ArtifactRef[] {
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new ContractViolation("BAD_ARTIFACT_INDEX", "artifact index has an incomplete tail");
  }
  const result: ArtifactRef[] = [];
  const ids = new Set<string>();
  for (const [index, line] of text.split("\n").entries()) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new ContractViolation("BAD_ARTIFACT_INDEX", `artifact index line ${index + 1} is invalid`, {
        cause: error,
      });
    }
    verifyArtifactRefMetadata(parsed as ArtifactRef);
    const ref = parsed as ArtifactRef;
    if (ids.has(ref.artifactId)) {
      throw new ContractViolation("DUPLICATE_ARTIFACT_ID", "artifact index repeats an artifact ID");
    }
    ids.add(ref.artifactId);
    result.push(ref);
  }
  return result;
}

/** core/contracts.ts 的文件系统 ArtifactStorePort 适配器，由应用 bootstrap 按 Run 创建。 */
export class FileArtifactStore implements ArtifactStorePort {
  readonly #artifactRoot: string;
  readonly #runRoot: string;
  readonly #scope: Readonly<ScopeRef>;
  readonly #runId: RunId;
  readonly #maxArtifactBytes: number;
  readonly #idempotency = new Map<string, { readonly input: ContentDigest; readonly result: Promise<PortResult<unknown>> }>();
  #writeQueue: Promise<void> = Promise.resolve();
  #initialization: Promise<void> | undefined;
  #poisoned = false;

  /** 固定并校验存储根、Run/Scope 锚点及大小上限；实际目录在首次操作时初始化。 */
  public constructor(options: FileArtifactStoreOptions) {
    assertAbsoluteStorageRoot(options.artifactRoot, "artifactRoot");
    assertAbsoluteStorageRoot(options.runRoot, "runRoot");
    const scope = validateScope(options.scope, "artifact store scope");
    const runId = validateStableId<"RunId">(options.runId, "runId");
    if (scope.runId !== undefined && scope.runId !== runId) {
      throw new ContractViolation("SCOPE_MISMATCH", "artifact anchor runId differs from its partition key");
    }
    if (!Number.isSafeInteger(options.maxArtifactBytes) || options.maxArtifactBytes <= 0) {
      throw new ContractViolation("INVALID_INPUT", "maxArtifactBytes must be a positive integer");
    }
    this.#artifactRoot = resolve(options.artifactRoot);
    this.#runRoot = resolve(options.runRoot);
    this.#scope = scope;
    this.#runId = runId;
    this.#maxArtifactBytes = options.maxArtifactBytes;
  }

  /** Port 写入口：提供取消、幂等、串行写和错误映射后调用 #commit。 */
  public async commit(
    context: OperationContext,
    bytes: Uint8Array | string,
    metadata: ArtifactCommitMetadata,
  ): Promise<PortResult<Readonly<ArtifactRef>>> {
    const input = {
      bytesDigest: digestBytes(bytes),
      metadata,
    };
    return this.#idempotent("commit", context, input, async () => {
      if (context.cancellationToken.isCancellationRequested) {
        return cancelled(
          this.#failure(context, "CANCELLED", "OPERATION_CANCELLED", "Artifact commit was cancelled", "USER"),
        );
      }
      try {
        const ref = await this.#withWriteLock(async () => this.#commit(bytes, metadata));
        return succeeded(ref);
      } catch (error) {
        return this.#mapError(context, error, "ARTIFACT_COMMIT_FAILED");
      }
    });
  }

  /** Port 读入口：按读取目的和 Scope 授权，并由 #readVerified 复验索引与字节摘要。 */
  public async readVerified(
    context: OperationContext,
    ref: ArtifactRef,
    scope: ScopeRef,
    purpose: ArtifactReadPurpose,
  ): Promise<PortResult<Uint8Array>> {
    return this.#idempotent("readVerified", context, { ref, scope, purpose }, async () => {
      if (context.cancellationToken.isCancellationRequested) {
        return cancelled(
          this.#failure(context, "CANCELLED", "OPERATION_CANCELLED", "Artifact read was cancelled", "USER"),
        );
      }
      try {
        return succeeded(await this.#readVerified(ref, scope, purpose));
      } catch (error) {
        return this.#mapError(context, error, "ARTIFACT_READ_FAILED");
      }
    });
  }

  /** 原子替换明确非权威的 status.html；应用编排层用它发布已提交事实的运行快照。 */
  public async replaceStatusHtml(context: OperationContext, html: string): Promise<PortResult<void>> {
    return this.#idempotent("replaceStatusHtml", context, { html }, async () => {
      if (context.cancellationToken.isCancellationRequested) {
        return cancelled(
          this.#failure(context, "CANCELLED", "OPERATION_CANCELLED", "Status update was cancelled", "USER"),
        );
      }
      try {
        await this.#ensureInitialized();
        const partition = await ensureSafeDirectory(this.#runRoot, [this.#runId]);
        const path = join(partition, "status.html");
        await this.#withWriteLock(async () => atomicReplace(path, html));
        return succeeded(undefined);
      } catch (error) {
        return this.#mapError(context, error, "STATUS_WRITE_FAILED");
      }
    });
  }

  /** 供启动检查或运维诊断调用，返回当前 Artifact 分区的全部恢复问题。 */
  public async inspectRecoveryState(): Promise<readonly ArtifactRecoveryIssue[]> {
    await this.#partitionDirectory();
    return this.#scanRecoveryIssues();
  }

  /** commit 的核心实现：验证元数据、原子创建对象后追加索引，并支持同内容 ID 的安全重放。 */
  async #commit(
    source: Uint8Array | string,
    metadata: ArtifactCommitMetadata,
  ): Promise<Readonly<ArtifactRef>> {
    await this.#ensureInitialized();
    if (this.#poisoned) {
      throw new ContractViolation("STORAGE_RECOVERY_REQUIRED", "artifact store has an incomplete commit");
    }
    const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
    if (bytes.byteLength > this.#maxArtifactBytes) {
      throw new ContractViolation("INVALID_INPUT", "artifact exceeds maxArtifactBytes");
    }
    const artifactId = validateStableId<"ArtifactId">(metadata.artifactId, "artifactId");
    const scope = validateScope(metadata.scope, "artifact scope");
    if (scope.runId !== undefined && scope.runId !== this.#runId) {
      throw new ContractViolation("SCOPE_MISMATCH", "artifact belongs to another run partition");
    }
    assertScopeAnchored(this.#scope, scope);
    validateStableId(metadata.artifactType, "artifactType");
    validateIsoDateTime(metadata.createdAt, "createdAt");
    if (
      !["EXPORTABLE", "RESTRICTED"].includes(metadata.sensitivity) ||
      !["NOT_REQUIRED", "APPLIED", "FAILED"].includes(metadata.redactionState) ||
      metadata.producerVersion.length === 0 ||
      metadata.producerVersion.includes("\0")
    ) {
      throw new ContractViolation("INVALID_INPUT", "artifact sensitivity, redaction or producerVersion is invalid");
    }
    if (
      metadata.logicalName.length === 0 ||
      metadata.logicalName.length > 256 ||
      metadata.logicalName.includes("/") ||
      metadata.logicalName.includes("\\") ||
      metadata.logicalName.includes("\0")
    ) {
      throw new ContractViolation("INVALID_INPUT", "logicalName must be a path-free display name");
    }
    if (
      metadata.mediaType.length === 0 ||
      metadata.mediaType.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(metadata.mediaType)
    ) {
      throw new ContractViolation("INVALID_INPUT", "mediaType is invalid");
    }
    if (metadata.sensitivity === "EXPORTABLE" && metadata.redactionState === "FAILED") {
      throw new ContractViolation("AUTHORIZATION_DENIED", "failed redaction must remain restricted");
    }
    const artifactContentDigest = digestBytes(bytes);
    const withoutDigest = {
      schema: "evaldock.mvp.artifact/v1" as const,
      artifactId,
      scope,
      artifactType: metadata.artifactType,
      logicalName: metadata.logicalName,
      mediaType: metadata.mediaType,
      portablePath: validatePortablePath(`objects/${artifactId}`),
      byteLength: bytes.byteLength,
      artifactContentDigest,
      producerVersion: metadata.producerVersion,
      createdAt: metadata.createdAt,
      sensitivity: metadata.sensitivity,
      redactionState: metadata.redactionState,
      state: "COMMITTED" as const,
    };
    const proposed: ArtifactRef = withContentDigest(withoutDigest);
    const index = await this.#loadIndex();
    const existing = index.find((item) => item.artifactId === artifactId);
    if (existing !== undefined) {
      if (!digestEquals(existing.contentDigest, proposed.contentDigest)) {
        throw new ContractViolation("IMMUTABILITY_CONFLICT", "artifact ID already has different content or metadata");
      }
      await this.#readVerified(existing, scope, "EVIDENCE_CAPTURE");
      return existing;
    }

    const objects = await this.#objectsDirectory();
    const finalPath = join(objects, artifactId);
    if (await this.#pathExists(finalPath)) {
      throw new ContractViolation("STORAGE_RECOVERY_REQUIRED", "artifact bytes exist without a committed index entry");
    }
    await atomicCreateImmutable(finalPath, bytes);
    try {
      const partition = await this.#partitionDirectory();
      await appendCanonicalJsonLine(join(partition, "index.jsonl"), proposed);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
    return proposed;
  }

  /** readVerified 的核心实现：验证 Ref/授权/路径和读前后文件身份，最后比对字节摘要。 */
  async #readVerified(
    suppliedRef: ArtifactRef,
    suppliedScope: ScopeRef,
    purpose: ArtifactReadPurpose,
  ): Promise<Uint8Array> {
    await this.#ensureInitialized();
    verifyArtifactRefMetadata(suppliedRef);
    if (!PURPOSES.has(purpose)) {
      throw new ContractViolation("AUTHORIZATION_DENIED", "artifact read purpose is not an MVP purpose");
    }
    const scope = validateScope(suppliedScope, "read scope");
    assertSameScope(suppliedRef.scope, scope);
    if (scope.runId !== undefined && scope.runId !== this.#runId) {
      throw new ContractViolation("SCOPE_MISMATCH", "artifact read belongs to another run partition");
    }
    assertScopeAnchored(this.#scope, scope);
    if (
      suppliedRef.sensitivity === "RESTRICTED" &&
      (purpose === "TASK_INPUT" || purpose === "REPORT_INPUT")
    ) {
      throw new ContractViolation("AUTHORIZATION_DENIED", "restricted artifact is not authorized for this purpose");
    }
    const committed = (await this.#loadIndex()).find(
      (item) => item.artifactId === suppliedRef.artifactId,
    );
    if (committed === undefined) {
      throw new ContractViolation("NOT_FOUND", "ArtifactRef is not present in the committed index");
    }
    if (!digestEquals(committed.contentDigest, suppliedRef.contentDigest)) {
      throw new ContractViolation("EVIDENCE_INTEGRITY", "supplied ArtifactRef metadata was altered");
    }
    const objects = await this.#objectsDirectory();
    const path = resolve(objects, suppliedRef.artifactId);
    const canonicalObjects = await realpath(objects);
    if (!isWithin(canonicalObjects, path)) {
      throw new ContractViolation("PATH_ESCAPE", "artifact path escaped the object root");
    }
    let before: Awaited<ReturnType<typeof lstat>>;
    let data: Buffer;
    let after: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new ContractViolation("PATH_ESCAPE", "artifact object is not a regular file");
      }
      const resolved = await realpath(path);
      if (!isWithin(canonicalObjects, resolved)) {
        throw new ContractViolation("PATH_ESCAPE", "artifact object resolved outside the object root");
      }
      data = await readFile(resolved);
      after = await lstat(resolved);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ContractViolation("EVIDENCE_INTEGRITY", "committed artifact bytes are missing");
      }
      throw error;
    }
    if (
      !after.isFile() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      data.byteLength !== suppliedRef.byteLength
    ) {
      throw new ContractViolation("EVIDENCE_INTEGRITY", "artifact changed while it was being read");
    }
    const actualDigest = digestBytes(data);
    assertDigestEquals(actualDigest, suppliedRef.artifactContentDigest);
    return new Uint8Array(data);
  }

  /** 读取并解析当前 Run 的 Artifact 索引；索引尚不存在时视为空集合。 */
  async #loadIndex(): Promise<readonly ArtifactRef[]> {
    const partition = await this.#partitionDirectory();
    const indexPath = join(partition, "index.jsonl");
    try {
      const info = await lstat(indexPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ContractViolation("PATH_ESCAPE", "artifact index is not a regular file");
      }
      return parseIndex(await readFile(indexPath, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  /** 通过 repositories.ts 的安全目录原语解析或创建 Run Artifact 分区。 */
  async #partitionDirectory(): Promise<string> {
    return ensureSafeDirectory(this.#artifactRoot, [this.#runId]);
  }

  /** 解析或创建分区内仅存放不可变 Artifact 字节的 objects 目录。 */
  async #objectsDirectory(): Promise<string> {
    return ensureSafeDirectory(await this.#partitionDirectory(), ["objects"]);
  }

  /** 首次真实操作前只执行一次恢复扫描；存在异常时阻断后续读写。 */
  async #ensureInitialized(): Promise<void> {
    this.#initialization ??= (async () => {
      await this.#partitionDirectory();
      const issues = await this.#scanRecoveryIssues();
      if (issues.length > 0) {
        throw new ContractViolation(
          "STORAGE_RECOVERY_REQUIRED",
          `artifact recovery is required (${issues.map((issue) => issue.code).join(", ")})`,
        );
      }
    })();
    return this.#initialization;
  }

  /** 对照 index.jsonl 与 objects 目录，发现破损索引、孤儿/缺失对象和摘要不一致。 */
  async #scanRecoveryIssues(): Promise<readonly ArtifactRecoveryIssue[]> {
    const issues: ArtifactRecoveryIssue[] = [];
    let refs: readonly ArtifactRef[] = [];
    try {
      refs = await this.#loadIndex();
    } catch {
      issues.push({ code: "BAD_INDEX", portableLocation: "index.jsonl", detail: "index cannot be verified" });
    }
    const indexed = new Set<string>(refs.map((ref) => ref.artifactId));
    const objects = await this.#objectsDirectory();
    const entries = await readdir(objects, { withFileTypes: true });
    for (const entry of entries) {
      const location = `objects/${entry.name}`;
      if (entry.name.startsWith(".tmp-") || entry.name.endsWith(".partial")) {
        issues.push({ code: "STALE_TEMP_FILE", portableLocation: location, detail: "uncommitted artifact stage" });
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) {
        issues.push({ code: "ARTIFACT_INTEGRITY", portableLocation: location, detail: "object is not a regular file" });
        continue;
      }
      if (!indexed.has(entry.name)) {
        issues.push({ code: "ORPHAN_ARTIFACT", portableLocation: location, detail: "object has no committed index entry" });
      }
    }
    for (const ref of refs) {
      const path = join(objects, ref.artifactId);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== ref.byteLength) {
          issues.push({
            code: "ARTIFACT_INTEGRITY",
            portableLocation: ref.portablePath,
            detail: "indexed object type or length does not match",
          });
          continue;
        }
        const digest = digestBytes(await readFile(path));
        if (!digestEquals(digest, ref.artifactContentDigest)) {
          issues.push({ code: "ARTIFACT_INTEGRITY", portableLocation: ref.portablePath, detail: "indexed object digest does not match" });
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          issues.push({ code: "MISSING_ARTIFACT", portableLocation: ref.portablePath, detail: "indexed object is missing" });
        } else {
          issues.push({ code: "ARTIFACT_INTEGRITY", portableLocation: ref.portablePath, detail: "indexed object cannot be verified" });
        }
      }
    }
    return issues;
  }

  /** 区分路径不存在与其他文件系统错误，供不可变提交检查孤儿对象。 */
  async #pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  /** 在当前 Store 实例内串行执行写动作，保护“对象创建 + 索引追加”等复合操作。 */
  async #withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const preceding = this.#writeQueue;
    let release!: () => void;
    this.#writeQueue = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await preceding;
    try {
      return await action();
    } finally {
      release();
    }
  }

  /** 按“操作名 + idempotencyKey”缓存 Promise；同键不同输入直接返回冲突。 */
  async #idempotent<T>(
    operation: string,
    context: OperationContext,
    input: unknown,
    action: () => Promise<PortResult<T>>,
  ): Promise<PortResult<T>> {
    let inputDigest: ContentDigest;
    try {
      inputDigest = digestValue(input);
    } catch (error) {
      return this.#mapError(context, error, "INVALID_OPERATION_INPUT");
    }
    const key = `${operation}:${context.idempotencyKey}`;
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      if (!digestEquals(existing.input, inputDigest)) {
        return rejected("CONFLICT", [
          this.#failure(context, "PERSISTENCE_FAILURE", "IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different input"),
        ]);
      }
      return existing.result as Promise<PortResult<T>>;
    }
    const result = action();
    this.#idempotency.set(key, { input: inputDigest, result: result as Promise<PortResult<unknown>> });
    return result;
  }

  /** 将领域/文件系统异常归一为 ArtifactStorePort 的 rejected 或 failed 结果。 */
  #mapError<T>(context: OperationContext, error: unknown, fallbackReason: string): PortResult<T> {
    if (error instanceof ContractViolation) {
      const rejection =
        error.code === "NOT_FOUND"
          ? "NOT_FOUND"
          : error.code === "IMMUTABILITY_CONFLICT"
            ? "CONFLICT"
            : error.code === "AUTHORIZATION_DENIED" || error.code === "PATH_ESCAPE" || error.code === "SCOPE_MISMATCH"
              ? "AUTHORIZATION_DENIED"
              : error.code === "STORAGE_RECOVERY_REQUIRED" || error.code === "BAD_ARTIFACT_INDEX"
                ? "PRECONDITION_FAILED"
                : "INVALID_INPUT";
      const category = error.code === "EVIDENCE_INTEGRITY" ? "EVIDENCE_INTEGRITY" : "PERSISTENCE_FAILURE";
      return rejected(rejection, [
        this.#failure(context, category, error.code || fallbackReason, "Artifact operation was rejected as unsafe or invalid"),
      ]);
    }
    return failed(
      this.#failure(context, "PERSISTENCE_FAILURE", fallbackReason, "Artifact storage could not persist or verify bytes"),
    );
  }

  /** 为本适配器生成统一脱敏的 STORAGE FailureDraft，供所有 Port 失败路径复用。 */
  #failure(
    _context: OperationContext,
    category: FailureDraft["category"],
    reasonCode: string,
    messageRedacted: string,
    origin: FailureDraft["origin"] = "EVALDOCK",
  ): FailureDraft {
    return {
      scope: this.#scope,
      category,
      origin,
      actor: "STORAGE",
      phase: "STORAGE",
      severity: "ERROR",
      retryable: false,
      messageRedacted,
      reasonCode,
      evidenceRefs: [],
      artifactRefs: [],
      occurredAt: new Date().toISOString() as IsoDateTime,
    };
  }
}
