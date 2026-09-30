/**
 * 文件职责：实现 RepositoryPort，并提供受路径约束的原子文件写入原语，用于持久化不可变记录和生命周期投影。
 * 核心流程：按 Run/Schema/ID 定位记录；写前校验摘要、Scope、Ref 与状态迁移；以不可变 revision 加 current 投影保存生命周期，并扫描未完成写入或断裂历史。
 * 真实交互：应用 bootstrap 以 FileRepository 注入 core/contracts.ts 的 RepositoryPort；artifacts.ts 复用本文件的安全目录、原子创建/替换和 JSONL 追加函数。
 * 公开接口：FileRepositoryOptions、RecoveryIssue、四个文件安全辅助函数，以及 FileRepository。
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  cancelled,
  failed,
  rejected,
  succeeded,
  type OperationContext,
  type PortResult,
  type RepositoryPort,
} from "../core/contracts.js";
import { type FailureDraft } from "../core/errors.js";
import {
  assertDigestEquals,
  assertLegalTransition,
  assertSameScope,
  canonicalJson,
  ContractViolation,
  digestEquals,
  digestValue,
  isLifecycleSchema,
  refForProjection,
  type ContentDigest,
  type IsoDateTime,
  type LifecycleAggregateSchema,
  type LifecycleEvent,
  type LifecycleProjectionBase,
  type Ref,
  type RunId,
  type ScopeRef,
  type StableId,
  type StateTransition,
  validateContentDigest,
  validateRef,
  validateSchemaId,
  validateScope,
  validateStableId,
  withContentDigest,
} from "../core/models.js";

/** 创建按 Run 分区的文件仓储所需的根目录、分区 ID、Scope 锚点和生产者版本。 */
export interface FileRepositoryOptions {
  readonly runRoot: string;
  /** Preallocated partition key; the EvaluationRun itself is still created only at step 4. */
  readonly runId: RunId | string;
  /** Target-level or deeper anchor used for cross-target checks and storage failures. */
  readonly scope: ScopeRef;
  readonly producerVersion: string;
}

/** 仓储恢复扫描发现的临时文件、JSONL 或生命周期 revision 异常。 */
export interface RecoveryIssue {
  readonly code:
    | "STALE_TEMP_FILE"
    | "BAD_JSONL"
    | "DUPLICATE_EVENT_ID"
    | "ORPHAN_PROJECTION_REVISION";
  readonly portableLocation: string;
  readonly detail: string;
}

/** 从磁盘解析、尚未收窄到具体领域模型的只读 JSON 对象。 */
type UnknownRecord = Readonly<Record<string, unknown>>;

/** 可跨 Run 保存、因此不要求 record.scope 的少量配置类 schema。 */
const SCOPELESS_SCHEMAS = new Set([
  "evaldock.mvp.target-descriptor/v1",
  "evaldock.case-execution-input/v1",
  "evaldock.mvp.config/v1",
]);

/** 不可变 schema 到其主键字段的白名单，也是 Repository 支持的 schema 目录。 */
const ID_FIELDS: Readonly<Record<string, string>> = {
  "evaldock.all-trace/v1":"traceId",
  "evaldock.label-score/v1":"scoreId",
  "evaldock.result/v1":"reportId",
  "evaldock.mvp.target-descriptor/v1": "targetId",
  "evaldock.mvp.target-snapshot/v1": "targetSnapshotId",
  "evaldock.mvp.inspection/v1": "inspectionId",
  "evaldock.case-execution-input/v1": "inputId",
  "evaldock.mvp.config/v1": "configId",
  "evaldock.mvp.evaluation-plan/v1": "evaluationPlanId",
  "evaldock.mvp.agent-trace-plan/v1": "agentTracePlanId",
  "evaldock.mvp.observation-plan/v1": "observationPlanId",
  "evaldock.mvp.control-event/v1": "controlEventId",
  "evaldock.mvp.seed-manifest/v1": "seedManifestId",
  "evaldock.mvp.security-preflight/v1": "preflightId",
  "evaldock.mvp.reset-verification/v1": "verificationId",
  "evaldock.mvp.lease/v1": "leaseId",
  "evaldock.mvp.source/v1": "sourceId",
  "evaldock.mvp.raw-observation/v1": "observationId",
  "evaldock.mvp.collection-status/v1": "collectionStatusId",
  "evaldock.mvp.file-snapshot/v1": "snapshotId",
  "evaldock.mvp.file-diff/v1": "diffId",
  "evaldock.mvp.process-snapshot/v1": "processSnapshotId",
  "evaldock.mvp.process-diff/v1": "processDiffId",
  "evaldock.mvp.artifact/v1": "artifactId",
  "evaldock.mvp.failure/v1": "failureId",
  "evaldock.mvp.lifecycle-event/v1": "eventId",
};

/** 生命周期聚合 schema 到主键字段的映射，供投影身份和路径校验使用。 */
const PROJECTION_ID_FIELDS: Readonly<Record<LifecycleAggregateSchema, string>> = {
  "evaldock.mvp.run/v1": "runId",
  "evaldock.mvp.case/v1": "caseId",
  "evaldock.mvp.attempt/v1": "attemptId",
  "evaldock.mvp.environment/v1": "environmentInstanceId",
  "evaldock.mvp.observation-session/v1": "observationSessionId",
};

/** 需要额外写入 append-only 事件日志的不可变 schema 与文件名映射。 */
const EVENT_FILES: Readonly<Record<string, string>> = {
  "evaldock.mvp.failure/v1": "failures.jsonl",
  "evaldock.mvp.raw-observation/v1": "raw-observations.jsonl",
};

/** 从 Node 文件系统异常中安全提取 code，供 ENOENT 等分支判断。 */
function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const value = (error as { readonly code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** 判断候选路径是否仍位于指定根目录内，安全目录和原子写函数共同使用。 */
function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

/** 拒绝相对路径、文件系统根和含空字节路径；FileRepository 与 ArtifactStore 构造时调用。 */
export function assertAbsoluteStorageRoot(root: string, fieldName: string): void {
  if (!isAbsolute(root) || root === parse(root).root || root.includes("\0")) {
    throw new ContractViolation(
      "INVALID_STORAGE_ROOT",
      `${fieldName} must be a non-root absolute path`,
    );
  }
}

/** 读取路径元数据并把 ENOENT 转为空值，其余 I/O 错误保持抛出。 */
async function existingLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** 逐段创建并复验无符号链接的安全目录，返回解析后的目录路径。 */
export async function ensureSafeDirectory(root: string, segments: readonly string[]): Promise<string> {
  assertAbsoluteStorageRoot(root, "storage root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ContractViolation("PATH_ESCAPE", "storage root must be a real directory, not a symlink");
  }
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    validateStableId(segment, `path segment[${index}]`);
    const candidate = resolve(current, segment);
    if (!isWithin(canonicalRoot, candidate)) {
      throw new ContractViolation("PATH_ESCAPE", "storage path escaped its configured root");
    }
    const before = await existingLstat(candidate);
    if (before === undefined) {
      await mkdir(candidate, { mode: 0o700 });
    } else if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new ContractViolation("PATH_ESCAPE", "storage path component is not a real directory");
    }
    const after = await lstat(candidate);
    if (!after.isDirectory() || after.isSymbolicLink()) {
      throw new ContractViolation("PATH_ESCAPE", "storage path component became unsafe");
    }
    current = await realpath(candidate);
    if (!isWithin(canonicalRoot, current)) {
      throw new ContractViolation("PATH_ESCAPE", "storage path resolved outside its configured root");
    }
  }
  return current;
}

/** 在支持目录 fsync 的平台刷新目录项；原子写原语用它提高崩溃一致性。 */
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** 通过同目录临时文件和硬链接原子创建不可覆盖文件，供记录 revision 与 Artifact 对象提交。 */
export async function atomicCreateImmutable(path: string, bytes: Uint8Array | string): Promise<void> {
  const parent = dirname(path);
  const parentReal = await realpath(parent);
  const target = resolve(parentReal, validateStableId(path.slice(path.lastIndexOf(sep) + 1), "file name"));
  if (!isWithin(parentReal, target)) {
    throw new ContractViolation("PATH_ESCAPE", "immutable target escaped its parent directory");
  }
  if ((await existingLstat(target)) !== undefined) {
    throw new ContractViolation("IMMUTABILITY_CONFLICT", "immutable target already exists");
  }
  const tempPath = join(parentReal, `.tmp-${randomUUID()}`);
  const handle = await open(tempPath, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await chmod(tempPath, 0o400);
    try {
      await link(tempPath, target);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new ContractViolation("IMMUTABILITY_CONFLICT", "immutable target already exists");
      }
      throw error;
    }
    published = true;
    await unlink(tempPath);
    await syncDirectory(parentReal);
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing an already closed descriptor is harmless; write/flush failures still propagate above.
    }
    if (!published) {
      try {
        await unlink(tempPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

/** 通过同目录临时文件加 rename 原子替换可变指针文件，如 current 投影和 status.html。 */
export async function atomicReplace(path: string, bytes: Uint8Array | string): Promise<void> {
  const parent = dirname(path);
  const parentReal = await realpath(parent);
  const targetName = path.slice(path.lastIndexOf(sep) + 1);
  validateStableId(targetName, "file name");
  const target = resolve(parentReal, targetName);
  if (!isWithin(parentReal, target)) {
    throw new ContractViolation("PATH_ESCAPE", "replace target escaped its parent directory");
  }
  const existing = await existingLstat(target);
  if (existing?.isSymbolicLink() === true || (existing !== undefined && !existing.isFile())) {
    throw new ContractViolation("PATH_ESCAPE", "replace target must be a regular file");
  }
  const tempPath = join(parentReal, `.tmp-${randomUUID()}`);
  const handle = await open(tempPath, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await chmod(tempPath, 0o400);
    await rename(tempPath, target);
    renamed = true;
    await syncDirectory(parentReal);
  } finally {
    try {
      await handle.close();
    } catch {
      // See atomicCreateImmutable.
    }
    if (!renamed) {
      try {
        await unlink(tempPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

/** 以单次 append 写入规范 JSON 行并 fsync，供事件日志和 Artifact 索引使用。 */
export async function appendCanonicalJsonLine(path: string, value: unknown): Promise<void> {
  const line = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const parent = await realpath(dirname(path));
  const name = path.slice(path.lastIndexOf(sep) + 1);
  validateStableId(name, "JSONL file name");
  const target = resolve(parent, name);
  if (!isWithin(parent, target)) throw new ContractViolation("PATH_ESCAPE", "JSONL path escaped parent");
  const existing = await existingLstat(target);
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new ContractViolation("PATH_ESCAPE", "JSONL target must be a regular file");
  }
  const handle = await open(
    target,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const { bytesWritten } = await handle.write(line, 0, line.byteLength, null);
    if (bytesWritten !== line.byteLength) {
      throw new ContractViolation("PERSISTENCE_FAILURE", "JSONL append was not a complete line write");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(parent);
}

/** 递归冻结从仓储返回的对象，避免调用方误改已验证记录。 */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value as Readonly<T>;
}

/** 将版本化 schema 转成稳定目录名，并先校验 schema 格式。 */
function schemaKind(schema: string): string {
  validateSchemaId(schema);
  const match = /^evaldock\.(?:mvp\.)?([a-z0-9-]+)\/v1$/u.exec(schema);
  if (match?.[1] === undefined) {
    throw new ContractViolation("INVALID_SCHEMA", "schema cannot be routed to a record kind");
  }
  return match[1];
}

/** 按 ID_FIELDS 从未知记录提取并校验不可变 schema/主键。 */
function immutableIdentity(record: UnknownRecord): { readonly schema: string; readonly id: StableId } {
  const schema = validateSchemaId(record.schema);
  if (isLifecycleSchema(schema)) {
    throw new ContractViolation("INVALID_INPUT", "lifecycle records must use projection methods");
  }
  const idField = ID_FIELDS[schema];
  if (idField === undefined) {
    throw new ContractViolation("UNSUPPORTED_SCHEMA", `schema ${schema} is not part of the MVP catalog`);
  }
  return { schema, id: validateStableId(record[idField], idField) };
}

/** 按 PROJECTION_ID_FIELDS 提取并核对生命周期投影的 schema、aggregateId 和业务主键。 */
function projectionIdentity(
  projection: LifecycleProjectionBase,
): { readonly schema: LifecycleAggregateSchema; readonly id: StableId } {
  if (!isLifecycleSchema(projection.schema)) {
    throw new ContractViolation("INVALID_SCHEMA", "projection schema is not an MVP lifecycle schema");
  }
  const idField = PROJECTION_ID_FIELDS[projection.schema];
  const raw = projection as unknown as Record<string, unknown>;
  const businessId = validateStableId(raw[idField], idField);
  const aggregateId = validateStableId(projection.aggregateId, "aggregateId");
  if (businessId !== aggregateId) {
    throw new ContractViolation("INVALID_PROJECTION", `${idField} must equal aggregateId`);
  }
  return { schema: projection.schema, id: aggregateId };
}

/** 复算不可变记录 contentDigest；写入和读取路径都必须通过。 */
function verifyImmutableDigest(record: UnknownRecord): ContentDigest {
  const declared = validateContentDigest(record.contentDigest, "contentDigest");
  const actual = digestValue(record, ["contentDigest"]);
  assertDigestEquals(actual, declared);
  return declared;
}

/** 复算生命周期投影 projectionDigest；创建、迁移和恢复扫描共同使用。 */
function verifyProjectionDigest(projection: LifecycleProjectionBase): ContentDigest {
  const declared = validateContentDigest(projection.projectionDigest, "projectionDigest");
  const actual = digestValue(projection, ["projectionDigest"]);
  assertDigestEquals(actual, declared);
  return declared;
}

/** 要求被引用记录在 owner 已声明的每一级 Scope 上保持一致。 */
function assertScopeCompatible(owner: ScopeRef, referenced: ScopeRef): void {
  const current = validateScope(owner, "record scope");
  const dependency = validateScope(referenced, "referenced scope");
  const fields = ["targetId", "targetSnapshotId", "runId", "caseId", "attemptId"] as const;
  for (const field of fields) {
    if (current[field] !== undefined && dependency[field] !== undefined && current[field] !== dependency[field]) {
      throw new ContractViolation("SCOPE_MISMATCH", `referenced ${field} belongs to another scope`);
    }
  }
}

/** 递归收集记录图中形似 Ref 的对象，供提交前逐一验证存在性和 Scope。 */
function collectRefs(value: unknown, refs: Ref[], visited = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs, visited);
    return;
  }
  const record = value as Record<string, unknown>;
  if ("schema" in record && "id" in record && "digest" in record) {
    refs.push(validateRef(record, { lifecycle: record.revision !== undefined }));
    return;
  }
  for (const nested of Object.values(record)) collectRefs(nested, refs, visited);
}

/** core/contracts.ts 的文件系统 RepositoryPort 适配器，由应用 bootstrap 为单个 Run 创建。 */
export class FileRepository implements RepositoryPort {
  readonly #runRoot: string;
  readonly #scope: Readonly<ScopeRef>;
  readonly #runId: RunId;
  readonly #idempotency = new Map<string, { readonly input: ContentDigest; readonly result: Promise<PortResult<unknown>> }>();
  #writeQueue: Promise<void> = Promise.resolve();
  #initialization: Promise<void> | undefined;

  /** 固定并校验存储根、Run 分区和 Scope 锚点；目录及恢复状态延迟到首次操作。 */
  public constructor(options: FileRepositoryOptions) {
    assertAbsoluteStorageRoot(options.runRoot, "runRoot");
    const scope = validateScope(options.scope, "repository scope");
    const runId = validateStableId<"RunId">(options.runId, "runId");
    if (scope.runId !== undefined && scope.runId !== runId) {
      throw new ContractViolation("SCOPE_MISMATCH", "repository anchor runId differs from its partition key");
    }
    this.#runRoot = resolve(options.runRoot);
    this.#scope = scope;
    this.#runId = runId;
  }

  /** Port 入口：幂等且串行地提交不可变记录，并返回内容寻址 Ref。 */
  public async putImmutable<T extends object>(
    context: OperationContext,
    record: T,
  ): Promise<PortResult<Readonly<Ref<T>>>> {
    return this.#idempotent("putImmutable", context, record, async () => {
      const cancelledResult = this.#cancelledIfRequested<T>(context);
      if (cancelledResult !== undefined) return cancelledResult as PortResult<Readonly<Ref<T>>>;
      try {
        const result = await this.#withWriteLock(async () => this.#putImmutable(record));
        return succeeded(result);
      } catch (error) {
        return this.#mapError<Readonly<Ref<T>>>(context, error, "PUT_IMMUTABLE_FAILED");
      }
    });
  }

  /** Port 入口：为生命周期聚合创建 revision 0 与 current 投影。 */
  public async createProjection<T extends LifecycleProjectionBase>(
    context: OperationContext,
    initialProjection: T,
  ): Promise<PortResult<Readonly<Ref<T> & { readonly revision: 0 }>>> {
    return this.#idempotent("createProjection", context, initialProjection, async () => {
      const cancelledResult = this.#cancelledIfRequested<T>(context);
      if (cancelledResult !== undefined) {
        return cancelledResult as PortResult<Readonly<Ref<T> & { readonly revision: 0 }>>;
      }
      try {
        const result = await this.#withWriteLock(async () => this.#createProjection(initialProjection));
        return succeeded(result);
      } catch (error) {
        return this.#mapError<Readonly<Ref<T> & { readonly revision: 0 }>>(
          context,
          error,
          "CREATE_PROJECTION_FAILED",
        );
      }
    });
  }

  /** Port 入口：以乐观 revision 校验追加合法状态迁移，并更新 current 投影。 */
  public async appendTransition<T extends LifecycleProjectionBase>(
    context: OperationContext,
    transition: StateTransition<T>,
  ): Promise<PortResult<Readonly<Ref<T> & { readonly revision: number }>>> {
    return this.#idempotent("appendTransition", context, transition, async () => {
      const cancelledResult = this.#cancelledIfRequested<T>(context);
      if (cancelledResult !== undefined) {
        return cancelledResult as PortResult<Readonly<Ref<T> & { readonly revision: number }>>;
      }
      try {
        const result = await this.#withWriteLock(async () => this.#appendTransition(transition));
        return succeeded(result);
      } catch (error) {
        return this.#mapError<Readonly<Ref<T> & { readonly revision: number }>>(
          context,
          error,
          "APPEND_TRANSITION_FAILED",
        );
      }
    });
  }

  /** Port 入口：按 Ref 读取并完整校验记录，返回递归冻结的对象。 */
  public async get<T>(context: OperationContext, ref: Ref<T>): Promise<PortResult<Readonly<T>>> {
    return this.#idempotent("get", context, ref, async () => {
      const cancelledResult = this.#cancelledIfRequested<T>(context);
      if (cancelledResult !== undefined) return cancelledResult as PortResult<Readonly<T>>;
      try {
        await this.#ensureInitialized();
        return succeeded(await this.#readRef(ref));
      } catch (error) {
        return this.#mapError<Readonly<T>>(context, error, "READ_RECORD_FAILED");
      }
    });
  }

  /** 供启动检查或运维诊断调用，扫描当前 Run 分区但不修改磁盘状态。 */
  public async inspectRecoveryState(): Promise<readonly RecoveryIssue[]> {
    const partition = await this.#partitionDirectory();
    return this.#scanRecoveryIssues(partition);
  }

  /** putImmutable 的核心实现：验证身份/摘要/引用，处理安全重放并原子落盘。 */
  async #putImmutable<T extends object>(record: T): Promise<Readonly<Ref<T>>> {
    await this.#ensureInitialized();
    const raw = record as UnknownRecord;
    const { schema, id } = immutableIdentity(raw);
    const digest = verifyImmutableDigest(raw);
    await this.#validateRecordScopeAndRefs(raw);
    const path = await this.#immutablePath(schema, id);
    const existing = await existingLstat(path);
    if (existing !== undefined) {
      const stored = await this.#readJson(path);
      const storedDigest = verifyImmutableDigest(stored);
      if (!digestEquals(digest, storedDigest)) {
        throw new ContractViolation("IMMUTABILITY_CONFLICT", "same schema/id has different content");
      }
      return Object.freeze({ schema, id, digest });
    }
    await atomicCreateImmutable(path, canonicalJson(raw));
    const eventFile = EVENT_FILES[schema];
    if (eventFile !== undefined) {
      const events = await ensureSafeDirectory(await this.#partitionDirectory(), ["events"]);
      await appendCanonicalJsonLine(join(events, eventFile), raw);
    }
    return Object.freeze({ schema, id, digest });
  }

  /** createProjection 的核心实现：校验 revision 0 后同时建立不可变历史和 current 文件。 */
  async #createProjection<T extends LifecycleProjectionBase>(
    projection: T,
  ): Promise<Readonly<Ref<T> & { readonly revision: 0 }>> {
    await this.#ensureInitialized();
    const { schema, id } = projectionIdentity(projection);
    if (projection.revision !== 0) {
      throw new ContractViolation("INVALID_PROJECTION", "initial lifecycle revision must be 0");
    }
    verifyProjectionDigest(projection);
    this.#assertPartitionScope(projection.scope);
    await this.#validateReferences(projection, projection.scope);
    const revisionPath = await this.#projectionRevisionPath(schema, id, 0);
    const currentPath = await this.#projectionCurrentPath(schema, id);
    const existingRevision = await existingLstat(revisionPath);
    if (existingRevision !== undefined) {
      const existing = (await this.#readJson(revisionPath)) as unknown as T;
      const existingDigest = verifyProjectionDigest(existing);
      if (!digestEquals(existingDigest, projection.projectionDigest)) {
        throw new ContractViolation("IMMUTABILITY_CONFLICT", "revision 0 already has different content");
      }
      return refForProjection(existing) as Readonly<Ref<T> & { readonly revision: 0 }>;
    }
    if ((await existingLstat(currentPath)) !== undefined) {
      throw new ContractViolation("IMMUTABILITY_CONFLICT", "lifecycle aggregate already exists");
    }
    const bytes = canonicalJson(projection);
    await atomicCreateImmutable(revisionPath, bytes);
    await atomicCreateImmutable(currentPath, bytes);
    return refForProjection(projection) as Readonly<Ref<T> & { readonly revision: 0 }>;
  }

  /** appendTransition 的核心实现：验证前态与引用，先写 revision/event，再原子替换 current。 */
  async #appendTransition<T extends LifecycleProjectionBase>(
    transition: StateTransition<T>,
  ): Promise<Readonly<Ref<T> & { readonly revision: number }>> {
    await this.#ensureInitialized();
    const next = transition.nextProjection;
    const { schema, id } = projectionIdentity(next);
    const aggregateRef = validateRef<T>(transition.aggregateRef, {
      lifecycle: true,
      fieldName: "aggregateRef",
    });
    if (aggregateRef.schema !== schema || aggregateRef.id !== id) {
      throw new ContractViolation("INVALID_TRANSITION", "transition aggregate Ref does not match projection");
    }
    if (aggregateRef.revision !== transition.expectedRevision) {
      throw new ContractViolation("STALE_REVISION", "aggregate Ref revision differs from expectedRevision");
    }
    const priorByRef = await this.#readRef(aggregateRef);
    if (priorByRef.state !== transition.fromState) {
      throw new ContractViolation("STALE_REVISION", "aggregate Ref state differs from transition fromState");
    }
    if (
      next.revision !== transition.expectedRevision + 1 ||
      next.state !== transition.toState ||
      next.aggregateId !== priorByRef.aggregateId ||
      next.schema !== priorByRef.schema
    ) {
      throw new ContractViolation("INVALID_TRANSITION", "next projection identity, revision or state is inconsistent");
    }
    assertSameScope(priorByRef.scope, next.scope);
    assertLegalTransition(schema, String(transition.fromState), String(transition.toState));
    verifyProjectionDigest(next);
    await this.#validateReferences(next, next.scope);
    await this.#validateReferences(
      { supportingRefs: transition.supportingRefs, failureRefs: transition.failureRefs },
      next.scope,
    );
    const currentPath = await this.#projectionCurrentPath(schema, id);
    const current = (await this.#readJson(currentPath)) as unknown as T;
    projectionIdentity(current);
    const currentDigest = verifyProjectionDigest(current);
    if (current.revision === transition.expectedRevision + 1) {
      const replayDigest = verifyProjectionDigest(next);
      if (current.revision === next.revision && digestEquals(currentDigest, replayDigest)) {
        return refForProjection(current);
      }
    }
    if (current.revision !== transition.expectedRevision) {
      throw new ContractViolation("STALE_REVISION", "expected lifecycle revision is stale");
    }
    if (
      aggregateRef.revision !== current.revision ||
      !digestEquals(aggregateRef.digest, currentDigest) ||
      transition.fromState !== current.state
    ) {
      throw new ContractViolation("STALE_REVISION", "aggregate Ref does not identify current projection");
    }
    const nextPath = await this.#projectionRevisionPath(schema, id, next.revision);
    if ((await existingLstat(nextPath)) !== undefined) {
      throw new ContractViolation("IMMUTABILITY_CONFLICT", "next revision file already exists");
    }
    await atomicCreateImmutable(nextPath, canonicalJson(next));

    const eventWithoutDigest = {
      schema: "evaldock.mvp.lifecycle-event/v1" as const,
      eventId: validateStableId<"LifecycleEventId">(
        `lifecycle-${digestValue({ schema, id, revision: next.revision }).value}`,
        "eventId",
      ),
      aggregateSchema: schema,
      aggregateId: id,
      scope: next.scope,
      revision: next.revision,
      fromState: current.state,
      toState: next.state,
      reasonCode: transition.reasonCode,
      supportingRefs: transition.supportingRefs,
      failureRefs: transition.failureRefs,
      occurredAt: transition.occurredAt,
      priorProjectionRef: refForProjection(current),
      nextProjectionDigest: next.projectionDigest,
    };
    const event: LifecycleEvent = withContentDigest(eventWithoutDigest);
    const events = await ensureSafeDirectory(await this.#partitionDirectory(), ["events"]);
    await appendCanonicalJsonLine(join(events, "lifecycle.jsonl"), event);
    await atomicReplace(currentPath, canonicalJson(next));
    return refForProjection(next);
  }

  /** 不可变记录提交前核对分区 Scope 及其全部非 Artifact Ref。 */
  async #validateRecordScopeAndRefs(record: UnknownRecord): Promise<void> {
    const schema = String(record.schema);
    if (SCOPELESS_SCHEMAS.has(schema)) {
      if (record.scope !== undefined) {
        throw new ContractViolation("INVALID_SCOPE", `${schema} must be scope-less`);
      }
      if (
        schema === "evaldock.mvp.target-descriptor/v1" &&
        record.targetId !== this.#scope.targetId
      ) {
        throw new ContractViolation("SCOPE_MISMATCH", "TargetDescriptor belongs to another target partition");
      }
    } else {
      this.#assertPartitionScope(record.scope);
    }
    if (record.scope !== undefined) {
      await this.#validateReferences(record, validateScope(record.scope));
    }
  }

/** 解析并读取记录内所有非 Artifact Ref，验证目标摘要及与 owner 的 Scope 兼容性。 */
  async #validateReferences(value: unknown, ownerScope: ScopeRef): Promise<void> {
    const refs: Ref[] = [];
    collectRefs(value, refs);
    for (const ref of refs) {
      if (ref.schema === "evaldock.mvp.artifact/v1") continue;
      const target = await this.#readRef(ref);
      if (
        target !== null &&
        typeof target === "object" &&
        "scope" in (target as Record<string, unknown>)
      ) {
        assertScopeCompatible(ownerScope, validateScope((target as Record<string, unknown>).scope));
      }
    }
  }

  /** 确认记录 Scope 属于构造时固定的 Run 分区和更上层锚点。 */
  #assertPartitionScope(scope: unknown): void {
    const recordScope = validateScope(scope, "record scope");
    if (recordScope.runId !== undefined && recordScope.runId !== this.#runId) {
      throw new ContractViolation("SCOPE_MISMATCH", "record does not belong to repository run partition");
    }
    assertScopeCompatible(this.#scope, recordScope);
  }

  /** get 与内部引用校验共用的读取器，按 schema 类型定位文件并复验身份、revision 和摘要。 */
  async #readRef<T>(unvalidatedRef: Ref<T>): Promise<Readonly<T>> {
    const lifecycle = isLifecycleSchema(unvalidatedRef.schema);
    const ref = validateRef<T>(unvalidatedRef, { lifecycle });
    const path = lifecycle
      ? await this.#projectionRevisionPath(
          ref.schema as LifecycleAggregateSchema,
          ref.id,
          ref.revision as number,
        )
      : await this.#immutablePath(ref.schema, ref.id);
    const record = await this.#readJson(path);
    if (record.schema !== ref.schema) {
      throw new ContractViolation("EVIDENCE_INTEGRITY", "stored schema does not match Ref");
    }
    let actualDigest: ContentDigest;
    if (lifecycle) {
      const projection = record as unknown as LifecycleProjectionBase;
      const identity = projectionIdentity(projection);
      if (identity.id !== ref.id || projection.revision !== ref.revision) {
        throw new ContractViolation("EVIDENCE_INTEGRITY", "stored lifecycle identity does not match Ref");
      }
      actualDigest = verifyProjectionDigest(projection);
      this.#assertPartitionScope(projection.scope);
    } else {
      const identity = immutableIdentity(record);
      if (identity.id !== ref.id) {
        throw new ContractViolation("EVIDENCE_INTEGRITY", "stored immutable identity does not match Ref");
      }
      actualDigest = verifyImmutableDigest(record);
      if (!SCOPELESS_SCHEMAS.has(identity.schema)) this.#assertPartitionScope(record.scope);
    }
    assertDigestEquals(actualDigest, ref.digest);
    return deepFreeze(record as unknown as T);
  }

  /** 从普通文件读取 JSON 对象，拒绝符号链接、缺失记录和非对象内容。 */
  async #readJson(path: string): Promise<UnknownRecord> {
    let bytes: Buffer;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ContractViolation("PATH_ESCAPE", "record path is not a regular file");
      }
      bytes = await readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ContractViolation("NOT_FOUND", "committed record was not found");
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new ContractViolation("EVIDENCE_INTEGRITY", "committed record is not valid JSON", {
        cause: error,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ContractViolation("EVIDENCE_INTEGRITY", "committed record is not a JSON object");
    }
    return parsed as UnknownRecord;
  }

  /** 通过 ensureSafeDirectory 解析或创建当前 Run 的仓储分区。 */
  async #partitionDirectory(): Promise<string> {
    return ensureSafeDirectory(this.#runRoot, [this.#runId]);
  }

  /** 为受支持的不可变 schema/ID 生成分区内记录路径。 */
  async #immutablePath(schema: string, id: StableId): Promise<string> {
    if (isLifecycleSchema(schema)) {
      throw new ContractViolation("INVALID_REF", "lifecycle Ref requires a revision");
    }
    if (ID_FIELDS[schema] === undefined) {
      throw new ContractViolation("UNSUPPORTED_SCHEMA", `schema ${schema} is not in the MVP catalog`);
    }
    const records = await ensureSafeDirectory(await this.#partitionDirectory(), [
      "records",
      schemaKind(schema),
    ]);
    return join(records, `${validateStableId(id)}.json`);
  }

  /** 为生命周期聚合的指定不可变 revision 生成记录路径。 */
  async #projectionRevisionPath(
    schema: LifecycleAggregateSchema,
    id: StableId,
    revision: number,
  ): Promise<string> {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new ContractViolation("INVALID_REF", "revision must be a non-negative integer");
    }
    const records = await ensureSafeDirectory(await this.#partitionDirectory(), [
      "records",
      schemaKind(schema),
    ]);
    return join(records, `${validateStableId(id)}.r${revision}.json`);
  }

  /** 为生命周期聚合生成可原子替换的 current 投影路径。 */
  async #projectionCurrentPath(schema: LifecycleAggregateSchema, id: StableId): Promise<string> {
    const records = await ensureSafeDirectory(await this.#partitionDirectory(), [
      "records",
      schemaKind(schema),
    ]);
    return join(records, `${validateStableId(id)}.json`);
  }

  /** 首次真实操作前只执行一次恢复扫描，发现异常则阻断该实例的后续操作。 */
  async #ensureInitialized(): Promise<void> {
    this.#initialization ??= (async () => {
      const partition = await this.#partitionDirectory();
      const issues = await this.#scanRecoveryIssues(partition);
      if (issues.length > 0) {
        throw new ContractViolation(
          "STORAGE_RECOVERY_REQUIRED",
          `storage recovery is required (${issues.map((issue) => issue.code).join(", ")})`,
        );
      }
    })();
    return this.#initialization;
  }

  /** 递归扫描临时文件/JSONL，并核对每个生命周期聚合的完整 revision 历史。 */
  async #scanRecoveryIssues(partition: string): Promise<readonly RecoveryIssue[]> {
    const issues: RecoveryIssue[] = [];
    /** 递归遍历分区，收集符号链接、临时文件以及破损/重复 JSONL 事件。 */
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const location = relative(partition, path).split(sep).join("/");
        if (entry.isSymbolicLink()) {
          issues.push({ code: "STALE_TEMP_FILE", portableLocation: location, detail: "symlink in data partition" });
          continue;
        }
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (entry.name.startsWith(".tmp-") || entry.name.endsWith(".partial")) {
          issues.push({ code: "STALE_TEMP_FILE", portableLocation: location, detail: "uncommitted temporary file" });
        }
        if (entry.name.endsWith(".jsonl")) {
          const text = await readFile(path, "utf8");
          if (text.length > 0 && !text.endsWith("\n")) {
            issues.push({ code: "BAD_JSONL", portableLocation: location, detail: "JSONL has an incomplete tail" });
            continue;
          }
          const eventIds = new Set<string>();
          for (const [index, line] of text.split("\n").entries()) {
            if (line.length === 0) continue;
            try {
              const parsed = JSON.parse(line) as unknown;
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
              const eventId = (parsed as Record<string, unknown>).eventId;
              if (typeof eventId === "string") {
                if (eventIds.has(eventId)) {
                  issues.push({
                    code: "DUPLICATE_EVENT_ID",
                    portableLocation: location,
                    detail: `duplicate event ID at line ${index + 1}`,
                  });
                }
                eventIds.add(eventId);
              }
            } catch {
              issues.push({
                code: "BAD_JSONL",
                portableLocation: location,
                detail: `invalid JSON at line ${index + 1}`,
              });
            }
          }
        }
      }
    };
    await walk(partition);
    const recordsRoot = join(partition, "records");
    for (const schema of Object.keys(PROJECTION_ID_FIELDS) as LifecycleAggregateSchema[]) {
      const directory = join(recordsRoot, schemaKind(schema));
      const directoryMetadata = await existingLstat(directory);
      if (directoryMetadata === undefined) continue;
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) continue;
      const entries = await readdir(directory, { withFileTypes: true });
      const revisions = new Map<string, Set<number>>();
      for (const entry of entries) {
        const match = /^(.+)\.r([0-9]+)\.json$/u.exec(entry.name);
        if (match?.[1] === undefined || match[2] === undefined) continue;
        const revision = Number(match[2]);
        if (!Number.isSafeInteger(revision)) continue;
        const set = revisions.get(match[1]) ?? new Set<number>();
        set.add(revision);
        revisions.set(match[1], set);
      }
      for (const [id, savedRevisions] of revisions) {
        const currentPath = join(directory, `${id}.json`);
        try {
          const current = (await this.#readJson(currentPath)) as unknown as LifecycleProjectionBase;
          const identity = projectionIdentity(current);
          verifyProjectionDigest(current);
          const expected = new Set(
            Array.from({ length: current.revision + 1 }, (_unused, revision) => revision),
          );
          const historyMatches =
            identity.schema === schema &&
            identity.id === id &&
            expected.size === savedRevisions.size &&
            [...expected].every((revision) => savedRevisions.has(revision));
          if (!historyMatches) {
            issues.push({
              code: "ORPHAN_PROJECTION_REVISION",
              portableLocation: relative(partition, directory).split(sep).join("/"),
              detail: `${schema}/${id} revision history does not match its current projection`,
            });
          }
        } catch {
          issues.push({
            code: "ORPHAN_PROJECTION_REVISION",
            portableLocation: relative(partition, directory).split(sep).join("/"),
            detail: `${schema}/${id} has no verifiable current projection`,
          });
        }
      }
    }
    return issues;
  }

  /** 在当前 Repository 实例内串行执行写动作，保护多文件提交顺序。 */
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

  /** 按“操作名 + idempotencyKey”缓存 Promise；同键不同输入返回冲突。 */
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
      return this.#mapError<T>(context, error, "INVALID_OPERATION_INPUT");
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

  /** 各 Port 入口在触碰存储前调用，将取消请求转换成统一 cancelled 结果。 */
  #cancelledIfRequested<T>(context: OperationContext): PortResult<T> | undefined {
    if (!context.cancellationToken.isCancellationRequested) return undefined;
    return cancelled(
      this.#failure(context, "CANCELLED", "OPERATION_CANCELLED", "Storage operation was cancelled", "USER"),
    );
  }

  /** 将领域/文件系统异常归一为 RepositoryPort 的 rejected 或 failed 结果。 */
  #mapError<T>(context: OperationContext, error: unknown, fallbackReason: string): PortResult<T> {
    if (error instanceof ContractViolation) {
      const rejection =
        error.code === "NOT_FOUND"
          ? "NOT_FOUND"
          : error.code === "IMMUTABILITY_CONFLICT"
            ? "CONFLICT"
            : error.code === "STALE_REVISION"
              ? "STALE_REVISION"
              : error.code === "PATH_ESCAPE"
                ? "AUTHORIZATION_DENIED"
                : error.code === "STORAGE_RECOVERY_REQUIRED"
                  ? "PRECONDITION_FAILED"
                  : error.code === "GATE_COMMIT_ORDER"
                    ? "PRECONDITION_FAILED"
                  : "INVALID_INPUT";
      const category =
        error.code === "EVIDENCE_INTEGRITY" ? "EVIDENCE_INTEGRITY" : "PERSISTENCE_FAILURE";
      return rejected(rejection, [
        this.#failure(context, category, error.code || fallbackReason, "Storage rejected an invalid or unsafe operation"),
      ]);
    }
    return failed(
      this.#failure(context, "PERSISTENCE_FAILURE", fallbackReason, "Storage could not persist or verify data"),
    );
  }

  /** 为本适配器构造统一脱敏的 STORAGE FailureDraft，供取消和错误映射复用。 */
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
