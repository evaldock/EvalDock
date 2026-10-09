/**
 * 文件职责：在 Agent 启动前验证身份、目录、网络和任务边界，并签发只读观测授权。
 *
 * 核心流程：解析 Controller/Target OS 身份，实测平台身份降权和目录访问，探测冻结
 * 网络策略，汇总 SecurityPreflight；随后为指定 Environment/SourceRequirement 生成
 * 进程内 Observer Binding，并在发布前扫描任务或结果中的敏感内容。
 *
 * 与其他文件的交互：`app/workflow.ts` 调用本文件；身份启动参数契约来自 core，
 * Observation 消费 PreparedObserverBinding，Runtime 使用预检确认的 Target UID/GID。
 *
 * 公开接口：身份/预检/Binding 类型、runSecurityPreflight、issueObserverBinding、
 * assertSafeAgentTask 和 findSecretLeaks。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";

import {
  identityLaunchCommand,
} from "../core/contracts.js";

import {
  digestValue,
  type PreparedObserverBinding,
  validateContentDigest,
  validateIsoDateTime,
  validateStableId,
  validateVersionedAssetId,
} from "../core/models.js";

/** Promise 版本的 execFile，仅用于固定路径的 OS 身份查询。 */
const execFileAsync = promisify(execFile);

/** 已解析的 POSIX 用户名及 UID/GID。 */
export interface OsIdentity {
  name: string;
  uid: number;
  gid: number;
}

/** 一项可直接展示和持久化的安全检查结果。 */
export interface SecurityCheck {
  name: string;
  status: "PASS" | "FAIL" | "FIXTURE_LIMITATION";
  detail: string;
}

/** 一次安全预检的聚合结果，Workflow 据此决定是否允许启动 Agent。 */
export interface SecurityPreflightResult {
  status: "PASSED" | "FAILED" | "FIXTURE_ONLY";
  targetIdentity?: OsIdentity;
  observerIdentity: OsIdentity;
  judgeIdentity: OsIdentity;
  checks: readonly SecurityCheck[];
  isolationLevel: "AGENT_SEPARATED" | "SESSION_SEPARATED" | "PROCESS_FIXTURE";
  networkPolicyVerified: boolean;
  telemetryDisabled: boolean;
}

/** Observer 的公共授权记录与仅在进程内存在的宿主 workspace 路径。 */
export interface PreparedObserverBindingRuntime {
  binding: PreparedObserverBinding;
  /** Host path is process-only and never part of the public Binding. */
  workspacePath: string;
}

/** 通过系统 id 命令把冻结用户名解析为数值身份。 */
async function identityByName(name: string): Promise<OsIdentity> {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error("invalid OS identity name");
  const [{ stdout: uidText }, { stdout: gidText }] = await Promise.all([
    execFileAsync("/usr/bin/id", ["-u", name], { encoding: "utf8" }),
    execFileAsync("/usr/bin/id", ["-g", name], { encoding: "utf8" }),
  ]);
  const uid = Number.parseInt(uidText.trim(), 10);
  const gid = Number.parseInt(gidText.trim(), 10);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new Error(`identity ${name} did not resolve to numeric uid/gid`);
  }
  return { name, uid, gid };
}

/** 读取当前 Controller 的真实 UID/GID 和可用用户名。 */
async function currentIdentity(): Promise<OsIdentity> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("POSIX identity APIs unavailable");
  let name = `uid-${uid}`;
  try {
    name = (await execFileAsync("/usr/bin/id", ["-un"], { encoding: "utf8" })).stdout.trim();
  } catch {
    // Numeric identity is still an observed fact; the name remains explicit.
  }
  return { name, uid, gid };
}

/** 使用与正式 Target 相同的受限启动器实测某身份的路径读写权限。 */
async function accessAs(identity: OsIdentity, target: string, mode: "read" | "write"): Promise<boolean> {
  const flag = mode === "read" ? "-r" : "-w";
  const launch = identityLaunchCommand(
    process.platform,
    identity.uid,
    identity.gid,
    "/usr/bin/test",
    [flag, target],
  );
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      launch.executablePath,
      launch.argv,
      {
        shell: false,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code === 0));
  });
}

/** 启动最小 Node 探针；Linux 额外验证能力集和 NoNewPrivs，macOS 验证实际 UID/GID。 */
async function verifyIdentityDrop(identity: OsIdentity): Promise<{
  ok: boolean;
  detail: string;
}> {
  const portableChecks = [
    "const [uidText, gidText] = process.argv.slice(1);",
    "const uid = Number(uidText); const gid = Number(gidText);",
    "if (process.getuid?.() !== uid || process.geteuid?.() !== uid) process.exit(10);",
    "if (process.getgid?.() !== gid || process.getegid?.() !== gid) process.exit(11);",
  ];
  const linuxChecks = [
    'import { readFileSync } from "node:fs";',
    "if ((process.getgroups?.() ?? []).some((group) => group !== gid)) process.exit(12);",
    'const status = readFileSync("/proc/self/status", "utf8");',
    'const field = (name) => status.match(new RegExp(`^${name}:\\\\s*(.+)$`, "m"))?.[1]?.trim();',
    'const uidColumns = (field("Uid") ?? "").split(/\\s+/).map(Number);',
    'if (uidColumns.length !== 4 || uidColumns.some((value) => value !== uid)) process.exit(15);',
    'const gidColumns = (field("Gid") ?? "").split(/\\s+/).map(Number);',
    'if (gidColumns.length !== 4 || gidColumns.some((value) => value !== gid)) process.exit(16);',
    'for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {',
    '  if (!/^0+$/.test(field(name) ?? "")) process.exit(13);',
    "}",
    'if (field("NoNewPrivs") !== "1") process.exit(14);',
  ];
  const program = [
    ...(process.platform === "linux" ? linuxChecks.slice(0, 1) : []),
    ...portableChecks,
    ...(process.platform === "linux" ? linuxChecks.slice(1) : []),
  ].join("");
  const launch = identityLaunchCommand(process.platform, identity.uid, identity.gid, process.execPath, [
    "--input-type=module",
    "-e",
    program,
    String(identity.uid),
    String(identity.gid),
  ]);
  return await new Promise((resolve) => {
    let settled = false;
    /** 保证身份探针的 error/close/timeout 路径只结算一次。 */
    const settle = (result: { ok: boolean; detail: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(launch.executablePath, launch.argv, {
      shell: false,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    child.once("error", (error) => {
      settle({ ok: false, detail: `identity launcher error: ${error.message}` });
    });
    child.once("close", (code) => {
      const failureDetails: Readonly<Record<number, string>> = {
        10: "launched process real/effective uid did not match dshagent",
        11: "launched process real/effective gid did not match dshagent",
        12: "launched process retained an unexpected supplementary group",
        13: "launched process retained an inheritable, permitted, effective, or ambient capability",
        14: "launched process did not have no_new_privs enabled",
        15: "launched process real/effective/saved/filesystem uid did not match dshagent",
        16: "launched process real/effective/saved/filesystem gid did not match dshagent",
        126: "identity launcher could not invoke the verification process",
        127: "identity launcher could not apply the required privilege transition",
      };
      settle({
        ok: code === 0,
        detail: code === 0
          ? process.platform === "linux"
            ? "uid/gid switch, supplementary-group clearing, capability drop, and no_new_privs verified"
            : "macOS real/effective uid and gid switch verified"
          : failureDetails[code ?? -1] ?? `identity verification exited with code ${code ?? "signal"}`,
      });
    });
  });
}

/** 以 Target 身份尝试 TCP 连接，用于验证允许端点和默认拒绝样本。 */
async function tcpConnectAs(
  identity: OsIdentity,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const program = [
    'import net from "node:net";',
    "const [host, portText, timeoutText] = process.argv.slice(1);",
    "const socket = net.createConnection({host, port: Number(portText)});",
    "const done = (code) => { socket.destroy(); process.exit(code); };",
    "socket.setTimeout(Number(timeoutText), () => done(1));",
    "socket.once('connect', () => done(0));",
    "socket.once('error', () => done(1));",
  ].join("");
  const launch = identityLaunchCommand(process.platform, identity.uid, identity.gid, process.execPath, [
    "--input-type=module",
    "-e",
    program,
    host,
    String(port),
    String(timeoutMs),
  ]);
  return await new Promise<boolean>((resolve) => {
    const child = spawn(
      launch.executablePath,
      launch.argv,
      {
        shell: false,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/**
 * 执行 Agent 启动门禁。Workflow 在 Environment/Run 创建后、Target 启动前调用。
 */
export async function runSecurityPreflight(input: {
  deniedRoots: readonly string[];
  allowedRoots: readonly string[];
  expectedFrameworkIdentity?: string;
  expectedTargetIdentity?: string;
  allowedModelEndpoints?: readonly string[];
  allowFixtureIdentity?: boolean;
  allowSessionIdentity?: boolean;
}): Promise<SecurityPreflightResult> {
  const checks: SecurityCheck[] = [];
  const observerIdentity = await currentIdentity();

  if (input.allowFixtureIdentity === true) {
    checks.push({
      name: "os-identity-separation",
      status: "FIXTURE_LIMITATION",
      detail: "Explicit test fixture uses the current identity and is not a production security pass",
    });
    return {
      status: "FIXTURE_ONLY",
      targetIdentity: observerIdentity,
      observerIdentity,
      judgeIdentity: observerIdentity,
      checks,
      isolationLevel: "PROCESS_FIXTURE",
      networkPolicyVerified: false,
      telemetryDisabled: false,
    };
  }

  if (input.allowSessionIdentity === true) {
    checks.push({
      name: "session-isolation",
      status: "PASS",
      detail: "Each Case starts a new Headless process and conversation under the controller identity",
    });
    return {
      status: "PASSED",
      targetIdentity: observerIdentity,
      observerIdentity,
      judgeIdentity: observerIdentity,
      checks,
      isolationLevel: "SESSION_SEPARATED",
      networkPolicyVerified: false,
      telemetryDisabled: true,
    };
  }

  let targetIdentity: OsIdentity | undefined;
  try {
    const expectedFrameworkIdentity = input.expectedFrameworkIdentity ?? "evaldock";
    if (observerIdentity.name !== expectedFrameworkIdentity) {
      throw new Error(
        `framework runs as ${observerIdentity.name}; expected ${expectedFrameworkIdentity}`,
      );
    }
    targetIdentity = await identityByName(input.expectedTargetIdentity ?? "dshagent");
    if (targetIdentity.uid === observerIdentity.uid) {
      throw new Error("framework and target resolve to the same uid");
    }
    checks.push({ name: "os-identity-separation", status: "PASS", detail: "distinct uids verified" });
  } catch (error) {
    checks.push({
      name: "os-identity-separation",
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (targetIdentity !== undefined) {
    const identityDrop = await verifyIdentityDrop(targetIdentity);
    checks.push({
      name: "target-privilege-drop",
      status: identityDrop.ok ? "PASS" : "FAIL",
      detail: identityDrop.detail,
    });
  } else {
    checks.push({
      name: "target-privilege-drop",
      status: "FAIL",
      detail: "target identity was unavailable for the controlled identity launcher",
    });
  }

  const deniedRoots = [...new Set([
    ...input.deniedRoots,
    os.homedir(),
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/etc/sudoers",
  ])];
  for (const root of deniedRoots) {
    try {
      const resolved = await realpath(root);
      const denied =
        targetIdentity !== undefined &&
        !(await accessAs(targetIdentity, resolved, "read")) &&
        !(await accessAs(targetIdentity, resolved, "write"));
      checks.push({
        name: `target-denied:${path.basename(root)}`,
        status: denied ? "PASS" : "FAIL",
        detail: denied ? "target cannot read or write root" : "target access was not reliably denied",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        checks.push({
          name: `target-denied:${path.basename(root)}`,
          status: "PASS",
          detail: "denied path is absent and therefore inaccessible",
        });
        continue;
      }
      checks.push({
        name: `target-denied:${path.basename(root)}`,
        status: "FAIL",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const root of input.allowedRoots) {
    try {
      const resolved = await realpath(root);
      const metadata = await lstat(resolved);
      const usable =
        metadata.isDirectory() &&
        targetIdentity !== undefined &&
        (await accessAs(targetIdentity, resolved, "read")) &&
        (await accessAs(targetIdentity, resolved, "write"));
      checks.push({
        name: `target-allowed:${path.basename(root)}`,
        status: usable ? "PASS" : "FAIL",
        detail: usable ? "target can read and write allowed root" : "target cannot use allowed root",
      });
    } catch (error) {
      checks.push({
        name: `target-allowed:${path.basename(root)}`,
        status: "FAIL",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let networkPolicyVerified = false;
  if (targetIdentity !== undefined) {
    const allowedEndpoints = (input.allowedModelEndpoints ?? []).map((endpoint) => new URL(endpoint));
    const allowedResults = await Promise.all(
      allowedEndpoints.map(async (endpoint) => ({
        endpoint,
        connected: await tcpConnectAs(
          targetIdentity!,
          endpoint.hostname,
          endpoint.port === "" ? 443 : Number(endpoint.port),
          1_500,
        ),
      })),
    );
    const allowedHosts = new Set(allowedEndpoints.map((endpoint) => endpoint.hostname));
    const denyCandidates = [
      { host: "1.1.1.1", port: 443 },
      { host: "8.8.8.8", port: 443 },
      { host: "example.com", port: 443 },
    ].filter((candidate) => !allowedHosts.has(candidate.host));
    const deniedResults = await Promise.all(
      denyCandidates.map(async (candidate) => ({
        ...candidate,
        connected: await tcpConnectAs(targetIdentity!, candidate.host, candidate.port, 1_500),
      })),
    );
    networkPolicyVerified =
      allowedResults.every((result) => result.connected) &&
      deniedResults.every((result) => !result.connected);
    checks.push({
      name: "network-default-deny",
      status: networkPolicyVerified ? "PASS" : "FAIL",
      detail: networkPolicyVerified
        ? "configured model endpoints were reachable and disallowed egress probes were blocked"
        : "allowed endpoint reachability or default-deny negative probes did not match the frozen policy",
    });
  } else {
    checks.push({
      name: "network-default-deny",
      status: "FAIL",
      detail: "target identity was unavailable for network policy probes",
    });
  }

  return {
    status: checks.every((check) => check.status === "PASS") ? "PASSED" : "FAILED",
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
    observerIdentity,
    judgeIdentity: observerIdentity,
    checks,
    isolationLevel: "AGENT_SEPARATED",
    networkPolicyVerified,
    telemetryDisabled: true,
  };
}

/**
 * 将冻结 SourceRequirement 与当前 Environment 绑定为短期只读能力；Workflow 在
 * CASE_RUN 与 POST_RESET 两次观测前分别调用。
 */
export async function issueObserverBinding(input: {
  environmentInstanceId: string;
  resetGeneration: number;
  sourceRequirementId: string;
  resourceBinding: string;
  sensorImplementationId: string;
  sensorImplementationVersion: string;
  sensorCapabilityDigest: PreparedObserverBinding["sensorCapabilityDigest"];
  expiresAt: string;
  workspacePath: string;
}): Promise<PreparedObserverBindingRuntime> {
  if (!Number.isSafeInteger(input.resetGeneration) || input.resetGeneration < 0) {
    throw new Error("resetGeneration must be a non-negative safe integer");
  }
  if (
    input.resourceBinding.length === 0 ||
    input.sensorImplementationVersion.length === 0 ||
    input.resourceBinding.includes("\0") ||
    input.sensorImplementationVersion.includes("\0")
  ) {
    throw new Error("observer resource binding and sensor version must be non-empty and NUL-free");
  }
  validateContentDigest(input.sensorCapabilityDigest, "sensorCapabilityDigest");
  const expiresAt = validateIsoDateTime(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.now()) throw new Error("observer binding expiration must be future");
  const workspaceInputMetadata = await lstat(input.workspacePath);
  if (!workspaceInputMetadata.isDirectory() || workspaceInputMetadata.isSymbolicLink()) {
    throw new Error("observer workspace must be a real directory");
  }
  const resolved = await realpath(input.workspacePath);
  await access(resolved, constants.R_OK);
  const token = randomBytes(32).toString("base64url");
  const grantMaterial = {
    bindingId: validateStableId<"PreparedObserverBindingId">(`binding-${randomUUID()}`),
    environmentInstanceId: validateStableId<"EnvironmentInstanceId">(
      input.environmentInstanceId,
    ),
    resetGeneration: input.resetGeneration,
    sourceRequirementId: validateVersionedAssetId<"SourceRequirementId">(
      input.sourceRequirementId,
      "sourceRequirementId",
    ),
    resourceBinding: input.resourceBinding,
    sensorImplementationId: validateStableId<"SensorImplementationId">(
      input.sensorImplementationId,
    ),
    sensorImplementationVersion: input.sensorImplementationVersion,
    sensorCapabilityDigest: input.sensorCapabilityDigest,
    allowedOperations: ["READ", "SNAPSHOT", "DRAIN"] as const,
    expiresAt,
  };
  const binding: PreparedObserverBinding = {
    ...grantMaterial,
    grantDigest: digestValue(grantMaterial),
    readCapabilityToken: token,
  };
  return {
    binding,
    workspacePath: resolved,
  };
}

/** 扫描 AgentTask，拒绝隐藏答案术语、Secret 或管理目录路径进入被测输入。 */
export function assertSafeAgentTask(
  task: string,
  forbiddenValues: readonly string[],
): void {
  const lowered = task.toLowerCase();
  const reservedTerms = ["ground truth", "evidencecontract", "artifactroot", "reportroot"];
  if (reservedTerms.some((term) => lowered.includes(term))) {
    throw new Error("AgentTask contains a reserved management term");
  }
  for (const forbidden of forbiddenValues) {
    if (forbidden.length > 0 && task.includes(forbidden)) {
      throw new Error("AgentTask contains hidden or sensitive material");
    }
  }
}

/** 返回出现在字节流中的 Secret canary 值；Workflow 决定拒绝或受限隔离。 */
export function findSecretLeaks(bytes: Uint8Array, canaries: readonly string[]): readonly string[] {
  const text = Buffer.from(bytes).toString("utf8");
  return canaries.filter((canary) => canary.length > 0 && text.includes(canary));
}
