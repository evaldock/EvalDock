/** question.json + public inputs + private grading references. */
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { freezeJson } from "../core/models.js";
import type { ContentDigest } from "../core/models.js";

import {
  digestBytes,
  digestValue,
  validatePortablePath,
  validateVersionedAssetId,
  type DatasetId,
  type JsonObject,
  type JsonValue,
  type LabelId,
} from "../core/models.js";

function object(value: unknown, field: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function string(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

async function json(file: string): Promise<Record<string, JsonValue>> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${file} must be a regular file`);
  return object(JSON.parse(await readFile(file, "utf8")), file);
}

function datasetSlug(datasetId: DatasetId): string {
  return String(datasetId).replace(/^dataset\./u, "").replace(/\/v[1-9][0-9]*$/u, "");
}

function currentDatasetDirectoryName(datasetId: DatasetId): string {
  const slug = datasetSlug(datasetId);
  return slug.startsWith("harbor-") ? slug.slice("harbor-".length) : slug;
}

export async function currentQuestionCases(root: string, datasetId: DatasetId): Promise<readonly string[]> {
  const group = path.join(root, currentDatasetDirectoryName(datasetId));
  const groupInfo = await lstat(group).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (groupInfo === undefined || !groupInfo.isDirectory() || groupInfo.isSymbolicLink()) return Object.freeze([]);
  const files: string[] = [];
  for (const entry of await readdir(group, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(group, entry.name, "question.json");
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (info?.isFile() && !info.isSymbolicLink()) files.push(candidate);
  }
  return Object.freeze(files.sort((left, right) => left.localeCompare(right, "en")));
}

/** Planner 的可用题量以磁盘上的真实 question.json 为准，不信任 Catalog 中可能过期的声明。 */
export async function countDatasetQuestionCases(root: string, datasetId: DatasetId): Promise<number> {
  return (await currentQuestionCases(root, datasetId)).length;
}

function mediaType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".webp": return "image/webp";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".json": return "application/json";
    case ".txt":
    case ".md": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

export interface CaseInputFile {
  readonly source: string;
  readonly destination: string;
  readonly delivery: "workspace" | "chat-attachment";
  readonly mediaType: string;
  readonly sha256: string;
}

export interface DatasetCase {
  readonly version: string;
  readonly caseId: string;
  readonly task: string;
  readonly deadlineMs: number;
  readonly inputs: readonly CaseInputFile[];
  readonly seedEntries: readonly JsonObject[];
  readonly allowedPaths: readonly string[];
  readonly labelIds: readonly LabelId[];
  readonly grading: JsonObject;
  readonly question: JsonObject;
  readonly contentDigest: ContentDigest;
}
async function currentCase(questionFile: string, selectedLabels: readonly LabelId[]): Promise<DatasetCase> {
  const question = await json(questionFile);
  if (question.schema !== "evaldock.question/v1") throw new Error(`${questionFile} has an unsupported schema`);
  const questionId = string(question.id, "question.id");
  const task = object(question.task, "question.task");
  const environment = object(question.environment, "question.environment");
  if (environment.platform !== "darwin" && environment.platform !== "portable") {
    throw new Error(`${questionId} is not compatible with the macOS Worker`);
  }
  const timeoutSeconds = Number(environment.timeoutSeconds);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error(`${questionId} timeoutSeconds is invalid`);
  const declaredLabels = Array.isArray(question.capabilityLabels)
    ? question.capabilityLabels.map((value, index) => validateVersionedAssetId<"LabelId">(
        `label.${string(value, `capabilityLabels[${index}]`)}/v1`,
        `capabilityLabels[${index}]`,
      ))
    : [];
  const selectedLabelSet = new Set(selectedLabels.map(String));
  if (declaredLabels.length === 0 || declaredLabels.some((labelId) => !selectedLabelSet.has(String(labelId)))) {
    throw new Error(`${questionId} labels are not covered by the selected Dataset catalog labels`);
  }

  const caseRoot = path.dirname(questionFile);
  const inputs: CaseInputFile[] = [];
  const destinations = new Set<string>();
  const entries: JsonObject[] = [
    { entryType: "DIRECTORY", mode: "0555", portablePath: "input", readOnlyForTarget: true },
    { entryType: "DIRECTORY", mode: "0775", portablePath: "output", readOnlyForTarget: false },
  ];
  if (!Array.isArray(question.inputs)) throw new Error(`${questionId} question.inputs must be an array`);
  for (const [index, rawInput] of question.inputs.entries()) {
    const item = object(rawInput, `question.inputs[${index}]`);
    const source = string(item.source, `question.inputs[${index}].source`);
    const destination = validatePortablePath(item.destination, `question.inputs[${index}].destination`);
    if (!String(destination).startsWith("input/")) throw new Error(`${questionId} input destination must stay under input/`);
    validatePortablePath(source, "inputs.source");
    if (!source.startsWith("input/")) throw new Error("Public input source must stay under input/");
    if (destinations.has(String(destination))) throw new Error("Duplicate input destination");
    destinations.add(String(destination));
    const delivery = item.delivery ?? "workspace";
    if (delivery !== "workspace" && delivery !== "chat-attachment") throw new Error("Unsupported input delivery");
    const sourcePath = path.resolve(caseRoot, source);
    const relative = path.relative(caseRoot, sourcePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${questionId} input source escapes its Case directory`);
    }
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${questionId} input source must be a regular file`);
    const canonical = await realpath(sourcePath);
    const publicRoot = path.join(await realpath(caseRoot), "input") + path.sep;
    if (!canonical.startsWith(publicRoot)) throw new Error("Public input resolves outside input/");
    const bytes = await readFile(sourcePath);
    const type = mediaType(sourcePath);
    inputs.push({source, destination: String(destination), delivery, mediaType:type, sha256:digestBytes(bytes).value});
    // 作者提供摘要时必须核验；未提供时，实际字节仍由Case/Artifact 摘要冻结。
    // 不回写题库，也不把不匹配的已声明摘要替换为计算值。
    if (item.sha256 !== undefined) {
      const declaredSha256 = string(item.sha256, `question.inputs[${index}].sha256`);
      if (!/^[a-f0-9]{64}$/u.test(declaredSha256) || digestBytes(bytes).value !== declaredSha256) {
        throw new Error(`${questionId} input digest mismatch`);
      }
    }
    entries.push({
      entryType: "FILE",
      mode: "0444",
      portablePath: String(destination),
      readOnlyForTarget: true,
      encoding: "base64",
      content: bytes.toString("base64"),
      mediaType: mediaType(sourcePath),
    });
  }

  // Environment provisioning is manual. No setup dispatch or Case-requirement check.
  const promptFile = path.join(caseRoot, "prompt.md");
  const instructions = await readFile(promptFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return string(task.instructions, "task.instructions");
  });
  // Revalidate public task text and input mapping at load time, including prompt.md overrides.
  if (question.benchdock !== undefined) {
    const origin = object(question.benchdock, "question.benchdock");
    const provenancePath = path.join(caseRoot, "PROVENANCE.json");
    const info = await lstat(provenancePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("BenchDock provenance must be a regular file");
    const bytes = await readFile(provenancePath);
    const record = object(JSON.parse(bytes.toString("utf8")), "BenchDock provenance");
    if (origin.repo_id !== "EvalDock/BenchDock" || origin.task_id !== questionId ||
        question.version !== origin.revision || record.schema !== "benchdock.catalog/v1" ||
        record.distribution !== "bundled" || record.task_id !== questionId ||
        digestBytes(bytes).value !== origin.task_record_sha256 ||
        record.prompt !== instructions || task.instructions !== instructions || record.title !== question.title) {
      throw new Error("BenchDock task differs from its pinned source record");
    }
    if (!Array.isArray(record.inputs) || record.inputs.length !== inputs.length) throw new Error("BenchDock input mapping differs from its source record");
    for (const [index, raw] of record.inputs.entries()) {
      const expected = object(raw, "BenchDock source input"), actual = inputs[index]!;
      if (actual.source !== expected.destination || actual.destination !== expected.destination ||
          actual.sha256 !== expected.sha256 || actual.delivery !== "workspace") {
        throw new Error("BenchDock input mapping differs from its source record");
      }
    }
  }
  const rawAllowedEdits = environment.allowedEdits ?? ["output/**"];
  if (!Array.isArray(rawAllowedEdits) || rawAllowedEdits.length === 0) {
    throw new Error(`${questionId} allowedEdits must be a non-empty array`);
  }
  const allowedPaths = Object.freeze([...new Set(rawAllowedEdits.map((entry, index) => {
    const pattern = string(entry, `environment.allowedEdits[${index}]`);
    const portable = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    if (/[?*\[\]{}]/u.test(portable)) throw new Error(`${questionId} allowedEdits pattern is unsupported`);
    const normalized = String(validatePortablePath(portable, "environment.allowedEdits"));
    if (["input", "private", "checks"].some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
      throw new Error(`${questionId} allowedEdits overlaps protected inputs or evaluator material`);
    }
    return normalized;
  }))].sort());

  // Case grading material is a reference for the label Judge, never an executable check.
  const grading = object(question.grading ?? {}, "question.grading");
  if(grading.weight!==undefined && (typeof grading.weight!=="number" || !Number.isFinite(grading.weight) || grading.weight<0))throw new Error("grading.weight must be a finite nonnegative number");
  let resolvedGrading: JsonObject;
  if (grading.mode === "unavailable") {
    if (Object.keys(grading).some(key => !["mode", "reason", "weight"].includes(key)) || grading.reason !== "PRIVATE_EVALUATOR_NOT_DISTRIBUTED") {
      throw new Error("Execution-only Cases must not carry evaluator references");
    }
    resolvedGrading = grading;
  } else {
    if (grading.mode !== undefined && grading.mode !== "reference") throw new Error("Unsupported grading mode");
    const referenceFile = string(grading.reference ?? "private/final.json", "grading.reference");
    validatePortablePath(referenceFile, "grading.reference");
    if (!referenceFile.startsWith("private/")) throw new Error("Grading reference must stay under private/");
    const referencePath = path.resolve(caseRoot, referenceFile);
    const privateRoot = path.join(await realpath(caseRoot), "private") + path.sep;
    if (!(await realpath(referencePath)).startsWith(privateRoot)) throw new Error("Grading reference escapes private/");
    const reference = await json(referencePath);
    resolvedGrading = { ...grading, reference, ...(question.evidence === undefined ? {} : { evidenceGuidance: question.evidence }) };
  }

  const result = {
    version: string(question.version, "question.version"),
    caseId: `scenario.${questionId.replace(/^harbor\./u, "harbor-")}/v1`,
    task: instructions,
    deadlineMs: timeoutSeconds * 1000,
    inputs: Object.freeze(inputs),
    seedEntries: Object.freeze(entries),
    allowedPaths,
    labelIds: Object.freeze(declaredLabels),
    question,
    grading: resolvedGrading,
  };
  return freezeJson({ ...result, contentDigest: digestValue(result) });
}

/** 只加载 Case；不会读取 labels、Trace 配置，也不生成 Judge/Metric/Gate。 */
export async function loadDatasetCase(input: {
  readonly datasetsRoot: string; readonly datasetId: DatasetId;
  readonly labelIds: readonly LabelId[]; readonly caseIndex?: number;
}): Promise<DatasetCase> {
  const index = input.caseIndex ?? 0;
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("caseIndex must be non-negative");
  const cases = await currentQuestionCases(input.datasetsRoot,input.datasetId);
  const file = cases[index];
  if (file === undefined) throw new Error("Dataset Case is unavailable");
  return currentCase(file,input.labelIds);
}
