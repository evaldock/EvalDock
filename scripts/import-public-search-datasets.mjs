#!/usr/bin/env node

/** 将 AGENT_DATASETS.md 指向的 SimpleQA 与 FRAMES 官方数据转换为逐题 Question Bundle。 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { convertFlatDatasets } from "./convert-flat-datasets-to-question-bundles.mjs";

// 固定开发子集：SimpleQA 同时均衡 10 个 topic 与 5 个 answer_type；
// FRAMES 优先保留多标签、多跳且不依赖“截至当前”动态事实的题目。
const CURATED_ORDINALS = Object.freeze({
  simpleQA: new Set([
    9, 24, 36, 40, 47, 49, 62, 68, 76, 78,
    84, 86, 90, 94, 105, 108, 111, 124, 126, 145,
    147, 152, 220, 223, 292, 356, 520, 1495, 2141, 4218,
  ]),
  frames: new Set([
    1, 10, 22, 35, 55, 61, 63, 65, 80, 90,
    101, 126, 162, 172, 190, 245, 256, 285, 316, 320,
    322, 345, 374, 460, 509, 703, 746, 759, 769, 784,
  ]),
});

const [, , simpleQaArgument, framesArgument, datasetsArgument = "datasets"] = process.argv;
if (!simpleQaArgument || !framesArgument) {
  throw new Error(
    "usage: import-public-search-datasets.mjs <simple_qa_test_set.csv> <frames_test.tsv> [datasets-dir]",
  );
}

function parseDelimited(source, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  const [header, ...records] = rows;
  if (!header) throw new Error("source data has no header");
  return records.filter((values) => values.some(Boolean)).map((values, rowIndex) => {
    if (values.length !== header.length) {
      throw new Error(`row ${rowIndex + 2} has ${values.length} fields; expected ${header.length}`);
    }
    return Object.fromEntries(header.map((name, index) => [name.trim(), values[index] ?? ""]));
  });
}

function urls(value) {
  return [...new Set(String(value).match(/https?:\/\/[^'"\],\s]+/gu) ?? [])];
}

function pythonMetadataValue(source, key) {
  const match = source.match(new RegExp(`['"]${key}['"]\\s*:\\s*(['"])(.*?)\\1`, "u"));
  return match?.[2] ?? "";
}

function outputQuestion(question) {
  return `${question.trim()}\n\nWrite the final answer to output/answer.txt.`;
}

function referenceAnswer(answer) {
  return {
    required_artifact: "output/answer.txt",
    requirements: [
      "The answer must be semantically equivalent to ground_truth and contain no contradictory claims.",
      "The final answer must be written to output/answer.txt.",
    ],
    ground_truth: answer.trim(),
  };
}

function serialize(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function numberCuratedCase(record, index) {
  const ordinal = String(index + 1).padStart(4, "0");
  return {
    ...record,
    sample_id: `${record.dataset}-${ordinal}`,
    question_id: `${record.dataset}:${ordinal}`,
  };
}

const simpleQaSource = await readFile(path.resolve(simpleQaArgument), "utf8");
const simpleQaRows = parseDelimited(simpleQaSource, ",");
if (simpleQaRows.length !== 4_326) {
  throw new Error(`expected 4326 SimpleQA rows, received ${simpleQaRows.length}`);
}
const simpleQaCases = simpleQaRows.map((row, index) => {
  const ordinal = index + 1;
  const evidence = urls(row.metadata);
  return {
    schema_version: "1.0",
    dataset: "simpleqa",
    sample_id: `simpleqa-${ordinal}`,
    question_id: `simpleqa:${ordinal}`,
    question: outputQuestion(row.problem),
    reference_answer: referenceAnswer(row.answer),
    evidence,
    choices: [],
    evaluator: "label_llm_judges",
    metadata: {
      topic: pythonMetadataValue(row.metadata, "topic"),
      answer_type: pythonMetadataValue(row.metadata, "answer_type"),
      source_urls: evidence,
      source_row: ordinal,
      source_dataset: "https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv",
      source_paper: "arXiv:2411.04368",
    },
  };
}).filter((record) => CURATED_ORDINALS.simpleQA.has(record.metadata.source_row)).map(numberCuratedCase);

const framesSource = await readFile(path.resolve(framesArgument), "utf8");
const framesRows = parseDelimited(framesSource, "\t");
if (framesRows.length !== 824) {
  throw new Error(`expected 824 FRAMES rows, received ${framesRows.length}`);
}
const framesCases = framesRows.map((row, index) => {
  const ordinal = index + 1;
  const evidence = urls(row.wiki_links);
  return {
    schema_version: "1.0",
    dataset: "frames",
    sample_id: `frames-${ordinal}`,
    question_id: `frames:${ordinal}`,
    question: outputQuestion(row.Prompt),
    reference_answer: referenceAnswer(row.Answer),
    evidence,
    choices: [],
    evaluator: "label_llm_judges",
    metadata: {
      reasoning_types: row.reasoning_types.split("|").map((value) => value.trim()).filter(Boolean),
      source_urls: evidence,
      source_row: Number(row[""]) + 1,
      source_dataset: "https://huggingface.co/datasets/google/frames-benchmark/blob/main/test.tsv",
      source_paper: "arXiv:2409.12941",
    },
  };
}).filter((record) => CURATED_ORDINALS.frames.has(Number(record.sample_id.split("-").at(-1)))).map(numberCuratedCase);

const datasetsRoot = path.resolve(datasetsArgument);
await Promise.all([
  writeFile(path.join(datasetsRoot, "simpleQA", "cases.jsonl"), serialize(simpleQaCases), "utf8"),
  writeFile(path.join(datasetsRoot, "frames", "cases.jsonl"), serialize(framesCases), "utf8"),
  writeFile(path.join(datasetsRoot, "simpleQA", "dataset.json"), `${JSON.stringify({
    schema: "evaldock.dataset/v1",
    datasetId: "dataset.simpleqa/v1",
    version: "1.1.0",
    catalogRef: "../catalog.md",
    casesFile: "cases.jsonl",
    caseCount: simpleQaCases.length,
    environmentId: "environment.macos/v1",
  }, null, 2)}\n`, "utf8"),
  writeFile(path.join(datasetsRoot, "frames", "dataset.json"), `${JSON.stringify({
    schema: "evaldock.dataset/v1",
    datasetId: "dataset.frames/v1",
    version: "1.1.0",
    catalogRef: "../catalog.md",
    casesFile: "cases.jsonl",
    caseCount: framesCases.length,
    environmentId: "environment.macos/v1",
  }, null, 2)}\n`, "utf8"),
]);
await convertFlatDatasets(path.dirname(datasetsRoot), ["simpleQA", "frames"]);
process.stdout.write(`SimpleQA ${simpleQaCases.length}; FRAMES ${framesCases.length} -> Question Bundles\n`);
