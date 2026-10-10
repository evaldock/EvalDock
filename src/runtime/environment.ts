/**
 * 文件职责：为每个 Attempt 创建受约束的 Workspace 与 Runtime Home，冻结目标文件树，播种场景资源，并执行重置和清理。
 * 核心流程：校验根目录、稳定标识和便携路径，创建精确的 run/case/attempt 目录，复制只读运行材料，随后按工作流阶段播种、重置或删除。
 * 与其他文件的真实交互：由 app/workflow.ts 编排；返回的路径交给 runtime/target.ts 启动目标，并由 observation 下的 Probe 与文件传感器读取证据。
 * 公开接口：SeedEntrySpec、SeedResourceEntry、PreparedEnvironment、StagedTargetRuntime，以及环境准备、目标暂存、播种、重置和清理函数。
 */
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 从冻结 EnvironmentDefinition 转换出的单个播种目录或文件规格。 */
export interface SeedEntrySpec {
  portablePath: string;
  entryType: "DIRECTORY" | "FILE";
  mode: string;
  readOnlyForTarget: boolean;
  content?: string;
  encoding?: "utf8" | "base64";
}

/** seedEnvironment 返回给工作流记录的实际播种资源及文件摘要。 */
export interface SeedResourceEntry {
  portablePath: string;
  entryType: "DIRECTORY" | "FILE";
  mode: string;
  readOnlyForTarget: boolean;
  byteLength?: number;
  sha256?: string;
}

/** prepareEnvironment 为目标执行和观察器建立的 Attempt 级路径集合。 */
export interface PreparedEnvironment {
  workspacePath: string;
  runtimeDshHomePath: string;
  probeDirectoryPath: string;
  probeOutputPath: string;
  resetGeneration: number;
}

/** 冻结目标树在 Runtime Home 内的只读副本及经复核的入口摘要。 */
export interface StagedTargetRuntime {
  stagedTargetRoot: string;
  stagedExecutablePath: string;
  executableSha256: string;
}

/** 用于映射目录层级的稳定标识约束，防止分隔符和宽泛路径进入文件系统。 */
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 校验文件系统路径片段使用的稳定标识；由 Attempt 路径和 Profile 处理调用。 */
function validateId(value: string, name: string): void {
  if (!STABLE_ID.test(value)) throw new Error(`${name} is not a StableId`);
}

/** 校验相对、无遍历且无通配符的便携路径；由源树检查和 Workspace 播种调用。 */
export function validatePortablePath(portablePath: string): string {
  if (
    portablePath.length === 0 ||
    portablePath.includes("\0") ||
    portablePath.includes("\\") ||
    path.posix.isAbsolute(portablePath) ||
    portablePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[*?[\]{}$]/.test(portablePath)
  ) {
    throw new Error(`unsafe portable path: ${portablePath}`);
  }
  return portablePath;
}

/** 判断候选路径在词法上是否位于指定根内；供本文件全部路径边界检查复用。 */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 逐级拒绝候选路径中的符号链接祖先；由精确目录校验和播种写入前检查调用。 */
async function assertNoSymlinkAncestors(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  if (!isWithin(root, candidate)) throw new Error("path escapes configured root");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`symlink path component rejected: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

/** 创建或解析安全的真实根目录，并拒绝文件系统根、用户目录和符号链接；由环境生命周期入口调用。 */
async function resolvedRoot(root: string, create = true): Promise<string> {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    throw new Error("environment root must be an absolute NUL-free path");
  }
  const absolute = path.resolve(root);
  if (absolute === path.parse(absolute).root || absolute === os.homedir()) {
    throw new Error("environment root must not be a filesystem or user-home root");
  }
  try {
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) throw new Error("environment root must not be a symlink");
    if (!before.isDirectory()) throw new Error("environment root must be a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  }
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("environment root must be a real directory");
  }
  const resolved = await realpath(absolute);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new Error("environment root resolved to a broad directory");
  }
  return resolved;
}

/** 从三个稳定标识推导精确 Attempt 路径；由创建和身份复核逻辑调用。 */
function attemptPath(root: string, runId: string, caseId: string, attemptId: string): string {
  validateId(runId, "runId");
  validateId(caseId, "caseId");
  validateId(attemptId, "attemptId");
  const candidate = path.join(root, runId, caseId, attemptId);
  if (!isWithin(root, candidate) || candidate === root) {
    throw new Error("attempt path escapes its configured root");
  }
  return candidate;
}

/** 创建新的 root/run/case/attempt 目录并复核每级真实身份；由 prepareEnvironment 分别用于 Workspace 与 Runtime Home。 */
async function ensureAttemptDirectory(
  root: string,
  runId: string,
  caseId: string,
  attemptId: string,
): Promise<string> {
  const expected = attemptPath(root, runId, caseId, attemptId);
  let current = root;
  for (const [index, segment] of [runId, caseId].entries()) {
    const candidate = path.join(current, segment);
    const existing = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined) await mkdir(candidate, { mode: 0o710 });
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`attempt parent component ${index + 1} is not a real directory`);
    }
    current = await realpath(candidate);
    if (!isWithin(root, current)) throw new Error("attempt parent escaped configured root");
  }
  if ((await lstat(expected).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) !== undefined) {
    throw new Error("attempt directory already exists");
  }
  await mkdir(expected, { recursive: false, mode: 0o2770 });
  // mkdir 会受服务进程 umask 影响；正式运行要求冻结目标所属组可写入精确 Attempt 目录，
  // 因此显式固定权限，避免依赖启动器的 umask。
  await chmod(expected, 0o2770);
  const metadata = await lstat(expected);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("attempt directory is not a real directory");
  }
  return expected;
}

/** 将输入复核为恰好三级的既有 Attempt 目录；所有重置、清理和暂存写入都经此入口限制删除或修改范围。 */
async function assertExactAttemptDirectory(
  rootInput: string,
  attemptInput: string,
  expectedIds?: {
    readonly runId: string;
    readonly caseId: string;
    readonly attemptId: string;
  },
): Promise<{ root: string; attempt: string; ids: readonly [string, string, string] }> {
  const root = await resolvedRoot(rootInput, false);
  if (!path.isAbsolute(attemptInput) || attemptInput.includes("\0")) {
    throw new Error("attempt path must be absolute and NUL-free");
  }
  const attempt = path.resolve(attemptInput);
  const relative = path.relative(root, attempt);
  const parts = relative.split(path.sep);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    parts.length !== 3 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("operation requires an exact root/run/case/attempt directory");
  }
  parts.forEach((part, index) => validateId(part, ["runId", "caseId", "attemptId"][index] ?? "id"));
  if (
    expectedIds !== undefined &&
    (parts[0] !== expectedIds.runId ||
      parts[1] !== expectedIds.caseId ||
      parts[2] !== expectedIds.attemptId)
  ) {
    throw new Error("attempt path does not match the frozen run/case/attempt identity");
  }
  await assertNoSymlinkAncestors(root, attempt);
  const metadata = await lstat(attempt);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("attempt path must be a real directory");
  }
  return { root, attempt, ids: parts as unknown as readonly [string, string, string] };
}

/** 递归验证冻结源树仅含文件、目录及根内符号链接；由 Profile 和目标暂存流程在复制前调用。 */
async function assertSafeSourceTree(root: string, source: string): Promise<void> {
  const relative = path.relative(root, source).split(path.sep).join("/");
  if (relative !== "") validatePortablePath(relative);
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    const resolved = await realpath(source);
    if (!isWithin(root, resolved)) throw new Error("source symlink escapes its frozen root");
    return;
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new Error("source tree contains a non-file, non-directory entry");
  }
  if (!metadata.isDirectory()) return;
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) await assertSafeSourceTree(root, path.join(source, entry.name));
}

/** 确定性复制已验证源树，并将目录和文件收紧为只读模式；由 Profile 与目标 Runtime 暂存调用。 */
async function copyFrozenTree(
  sourceRoot: string,
  source: string,
  destinationRoot: string,
  destination: string,
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    const resolvedSourceTarget = await realpath(source);
    if (!isWithin(sourceRoot, resolvedSourceTarget)) {
      throw new Error("source symlink escapes its frozen root");
    }
    const mappedTarget = path.join(destinationRoot, path.relative(sourceRoot, resolvedSourceTarget));
    if (!isWithin(destinationRoot, mappedTarget)) {
      throw new Error("mapped source symlink escapes its staged root");
    }
    const relativeTarget = path.relative(path.dirname(destination), mappedTarget) || ".";
    await symlink(relativeTarget, destination);
    return;
  }
  if (metadata.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      await copyFrozenTree(
        sourceRoot,
        path.join(source, entry.name),
        destinationRoot,
        path.join(destination, entry.name),
      );
    }
    await chmod(destination, 0o555);
    return;
  }
  if (!metadata.isFile()) throw new Error("source tree contains an unsupported special file");
  await copyFile(source, destination);
  await chmod(destination, (metadata.mode & 0o111) === 0 ? 0o444 : 0o555);
}

/** 让隔离 Runtime Profile 可由目标身份初始化；冻结源和暂存 Target 仍保持只读。 */
async function makeRuntimeProfileWritable(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makeRuntimeProfileWritable(child);
      continue;
    }
    const metadata = await lstat(child);
    await chmod(child, (metadata.mode & 0o111) === 0 ? 0o660 : 0o770);
  }
  await chmod(directory, 0o770);
}

/** 在准备失败后仅回滚已创建且身份重新验证的 Attempt 目录；由 prepareEnvironment 的异常路径调用。 */
async function rollbackCreatedAttempt(
  root: string,
  attempt: string,
  ids: { readonly runId: string; readonly caseId: string; readonly attemptId: string },
): Promise<void> {
  const existing = await lstat(attempt).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) return;
  const verified = await assertExactAttemptDirectory(root, attempt, ids);
  await makeTreeControllerWritable(verified.attempt);
  await rm(verified.attempt, { recursive: true, force: false, maxRetries: 0 });
}

/**
 * 创建一次执行的 Workspace、隔离 Runtime Home、可选冻结 Profile 和 Probe 输出目录；由 app/workflow.ts 在创建运行投影后调用。
 */
export async function prepareEnvironment(input: {
  workspaceRoot: string;
  runtimeDshHomeRoot: string;
  runId: string;
  caseId: string;
  attemptId: string;
  sourceDshHome?: string;
  profile?: string;
}): Promise<PreparedEnvironment> {
  if ((input.sourceDshHome === undefined) !== (input.profile === undefined)) {
    throw new Error("sourceDshHome and profile must be supplied together");
  }
  const workspaceRoot = await resolvedRoot(input.workspaceRoot);
  const runtimeHomeRoot = await resolvedRoot(input.runtimeDshHomeRoot);
  const ids = { runId: input.runId, caseId: input.caseId, attemptId: input.attemptId };
  let workspacePath: string | undefined;
  let runtimeDshHomePath: string | undefined;
  try {
    workspacePath = await ensureAttemptDirectory(
      workspaceRoot,
      input.runId,
      input.caseId,
      input.attemptId,
    );
    runtimeDshHomePath = await ensureAttemptDirectory(
      runtimeHomeRoot,
      input.runId,
      input.caseId,
      input.attemptId,
    );

    if (input.sourceDshHome !== undefined && input.profile !== undefined) {
      validateId(input.profile, "profile");
      if (!path.isAbsolute(input.sourceDshHome)) throw new Error("sourceDshHome must be absolute");
      const sourceHomeInput = path.resolve(input.sourceDshHome);
      const sourceHomeMetadata = await lstat(sourceHomeInput);
      if (!sourceHomeMetadata.isDirectory() || sourceHomeMetadata.isSymbolicLink()) {
        throw new Error("sourceDshHome must be a real directory");
      }
      const sourceHome = await realpath(sourceHomeInput);
      const sourceProfileInput = path.join(sourceHome, "profiles", input.profile);
      const sourceProfile = await realpath(sourceProfileInput);
      if (!isWithin(sourceHome, sourceProfile)) throw new Error("profile escapes sourceDshHome");
      const profileMetadata = await lstat(sourceProfile);
      if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()) {
        throw new Error("profile must resolve to a real directory");
      }
      await assertSafeSourceTree(sourceProfile, sourceProfile);
      const profilesDestination = path.join(runtimeDshHomePath, "profiles");
      // 保留 setgid，使复制出的 profile 继承 Attempt 的目标组；否则降权后的
      // dshagent 无法读取 package.json，DSH 会把既有 profile 误判为不存在。
      await mkdir(profilesDestination, { mode: 0o2770 });
      await chmod(profilesDestination, 0o2770);
      const destination = path.join(profilesDestination, input.profile);
      await copyFrozenTree(sourceProfile, sourceProfile, destination, destination);
      await makeRuntimeProfileWritable(destination);
    }

    const probeDirectoryPath = path.join(runtimeDshHomePath, "probe");
    await mkdir(probeDirectoryPath, { recursive: false, mode: 0o770 });
    await chmod(probeDirectoryPath, 0o770);
    const temporaryDirectoryPath = path.join(runtimeDshHomePath, "tmp");
    await mkdir(temporaryDirectoryPath, { recursive: false, mode: 0o770 });
    await chmod(temporaryDirectoryPath, 0o770);
    return {
      workspacePath,
      runtimeDshHomePath,
      probeDirectoryPath,
      probeOutputPath: path.join(probeDirectoryPath, "events.jsonl"),
      resetGeneration: 0,
    };
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const [root, attempt] of [
      [runtimeHomeRoot, runtimeDshHomePath],
      [workspaceRoot, workspacePath],
    ] as const) {
      if (attempt === undefined) continue;
      try {
        await rollbackCreatedAttempt(root, attempt, ids);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "environment preparation failed and its exact-attempt rollback was incomplete",
        { cause: error },
      );
    }
    throw error;
  }
}

/** 流式计算文件 SHA-256；由 stageTargetRuntime 在复制前后验证入口内容一致性。 */
async function sha256File(file: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * 将已冻结目标树复制到本 Attempt 的 Runtime Home 并复核入口摘要；由 app/workflow.ts 在 executeTarget 前调用。
 */
export async function stageTargetRuntime(input: {
  sourceRoot: string;
  executablePath: string;
  expectedExecutableSha256: string;
  runtimeDshHomeRoot: string;
  runtimeDshHomePath: string;
  runId: string;
  caseId: string;
  attemptId: string;
}): Promise<StagedTargetRuntime> {
  if (!/^[0-9a-f]{64}$/.test(input.expectedExecutableSha256)) {
    throw new Error("expectedExecutableSha256 must be a lowercase SHA-256 digest");
  }
  if (!path.isAbsolute(input.sourceRoot) || !path.isAbsolute(input.executablePath)) {
    throw new Error("sourceRoot and executablePath must be absolute");
  }
  const sourceInput = path.resolve(input.sourceRoot);
  const sourceMetadata = await lstat(sourceInput);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("sourceRoot must be a real directory");
  }
  const sourceRoot = await realpath(sourceInput);
  if (sourceRoot === path.parse(sourceRoot).root || sourceRoot === os.homedir()) {
    throw new Error("sourceRoot is too broad to stage");
  }
  const executablePath = await realpath(input.executablePath);
  if (!isWithin(sourceRoot, executablePath)) {
    throw new Error("executablePath escapes sourceRoot");
  }
  const executableMetadata = await lstat(executablePath);
  if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink()) {
    throw new Error("executablePath must resolve to a regular file");
  }
  const sourceExecutableSha256 = await sha256File(executablePath);
  if (sourceExecutableSha256 !== input.expectedExecutableSha256) {
    throw new Error("frozen executable digest changed before staging");
  }

  const runtime = await assertExactAttemptDirectory(
    input.runtimeDshHomeRoot,
    input.runtimeDshHomePath,
    input,
  );
  await assertSafeSourceTree(sourceRoot, sourceRoot);
  const stagedTargetRoot = path.join(runtime.attempt, "target-runtime");
  if ((await lstat(stagedTargetRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) !== undefined) {
    throw new Error("staged target runtime already exists");
  }
  await copyFrozenTree(sourceRoot, sourceRoot, stagedTargetRoot, stagedTargetRoot);
  const stagedExecutablePath = path.join(
    stagedTargetRoot,
    path.relative(sourceRoot, executablePath),
  );
  if (!isWithin(stagedTargetRoot, stagedExecutablePath)) {
    throw new Error("staged executable escaped the staged target root");
  }
  const stagedExecutableMetadata = await lstat(stagedExecutablePath);
  if (!stagedExecutableMetadata.isFile() || stagedExecutableMetadata.isSymbolicLink()) {
    throw new Error("staged executable is not a regular file");
  }
  const executableSha256 = await sha256File(stagedExecutablePath);
  if (executableSha256 !== sourceExecutableSha256) {
    throw new Error("staged executable digest does not match frozen source");
  }
  return { stagedTargetRoot, stagedExecutablePath, executableSha256 };
}

/** 按便携路径顺序向新 Workspace 写入冻结种子并返回可审计元数据；由 app/workflow.ts 在基线快照前调用。 */
export async function seedEnvironment(
  workspacePath: string,
  entries: readonly SeedEntrySpec[],
): Promise<readonly SeedResourceEntry[]> {
  if (!path.isAbsolute(workspacePath) || workspacePath.includes("\0")) {
    throw new Error("workspacePath must be absolute and NUL-free");
  }
  const workspaceMetadata = await lstat(workspacePath);
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw new Error("workspacePath must be a real directory");
  }
  const root = await realpath(workspacePath);
  if (root === path.parse(root).root || root === os.homedir()) {
    throw new Error("refusing to seed a broad workspace path");
  }
  const seen = new Set<string>();
  const resources: SeedResourceEntry[] = [];
  const directoryModes: Array<{ destination: string; mode: number }> = [];
  // Materialize missing parent directories before any writes. Explicit modes remain authoritative.
  const expanded = new Map<string, SeedEntrySpec>();
  for (const entry of entries) {
    validatePortablePath(entry.portablePath);
    if (expanded.has(entry.portablePath)) throw new Error(`duplicate seed path: ${entry.portablePath}`);
    expanded.set(entry.portablePath, entry);
  }
  const implicit = new Set<string>();
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.portablePath);
    while (parent !== ".") {
      const existing = expanded.get(parent);
      if (existing?.entryType === "FILE") throw new Error("Seed parent is a file");
      if (!existing) {
        expanded.set(parent, {portablePath:parent,entryType:"DIRECTORY",
          mode:entry.readOnlyForTarget ? "0555" : "0775",readOnlyForTarget:entry.readOnlyForTarget});
        implicit.add(parent);
      } else if (implicit.has(parent) && !entry.readOnlyForTarget) {
        expanded.set(parent, {...existing, mode:"0775", readOnlyForTarget:false});
      }
      parent = path.posix.dirname(parent);
    }
  }
  for (const entry of [...expanded.values()].sort((left, right) =>
    Buffer.from(left.portablePath).compare(Buffer.from(right.portablePath)),
  )) {
    const portablePath = validatePortablePath(entry.portablePath);
    if (seen.has(portablePath)) throw new Error(`duplicate seed path: ${portablePath}`);
    seen.add(portablePath);
    const destination = path.join(root, ...portablePath.split("/"));
    if (!isWithin(root, destination)) throw new Error("seed path escapes workspace");
    await assertNoSymlinkAncestors(root, path.dirname(destination));
    if (!/^0[0-7]{3}$/.test(entry.mode)) {
      throw new Error(`invalid seed mode for ${portablePath}`);
    }
    const mode = Number.parseInt(entry.mode, 8);
    const writable = (mode & 0o222) !== 0;
    if (entry.readOnlyForTarget === writable) {
      throw new Error(`seed mode contradicts readOnlyForTarget for ${portablePath}`);
    }
    if (entry.entryType === "DIRECTORY") {
      await mkdir(destination, { recursive: false, mode: 0o700 });
      directoryModes.push({ destination, mode });
      resources.push({
        portablePath,
        entryType: "DIRECTORY",
        mode: entry.mode,
        readOnlyForTarget: entry.readOnlyForTarget,
      });
      continue;
    }
    if (entry.content === undefined || (entry.encoding !== "utf8" && entry.encoding !== "base64")) {
      throw new Error(`file seed ${portablePath} requires explicit UTF-8 or base64 content`);
    }
    const bytes = Buffer.from(entry.content, entry.encoding);
    await writeFile(destination, bytes, { flag: "wx", mode });
    await chmod(destination, mode);
    resources.push({
      portablePath,
      entryType: "FILE",
      mode: entry.mode,
      readOnlyForTarget: entry.readOnlyForTarget,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  for (const directory of directoryModes.sort(
    (left, right) => right.destination.length - left.destination.length,
  )) {
    await chmod(directory.destination, directory.mode);
  }
  return resources;
}

/** 删除并重建经身份复核的 Workspace，递增重置代次；由 app/workflow.ts 在目标执行和评判结束后调用。 */
export async function resetEnvironment(input: {
  workspaceRoot: string;
  workspacePath: string;
  resetGeneration: number;
}): Promise<{ resetGeneration: number; expectedEntries: readonly [] }> {
  if (!Number.isSafeInteger(input.resetGeneration) || input.resetGeneration < 0) {
    throw new Error("resetGeneration must be a non-negative safe integer");
  }
  const { attempt: workspace } = await assertExactAttemptDirectory(
    input.workspaceRoot,
    input.workspacePath,
  );
  await makeTreeControllerWritable(workspace);
  await rm(workspace, { recursive: true, force: false, maxRetries: 0 });
  await mkdir(workspace, { recursive: false, mode: 0o700 });
  return { resetGeneration: input.resetGeneration + 1, expectedEntries: [] };
}

/** 在独立快照确认 Workspace 为空后移除 Attempt 目录；由 app/workflow.ts 的正常及恢复清理路径调用。 */
export async function cleanupEnvironment(input: {
  workspaceRoot: string;
  workspacePath: string;
}): Promise<void> {
  const { attempt: workspace } = await assertExactAttemptDirectory(
    input.workspaceRoot,
    input.workspacePath,
  );
  const children = await readFileCount(workspace);
  if (children !== 0) throw new Error("cleanup requires an independently verified empty workspace");
  await rmdir(workspace);
}

/** 在 Probe 排空和 Session 封存后删除经身份复核的 Attempt Runtime Home；由 app/workflow.ts 清理阶段调用。 */
export async function cleanupRuntimeDshHome(input: {
  runtimeDshHomeRoot: string;
  runtimeDshHomePath: string;
  runId: string;
  caseId: string;
  attemptId: string;
}): Promise<void> {
  const { attempt } = await assertExactAttemptDirectory(
    input.runtimeDshHomeRoot,
    input.runtimeDshHomePath,
    input,
  );
  await makeTreeControllerWritable(attempt);
  await rm(attempt, { recursive: true, force: false, maxRetries: 0 });
}

/** 为 reset-mismatch 集成夹具写入残留文件；仅由带 fixture-* RunId 的测试流程调用。 */
export async function injectFixtureOnlyResetResidue(input: {
  workspaceRoot: string;
  workspacePath: string;
  runId: string;
  caseId: string;
  attemptId: string;
  fixtureBehavior: "reset-mismatch";
}): Promise<string> {
  if (!input.runId.startsWith("fixture-")) {
    throw new Error("fixture residue is allowed only for a fixture-* runId");
  }
  const { attempt } = await assertExactAttemptDirectory(
    input.workspaceRoot,
    input.workspacePath,
    input,
  );
  const residue = path.join(attempt, "fixture-reset-residue.txt");
  await writeFile(residue, "fixture-only reset mismatch\n", { flag: "wx", mode: 0o600 });
  return residue;
}

/** 统计目录直属项数量；由 cleanupEnvironment 验证 Workspace 已为空时调用。 */
async function readFileCount(directory: string): Promise<number> {
  const { opendir } = await import("node:fs/promises");
  const handle = await opendir(directory);
  let count = 0;
  try {
    for await (const _entry of handle) count += 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return count;
}

/** 递归恢复控制器对冻结树的写权限；由重置、清理与失败回滚在安全删除前调用。 */
async function makeTreeControllerWritable(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeTreeControllerWritable(child);
    else await chmod(child, 0o600);
  }
  await chmod(directory, 0o700);
}
