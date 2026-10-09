/** One immutable evidence directory per Case. Bodies are content-addressed; reads verify every reference. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, open, link, unlink, rename, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { digestBytes, digestValue, digestEquals, freezeJson, validatePortablePath, type ContentDigest, type JsonValue, type ScopeRef, type ArtifactRef } from "../core/models.js";
import type { AllTrace } from "./types.js";

type Node = ["v", JsonValue] | ["a", Node[]] | ["o", [string, Node][]] | ["r", FileRef];
interface FileRef { path: string; sha256: string; byteLength: number; encoding: "node" | "TEXT" | "JSON" | "BASE64"; }
export interface TraceDirectoryRef {
  readonly schema: "evaldock.trace-directory-ref/v1";
  readonly manifestPath: "all-trace/manifest.json";
  readonly manifestDigest: ContentDigest;
  readonly traceId: string;
  readonly scope: ScopeRef;
  readonly contentDigest: ContentDigest;
  readonly entryCount: number;
  readonly layers: Readonly<Record<"AGENT" | "ENVIRONMENT" | "DELIVERY", number>>;
  readonly outputs: readonly string[];
}
interface Manifest {
  schema: "evaldock.trace-directory/v1";
  traceId: string;
  header: Node;
  events: FileRef;
  files: FileRef[];
  entryCount: number;
  traceDigest: ContentDigest;
  rawArtifactPolicy: "PROVENANCE_METADATA_ONLY";
}
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

export async function readEvidenceFile(root: string, relative: string, maxBytes: number): Promise<Buffer> {
  validatePortablePath(relative, "evidence path");
  const base = await realpath(root);
  if (base !== path.resolve(root)) throw new Error("Evidence root must not contain symlinks");
  let current = base;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error("Unsafe evidence path");
    if (index === parts.length - 1 && info.size > maxBytes) throw new Error("Evidence file exceeds limit");
  }
  const before = await lstat(current);
  const bytes = await readFile(current);
  const after = await lstat(current);
  if (bytes.length > maxBytes || before.ino !== after.ino || before.dev !== after.dev ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.isSymbolicLink()) throw new Error("Evidence changed during read");
  return bytes;
}

async function immutableFile(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  validatePortablePath(relative, "evidence destination");
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + ".tmp-" + randomUUID();
  try {
    const handle = await open(temp, "wx", 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temp, target); }
    catch (error) {
      if (code(error) !== "EEXIST" || !Buffer.from(await readEvidenceFile(root, relative, bytes.length)).equals(Buffer.from(bytes))) throw error;
    }
  } finally { await unlink(temp).catch(() => undefined); }
}

/** Called before Judge. Source files may be transient; this directory owns all evidence needed for scoring. */
export async function writeTraceDirectory(input: {
  caseDirectory: string; trace: AllTrace; maxBytes: number;
  readArtifact?: (artifact: ArtifactRef) => Promise<Uint8Array>;
}): Promise<TraceDirectoryRef> {
  const { trace, maxBytes } = input;
  if (!digestEquals(trace.contentDigest, digestValue(trace, ["contentDigest"]))) throw new Error("Invalid source all trace digest");
  const root = path.resolve(input.caseDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new Error("Evidence root must be canonical");
  const existing = await lstat(path.join(root, "all-trace")).catch(error => { if (code(error) !== "ENOENT") throw error; });
  if (existing) throw new Error("All trace directory is immutable and already exists");
  const staging = path.join(root, ".evidence-" + randomUUID());
  await mkdir(path.join(staging, "all-trace", "blobs"), { recursive: true, mode: 0o700 });
  const files = new Map<string, FileRef>();
  const memo = new Map<string, Node>();
  const outputs: string[] = [];
  const bodyOverrides = new Map<string, FileRef>();
  let totalBytes = 0;
  let outputBytes = 0;
  const put = async (relative: string, bytes: Uint8Array, encoding: FileRef["encoding"]): Promise<FileRef> => {
    const ref = { path: relative, sha256: sha(bytes), byteLength: bytes.length, encoding };
    const prior = files.get(relative);
    if (prior) {
      if (prior.sha256 !== ref.sha256) throw new Error("Conflicting evidence path");
      return { ...prior, encoding };
    }
    // Archived originals have a separate budget; index-only bodies are never expanded into Judge input.
    if (relative.startsWith("output/")) outputBytes += bytes.length;
    else totalBytes += bytes.length;
    if (totalBytes > maxBytes || outputBytes > maxBytes) throw new Error("Evidence directory exceeds byte limit");
    await immutableFile(staging, relative, bytes);
    files.set(relative, ref);
    return ref;
  };
  const encode = async (value: unknown, depth = 0, externalize = true): Promise<Node> => {
    if (depth > 128) throw new Error("Evidence nesting exceeds limit");
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Evidence must be JSON");
    if (Buffer.byteLength(text) < 1024) return ["v", value as JsonValue];
    const key = sha(text);
    const output = bodyOverrides.get(key);
    if (output) return ["r", output];
    const cached = memo.get(key);
    if (cached && externalize) return cached;
    let node: Node;
    if (value === null || typeof value !== "object") node = ["v", value as null | boolean | number | string];
    else if (Array.isArray(value)) {
      const items: Node[] = [];
      for (const item of value) items.push(await encode(item, depth + 1));
      node = ["a", items];
    } else {
      const items: [string, Node][] = [];
      for (const [key, item] of Object.entries(value)) items.push([key, await encode(item, depth + 1, key !== "observation")]);
      node = ["o", items];
    }
    if (externalize && (value === null || typeof value !== "object" || depth === 1)) {
      const bytes = Buffer.from(JSON.stringify(node));
      node = ["r", await put("all-trace/blobs/" + sha(bytes), bytes, "node")];
    }
    if (externalize) memo.set(key, node);
    return node;
  };
  try {
    for (const entry of trace.entries) {
      if (entry.layer !== "DELIVERY" || !entry.content || typeof entry.content !== "object" || Array.isArray(entry.content)) continue;
      const file = entry.content as Record<string, JsonValue>;
      if (typeof file.portablePath !== "string" || !file.portablePath.startsWith("output/") || file.contentRestricted) continue;
      validatePortablePath(file.portablePath, "output path");
      const artifactId = (file.artifactRef as { id?: string } | undefined)?.id;
      const artifact = trace.artifacts.find(item => item.artifactId === artifactId && item.sensitivity === "EXPORTABLE");
      if (file.representation === "INDEX_ONLY" && file.archiveStatus === "NOT_ARCHIVED") continue;
      let bytes: Buffer;
      if (artifact && input.readArtifact) {
        bytes = Buffer.from(await input.readArtifact(artifact));
        if (!digestEquals(digestBytes(bytes), artifact.artifactContentDigest)) throw new Error("Output artifact digest mismatch");
      } else if (!file.contentTruncated && file.representation === "BASE64" && typeof file.content === "string") bytes = Buffer.from(file.content, "base64");
      else if (!file.contentTruncated && file.representation === "TEXT" && typeof file.content === "string") bytes = Buffer.from(file.content);
      else throw new Error("Full output bytes are required before workspace cleanup");
      const encoding = (file.representation === "INDEX_ONLY" ? "BASE64" : file.representation) as FileRef["encoding"];
      if (!["TEXT", "BASE64", "JSON"].includes(encoding)) throw new Error("Invalid output representation");
      const ref = await put(file.portablePath, bytes, encoding);
      outputs.push(file.portablePath);
      if (file.representation !== "INDEX_ONLY" && !file.contentTruncated) {
        const restored = encoding === "BASE64" ? bytes.toString("base64") : encoding === "TEXT" ? bytes.toString("utf8") : JSON.parse(bytes.toString("utf8"));
        if (JSON.stringify(restored) === JSON.stringify(file.content)) bodyOverrides.set(sha(JSON.stringify(file.content)), ref);
      }
    }
    const rows: string[] = [];
    const layers = { AGENT: 0, ENVIRONMENT: 0, DELIVERY: 0 };
    for (const entry of trace.entries) {
      layers[entry.layer]++;
      rows.push(JSON.stringify({ id: entry.id, layer: entry.layer, value: await encode(entry, 0, false) }));
    }
    const eventBytes = Buffer.from(rows.join("\n") + "\n");
    const events = await put("all-trace/events.jsonl", eventBytes, "node");
    const { entries: _entries, ...header } = trace;
    const headerNode = await encode(header, 0, false);
    const manifest: Manifest = {
      schema: "evaldock.trace-directory/v1", traceId: trace.traceId, header: headerNode, events,
      files: [...files.values()], entryCount: trace.entries.length, traceDigest: trace.contentDigest,
      rawArtifactPolicy: "PROVENANCE_METADATA_ONLY",
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n");
    if (totalBytes + manifestBytes.length > maxBytes) throw new Error("Evidence manifest exceeds byte limit");
    await immutableFile(staging, "all-trace/manifest.json", manifestBytes);
    // Publish outputs first; the manifest directory is the last commit marker.
    for (const output of outputs) {
      await mkdir(path.dirname(path.join(root, output)), { recursive: true, mode: 0o700 });
      try { await link(path.join(staging, output), path.join(root, output)); }
      catch (error) {
        if (code(error) !== "EEXIST" || !(await readEvidenceFile(root, output, maxBytes)).equals(await readEvidenceFile(staging, output, maxBytes))) throw error;
      }
    }
    await rename(path.join(staging, "all-trace"), path.join(root, "all-trace"));
    const ref: TraceDirectoryRef = {
      schema: "evaldock.trace-directory-ref/v1", manifestPath: "all-trace/manifest.json",
      manifestDigest: digestBytes(manifestBytes), traceId: trace.traceId, scope: trace.scope,
      contentDigest: trace.contentDigest, entryCount: trace.entries.length, layers, outputs,
    };
    await readTraceDirectory(root, ref, maxBytes);
    return freezeJson(ref);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function readTraceDirectory(root: string, ref: TraceDirectoryRef, maxBytes: number): Promise<AllTrace> {
  if (ref.schema !== "evaldock.trace-directory-ref/v1" || ref.manifestPath !== "all-trace/manifest.json") throw new Error("Invalid trace reference");
  const manifestBytes = await readEvidenceFile(root, ref.manifestPath, maxBytes);
  if (!digestEquals(digestBytes(manifestBytes), ref.manifestDigest)) throw new Error("Trace manifest digest mismatch");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  if (manifest.schema !== "evaldock.trace-directory/v1" || manifest.traceId !== ref.traceId ||
      manifest.entryCount !== ref.entryCount || !digestEquals(manifest.traceDigest, ref.contentDigest)) throw new Error("Trace manifest identity mismatch");
  const index = new Map(manifest.files.map(file => [file.path, file]));
  const cache = new Map<string, { value: JsonValue; cost: number }>();
  const active = new Set<string>();
  let bytesRead = manifestBytes.length;
  let visits = 0;
  const verified = async (file: FileRef): Promise<Buffer> => {
    const known = index.get(file.path);
    if (!known || file.sha256 !== known.sha256 || file.byteLength !== known.byteLength ||
      !/^(all-trace\/(blobs\/[a-f0-9]{64}|events\.jsonl)|output\/.+)$/.test(file.path)) throw new Error("Unlisted evidence reference");
    const bytes = await readEvidenceFile(root, file.path, maxBytes);
    bytesRead += bytes.length;
    if (bytesRead > maxBytes || bytes.length !== file.byteLength || sha(bytes) !== file.sha256) throw new Error("Evidence size or digest mismatch");
    return bytes;
  };
  const decode = async (node: Node, depth = 0): Promise<{ value: JsonValue; cost: number }> => {
    if (!Array.isArray(node) || depth > 256 || ++visits > 2_000_000) throw new Error("Invalid or excessive evidence nodes");
    let value: JsonValue;
    let cost: number;
    if (node[0] === "r") {
      const file = node[1];
      const key = file.path + ":" + file.encoding;
      const cached = cache.get(key);
      if (cached) return cached;
      if (active.has(key)) throw new Error("Cyclic evidence reference");
      active.add(key);
      const bytes = await verified(file);
      const decoded = file.encoding === "node" ? await decode(JSON.parse(bytes.toString("utf8")) as Node, depth + 1) : {
        value: file.encoding === "BASE64" ? bytes.toString("base64") : file.encoding === "TEXT" ? bytes.toString("utf8") : JSON.parse(bytes.toString("utf8")) as JsonValue,
        cost: Math.ceil(bytes.length * 2) + 2,
      };
      cache.set(key, decoded); active.delete(key); return decoded;
    } else if (node[0] === "v") {
      value = node[1]; cost = Buffer.byteLength(JSON.stringify(value));
    } else if (node[0] === "a") {
      value = []; cost = 2;
      for (const child of node[1]) {
        const item = await decode(child, depth + 1); cost += item.cost + 1;
        if (cost > maxBytes) throw new Error("Expanded evidence exceeds limit");
        (value as JsonValue[]).push(item.value);
      }
    } else if (node[0] === "o") {
      value = Object.create(null) as Record<string, JsonValue>; cost = 2;
      for (const [key, child] of node[1]) {
        if (Object.hasOwn(value, key)) throw new Error("Duplicate evidence property");
        const item = await decode(child, depth + 1); cost += item.cost + Buffer.byteLength(JSON.stringify(key)) + 2;
        if (cost > maxBytes) throw new Error("Expanded evidence exceeds limit");
        (value as Record<string, JsonValue>)[key] = item.value;
      }
    } else throw new Error("Unknown evidence node");
    return { value, cost };
  };
  const header = (await decode(manifest.header)).value as Record<string, JsonValue>;
  const eventBytes = await verified(manifest.events);
  const entries: AllTrace["entries"][number][] = [];
  let expanded = 0;
  const ids = new Set<string>();
  for (const line of eventBytes.toString("utf8").trimEnd().split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    const decoded = await decode(row.value);
    expanded += decoded.cost;
    if (expanded > maxBytes) throw new Error("Expanded trace exceeds limit");
    const entry = decoded.value as unknown as AllTrace["entries"][number];
    if (entry.id !== row.id || entry.layer !== row.layer || ids.has(entry.id)) throw new Error("Invalid trace event identity");
    ids.add(entry.id); entries.push(entry);
  }
  const trace = { ...header, entries } as unknown as AllTrace;
  if (entries.length !== ref.entryCount || JSON.stringify(trace.scope) !== JSON.stringify(ref.scope) ||
      !digestEquals(trace.contentDigest, ref.contentDigest) || !digestEquals(digestValue(trace, ["contentDigest"]), ref.contentDigest)) throw new Error("Reconstructed all trace digest mismatch");
  return freezeJson(trace);
}

/** Publish a relocatable tree without copying file bodies on the same volume. */
export async function linkEvidenceTree(source: string, destination: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Cannot export symlink");
    if (entry.isDirectory()) await linkEvidenceTree(from, to);
    else if (entry.isFile()) await link(from, to);
    else throw new Error("Cannot export special file");
  }
}
