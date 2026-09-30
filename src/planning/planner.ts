/**
 * 文件功能：把真实 Agent 静态观测、外部 Dataset 描述目录和测试规模交给一次 LLM 请求，
 * 生成 Dataset 与题量计划。Dataset 标签由目录提供，模型不判断或生成 Agent 标签。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {withDifficultyHints} from "./case-sampling.js";

import type { DatasetId, JsonObject, JsonValue, LabelId } from "../core/models.js";
import { validateVersionedAssetId } from "../core/models.js";
import type { AgentStaticInfo } from "./agent-static.js";

const DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_TIMEOUT_MS = 60_000;

/** MVP 只保留一套经过验证的 STANDARD 规划策略。 */
export type DatasetTestProfile = "STANDARD";

export interface DatasetTestPolicy {
  readonly profile: DatasetTestProfile;
  readonly minDatasets: number;
  readonly maxDatasets: number;
  readonly minCasesPerDataset: number;
  readonly maxCasesPerDataset: number;
  readonly maxTotalCases: number;
}

const POLICY_SCHEMA = "evaldock.dataset-test-policies/v1";

/** Dataset 团队交给统一 Planner 的只读目录投影，不包含题目正文。 */
export interface DatasetCandidate {
  readonly datasetId: DatasetId;
  readonly name: string;
  readonly description: string;
  readonly labelIds: readonly LabelId[];
  readonly availableCaseCount: number;
  readonly estimatedSecondsPerCase?: number;
}

export interface TestSize { readonly datasetCount?: number; readonly casesPerDataset?: number; readonly maxCases?: number; readonly caseCount?: number; }

export function applyTestSize(policy:DatasetTestPolicy,size:TestSize = {}):DatasetTestPolicy {
  for(const [key,value] of Object.entries(size)) { assertPositiveInteger(value,key); if(value>10000)throw new Error(key+" exceeds 10000"); }
  if(size.caseCount!==undefined){
    if(size.maxCases!==undefined && size.caseCount>size.maxCases)throw new Error("caseCount exceeds maxCases");
    if(size.casesPerDataset!==undefined)throw new Error("Use caseCount or casesPerDataset, not both");
    size={...size,maxCases:size.caseCount};
  }
  const minDatasets=size.datasetCount??Math.min(policy.minDatasets,size.maxCases??policy.minDatasets);
  const maxDatasets=size.datasetCount??Math.min(policy.maxDatasets,size.maxCases??policy.maxDatasets);
  const minCasesPerDataset=size.casesPerDataset??(size.maxCases===undefined?policy.minCasesPerDataset:1);
  const maxCasesPerDataset=size.casesPerDataset??(Math.min(policy.maxCasesPerDataset,size.caseCount??size.maxCases??policy.maxCasesPerDataset));
  const maxTotalCases=size.maxCases??(size.datasetCount!==undefined||size.casesPerDataset!==undefined?maxDatasets*maxCasesPerDataset:policy.maxTotalCases);
  if(minDatasets*minCasesPerDataset>maxTotalCases)throw new Error("Requested Dataset/Case counts exceed maxCases");
  return {...policy,minDatasets,maxDatasets,minCasesPerDataset,maxCasesPerDataset,maxTotalCases};
}

export interface DatasetSelectionInput {
  readonly testSize?: TestSize;
  readonly agentStaticInfo: AgentStaticInfo;
  readonly availableDatasets: readonly DatasetCandidate[];
  readonly profile: DatasetTestProfile;
  readonly signal?: AbortSignal;
}

export interface SelectedDatasetAllocation {
  readonly datasetId: DatasetId;
  /** 由所选 Dataset 的目录标签确定性复制，不由模型生成。 */
  readonly evaluationLabelIds: readonly LabelId[];
  readonly caseCount: number;
  readonly reason: string;
  readonly matchType?: "DIRECT" | "PROXY" | "BASELINE";
  readonly targetCapabilities?: readonly string[];
  readonly evidence?: readonly string[];
  readonly marginalValue?: string;
}

export interface DatasetSelectionPlan {
  readonly schema: "evaldock.mvp.unified-planner-result/v1";
  readonly profile: DatasetTestProfile;
  readonly selectedDatasets: readonly SelectedDatasetAllocation[];
  /** 所选 Dataset 标签的确定性并集。 */
  readonly evaluationLabelIds: readonly LabelId[];
  readonly totalCaseCount: number;
  readonly model: string;
  readonly durationMs: number;
}

export interface DatasetMatcher {
  select(input: DatasetSelectionInput): Promise<DatasetSelectionPlan>;
}

export interface OpenAiCompatibleDatasetMatcherOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly promptRoot?: string;
  readonly policyFile?: string;
  readonly difficultyFile?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** 调试只观察请求体；API Key 永远不会传入。 */
  readonly requestObserver?: (requestBody: JsonObject) => void;
}

interface PreparedDatasetSelection {
  readonly agentStaticInfo: AgentStaticInfo;
  readonly candidates: readonly DatasetCandidate[];
  readonly policy: DatasetTestPolicy;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
}

function sortedUniqueLabels(values: readonly LabelId[], field: string): readonly LabelId[] {
  const strings = values.map(String);
  if (new Set(strings).size !== strings.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze(strings.sort((left, right) => left.localeCompare(right, "en"))
    .map((value, index) => validateVersionedAssetId<"LabelId">(value, `${field}[${index}]`)));
}

/** 少题测试集仍可选；选中后必须取全量，适配判断留给统一 Planner。 */
function prepareSelection(
  input: DatasetSelectionInput,
  policy: DatasetTestPolicy,
): PreparedDatasetSelection {
  const datasetIds = new Set<string>();
  const candidates: DatasetCandidate[] = [];
  for (const [index, candidate] of input.availableDatasets.entries()) {
    const datasetId = validateVersionedAssetId<"DatasetId">(
      candidate.datasetId,
      `availableDatasets[${index}].datasetId`,
    );
    if (datasetIds.has(datasetId)) throw new Error("availableDatasets must not contain duplicate IDs");
    datasetIds.add(datasetId);
    if (candidate.name.trim().length === 0 || candidate.description.trim().length === 0) {
      throw new Error(`availableDatasets[${index}] must have a name and description`);
    }
    assertPositiveInteger(candidate.availableCaseCount, `availableDatasets[${index}].availableCaseCount`);
    if (candidate.estimatedSecondsPerCase !== undefined) {
      assertPositiveInteger(candidate.estimatedSecondsPerCase, `availableDatasets[${index}].estimatedSecondsPerCase`);
    }
    const labelIds = sortedUniqueLabels(candidate.labelIds, `availableDatasets[${index}].labelIds`);
    if (labelIds.length === 0) throw new Error(`availableDatasets[${index}] must have labels`);
    candidates.push(Object.freeze({
      datasetId,
      name: candidate.name.trim(),
      description: candidate.description.trim(),
      labelIds,
      availableCaseCount: candidate.availableCaseCount,
      ...(candidate.estimatedSecondsPerCase === undefined ? {} : {
        estimatedSecondsPerCase: candidate.estimatedSecondsPerCase,
      }),
    }));
  }
  candidates.sort((left, right) => left.datasetId.localeCompare(right.datasetId, "en"));
  if (candidates.length < policy.minDatasets) {
    throw new Error(`${input.profile} requires at least ${policy.minDatasets} available Datasets`);
  }
  return Object.freeze({
    agentStaticInfo: input.agentStaticInfo,
    candidates: Object.freeze(candidates),
    policy,
  });
}

/** 从独立策略文件读取题量边界；新增 QUICK/DEEP 时无需修改 Planner 代码。 */
export async function loadDatasetTestPolicy(
  policyFile: string,
  profile: DatasetTestProfile,
): Promise<DatasetTestPolicy> {
  const root = asObject(JSON.parse(await readFile(path.resolve(policyFile), "utf8")) as unknown, "Dataset test policies");
  exactFields(root, ["schema", "profiles"], "Dataset test policies");
  if (root.schema !== POLICY_SCHEMA) throw new Error("Dataset test policy schema is invalid");
  const profiles = asObject(root.profiles, "Dataset test policies.profiles");
  const raw = asObject(profiles[profile], `Dataset test policies.profiles.${profile}`);
  exactFields(raw, [
    "minDatasets",
    "maxDatasets",
    "minCasesPerDataset",
    "maxCasesPerDataset",
    "maxTotalCases",
  ], `Dataset test policies.profiles.${profile}`);
  const policyNumber = (field: string): number => {
    const value = raw[field];
    if (typeof value !== "number") throw new Error(`${field} must be a number`);
    assertPositiveInteger(value, field);
    return value;
  };
  const values = {
    minDatasets: policyNumber("minDatasets"),
    maxDatasets: policyNumber("maxDatasets"),
    minCasesPerDataset: policyNumber("minCasesPerDataset"),
    maxCasesPerDataset: policyNumber("maxCasesPerDataset"),
    maxTotalCases: policyNumber("maxTotalCases"),
  };
  if (values.minDatasets > values.maxDatasets) throw new Error("Dataset count policy range is invalid");
  if (values.minCasesPerDataset > values.maxCasesPerDataset) throw new Error("Case count policy range is invalid");
  if (values.maxTotalCases < values.minDatasets * values.minCasesPerDataset) {
    throw new Error("Dataset test policy total budget is too small");
  }
  return Object.freeze({
    profile,
    ...values,
  });
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(object: Record<string, unknown>, fields: readonly string[], field: string): void {
  const actual = Object.keys(object).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...fields].sort((left, right) => left.localeCompare(right, "en"));
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${field} fields are invalid`);
  }
}

export function allocateCaseCount<T extends Pick<DatasetSelectionPlan,"selectedDatasets"|"totalCaseCount">>(selection:T,candidates:readonly DatasetCandidate[],total:number):T {
  assertPositiveInteger(total,"caseCount");
  const capacity=new Map(candidates.map(c=>[String(c.datasetId),c.availableCaseCount]));
  const selected=selection.selectedDatasets.map(d=>({...d,caseCount:1}));
  if(total<selected.length || selected.some(d=>(capacity.get(String(d.datasetId))??0)<1) ||
    selected.reduce((sum,d)=>sum+(capacity.get(String(d.datasetId))??0),0)<total)throw new Error("Selected Datasets do not have enough Cases for caseCount");
  let remaining=total-selected.length;
  while(remaining>0)for(const d of selected)if(remaining>0&&d.caseCount<capacity.get(String(d.datasetId))!){d.caseCount++;remaining--;}
  return {...selection,selectedDatasets:selected,totalCaseCount:total};
}

function parsePlan(
  content: string,
  prepared: PreparedDatasetSelection,
): Pick<DatasetSelectionPlan, "selectedDatasets" | "evaluationLabelIds" | "totalCaseCount"> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error("Unified Planner returned invalid JSON", { cause: error });
  }
  const root = asObject(decoded, "Unified Planner response");
  exactFields(root, ["selected_datasets"], "Unified Planner response");
  if (!Array.isArray(root.selected_datasets)) throw new Error("selected_datasets must be an array");
  const { policy } = prepared;
  const maximumSelectable = Math.min(policy.maxDatasets, prepared.candidates.length);
  if (root.selected_datasets.length < policy.minDatasets || root.selected_datasets.length > maximumSelectable) {
    throw new Error(`selected_datasets count violates ${policy.profile} policy`);
  }
  const byId = new Map(prepared.candidates.map((candidate) => [String(candidate.datasetId), candidate]));
  const selectedIds = new Set<string>();
  let totalCaseCount = 0;
  const selectedDatasets = root.selected_datasets.map((value, index) => {
    const item = asObject(value, `selected_datasets[${index}]`);
    const allowedFields = new Set([
      "dataset_id",
      "case_count",
      "reason",
      "match_type",
      "target_capabilities",
      "evidence",
      "marginal_value",
    ]);
    if (Object.keys(item).some((field) => !allowedFields.has(field))) {
      throw new Error(`selected_datasets[${index}] fields are invalid`);
    }
    for (const required of ["dataset_id", "case_count", "reason"]) {
      if (!Object.hasOwn(item, required)) throw new Error(`selected_datasets[${index}] is missing ${required}`);
    }
    if (typeof item.dataset_id !== "string" || selectedIds.has(item.dataset_id)) {
      throw new Error("selected_datasets must contain unique candidate IDs");
    }
    const candidate = byId.get(item.dataset_id);
    if (candidate === undefined) throw new Error(`selected_datasets[${index}] is not an available Dataset`);
    if (typeof item.case_count !== "number" || !Number.isSafeInteger(item.case_count)) {
      throw new Error(`selected_datasets[${index}].case_count must be an integer`);
    }
    if (item.case_count < Math.min(policy.minCasesPerDataset, candidate.availableCaseCount) || item.case_count > policy.maxCasesPerDataset ||
      item.case_count > candidate.availableCaseCount) {
      throw new Error(`selected_datasets[${index}].case_count violates the Dataset or profile budget`);
    }
    if (typeof item.reason !== "string" || item.reason.trim().length === 0 || item.reason.length > 500) {
      throw new Error(`selected_datasets[${index}].reason must be 1 to 500 characters`);
    }
    if (item.match_type !== undefined && !["DIRECT", "PROXY", "BASELINE"].includes(String(item.match_type))) {
      throw new Error(`selected_datasets[${index}].match_type is invalid`);
    }
    const targetCapabilities = optionalStringArray(item.target_capabilities, `selected_datasets[${index}].target_capabilities`);
    const evidence = optionalStringArray(item.evidence, `selected_datasets[${index}].evidence`);
    if (item.marginal_value !== undefined &&
      (typeof item.marginal_value !== "string" || item.marginal_value.length > 500)) {
      throw new Error(`selected_datasets[${index}].marginal_value must be at most 500 characters`);
    }
    selectedIds.add(item.dataset_id);
    totalCaseCount += item.case_count;
    return Object.freeze({
      datasetId: candidate.datasetId,
      evaluationLabelIds: candidate.labelIds,
      caseCount: item.case_count,
      reason: item.reason.trim(),
      ...(item.match_type === undefined ? {} : {
        matchType: item.match_type as "DIRECT" | "PROXY" | "BASELINE",
      }),
      ...(targetCapabilities.length === 0 ? {} : { targetCapabilities }),
      ...(evidence.length === 0 ? {} : { evidence }),
      ...(typeof item.marginal_value !== "string" || item.marginal_value.trim().length === 0
        ? {}
        : { marginalValue: item.marginal_value.trim() }),
    });
  });
  if (totalCaseCount > policy.maxTotalCases) {
    throw new Error(`selected Dataset cases exceed the ${policy.profile} total budget`);
  }
  const evaluationLabelIds = Object.freeze(
    [...new Map(selectedDatasets.flatMap((dataset) => dataset.evaluationLabelIds)
      .map((labelId) => [String(labelId), labelId])).values()]
      .sort((left, right) => left.localeCompare(right, "en")),
  );
  return Object.freeze({
    selectedDatasets: Object.freeze(selectedDatasets),
    evaluationLabelIds,
    totalCaseCount,
  });
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${field} must be a string array`);
  }
  return Object.freeze([...new Set(value.map((item) => String(item).trim()))]);
}

function promptFileName(_profile: DatasetTestProfile): string {
  return "standard.json";
}

const PROMPT_PLACEHOLDERS = Object.freeze([
  "{{TEST_PROFILE}}",
  "{{POLICY_JSON}}",
  "{{AGENT_STATIC_SNAPSHOT_JSON}}",
  "{{AVAILABLE_DATASETS_JSON}}",
  "{{CAPABILITY_LEDGER_JSON}}",
  "{{ELIGIBILITY_INDEX_JSON}}",
] as const);

function objectName(value: JsonValue): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as JsonObject;
  for (const field of ["name", "id", "schema"] as const) {
    const name = candidate[field];
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  return undefined;
}

/** 把真实静态快照投影成 Prompt 所需的可追溯能力账本，不再依赖 Python README 扫描器。 */
function capabilityLedger(info: AgentStaticInfo): JsonObject {
  const entries = [
    ...(Array.isArray(info.plugins) ? info.plugins : []).map((plugin) => ({ kind: "PLUGIN", value: plugin })),
    ...(Array.isArray(info.components) ? info.components : []).map((component) => ({
      kind: component !== null && typeof component === "object" && !Array.isArray(component) && component.kind === "EXTENSION" ? "EXTENSION" : "COMPONENT",
      value: component,
    })),
    ...info.tools.map((tool) => ({ kind: "TOOL", value: tool })),
  ].map(({ kind, value }, index) => {
    const name = objectName(value) ?? `${kind.toLowerCase()}-${index + 1}`;
    return {
      capability_id: `${kind.toLowerCase()}:${name}`,
      kind,
      evidence_status: "VERIFIED_STATIC_SNAPSHOT",
      evidence: value,
    };
  });
  return Object.freeze({
    schema: "evaldock.planner-capability-ledger/v1",
    source: "AGENT_STATIC_SNAPSHOT",
    target_type: info.target_type,
    entries,
    tool_delta: info.tool_delta,
    permission_preset: info.permission_preset,
    sandbox_mode: info.sandbox_mode,
    limitations: info.limitations,
  });
}

/** Dataset 运行条件由执行期 Loader 再做硬校验；Planner 只收到保守的条件性索引。 */
function eligibilityIndex(candidates: readonly DatasetCandidate[]): JsonObject {
  return Object.freeze({
    schema: "evaldock.planner-eligibility-index/v1",
    datasets: candidates.map((candidate) => ({
      dataset_id: candidate.datasetId,
      status: "CONDITIONAL",
      reason: "Catalog metadata is available; Loader delivers Case inputs, and the environment is prepared manually.",
      label_ids: candidate.labelIds,
      available_case_count: candidate.availableCaseCount,
    })),
  });
}

/**
 * 把动态事实注入一份可直接发送的完整提示词。每个占位符必须恰好出现一次，
 * 且单次 replace 不会再扫描注入内容，避免 Dataset 描述伪造占位符。
 */
function renderPlannerPrompt(template: string, prepared: PreparedDatasetSelection): string {
  const policy = {
    min_datasets: prepared.policy.minDatasets,
    max_datasets: Math.min(prepared.policy.maxDatasets, prepared.candidates.length),
    min_cases_per_dataset: prepared.policy.minCasesPerDataset,
    max_cases_per_dataset: prepared.policy.maxCasesPerDataset,
    max_total_cases: prepared.policy.maxTotalCases,
    when_available_below_minimum: "select_all_available_cases",
  };
  const datasets = prepared.candidates.map((candidate) => ({
    dataset_id: candidate.datasetId,
    name: candidate.name,
    description: candidate.description,
    label_ids: candidate.labelIds,
    available_case_count: candidate.availableCaseCount,
    ...(candidate.estimatedSecondsPerCase === undefined ? {} : {
      estimated_seconds_per_case: candidate.estimatedSecondsPerCase,
    }),
  }));
  const replacements: Readonly<Record<(typeof PROMPT_PLACEHOLDERS)[number], string>> = Object.freeze({
    "{{TEST_PROFILE}}": prepared.policy.profile,
    "{{POLICY_JSON}}": JSON.stringify(policy, null, 2),
    "{{AGENT_STATIC_SNAPSHOT_JSON}}": JSON.stringify(prepared.agentStaticInfo, null, 2),
    "{{AVAILABLE_DATASETS_JSON}}": JSON.stringify(datasets, null, 2),
    "{{CAPABILITY_LEDGER_JSON}}": JSON.stringify(capabilityLedger(prepared.agentStaticInfo), null, 2),
    "{{ELIGIBILITY_INDEX_JSON}}": JSON.stringify(eligibilityIndex(prepared.candidates), null, 2),
  });
  const discovered = template.match(/\{\{[A-Z0-9_]+\}\}/gu) ?? [];
  for (const placeholder of PROMPT_PLACEHOLDERS) {
    if (discovered.filter((value) => value === placeholder).length !== 1) {
      throw new Error(`Unified Planner prompt must contain ${placeholder} exactly once`);
    }
  }
  if (discovered.some((placeholder) => !PROMPT_PLACEHOLDERS.includes(
    placeholder as (typeof PROMPT_PLACEHOLDERS)[number],
  ))) {
    throw new Error("Unified Planner prompt contains an unknown placeholder");
  }
  return template.replace(/\{\{[A-Z0-9_]+\}\}/gu, (placeholder) =>
    replacements[placeholder as (typeof PROMPT_PLACEHOLDERS)[number]]);
}

/** 一次 OpenAI-compatible 请求；没有标签请求、Agent loop、重试或格式修复。 */
export class OpenAiCompatibleDatasetMatcher implements DatasetMatcher {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #promptRoot: string;
  readonly #policyFile: string;
  readonly #difficultyFile: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #requestObserver: ((requestBody: JsonObject) => void) | undefined;

  public constructor(options: OpenAiCompatibleDatasetMatcherOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
      throw new Error("Unified Planner endpoint must be HTTPS without embedded credentials");
    }
    if (options.apiKey.trim().length === 0) throw new Error("Unified Planner API key is required");
    if (options.model.trim().length === 0) throw new Error("Unified Planner model is required");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertPositiveInteger(timeoutMs, "Unified Planner timeout");
    this.#endpoint = endpoint.toString();
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#timeoutMs = timeoutMs;
    this.#promptRoot = path.resolve(options.promptRoot ?? path.join(process.cwd(), "planning", "prompts"));
    this.#policyFile = path.resolve(options.policyFile ?? path.join(process.cwd(), "planning", "policies.json"));
    this.#difficultyFile = options.difficultyFile;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#requestObserver = options.requestObserver;
  }

  public async select(input: DatasetSelectionInput): Promise<DatasetSelectionPlan> {
    const policy = applyTestSize(await loadDatasetTestPolicy(this.#policyFile, input.profile),input.testSize);
    const candidates = this.#difficultyFile ? await withDifficultyHints(input.availableDatasets, this.#difficultyFile) : input.availableDatasets;
    const prepared = prepareSelection({...input, availableDatasets: candidates}, policy);
    const template = await readFile(path.join(this.#promptRoot, promptFileName(input.profile)), "utf8");
    if (template.trim().length === 0) throw new Error("Unified Planner prompt must not be empty");
    const prompt = renderPlannerPrompt(template, prepared);
    const startedAt = this.#now();
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
    const requestBody = Object.freeze({
      model: this.#model,
      messages: Object.freeze([
        Object.freeze({ role: "user", content: prompt }),
      ]),
      temperature: 0,
      max_tokens: 393_216,
      response_format: Object.freeze({ type: "json_object" }),
    });
    this.#requestObserver?.(requestBody);
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal,
    });
    if (!response.ok) throw new Error(`Unified Planner request failed with HTTP ${response.status}`);
    const payload = asObject(await response.json(), "Unified Planner HTTP response");
    if (!Array.isArray(payload.choices) || payload.choices.length < 1) {
      throw new Error("Unified Planner HTTP response has no choices");
    }
    const choice = asObject(payload.choices[0], "Unified Planner choice");
    const message = asObject(choice.message, "Unified Planner message");
    if (typeof message.content !== "string") throw new Error("Unified Planner message content must be a string");
    const initial = parsePlan(message.content, prepared);
    const parsed = input.testSize?.caseCount === undefined ? initial : allocateCaseCount(initial,prepared.candidates.map(candidate=>({...candidate,availableCaseCount:Math.min(candidate.availableCaseCount,policy.maxCasesPerDataset)})),input.testSize.caseCount);
    return Object.freeze({
      schema: "evaldock.mvp.unified-planner-result/v1",
      profile: prepared.policy.profile,
      selectedDatasets: parsed.selectedDatasets,
      evaluationLabelIds: parsed.evaluationLabelIds,
      totalCaseCount: parsed.totalCaseCount,
      model: this.#model,
      durationMs: Math.max(0, this.#now() - startedAt),
    });
  }
}

export function createDefaultDatasetMatcher(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DatasetMatcher {
  const apiKey = environment.EVALDOCK_PLANNER_API_KEY ?? environment.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("Set EVALDOCK_PLANNER_API_KEY or DEEPSEEK_API_KEY before unified planning");
  }
  const timeoutText = environment.EVALDOCK_PLANNER_TIMEOUT_MS;
  const timeoutMs = timeoutText === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutText);
  return new OpenAiCompatibleDatasetMatcher({
    endpoint: environment.EVALDOCK_PLANNER_MODEL_ENDPOINT ?? DEFAULT_ENDPOINT,
    apiKey,
    model: environment.EVALDOCK_PLANNER_MODEL ?? DEFAULT_MODEL,
    timeoutMs,
    promptRoot: environment.EVALDOCK_PLANNER_PROMPT_ROOT ?? path.join(cwd, "planning", "prompts"),
    policyFile: environment.EVALDOCK_PLANNER_POLICY_FILE ?? path.join(cwd, "planning", "policies.json"),
    difficultyFile: path.join(cwd, "planning", "case-difficulty.json"),
    ...(environment.EVALDOCK_DEBUG_PLANNER_PROMPT === "1" ? {
      requestObserver: (requestBody: JsonObject) => {
        process.stderr.write(`[evaldock:planner-prompt] ${JSON.stringify(requestBody, null, 2)}\n`);
      },
    } : {}),
  });
}
