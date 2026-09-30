import { linkEvidenceTree, readTraceDirectory } from "../all-trace/store.js";
import { link } from "node:fs/promises";
import { parseVerifiedReportDocument } from "../reporting/record.js";
/**
 * 文件职责：把一次 Case 的细粒度内部记录收敛为便于审查的 Agent/Run/Case 结果包。
 * 内部 records 仍可保持领域对象粒度；最终结果只保留聚合 JSON、压缩 Trace、交付物与报告。
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { digestBytes, validatePortablePath, validateStableId } from "../core/models.js";

interface ArtifactIndexEntry {
  readonly artifactId?: string;
  readonly artifactType?: string;
  readonly logicalName?: string;
  readonly portablePath?: string;
  readonly sensitivity?: string;
}

export interface CaseBundleResult {
  readonly directory: string;
  readonly reportJsonPath: string;
  readonly reportHtmlPath?: string;
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const value = (error as { readonly code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function safeRoot(input: string): Promise<string> {
  if (!path.isAbsolute(input) || input.includes("\0")) throw new Error("resultRoot must be absolute");
  const resolved = path.resolve(input);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new Error("resultRoot must not be a filesystem or user-home root");
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("resultRoot must be a real directory");
  }
  return realpath(resolved);
}

async function childDirectory(parent: string, name: string): Promise<string> {
  validateStableId(name, "case bundle path segment");
  const target = path.join(parent, name);
  await mkdir(target, { mode: 0o700 }).catch((error) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("case bundle path contains a non-directory or symlink");
  }
  const canonical = await realpath(target);
  if (!within(parent, canonical) || canonical === parent) throw new Error("case bundle path escaped root");
  return canonical;
}

async function writeBytes(destination: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  await chmod(destination, 0o400);
}

async function readJsonOptional(source: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const metadata = await lstat(source).catch((error) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error("case bundle JSON source is invalid or exceeds configured byte limit");
  }
  const parsed = JSON.parse(await readFile(source, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("case bundle JSON source must contain an object");
  }
  return parsed as Record<string, unknown>;
}

function artifactPath(partition: string, artifact: ArtifactIndexEntry): string | undefined {
  if (typeof artifact.portablePath !== "string" || artifact.portablePath.includes("\0")) return undefined;
  const candidate = path.resolve(partition, artifact.portablePath);
  return within(partition, candidate) && candidate !== partition ? candidate : undefined;
}

/** Case 终态形成后调用；以临时目录组装并原子发布一个不可覆盖的精简结果包。 */
export async function exportCaseBundle(input: {
  readonly resultRoot: string;
  readonly runRoot: string;
  readonly artifactRoot: string;
  readonly reportRoot: string;
  readonly agentId: string;
  readonly runId: string;
  /** 内部单 Case Workflow 的存储键；Batch 下与最终父 Run ID 不同。 */
  readonly sourceRunId?: string;
  readonly caseId: string;
  readonly maxFileBytes: number;
}): Promise<CaseBundleResult> {
  const agentId = validateStableId(input.agentId, "agentId");
  const runId = validateStableId(input.runId, "runId");
  const sourceRunId = validateStableId(input.sourceRunId ?? input.runId, "sourceRunId");
  const caseId = validateStableId(input.caseId, "caseId");
  if (!Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes <= 0) {
    throw new Error("maxFileBytes must be a positive safe integer");
  }

  const root = await safeRoot(input.resultRoot);
  const agents = await childDirectory(root, "agents");
  const agent = await childDirectory(agents, agentId);
  const runs = await childDirectory(agent, "runs");
  const run = await childDirectory(runs, runId);
  const cases = await childDirectory(run, "cases");
  const destination = path.join(cases, caseId);
  if (await lstat(destination).catch((error) => errorCode(error) === "ENOENT" ? undefined : Promise.reject(error))) {
    throw new Error("case bundle is immutable and already exists");
  }


  const sourceReportPath = path.join(input.reportRoot, sourceRunId, "report.json");
  const report = await readJsonOptional(sourceReportPath, input.maxFileBytes);
  if (report === undefined) throw new Error("committed report.json is unavailable");
  const document = parseVerifiedReportDocument(JSON.stringify(report));
  const artifactPartition = path.join(input.artifactRoot, sourceRunId);
  const staging = await mkdtemp(path.join(cases, ".partial-"));
  try {
    if (document.allTraceRef) {
      const sourceDirectory = path.dirname(sourceReportPath);
      await readTraceDirectory(sourceDirectory, document.allTraceRef, input.maxFileBytes);
      for (const name of ["all-trace", "output", "judge"]) {
        const source = path.join(sourceDirectory, name);
        const info = await lstat(source).catch(error => { if (errorCode(error) !== "ENOENT") throw error; });
        if (info) {
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid evidence export directory");
          await linkEvidenceTree(source, path.join(staging, name));
        }
      }
      let hasHtml = false;
      for (const name of ["report.json", "report.html", "report-data.js"]) {
        const source = path.join(sourceDirectory, name);
        const info = await lstat(source).catch(error => { if (errorCode(error) !== "ENOENT") throw error; });
        if (info) {
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid report export file");
          await link(source, path.join(staging, name));
          if (name === "report.html") hasHtml = true;
        }
      }
      // Verify after relocation, before publishing or letting Batch remove its working directory.
      await readTraceDirectory(staging, document.allTraceRef, input.maxFileBytes);
      await rename(staging, destination);
      return {directory:destination, reportJsonPath:path.join(destination,"report.json"),
        ...(hasHtml ? {reportHtmlPath:path.join(destination,"report.html")} : {})};
    }
    await writeBytes(path.join(staging,"report.json"),await readFile(sourceReportPath));
    const sourceHtml = path.join(input.reportRoot, sourceRunId,"report.html");
    const html=await lstat(sourceHtml).catch(error=>errorCode(error)==="ENOENT"?undefined:Promise.reject(error));
    if(html) {
      if(!html.isFile() || html.isSymbolicLink() || html.size>input.maxFileBytes) throw new Error("Invalid report HTML");
      await writeBytes(path.join(staging,"report.html"),await readFile(sourceHtml));
    }
    // ArtifactRef.portablePath is kept unchanged below attachments/, so every full raw file is resolvable.
    const copied=new Set<string>();
    for(const artifact of document.artifacts) {
      if(artifact.sensitivity!=="EXPORTABLE" || copied.has(String(artifact.portablePath))) continue;
      const source=artifactPath(artifactPartition,artifact);
      if(!source) throw new Error("Invalid artifact path");
      const info=await lstat(source);
      if(!info.isFile() || info.isSymbolicLink() || info.size>input.maxFileBytes) throw new Error("Invalid attachment");
      const bytes=await readFile(source);
      if(digestBytes(bytes).value!==artifact.artifactContentDigest.value) throw new Error("Attachment digest mismatch");
      await writeBytes(path.join(staging,"attachments",artifact.portablePath),bytes);
      copied.add(String(artifact.portablePath));
    }
    // Archive actual output files before workspace cleanup. Missing outputs stay absent.
    await mkdir(path.join(staging,"output"),{recursive:true,mode:0o700});
    for(const entry of document.allTrace?.entries ?? []) {
      if(entry.layer!=="DELIVERY" || !entry.content || Array.isArray(entry.content) || typeof entry.content!=="object") continue;
      const file=entry.content as Record<string, import("../core/models.js").JsonValue>;
      if(typeof file.portablePath!=="string" || !file.portablePath.startsWith("output/")) continue;
      validatePortablePath(file.portablePath,"deliverable path");
      const ref=file.artifactRef as {id?:string}|undefined;
      const artifact=document.artifacts.find(item=>item.artifactId===ref?.id && item.artifactType==="AGENT_DELIVERABLE");
      if(!artifact || artifact.sensitivity!=="EXPORTABLE") continue;
      const source=path.join(staging,"attachments",artifact.portablePath);
      await writeBytes(path.join(staging,file.portablePath),await readFile(source));
    }
    await rename(staging,destination);
    return {directory:destination,reportJsonPath:path.join(destination,"report.json"),
      ...(html?{reportHtmlPath:path.join(destination,"report.html")}:{})};
  } catch(error) { await rm(staging,{recursive:true,force:true});throw error; }
}
