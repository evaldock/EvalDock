/**
 * 文件职责：从 evaldock.ai 榜单解析 CLI 请求的插件，并在一次性 Target 副本中安装。
 *
 * 只接受网站能够解析为 npm/GitHub DSH 安装目标的安装源。网站搜索索引的 rank
 * 越小表示排名越高；同名候选始终选择排名最高的一项，若该项没有可识别安装源
 * 则直接失败，不会静默降级到较低排名的候选。
 */
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { TargetDescriptor } from "../core/models.js";
import { withContentDigest } from "../core/models.js";

const DEFAULT_REGISTRY_URL = "https://www.dsheval.ai/data/manifest.json";
const DEFAULT_DSH_PACKAGE = "@deepseek-ai/dsh";
const FETCH_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
// 单测和宿主程序可能会替换 globalThis.fetch；只有保持原生实现时，
// Windows 才优先使用 PowerShell 的系统网络栈。
const nativeFetch = globalThis.fetch;

type JsonRecord = Record<string, unknown>;

interface CatalogInstall {
  readonly method?: unknown;
  readonly packageName?: unknown;
  readonly version?: unknown;
  readonly commands?: unknown;
}

type CatalogPlugin = JsonRecord;

interface CatalogManifest {
  readonly datasets?: unknown;
}

/** 网站解析出的、可用于一次安装的插件候选。 */
export interface ResolvedPlugin {
  readonly input: string;
  readonly rank: number;
  readonly fullName: string;
  readonly name: string;
  readonly packageName: string;
  readonly installMethod: string;
  readonly description?: string;
}

/** 供 CLI 诊断和测试使用的安装结果。 */
export interface PluginSelection {
  readonly plugins: readonly ResolvedPlugin[];
  readonly installCommands: readonly string[];
}

/** 返回用于 UI 模糊搜索的候选插件，按网站排名升序。 */
export async function searchPlugins(query: string, limit = 12): Promise<readonly ResolvedPlugin[]> {
  const value = query.trim();
  if (value.length === 0) return Object.freeze([]);
  const entries = await catalogEntries(process.env.EVALDOCK_PLUGIN_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
  return Object.freeze(entries
    .map((plugin, index) => ({ plugin, index }))
    .filter(({ plugin }) => pluginMatches(plugin, value, false))
    .sort((a, b) => pluginMatchScore(a.plugin, value) - pluginMatchScore(b.plugin, value) || rankOf(a.plugin, a.index) - rankOf(b.plugin, b.index))
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map(({ plugin, index }) => {
      const fullName = nonEmptyString(plugin.fullName) ?? nonEmptyString(plugin.name) ?? "";
      const name = nonEmptyString(plugin.name) ?? fullName;
      const install = recognizedInstall(plugin);
      const description = nonEmptyString(plugin.description);
      return Object.freeze({
        input: value,
        rank: rankOf(plugin, index),
        fullName,
        name,
        packageName: install === undefined ? "" : `${install.packageName}${install.version === undefined ? "" : `@${install.version}`}`,
        installMethod: install?.method ?? "unrecognized",
        ...(description === undefined ? {} : { description }),
      });
    }));
}

/** 一次性 Target 副本；调用方必须在使用后执行 cleanup。 */
export interface PreparedPluginTarget {
  readonly descriptor: TargetDescriptor;
  readonly selection: PluginSelection;
  readonly stagingRoot: string;
  readonly cleanup: () => Promise<void>;
}

function asObject(value: unknown): JsonRecord | undefined {
  return record(value);
}

async function readJsonObject(file: string): Promise<JsonRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return asObject(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`plugin target configuration is not valid JSON: ${file}`, { cause: error });
  }
}

function pluginId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = asObject(value);
  return nonEmptyString(object?.id) ?? nonEmptyString(object?.name);
}

function appendPlugin(values: unknown[], packageName: string): void {
  if (values.some((value) => pluginId(value)?.toLowerCase() === packageName.toLowerCase())) return;
  values.push(packageName);
}

async function writeJsonObject(file: string, value: JsonRecord): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * 将已安装插件显式声明到隔离副本。Target 可能只由 effective-config 声明插件，
 * 也可能同时有 DSH Profile 的 profile.json；两处都存在时保持一致并去重。
 */
export async function declarePluginsInTarget(
  stagedSourceRoot: string,
  dshHome: string,
  profile: string,
  plugins: readonly ResolvedPlugin[],
): Promise<void> {
  const packageNames = [...new Set(plugins.map((plugin) => plugin.packageName))];
  if (packageNames.length === 0) return;

  const effectiveConfigPath = path.join(stagedSourceRoot, "effective-config.json");
  const effectiveConfig = await readJsonObject(effectiveConfigPath);
  if (effectiveConfig === undefined) {
    throw new Error("plugin target is missing effective-config.json");
  }
  const configuredProfile = asObject(effectiveConfig.profile) ?? {};
  const configuredPlugins = Array.isArray(configuredProfile.plugins)
    ? [...configuredProfile.plugins]
    : [];
  for (const packageName of packageNames) appendPlugin(configuredPlugins, packageName);
  effectiveConfig.profile = {
    ...configuredProfile,
    plugins: configuredPlugins,
  };
  await writeJsonObject(effectiveConfigPath, effectiveConfig);

  const profileDirectories = [
    path.join(dshHome, "profiles", profile),
    path.join(dshHome, "profile", profile),
    path.join(dshHome, profile),
  ];
  for (const directory of profileDirectories) {
    const profileFile = path.join(directory, "profile.json");
    const profileConfig = await readJsonObject(profileFile);
    if (profileConfig === undefined) continue;
    const profilePlugins = Array.isArray(profileConfig.plugins)
      ? [...profileConfig.plugins]
      : [];
    for (const packageName of packageNames) appendPlugin(profilePlugins, packageName);
    await writeJsonObject(profileFile, { ...profileConfig, plugins: profilePlugins });
    break;
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function rankOf(plugin: CatalogPlugin, index: number): number {
  const rank = typeof plugin.rank === "number" && Number.isFinite(plugin.rank)
    ? plugin.rank
    : typeof plugin.totalRank === "number" && Number.isFinite(plugin.totalRank)
      ? plugin.totalRank
      : index + 1;
  return rank > 0 ? rank : index + 1;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function pluginMatches(plugin: CatalogPlugin, query: string, exactOnly: boolean): boolean {
  const normalizedQuery = normalize(query);
  const values = [
    nonEmptyString(plugin.name),
    nonEmptyString(plugin.fullName),
    nonEmptyString(record(plugin.install)?.packageName),
    ...(Array.isArray(plugin.tags)
      ? plugin.tags.filter((value): value is string => typeof value === "string")
      : []),
    ...(Array.isArray(plugin.topics)
      ? plugin.topics.filter((value): value is string => typeof value === "string")
      : []),
  ]
    .filter((value): value is string => value !== undefined)
    .map(normalize);
  if (values.some((value) => value === normalizedQuery)) return true;
  if (exactOnly) return false;
  const description = nonEmptyString(plugin.description);
  return values.some((value) => value.includes(normalizedQuery)) ||
    (description !== undefined && normalize(description).includes(normalizedQuery));
}

/** 模糊搜索相关度：名称/包名优先，仓库名其次，标签和描述最后。 */
function pluginMatchScore(plugin: CatalogPlugin, query: string): number {
  const needle = normalize(query);
  const name = normalize(nonEmptyString(plugin.name) ?? "");
  const fullName = normalize(nonEmptyString(plugin.fullName) ?? "");
  const packageName = normalize(nonEmptyString(record(plugin.install)?.packageName) ?? "");
  if (name === needle || packageName === needle) return 0;
  if (name.startsWith(needle) || packageName.startsWith(needle)) return 1;
  if (name.includes(needle) || packageName.includes(needle)) return 2;
  if (fullName.startsWith(needle) || fullName.includes(needle)) return 3;
  const tags = [
    ...(Array.isArray(plugin.tags) ? plugin.tags.filter((value): value is string => typeof value === "string") : []),
    ...(Array.isArray(plugin.topics) ? plugin.topics.filter((value): value is string => typeof value === "string") : []),
  ].map(normalize);
  if (tags.some((value) => value === needle || value.startsWith(needle))) return 4;
  if (tags.some((value) => value.includes(needle))) return 5;
  const description = normalize(nonEmptyString(plugin.description) ?? "");
  return description.includes(needle) ? 6 : 99;
}

function normalizeInstallTarget(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let target = value.trim();
  if (
    (target.startsWith("\"") && target.endsWith("\"")) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }
  if (
    target.length === 0 ||
    target.length > 2048 ||
    target.startsWith("-") ||
    /[\s|&;<>()$`\\'"!*?]/u.test(target)
  ) {
    return undefined;
  }
  const githubUrl = /^https?:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100})(?:\.git)?$/iu.exec(target);
  if (githubUrl !== null) return `github:${githubUrl[1]!.toLowerCase()}`;
  const githubSsh = /^git@github\.com:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100})(?:\.git)?$/iu.exec(target);
  if (githubSsh !== null) return `github:${githubSsh[1]!.toLowerCase()}`;
  if (/^github:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}(?:#[A-Za-z0-9._~+/:=-]+)?$/u.test(target)) {
    return target.toLowerCase();
  }
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}(?:#[A-Za-z0-9._~+/:=-]+)?$/u.test(target)) {
    return `github:${target.toLowerCase()}`;
  }
  if (/^(?:@[a-z0-9-~][a-z0-9._~-]*\/)?[a-z0-9-~][a-z0-9._~-]*(?:@[a-z0-9][a-z0-9._+-]*)?$/iu.test(target)) {
    return target;
  }
  return undefined;
}

function commandInstallTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[\r\n]/u.test(value)) return undefined;
  const command = value
    .trim()
    .replace(/^[$>]\s+/u, "")
    .replace(/\s+#.*$/u, "")
    .trim();
  const match = /^(?:(?:npx)(?:\s+(?:--yes|-y))?\s+['"]?@deepseek-ai\/dsh(?:@[A-Za-z0-9][A-Za-z0-9._+-]*)?['"]?|dsh)\s+plugin(?:\s+--profile(?:=|\s+)[A-Za-z0-9][A-Za-z0-9._-]*)?\s+add\s+(.+)$/u.exec(command);
  return match === null ? undefined : normalizeInstallTarget(match[1]);
}

function recognizedInstall(plugin: CatalogPlugin): {
  readonly packageName: string;
  readonly method: string;
  readonly version?: string;
} | undefined {
  const install = record(plugin.install) as CatalogInstall | undefined;
  const fullName = nonEmptyString(plugin.fullName);
  const packageName = nonEmptyString(install?.packageName);
  if (fullName === undefined) return undefined;
  const targets: string[] = [];
  const direct = normalizeInstallTarget(plugin.installTarget);
  if (direct !== undefined) targets.push(direct);
  const commands = install?.commands;
  if (Array.isArray(commands)) {
    for (const command of commands) {
      const target = commandInstallTarget(command);
      if (target !== undefined) targets.push(target);
    }
  }
  const githubTarget = targets.find((target) =>
    target.toLowerCase().split("#", 1)[0] === `github:${fullName.toLowerCase()}`,
  );
  const packageTarget = packageName === undefined ? undefined : targets.find((target) => {
    const targetPackage = target.match(/^(@?[a-z0-9-~][a-z0-9._~-]*(?:\/[a-z0-9-~][a-z0-9._~-]*)?)(?:@[a-z0-9][a-z0-9._+-]*)?$/iu)?.[1];
    return targetPackage?.toLowerCase() === packageName.toLowerCase();
  });
  const target = githubTarget ?? packageTarget;
  if (target === undefined) return undefined;
  const method = nonEmptyString(install?.method) ?? "site-command";
  const version = nonEmptyString(install?.version);
  return Object.freeze({
    packageName: target,
    method,
    ...(version === undefined ? {} : { version }),
  });
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`evaldock.ai plugin catalog returned HTTP ${response.status}`);
  return await response.json() as unknown;
}

/** Windows Node fetch 可能不走系统代理；使用 PowerShell 的系统网络栈做只读回退。 */
async function fetchJsonWithPowerShell(url: string): Promise<unknown> {
  if (process.platform !== "win32") throw new Error("PowerShell catalog fallback is only available on Windows");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Out.Write((Invoke-WebRequest -UseBasicParsing -Uri $env:EVALDOCK_PLUGIN_URL).Content)",
    ],
    {
      env: { ...process.env, EVALDOCK_PLUGIN_URL: url },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes < MAX_CATALOG_BYTES) {
      const accepted = chunk.subarray(0, MAX_CATALOG_BYTES - stdoutBytes);
      stdout.push(accepted);
      stdoutBytes += accepted.byteLength;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes < MAX_PROCESS_OUTPUT_BYTES) {
      const accepted = chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - stderrBytes);
      stderr.push(accepted);
      stderrBytes += accepted.byteLength;
    }
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, FETCH_TIMEOUT_MS);
  const result = await new Promise<{ readonly code: number | null; readonly error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({
      code,
      ...(timedOut ? { error: new Error("PowerShell catalog request timed out") } : {}),
    }));
  });
  clearTimeout(timer);
  if (result.error !== undefined) throw result.error;
  if (result.code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").replaceAll(/[\r\n\t]+/gu, " ").trim();
    throw new Error(`PowerShell could not read evaldock.ai plugin catalog${detail.length === 0 ? "" : `: ${detail.slice(0, 512)}`}`);
  }
  try {
    return JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("PowerShell returned invalid evaldock.ai plugin catalog JSON", { cause: error });
  }
}

async function fetchWithTimeout(url: string): Promise<unknown> {
  if (
    process.platform === "win32" &&
    /^https?:\/\//iu.test(url) &&
    globalThis.fetch === nativeFetch
  ) {
    try {
      return await fetchJsonWithPowerShell(url);
    } catch {
      // Fall through to Node fetch so callers still get the normal HTTP error path.
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchJson(url, controller.signal);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof TypeError && process.platform === "win32")) {
      try {
        return await fetchJsonWithPowerShell(url);
      } catch (fallbackError) {
        if (controller.signal.aborted) {
          throw new Error("evaldock.ai plugin catalog request timed out (Node fetch and PowerShell fallback failed)", {
            cause: fallbackError,
          });
        }
        throw fallbackError;
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function catalogEntries(registryUrl: string): Promise<readonly CatalogPlugin[]> {
  const manifest = record(await fetchWithTimeout(registryUrl)) as CatalogManifest | undefined;
  const datasets = record(manifest?.datasets);
  const searchUrl = nonEmptyString(datasets?.search && record(datasets.search)?.url);
  if (searchUrl === undefined) throw new Error("evaldock.ai plugin catalog has no search dataset URL");
  const resolvedSearchUrl = new URL(searchUrl, registryUrl).href;
  const decode = (value: unknown): readonly CatalogPlugin[] | undefined => {
    const rankings = record(value)?.rankings;
    if (!Array.isArray(rankings)) return undefined;
    return Object.freeze(rankings
      .map((item) => record(item))
      .filter((item): item is JsonRecord => item !== undefined));
  };
  const current = decode(await fetchWithTimeout(resolvedSearchUrl));
  if (current === undefined) throw new Error("evaldock.ai plugin search dataset is invalid");
  // 当前快照的轻量搜索索引可能不带 install；兼容索引仍包含网站已识别安装源。
  if (current.every((plugin) => record(plugin.install) !== undefined)) return current;
  const legacyUrl = new URL("/data/rankings-search.json", registryUrl).href;
  const legacy = decode(await fetchWithTimeout(legacyUrl));
  if (legacy === undefined) throw new Error("evaldock.ai legacy plugin search dataset is invalid");
  const legacyByName = new Map(
    legacy
      .map((plugin) => [normalize(nonEmptyString(plugin.fullName) ?? ""), plugin] as const)
      .filter(([name]) => name.length > 0),
  );
  return Object.freeze(current.map((plugin) => {
    if (record(plugin.install) !== undefined) return plugin;
    const fullName = nonEmptyString(plugin.fullName);
    const fallback = fullName === undefined ? undefined : legacyByName.get(normalize(fullName));
    return fallback === undefined ? plugin : Object.freeze({ ...plugin, install: fallback.install });
  }));
}

/**
 * 按网站当前搜索索引解析输入。CLI/安装流程只接受规范名称的精确匹配；
 * 模糊搜索仅由 searchPlugins 提供给可视化选择界面。
 */
export async function resolvePlugins(
  names: readonly string[],
  options: { readonly registryUrl?: string } = {},
): Promise<PluginSelection> {
  const requested = names
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return Object.freeze({ plugins: Object.freeze([]), installCommands: Object.freeze([]) });
  }
  const entries = await catalogEntries(options.registryUrl ?? process.env.EVALDOCK_PLUGIN_REGISTRY_URL ?? DEFAULT_REGISTRY_URL);
  const selected: ResolvedPlugin[] = [];
  const seen = new Set<string>();
  for (const input of requested) {
    if (input.length > 256 || input.includes("\0") || /[\r\n]/u.test(input)) {
      throw new Error(`plugin name is invalid: ${input.slice(0, 64)}`);
    }
    const exact = entries
      .map((plugin, index) => ({ plugin, index }))
      .filter(({ plugin }) => pluginMatches(plugin, input, true));
    const candidates = exact
      .sort((left, right) => rankOf(left.plugin, left.index) - rankOf(right.plugin, right.index));
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error(`plugin name must exactly match a evaldock.ai plugin: ${input}`);
    const fullName = nonEmptyString(candidate.plugin.fullName) ?? nonEmptyString(candidate.plugin.name);
    const name = nonEmptyString(candidate.plugin.name) ?? fullName;
    if (fullName === undefined || name === undefined) {
      throw new Error(`evaldock.ai plugin result is missing its name: ${input}`);
    }
    const install = recognizedInstall(candidate.plugin);
    if (install === undefined) {
      throw new Error(`plugin has no recognized install source on evaldock.ai: ${name}`);
    }
    const packageSpec = install.version === undefined
      ? install.packageName
      : `${install.packageName}@${install.version}`;
    const description = nonEmptyString(candidate.plugin.description);
    if (!seen.has(packageSpec)) {
      seen.add(packageSpec);
      selected.push(Object.freeze({
        input,
        rank: rankOf(candidate.plugin, candidate.index),
        fullName,
        name,
        packageName: packageSpec,
        installMethod: install.method,
        ...(description === undefined ? {} : { description }),
      }));
    }
  }
  const profilePlaceholder = "{profile}";
  const packagePlaceholder = "{package}";
  const installCommands = selected.map((plugin) =>
    `npx --yes ${DEFAULT_DSH_PACKAGE} plugin --profile ${profilePlaceholder} add ${packagePlaceholder}`
      .replace(packagePlaceholder, plugin.packageName),
  );
  return Object.freeze({
    plugins: Object.freeze(selected),
    installCommands: Object.freeze(installCommands),
  });
}

function processCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function boundedOutput(chunks: Buffer[], current: number, chunk: Buffer): number {
  if (current >= MAX_PROCESS_OUTPUT_BYTES) return current;
  const accepted = chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - current);
  chunks.push(accepted);
  return current + accepted.byteLength;
}

async function runInstallCommand(
  packageName: string,
  profile: string,
  cwd: string,
  dshHome: string,
): Promise<void> {
  const args = [
    "--yes",
    process.env.EVALDOCK_DSH_PACKAGE ?? DEFAULT_DSH_PACKAGE,
    "plugin",
    "--profile",
    profile,
    "add",
    packageName,
  ];
  const inheritedEnvironment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOME",
    "LANG",
  ]) {
    const value = process.env[name];
    if (value !== undefined) inheritedEnvironment[name] = value;
  }
  const child = spawn(processCommand(), args, {
    cwd,
    env: {
      ...inheritedEnvironment,
      DSH_HOME: dshHome,
      CI: "1",
      NPM_CONFIG_YES: "true",
      NPM_CONFIG_CACHE: path.join(dshHome, "npm-cache"),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = boundedOutput(stdout, stdoutBytes, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes = boundedOutput(stderr, stderrBytes, chunk); });
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const result = await new Promise<{ readonly code: number | null; readonly error?: Error }>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({
      code,
      ...(timedOut ? { error: new Error("plugin install command timed out") } : {}),
    }));
  });
  if (timeout !== undefined) clearTimeout(timeout);
  if (result.error !== undefined) throw result.error;
  if (result.code !== 0) {
    const detail = Buffer.concat([...stdout, ...stderr]).toString("utf8").replaceAll(/[\r\n\t]+/gu, " ").trim();
    throw new Error(`plugin install failed for ${packageName}${detail.length === 0 ? "" : `: ${detail.slice(0, 512)}`}`);
  }
}

/**
 * 复制 Target、在副本中逐个安装插件并返回新的 descriptor。没有插件时不创建副本。
 */
export async function preparePluginTarget(
  descriptor: TargetDescriptor,
  pluginNames: readonly string[],
): Promise<PreparedPluginTarget | undefined> {
  if (descriptor.webEndpoint !== undefined) throw new Error("Real Web targets must use prepareRealDshTarget; copied plugin targets are not supported");
  const selection = await resolvePlugins(pluginNames);
  if (selection.plugins.length === 0) return undefined;
  const sourceMetadata = await lstat(descriptor.sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("Target sourceRoot must be a real directory before plugin installation");
  }
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "evaldock-plugin-target-"));
  const stagedSourceRoot = path.join(stagingRoot, "target");
  try {
    await cp(descriptor.sourceRoot, stagedSourceRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    const stagedDshHome = path.resolve(stagedSourceRoot, descriptor.dshHome);
    for (const plugin of selection.plugins) {
      await runInstallCommand(
        plugin.packageName,
        descriptor.profile,
        stagedSourceRoot,
        stagedDshHome,
      );
    }
    await declarePluginsInTarget(
      stagedSourceRoot,
      stagedDshHome,
      descriptor.profile,
      selection.plugins,
    );
    const { contentDigest: _contentDigest, ...descriptorWithoutDigest } = descriptor;
    const stagedDescriptor = withContentDigest({
      ...descriptorWithoutDigest,
      sourceRoot: stagedSourceRoot,
    }) as TargetDescriptor;
    let cleaned = false;
    return {
      descriptor: stagedDescriptor,
      selection,
      stagingRoot,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(stagingRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
