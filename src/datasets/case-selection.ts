/** Resolve an explicit CLI case against real question files, without model selection. */
import path from "node:path";
import { validateStableId } from "../core/models.js";
import type { DatasetSelectionPlan, DatasetTestProfile } from "../planning/planner.js";
import { loadDatasetDescriptionCatalog } from "./catalog.js";
import { currentQuestionCases } from "./loader.js";

export async function resolveExplicitCase(input: {
  readonly cwd: string;
  readonly datasetsRoot?: string;
  readonly datasetCatalogPath?: string;
  readonly testProfile?: DatasetTestProfile;
  readonly selector: string;
}) {
  const root = path.resolve(input.cwd, input.datasetsRoot ?? process.env.EVALDOCK_DATASETS_ROOT ?? "datasets");
  const catalog = await loadDatasetDescriptionCatalog(path.resolve(input.cwd,
    input.datasetCatalogPath ?? process.env.EVALDOCK_DATASET_CATALOG ?? path.join(root, "catalog.md")));
  const selector = input.selector.trim();
  if (!selector) throw new Error("--case requires a Case ID, question directory name or path");
  const requestedPath = path.resolve(input.cwd, selector);
  const matches = [];
  for (const dataset of catalog) {
    const slug = String(dataset.datasetId).replace(/^dataset\./u, "").replace(/\/v[1-9][0-9]*$/u, "");
    const files = await currentQuestionCases(root, dataset.datasetId);
    for (const [caseIndex, questionPath] of files.entries()) {
      const caseId = validateStableId(`${slug}.case-${caseIndex + 1}`, "caseId");
      const directory = path.dirname(questionPath);
      const relativeDirectory = path.relative(root, directory).split(path.sep).join("/");
      if (selector !== caseId && selector !== path.basename(directory) &&
          selector !== relativeDirectory && requestedPath !== directory && requestedPath !== questionPath) continue;
      matches.push({ dataset, caseIndex, caseId, questionPath });
    }
  }
  if (matches.length === 0) {
    throw new Error(`--case "${selector}" was not found in ${root}. Use a real question directory (e.g. agentbench-os/agentbench-os-count-files) or a valid dataset.case-N ID.`);
  }
  if (matches.length !== 1) {
    throw new Error(`--case "${selector}" is ambiguous; use one of: ${matches.map(item => item.questionPath).join(", ")}`);
  }
  const match = matches[0]!;
  const selection: DatasetSelectionPlan = Object.freeze({
    schema: "evaldock.mvp.unified-planner-result/v1",
    profile: input.testProfile ?? "STANDARD",
    selectedDatasets: Object.freeze([Object.freeze({
      datasetId: match.dataset.datasetId,
      evaluationLabelIds: match.dataset.labelIds,
      caseCount: 1,
      reason: `Explicit CLI --case ${selector}; question: ${match.questionPath}`,
    })]),
    evaluationLabelIds: match.dataset.labelIds,
    totalCaseCount: 1,
    model: "user-selected-case/v1",
    durationMs: 0,
  });
  return Object.freeze({
    item: Object.freeze({ datasetId: match.dataset.datasetId, caseIndex: match.caseIndex, caseId: match.caseId }),
    questionPath: match.questionPath,
    selection,
  });
}
