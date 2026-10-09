import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function digest(value) {
  const bytes = Buffer.from(JSON.stringify(stable(value)), "utf8");
  return { algorithm: "sha256", byteLength: bytes.byteLength, value: createHash("sha256").update(bytes).digest("hex") };
}

export async function command(file, args = [], options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      env: options.env ?? process.env,
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error?.stderr === "string" ? error.stderr.trim() : "",
      reasonCode: error?.code === "ENOENT" ? "COMMAND_NOT_FOUND" : "COMMAND_FAILED",
    };
  }
}

export function lines(text) {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export function observation(component, phase, state, errors, startedAt, completedAt, capabilities, runtime = {}) {
  const capturedCapabilities = [...new Set(runtime.capturedCapabilities ?? (errors.length === 0 ? capabilities : []))].sort();
  const body = {
    schema: "evaldock.observer.snapshot/v1",
    component,
    phase,
    capturedAt: completedAt,
    interval: { startedAt, completedAt },
    completeness: errors.length === 0 ? "COMPLETE" : "PARTIAL",
    capabilities: [...capabilities].sort(),
    runtime: {
      status: runtime.status ?? (errors.length === 0 ? "COMPLETE" : "PARTIAL"),
      capturedCapabilities,
      reasonCodes: [...new Set(runtime.reasonCodes ?? errors)].sort(),
    },
    state,
    errors: [...new Set(errors)].sort(),
  };
  return { ...body, contentDigest: digest(body) };
}

export function diffSnapshots(before, after) {
  if (before.component !== after.component) throw new Error("snapshot components differ");
  const beforeDigest = digest(before.state);
  const afterDigest = digest(after.state);
  const body = {
    schema: "evaldock.observer.diff/v1",
    component: before.component,
    beforeDigest,
    afterDigest,
    changed: beforeDigest.value !== afterDigest.value,
    beforeState: before.state,
    afterState: after.state,
    completeness: before.completeness === "COMPLETE" && after.completeness === "COMPLETE" ? "COMPLETE" : "PARTIAL",
  };
  return { ...body, contentDigest: digest(body) };
}

function pointer(path, key) {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

/** 生成紧凑的通用变化列表；数组按稳定值做增删，不重复保存完整前后快照。 */
export function stateChanges(before, after, path = "") {
  if (canonical(before) === canonical(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const remainingAfter = new Map();
    for (const value of after) {
      const key = canonical(value);
      const bucket = remainingAfter.get(key) ?? [];
      bucket.push(value);
      remainingAfter.set(key, bucket);
    }
    const removed = [];
    for (const value of before) {
      const key = canonical(value);
      const bucket = remainingAfter.get(key);
      if (bucket?.length) bucket.pop();
      else removed.push({ op: "REMOVE", path: path || "/", value });
    }
    const remainingBefore = new Map();
    for (const value of before) {
      const key = canonical(value);
      remainingBefore.set(key, (remainingBefore.get(key) ?? 0) + 1);
    }
    const added = [];
    for (const value of after) {
      const key = canonical(value);
      const count = remainingBefore.get(key) ?? 0;
      if (count > 0) remainingBefore.set(key, count - 1);
      else added.push({ op: "ADD", path: path || "/", value });
    }
    return [...removed, ...added];
  }
  if (before !== null && after !== null && typeof before === "object" && typeof after === "object") {
    const changes = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const nextPath = pointer(path, key);
      if (!(key in before)) changes.push({ op: "ADD", path: nextPath, value: after[key] });
      else if (!(key in after)) changes.push({ op: "REMOVE", path: nextPath, value: before[key] });
      else changes.push(...stateChanges(before[key], after[key], nextPath));
    }
    return changes;
  }
  return [{ op: "REPLACE", path: path || "/", before, after }];
}

/** 所有组件共用的触发事件 Envelope；只在 state digest 改变后创建。 */
export function changeEvent({ component, sequence, before, after, intervalMs, scope = {} }) {
  const changes = stateChanges(before.state, after.state);
  if (changes.length === 0) return undefined;
  const body = {
    schema: "evaldock.observer.event/v1",
    eventId: `${scope.attemptId ?? scope.caseId ?? "unscoped"}.${component}.${sequence}`,
    component,
    sequence,
    observedAt: after.capturedAt,
    interval: {
      startedAt: before.capturedAt,
      completedAt: after.capturedAt,
    },
    trigger: {
      mode: "STATE_CHANGE",
      detector: "SNAPSHOT_DIGEST",
      intervalMs,
    },
    association: {
      type: scope.caseId ? "CASE_WINDOW" : "UNSCOPED_WINDOW",
      causality: "NOT_PROVEN_BY_EXTERNAL_OBSERVER",
      ...(scope.caseId ? { caseId: scope.caseId } : {}),
      ...(scope.attemptId ? { attemptId: scope.attemptId } : {}),
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.agentPid ? { agentPid: scope.agentPid } : {}),
    },
    completeness: before.completeness === "COMPLETE" && after.completeness === "COMPLETE"
      ? "COMPLETE"
      : "PARTIAL",
    beforeDigest: digest(before.state),
    afterDigest: digest(after.state),
    changes,
    errors: [...new Set([...(before.errors ?? []), ...(after.errors ?? [])])].sort(),
  };
  return { ...body, contentDigest: digest(body) };
}

export async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

export async function writeJson(file, value) {
  const target = path.resolve(file);
  const root = path.parse(target).root;
  if (target === root || target === os.homedir()) throw new Error("unsafe output path");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

function safeOutput(file) {
  const target = path.resolve(file);
  const root = path.parse(target).root;
  if (target === root || target === os.homedir()) throw new Error("unsafe output path");
  return target;
}

export async function prepareJsonl(file) {
  const target = safeOutput(file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, "", { flag: "wx", mode: 0o600 });
  return target;
}

export async function appendJsonLine(file, value) {
  const target = safeOutput(file);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("event stream must be a regular file");
  await appendFile(target, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function safeError(component, reasonCode) {
  return `${component.toUpperCase()}_${reasonCode}`;
}
