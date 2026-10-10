import { prepareInputLaunch, type InputDeliveryReceipt } from "./input-delivery.js";
import type { CaseInputFile } from "../datasets/loader.js";
/**
 * 文件职责：以冻结的命令、身份和环境约束启动目标程序，限额收集输出，并归一化终止结果。
 * 核心流程：校验执行请求，构建最小环境与平台身份启动参数，启动独立进程组，处理回执、取消和超时，最后汇总退出状态及有界输出。
 * 与其他文件的真实交互：使用 core/contracts.ts 的 Linux/macOS 身份降权契约；由 app/workflow.ts 调用并将启动 PID、终止时间和结果写入运行投影及观察流程。
 * 公开接口：TargetTerminationKind、TargetExecutionRequest、TargetExecutionResult、executeTarget。
 */
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";

import {
  identityLaunchCommand,
} from "../core/contracts.js";

/** 将原始进程退出、用户取消、超时和执行器故障映射为工作流可判定的终止分类。 */
export type TargetTerminationKind =
  | "EXITED"
  | "TARGET_FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "HARNESS_ERROR";

/** app/workflow.ts 提交给目标执行器的冻结参数、资源上限与生命周期回调。 */
export interface TargetExecutionRequest {
  executablePath: string;
  profile: string;
  task: string;
  inputs?: readonly CaseInputFile[];
  cwd: string;
  runtimeDshHomePath: string;
  /** 可选的共享会话 Home；用于让 Headless Case 出现在常驻 Web UI。 */
  sessionDshHomePath?: string;
  probeOutputPath: string;
  sourceRunId: string;
  displayCase?: {runId:string;ordinal:number;name:string};
  /** Native Probe 内容保存策略；FULL 保留 SQL、命令参数和工具返回正文。 */
  contentMode: string;
  deadlineMs: number;
  maxOutputBytes: number;
  targetUid?: number;
  targetGid?: number;
  modelEnvironment?: Readonly<Record<string, string>>;
  fixtureBehavior?: string;
  signal?: AbortSignal;
  onStarted?: (pid: number) => Promise<void> | void;
}

/** 将 EvalDock 配置名映射为 Native Probe 接受的稳定值。 */
function probeContentMode(value: string): "full" | "hash" | "omit" {
  switch (value.toUpperCase()) {
    case "FULL": return "full";
    case "DIGEST": return "hash";
    case "OMIT": return "omit";
    default: throw new Error("contentMode must be FULL, DIGEST, or OMIT");
  }
}

/** 目标进程完成后返回给工作流的时间、退出信息及截断标记。 */
export interface TargetExecutionResult {
  inputDelivery?: InputDeliveryReceipt;
  terminationKind: TargetTerminationKind;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  pid?: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  errorMessage?: string;
}

/** 禁止模型配置覆盖的宿主、加载器和证据采集关键环境变量。 */
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
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

/** 校验将进入 argv 或路径处理的字符串；由 executeTarget 在启动前集中调用。 */
function assertArgument(value: string, name: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty NUL-free string`);
  }
}

/** 将 stdout/stderr 数据追加到固定字节预算内；由 executeTarget 的流监听器调用并返回累计长度与截断状态。 */
function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentLength: number,
  limit: number,
): { length: number; truncated: boolean } {
  if (currentLength >= limit) return { length: currentLength, truncated: true };
  const remaining = limit - currentLength;
  const accepted = chunk.subarray(0, remaining);
  chunks.push(accepted);
  return {
    length: currentLength + accepted.byteLength,
    truncated: accepted.byteLength !== chunk.byteLength,
  };
}

/** 从固定框架变量和受限模型变量构造子进程环境；由 executeTarget 在 spawn 前调用。 */
function buildEnvironment(request: TargetExecutionRequest): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: path.join(request.runtimeDshHomePath, "tmp"),
    DSH_HOME: request.sessionDshHomePath ?? request.runtimeDshHomePath,
    // EvalDock 自有 Native Probe 读取目录和 RunId；PROBE_OUTPUT 保留给
    // 旧线协议及 Fixture。Native 输出随后由适配器转换，不伪装成 DSH 内置能力。
    DSH_EVAL_OUTPUT_DIR: path.dirname(request.probeOutputPath),
    DSH_EVAL_RUN_ID: request.sourceRunId,
    DSH_EVAL_PROBE_OUTPUT: request.probeOutputPath,
    DSH_EVAL_SOURCE_RUN_ID: request.sourceRunId,
    DSH_EVAL_WORKSPACE: request.cwd,
    DSH_EVAL_CONTENT_MODE: probeContentMode(request.contentMode),
    DO_NOT_TRACK: "1",
    DSH_TELEMETRY_MODE: "DISABLED",
    DSH_TELEMETRY_DISABLED: "1",
  };
  for (const [name, value] of Object.entries(request.modelEnvironment ?? {})) {
    if (
      FORBIDDEN_ENVIRONMENT_NAMES.has(name) ||
      name.startsWith("DSH_EVAL_") ||
      name.startsWith("EVALDOCK_") ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(name) ||
      value.includes("\0")
    ) {
      throw new Error(`environment variable ${name} is not allowed`);
    }
    environment[name] = value;
  }
  if (request.fixtureBehavior !== undefined) {
    environment.EVALDOCK_FIXTURE_BEHAVIOR = request.fixtureBehavior;
  }
  return environment;
}

/** 向目标进程组发送终止信号并容忍进程已退出；由 executeTarget 的取消、超时和升级清理路径调用。 */
function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

/**
 * 执行冻结的 DSH 无头命令并返回有界结果；由 app/workflow.ts 调用，内部通过 spawn、启动回执和进程组信号协调目标生命周期。
 */
export async function executeTarget(
  request: TargetExecutionRequest,
): Promise<TargetExecutionResult> {
  assertArgument(request.executablePath, "executablePath");
  assertArgument(request.profile, "profile");
  assertArgument(request.task, "task");
  assertArgument(request.cwd, "cwd");
  assertArgument(request.runtimeDshHomePath, "runtimeDshHomePath");
  assertArgument(request.probeOutputPath, "probeOutputPath");
  assertArgument(request.sourceRunId, "sourceRunId");
  assertArgument(request.contentMode, "contentMode");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.profile)) {
    throw new Error("profile must be a StableId-like argv value");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.sourceRunId)) {
    throw new Error("sourceRunId must be a StableId");
  }
  for (const [name, value] of [
    ["executablePath", request.executablePath],
    ["cwd", request.cwd],
    ["runtimeDshHomePath", request.runtimeDshHomePath],
    ["probeOutputPath", request.probeOutputPath],
  ] as const) {
    if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  }
  if (request.sessionDshHomePath !== undefined && !path.isAbsolute(request.sessionDshHomePath)) {
    throw new Error("sessionDshHomePath must be absolute");
  }
  if (!Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= 0) {
    throw new Error("deadlineMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    throw new Error("maxOutputBytes must be a positive safe integer");
  }
  if ((request.targetUid === undefined) !== (request.targetGid === undefined)) {
    throw new Error("targetUid and targetGid must be supplied together");
  }
  for (const [name, value] of [
    ["targetUid", request.targetUid],
    ["targetGid", request.targetGid],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  const fixtureExecution = request.fixtureBehavior !== undefined;
  const sessionSeparatedExecution = request.sessionDshHomePath !== undefined;
  if (!fixtureExecution && !sessionSeparatedExecution) {
    if (request.targetUid === undefined || request.targetGid === undefined) {
      throw new Error("formal target execution requires the frozen dshagent uid and gid");
    }
    if (process.getuid?.() === request.targetUid) {
      throw new Error("formal target execution requires a uid distinct from evaldock");
    }
    const stagedRelative = path.relative(request.runtimeDshHomePath, request.executablePath);
    if (
      path.isAbsolute(stagedRelative) ||
      stagedRelative === "" ||
      stagedRelative.startsWith(`..${path.sep}`) ||
      stagedRelative.split(path.sep)[0] !== "target-runtime"
    ) {
      throw new Error("formal target executable must be staged inside its Runtime Home");
    }
  }
  if (sessionSeparatedExecution && (request.targetUid !== undefined || request.targetGid !== undefined)) {
    throw new Error("session-separated execution must run under the controller identity");
  }

  const startedAt = new Date().toISOString();
  if (request.signal?.aborted === true) {
    return {
      terminationKind: "CANCELLED",
      startedAt,
      endedAt: new Date().toISOString(),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLength = 0;
  let stderrLength = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let stopReason: "TIMED_OUT" | "CANCELLED" | undefined;
  let spawnError: Error | undefined;
  let terminationError: Error | undefined;
  let startedCallbackError: Error | undefined;
  let childClosed = false;
  let escalation: NodeJS.Timeout | undefined;

  const environment = buildEnvironment(request);
  const inputLaunch = await prepareInputLaunch(request.runtimeDshHomePath,request.inputs ?? []);
  if(inputLaunch) {
    environment.DSH_EVAL_ATTACHMENT_MANIFEST=inputLaunch.manifestPath;
    environment.DSH_EVAL_INPUT_RECEIPT=inputLaunch.receiptPath;
    environment.DSH_EVAL_TARGET_EXECUTABLE=request.executablePath;
  }
  const targetArguments = ["--profile", request.profile,
    ...(inputLaunch ? ["--patch",inputLaunch.patchPath] : []), "--", request.task];
  const identityLaunch = request.targetUid === undefined
    ? undefined
    : identityLaunchCommand(
        process.platform,
        request.targetUid,
        request.targetGid!,
        request.executablePath,
        targetArguments,
      );
  const launchExecutable = identityLaunch?.executablePath ?? request.executablePath;
  const launchArguments = identityLaunch?.argv ?? targetArguments;
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(launchExecutable, launchArguments, {
      cwd: request.cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const spawnFailure = error instanceof Error ? error : new Error(String(error));
    return {
      terminationKind: "HARNESS_ERROR",
      startedAt,
      endedAt: new Date().toISOString(),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      errorMessage: spawnFailure.message,
    };
  }

  /** 封装当前子进程组信号发送并记录执行器错误；由 beginTermination 及其升级定时器调用。 */
  const signalProcessGroup = (signal: NodeJS.Signals): void => {
    if (childClosed) return;
    try {
      terminateProcess(child.pid, signal);
    } catch (error) {
      terminationError = error instanceof Error ? error : new Error(String(error));
    }
  };
  /** 开始 SIGTERM 到 SIGKILL 的有界终止序列；由取消、超时和启动回调失败路径调用。 */
  const beginTermination = (): void => {
    signalProcessGroup("SIGTERM");
    if (escalation === undefined) {
      escalation = setTimeout(() => signalProcessGroup("SIGKILL"), 1_000);
      escalation.unref();
    }
  };

  child.stdout.on("data", (data: Buffer) => {
    const appended = appendBounded(
      stdoutChunks,
      data,
      stdoutLength,
      request.maxOutputBytes,
    );
    stdoutLength = appended.length;
    stdoutTruncated ||= appended.truncated;
  });
  child.stderr.on("data", (data: Buffer) => {
    const appended = appendBounded(
      stderrChunks,
      data,
      stderrLength,
      request.maxOutputBytes,
    );
    stderrLength = appended.length;
    stderrTruncated ||= appended.truncated;
  });
  /** 只结算一次启动回执等待；由 spawn/error/timeout 三条竞态路径共同调用。 */
  let settleStartReceipt!: () => void;
  let startReceiptSettled = false;
  const startReceiptPromise = new Promise<void>((resolve) => {
    settleStartReceipt = () => {
      if (startReceiptSettled) return;
      startReceiptSettled = true;
      resolve();
    };
  });
  child.once("error", (error) => {
    spawnError = error;
    settleStartReceipt();
  });
  const closePromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => {
      childClosed = true;
      if (escalation !== undefined) clearTimeout(escalation);
      resolve({ code, signal });
    });
  });

  /** 将外部 AbortSignal 转换为取消原因并启动进程组清理；注册于本次 executeTarget 调用。 */
  const onAbort = (): void => {
    stopReason ??= "CANCELLED";
    beginTermination();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  const timeout = setTimeout(() => {
    stopReason ??= "TIMED_OUT";
    if (!startReceiptSettled) {
      startedCallbackError = new Error("target start receipt did not complete before the deadline");
      settleStartReceipt();
    }
    beginTermination();
  }, request.deadlineMs);
  timeout.unref();

  child.once("spawn", () => {
    if (child.pid === undefined) {
      startedCallbackError = new Error("spawned target did not expose a pid");
      settleStartReceipt();
      beginTermination();
      return;
    }
    Promise.resolve(request.onStarted?.(child.pid))
      .catch((error: unknown) => {
        startedCallbackError = error instanceof Error ? error : new Error(String(error));
        beginTermination();
      })
      .finally(settleStartReceipt);
  });

  const [closed] = await Promise.all([closePromise, startReceiptPromise]);
  clearTimeout(timeout);
  if (escalation !== undefined) clearTimeout(escalation);
  request.signal?.removeEventListener("abort", onAbort);

  let terminationKind: TargetTerminationKind;
  const identityLaunchUnconfirmed =
    request.targetUid !== undefined &&
    (closed.code === 126 ||
      closed.code === 127 ||
      (process.platform === "darwin" && closed.code !== 0)) &&
    !(await lstat(request.probeOutputPath)
      .then((metadata) => metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0)
      .catch(() => false));
  if (
    startedCallbackError !== undefined ||
    spawnError !== undefined ||
    terminationError !== undefined ||
    identityLaunchUnconfirmed
  ) {
    terminationKind = "HARNESS_ERROR";
  } else if (stopReason === "CANCELLED") {
    terminationKind = "CANCELLED";
  } else if (stopReason === "TIMED_OUT") {
    terminationKind = "TIMED_OUT";
  } else if (closed.code === 0) {
    terminationKind = "EXITED";
  } else {
    terminationKind = "TARGET_FAILED";
  }

  const executionError =
    startedCallbackError ??
    spawnError ??
    terminationError ??
    (identityLaunchUnconfirmed
      ? new Error("identity launch or target exec could not be confirmed")
      : undefined);
  let inputDelivery: InputDeliveryReceipt | undefined;
  if(inputLaunch) {
    try {
      const receipt=JSON.parse(await readFile(inputLaunch.receiptPath,"utf8"));
      if(!["SUBMITTED","FAILED"].includes(receipt.status) || !Array.isArray(receipt.attachments)) throw new Error("Invalid input receipt");
      inputDelivery=receipt;
    } catch {
      inputDelivery={status:"FAILED",attachments:[],reason:"DSH_INPUT_SUBMISSION_UNCONFIRMED"};
    }
    if(inputDelivery?.status==="FAILED" && terminationKind!=="CANCELLED" && terminationKind!=="TIMED_OUT") terminationKind="HARNESS_ERROR";
  }
  return {
    terminationKind,
    ...(inputDelivery ? {inputDelivery} : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    ...(closed.code === null ? {} : { exitCode: closed.code }),
    ...(closed.signal === null ? {} : { signal: closed.signal }),
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    stdoutTruncated,
    stderrTruncated,
    ...(executionError === undefined ? {} : { errorMessage: executionError.message }),
  };
}
