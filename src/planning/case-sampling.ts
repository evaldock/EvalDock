/** Shared difficulty sampling for DSH and peer adapters; does not change grading weights. */
import {createHash, randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {validateStableId, type DatasetId} from "../core/models.js";
import {currentQuestionCases} from "../datasets/loader.js";
import type {DatasetCandidate, DatasetSelectionPlan} from "./planner.js";

const levels = ["EASY", "MEDIUM", "HARD"] as const;
type Level = typeof levels[number];
type ObservedLevel = Level | "UNKNOWN";
type Counts = Record<Level, number>;
export interface SamplingCase {
  readonly datasetId: DatasetId;
  readonly caseIndex: number;
  readonly caseId: string;
  readonly difficulty: ObservedLevel;
}
interface CasePool {readonly datasetId: DatasetId; readonly count: number; readonly cases: readonly SamplingCase[];}
const emptyCounts = (): Counts => ({EASY: 0, MEDIUM: 0, HARD: 0});
const isLevel = (value: unknown): value is Level => levels.includes(value as Level);

function randomSource(seed: string): () => number {
  let counter = 0;
  return () => createHash("sha256").update(`${seed}:${counter++}`).digest().readUInt32BE(0) / 0x100000000;
}
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Small bipartite flow: preserve each Dataset allocation while satisfying as many tier slots as possible. */
export function sampleDifficultyPools(pools: readonly CasePool[], percentages: Counts, seed: string) {
  if (!seed || levels.some(k => !Number.isFinite(percentages[k]) || percentages[k] < 0) ||
      levels.reduce((n, k) => n + percentages[k], 0) !== 100) throw Error("Invalid sampling percentages or seed");
  const ids = new Set<string>(), datasetIds = new Set<string>();
  for (const pool of pools) {
    if (datasetIds.has(pool.datasetId)) throw Error("Duplicate sampling Dataset");
    datasetIds.add(pool.datasetId);
    if (!Number.isSafeInteger(pool.count) || pool.count < 1 || pool.count > pool.cases.length) throw Error("Insufficient Dataset Cases");
    for (const item of pool.cases) {
      if (ids.has(item.caseId) || item.datasetId !== pool.datasetId || (!isLevel(item.difficulty) && item.difficulty !== "UNKNOWN")) throw Error("Invalid sampling pool");
      ids.add(item.caseId);
    }
  }
  const random = randomSource(seed), ordered = shuffled(pools, random);
  const total = pools.reduce((n, p) => n + p.count, 0), target = emptyCounts();
  for (const k of levels) target[k] = Math.floor(total * percentages[k] / 100);
  const remainderOrder = shuffled(levels, random).sort((a, b) =>
    (total * percentages[b] / 100 - target[b]) - (total * percentages[a] / 100 - target[a]));
  const remaining = total - levels.reduce((n, k) => n + target[k], 0);
  for (let i = 0; i < remaining; i++) target[remainderOrder[i]!]++;

  type Edge = {to: number; reverse: number; capacity: number; initial: number};
  const sink = ordered.length + 4, graph: Edge[][] = Array.from({length: sink + 1}, () => []);
  function edge(from: number, to: number, capacity: number): Edge {
    const forward = {to, reverse: graph[to]!.length, capacity, initial: capacity};
    graph[from]!.push(forward);
    graph[to]!.push({to: from, reverse: graph[from]!.length - 1, capacity: 0, initial: 0});
    return forward;
  }
  const tierEdges: Array<Partial<Record<Level, Edge>>> = [];
  const buckets = ordered.map((pool, i) => {
    edge(0, i + 1, pool.count);
    const b = Object.fromEntries(levels.map(k => [k, shuffled(pool.cases.filter(c => c.difficulty === k), random)])) as Record<Level, SamplingCase[]>;
    const links: Partial<Record<Level, Edge>> = {};
    for (const k of shuffled(levels, random)) links[k] = edge(i + 1, ordered.length + 1 + levels.indexOf(k), b[k].length);
    tierEdges.push(links);
    return b;
  });
  levels.forEach((k, i) => edge(ordered.length + 1 + i, sink, target[k]));
  while (true) {
    const parents: Array<{from: number; edge: Edge} | undefined> = new Array(graph.length);
    const seen = new Set([0]), visit = [0];
    for (let cursor = 0; cursor < visit.length && !seen.has(sink); cursor++) {
      const from = visit[cursor]!;
      for (const e of graph[from]!) if (e.capacity > 0 && !seen.has(e.to)) {
        seen.add(e.to); parents[e.to] = {from, edge: e}; visit.push(e.to);
      }
    }
    if (!seen.has(sink)) break;
    let amount = Infinity;
    for (let at = sink; at !== 0; at = parents[at]!.from) amount = Math.min(amount, parents[at]!.edge.capacity);
    for (let at = sink; at !== 0; at = parents[at]!.from) {
      const e = parents[at]!.edge; e.capacity -= amount; graph[e.to]![e.reverse]!.capacity += amount;
    }
  }
  const selected: SamplingCase[] = [];
  ordered.forEach((pool, i) => {
    const chosen = levels.flatMap(k => {
      const e = tierEdges[i]![k]!;
      return buckets[i]![k].slice(0, e.initial - e.capacity);
    });
    const taken = new Set(chosen.map(c => c.caseId));
    const rest = shuffled(pool.cases.filter(c => !taken.has(c.caseId)), random);
    selected.push(...chosen, ...rest.slice(0, pool.count - chosen.length));
  });
  const actual = {...emptyCounts(), UNKNOWN: 0};
  selected.forEach(c => actual[c.difficulty]++);
  const shortfall = Object.fromEntries(levels.map(k => [k, Math.max(0, target[k] - actual[k])])) as Counts;
  return {queue: shuffled(selected, random), target, actual, shortfall, exact: levels.every(k => actual[k] === target[k]) && actual.UNKNOWN === 0};
}

async function optionalJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Descriptions-only hints; does not expose question bodies or private references to Planner. */
export async function withDifficultyHints(candidates: readonly DatasetCandidate[], difficultyFile: string): Promise<readonly DatasetCandidate[]> {
  const manifest = await optionalJson(difficultyFile);
  if (!manifest) return candidates;
  if (manifest.schema !== "evaldock.case-difficulty/v1" || !Array.isArray(manifest.cases)) throw Error("Invalid difficulty manifest");
  return candidates.map(candidate => {
    const directory = String(candidate.datasetId).replace(/^dataset\./, "").replace(/\/v\d+$/, "").replace(/^harbor-/, "");
    const counts = emptyCounts();
    for (const c of manifest.cases) { const level: unknown = c.level; if (String(c.questionPath).startsWith(`datasets/${directory}/`) && isLevel(level)) counts[level]++; }
    return {...candidate, description: candidate.description + `\n初版难度库存：简单 ${counts.EASY}，中等 ${counts.MEDIUM}，困难 ${counts.HARD}。在能力匹配和题量限制内，组合尽量接近简单20%、中等40%、困难40%；具体 Case 由系统分层随机抽取。`};
  });
}

/** Optional at project level for compatibility with embedded/fixture repositories. */
export async function samplePlannedCases(input: {
  root: string; datasetsRoot: string; selection: DatasetSelectionPlan; seed?: string;
}) {
  const policy = await optionalJson(path.join(input.root, "planning/case-sampling.json"));
  if (!policy || policy.enabled === false) return undefined;
  if (policy.schema !== "evaldock.case-sampling/v1" || policy.enabled !== true || !policy.percentages) throw Error("Invalid sampling policy");
  const manifest = await optionalJson(path.join(input.root, "planning/case-difficulty.json"));
  if (!manifest || manifest.schema !== "evaldock.case-difficulty/v1" || !Array.isArray(manifest.cases)) throw Error("Missing or invalid difficulty manifest");
  const byId = new Map<string, {level: unknown; questionSha256: string}>(manifest.cases.map((c: any) => [c.questionId, c]));
  if (byId.size !== manifest.cases.length) throw Error("Duplicate difficulty annotation");
  const annotationWarnings: string[] = [], pools: CasePool[] = [];
  for (const dataset of input.selection.selectedDatasets) {
    const files = await currentQuestionCases(input.datasetsRoot, dataset.datasetId);
    const cases: SamplingCase[] = [];
    for (const [caseIndex, file] of files.entries()) {
      const bytes = await readFile(file), question = JSON.parse(bytes.toString("utf8")), annotation = byId.get(question.id);
      const slug = String(dataset.datasetId).replace(/^dataset\./, "").replace(/\/v\d+$/, "");
      const caseId = validateStableId(`${slug}.case-${caseIndex + 1}`, "caseId");
      const valid = annotation && isLevel(annotation.level) && annotation.questionSha256 === createHash("sha256").update(bytes).digest("hex");
      if (!valid) annotationWarnings.push(`${caseId}:${annotation ? "STALE" : "UNCLASSIFIED"}`);
      cases.push({datasetId: dataset.datasetId, caseIndex, caseId, difficulty: valid ? annotation.level as Level : "UNKNOWN"});
    }
    pools.push({datasetId: dataset.datasetId, count: dataset.caseCount, cases});
  }
  const seed = input.seed ?? randomBytes(16).toString("hex");
  const result = sampleDifficultyPools(pools, policy.percentages, seed);
  return {queue: result.queue, metadata: {
    schema: "evaldock.case-sampling-result/v1", algorithm: "difficulty-constrained-random/v1", seed,
    policyVersion: policy.version, difficultyVersion: manifest.version, targetPercentages: policy.percentages,
    targetCounts: result.target, actualCounts: result.actual, shortfall: result.shortfall,
    exact: result.exact, annotationWarnings,
    warning: result.exact ? null : "题量取整后，在所选数据集和每集题量约束内无法完全满足目标比例；已从其余可用题目补齐。",
  }};
}
