import {loadObserverRegistry,type ObserverRegistration} from "./registry.js";
/**
 * 把 observer-lab 中已安装的 macOS 组件适配器接入正式 Workflow。
 * 正式评测仅比较 BEFORE/AFTER 两次采样；暂停进程采集。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  digestValue,
  refForImmutable,
  validateIsoDateTime,
  validateScope,
  validateStableId,
  withContentDigest,
  type ArtifactRef,
  type CollectionStatus,
  type JsonObject,
  type JsonValue,
  type RawObservation,
  type Ref,
  type ScopeRef,
  type SourceDescriptor,
  type SourceRequirement,
} from "../core/models.js";

export function createLabSourceDescriptor(input: {
  readonly registry: readonly ObserverRegistration[];
  readonly requirement: SourceRequirement;
  readonly sourceId: string;
  readonly scope: ScopeRef;
  readonly createdAt: string;
  readonly producerVersion: string;
}): SourceDescriptor {
  const descriptor = input.registry.find((item) =>
    item.sourceType === input.requirement.sourceType &&
    item.implementationId === input.requirement.sensorImplementationId);
  if (descriptor === undefined) throw new Error(`No observer-lab descriptor for ${input.requirement.sourceType}`);
  return withContentDigest({
    schema: "evaldock.mvp.source/v1" as const,
    sourceId: validateStableId<"SourceId">(input.sourceId),
    scope: validateScope(input.scope),
    sourceType: descriptor.sourceType,
    externalSchema: "evaldock.observer.event/v1",
    collectorName: descriptor.implementationId,
    collectorVersion: descriptor.implementationVersion,
    collectorCapabilityDigest: descriptor.capabilityDigest,
    trust: "INDEPENDENT" as const,
    resourceBinding: input.requirement.resourceBinding,
    sequenceMode: "CONTIGUOUS_FROM_ONE",
    watermarkDefinition: input.requirement.watermarkDefinition,
    contentMode: input.requirement.contentMode,
    knownBlindSpots: ["BEFORE_AFTER_ONLY_TRANSIENT_CHANGES_NOT_OBSERVED", "EXTERNAL_OBSERVER_DOES_NOT_PROVE_AGENT_CAUSALITY"],
    createdAt: validateIsoDateTime(input.createdAt),
    producerVersion: input.producerVersion,
  });
}

interface WatchProcess {
  readonly component: string;
  readonly sourceType: string;
  readonly output: string;
  readonly statusOutput: string;
  readonly requiredCapabilities: readonly string[];
  readonly openedAt: string;
  readonly child: ChildProcess;
}

export interface LabCapture {
  readonly component: string;
  readonly sourceType: string;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly events: readonly JsonObject[];
  readonly captureCount?: number;
  readonly changeStatus?: "CHANGED" | "UNCHANGED" | "UNKNOWN";
  readonly runtimeStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "NOT_CONFIGURED" | "IDLE";
  readonly adapterCapabilities: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly capturedCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly complete: boolean;
  readonly reasonCode?: string;
}

function readEvents(text: string, component: string): readonly JsonObject[] {
  return Object.freeze(text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    const value = JSON.parse(line) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${component} event ${index} is not an object`);
    }
    const event = value as JsonObject;
    if (event.schema !== "evaldock.observer.event/v1" || event.component !== component || !Array.isArray(event.changes) || event.changes.length === 0) {
      throw new Error(`${component} event ${index} has an invalid envelope`);
    }
    return Object.freeze(event);
  }));
}

async function stopChild(watcher: WatchProcess): Promise<LabCapture> {
  if (watcher.child.exitCode === null && watcher.child.signalCode === null) watcher.child.kill("SIGTERM");
  const killTimer = setTimeout(() => watcher.child.kill("SIGKILL"), 30_000);
  killTimer.unref();
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (watcher.child.exitCode !== null || watcher.child.signalCode !== null) {
      resolve({ code: watcher.child.exitCode, signal: watcher.child.signalCode });
    } else {
      watcher.child.once("exit", (code, signal) => resolve({ code, signal }));
    }
  });
  clearTimeout(killTimer);
  const closedAt = new Date().toISOString();
  const events: JsonObject[] = [];
  let eventsValid = true;
  try {
    const text = await readFile(watcher.output, "utf8");
    for (const line of text.split(/\r?\n/u).filter((value) => value.trim().length > 0)) {
      events.push(...readEvents(line, watcher.component));
    }
  } catch {
    eventsValid = false;
  }
  try {
    const runtime = JSON.parse(await readFile(watcher.statusOutput, "utf8")) as Record<string, unknown>;
    const runtimeStatus = runtime.runtimeStatus;
    if (!["COMPLETE", "PARTIAL", "UNAVAILABLE", "NOT_CONFIGURED", "IDLE"].includes(String(runtimeStatus))) {
      throw new Error("invalid Observer runtime status");
    }
    const strings = (value: unknown): readonly string[] => Array.isArray(value)
      ? Object.freeze(value.filter((item): item is string => typeof item === "string"))
      : Object.freeze([]);
    const transportOk = result.code === 0 && eventsValid;
    const complete = transportOk && ["COMPLETE","IDLE"].includes(String(runtimeStatus));
    return Object.freeze({
      component: watcher.component,
      sourceType: watcher.sourceType,
      openedAt: typeof runtime.openedAt === "string" ? runtime.openedAt : watcher.openedAt,
      closedAt: typeof runtime.closedAt === "string" ? runtime.closedAt : closedAt,
      events,
      captureCount: typeof runtime.captureCount === "number" ? runtime.captureCount : 0,
      changeStatus: events.length > 0 ? "CHANGED" : complete && ["COMPLETE", "IDLE"].includes(String(runtimeStatus)) ? "UNCHANGED" : "UNKNOWN",
      runtimeStatus: transportOk ? runtimeStatus as LabCapture["runtimeStatus"] : "PARTIAL",
      adapterCapabilities: strings(runtime.adapterCapabilities),
      requiredCapabilities: strings(runtime.requiredCapabilities),
      capturedCapabilities: strings(runtime.capturedCapabilities),
      missingCapabilities: strings(runtime.missingCapabilities),
      reasonCodes: [...strings(runtime.reasonCodes), ...(transportOk ? [] : [eventsValid ? "OBSERVER_LAB_PROCESS_FAILED" : "OBSERVER_LAB_OUTPUT_INVALID"])],
      complete,
      ...(transportOk ? {} : { reasonCode: "OBSERVER_LAB_PROCESS_FAILED" }),
    });
  } catch {
    return Object.freeze({
      component: watcher.component,
      sourceType: watcher.sourceType,
      openedAt: watcher.openedAt,
      closedAt,
      events: Object.freeze(events),
      changeStatus: events.length > 0 ? "CHANGED" : "UNKNOWN",
      runtimeStatus: "UNAVAILABLE",
      adapterCapabilities: Object.freeze([]),
      requiredCapabilities: watcher.requiredCapabilities,
      capturedCapabilities: Object.freeze([]),
      missingCapabilities: watcher.requiredCapabilities,
      reasonCodes: Object.freeze(["OBSERVER_RUNTIME_STATUS_UNAVAILABLE"]),
      complete: false,
      reasonCode: "OBSERVER_LAB_OUTPUT_INVALID",
    });
  }
}

/** 启动全部外部环境 Observer；返回的 stop 必须在 Agent 结束后调用。 */
export async function startLabObservers(input: {
  readonly cwd: string;
  readonly outputDirectory: string;
  readonly caseId: string;
  readonly agentId: string;
  readonly requirements: readonly SourceRequirement[];
  readonly workspacePath: string;
  readonly observedUid: number;
  readonly attemptId: string;
  readonly maxFileBytes: number;
  readonly configPath?: string;
}): Promise<{ readonly stop: () => Promise<readonly LabCapture[]> }> {
  const registry = await loadObserverRegistry(input.cwd);
  const script = path.join(input.cwd, "observer-lab", "bin", "observer-worker.mjs");
  const originalConfig = JSON.parse(await readFile(input.configPath ??
    path.join(input.cwd, "observer-lab", "config", "macos-worker.json"), "utf8")) as {
      components: Record<string, Record<string, unknown>>;
    };
  Object.assign(originalConfig, { runtime: {
    workspacePath:input.workspacePath,maxFileBytes:input.maxFileBytes,
    attemptId:input.attemptId,observedUid:input.observedUid,
  }});
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const config = path.join(input.outputDirectory, "config.json");
  await writeFile(config, JSON.stringify(originalConfig), { flag: "wx", mode: 0o600 });
  const starts = await Promise.all(input.requirements.map(async (requirement): Promise<
    { readonly watcher: WatchProcess } | { readonly failure: LabCapture } | undefined
  > => {
    const component = registry.find((item) => item.sourceType === requirement.sourceType);
    if(component===undefined)throw new Error("Observer is not registered: "+requirement.sourceType);
    if(!component.enabled || originalConfig.components[component.component]?.enabled===false)return undefined;
    const output = path.join(input.outputDirectory, `${component.component}.jsonl`);
    const statusOutput = path.join(input.outputDirectory, `${component.component}.status.json`);
    const requiredCapabilities = (requirement.requiredCapabilities ?? []).filter((capability) =>
      !capability.startsWith("SNAPSHOT_") && capability !== "STABLE_WINDOW");
    const openedAt = new Date().toISOString();
    const child = spawn(process.execPath, [
      script,
      component.component,
      "watch",
      "--final-only",
      "--config", config,
      "--output", output,
      "--status-output", statusOutput,
      "--required-capabilities", requiredCapabilities.join(","),
      "--interval-ms", "250",
      "--case-id", input.caseId,
      "--attempt-id", input.attemptId,
      "--agent-id", input.agentId,
    ], { cwd: input.cwd, stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${component.component} Observer did not become ready`)), 30_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.stdout!.once("data", () => { clearTimeout(timer); child.stdout!.resume(); resolve(); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${component.component} Observer exited before ready (${code ?? "signal"})`)); });
      });
      return { watcher: {
        component: component.component,
        sourceType: component.sourceType,
        output,
        statusOutput,
        requiredCapabilities,
        openedAt,
        child,
      } };
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return { failure: Object.freeze({
        component: component.component,
        sourceType: component.sourceType,
        openedAt,
        closedAt: new Date().toISOString(),
        events: Object.freeze([]),
        runtimeStatus: "UNAVAILABLE",
        adapterCapabilities: Object.freeze([]),
        requiredCapabilities,
        capturedCapabilities: Object.freeze([]),
        missingCapabilities: requiredCapabilities,
        reasonCodes: Object.freeze(["OBSERVER_LAB_START_FAILED"]),
        complete: false,
        reasonCode: "OBSERVER_LAB_START_FAILED",
      }) };
    }
  }));
  const watchers = starts.flatMap((result) => result !== undefined && "watcher" in result ? [result.watcher] : [])
    .sort((left, right) => left.component.localeCompare(right.component, "en"));
  const startupFailures = starts.flatMap((result) => result !== undefined && "failure" in result ? [result.failure] : [])
    .sort((left, right) => left.component.localeCompare(right.component, "en"));
  let stopped: Promise<readonly LabCapture[]> | undefined;
  return Object.freeze({
    stop: () => stopped ??= Promise.all(watchers.map(stopChild)).then((captures) => Object.freeze([
      ...startupFailures,
      ...captures,
    ])),
  });
}

export function materializeLabObservations(input: {
  readonly capture: LabCapture;
  readonly source: SourceDescriptor;
  readonly scope: ScopeRef;
  readonly attemptId: string;
  readonly producerVersion: string;
  readonly rawArtifactRef?: Ref<ArtifactRef>;
}): { readonly observations: readonly RawObservation[]; readonly status: CollectionStatus } {
  const scope = validateScope(input.scope);
  const sourceRef = refForImmutable(input.source, input.source.sourceId);
  if (input.capture.events.length > 0 && input.rawArtifactRef === undefined) {
    throw new Error("Observer change events require a committed raw artifact");
  }
  const observations = input.capture.events.map((event, index) => withContentDigest({
    schema: "evaldock.mvp.raw-observation/v1" as const,
    observationId: validateStableId<"ObservationId">(`raw.${input.capture.component}.${input.attemptId}.${index + 1}`),
    scope,
    attemptId: validateStableId<"AttemptId">(input.attemptId),
    sourceRef,
    externalEventType: "environment/change",
    sourceTime: {
      observedAt: validateIsoDateTime(String(event.observedAt), "observer event observedAt"),
      sourceSeq: index + 1,
      clockDomain: `observer-lab-${input.capture.component}`,
    },
    payloadInline: event as JsonValue,
    captureMetadata: {
      component: input.capture.component,
      association: event.association ?? {},
      trigger: event.trigger ?? {},
      ...(input.rawArtifactRef === undefined ? {} : { rawArtifactRef: {
        schema: input.rawArtifactRef.schema,
        id: input.rawArtifactRef.id,
        digest: {
          algorithm: input.rawArtifactRef.digest.algorithm,
          value: input.rawArtifactRef.digest.value,
          byteLength: input.rawArtifactRef.digest.byteLength,
        },
      } as JsonObject }),
    },
    rawDigest: digestValue(event),
    createdAt: input.capture.closedAt,
    producerVersion: input.producerVersion,
  }));
  const status = withContentDigest({
    schema: "evaldock.mvp.collection-status/v1" as const,
    collectionStatusId: validateStableId<"CollectionStatusId">(`collection.window.${input.capture.component}.${input.attemptId}`),
    scope,
    sourceRef,
    openedAt: validateIsoDateTime(input.capture.openedAt),
    closedAt: validateIsoDateTime(input.capture.closedAt),
    recordCount: observations.length,
    ...(observations.length === 0 ? {} : { firstSourceSeq: 1, lastSourceSeq: observations.length }),
    finalWatermark: {
      eventCount: observations.length,
      captureCount: input.capture.captureCount ?? 0,
      changeStatus: input.capture.changeStatus ?? (observations.length > 0 ? "CHANGED" :
        input.capture.complete && ["COMPLETE", "IDLE"].includes(input.capture.runtimeStatus) ? "UNCHANGED" : "UNKNOWN"),
      mode: "BEFORE_AFTER",
      runtimeStatus: input.capture.runtimeStatus,
      adapterCapabilities: input.capture.adapterCapabilities,
      requiredCapabilities: input.capture.requiredCapabilities,
      capturedCapabilities: input.capture.capturedCapabilities,
      missingCapabilities: input.capture.missingCapabilities,
    },
    gaps: input.capture.runtimeStatus === "COMPLETE" || input.capture.runtimeStatus === "IDLE"
      ? []
      : (input.capture.reasonCodes.length === 0
          ? [{ kind: "OBSERVER_RUNTIME", reasonCode: input.capture.reasonCode ?? "OBSERVER_RUNTIME_PARTIAL" }]
          : input.capture.reasonCodes.map((reasonCode) => ({ kind: "OBSERVER_RUNTIME", reasonCode }))),
    truncated: false,
    health: input.capture.complete && (input.capture.runtimeStatus === "COMPLETE" || input.capture.runtimeStatus === "IDLE")
      ? "HEALTHY" as const
      : "DEGRADED" as const,
    completeness: input.capture.complete && ["COMPLETE", "IDLE"].includes(input.capture.runtimeStatus)
      ? "COMPLETE" as const : "PARTIAL" as const,
    failureRefs: [],
    createdAt: input.capture.closedAt,
    producerVersion: input.producerVersion,
  });
  return Object.freeze({ observations: Object.freeze(observations), status });
}
