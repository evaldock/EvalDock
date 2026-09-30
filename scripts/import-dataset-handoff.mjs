#!/usr/bin/env node

/** 把 Dataset 团队的 agent_dataset_description 文档转换为统一 Planner Catalog。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [, , sourceArgument, outputArgument] = process.argv;
if (!sourceArgument || !outputArgument) {
  throw new Error("usage: import-dataset-handoff.mjs <description.json> <catalog.json>");
}

const sourcePath = path.resolve(sourceArgument);
const outputPath = path.resolve(outputArgument);
const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (source?.format !== "agent_dataset_description" || !Array.isArray(source.sections)) {
  throw new Error("source must use agent_dataset_description format");
}

const stripMarkup = (value) => String(value).replaceAll("`", "").trim();
const labelId = (value) => {
  const normalized = stripMarkup(value).toLowerCase();
  const slug = normalized === "retrieval" ? "retrieval-grounding" : normalized.replaceAll(".", "-");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`invalid label token: ${value}`);
  return `label.${slug}/v1`;
};
const datasetSlug = (name) => name.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");

const overview = source.sections.find((section) => String(section.heading).includes("数据集差异总览"));
const overviewRows = overview?.tables?.[0]?.rows ?? [];
const datasets = [];
for (let index = 0; index < source.sections.length; index += 1) {
  const section = source.sections[index];
  const match = typeof section?.heading === "string"
    ? section.heading.match(/^[^、]+、(.+?)\s+30\s*题简化版$/u)
    : null;
  if (!match) continue;
  const name = match[1].trim();
  const details = [];
  for (let cursor = index + 1; cursor < source.sections.length; cursor += 1) {
    const next = source.sections[cursor];
    if (next.level === 2) break;
    details.push(next);
  }
  const labelSection = details.find((item) => String(item.heading).includes("本测试集对应的标签评分标准"));
  const labelRows = labelSection?.tables?.[0]?.rows ?? [];
  const labels = [...new Set(labelRows.map((row) => labelId(row[Object.keys(row)[0]])))].sort();
  if (labels.length === 0) throw new Error(`Dataset ${name} has no labels`);
  const row = overviewRows.find((item) => stripMarkup(item["数据集"]) === name);
  const summary = row ? Object.entries(row).map(([key, value]) => `${key}: ${stripMarkup(value)}`).join("\n") : "";
  const description = [
    summary,
    ...details.filter((item) => !String(item.heading).includes("标签评分标准"))
      .map((item) => `${item.heading}\n${item.markdown ?? ""}`),
  ].filter(Boolean).join("\n\n");
  const countMatch = section.heading.match(/(\d+)\s*题/u);
  const availableCaseCount = countMatch ? Number(countMatch[1]) : 30;
  datasets.push({
    datasetId: `dataset.${datasetSlug(name)}/v1`,
    name,
    description,
    labelIds: labels,
    availableCaseCount,
  });
}
if (datasets.length === 0) throw new Error("no Dataset sections were found");
datasets.sort((left, right) => left.datasetId.localeCompare(right.datasetId, "en"));
await mkdir(path.dirname(outputPath), { recursive: true });
const catalog = JSON.stringify({
  schema: "evaldock.dataset-planner-catalog/v1",
  version: String(source.version ?? "1.0"),
  datasets,
}, null, 2);
const output = outputPath.endsWith(".md")
  ? `# Dataset Catalog\n\n本文件是 Planning 唯一读取的数据集描述入口；题目正文位于各 Dataset 子目录。\n\n\`\`\`json evaldock-dataset-catalog\n${catalog}\n\`\`\`\n`
  : `${catalog}\n`;
await writeFile(outputPath, output, "utf8");
process.stdout.write(`${datasets.length} datasets -> ${outputPath}\n`);
