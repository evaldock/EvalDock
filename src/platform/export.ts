import { linkEvidenceTree, readTraceDirectory } from "../all-trace/store.js";
import { parseVerifiedReportDocument } from "../reporting/record.js";
/**
 * 文件职责：安全提交、读取并导出最终评测报告文件。
 *
 * 核心流程：建立受约束的 Run 报告目录，以 staging+rename 原子提交 report.json/html，
 * 读取时复核文件身份和字节上限，导出时生成仅含两份报告及其 SHA-256 的 Manifest。
 *
 * 与其他文件的交互：`app/workflow.ts` 调用提交、读取与 exportReport；
 * `evaluation/report.ts` 负责报告语义和渲染，本文件只负责文件交付完整性。
 *
 * 公开接口：DeliveryManifestEntry、DeliveryManifest、报告读写函数和 exportReport。
 */
import { createHash, randomUUID } from "node:crypto";
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
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";


/** 导出目录内一个固定报告文件的长度和摘要。 */
export interface DeliveryManifestEntry {
  portablePath: "report.json" | "report.html";
  byteLength: number;
  sha256: string;
}

/** 一次可搬运报告导出的完整 Manifest。 */
export interface DeliveryManifest {
  schema: "evaldock.mvp.delivery-manifest/v1";
  runId: string;
  exportId: string;
  files: readonly DeliveryManifestEntry[];
  manifestDigest: string;
}

/** 校验 Run/Export ID，供所有路径拼接前调用。 */
function validateId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a StableId`);
  }
}

/** 计算报告原始字节的 SHA-256 十六进制值。 */
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 从未知文件系统异常中提取 Node errno code。 */
function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const value = (error as { readonly code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** 校验所有报告读取和写入共用的正字节上限。 */
function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
}

/** 判断解析后的路径是否仍位于指定根目录内。 */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** 建立或验证 `<reportRoot>/<runId>`，并返回经过 realpath 的目录边界。 */
async function reportRunDirectory(
  reportRootInput: string,
  runId: string,
  create: boolean,
): Promise<string> {
  validateId(runId, "runId");
  if (!path.isAbsolute(reportRootInput) || reportRootInput.includes("\0")) {
    throw new Error("reportRoot must be an absolute NUL-free path");
  }
  const reportRoot = path.resolve(reportRootInput);
  if (reportRoot === path.parse(reportRoot).root || reportRoot === os.homedir()) {
    throw new Error("reportRoot must not be a filesystem or user-home root");
  }
  try {
    const rootMetadata = await lstat(reportRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("reportRoot must be a real directory");
    }
  } catch (error) {
    if (!create || errorCode(error) !== "ENOENT") throw error;
    await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  }
  const rootMetadata = await lstat(reportRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("reportRoot must be a real directory");
  }
  const canonicalRoot = await realpath(reportRoot);
  const candidate = path.join(canonicalRoot, runId);
  let candidateMetadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (candidateMetadata === undefined) {
    if (!create) throw new Error("committed report run directory does not exist");
    await mkdir(candidate, { mode: 0o700 });
    candidateMetadata = await lstat(candidate);
  }
  if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()) {
    throw new Error("report run path must be a real directory");
  }
  const canonicalRun = await realpath(candidate);
  if (!isWithin(canonicalRoot, canonicalRun) || canonicalRun === canonicalRoot) {
    throw new Error("report run path escaped reportRoot");
  }
  return canonicalRun;
}

/** fsync 目录元数据，确保 rename/link 的提交在崩溃后可见。 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 以 staging 文件、fsync 和原子 rename 提交一份不可覆盖的报告文件。 */
async function commitImmutableFile(
  directory: string,
  name: "report.json" | "report.html",
  source: Uint8Array | string,
  maxBytes: number,
): Promise<{ path: string; digest: string; byteLength: number }> {
  assertMaxBytes(maxBytes);
  const unresolvedStages = (await readdir(directory, { withFileTypes: true })).filter((entry) =>
    entry.name.startsWith(".tmp-"),
  );
  if (unresolvedStages.length > 0) {
    throw new Error("report recovery is required before another immutable commit");
  }
  const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
  if (bytes.byteLength > maxBytes) throw new Error(`${name} exceeds configured byte limit`);
  const target = path.join(directory, name);
  if ((await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) !== undefined) {
    throw new Error(`${name} is immutable and already committed`);
  }
  const temporary = path.join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await chmod(temporary, 0o400);
    await link(temporary, target);
    published = true;
    await unlink(temporary);
    await syncDirectory(directory);
  } finally {
    await handle.close().catch(() => undefined);
    if (!published) await unlink(temporary).catch(() => undefined);
  }
  const verified = await readCommittedFile(target, maxBytes);
  if (verified.byteLength !== bytes.byteLength || digest(verified) !== digest(bytes)) {
    throw new Error(`${name} failed post-commit verification`);
  }
  return { path: target, digest: digest(bytes), byteLength: bytes.byteLength };
}

/** 解析并验证 report.json 的顶层摘要、Schema、字段和关键视图结构。 */
function parseAndVerifyReportJson(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  return parseVerifiedReportDocument(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown as Readonly<Record<string,unknown>>;
}

/** Workflow 调用：验证 JSON 后原子提交唯一 report.json。 */
export async function commitReportJson(input: {
  reportRoot: string;
  runId: string;
  bytes: Uint8Array | string;
  maxBytes: number;
}): Promise<{ path: string; digest: string; byteLength: number }> {
  assertMaxBytes(input.maxBytes);
  const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes, "utf8") : Buffer.from(input.bytes);
  if (bytes.byteLength > input.maxBytes) throw new Error("report.json exceeds configured byte limit");
  parseAndVerifyReportJson(bytes);
  const directory = await reportRunDirectory(input.reportRoot, input.runId, true);
  return commitImmutableFile(directory, "report.json", bytes, input.maxBytes);
}

/** Workflow/report 命令调用：读取并验证已提交的 report.json。 */
export async function readCommittedReportJson(input: {
  reportRoot: string;
  runId: string;
  maxBytes: number;
}): Promise<Buffer> {
  assertMaxBytes(input.maxBytes);
  const directory = await reportRunDirectory(input.reportRoot, input.runId, false);
  const bytes = await readCommittedFile(path.join(directory, "report.json"), input.maxBytes);
  parseAndVerifyReportJson(bytes);
  return Buffer.from(bytes);
}

/** Workflow 调用：校验静态 HTML 安全属性后原子提交唯一 report.html。 */
export async function commitReportHtml(input: {
  reportRoot: string;
  runId: string;
  bytes: Uint8Array | string;
  maxBytes: number;
}): Promise<{ path: string; digest: string; byteLength: number }> {
  assertMaxBytes(input.maxBytes);
  const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes, "utf8") : Buffer.from(input.bytes);
  if (bytes.byteLength > input.maxBytes) throw new Error("report.html exceeds configured byte limit");
  await readCommittedReportJson({
    reportRoot: input.reportRoot,
    runId: input.runId,
    maxBytes: input.maxBytes,
  });
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("report.html must be valid UTF-8", { cause: error });
  }
  const directory = await reportRunDirectory(input.reportRoot, input.runId, false);
  return commitImmutableFile(directory, "report.html", bytes, input.maxBytes);
}

/** Workflow/report 命令调用：读取已提交且满足静态安全约束的 report.html。 */
export async function readCommittedReportHtml(input: {
  reportRoot: string;
  runId: string;
  maxBytes: number;
}): Promise<Buffer> {
  await readCommittedReportJson(input);
  const directory = await reportRunDirectory(input.reportRoot, input.runId, false);
  const bytes = await readCommittedFile(path.join(directory, "report.html"), input.maxBytes);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("report.html must be valid UTF-8", { cause: error });
  }
  return Buffer.from(bytes);
}

/** 以 O_NOFOLLOW 固定读取单个报告文件，并核对读取前后的文件身份。 */
async function readCommittedFile(file: string, maxBytes: number): Promise<Buffer> {
  assertMaxBytes(maxBytes);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`delivery input is not a committed regular file: ${path.basename(file)}`);
  }
  if (before.size > maxBytes) throw new Error("delivery input exceeds configured byte limit");
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    bytes.byteLength !== before.size ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("delivery input changed while reading");
  }
  return bytes;
}

/**
 * 将已验证 report.json/html 硬链接到不可变导出目录并提交摘要 Manifest。
 */
export async function exportReport(input: {
  reportRoot: string;
  runId: string;
  exportId: string;
  maxBytes: number;
}): Promise<{ directory: string; manifest: DeliveryManifest }> {
  validateId(input.runId, "runId");
  validateId(input.exportId, "exportId");
  assertMaxBytes(input.maxBytes);
  const runDirectory = await reportRunDirectory(input.reportRoot, input.runId, false);
  const reportJson = await readCommittedFile(path.join(runDirectory, "report.json"), input.maxBytes);
  parseAndVerifyReportJson(reportJson);
  const document = parseVerifiedReportDocument(reportJson.toString("utf8"));
  if (document.allTraceRef) await readTraceDirectory(runDirectory, document.allTraceRef, input.maxBytes);
  const reportHtml = await readCommittedFile(path.join(runDirectory, "report.html"), input.maxBytes);
  const entries: DeliveryManifestEntry[] = [
    {
      portablePath: "report.html",
      byteLength: reportHtml.byteLength,
      sha256: digest(reportHtml),
    },
    {
      portablePath: "report.json",
      byteLength: reportJson.byteLength,
      sha256: digest(reportJson),
    },
  ];
  const manifestWithoutDigest = {
    schema: "evaldock.mvp.delivery-manifest/v1" as const,
    runId: input.runId,
    exportId: input.exportId,
    files: entries,
  };
  const manifestBytesWithoutDigest = Buffer.from(JSON.stringify(manifestWithoutDigest), "utf8");
  const manifest: DeliveryManifest = {
    ...manifestWithoutDigest,
    manifestDigest: digest(manifestBytesWithoutDigest),
  };
  const partialRoot = path.join(runDirectory, ".partial");
  const staged = path.join(partialRoot, input.exportId);
  const deliveryRoot = path.join(runDirectory, "delivery");
  const destination = path.join(deliveryRoot, input.exportId);
  for (const directory of [partialRoot, deliveryRoot]) {
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined) await mkdir(directory, { mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("delivery staging path must be a real directory");
    }
    const resolved = await realpath(directory);
    if (!isWithin(runDirectory, resolved)) throw new Error("delivery path escaped report run root");
  }
  const unresolvedDeliveries = await readdir(partialRoot, { withFileTypes: true });
  if (unresolvedDeliveries.length > 0) {
    throw new Error("delivery recovery is required for an unconfirmed partial export");
  }
  if ((await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) !== undefined) {
    throw new Error("delivery destination is immutable and already exists");
  }
  await mkdir(staged, { recursive: false, mode: 0o700 });
  try {
    await link(path.join(runDirectory, "report.json"), path.join(staged, "report.json"));
    await link(path.join(runDirectory, "report.html"), path.join(staged, "report.html"));
    if (document.allTraceRef) {
      for (const name of ["all-trace", "output", "judge"]) {
        const info = await lstat(path.join(runDirectory,name)).catch(error=>{if(errorCode(error)!=="ENOENT")throw error;});
        if (info) await linkEvidenceTree(path.join(runDirectory,name),path.join(staged,name));
      }
      await link(path.join(runDirectory,"report-data.js"),path.join(staged,"report-data.js"));
      await readTraceDirectory(staged,document.allTraceRef,input.maxBytes);
    }
    await writeFile(path.join(staged, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    for (const name of ["report.json", "report.html", "manifest.json"] as const) {
      const file = path.join(staged, name);
      const handle = await open(file, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(file, 0o400);
    }
    await syncDirectory(staged);
    await rename(staged, destination);
    await syncDirectory(deliveryRoot);
    return { directory: destination, manifest };
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}
