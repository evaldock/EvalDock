import {projectPaths} from "./paths.js";
/**
 * 文件职责：合并、校验并冻结一次调用的 EvalDock 配置。
 *
 * 核心流程：按默认值→配置文件→环境变量→CLI 的优先级合并字段，验证路径隔离、
 * Deadline、模型端点和 Secret 引用名称，记录每个字段来源并生成带摘要 ConfigSnapshot。
 *
 * 与其他文件的交互：`app/bootstrap.ts` 调用 freezeConfig；Workflow、Runtime、
 * Security、Storage 和 Report 只消费冻结后的 ConfigSnapshot。
 *
 * 公开接口：MvpConfigValues、FreezeConfigOptions 和 freezeConfig。
 */
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  type ConfigSnapshot,
  type JsonObject,
  validateIsoDateTime,
  validateStableId,
  withContentDigest,
} from "../core/models.js";

/** 用户可配置的 MVP 字段集合，也是未知字段校验的唯一白名单。 */
export interface MvpConfigValues {
  targetRoot: string;
  runRoot: string;
  artifactRoot: string;
  reportRoot: string;
  resultRoot: string;
  workspaceRoot: string;
  runtimeDshHomeRoot: string;
  runDeadlineMs: number;
  caseDeadlineMs: number;
  stableWindowMs: number;
  stableMaxWaitMs: number;
  maxArtifactBytes: number;
  contentMode: string;
  allowedModelEndpoints: readonly string[];
  minimumIsolationLevel: "AGENT_SEPARATED" | "SESSION_SEPARATED";
  rendererVersion: string;
  secretRefNames: readonly string[];
}

/** freezeConfig 的调用级上下文和三种可选配置来源。 */
export interface FreezeConfigOptions {
  cwd: string;
  configId: string;
  invocationId: string;
  createdAt: string;
  evaldockVersion: string;
  configFile?: string;
  environment?: NodeJS.ProcessEnv;
  cli?: Partial<MvpConfigValues>;
}

/** 需要绝对化、危险根检查和两两不重叠验证的路径字段。 */
const ROOT_FIELDS = [
  "targetRoot",
  "runRoot",
  "artifactRoot",
  "reportRoot",
  "resultRoot",
  "workspaceRoot",
  "runtimeDshHomeRoot",
] as const;

/** 配置文件和 CLI 对象可出现的全部正式字段。 */
const CONFIG_FIELDS = new Set<keyof MvpConfigValues>([
  ...ROOT_FIELDS,
  "runDeadlineMs",
  "caseDeadlineMs",
  "stableWindowMs",
  "stableMaxWaitMs",
  "maxArtifactBytes",
  "contentMode",
  "allowedModelEndpoints",
  "minimumIsolationLevel",
  "rendererVersion",
  "secretRefNames",
]);

/** 允许进入配置合并流程的环境变量到字段映射。 */
const ENVIRONMENT_FIELDS: Readonly<Record<string, keyof MvpConfigValues>> = {
  EVALDOCK_TARGET_ROOT: "targetRoot",
  EVALDOCK_RUN_ROOT: "runRoot",
  EVALDOCK_ARTIFACT_ROOT: "artifactRoot",
  EVALDOCK_REPORT_ROOT: "reportRoot",
  EVALDOCK_RESULT_ROOT: "resultRoot",
  EVALDOCK_WORKSPACE_ROOT: "workspaceRoot",
  EVALDOCK_RUNTIME_DSH_HOME_ROOT: "runtimeDshHomeRoot",
  EVALDOCK_RUN_DEADLINE_MS: "runDeadlineMs",
  EVALDOCK_CASE_DEADLINE_MS: "caseDeadlineMs",
  EVALDOCK_STABLE_WINDOW_MS: "stableWindowMs",
  EVALDOCK_STABLE_MAX_WAIT_MS: "stableMaxWaitMs",
  EVALDOCK_MAX_ARTIFACT_BYTES: "maxArtifactBytes",
  EVALDOCK_CONTENT_MODE: "contentMode",
  EVALDOCK_ALLOWED_MODEL_ENDPOINTS: "allowedModelEndpoints",
  EVALDOCK_RENDERER_VERSION: "rendererVersion",
  EVALDOCK_SECRET_REF_NAMES: "secretRefNames",
};

/** Harness 或进程启动语义占用的变量名，不能被 Secret 引用替换。 */
const RESERVED_SECRET_REF_NAMES = new Set([
  "HOME",
  "USERPROFILE",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "CDPATH",
  "PATH",
  "LANG",
  "TMPDIR",
  "DSH_HOME",
]);

/** 构造相对于当前工作目录的安全默认配置。 */
function defaults(cwd: string): Omit<MvpConfigValues, "targetRoot"> {
  const variableRoot = path.join(projectPaths(cwd).runtime,"standalone");
  return {
    runRoot: path.join(variableRoot, "records"),
    artifactRoot: path.join(variableRoot, "artifacts"),
    reportRoot: path.join(variableRoot, "reports"),
    resultRoot: projectPaths(cwd).results,
    workspaceRoot: path.join(variableRoot, "workspaces"),
    runtimeDshHomeRoot: path.join(variableRoot, "runtime-homes"),
    runDeadlineMs: 300_000,
    caseDeadlineMs: 240_000,
    stableWindowMs: 250,
    stableMaxWaitMs: 5_000,
    maxArtifactBytes: 67_108_864,
    contentMode: "DIGEST",
    allowedModelEndpoints: [],
    minimumIsolationLevel: "AGENT_SEPARATED",
    rendererVersion: "evaldock-static/v3",
    secretRefNames: [],
  };
}

/** 将配置来源收窄为对象，并拒绝 CONFIG_FIELDS 之外的键。 */
function assertKnownFields(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => !CONFIG_FIELDS.has(key as keyof MvpConfigValues),
  );
  if (unknown.length > 0) throw new Error(`${source} has unknown fields: ${unknown.sort().join(", ")}`);
  return record;
}

/** 读取白名单环境变量，并把数字和逗号列表转换为配置值。 */
function environmentValues(environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [environmentName, field] of Object.entries(ENVIRONMENT_FIELDS)) {
    const raw = environment[environmentName];
    if (raw === undefined) continue;
    if (
      field === "runDeadlineMs" ||
      field === "caseDeadlineMs" ||
      field === "stableWindowMs" ||
      field === "stableMaxWaitMs" ||
      field === "maxArtifactBytes"
    ) {
      values[field] = Number(raw);
    } else if (field === "allowedModelEndpoints" || field === "secretRefNames") {
      values[field] = raw.length === 0 ? [] : raw.split(",").map((entry) => entry.trim());
    } else {
      values[field] = raw;
    }
  }
  return values;
}

/** 校验 Deadline、窗口和字节限制等正安全整数。 */
function validatePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

/** 校验字符串数组，去重并稳定排序以便摘要可复现。 */
function validateStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value as string[])].sort();
}

/** 解析并验证单个 Root 路径，保留不存在但可安全创建的绝对路径。 */
async function validateRoot(root: string, cwd: string, field: string): Promise<string> {
  if (
    root.includes("\0") ||
    /[*?[\]{}$]/u.test(root) ||
    /%[^%]+%/u.test(root)
  ) {
    throw new Error(`${field} contains an unsafe or unresolved path expression`);
  }
  const absolute = path.resolve(cwd, root);
  const parsed = path.parse(absolute);
  const looksLikeUserHome =
    absolute === "/root" ||
    /^\/home\/[^/]+$/u.test(absolute) ||
    /^\/Users\/[^/]+$/u.test(absolute);
  if (absolute === parsed.root || absolute === os.homedir() || looksLikeUserHome) {
    throw new Error(`${field} cannot be a filesystem or user-home root`);
  }
  if (field !== "targetRoot" && absolute === path.resolve(cwd)) {
    throw new Error(`${field} cannot be the repository root`);
  }
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`${field} cannot be a symlink root`);
    if (!metadata.isDirectory()) throw new Error(`${field} must be a directory when it exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return absolute;
}

/** 判断两个 Root 是否相同或存在祖先关系；freezeConfig 用它阻止权限域重叠。 */
function rootsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative)) ||
    (!reverse.startsWith("..") && !path.isAbsolute(reverse))
  );
}

/** 为每个冻结字段记录最终值来自 CLI、环境、文件还是默认值。 */
function fieldSources(
  file: Record<string, unknown>,
  environment: Record<string, unknown>,
  cli: Record<string, unknown>,
): JsonObject {
  return Object.fromEntries(
    [...CONFIG_FIELDS].sort().map((field) => [
      field,
      Object.prototype.hasOwnProperty.call(cli, field)
        ? "CLI"
        : Object.prototype.hasOwnProperty.call(environment, field)
          ? "ENVIRONMENT"
          : Object.prototype.hasOwnProperty.call(file, field)
            ? "FILE"
            : "DEFAULT",
    ]),
  ) as JsonObject;
}

/**
 * 合并全部配置来源并返回摘要保护的 ConfigSnapshot；Bootstrap 是生产调用方。
 */
export async function freezeConfig(options: FreezeConfigOptions): Promise<ConfigSnapshot> {
  const fileValues =
    options.configFile === undefined
      ? {}
      : assertKnownFields(
          JSON.parse(await readFile(path.resolve(options.cwd, options.configFile), "utf8")),
          "config file",
        );
  const fromEnvironment = environmentValues(options.environment ?? process.env);
  const cliValues = assertKnownFields(options.cli ?? {}, "CLI config");
  const merged = {
    ...defaults(options.cwd),
    ...fileValues,
    ...fromEnvironment,
    ...cliValues,
  } as Record<string, unknown>;
  if (typeof merged.targetRoot !== "string" || merged.targetRoot.length === 0) {
    throw new Error("targetRoot is required");
  }

  const roots: Record<(typeof ROOT_FIELDS)[number], string> = {} as Record<
    (typeof ROOT_FIELDS)[number],
    string
  >;
  for (const field of ROOT_FIELDS) {
    if (typeof merged[field] !== "string" || merged[field].length === 0) {
      throw new Error(`${field} must be a non-empty path`);
    }
    roots[field] = await validateRoot(merged[field], options.cwd, field);
  }
  for (let left = 0; left < ROOT_FIELDS.length; left += 1) {
    for (let right = left + 1; right < ROOT_FIELDS.length; right += 1) {
      const leftField = ROOT_FIELDS[left];
      const rightField = ROOT_FIELDS[right];
      if (leftField === undefined || rightField === undefined) continue;
      if (rootsOverlap(roots[leftField], roots[rightField])) {
        throw new Error(`${leftField} and ${rightField} must not overlap`);
      }
    }
  }

  const allowedModelEndpoints = validateStringArray(
    merged.allowedModelEndpoints,
    "allowedModelEndpoints",
  );
  for (const endpoint of allowedModelEndpoints) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:") throw new Error("model endpoints must use HTTPS");
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("model endpoint URLs cannot contain credentials");
    }
  }
  const secretRefNames = validateStringArray(merged.secretRefNames, "secretRefNames");
  if (secretRefNames.some((name) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(name))) {
    throw new Error("secretRefNames must contain environment reference names, never values");
  }
  if (
    secretRefNames.some(
      (name) =>
        RESERVED_SECRET_REF_NAMES.has(name) ||
        name.startsWith("DSH_EVAL_") ||
        name.startsWith("EVALDOCK_"),
    )
  ) {
    throw new Error("secretRefNames cannot replace harness-owned environment variables");
  }
  if (
    merged.minimumIsolationLevel !== "AGENT_SEPARATED" &&
    merged.minimumIsolationLevel !== "SESSION_SEPARATED"
  ) {
    throw new Error("minimumIsolationLevel must be AGENT_SEPARATED or SESSION_SEPARATED");
  }
  if (typeof merged.contentMode !== "string" || merged.contentMode.length === 0) {
    throw new Error("contentMode must be a non-empty string");
  }
  if (typeof merged.rendererVersion !== "string" || merged.rendererVersion.length === 0) {
    throw new Error("rendererVersion must be a non-empty string");
  }

  const sources = fieldSources(fileValues, fromEnvironment, cliValues);
  const record = {
    schema: "evaldock.mvp.config/v1" as const,
    configId: validateStableId<"ConfigId">(options.configId, "configId"),
    invocationId: validateStableId<"InvocationId">(options.invocationId, "invocationId"),
    ...roots,
    runDeadlineMs: validatePositiveInteger(merged.runDeadlineMs, "runDeadlineMs"),
    caseDeadlineMs: validatePositiveInteger(merged.caseDeadlineMs, "caseDeadlineMs"),
    stableWindowMs: validatePositiveInteger(merged.stableWindowMs, "stableWindowMs"),
    stableMaxWaitMs: validatePositiveInteger(merged.stableMaxWaitMs, "stableMaxWaitMs"),
    maxArtifactBytes: validatePositiveInteger(merged.maxArtifactBytes, "maxArtifactBytes"),
    contentMode: merged.contentMode,
    allowedModelEndpoints,
    minimumIsolationLevel: merged.minimumIsolationLevel,
    rendererVersion: merged.rendererVersion,
    fieldSources: sources,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    evaldockVersion: options.evaldockVersion,
    secretRefNames,
    createdAt: validateIsoDateTime(options.createdAt, "createdAt"),
  };
  return withContentDigest(record) as ConfigSnapshot;
}
