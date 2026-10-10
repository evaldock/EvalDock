/** 只读取 datasets/catalog.md 中的 Dataset 描述、标签和题量，不读取 Label、Observer 或 Judge。 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { validateVersionedAssetId } from "../core/models.js";
import type { DatasetCandidate } from "../planning/planner.js";

const CATALOG_FIELDS = ["schema", "version", "datasets"] as const;
const DATASET_FIELDS = [
  "datasetId",
  "name",
  "description",
  "labelIds",
  "availableCaseCount",
  "estimatedSecondsPerCase",
] as const;

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${field} fields differ (unknown=${unknown.join(",") || "-"}, missing=${missing.join(",") || "-"})`);
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

/** 读取一个无符号链接的标准目录文件，返回稳定排序的候选。 */
export async function loadDatasetDescriptionCatalog(catalogPath: string): Promise<readonly DatasetCandidate[]> {
  const absolute = path.resolve(catalogPath);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Dataset description catalog must be a regular non-symlink file");
  }
  const canonical = await realpath(absolute);
  const source = await readFile(canonical, "utf8");
  const payload = canonical.endsWith(".md")
    ? source.match(/```json evaldock-dataset-catalog\s*\n([\s\S]*?)\n```/u)?.[1]
    : source;
  if (payload === undefined) throw new Error("Dataset Markdown must contain one evaldock-dataset-catalog JSON block");
  const root = asObject(JSON.parse(payload) as unknown, "Dataset catalog");
  exactFields(root, CATALOG_FIELDS, [], "Dataset catalog");
  if (root.schema !== "evaldock.dataset-planner-catalog/v1" || typeof root.version !== "string") {
    throw new Error("Dataset catalog schema or version is invalid");
  }
  if (!Array.isArray(root.datasets) || root.datasets.length === 0) {
    throw new Error("Dataset catalog must contain at least one Dataset");
  }
  const ids = new Set<string>();
  const candidates = root.datasets.map((raw, index) => {
    const item = asObject(raw, `datasets[${index}]`);
    exactFields(item, DATASET_FIELDS.slice(0, 5), [DATASET_FIELDS[5]!], `datasets[${index}]`);
    const datasetId = validateVersionedAssetId<"DatasetId">(item.datasetId, `datasets[${index}].datasetId`);
    if (ids.has(datasetId)) throw new Error("Dataset catalog IDs must be unique");
    ids.add(datasetId);
    if (typeof item.name !== "string" || item.name.trim().length === 0 ||
      typeof item.description !== "string" || item.description.trim().length === 0) {
      throw new Error(`datasets[${index}] name and description must be non-empty`);
    }
    if (!Array.isArray(item.labelIds) || item.labelIds.length === 0) {
      throw new Error(`datasets[${index}].labelIds must not be empty`);
    }
    const labelIds = item.labelIds.map((labelId, labelIndex) =>
      validateVersionedAssetId<"LabelId">(labelId, `datasets[${index}].labelIds[${labelIndex}]`));
    if (new Set(labelIds).size !== labelIds.length) {
      throw new Error(`datasets[${index}].labelIds must be unique`);
    }
    return Object.freeze({
      datasetId,
      name: item.name.trim(),
      description: item.description.trim(),
      labelIds: Object.freeze(labelIds.sort((left, right) => left.localeCompare(right, "en"))),
      availableCaseCount: positiveInteger(item.availableCaseCount, `datasets[${index}].availableCaseCount`),
      ...(item.estimatedSecondsPerCase === undefined ? {} : {
        estimatedSecondsPerCase: positiveInteger(item.estimatedSecondsPerCase, `datasets[${index}].estimatedSecondsPerCase`),
      }),
    });
  });
  return Object.freeze(candidates.sort((left, right) => left.datasetId.localeCompare(right.datasetId, "en")));
}
