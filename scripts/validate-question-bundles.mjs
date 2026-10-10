#!/usr/bin/env node

/** Read-only validation of evaldock.question/v1 bundles; does not execute agents or upstream evaluators. */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetsRoot = path.join(repoRoot, "datasets");
const hashPattern = /^[0-9a-f]{64}$/u;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, field) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${field}: expected object`);
  return value;
}

function fields(value, required, optional, field) {
  object(value, field);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  requireValue(missing.length === 0 && extra.length === 0,
    `${field}: missing=[${missing.join(",")}] unknown=[${extra.join(",")}]`);
}

function string(value, field) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${field}: expected nonempty string`);
  return value;
}

function array(value, field, nonempty = false) {
  requireValue(Array.isArray(value) && (!nonempty || value.length > 0), `${field}: expected ${nonempty ? "nonempty " : ""}array`);
  return value;
}

function strings(value, field, nonempty = false) {
  array(value, field, nonempty).forEach((item, index) => string(item, `${field}[${index}]`));
  requireValue(new Set(value).size === value.length, `${field}: duplicate entries`);
  return value;
}

function portablePath(value, field, prefix) {
  string(value, field);
  requireValue(!/[\\\u0000-\u001f\u007f:]/u.test(value) && !path.posix.isAbsolute(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."), `${field}: unsafe relative path`);
  if (prefix !== undefined) requireValue(value.startsWith(`${prefix}/`), `${field}: must be inside ${prefix}/`);
  return value;
}

async function regular(file, kind) {
  const info = await lstat(file);
  requireValue(!info.isSymbolicLink(), `${file}: symbolic links are forbidden`);
  requireValue(kind === "directory" ? info.isDirectory() : info.isFile(), `${file}: expected regular ${kind}`);
  return info;
}

async function localPath(root, relative, kind = "file") {
  portablePath(relative, relative);
  await regular(root, "directory");
  const parts = relative.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    await regular(current, index === parts.length - 1 ? kind : "directory");
  }
  return current;
}

async function jsonFile(file) {
  await regular(file, "file");
  return object(JSON.parse(await readFile(file, "utf8")), file);
}

async function walkFiles(root, relative = "") {
  await regular(root, "directory");
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const info = await lstat(child);
    requireValue(!info.isSymbolicLink(), `${child}: symbolic links are forbidden`);
    if (info.isDirectory()) files.push(...await walkFiles(child, name));
    else {
      requireValue(info.isFile(), `${child}: special files are forbidden`);
      files.push(name);
    }
  }
  return files;
}

async function knownLabels() {
  const root = path.join(repoRoot, "labels");
  await regular(root, "directory");
  const labels = new Set();
  for (const name of (await readdir(root)).filter((name) => name.endsWith(".json"))) {
    const label = await jsonFile(path.join(root, name));
    requireValue(typeof label.labelId === "string" && /^label\.[a-z0-9-]+\/v1$/u.test(label.labelId), `${name}: invalid labelId`);
    requireValue(!labels.has(label.labelId), `${name}: duplicate labelId`);
    labels.add(label.labelId);
  }
  requireValue(labels.size > 0, "no label assets found");
  return labels;
}

async function globalIds() {
  await regular(datasetsRoot, "directory");
  const ids = new Map();
  const matchingIds = new Map();
  let count = 0;
  for (const dataset of await readdir(datasetsRoot, { withFileTypes: true })) {
    requireValue(!dataset.isSymbolicLink(), `${dataset.name}: symbolic links are forbidden`);
    if (!dataset.isDirectory()) continue;
    const directory = path.join(datasetsRoot, dataset.name);
    for (const bundle of await readdir(directory, { withFileTypes: true })) {
      requireValue(!bundle.isSymbolicLink(), `${dataset.name}/${bundle.name}: symbolic links are forbidden`);
      if (!bundle.isDirectory()) continue;
      const file = path.join(directory, bundle.name, "question.json");
      const info = await lstat(file).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info === undefined) continue;
      const question = await jsonFile(file);
      for (const [value, map, field] of [[question.id, ids, "id"], [question.matching?.datasetId, matchingIds, "matching.datasetId"]]) {
        string(value, `${file}.${field}`);
        requireValue(!map.has(value), `duplicate ${field} ${value}: ${map.get(value)} and ${file}`);
        map.set(value, file);
      }
      count += 1;
    }
  }
  return count;
}

function checkpoints(value, field) {
  fields(value, ["description", "checkpoints"], [], field);
  string(value.description, `${field}.description`);
  const ids = new Set();
  for (const item of array(value.checkpoints, `${field}.checkpoints`, true)) {
    fields(item, ["id", "description"], [], `${field}.checkpoint`);
    requireValue(slugPattern.test(string(item.id, `${field}.checkpoint.id`)), `${field}: invalid checkpoint id`);
    requireValue(!ids.has(item.id), `${field}: duplicate checkpoint id ${item.id}`);
    ids.add(item.id);
    string(item.description, `${field}.checkpoint.description`);
  }
}

async function validateBundle(root, labels) {
  const files = await walkFiles(root);
  const question = await jsonFile(await localPath(root, "question.json"));
  fields(question, ["schema", "id", "version", "title", "matching", "source", "capabilityLabels", "task", "environment", "inputs", "grading", "evidence"], [], "question");
  requireValue(question.schema === "evaldock.question/v1", "question.schema: expected evaldock.question/v1");
  requireValue(/^\d+\.\d+\.\d+$/u.test(string(question.version, "question.version")), "question.version: expected semantic version");
  requireValue(slugPattern.test(string(question.title, "question.title")) && question.title === path.basename(root), "question.title: must equal bundle directory slug");
  requireValue(/^[a-z0-9-]+\.[a-z0-9-]+$/u.test(string(question.id, "question.id")) && question.id.endsWith(`.${question.title}`), "question.id: expected owner.title");
  fields(question.matching, ["datasetId", "description"], [], "matching");
  requireValue(question.matching.datasetId === `dataset.${question.id}/v1`, "matching.datasetId: must match question.id");
  string(question.matching.description, "matching.description");
  for (const label of strings(question.capabilityLabels, "capabilityLabels", true)) {
    requireValue(labels.has(`label.${label}/v1`), `capabilityLabels: unknown label ${label}`);
  }

  const source = question.source;
  fields(source, ["repository", "commit", "taskPath", "files", "adaptationChanges"], ["upstreamMetadata"], "source");
  const repository = new URL(string(source.repository, "source.repository"));
  requireValue(repository.protocol === "https:" && !repository.username && !repository.password, "source.repository: expected HTTPS URL without credentials");
  requireValue(/^[0-9a-f]{40}$/u.test(string(source.commit, "source.commit")), "source.commit: expected pinned 40-digit commit");
  string(source.taskPath, "source.taskPath");
  strings(source.adaptationChanges, "source.adaptationChanges", true);
  const provenancePaths = new Set();
  for (const file of array(source.files, "source.files", true)) {
    fields(file, ["path", "sha256"], [], "source.files entry");
    string(file.path, "source.files.path");
    requireValue(hashPattern.test(file.sha256), "source.files.sha256: invalid SHA-256");
    requireValue(!provenancePaths.has(file.path), `source.files: duplicate path ${file.path}`);
    provenancePaths.add(file.path);
  }
  if (source.upstreamMetadata !== undefined) object(source.upstreamMetadata, "source.upstreamMetadata");
  fields(question.task, ["instructions"], [], "task");
  string(question.task.instructions, "task.instructions");
  requireValue(!/report UNEVALUABLE/u.test(question.task.instructions),
    "task.instructions: must not instruct the agent to write the judge verdict UNEVALUABLE");

  const environment = question.environment;
  fields(environment, ["platform", "timeoutSeconds"], ["dependencies", "reset", "upstreamConstraints", "allowedEdits"], "environment");
  requireValue(["darwin", "portable"].includes(environment.platform), "environment.platform: expected darwin or portable");
  requireValue(Number.isSafeInteger(environment.timeoutSeconds) && environment.timeoutSeconds > 0, "environment.timeoutSeconds: expected positive integer");
  strings(environment.dependencies ?? [], "environment.dependencies");
  if (environment.upstreamConstraints !== undefined) object(environment.upstreamConstraints, "environment.upstreamConstraints");
  const sources = new Set();
  const destinations = new Set();
  let inputBytes = 0;
  for (const input of array(question.inputs, "question.inputs")) {
    fields(input, ["source", "destination", "delivery"], ["sha256"], "question.inputs entry");
    requireValue(["workspace","chat-attachment"].includes(input.delivery),"unsupported input delivery");
    portablePath(input.source, "input.source", "input");
    portablePath(input.destination, "input.destination", "input");
    requireValue(!sources.has(input.source), `duplicate input source ${input.source}`);
    const normalizedDestination = input.destination.normalize("NFC").toLocaleLowerCase("en");
    requireValue(![...destinations].some((value) => {
      const previous = value.normalize("NFC").toLocaleLowerCase("en");
      return previous === normalizedDestination || previous.startsWith(`${normalizedDestination}/`) || normalizedDestination.startsWith(`${previous}/`);
    }), `duplicate or overlapping input destination ${input.destination}`);
    requireValue(input.sha256 === undefined || hashPattern.test(input.sha256), `input ${input.source}: invalid SHA-256`);
    const bytes = await readFile(await localPath(root, input.source));
    requireValue(input.sha256 === undefined || createHash("sha256").update(bytes).digest("hex") === input.sha256, `input ${input.source}: SHA-256 mismatch`);
    sources.add(input.source);
    destinations.add(input.destination);
    inputBytes += bytes.length;
  }
  for (const file of files.filter((file) => file.startsWith("input/"))) {
    requireValue(sources.has(file), `undeclared public asset ${file}`);
  }
  object(question.grading,"grading");
  portablePath(question.grading.reference,"grading.reference","private");
  const final = await jsonFile(await localPath(root, "private/final.json"));
  object(final, "private grading reference");
  fields(question.evidence, ["process", "local"], [], "evidence");
  checkpoints(question.evidence.process, "evidence.process");
  checkpoints(question.evidence.local, "evidence.local");

  return { inputCount: sources.size, inputBytes };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: node scripts/validate-question-bundles.mjs [datasets/<directory> ...]\nDefaults: every dataset directory except legacy attention-pytorch. Read-only; validates format and local assets, not runtime readiness or remote provenance.\n");
    return;
  }
  const directories = args.length > 0 ? args.map((item) => path.resolve(item))
    : (await readdir(datasetsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "attention-pytorch")
      .map((entry) => path.join(datasetsRoot, entry.name));
  requireValue(new Set(directories).size === directories.length, "duplicate target directories");
  const labels = await knownLabels();
  const globalCount = await globalIds();
  let total = 0;
  let inputCount = 0;
  let inputBytes = 0;
  const errors = [];
  for (const directory of directories) {
    const relative = path.relative(datasetsRoot, directory);
    try {
      portablePath(relative, "target directory");
      await localPath(datasetsRoot, relative, "directory");
      const bundles = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      requireValue(bundles.length > 0, `${relative}: no bundle directories`);
      let valid = 0;
      for (const bundle of bundles.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
        try {
          const result = await validateBundle(path.join(directory, bundle.name), labels);
          total += 1;
          valid += 1;
          inputCount += result.inputCount;
          inputBytes += result.inputBytes;
        } catch (error) { errors.push(`${relative}/${bundle.name}: ${error.message}`); }
      }
      process.stdout.write(`${relative}: ${valid}/${bundles.length} valid bundles\n`);
    } catch (error) { errors.push(`${relative}: ${error.message}`); }
  }
  for (const error of errors) process.stderr.write(`FAIL ${error}\n`);
  process.stdout.write(`${errors.length === 0 ? "PASS" : "FAIL"}: ${total} bundles, ${inputCount} verified input hashes, ${inputBytes} input bytes; ${globalCount} global bundle IDs checked.\n`);
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error.message}\n`);
  process.exitCode = 1;
});
