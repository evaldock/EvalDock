import {samplePlannedCases} from "../planning/case-sampling.js";
import {projectPaths} from "../platform/paths.js";
import {freezeConfig} from "../platform/config.js";
import { safeErrorDiagnostics } from "../core/errors.js";
import { renderRunReport } from "../reporting/batch-html.js";
import { aggregateScores } from "../evaluation/scoring.js";
/**
 * 文件职责：把一次统一 Planner 结果展开为互不重复的 Case，并复用单 Case Workflow。
 * Planner 只执行一次；每个 Case 启动新的 Headless 会话并发布到同一父 Run 目录。
 */
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateStableId,
  validateVersionedAssetId,
  type DatasetId,
} from "../core/models.js";
import type { DatasetSelectionPlan } from "../planning/planner.js";
import { resolveExplicitCase } from "../datasets/case-selection.js";
import { loadDatasetDescriptionCatalog } from "../datasets/catalog.js";
import { countDatasetQuestionCases } from "../datasets/loader.js";
import type { EvaluationConfig } from "./evaluation-config.js";
import {
  runEvaluationWorkflow,
  type RunWorkflowInput,
  type WorkflowSummary,
} from "./workflow.js";

export interface BatchRunWorkflowInput extends RunWorkflowInput {
  readonly maxCases?: number;
  readonly evaluationConfig?: EvaluationConfig;
  readonly selectedCaseId?: string;
  readonly stopAfterCase?: boolean;
  readonly onProgress?: (message: string) => void;
  /** 仅供受控测试或嵌入调用替换单 Case Workflow。 */
  readonly workflowRunner?: typeof runEvaluationWorkflow;
}

export interface BatchCaseSummary {
  readonly caseId: string;
  readonly datasetId: string;
  readonly caseIndex: number;
  readonly executionRunId: string;
  readonly status: WorkflowSummary["status"];
  readonly scores: NonNullable<WorkflowSummary["scores"]>;
  readonly exitCode: WorkflowSummary["exitCode"];
  readonly operationalHealth?: WorkflowSummary["operationalHealth"];
  readonly failureGroups: WorkflowSummary["failureGroups"];
  readonly reasonCodes: WorkflowSummary["reasonCodes"];
  readonly caseBundlePath?: string;
  readonly reportHtml?: string;
  readonly dshSessionIds: readonly string[];
}

export interface BatchWorkflowSummary extends WorkflowSummary {
  readonly caseSampling?: NonNullable<Awaited<ReturnType<typeof samplePlannedCases>>>["metadata"];
  readonly caseConcurrency: 3;
  readonly evaluationConfig?: EvaluationConfig;
  readonly caseResults: readonly BatchCaseSummary[];
  readonly runSummaryPath?: string;
}

/** 最多三个 Case 同时运行；任一完成后立即从队列补位。 */
const CASE_CONCURRENCY = 3 as const;

function selectionFromSummary(summary: WorkflowSummary): DatasetSelectionPlan {
  if (
    summary.datasetTestProfile === undefined ||
    summary.selectedDatasets === undefined ||
    summary.totalCaseCount === undefined ||
    summary.datasetMatchModel === undefined ||
    summary.datasetMatchDurationMs === undefined
  ) {
    throw new Error("Planner summary is missing the frozen Dataset selection");
  }
  const selectedDatasets = summary.selectedDatasets.map((selected) => Object.freeze({
    datasetId: validateVersionedAssetId<"DatasetId">(selected.datasetId),
    evaluationLabelIds: Object.freeze(selected.evaluationLabelIds.map(
      (labelId) => validateVersionedAssetId<"LabelId">(labelId),
    )),
    caseCount: selected.caseCount,
    reason: selected.reason,
    ...(selected.matchType === undefined ? {} : { matchType: selected.matchType }),
    ...(selected.targetCapabilities === undefined ? {} : { targetCapabilities: selected.targetCapabilities }),
    ...(selected.evidence === undefined ? {} : { evidence: selected.evidence }),
    ...(selected.marginalValue === undefined ? {} : { marginalValue: selected.marginalValue }),
  }));
  const evaluationLabelIds = Object.freeze([
    ...new Map(selectedDatasets.flatMap((dataset) => dataset.evaluationLabelIds)
      .map((labelId) => [String(labelId), labelId] as const)).values(),
  ].sort((left, right) => String(left).localeCompare(String(right), "en")));
  return Object.freeze({
    schema: "evaldock.mvp.unified-planner-result/v1" as const,
    profile: summary.datasetTestProfile,
    selectedDatasets: Object.freeze(selectedDatasets),
    evaluationLabelIds,
    totalCaseCount: summary.totalCaseCount,
    model: summary.datasetMatchModel,
    durationMs: summary.datasetMatchDurationMs,
  });
}

async function selectedPlan(root:string,config:EvaluationConfig):Promise<DatasetSelectionPlan|undefined> {
  if(config.selection.kind!=="SELECTED")return undefined;
  const datasetsRoot=path.join(root,"datasets");
  const catalog=await loadDatasetDescriptionCatalog(path.join(datasetsRoot,"catalog.md"));
  const selectedDatasets=[];
  for(const item of config.selection.items){
    const candidate=catalog.find(dataset=>String(dataset.datasetId)===item.datasetId);
    if(!candidate)throw new Error("Selected Dataset is no longer available: "+item.datasetId);
    const count=await countDatasetQuestionCases(datasetsRoot,candidate.datasetId);
    if(item.caseIndices.some(index=>index>=count))throw new Error("Selected Case is no longer available: "+item.datasetId);
    selectedDatasets.push({datasetId:candidate.datasetId,evaluationLabelIds:candidate.labelIds,caseCount:item.caseIndices.length,reason:"Operator selected exact Cases"});
  }
  return {schema:"evaldock.mvp.unified-planner-result/v1",profile:"STANDARD",selectedDatasets,evaluationLabelIds:[...new Set(selectedDatasets.flatMap(dataset=>dataset.evaluationLabelIds))],totalCaseCount:selectedDatasets.reduce((total,dataset)=>total+dataset.caseCount,0),model:"explicit-cases",durationMs:0};
}

function datasetSlug(datasetId: DatasetId): string {
  return String(datasetId).replace(/^dataset\./u, "").replace(/\/v[1-9][0-9]*$/u, "");
}

function caseQueue(selection: DatasetSelectionPlan): Array<{
  readonly datasetId: DatasetId;
  readonly caseIndex: number;
  readonly caseId: string;
}> {
  const queue: Array<{ datasetId: DatasetId; caseIndex: number; caseId: string }> = [];
  for (const dataset of selection.selectedDatasets) {
    for (let caseIndex = 0; caseIndex < dataset.caseCount; caseIndex += 1) {
      queue.push(Object.freeze({
        datasetId: dataset.datasetId,
        caseIndex,
        caseId: validateStableId(`${datasetSlug(dataset.datasetId)}.case-${caseIndex + 1}`, "caseId"),
      }));
    }
  }
  return queue;
}

async function commitRunSummary(summary: BatchWorkflowSummary, runDirectory: string): Promise<{
  readonly summaryPath: string;
  readonly reportHtmlPath: string;
} | undefined> {
  const destination = path.join(runDirectory, "run.json");
  const temporary = `${destination}.tmp`;
  const reportHtmlPath = path.join(runDirectory, "report.html");
  const reportTemporary = `${reportHtmlPath}.tmp`;
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(reportTemporary, renderRunReport(summary), { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
  await rename(reportTemporary, reportHtmlPath);
  return { summaryPath: destination, reportHtmlPath };
}

/** 真实 run 的批量入口；Fixture、inspect 和 plan 仍直接调用单 Workflow。 */
export async function runEvaluationBatch(input: BatchRunWorkflowInput): Promise<BatchWorkflowSummary> {
  const {
    maxCases,
    evaluationConfig,
    selectedCaseId,
    stopAfterCase,
    onProgress,
    workflowRunner = runEvaluationWorkflow,
    ...workflowInput
  } = input;
  const parentRunId = validateStableId(workflowInput.runId ?? `batch-${Date.now()}`, "runId");
  const paths=projectPaths(workflowInput.cwd);
  const config=await freezeConfig({cwd:workflowInput.cwd,configId:"config.batch",invocationId:"invocation.batch",
    createdAt:new Date().toISOString(),evaldockVersion:"0.1.0",
    ...(workflowInput.configFile?{configFile:workflowInput.configFile}:{}),
    cli:{...workflowInput.configOverrides,targetRoot:workflowInput.descriptor.sourceRoot}});
  const transientRoot = path.join(paths.runtime, parentRunId);
  const planningRoot = path.join(transientRoot, "planning");
  const selected = evaluationConfig ? await selectedPlan(workflowInput.cwd,evaluationConfig) : undefined;
  const explicit = selectedCaseId === undefined ? undefined : await resolveExplicitCase({
    ...workflowInput, selector: selectedCaseId,
  });
  if (explicit !== undefined) {
    onProgress?.(`explicit case: ${explicit.item.caseId} -> ${explicit.questionPath} (model selection skipped)`);
  }
  const planning = await workflowRunner({
    ...workflowInput,
    ...(explicit === undefined && selected===undefined ? {} : {
      precomputedDatasetSelection: explicit?.selection ?? selected!,
      ...(explicit===undefined?{}:{executionCase: { ...explicit.item, resultRunId: parentRunId, resultCaseId: explicit.item.caseId }}),
    }),
    configOverrides: {
      ...workflowInput.configOverrides,
      runRoot: path.join(planningRoot, "records"),
      artifactRoot: path.join(planningRoot, "artifacts"),
      reportRoot: path.join(planningRoot, "reports"),
      workspaceRoot: path.join(planningRoot, "workspaces"),
      runtimeDshHomeRoot: path.join(planningRoot, "runtime-homes"),
    },
    runId: parentRunId,
    stopAfter: "PLAN",
  });
  if (planning.status !== "COMPLETED") {
    return Object.freeze({
      ...planning,
      caseConcurrency: CASE_CONCURRENCY,
      caseResults: Object.freeze([]),
    });
  }

  const selection = explicit?.selection ?? selected ?? selectionFromSummary(planning);
  let queue = explicit === undefined ? caseQueue(selection) : [explicit.item];
  if(evaluationConfig?.selection.kind==="SELECTED") {
    const indices=new Map(evaluationConfig.selection.items.map(item=>[item.datasetId,new Set(item.caseIndices)]));
    queue=[];
    for(const dataset of selection.selectedDatasets){
      for(const caseIndex of indices.get(String(dataset.datasetId))??[]){
        queue.push({datasetId:dataset.datasetId,caseIndex,caseId:validateStableId(`${datasetSlug(dataset.datasetId)}.case-${caseIndex+1}`,"caseId")});
      }
    }
  }
  const limit = stopAfterCase === true ? 1 : maxCases;
  if (limit !== undefined) queue = queue.slice(0, limit);
  let sampling: Awaited<ReturnType<typeof samplePlannedCases>>;
  if (!explicit && !selected && !workflowInput.allDatasets && evaluationConfig?.selection.kind !== "ALL" && limit === undefined) {
    sampling = await samplePlannedCases({root: workflowInput.cwd,
      datasetsRoot: path.resolve(workflowInput.datasetsRoot ?? process.env.EVALDOCK_DATASETS_ROOT ?? path.join(workflowInput.cwd, "datasets")), selection});
    if (sampling) {
      queue = sampling.queue;
      onProgress?.(`[evaldock:sampling] ${JSON.stringify(sampling.metadata)}`);
    }
  }

  // Publish the frozen selection before the first Case; readers need not wait for run.json.
  const planDirectory = path.join(config.resultRoot, "agents",
    String(workflowInput.descriptor.targetId), "runs", parentRunId);
  await mkdir(planDirectory, { recursive: true, mode: 0o700 });
  const planPath = path.join(planDirectory, "plan.json");
  await writeFile(planPath + ".tmp", JSON.stringify({
    ...selection, schema: "evaldock.workbench.plan/v1", runId: parentRunId, agentId: workflowInput.descriptor.targetId,
    status: "FROZEN", createdAt: new Date().toISOString(), queue,
    ...(sampling ? {caseSampling: sampling.metadata} : {}),
  }) + "\n", { mode: 0o600 });
  await rename(planPath + ".tmp", planPath);

  // Publish the frozen inspection even while Cases are running or all Cases fail.
  const inspectionDirectory = path.join(planning.recordsPath, "records", "inspection");
  const inspectionFiles = await readdir(inspectionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  for (const file of inspectionFiles.filter(file=>file.endsWith(".json"))) {
    const inspection = JSON.parse(await readFile(path.join(inspectionDirectory,file),"utf8")) as {schema?:string};
    if (inspection.schema !== "evaldock.mvp.inspection/v1") continue;
    const inspectionPath = path.join(planDirectory,"inspection.json");
    await writeFile(inspectionPath+".tmp",JSON.stringify(inspection)+"\n",{mode:0o600});
    await rename(inspectionPath+".tmp",inspectionPath);
    break;
  }

  const resultsByOrdinal: Array<BatchCaseSummary | undefined> = new Array(queue.length);
  let nextOrdinal = 0, cancellationSeen = false;
  async function worker(): Promise<void> {
    while (!workflowInput.signal?.aborted && !cancellationSeen) {
      const ordinal = nextOrdinal++;
      const item = queue[ordinal];
      if (item === undefined) return;
      const executionRunId = validateStableId(`${parentRunId}.c${ordinal + 1}`, "executionRunId");
      const isolatedRoot = path.join(transientRoot, executionRunId);
      onProgress?.(`starting ${ordinal + 1}/${queue.length}: ${item.caseId}`);
      let result: WorkflowSummary;
      try {
        result = await workflowRunner({
          ...workflowInput,
          configOverrides: {
            ...workflowInput.configOverrides,
            runRoot: path.join(isolatedRoot, "records"),
            artifactRoot: path.join(isolatedRoot, "artifacts"),
            reportRoot: path.join(isolatedRoot, "reports"),
            workspaceRoot: path.join(isolatedRoot, "workspaces"),
            runtimeDshHomeRoot: path.join(isolatedRoot, "runtime-homes"),
          },
          runId: executionRunId,
          precomputedDatasetSelection: selection,
          executionCase: {
            datasetId: String(item.datasetId),
            caseIndex: item.caseIndex,
            resultRunId: parentRunId,
            resultCaseId: item.caseId,
            ordinal: ordinal + 1,
          },
        });
      } catch (error) {
        let diagnosticWriteFailed = false;
        try {
          const diagnosticDirectory = path.join(planDirectory, "diagnostics");
          await mkdir(diagnosticDirectory, { recursive: true, mode: 0o700 });
          await writeFile(path.join(diagnosticDirectory, executionRunId + ".json"), JSON.stringify({
            caseId: item.caseId, executionRunId, phase: "CASE_WORKFLOW", ...safeErrorDiagnostics(error),
          }) + "\n", { mode: 0o600 });
        } catch {
          // A diagnostic I/O failure must not turn a Case failure into a batch abort.
          diagnosticWriteFailed = true;
        }
        // A Case-local exception must not discard earlier results or the rest of the selected queue.
        const cancelled = workflowInput.signal?.aborted === true;
        result = {
          schema: "evaldock.mvp.cli-summary/v1", command: "run",
          runId: executionRunId, fixture: false, recordsPath: isolatedRoot,
          status: cancelled ? "CANCELLED" : "FAILED",
          exitCode: cancelled ? 130 : 4, operationalHealth: "FAILED",
          failureGroups: [cancelled ? "CANCELLED" : "infrastructure_error"],
          reasonCodes: [cancelled ? "TARGET_CANCELLED" : "CASE_WORKFLOW_ERROR",
            ...(diagnosticWriteFailed ? ["CASE_DIAGNOSTIC_WRITE_FAILED"] : [])],
        };
      }
      if (result.status === "CANCELLED") cancellationSeen = true;
      // Case Bundle 已原子落盘后，删除其隔离运行区；最终 var 只保留精简结果，不重复保存内部 records/artifacts。
      if (result.caseBundlePath !== undefined) {
        try {
          // Keep redacted failure records before deleting the transient workspace/artifacts.
          const failures = path.join(isolatedRoot,"records",executionRunId,"records","failure");
          const info = await lstat(failures).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return undefined;throw error;});
          if(info){
            if(!info.isDirectory() || info.isSymbolicLink())throw new Error("Invalid failure diagnostics directory");
            await cp(failures,path.join(result.caseBundlePath,"diagnostics","failures"),{recursive:true,force:false,errorOnExist:true});
          }
          await rm(isolatedRoot, { recursive: true, force: true });
        } catch {
          result = { ...result, operationalHealth: "FAILED",
            failureGroups: [...result.failureGroups, "infrastructure_error"],
            reasonCodes: [...result.reasonCodes, "CASE_TEMP_CLEANUP_FAILED"] };
        }
      }
      onProgress?.(`finished ${ordinal + 1}/${queue.length}: ${item.caseId} (${result.status})`);
      resultsByOrdinal[ordinal] = Object.freeze({
        caseId: item.caseId,
        datasetId: String(item.datasetId),
        caseIndex: item.caseIndex,
        executionRunId,
        status: result.status,
        scores: result.scores ?? [],
        exitCode: result.exitCode,
        ...(result.operationalHealth === undefined ? {} : { operationalHealth: result.operationalHealth }),
        failureGroups: result.failureGroups,
        reasonCodes: result.reasonCodes,
        ...(result.caseBundlePath === undefined ? {} : { caseBundlePath: result.caseBundlePath }),
        ...(result.caseBundlePath === undefined && result.reportHtml === undefined
          ? {}
          : { reportHtml: result.caseBundlePath === undefined ? result.reportHtml! : path.join(result.caseBundlePath, "report.html") }),
        dshSessionIds: Object.freeze(result.dshSessionIds ?? []),
      }) satisfies BatchCaseSummary;
    }
  }
  await Promise.all(Array.from({length: Math.min(CASE_CONCURRENCY,queue.length)},()=>worker()));
  const caseResults = resultsByOrdinal.filter((result): result is BatchCaseSummary => result !== undefined);

  const scores=caseResults.flatMap(result=>result.scores);
  const dimensions=aggregateScores(scores);
  const cancelled = workflowInput.signal?.aborted === true || caseResults.some((item) => item.status === "CANCELLED");
  const planUnsatisfiable = caseResults.some((item) => item.status === "PLAN_UNSATISFIABLE");
  const failed = caseResults.some((item) => item.status === "FAILED" || item.operationalHealth === "FAILED" || item.exitCode === 4);
  const exitCode: WorkflowSummary["exitCode"] = cancelled ? 130 : planUnsatisfiable ? 2 : failed ? 4 : 0;
  const status: WorkflowSummary["status"] = cancelled ? "CANCELLED" : planUnsatisfiable ? "PLAN_UNSATISFIABLE" : failed ? "FAILED" : "COMPLETED";
  const firstBundle = caseResults.find((item) => item.caseBundlePath !== undefined)?.caseBundlePath;
  const summary: BatchWorkflowSummary = Object.freeze({
    ...planning,
    command: "run" as const,
    status,
    runId: parentRunId,
    scores, dimensions,
    operationalHealth: failed ? "FAILED" : "HEALTHY",
    securityIsolation: "SESSION_SEPARATED" as const,
    caseConcurrency: CASE_CONCURRENCY,
    ...(evaluationConfig===undefined?{}:{evaluationConfig}),
    ...(sampling ? {caseSampling: sampling.metadata} : {}),
    failureGroups: Object.freeze([...new Set(caseResults.flatMap((item) => item.failureGroups))]),
    reasonCodes: Object.freeze([...new Set(caseResults.flatMap((item) => item.reasonCodes))]),
    recordsPath: firstBundle === undefined ? planDirectory : path.dirname(path.dirname(firstBundle)),
    exitCode,
    caseResults: Object.freeze(caseResults),
  });
  const committedRun = await commitRunSummary(summary,planDirectory);
  // Keep failed/unfinished execution data as diagnostics, never as a second result tree.
  const diagnosticRoot=path.join(paths.logs,"runs",parentRunId);
  await mkdir(path.dirname(diagnosticRoot),{recursive:true,mode:0o700});
  await rename(transientRoot,diagnosticRoot).catch(error=>{if(error.code!=="ENOENT")throw error;});
  return committedRun === undefined
    ? summary
    : Object.freeze({
        ...summary,
        reportHtml: committedRun.reportHtmlPath,
        runSummaryPath: committedRun.summaryPath,
      });
}
