import {inspectHeadlessInstallation} from "../runtime/headless-inspection.js";
import {selectAllDatasets} from "../planning/all-datasets.js";
import { submissionContent, submissionIndex, SUBMISSION_CONTENT_BUDGET_BYTES } from "../all-trace/submission.js";
/**
 * 文件职责：驱动 EvalDock 唯一的端到端评测状态机。
 *
 * 核心流程：依次完成 Target 冻结与检查、计划生成、安全预检、环境准备、Agent
 * 执行、双通道观测、all trace 收拢、Judge、Reset 独立验证、数值评分 和报告交付。
 * 每一步都先持久化事实再推进状态，异常路径复用同一套安全收尾流程。
 *
 * 与其他文件的交互：从 bootstrap 取得全部服务；顺序调用 planning、runtime、
 * observation、evaluation、platform 与 storage 的公开接口；CLI 只调用本文件的
 * runEvaluationWorkflow 或 rebuildCommittedReportHtml。
 *
 * 公开接口：FixtureHooks、RunWorkflowInput、WorkflowSummary、ReportWorkflowSummary、
 * rebuildCommittedReportHtml 和 runEvaluationWorkflow。
 */
import { lstat, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { ArtifactCommitMetadata, PortResult } from "../core/contracts.js";
import { readNativeProbeTrace } from "../agent-trace/native-probe-adapter.js";
import {
  commitFailureDraft,
  failureDisplayGroup,
  internalFailureDraft,
  type FailureDraft,
  type FailureRecord,
} from "../core/errors.js";
import {
  digestBytes,
  digestValue,
  refForArtifact,
  refForImmutable,
  refForProjection,
  validateStableId,
  withContentDigest,
  type AgentTracePlan,
  type ArtifactRef,
  type CollectionStatus,
  type ConfigSnapshot,
  type ControlEvent,
  type EnvironmentInstance,
  type EvaluationCase,
  type EvaluationPlan,
  type EvaluationRun,
  type ExecutionAttempt,
  type FileDiff,
  type FileSnapshot,
  type InspectionSnapshot,
  type IsoDateTime,
  type JsonObject,
  type JsonValue,
  type ObservationPlan,
  type ObservationSession,
  type RawObservation,
  type Ref,
  type ResetVerification,
  type ScopeRef,
  type SecurityPreflight,
  type SeedManifest,
  type SourceDescriptor,
  type TargetDescriptor,
  type TargetSnapshot,
} from "../core/models.js";
import { writeTraceDirectory, readTraceDirectory, type TraceDirectoryRef } from "../all-trace/store.js";
import { writeReportLoader } from "../reporting/trace-loader.js";
import { assembleAllTrace } from "../all-trace/assemble.js";
import { executeWebTarget, inspectWebTarget } from "../runtime/web-target.js";
import type { AllTrace, SubmissionFile as SubmissionFileEvidenceInput } from "../all-trace/types.js";
import { loadLabels, type LabelDefinition } from "../labels/catalog.js";
import { createDefaultLabelJudge, unavailableReferenceScore } from "../evaluation/llm-label-judge.js";
import { aggregateScores } from "../evaluation/scoring.js";
import type { LabelJudge, LabelScore, DimensionScore } from "../evaluation/types.js";
import { buildResult, parseVerifiedReportDocument, serializeReportDocument } from "../reporting/record.js";
import { renderReportHtml, renderStatusHtml } from "../reporting/html.js";
import type { ResultData, ExecutionDataView, WorkflowStepView } from "../reporting/types.js";
import {
  activateObservation,
  beginBaseline,
  beginDrain,
  completeBaseline,
  completionLedger,
  createFileSourceDescriptor,
  createObservationSession,
  createProbeSourceDescriptor,
  failObservation,
  ledgerItem,
  sealObservation,
} from "../observation/coordinator.js";
import {
  FILE_SENSOR_REGISTRY_DIGEST,
  fileCollectionFailureDrafts,
  materializeFileCollectionStatus,
  materializeFileObservation,
  type EnvironmentSensor,
} from "../../observer-lab/adapters/filesystem/binding.js";

import {
  createLabSourceDescriptor,
  materializeLabObservations,
  startLabObservers,
  type LabCapture,
} from "../observation/collection.js";

import {
  materializeProbeCollection,
  parseProbeJsonl,
  probeIssueFailureDrafts,
  readProbeFileBounded,
} from "../agent-trace/reader.js";
import {
  buildFileDiff,
  emptyWorkspaceManifestDigest,
  materializeFileDiff,
  materializeFileSnapshot,
  materializeResetVerification,
  serializeFileSnapshotArtifact,
  verifyResetSnapshot,
  type FileSnapshotDraft,
} from "../../observer-lab/adapters/filesystem/sensor.js";
import {
  freezeTargetResult,
  inspectTargetResult,
  verifyTargetIntegrityResult,
  type PlanningArtifactCommitRequest,
} from "../planning/target.js";
import {
  dshSessionCwd,
  dshSessionsToProbeJsonl,
  readDshSessionArchive,
} from "../runtime/dsh-session-trace.js";
import {
  commitReportHtml,
  commitReportJson,
  readCommittedReportHtml,
  readCommittedReportJson,
} from "../platform/export.js";
import { exportCaseBundle } from "../platform/case-bundle.js";
import {
  assertSafeAgentTask,
  findSecretLeaks,
  issueObserverBinding,
  runSecurityPreflight,
} from "../platform/security.js";
import { acquireLease, releaseLease, type LeaseFact } from "../platform/services.js";
import {
  cleanupRuntimeDshHome,
  cleanupEnvironment,
  prepareEnvironment,
  resetEnvironment,
  seedEnvironment,
  stageTargetRuntime,
  type PreparedEnvironment,
  type SeedEntrySpec,
} from "../runtime/environment.js";
import { createRuntimeProjectionGraph, transitionRuntimeProjection } from "../runtime/runner.js";
import { executeTarget, type TargetExecutionResult } from "../runtime/target.js";
import {
  bootstrapApplication,
  createRunId,
  EVALDOCK_VERSION,
  failureDraftsFrom,
  requireSucceeded,
  type ApplicationServices,
} from "./bootstrap.js";
import type { MvpConfigValues } from "../platform/config.js";
import { projectDshStaticInfo } from "../planning/agent-static.js";
import {
  createDefaultDatasetMatcher,
  type DatasetMatcher,
  type DatasetSelectionPlan,
  type DatasetTestProfile,
} from "../planning/planner.js";
import { loadDatasetDescriptionCatalog } from "../datasets/catalog.js";
import { countDatasetQuestionCases, loadDatasetCase, type DatasetCase } from "../datasets/loader.js";
import { loadCaseExecutionInput } from "../runtime/case-input.js";


/** 报告和 status.html 共用的十步稳定流程名称。 */
const STEP_LABELS = [
  "Freeze Target / Config / Assets",
  "Inspect DSH / Probe / Driver",
  "Build frozen evaluation plan",
  "Compile / Lease / Run objects / Preflight",
  "Prepare / Seed / File Before / Probe armed",
  "Execute one DSH Headless Attempt",
  "Collect Agent trace / Observer changes / Deliverables",
  "Score labels against all trace and Case grading",
  "Reset / independent verification / Cleanup",
  "Finalize scores / Save result JSON / Render HTML",
] as const;

/** HTML/report.json 内最多内联 256 KiB 单路输出；完整字节仍由 ArtifactStore 保存。 */
const REPORT_OUTPUT_PREVIEW_BYTES = 256 * 1024;


/** 测试 Fixture 可注入的明确故障点或行为；E2E 用它覆盖收尾分支。 */
export interface FixtureHooks {
  readonly behavior?: string;
  readonly onTargetStarted?: () => Promise<void> | void;
  readonly afterTargetBeforeDrain?: (workspacePath: string) => Promise<void>;
  readonly beforeReset?: () => Promise<void> | void;
  readonly afterReset?: (workspacePath: string) => Promise<void>;
  readonly beforeReportHtml?: () => Promise<void>;
}

/** CLI 交给主 Workflow 的完整输入。stopAfter 复用前两段流程实现 inspect/plan。 */
export interface RunWorkflowInput {
  /** Host-owned compatibility lease checks before execution and before evidence grading. */
  readonly verifyCompatibility?: () => Promise<void>;
  readonly headlessRuntimeFacts?: {permissionPreset:string;sandboxMode:string};
  readonly cwd: string;
  readonly descriptor: TargetDescriptor;
  readonly labelJudge?: LabelJudge;
  readonly datasetCatalogPath?: string;
  readonly datasetsRoot?: string;
  readonly labelsRoot?: string;
  /** Agent 自身 Trace 来源；与 Environment Observer 配置严格分离。 */
  readonly traceFile?: string;
  readonly environmentFile?: string;
  readonly testProfile?: DatasetTestProfile;
  readonly testSize?: import("../planning/planner.js").TestSize;
  readonly configFile?: string;
  readonly configOverrides?: Partial<MvpConfigValues>;
  readonly runId?: string;
  readonly fixtureMode?: boolean;
  readonly fixtureHooks?: FixtureHooks;
  readonly signal?: AbortSignal;
  /** 测试可注入替身；真实运行默认创建唯一一次统一 Planner 请求。 */
  readonly datasetMatcher?: DatasetMatcher;
  readonly allDatasets?: boolean;
  readonly evaluationMode?: "EFFECT" | "FULL";
  /** Batch 外层复用已经完成的一次 Planner 结果，避免每个 Case 再调用 LLM。 */
  readonly precomputedDatasetSelection?: DatasetSelectionPlan;
  /** Batch 当前执行单元；内部 Run 与最终 agent/run/case 目录解耦。 */
  readonly executionCase?: {
    readonly datasetId: string;
    readonly caseIndex: number;
    readonly resultRunId: string;
    readonly resultCaseId: string;
    readonly ordinal?: number;
  };
  /** Inspect/plan CLI reuse the same planning gates and stop before Run creation. */
  readonly stopAfter?: "INSPECT" | "PLAN";
}

/** inspect、plan、run 最终写到 CLI stdout 的统一摘要。 */
export interface WorkflowSummary {
  readonly schema: "evaldock.mvp.cli-summary/v1";
  readonly command: "run" | "inspect" | "plan";
  readonly status: "COMPLETED" | "PLAN_UNSATISFIABLE" | "FAILED" | "CANCELLED";
  readonly runId: string;
  readonly runState?: string;
  readonly scores?: readonly LabelScore[];
  readonly dimensions?: readonly DimensionScore[];
  readonly operationalHealth?: string;
  readonly fixture: boolean;
  readonly securityIsolation?: "AGENT_SEPARATED" | "SESSION_SEPARATED" | "PROCESS_FIXTURE";
  readonly reportJson?: string;
  readonly reportHtml?: string;
  readonly delivery?: string;
  readonly caseBundlePath?: string;
  readonly failureGroups: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly targetSnapshotId?: string;
  readonly inspectionId?: string;
  readonly selectedLabelIds?: readonly string[];
  readonly datasetTestProfile?: DatasetTestProfile;
  readonly selectedDatasets?: readonly {
    readonly datasetId: string;
    readonly evaluationLabelIds: readonly string[];
    readonly caseCount: number;
    readonly reason: string;
    readonly matchType?: "DIRECT" | "PROXY" | "BASELINE";
    readonly targetCapabilities?: readonly string[];
    readonly evidence?: readonly string[];
    readonly marginalValue?: string;
  }[];
  readonly totalCaseCount?: number;
  readonly datasetMatchModel?: string;
  readonly datasetMatchDurationMs?: number;
  readonly evaluationPlanId?: string;
  readonly agentTracePlanId?: string;
  readonly observationPlanId?: string;
  readonly dshSessionIds?: readonly string[];
  readonly recordsPath: string;
  readonly exitCode: 0 | 1 | 2 | 3 | 4 | 130;
}

/** report 子命令重建或验证 HTML 后返回的摘要。 */
export interface ReportWorkflowSummary {
  readonly schema: "evaldock.mvp.cli-summary/v1";
  readonly command: "report";
  readonly status: "COMPLETED";
  readonly runId: string;
  readonly reportJson: string;
  readonly reportHtml: string;
  readonly rendererVersion: string;
  readonly reportDigest: string;
  readonly htmlDigest: string;
  readonly htmlStatus: "CREATED" | "VERIFIED";
  readonly exitCode: 0;
}

/**
 * 从已提交且摘要验证通过的 report.json 重建 HTML；由 CLI report 命令调用。
 * 已存在 HTML 时只做确定性比对，缺失时才提交新文件。
 */
export async function rebuildCommittedReportHtml(input: {
  readonly reportRoot: string;
  readonly runId: string;
  readonly maxBytes: number;
}): Promise<ReportWorkflowSummary> {
  const runId = validateStableId<"RunId">(input.runId, "runId");
  const reportRoot = path.resolve(input.reportRoot);
  const jsonBytes = await readCommittedReportJson({
    reportRoot,
    runId,
    maxBytes: input.maxBytes,
  });
  const document = parseVerifiedReportDocument(jsonBytes.toString("utf8"));
  if (document.allTraceRef) await readTraceDirectory(path.join(reportRoot,runId),document.allTraceRef,input.maxBytes);
  const renderedBytes = Buffer.from(renderReportHtml(document), "utf8");
  let htmlStatus: ReportWorkflowSummary["htmlStatus"] = "VERIFIED";
  try {
    const committed = await readCommittedReportHtml({
      reportRoot,
      runId,
      maxBytes: input.maxBytes,
    });
    if (digestBytes(committed).value !== digestBytes(renderedBytes).value) {
      throw new Error("committed report.html does not match deterministic rendering");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await commitReportHtml({
      reportRoot,
      runId,
      bytes: renderedBytes,
      maxBytes: input.maxBytes,
    });
    htmlStatus = "CREATED";
  }
  return {
    schema: "evaldock.mvp.cli-summary/v1",
    command: "report",
    status: "COMPLETED",
    runId,
    reportJson: path.join(reportRoot, runId, "report.json"),
    reportHtml: path.join(reportRoot, runId, "report.html"),
    rendererVersion: "html/v3",
    reportDigest: digestBytes(jsonBytes).value,
    htmlDigest: digestBytes(renderedBytes).value,
    htmlStatus,
    exitCode: 0,
  };
}

/** Workflow 运行期间的内存索引；每项都对应已提交或即将提交的领域事实。 */
interface MutableWorkflowFacts {
  readonly evaluationMode: "EFFECT" | "FULL";
  readonly fixture: boolean;
  run?: EvaluationRun;
  evaluationCase?: EvaluationCase;
  attempt?: ExecutionAttempt;
  environment?: EnvironmentInstance;
  target?: TargetSnapshot;
  inspection?: InspectionSnapshot;
  datasetSelection?: DatasetSelectionPlan;
  evaluationPlan?: EvaluationPlan;
  agentTracePlan?: AgentTracePlan;
  observationPlan?: ObservationPlan;
  session?: ObservationSession;
  resetVerification?: ResetVerification;
  allTrace?: AllTrace;
  allTraceRef?: TraceDirectoryRef;
  caseData?: DatasetCase;
  labels: readonly LabelDefinition[];
  scores: LabelScore[];
  dimensions: readonly DimensionScore[];
  securityIsolation?: "AGENT_SEPARATED" | "SESSION_SEPARATED" | "PROCESS_FIXTURE";
  execution?: ExecutionDataView;
  readonly sources: SourceDescriptor[];
  readonly collectionStatuses: CollectionStatus[];
  readonly rawObservations: RawObservation[];
  readonly fileSnapshots: FileSnapshot[];
  readonly fileDiffs: FileDiff[];
  readonly failures: FailureRecord[];
  readonly artifacts: ArtifactRef[];
  readonly timeline: WorkflowStepView[];
}

/** 主链路的受控停止信号，携带 CLI 状态和退出码进入统一 catch/finally。 */
class WorkflowStop extends Error {
  public readonly exitCode: WorkflowSummary["exitCode"];
  public readonly status: WorkflowSummary["status"];

  /** 由规划失败、取消或阶段门禁创建；runEvaluationWorkflow 捕获并收尾。 */
  public constructor(
    message: string,
    exitCode: WorkflowSummary["exitCode"],
    status: WorkflowSummary["status"] = "FAILED",
  ) {
    super(message);
    this.name = "WorkflowStop";
    this.exitCode = exitCode;
    this.status = status;
  }
}

/** Fixture 只做一次确定性 Dataset 选择，不产生独立 Agent 标签。 */
function fixtureDatasetMatcher(): DatasetMatcher {
  return {
    select: async (input) => {
      const ranked = input.availableDatasets
        .filter((candidate) => candidate.availableCaseCount > 0)
        .sort((left, right) => left.datasetId.localeCompare(right.datasetId, "en"));
      const selected = ranked[0];
      if (selected === undefined) throw new Error("No Fixture Dataset is available");
      return Object.freeze({
        schema: "evaldock.mvp.unified-planner-result/v1" as const,
        profile: input.profile,
        selectedDatasets: Object.freeze([Object.freeze({
          datasetId: selected.datasetId,
          evaluationLabelIds: selected.labelIds,
          caseCount: 1,
          reason: "fixture deterministic selection",
        })]),
        evaluationLabelIds: selected.labelIds,
        totalCaseCount: 1,
        model: "fixture.unified-planner",
        durationMs: 0,
      });
    },
  };
}

/**
 * 执行一次完整评测。CLI 的 inspect/plan/run 都调用本函数；内部通过阶段门禁保证
 * 单 Case、单 Attempt、先证据后 Judge、先标签评分后结果提交、Reset 结果独立。
 */
export async function runEvaluationWorkflow(input: RunWorkflowInput): Promise<WorkflowSummary> {
  const runId = validateStableId<"RunId">(input.runId ?? createRunId(), "runId");
  const createdAt = new Date().toISOString();
  const fixtureMode = input.fixtureMode === true;
  if (!fixtureMode && input.fixtureHooks !== undefined) {
    throw new Error("fixtureHooks require explicit fixtureMode");
  }
  if (
    fixtureMode &&
    input.stopAfter === undefined &&
    input.fixtureHooks?.behavior === undefined
  ) {
    throw new Error("fixtureMode requires an explicit fixture behavior; no success behavior is assumed");
  }
  const services = await bootstrapApplication({
    cwd: input.cwd,
    runId,
    descriptor: input.descriptor,
    createdAt,
    ...(input.configFile === undefined ? {} : { configFile: input.configFile }),
    ...(input.configOverrides === undefined ? {} : { configOverrides: input.configOverrides }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const sessionSeparatedMode = !fixtureMode && services.config.minimumIsolationLevel === "SESSION_SEPARATED";
  const sharedDshHomePath = sessionSeparatedMode
    ? path.resolve(input.descriptor.sourceRoot, input.descriptor.dshHome)
    : undefined;
  const facts: MutableWorkflowFacts = {
    evaluationMode: input.evaluationMode ?? "FULL",
    fixture: fixtureMode,
    labels: [], scores: [], dimensions: [],
    sources: [],
    collectionStatuses: [],
    rawObservations: [],
    fileSnapshots: [],
    fileDiffs: [],
    failures: [],
    artifacts: [],
    timeline: STEP_LABELS.map((label, index) => ({
      number: (index + 1) as WorkflowStepView["number"],
      label,
      status: "PENDING",
      objectRefs: [],
      failureGroups: [],
    })),
  };
  let lease: LeaseFact | undefined;
  let prepared: PreparedEnvironment | undefined;
  let stagedExecutablePath: string | undefined;
  let leaseReleased = false;
  let reportPhase: ReportPhase = "NOT_STARTED";
  const artifactById = new Map<string, ArtifactRef>();
  const save = createPersistence(services, facts);

  try {
    markStep(facts, 1, "RUNNING");
    await save.immutable(services.config, services.config.configId);
    await save.immutable(input.descriptor, input.descriptor.targetId);
    if(input.headlessRuntimeFacts){if(!input.verifyCompatibility)throw Error("DSH_COMPATIBILITY_RECEIPT_REQUIRED");await input.verifyCompatibility();}
    const effectiveTargetConfig = input.descriptor.webEndpoint ? await inspectWebTarget(input.descriptor) : await readFile(path.join(input.descriptor.sourceRoot, "effective-config.json"), "utf8").then(value=>JSON.parse(value) as JsonObject).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT"&&sessionSeparatedMode)return inspectHeadlessInstallation(input.descriptor,input.headlessRuntimeFacts);throw error;});
    // 将 Target 冻结阶段产生的输入和清单提交为 Artifact，并建立本次 Run 的内存索引。
    const planningArtifactCommit = async (
      request: PlanningArtifactCommitRequest,
    ): Promise<ArtifactRef> => {
      assertSecretFreeBytes(request.bytes, services.config, "planning Artifact");
      const artifact = requireSucceeded(
        `commit ${request.artifactType}`,
        await services.artifacts.commit(
          services.operation("PLANNING", `artifact-${request.artifactId}`),
          request.bytes,
          {
            artifactId: validateStableId<"ArtifactId">(request.artifactId),
            scope: request.scope,
            artifactType: request.artifactType,
            logicalName: request.logicalName,
            mediaType: request.mediaType,
            producerVersion: request.producerVersion,
            createdAt: request.createdAt,
            sensitivity: request.sensitivity,
            redactionState: "NOT_REQUIRED",
          },
        ),
      );
      artifactById.set(String(artifact.artifactId), artifact);
      facts.artifacts.push(artifact);
      return artifact;
    };
    const target = requireSucceeded(
      "freeze target",
      await freezeTargetResult(
        services.operation("PLANNING", "freeze-target"),
        input.descriptor,
        services.config,
        {
          createdAt,
          producerVersion: EVALDOCK_VERSION,
          commitArtifact: planningArtifactCommit,
          effectiveConfig: effectiveTargetConfig,
          secretRefNames: services.config.secretRefNames,
        },
      ),
    );
    facts.target = target;
    const targetRef = await save.immutable(target, target.targetSnapshotId);
    // Inspector 和完整性校验通过 Ref 读取已经验证的规划 Artifact，不能直接读 Target 路径。
    const readPlanningArtifact = async (ref: Ref<ArtifactRef>): Promise<Uint8Array> => {
      const artifact = requireFullArtifact(artifactById, ref);
      return requireSucceeded(
        `read planning artifact ${ref.id}`,
        await services.artifacts.readVerified(
          services.operation("PLANNING", `read-${ref.id}`),
          artifact,
          artifact.scope,
          "INSPECTION",
        ),
      );
    };
    markStep(facts, 1, "SUCCEEDED", [targetRef]);

    markStep(facts, 2, "RUNNING");
    const inspection = requireSucceeded(
      "inspect target",
      await inspectTargetResult(
        services.operation("PLANNING", "inspect-target"),
        target,
        { createdAt: new Date().toISOString(), producerVersion: EVALDOCK_VERSION, readArtifact: readPlanningArtifact },
      ),
    );
    facts.inspection = inspection;
    const inspectionRef = await save.immutable(inspection, inspection.inspectionId);
    markStep(facts, 2, "SUCCEEDED", [inspectionRef]);
    if (input.stopAfter === "INSPECT") {
      return summary(facts, runId, fixtureMode, 0, "COMPLETED", services.config.runRoot, "inspect");
    }

    const datasetsRoot = path.resolve(input.datasetsRoot ?? process.env.EVALDOCK_DATASETS_ROOT ?? path.join(input.cwd, "datasets"));
    const externalCatalogPath = input.datasetCatalogPath ?? process.env.EVALDOCK_DATASET_CATALOG ?? path.join(datasetsRoot,"catalog.md");
    const external = await loadDatasetDescriptionCatalog(path.resolve(input.cwd,externalCatalogPath));
    const catalogCandidates = Object.freeze(await Promise.all(external.map(async candidate => ({
      ...candidate, availableCaseCount: await countDatasetQuestionCases(datasetsRoot,candidate.datasetId),
    }))));

    markStep(facts, 3, "RUNNING");
    if (input.precomputedDatasetSelection === undefined) {
      const datasetMatcher = input.allDatasets ? {select:async (request:Parameters<DatasetMatcher["select"]>[0])=>selectAllDatasets(request)} : input.datasetMatcher ?? (
        fixtureMode ? fixtureDatasetMatcher() : createDefaultDatasetMatcher(process.env, input.cwd)
      );
      facts.datasetSelection = await datasetMatcher.select({
        agentStaticInfo: projectDshStaticInfo(input.descriptor, inspection),
        availableDatasets: catalogCandidates,
        profile: input.testProfile ?? "STANDARD",
        ...(input.testSize === undefined ? {} : {testSize: input.testSize}),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } else {
      facts.datasetSelection = input.precomputedDatasetSelection;
    }
    const selectedDataset = input.executionCase === undefined
      ? facts.datasetSelection.selectedDatasets[0]!
      : facts.datasetSelection.selectedDatasets.find(
          (candidate) => String(candidate.datasetId) === input.executionCase!.datasetId,
        );
    if (selectedDataset === undefined) {
      throw new WorkflowStop("Requested Case Dataset is absent from the frozen Planner result", 2, "PLAN_UNSATISFIABLE");
    }
    const selectedCandidate = catalogCandidates.find(
      (candidate) => candidate.datasetId === selectedDataset.datasetId,
    );
    const caseIndex = input.executionCase?.caseIndex ?? 0;
    const executableSelection = input.executionCase === undefined
      ? facts.datasetSelection.selectedDatasets.length === 1 && selectedDataset.caseCount === 1
      : Number.isSafeInteger(caseIndex) && caseIndex >= 0 && caseIndex < (selectedCandidate?.availableCaseCount ?? 0);
    if (!executableSelection) {
      if (input.stopAfter === "PLAN") {
        markStep(facts, 3, "SUCCEEDED");
        return summary(facts, runId, fixtureMode, 0, "COMPLETED", services.config.runRoot, "plan");
      }
      await save.failure(makeFailure(
        target.scope,
        "PLAN_UNSATISFIABLE",
        "EVALDOCK",
        "PLANNING",
        "DATASET_SELECTION",
        "SELECTED_DATASETS_NOT_EXECUTABLE",
        "Selected Datasets require batch execution",
      ));
      markStep(facts, 3, "FAILED");
      return summary(
        facts,
        runId,
        fixtureMode,
        2,
        "PLAN_UNSATISFIABLE",
        services.config.runRoot,
        input.stopAfter === "PLAN" ? "plan" : "run",
      );
    }
    if (selectedCandidate === undefined) {
      throw new WorkflowStop("Dataset Planner selected an unavailable Dataset", 2, "PLAN_UNSATISFIABLE");
    }
    facts.caseData = await loadDatasetCase({
      datasetsRoot,datasetId:selectedDataset.datasetId,labelIds:selectedDataset.evaluationLabelIds,caseIndex,
    });
    const labels=await loadLabels(path.resolve(input.labelsRoot ?? process.env.EVALDOCK_LABEL_ROOT ?? path.join(input.cwd,"labels")));
    facts.labels = Object.freeze(facts.caseData.labelIds.map(id=>{
      const label=labels.find(item=>item.labelId===id);
      if(!label) throw new Error("Missing label standard: "+id);
      return label;
    }));
    const pack=await loadCaseExecutionInput({observerRegistry:services.observers,
      case:facts.caseData,datasetId:selectedDataset.datasetId,
      traceFile:path.resolve(input.traceFile ?? process.env.EVALDOCK_TRACE_FILE ?? path.join(input.cwd,"trace","dsh-runtime.json")),
      environmentFile:path.resolve(input.environmentFile ?? process.env.EVALDOCK_ENVIRONMENT_FILE ?? path.join(input.cwd,"environments","macos.json")),
    });
    const packRef = await save.immutable(pack,pack.inputId);
    await save.artifact(JSON.stringify({case:facts.caseData,labels:facts.labels})+"\n",
      target.scope,"grading-context."+runId,"GRADING_CONTEXT","grading-context.json","application/json","RESTRICTED");
    const planCompiler = services.planCompiler;
    // 把运行期计划编译器的 Artifact Port 绑定到本 Run 的真实 ArtifactStore，并同步维护事实索引。
    const planningArtifacts = {
      commit: async (
        _context: Parameters<typeof services.artifacts.commit>[0],
        bytes: Uint8Array | string,
        metadata: ArtifactCommitMetadata,
      ): Promise<PortResult<Readonly<ArtifactRef>>> => {
        assertSecretFreeBytes(bytes, services.config, "Planner Artifact");
        const result = await services.artifacts.commit(
          services.operation("PLANNING", `plan-artifact-${metadata.artifactId}`),
          bytes,
          metadata,
        );
        if (result.status === "SUCCEEDED") {
          artifactById.set(String(result.value.artifactId), result.value);
          facts.artifacts.push(result.value);
        }
        return result;
      },
    };
    const planBuild = requireSucceeded(
      "build plan",
      await planCompiler.buildPlan(
        services.operation("PLANNING", "build-plan"),
        {
          targetSnapshot: target,
          inspectionSnapshot: inspection,
          caseInput: pack,
          configSnapshot: services.config,
          sensors: services.sensors,
        },
        planningArtifacts,
      ),
    );
    if (planBuild.status === "UNSATISFIABLE") {
      await save.failures(planBuild.failureDrafts);
      markStep(facts, 3, "FAILED");
      return summary(
        facts,
        runId,
        fixtureMode,
        2,
        "PLAN_UNSATISFIABLE",
        services.config.runRoot,
        input.stopAfter === "PLAN" ? "plan" : "run",
      );
    }
    facts.evaluationPlan = planBuild.evaluationPlan;
    const evaluationPlanRef = await save.immutable(
      planBuild.evaluationPlan,
      planBuild.evaluationPlan.evaluationPlanId,
    );
    facts.agentTracePlan = planBuild.agentTracePlan;
    const agentTracePlanRef = await save.immutable(
      planBuild.agentTracePlan,
      planBuild.agentTracePlan.agentTracePlanId,
    );
    facts.observationPlan = planBuild.observationPlan;
    const observationPlanRef = await save.immutable(
      planBuild.observationPlan,
      planBuild.observationPlan.observationPlanId,
    );
    markStep(facts, 3, "SUCCEEDED", [
      packRef,
      evaluationPlanRef,
      agentTracePlanRef,
      observationPlanRef,
    ]);
    if (input.stopAfter === "PLAN") {
      return summary(facts, runId, fixtureMode, 0, "COMPLETED", services.config.runRoot, "plan");
    }

    // 纯 inspect/plan 消费的始终是已提交静态产物，无需在冻结后立刻重复扫描 Target。
    // 只有真正执行前才复核同一组规划关键文件，缩短 TOCTOU 窗口并避免 Planner 的重复 I/O。
    const integrity = requireSucceeded(
      "verify target integrity",
      await verifyTargetIntegrityResult(
        services.operation("PLANNING", "verify-target-before-execution"),
        target,
        {
          readArtifact: readPlanningArtifact,
          effectiveConfig: effectiveTargetConfig,
        },
        new Date().toISOString(),
      ),
    );
    if (integrity.status !== "VALID") {
      await save.failure(makeFailure(target.scope, "TARGET_INTEGRITY", "TARGET", "PLANNING", "FREEZE", "TARGET_INTEGRITY_INVALID", "Frozen Target changed before execution"));
      throw new WorkflowStop("target integrity verification failed", 2, "PLAN_UNSATISFIABLE");
    }

    markStep(facts, 4, "RUNNING");
    lease = await acquireLease(services.config.runRoot, runId);
    const resultCaseId = validateStableId(
      input.executionCase?.resultCaseId ?? `${runId}.case`,
      "caseId",
    );
    const ids = {
      runId,
      caseId: resultCaseId,
      attemptId: `${runId}.attempt`,
      environmentInstanceId: `${runId}.environment`,
      sourceRunId: `${runId}.source`,
    };
    const workspacePath = path.join(
      services.config.workspaceRoot,
      runId,
      ids.caseId,
      ids.attemptId,
    );
    const runtimeDshHomePath = path.join(
      services.config.runtimeDshHomeRoot,
      runId,
      ids.caseId,
      ids.attemptId,
    );
    const graph = createRuntimeProjectionGraph({
      ids,
      targetId: target.targetId,
      targetSnapshotId: target.targetSnapshotId,
      targetSnapshotRef: targetRef as Ref<TargetSnapshot>,
      evaluationPlanRef: evaluationPlanRef as Ref<EvaluationPlan>,
      observationPlanRef: observationPlanRef as Ref<ObservationPlan>,
      casePlanId: planBuild.evaluationPlan.casePlan.casePlanId,
      environmentId: planBuild.evaluationPlan.casePlan.environmentId,
      workspacePath,
      runtimeDshHomePath,
      now: new Date().toISOString(),
    });
    facts.run = graph.run;
    facts.evaluationCase = graph.evaluationCase;
    facts.attempt = graph.attempt;
    facts.environment = graph.environment;
    await save.projection(graph.run);
    await save.projection(graph.evaluationCase);
    await save.projection(graph.attempt);
    await save.projection(graph.environment);
    await save.lease(lease, graph.run.scope, "ACTIVE");
    facts.run = await save.transition(
      transitionRuntimeProjection({
        projection: facts.run,
        toState: "PREFLIGHTING",
        reasonCode: "PREFLIGHT_STARTED",
        occurredAt: new Date().toISOString(),
      }),
    );
    await updateStatus(services, facts, "PREFLIGHTING", save.failure);
    if (services.health.status !== "HEALTHY") {
      await save.failure(makeFailure(graph.run.scope, "PLATFORM_SECURITY_FAILURE", "EVALDOCK", "PLATFORM", "PREFLIGHT", "LOCAL_SERVICE_HEALTH_FAILED", "A required local storage or environment root is unhealthy"));
      throw new WorkflowStop("local service health check failed", 4);
    }
    const prepareStartedAt = new Date().toISOString() as IsoDateTime;
    try {
      prepared = await prepareEnvironment({
        workspaceRoot: services.config.workspaceRoot,
        runtimeDshHomeRoot: services.config.runtimeDshHomeRoot,
        runId,
        caseId: ids.caseId,
        attemptId: ids.attemptId,
        ...(sessionSeparatedMode || input.descriptor.webEndpoint ? {} : {
          sourceDshHome: path.resolve(input.descriptor.sourceRoot, input.descriptor.dshHome),
          profile: input.descriptor.profile,
        }),
      });
    } catch (error) {
      const failureRef = await save.failure(makeFailure(
        graph.scope,
        "ENVIRONMENT_FAILURE",
        "ENVIRONMENT",
        "ENVIRONMENT_CONTROLLER",
        "PREPARE",
        "ENVIRONMENT_PREPARE_FAILED",
        "Attempt environment preparation failed",
      ));
      await save.control(graph.scope, "ENV_PREPARE", "FAILED", {
        startedAt: prepareStartedAt,
        failureRefs: [failureRef],
      });
      throw error;
    }
    const stagedTarget = sessionSeparatedMode || input.descriptor.webEndpoint ? {stagedExecutablePath:target.dshExecutablePath} : await stageTargetRuntime({
      sourceRoot: input.descriptor.sourceRoot,
      executablePath: target.dshExecutablePath,
      expectedExecutableSha256: target.dshEntrypointDigest.value,
      runtimeDshHomeRoot: services.config.runtimeDshHomeRoot,
      runtimeDshHomePath: prepared.runtimeDshHomePath,
      runId,
      caseId: ids.caseId,
      attemptId: ids.attemptId,
    });
    stagedExecutablePath = stagedTarget.stagedExecutablePath;
    const preflightResult = await runSecurityPreflight({
      deniedRoots: [
        services.config.targetRoot,
        services.config.runRoot,
        services.config.artifactRoot,
        services.config.reportRoot,
        services.config.workspaceRoot,
        services.config.runtimeDshHomeRoot,
      ],
      allowedRoots: [prepared.workspacePath, prepared.runtimeDshHomePath],
      ...(fixtureMode ? {} : { expectedFrameworkIdentity: "evaldock" }),
      expectedTargetIdentity: input.descriptor.targetIdentity,
      allowedModelEndpoints: services.config.allowedModelEndpoints,
      allowFixtureIdentity: fixtureMode,
      allowSessionIdentity: sessionSeparatedMode,
    });
    if (preflightResult.status !== "FAILED") {
      facts.securityIsolation = preflightResult.isolationLevel;
    }
    const preflightFailureRef = preflightResult.status === "FAILED"
      ? await save.failure(makeFailure(
          graph.run.scope,
          "PLATFORM_SECURITY_FAILURE",
          "EVALDOCK",
          "PLATFORM",
          "PREFLIGHT",
          "SECURITY_PREFLIGHT_FAILED",
          "Required OS identity, root isolation or network policy was not verified",
        ))
      : undefined;
    const preflight = withContentDigest({
      schema: "evaldock.mvp.security-preflight/v1" as const,
      preflightId: validateStableId<"SecurityPreflightId">(`preflight.${runId}`),
      scope: graph.run.scope,
      runId,
      targetIdentity: preflightResult.targetIdentity?.name ?? input.descriptor.targetIdentity,
      observerIdentity: preflightResult.observerIdentity.name,
      judgeIdentity: preflightResult.judgeIdentity.name,
      allowedRoots: sessionSeparatedMode
        ? ["attempt.workspace", "attempt.runtime-home", "shared-dsh-session-home"]
        : ["attempt.workspace", "attempt.runtime-home"],
      deniedRoots: sessionSeparatedMode
        ? []
        : ["target", "records", "artifacts", "reports", "workspace-parent", "runtime-home-parent", "framework-home", "docker-socket", "sudoers"],
      networkPolicyDigest: digestValue(sessionSeparatedMode
        ? { default: "NOT_VERIFIED", endpoints: services.config.allowedModelEndpoints }
        : { default: "DENY", endpoints: services.config.allowedModelEndpoints }),
      telemetryDisabled: preflightResult.telemetryDisabled,
      probeOrderValid: inspection.probeOrderStatus === "VALID",
      status: preflightResult.status === "PASSED" ? "PASSED" as const : "FAILED" as const,
      failureRefs: preflightFailureRef === undefined ? [] : [preflightFailureRef],
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    }) as SecurityPreflight;
    const preflightRef = await save.immutable(preflight, preflight.preflightId);
    if (preflightResult.status === "FAILED") {
      markStep(facts, 4, "FAILED", [
        refForProjection(facts.run),
        preflightRef,
        preflightFailureRef!,
      ]);
      throw new WorkflowStop("security preflight failed", 4);
    }
    markStep(facts, 4, "SUCCEEDED", [refForProjection(graph.run), preflightRef]);
    await updateStatus(
      services,
      facts,
      fixtureMode ? "PROCESS_FIXTURE_PREFLIGHT" : "PREFLIGHT_COMPLETE",
      save.failure,
    );

    markStep(facts, 5, "RUNNING");
    facts.environment = await save.transition(
      transitionRuntimeProjection({
        projection: facts.environment!,
        toState: "PREPARED",
        reasonCode: "ENVIRONMENT_PREPARED",
        occurredAt: new Date().toISOString(),
      }),
    );
    await save.control(graph.scope, "ENV_PREPARE", "SUCCEEDED", {
      startedAt: prepareStartedAt,
    });
    const seedEntries = seedSpecs(planBuild.evaluationPlan);
    const seedStartedAt = new Date().toISOString() as IsoDateTime;
    let seeded: Awaited<ReturnType<typeof seedEnvironment>>;
    try {
      seeded = await seedEnvironment(prepared.workspacePath, seedEntries);
    } catch (error) {
      const failureRef = await save.failure(makeFailure(
        graph.scope,
        "ENVIRONMENT_FAILURE",
        "ENVIRONMENT",
        "ENVIRONMENT_CONTROLLER",
        "SEED",
        "ENVIRONMENT_SEED_FAILED",
        "Attempt environment seeding failed",
      ));
      await save.control(graph.scope, "ENV_SEED", "FAILED", {
        startedAt: seedStartedAt,
        failureRefs: [failureRef],
      });
      throw error;
    }
    const seedManifest = withContentDigest({
      schema: "evaldock.mvp.seed-manifest/v1" as const,
      seedManifestId: validateStableId<"SeedManifestId">(`seed.${ids.attemptId}`),
      scope: graph.scope,
      environmentInstanceRef: refForProjection(facts.environment),
      resetGeneration: 0,
      resourceEntries: seeded.map((entry) => ({
        portablePath: entry.portablePath,
        entryType: entry.entryType,
        ...(entry.sha256 === undefined || entry.byteLength === undefined
          ? {}
          : {
              contentDigest: {
                algorithm: "sha256" as const,
                value: entry.sha256,
                byteLength: entry.byteLength,
              },
            }),
        mode: Number.parseInt(entry.mode, 8),
        readOnlyForTarget: entry.readOnlyForTarget,
      })),
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    }) as SeedManifest;
    const seedRef = await save.immutable(seedManifest, seedManifest.seedManifestId);
    facts.environment = await save.transition(
      transitionRuntimeProjection({
        projection: facts.environment,
        toState: "SEEDED",
        reasonCode: "ENVIRONMENT_SEEDED",
        occurredAt: new Date().toISOString(),
        supportingRefs: [seedRef],
        patch: { seedManifestRef: seedRef },
      }),
    );
    await save.control(graph.scope, "ENV_SEED", "SUCCEEDED", {
      startedAt: seedStartedAt,
      identityRefs: [seedRef],
    });
    const probeRequirement = planBuild.agentTracePlan.sourceRequirements.find(
      (item) => item.sourceType === "DSH_PROBE",
    )!;
    const fileRequirement = planBuild.observationPlan.sourceRequirements.find(
      (item) => item.sourceType === "FILESYSTEM",
    )!;
    const labRequirements = planBuild.observationPlan.sourceRequirements.filter(
      (item) => item.sourceRequirementId !== fileRequirement.sourceRequirementId,
    );
    const probeSource = createProbeSourceDescriptor({
      sourceId: `source.probe.${ids.attemptId}`,
      scope: graph.scope,
      resourceBinding: probeRequirement.resourceBinding,
      contentMode: probeRequirement.contentMode,
      watermarkDefinition: probeRequirement.watermarkDefinition,
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    });
    const fileSource = createFileSourceDescriptor({
      sourceId: `source.file.${ids.attemptId}`,
      scope: graph.scope,
      resourceBinding: fileRequirement.resourceBinding,
      contentMode: fileRequirement.contentMode,
      watermarkDefinition: fileRequirement.watermarkDefinition,
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    });
    const labSources = labRequirements.map((requirement) => createLabSourceDescriptor({
      registry: services.observers,
      requirement,
      sourceId: `source.${requirement.sourceType.toLowerCase().replaceAll("_", "-")}.${ids.attemptId}`,
      scope: graph.scope,
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    }));
    const probeSourceRef = await save.immutable(probeSource, probeSource.sourceId);
    const fileSourceRef = await save.immutable(fileSource, fileSource.sourceId);
    const labSourceRefs = await Promise.all(
      labSources.map((source) => save.immutable(source, source.sourceId)),
    );
    facts.sources.push(probeSource, fileSource, ...labSources);
    let session = createObservationSession({
      observationSessionId: `${runId}.observation`,
      attemptId: ids.attemptId,
      scope: graph.scope,
      agentTracePlanRef: agentTracePlanRef as Ref<AgentTracePlan>,
      observationPlanRef: observationPlanRef as Ref<ObservationPlan>,
      sourceRefs: [probeSourceRef, fileSourceRef, ...labSourceRefs],
      createdAt: new Date().toISOString(),
    });
    await save.projection(session);
    session = await save.transition(
      beginBaseline(session, { occurredAt: new Date().toISOString(), reasonCode: "FILE_BASELINE_STARTED" }),
    );
    const fileSensor = services.fileSensor;
    const bindingRuntime = await issueObserverBinding({
      environmentInstanceId: facts.environment.environmentInstanceId,
      resetGeneration: 0,
      sourceRequirementId: String(fileRequirement.sourceRequirementId),
      resourceBinding: fileRequirement.resourceBinding,
      sensorImplementationId: String(fileRequirement.sensorImplementationId),
      sensorImplementationVersion: fileRequirement.sensorImplementationVersion,
      sensorCapabilityDigest: fileRequirement.sensorCapabilityDigest,
      expiresAt: new Date(Date.now() + services.config.runDeadlineMs).toISOString(),
      workspacePath: prepared.workspacePath,
    });
    const observationRequest = {
      kind: "CASE_RUN" as const,
      observationPlan: planBuild.observationPlan,
      environment: facts.environment as EnvironmentInstance & { readonly state: "SEEDED" },
      preparedBindings: [bindingRuntime.binding],
      sensorRegistryDigest: FILE_SENSOR_REGISTRY_DIGEST,
    };
    const beforeDraft = (
      await fileSensor.captureBefore({
        request: observationRequest,
        sourceRequirementId: String(fileRequirement.sourceRequirementId),
        expectedSensorRegistryDigest: FILE_SENSOR_REGISTRY_DIGEST,
        rootPath: bindingRuntime.workspacePath,
        snapshotId: `snapshot.before.${ids.attemptId}`,
        attemptId: ids.attemptId,
        maxFileBytes: services.config.maxArtifactBytes,
      })
    ).snapshot;
    const before = materializeFileSnapshot(beforeDraft, recordMetadata(graph.scope));
    const beforeRef = await save.immutable(before, before.snapshotId);
    const beforeArtifact = await save.artifact(
      serializeFileSnapshotArtifact(before),
      graph.scope,
      `raw-file-before.${ids.attemptId}`,
      "FILE_SNAPSHOT_RAW",
      "file-before.json",
      "application/json",
      "RESTRICTED",
    );
    const beforeRaw = materializeFileObservation({
      observationId: `raw.file.before.${ids.attemptId}`,
      scope: graph.scope,
      snapshot: before,
      snapshotRef: beforeRef,
      sourceRef: fileSourceRef,
      snapshotArtifact: beforeArtifact,
      snapshotArtifactRef: refForArtifact(beforeArtifact),
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    });
    const beforeRawRef = await save.immutable(beforeRaw, beforeRaw.observationId);
    const observedUid = preflightResult.targetIdentity?.uid ?? process.getuid?.() ?? 0;
    if (before.completeness !== "COMPLETE") {
      const baselineFailureRefs = await save.failures(fileCollectionFailureDrafts({
        scope: graph.scope,
        snapshots: [before],
        requiredPhases: ["BEFORE"],
        stableWindowComplete: true,
        occurredAt: new Date().toISOString(),
        artifactRefs: [refForArtifact(beforeArtifact)],
      }));
      const baselineStatus = materializeFileCollectionStatus({
        collectionStatusId: `collection.baseline.${ids.attemptId}`,
        scope: graph.scope,
        sourceRef: fileSourceRef,
        snapshots: [before],
        openedAt: before.scanStartedAt,
        closedAt: before.scanCompletedAt,
        requiredPhases: ["BEFORE"],
        stableWindowComplete: true,
        failureRefs: baselineFailureRefs,
        createdAt: new Date().toISOString(),
        producerVersion: EVALDOCK_VERSION,
      });
      const baselineStatusRef = await save.immutable(
        baselineStatus,
        baselineStatus.collectionStatusId,
      );
      facts.collectionStatuses.push(baselineStatus);
      session = await save.transition(failObservation(session, {
        occurredAt: new Date().toISOString(),
        reasonCode: "FILE_BASELINE_INCOMPLETE",
        failureRefs: baselineFailureRefs,
        supportingRefs: [beforeRef, beforeRawRef, baselineStatusRef],
      }));
      facts.session = session;
      markStep(facts, 5, "FAILED", [beforeRef, baselineStatusRef, refForProjection(session)]);
      throw new WorkflowStop("independent file baseline is incomplete", 4);
    }
    session = await save.transition(
      completeBaseline(session, {
        occurredAt: new Date().toISOString(),
        reasonCode: "FILE_BASELINE_COMMITTED",
        beforeSnapshotRef: beforeRef,
        supportingRefs: [beforeRef, beforeRawRef],
      }),
    );
    facts.session = session;
    markStep(facts, 5, "SUCCEEDED", [seedRef, beforeRef, refForProjection(session)]);
    await updateStatus(services, facts, "BASELINED", save.failure);

    const missingSecretRefs = services.config.secretRefNames.filter(
      (name) => process.env[name] === undefined,
    );
    if (missingSecretRefs.length > 0) {
      await save.failure(makeFailure(
        graph.scope,
        "PLATFORM_SECURITY_FAILURE",
        "EXTERNAL_DEPENDENCY",
        "PLATFORM",
        "SECRET_RESOLUTION",
        "SECRET_REF_UNRESOLVED",
        `Configured Secret references are unresolved: ${missingSecretRefs.join(", ")}`,
      ));
      throw new WorkflowStop("configured Secret reference is unresolved", 4);
    }

    markStep(facts, 6, "RUNNING");
    facts.run = await save.transition(transitionRuntimeProjection({ projection: facts.run!, toState: "RUNNING", reasonCode: "EXECUTION_STARTED", occurredAt: new Date().toISOString() }));
    facts.evaluationCase = await save.transition(transitionRuntimeProjection({ projection: facts.evaluationCase!, toState: "RUNNING", reasonCode: "CASE_STARTED", occurredAt: new Date().toISOString() }));
    facts.environment = await save.transition(transitionRuntimeProjection({ projection: facts.environment, toState: "IN_USE", reasonCode: "TARGET_RECEIVED_ENVIRONMENT", occurredAt: new Date().toISOString(), patch: { baselineSnapshotRef: beforeRef } }));
    session = await save.transition(activateObservation(session, { occurredAt: new Date().toISOString(), reasonCode: "PROBE_ARMED" }));
    facts.session = session;
    facts.attempt = await save.transition(transitionRuntimeProjection({ projection: facts.attempt!, toState: "RUNNING", reasonCode: "TARGET_STARTING", occurredAt: new Date().toISOString(), patch: { startedAt: new Date().toISOString() } }));
    const taskArtifact = requireFullArtifact(artifactById, planBuild.evaluationPlan.casePlan.agentTaskArtifactRef);
    const task = Buffer.from(requireSucceeded("read AgentTask", await services.artifacts.readVerified(services.operation("RUNTIME", "read-agent-task"), taskArtifact, taskArtifact.scope, "TASK_INPUT"))).toString("utf8");
    assertSafeAgentTask(task, [
      services.config.runRoot,
      services.config.artifactRoot,
      services.config.reportRoot,
      services.config.resultRoot,
    ]);
    facts.execution = { task };
    if (stagedExecutablePath === undefined) {
      throw new Error("staged target executable is unavailable");
    }
    const labRun = await startLabObservers({
      cwd: input.cwd,
      outputDirectory: path.join(prepared.runtimeDshHomePath, "observer-events"),
      caseId: ids.caseId,
      agentId: String(target.targetId),
      requirements: planBuild.observationPlan.sourceRequirements,
      workspacePath: prepared.workspacePath,
      observedUid,
      attemptId: ids.attemptId,
      maxFileBytes: services.config.maxArtifactBytes,
    });
    // 将 Target 启动异常统一收敛为 TargetExecutionResult，后续仍可 Drain 并形成证据。
      const sessionsBefore = sharedDshHomePath === undefined
        ? new Map<string, string>()
        : await listDshSessionArchives(sharedDshHomePath);
      const targetPromise = (async (): Promise<TargetExecutionResult> => {
      const modelEnvironment: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const name of services.config.secretRefNames) {
        const value = process.env[name];
        if (value === undefined) {
          throw new Error(`Secret reference became unavailable before Target start: ${name}`);
        }
        modelEnvironment[name] = value;
      }
      try {
        await input.verifyCompatibility?.();
        const runTarget = input.descriptor.webEndpoint
          ? (request: Parameters<typeof executeTarget>[0]) => executeWebTarget(request, input.descriptor)
          : executeTarget;
        return await runTarget({
          executablePath: stagedExecutablePath,
          profile: target.profile,
          task,
          inputs:facts.caseData!.inputs,
          cwd: prepared.workspacePath,
          runtimeDshHomePath: prepared.runtimeDshHomePath,
          ...(sharedDshHomePath === undefined ? {} : { sessionDshHomePath: sharedDshHomePath }),
          probeOutputPath: prepared.probeOutputPath,
          sourceRunId: ids.sourceRunId,
          displayCase: {runId:input.executionCase?.resultRunId ?? runId,ordinal:input.executionCase?.ordinal ?? 1,name:String(facts.caseData!.question.id ?? facts.caseData!.caseId)},
          contentMode: services.config.contentMode,
          deadlineMs: planBuild.evaluationPlan.casePlan.deadlineMs,
          maxOutputBytes: services.config.maxArtifactBytes,
          modelEnvironment,
          ...(fixtureMode || sessionSeparatedMode || preflightResult.targetIdentity === undefined
            ? {}
            : {
                targetUid: preflightResult.targetIdentity.uid,
                targetGid: preflightResult.targetIdentity.gid,
              }),
          ...(input.fixtureHooks?.behavior === undefined ? {} : { fixtureBehavior: input.fixtureHooks.behavior }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          onStarted: async () => {
            await save.control(graph.scope, "TARGET_START", "SUCCEEDED");
            await updateStatus(services, facts, "TARGET_RUNNING", save.failure);
            await input.fixtureHooks?.onTargetStarted?.();
          },
        });
      } finally {
        for (const name of Object.keys(modelEnvironment)) delete modelEnvironment[name];
      }
    })();
    let labCaptures: readonly LabCapture[] = Object.freeze([]);
    const targetResult = await targetPromise.finally(async () => {
      labCaptures = await labRun.stop();
    });
    const sessionsAfter = sharedDshHomePath === undefined
      ? new Map<string, string>()
      : await listDshSessionArchives(sharedDshHomePath);
    const newSessionCandidates = [...sessionsAfter]
      .filter(([sessionId]) => !sessionsBefore.has(sessionId))
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    const sessionBudget = Math.max(
      1,
      Math.floor(services.config.maxArtifactBytes / Math.max(1, newSessionCandidates.length)),
    );
    const expectedSessionWorkspacePath = prepared.workspacePath;
    const sessionSources = (await Promise.all(newSessionCandidates.map(async ([sessionId, archivePath]) => ({
        sessionId,
        ...(await readDshSessionArchive(archivePath, sessionBudget)),
      })))).filter((session) => dshSessionCwd(session.jsonl) === expectedSessionWorkspacePath);
    const dshSessionIds = sessionSources.map((session) => session.sessionId);
    const nativeProbeTrace = targetResult.pid === undefined
      ? undefined
      : await readNativeProbeTrace({
          probeOutputPath: prepared.probeOutputPath,
          sourceRunId: ids.sourceRunId,
          pid: targetResult.pid,
          startedAt: targetResult.startedAt,
          endedAt: targetResult.endedAt,
          maxBytes: Math.min(
            planBuild.agentTracePlan.sourceRequirements.find(
              (item) => item.sourceType === "DSH_PROBE",
            )!.maxBytes,
            services.config.maxArtifactBytes,
          ),
        });
    if (nativeProbeTrace !== undefined) {
      await writeFile(prepared.probeOutputPath, nativeProbeTrace.bytes, { flag: "w", mode: 0o600 });
    } else if (sessionSeparatedMode && targetResult.pid !== undefined && sessionSources.length > 0) {
      const traceBytes = dshSessionsToProbeJsonl({
        sessions: sessionSources,
        sourceRunId: ids.sourceRunId,
        pid: targetResult.pid,
        startedAt: targetResult.startedAt,
        endedAt: targetResult.endedAt,
      });
      await writeFile(prepared.probeOutputPath, traceBytes, { flag: "w", mode: 0o600 });
    }
    const adaptedTraceTruncated = nativeProbeTrace?.truncated ??
      (sessionSeparatedMode && sessionSources.some((session) => session.truncated));
    const stdoutArtifact = await save.outputArtifact(targetResult.stdout, graph.scope, `stdout.${ids.attemptId}`, "stdout.txt", services.config);
    const stderrArtifact = await save.outputArtifact(targetResult.stderr, graph.scope, `stderr.${ids.attemptId}`, "stderr.txt", services.config);
    const stdoutPreview = outputPreview(targetResult.stdout);
    const stderrPreview = outputPreview(targetResult.stderr);
    facts.execution = {
      task,
      terminationKind: targetResult.terminationKind,
      ...(targetResult.inputDelivery ? {inputDelivery:targetResult.inputDelivery} : {}),
      ...(targetResult.exitCode === undefined ? {} : { exitCode: targetResult.exitCode }),
      ...(targetResult.signal === undefined ? {} : { signal: targetResult.signal }),
      ...(targetResult.pid === undefined ? {} : { pid: targetResult.pid }),
      startedAt: targetResult.startedAt,
      endedAt: targetResult.endedAt,
      durationMs: Math.max(0, Date.parse(targetResult.endedAt) - Date.parse(targetResult.startedAt)),
      stdout: stdoutArtifact.sensitivity === "EXPORTABLE"
        ? stdoutPreview.text
        : "[RESTRICTED: configured Secret canary detected]",
      stderr: stderrArtifact.sensitivity === "EXPORTABLE"
        ? stderrPreview.text
        : "[RESTRICTED: configured Secret canary detected]",
      stdoutCapturedBytes: targetResult.stdout.byteLength,
      stderrCapturedBytes: targetResult.stderr.byteLength,
      stdoutCaptureTruncated: targetResult.stdoutTruncated,
      stderrCaptureTruncated: targetResult.stderrTruncated,
      stdoutReportTruncated: stdoutPreview.truncated,
      stderrReportTruncated: stderrPreview.truncated,
      stdoutArtifactId: String(stdoutArtifact.artifactId),
      stderrArtifactId: String(stderrArtifact.artifactId),
      ...(dshSessionIds.length === 0 ? {} : { dshSessionIds: Object.freeze(dshSessionIds) }),
    };
    let targetFailureRef: Ref<FailureRecord> | undefined;
    if (targetResult.terminationKind !== "EXITED") {
      targetFailureRef = await save.failure(targetFailure(targetResult, graph.scope));
    }
    facts.attempt = await save.transition(
      transitionRuntimeProjection({
        projection: facts.attempt,
        toState: attemptTerminalState(targetResult),
        reasonCode: `TARGET_${targetResult.terminationKind}`,
        occurredAt: targetResult.endedAt,
        ...(targetFailureRef === undefined ? {} : { failureRefs: [targetFailureRef] }),
        patch: {
          endedAt: targetResult.endedAt,
          terminationKind: targetResult.terminationKind,
          stdoutArtifactRef: refForArtifact(stdoutArtifact),
          stderrArtifactRef: refForArtifact(stderrArtifact),
        },
      }),
    );
    await save.control(
      graph.scope,
      "TARGET_STOP",
      targetResult.terminationKind === "EXITED"
        ? "SUCCEEDED"
        : targetResult.terminationKind === "CANCELLED"
          ? "CANCELLED"
          : "FAILED",
      {
        startedAt: targetResult.startedAt as IsoDateTime,
        identityRefs: [refForProjection(facts.attempt)],
        ...(targetFailureRef === undefined ? {} : { failureRefs: [targetFailureRef] }),
      },
    );
    markStep(facts, 6, "SUCCEEDED", [refForProjection(facts.attempt)]);
    await updateStatus(services, facts, "TARGET_TERMINATED", save.failure);
    await input.fixtureHooks?.afterTargetBeforeDrain?.(prepared.workspacePath);

    markStep(facts, 7, "RUNNING");
    session = await save.transition(beginDrain(session, { occurredAt: targetResult.endedAt, targetTerminatedAt: targetResult.endedAt, reasonCode: "BOUNDED_DRAIN_STARTED", supportingRefs: [refForProjection(facts.attempt)] }));

    const probeRead = await readProbeFileBounded({
      path: prepared.probeOutputPath,
      maxBytes: Math.min(probeRequirement.maxBytes, services.config.maxArtifactBytes),
      timeoutMs: probeRequirement.timeoutMs,
    });
    const probeBytes = Buffer.from(probeRead.bytes);
    const secretCanaries = services.config.secretRefNames
      .map((name) => process.env[name])
      .filter((value): value is string => value !== undefined);
    const probeLeaks = findSecretLeaks(probeBytes, secretCanaries);
    const probeArtifact = await save.artifact(
      probeBytes,
      graph.scope,
      `raw-probe.${ids.attemptId}`,
      "DSH_PROBE_JSONL",
      "probe.jsonl",
      "application/x-ndjson",
      "RESTRICTED",
      probeLeaks.length === 0 ? "NOT_REQUIRED" : "FAILED",
    );
    const parsedProbe = parseProbeJsonl(probeBytes, {
      expectedRunId: ids.sourceRunId,
      ...(targetResult.pid === undefined ? {} : { expectedPid: targetResult.pid }),
      attemptId: ids.attemptId,
      sourceRef: probeSourceRef,
      collectionStatusId: `collection.probe.${ids.attemptId}`,
      openedAt: targetResult.startedAt,
      closedAt: targetResult.endedAt,
      observedAt: new Date().toISOString(),
      rawArtifactRef: refForArtifact(probeArtifact),
      inputTruncated: probeRead.truncated || adaptedTraceTruncated,
      contentRestricted: probeLeaks.length > 0,
    });
    const probeFailureRefs = [
      ...await save.failures(probeIssueFailureDrafts(parsedProbe, {
        scope: graph.scope,
        occurredAt: new Date().toISOString(),
        rawArtifactRef: refForArtifact(probeArtifact),
      })),
      ...(probeLeaks.length === 0
        ? []
        : [await save.failure({
            ...makeFailure(
              graph.scope,
              "TARGET_SECURITY_VIOLATION",
              "TARGET",
              "TARGET",
              "PROBE_DRAIN",
              "SECRET_CANARY_EXPOSED",
              "Runtime Probe content matched a configured Secret canary and was isolated",
            ),
            artifactRefs: [refForArtifact(probeArtifact)],
          })]),
    ];
    const probeCollection = materializeProbeCollection({ scope: graph.scope, parseResult: parsedProbe, rawArtifact: probeArtifact, rawArtifactRef: refForArtifact(probeArtifact), createdAt: new Date().toISOString(), producerVersion: EVALDOCK_VERSION, failureRefs: probeFailureRefs });
    const traceFinalResponse = finalResponseFromTrace(probeCollection.observations);
    const finalResponseRaw = stdoutPreview.text.length > 0 ? stdoutPreview.text : traceFinalResponse;
    const finalResponsePreview = outputPreview(Buffer.from(finalResponseRaw, "utf8"));
    const finalResponseArtifact = stdoutPreview.text.length > 0
      ? stdoutArtifact
      : await save.outputArtifact(
          Buffer.from(finalResponseRaw, "utf8"),
          graph.scope,
          `final-response.${ids.attemptId}`,
          "final-response.txt",
          services.config,
        );
    const probeStatusRef = await save.immutable(probeCollection.collectionStatus, probeCollection.collectionStatus.collectionStatusId);
    facts.collectionStatuses.push(probeCollection.collectionStatus);

    const stability = await captureStableAfter(fileSensor, {
      request: observationRequest,
      sourceRequirementId: String(fileRequirement.sourceRequirementId),
      expectedSensorRegistryDigest: FILE_SENSOR_REGISTRY_DIGEST,
      rootPath: bindingRuntime.workspacePath,
      attemptId: ids.attemptId,
      maxFileBytes: services.config.maxArtifactBytes,
      stableWindowMs: planBuild.evaluationPlan.casePlan.stableWindowMs,
      stableMaxWaitMs: services.config.stableMaxWaitMs,
    });
    const after = materializeFileSnapshot(stability.snapshot, recordMetadata(graph.scope));
    const afterRef = await save.immutable(after, after.snapshotId);
    const afterArtifact = await save.artifact(serializeFileSnapshotArtifact(after), graph.scope, `raw-file-after.${ids.attemptId}`, "FILE_SNAPSHOT_RAW", "file-after.json", "application/json", "RESTRICTED");
    const afterRaw = materializeFileObservation({ observationId: `raw.file.after.${ids.attemptId}`, scope: graph.scope, snapshot: after, snapshotRef: afterRef, sourceRef: fileSourceRef, snapshotArtifact: afterArtifact, snapshotArtifactRef: refForArtifact(afterArtifact), createdAt: new Date().toISOString(), producerVersion: EVALDOCK_VERSION });
    const afterRawRef = await save.immutable(afterRaw, afterRaw.observationId);
    const diffDraft = buildFileDiff({ diffId: `diff.${ids.attemptId}`, beforeSnapshot: beforeDraft, afterSnapshot: stability.snapshot, beforeSnapshotRef: beforeRef, afterSnapshotRef: afterRef, allowDiagnosticPartial: true });
    const fileDiff = materializeFileDiff(diffDraft, recordMetadata(graph.scope));
    const diffRef = await save.immutable(fileDiff, fileDiff.diffId);
    // 在 Reset 删除 Workspace 前，只归档 Dataset 允许路径内由 Agent 新增或修改的真实交付文件。
    // 路径来自 CasePlan，不要求所有 Dataset 都使用 output/；最终 Case Bundle 再按原相对路径还原。
    const deliverableFiles: Array<{
      readonly portablePath: string;
      readonly artifactId: string;
      readonly byteLength: number;
      readonly mediaType: string;
      readonly sensitivity: "EXPORTABLE" | "RESTRICTED";
    }> = [];
    const deliverableArtifacts: ArtifactRef[] = [];
    const submissionFiles: SubmissionFileEvidenceInput[] = [];
    let deliverableBytes = 0;
    let submissionContentBudget = SUBMISSION_CONTENT_BUDGET_BYTES;
    const changedFiles = new Map(
      [...fileDiff.added, ...fileDiff.modified, ...fileDiff.typeChanged]
        .filter((change) => change.after?.entryType === "FILE" && change.after.resolvedWithinRoot)
        .map((change) => [String(change.portablePath), change] as const),
    );
    for (const [portablePath] of [...changedFiles].sort(([left], [right]) => left.localeCompare(right, "en"))) {
      const normalized = path.posix.normalize(portablePath);
      const allowed = planBuild.evaluationPlan.casePlan.allowedPaths.some((allowedPath) => {
        const root = String(allowedPath);
        return normalized === root || normalized.startsWith(`${root}/`);
      });
      if (!allowed || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) continue;
      const absolute = path.resolve(prepared.workspacePath, ...normalized.split("/"));
      const relative = path.relative(prepared.workspacePath, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const metadata = await lstat(absolute).catch(() => undefined);
      if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (metadata.size > services.config.maxArtifactBytes - deliverableBytes) {
        const { consumedBytes: _cost, ...index } = submissionIndex("ARCHIVE_LIMIT");
        submissionFiles.push({
          portablePath: normalized, mediaType: deliverableMediaType(normalized),
          byteLength: metadata.size, contentRestricted: false, archiveStatus: "NOT_ARCHIVED", ...index,
        });
        continue;
      }
      const bytes = await readFile(absolute);
      const secretCanaries = services.config.secretRefNames
        .map((name) => process.env[name])
        .filter((value): value is string => value !== undefined);
      const restricted = findSecretLeaks(bytes, secretCanaries).length > 0;
      const pathKey = digestValue({ portablePath: normalized }).value.slice(0, 16);
      const mediaType = deliverableMediaType(normalized);
      const artifact = await save.artifact(
        bytes,
        graph.scope,
        `deliverable.${ids.attemptId}.${pathKey}`,
        "AGENT_DELIVERABLE",
        path.posix.basename(normalized),
        mediaType,
        restricted ? "RESTRICTED" : "EXPORTABLE",
        restricted ? "FAILED" : "NOT_REQUIRED",
      );
      deliverableArtifacts.push(artifact);
      deliverableBytes += bytes.byteLength;
      deliverableFiles.push({
        portablePath: normalized,
        artifactId: String(artifact.artifactId),
        byteLength: bytes.byteLength,
        mediaType,
        sensitivity: artifact.sensitivity,
      });
      const preview = submissionContent(bytes, normalized, submissionContentBudget, restricted);
      submissionContentBudget = Math.max(0, submissionContentBudget - preview.consumedBytes);
      submissionFiles.push({
        portablePath: normalized,
        mediaType,
        byteLength: bytes.byteLength,
        artifactRef: refForArtifact(artifact),
        archiveStatus: "ARCHIVED",
        evaluationScope: preview.evaluationScope,
        ...(preview.contentOmittedReason ? { contentOmittedReason: preview.contentOmittedReason } : {}),
        representation: preview.representation,
        content: preview.content,
        contentTruncated: preview.contentTruncated,
        contentRestricted: restricted,
      });
    }
    if (deliverableFiles.length > 0) {
      await save.artifact(
        `${JSON.stringify({ schema: "evaldock.agent-deliverables/v1", files: deliverableFiles })}\n`,
        graph.scope,
        `deliverable-manifest.${ids.attemptId}`,
        "AGENT_DELIVERABLE_MANIFEST",
        "deliverables.json",
        "application/json",
        "EXPORTABLE",
      );
    }
    const fileFailureRefs = await save.failures(fileCollectionFailureDrafts({
      scope: graph.scope,
      snapshots: [before, after],
      requiredPhases: ["BEFORE", "AFTER"],
      stableWindowComplete: stability.stable,
      occurredAt: new Date().toISOString(),
      artifactRefs: [refForArtifact(beforeArtifact), refForArtifact(afterArtifact)],
    }));
    const fileStatus = materializeFileCollectionStatus({ collectionStatusId: `collection.file.${ids.attemptId}`, scope: graph.scope, sourceRef: fileSourceRef, snapshots: [before, after], openedAt: before.scanStartedAt, closedAt: after.scanCompletedAt, requiredPhases: ["BEFORE", "AFTER"], stableWindowComplete: stability.stable, failureRefs: fileFailureRefs, createdAt: new Date().toISOString(), producerVersion: EVALDOCK_VERSION });
    const fileStatusRef = await save.immutable(fileStatus, fileStatus.collectionStatusId);
    facts.collectionStatuses.push(fileStatus);
    const labArtifacts = await Promise.all(labCaptures.map((capture) => capture.events.length === 0 ? undefined : save.artifact( `${capture.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      graph.scope,
      `raw-observer.${capture.component}.${ids.attemptId}`,
      "ENVIRONMENT_OBSERVER_JSONL",
      `${capture.component}.jsonl`,
      "application/x-ndjson",
      "RESTRICTED",
    )));
    const labCollections = labCaptures.map((capture, index) => {
      const source = facts.sources.find((candidate) => candidate.sourceType === capture.sourceType);
      if (source === undefined) throw new Error(`Missing SourceDescriptor for ${capture.sourceType}`);
      return materializeLabObservations({
        capture,
        source,
        scope: graph.scope,
        attemptId: ids.attemptId,
        producerVersion: EVALDOCK_VERSION,
        ...(labArtifacts[index] === undefined ? {} : { rawArtifactRef: refForArtifact(labArtifacts[index]!) }),
      });
    });
    const labStatusRefs = await Promise.all(labCollections.map(
      (collection) => save.immutable(collection.status, collection.status.collectionStatusId),
    ));
    facts.collectionStatuses.push(...labCollections.map((collection) => collection.status));
    const watchedSources = new Set(labCollections.map((collection) => String(collection.status.sourceRef.id)));
    const evaluationStatuses = [
      probeCollection.collectionStatus,
      ...[fileStatus].filter((status): status is CollectionStatus =>
        status !== undefined && !watchedSources.has(String(status.sourceRef.id))),
      ...labCollections.map((collection) => collection.status),
    ];
    const evaluationStatusRefs = evaluationStatuses.map((status) => refForImmutable(status, status.collectionStatusId));
    const labRaws = labCollections.flatMap((collection) => [...collection.observations]);
    const rawObservations: RawObservation[] = [beforeRaw, afterRaw, ...probeCollection.observations, ...labRaws];
    const rawObservationRefs: Ref<RawObservation>[] = [refForImmutable(beforeRaw, beforeRaw.observationId), afterRawRef];
    for (const raw of probeCollection.observations) rawObservationRefs.push(refForImmutable(raw, raw.observationId));
    for (const raw of labRaws) rawObservationRefs.push(refForImmutable(raw, raw.observationId));
    facts.rawObservations.push(...rawObservations);
    facts.fileSnapshots.push(before, after);
    facts.fileDiffs.push(fileDiff);
    const ledger = completionLedger({
      TARGET_TERMINATION: ledgerItem("TARGET_TERMINATION", "COMPLETE", { supportingRefs: [refForProjection(facts.attempt)] }),
      TOOL_CALLS: ledgerItem("TOOL_CALLS", probeCollection.collectionStatus.completeness === "COMPLETE" ? "COMPLETE" : "INCOMPLETE", { reasonCodes: parsedProbe.issues.map((issue) => issue.code) }),
      SESSION_FLUSH: ledgerItem("SESSION_FLUSH", probeCollection.collectionStatus.completeness === "COMPLETE" ? "COMPLETE" : "INCOMPLETE", { supportingRefs: [probeStatusRef], reasonCodes: parsedProbe.issues.map((issue) => issue.code) }),
      PROBE_WATERMARK: ledgerItem("PROBE_WATERMARK", probeCollection.collectionStatus.completeness === "COMPLETE" ? "COMPLETE" : "INCOMPLETE", { supportingRefs: [probeStatusRef] }),
      STABLE_WINDOW: ledgerItem("STABLE_WINDOW", stability.stable ? "COMPLETE" : "INCOMPLETE"),
      FINAL_FILE_SNAPSHOT: ledgerItem("FINAL_FILE_SNAPSHOT", after.completeness === "COMPLETE" ? "COMPLETE" : "INCOMPLETE", { supportingRefs: [afterRef] }),
    });
    session = await save.transition(sealObservation(session, { occurredAt: new Date().toISOString(), reasonCode: "OBSERVATION_SEALED", collectionStatusRefs: evaluationStatusRefs, completionLedger: ledger, allRawArtifactsCommitted: true, supportingRefs: [probeStatusRef, fileStatusRef, beforeRef, afterRef, diffRef, ...labStatusRefs] }));
    facts.session = session;
    const verifiedArtifacts = [] as Array<{ artifactRef: Ref<ArtifactRef>; verified: boolean }>;
    for (const artifact of [beforeArtifact, afterArtifact, probeArtifact, finalResponseArtifact, ...deliverableArtifacts, ...labArtifacts].filter((item): item is ArtifactRef => item !== undefined)) {
      requireSucceeded(`verify raw artifact ${artifact.artifactId}`, await services.artifacts.readVerified(services.operation("EVIDENCE_PROCESSOR", `verify-${artifact.artifactId}`), artifact, artifact.scope, "EVIDENCE_CAPTURE"));
      verifiedArtifacts.push({ artifactRef: refForArtifact(artifact), verified: true });
    }
    facts.allTrace=assembleAllTrace({
      pausedComponents:services.observers.filter(item=>!item.enabled).map(item=>item.sourceType.toLowerCase()),
      traceId:"all-trace."+ids.attemptId,scope:graph.scope,
      createdAt:new Date().toISOString(),producerVersion:EVALDOCK_VERSION,
      agentObservations:probeCollection.observations,environmentChanges:labRaws,
      agentContents:new Map(parsedProbe.records.map(record=>[record.location.lineNumber,record.envelope as unknown as JsonValue])),
      sources:facts.sources,coverage:evaluationStatuses,
      artifacts:[...facts.artifacts],
      finalResponse:{
        content:finalResponseArtifact.sensitivity==="EXPORTABLE"?finalResponsePreview.text:"[RESTRICTED]",
        artifactRef:refForArtifact(finalResponseArtifact),capturedBytes:Buffer.byteLength(finalResponseRaw,"utf8"),
        captureTruncated:stdoutPreview.text.length>0 && targetResult.stdoutTruncated,
        contentTruncated:finalResponsePreview.truncated || finalResponseArtifact.sensitivity!=="EXPORTABLE",
        contentRestricted:finalResponseArtifact.sensitivity!=="EXPORTABLE",completedAt:targetResult.endedAt,
      },
      files:submissionFiles,
    });
    const evidenceDirectory = path.join(services.config.reportRoot, String(graph.scope.runId));
    assertSecretFreeValue(facts.allTrace, services.config, "all trace");
    facts.allTraceRef = await writeTraceDirectory({
      caseDirectory: evidenceDirectory, trace: facts.allTrace, maxBytes: services.config.maxArtifactBytes,
      readArtifact: async artifact => requireSucceeded("read output for canonical evidence",
        await services.artifacts.readVerified(services.operation("EVIDENCE_PROCESSOR", "canonical-" + artifact.artifactId),
          artifact, artifact.scope, "EVIDENCE_CAPTURE")),
    });
    await input.verifyCompatibility?.();
    // Judge reads the committed directory, so a broken/missing reference fails before any scoring call.
    facts.allTrace = await readTraceDirectory(evidenceDirectory, facts.allTraceRef, services.config.maxArtifactBytes);
    const traceRef=refForImmutable(facts.allTrace,validateStableId(facts.allTrace.traceId));
    markStep(facts,7,"SUCCEEDED",[refForProjection(session),traceRef]);
    await updateStatus(services,facts,"ALL_TRACE_COLLECTED",save.failure);
    markStep(facts,8,"RUNNING");
    facts.evaluationCase=await save.transition(transitionRuntimeProjection({
      projection:facts.evaluationCase!,toState:"EVALUATING",reasonCode:"JUDGING_STARTED",occurredAt:new Date().toISOString(),
    }));
    const judge=input.labelJudge ?? createDefaultLabelJudge(process.env,input.signal);
    const scoreRefs: Ref<LabelScore>[]=[];
    // Every label receives the same complete trace assembled above; only the rubric changes.
    for(const label of facts.labels) {
      const judgeInput={label,case:facts.caseData!,allTrace:facts.allTrace,...input.evaluationMode?{evaluationMode:input.evaluationMode}:{}};
      const score=facts.caseData!.grading.mode === "unavailable" ? unavailableReferenceScore(judgeInput) : await judge.evaluate(judgeInput);
      scoreRefs.push(await save.immutable(score,score.scoreId));
      facts.scores.push(score);
      if(score.status==="ERROR") await save.failure(makeFailure(graph.scope,"JUDGE_FAILURE","EVALDOCK","JUDGE","SCORING","LABEL_JUDGE_ERROR",score.reason));
    }
    facts.dimensions=aggregateScores(facts.scores);
    const caseTerminal = targetResult.terminationKind === "CANCELLED"
      ? "ABORTED" as const
      : targetResult.terminationKind === "HARNESS_ERROR"
        ? "ERRORED" as const
        : "FINISHED" as const;
    facts.evaluationCase = await save.transition(transitionRuntimeProjection({ projection: facts.evaluationCase, toState: caseTerminal, reasonCode: targetResult.terminationKind === "CANCELLED" ? "USER_CANCELLED_AFTER_CHECKS" : targetResult.terminationKind === "HARNESS_ERROR" ? "HARNESS_ERROR_AFTER_CHECKS" : "LABEL_SCORES_COMMITTED", occurredAt: new Date().toISOString(), supportingRefs: scoreRefs, patch: { scoreRefs } }));
    markStep(facts, 8, facts.scores.some(score=>score.status==="ERROR")?"FAILED":"SUCCEEDED", scoreRefs);
    await updateStatus(services, facts, "LABEL_SCORES_COMMITTED", save.failure);

    markStep(facts, 9, "RUNNING");
    const resetStartedAt = new Date().toISOString() as IsoDateTime;
    const expectedCleanDigest = emptyWorkspaceManifestDigest(fileRequirement.resourceBinding);
    let resetGeneration = facts.environment.resetGeneration;
    let resetVerificationRef: Ref<ResetVerification> | undefined;
    let reset: Awaited<ReturnType<typeof resetEnvironment>> | undefined;
    try {
      await input.fixtureHooks?.beforeReset?.();
      reset = await resetEnvironment({
        workspaceRoot: services.config.workspaceRoot,
        workspacePath: prepared.workspacePath,
        resetGeneration: facts.environment.resetGeneration,
      });
      resetGeneration = reset.resetGeneration;
    } catch (error) {
      const failureRef = await save.failure(makeFailure(
        graph.scope,
        "ENVIRONMENT_FAILURE",
        "ENVIRONMENT",
        "ENVIRONMENT_CONTROLLER",
        "RESET",
        "ENVIRONMENT_RESET_FAILED",
        "Environment Reset failed and cleanliness could not be established",
      ));
      await save.control(graph.scope, "ENV_RESET", "FAILED", {
        startedAt: resetStartedAt,
        failureRefs: [failureRef],
      });
      facts.environment = await save.transition(transitionRuntimeProjection({
        projection: facts.environment,
        toState: "QUARANTINED",
        reasonCode: "ENVIRONMENT_RESET_FAILED",
        occurredAt: new Date().toISOString(),
        failureRefs: [failureRef],
        patch: { resetGeneration },
      }));
      markStep(facts, 9, "FAILED", [failureRef, refForProjection(facts.environment)]);
      void error;
    }

    if (reset !== undefined) {
      facts.environment = await save.transition(transitionRuntimeProjection({
        projection: facts.environment,
        toState: "RESETTING",
        reasonCode: "RESET_COMPLETED_PENDING_VERIFICATION",
        occurredAt: new Date().toISOString(),
        patch: { resetGeneration },
      }));
      await save.control(graph.scope, "ENV_RESET", "SUCCEEDED", { startedAt: resetStartedAt });

      let postResetDraft: FileSnapshotDraft | undefined;
      try {
        await input.fixtureHooks?.afterReset?.(prepared.workspacePath);
        const resetBinding = await issueObserverBinding({ environmentInstanceId: facts.environment.environmentInstanceId, resetGeneration, sourceRequirementId: String(fileRequirement.sourceRequirementId), resourceBinding: fileRequirement.resourceBinding, sensorImplementationId: String(fileRequirement.sensorImplementationId), sensorImplementationVersion: fileRequirement.sensorImplementationVersion, sensorCapabilityDigest: fileRequirement.sensorCapabilityDigest, expiresAt: new Date(Date.now() + services.config.stableMaxWaitMs + 5_000).toISOString(), workspacePath: prepared.workspacePath });
        const resetRequest = { kind: "POST_RESET" as const, observationPlan: planBuild.observationPlan, environment: facts.environment as EnvironmentInstance & { readonly state: "RESETTING" }, resetGeneration, expectedCleanDigest, preparedBindings: [resetBinding.binding], sensorRegistryDigest: FILE_SENSOR_REGISTRY_DIGEST };
        postResetDraft = (await fileSensor.verifyReset({ request: resetRequest, sourceRequirementId: String(fileRequirement.sourceRequirementId), expectedSensorRegistryDigest: FILE_SENSOR_REGISTRY_DIGEST, rootPath: resetBinding.workspacePath, snapshotId: `snapshot.post-reset.${ids.attemptId}`, attemptId: ids.attemptId, maxFileBytes: services.config.maxArtifactBytes })).snapshot;
      } catch (error) {
        const failureRef = await save.failure(makeFailure(
          graph.scope,
          "OBSERVATION_FAILURE",
          "EVALDOCK",
          "COLLECTOR",
          "RESET_VERIFY",
          "RESET_VERIFICATION_COLLECTION_FAILED",
          "Independent post-reset collection failed and cleanliness could not be established",
        ));
        facts.environment = await save.transition(transitionRuntimeProjection({
          projection: facts.environment,
          toState: "QUARANTINED",
          reasonCode: "RESET_VERIFICATION_COLLECTION_FAILED",
          occurredAt: new Date().toISOString(),
          failureRefs: [failureRef],
          patch: { resetGeneration },
        }));
        markStep(facts, 9, "FAILED", [failureRef, refForProjection(facts.environment)]);
        void error;
      }

      if (postResetDraft !== undefined) {
        const postReset = materializeFileSnapshot(postResetDraft, recordMetadata(graph.scope));
        const postResetRef = await save.immutable(postReset, postReset.snapshotId);
        const postResetArtifact = await save.artifact(serializeFileSnapshotArtifact(postReset), graph.scope, `raw-file-post-reset.${ids.attemptId}`, "FILE_SNAPSHOT_RAW", "file-post-reset.json", "application/json", "RESTRICTED");
        const postResetRaw = materializeFileObservation({ observationId: `raw.file.post-reset.${ids.attemptId}`, scope: graph.scope, snapshot: postReset, snapshotRef: postResetRef, sourceRef: fileSourceRef, snapshotArtifact: postResetArtifact, snapshotArtifactRef: refForArtifact(postResetArtifact), createdAt: new Date().toISOString(), producerVersion: EVALDOCK_VERSION });
        await save.immutable(postResetRaw, postResetRaw.observationId);
        facts.rawObservations.push(postResetRaw);
        facts.fileSnapshots.push(postReset);
        const resetCollectionFailureRefs = await save.failures(fileCollectionFailureDrafts({
          scope: graph.scope,
          snapshots: [postReset],
          requiredPhases: ["POST_RESET"],
          stableWindowComplete: true,
          occurredAt: new Date().toISOString(),
          artifactRefs: [refForArtifact(postResetArtifact)],
        }));
        const resetStatus = materializeFileCollectionStatus({ collectionStatusId: `collection.reset.${ids.attemptId}`, scope: graph.scope, sourceRef: fileSourceRef, snapshots: [postReset], openedAt: postReset.scanStartedAt, closedAt: postReset.scanCompletedAt, requiredPhases: ["POST_RESET"], stableWindowComplete: true, failureRefs: resetCollectionFailureRefs, createdAt: new Date().toISOString(), producerVersion: EVALDOCK_VERSION });
        const resetStatusRef = await save.immutable(resetStatus, resetStatus.collectionStatusId);
        facts.collectionStatuses.push(resetStatus);
        const resetDraft = verifyResetSnapshot({ verificationId: `reset-verification.${ids.attemptId}`, environmentInstanceRef: refForProjection(facts.environment), resetGeneration, expectedCleanDigest, postResetSnapshot: postResetDraft, postResetSnapshotRef: postResetRef, collectionStatusRef: resetStatusRef });
        const resetVerification = materializeResetVerification(resetDraft, recordMetadata(graph.scope));
        resetVerificationRef = await save.immutable(resetVerification, resetVerification.verificationId);
        facts.resetVerification = resetVerification;
        if (resetVerification.result === "MATCH") {
          facts.environment = await save.transition(transitionRuntimeProjection({ projection: facts.environment, toState: "VERIFIED", reasonCode: "RESET_VERIFIED", occurredAt: new Date().toISOString(), supportingRefs: [resetVerificationRef], patch: { resetGeneration } }));
          const cleanupStartedAt = new Date().toISOString() as IsoDateTime;
          try {
            await cleanupEnvironment({ workspaceRoot: services.config.workspaceRoot, workspacePath: prepared.workspacePath });
            await cleanupRuntimeDshHome({
              runtimeDshHomeRoot: services.config.runtimeDshHomeRoot,
              runtimeDshHomePath: prepared.runtimeDshHomePath,
              runId,
              caseId: ids.caseId,
              attemptId: ids.attemptId,
            });
            facts.environment = await save.transition(transitionRuntimeProjection({ projection: facts.environment, toState: "CLEANED", reasonCode: "ENVIRONMENT_CLEANED", occurredAt: new Date().toISOString() }));
            await save.control(graph.scope, "ENV_CLEANUP", "SUCCEEDED", {
              startedAt: cleanupStartedAt,
            });
            markStep(facts, 9, "SUCCEEDED", [resetVerificationRef, refForProjection(facts.environment)]);
          } catch {
            const failureRef = await save.failure(makeFailure(graph.scope, "CLEANUP_FAILURE", "ENVIRONMENT", "ENVIRONMENT_CONTROLLER", "CLEANUP", "ENVIRONMENT_CLEANUP_FAILED", "Verified environment cleanup failed"));
            facts.environment = await save.transition(transitionRuntimeProjection({ projection: facts.environment, toState: "CLEANUP_FAILED", reasonCode: "CLEANUP_FAILED", occurredAt: new Date().toISOString(), failureRefs: [failureRef] }));
            await save.control(graph.scope, "ENV_CLEANUP", "FAILED", {
              startedAt: cleanupStartedAt,
              failureRefs: [failureRef],
            });
            markStep(facts, 9, "FAILED", [resetVerificationRef, refForProjection(facts.environment)]);
          }
        } else {
          const failureRef = await save.failure(makeFailure(graph.scope, "CLEANUP_FAILURE", "ENVIRONMENT", "ENVIRONMENT_CONTROLLER", "RESET_VERIFY", resetVerification.result === "MISMATCH" ? "RESET_MISMATCH" : "RESET_UNAVAILABLE", "Independent post-reset verification did not confirm a clean environment"));
          facts.environment = await save.transition(transitionRuntimeProjection({ projection: facts.environment, toState: "QUARANTINED", reasonCode: resetVerification.result, occurredAt: new Date().toISOString(), failureRefs: [failureRef], patch: { resetGeneration } }));
          markStep(facts, 9, "FAILED", [resetVerificationRef, refForProjection(facts.environment)]);
        }
      }
    }
    await updateStatus(services, facts, "RESET_FINALIZED", save.failure);

    markStep(facts, 10, "RUNNING");
    facts.run = await save.transition(transitionRuntimeProjection({ projection: facts.run!, toState: "FINALIZING", reasonCode: "FINALIZATION_FACTS_COMMITTED", occurredAt: new Date().toISOString(), patch: { environmentFinalState: facts.environment.state, operationalHealth: facts.environment.state === "CLEANED" ? "HEALTHY" : "FAILED" } }));
    const userCancelled = targetResult.terminationKind === "CANCELLED";
    const harnessFailed = targetResult.terminationKind === "HARNESS_ERROR";
    const judgeFailed=facts.scores.some(score=>score.status==="ERROR");
    const runTerminal = userCancelled
      ? "CANCELLED" as const
      : harnessFailed || judgeFailed
        ? "FAILED" as const
        : facts.environment.state === "CLEANED"
        ? "FINISHED" as const
        : "FAILED" as const;
    const terminalHealth = !harnessFailed && !judgeFailed && facts.environment.state === "CLEANED"
      ? "HEALTHY" as const
      : "FAILED" as const;
    facts.run = await save.transition(transitionRuntimeProjection({ projection: facts.run, toState: runTerminal, reasonCode: userCancelled ? "USER_CANCELLED" : harnessFailed ? "HARNESS_OPERATION_FAILED" : runTerminal === "FINISHED" ? "RUN_FINISHED" : "OPERATIONAL_FINALIZATION_FAILED", occurredAt: new Date().toISOString(), supportingRefs: [], patch: { environmentFinalState: facts.environment.state, operationalHealth: terminalHealth } }));
    markStep(facts, 10, "SUCCEEDED", [refForProjection(facts.run)]);
    const deliveredReport = await persistAndDeliverReport({
      services,
      facts,
      save,
      runId,
      ...(input.executionCase === undefined ? {} : {
        resultRunId: input.executionCase.resultRunId,
        resultCaseId: input.executionCase.resultCaseId,
      }),
      phase: userCancelled ? "CANCELLED" : terminalHealth === "FAILED" ? "FAILED" : "COMPLETED",
      setReportPhase: (phase) => {
        reportPhase = phase;
      },
      ...(input.fixtureHooks?.beforeReportHtml === undefined
        ? {}
        : { beforeReportHtml: input.fixtureHooks.beforeReportHtml }),
    });
    await updateStatus(services, facts, "COMPLETED", save.failure);
    if (lease !== undefined) {
      const released = await releaseLease(services.config.runRoot, lease);
      leaseReleased = true;
      await save.lease(released, graph.run.scope, "RELEASED");
    }
    const operationalFailure = facts.run.operationalHealth === "FAILED";
    const exitCode = userCancelled
      ? 130
      : operationalFailure
        ? 4
      : facts.scores.some(score=>score.status==="ERROR")
        ? 4
        : 0;
    return {
      ...summary(
        facts,
        runId,
        fixtureMode,
        exitCode,
        userCancelled ? "CANCELLED" : operationalFailure ? "FAILED" : "COMPLETED",
        services.config.runRoot,
      ),
      ...deliveredReport,
    };
  } catch (error) {
    if (process.env.EVALDOCK_DEBUG_ERRORS === "1") {
      process.stderr.write(`[evaldock:debug-error] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    const drafts = failureDraftsFrom(error);
    if (drafts.length > 0) await save.failures(drafts).catch(() => undefined);
    if (reportPhase !== "NOT_STARTED") {
      const scope = facts.attempt?.scope ?? facts.run?.scope ?? facts.target?.scope ?? { targetId: input.descriptor.targetId };
      await save.failure(makeFailure(
        scope,
        "REPORT_FAILURE",
        "EVALDOCK",
        reportPhase === "EXPORT" ? "EXPORTER" : "REPORTER",
        reportPhase,
        `${reportPhase}_DELIVERY_FAILED`,
        "Report delivery failed after evaluation",
      )).catch(() => undefined);
    } else if (!(error instanceof WorkflowStop) && drafts.length === 0) {
      const scope = facts.attempt?.scope ?? facts.run?.scope ?? facts.target?.scope ?? { targetId: input.descriptor.targetId };
      await save.failure(internalFailureDraft(scope, "WORKFLOW", new Date().toISOString() as IsoDateTime, { actor: "APP", reasonCode: "WORKFLOW_ABORTED", messageRedacted: "Workflow step " + (facts.timeline.find(step => step.status === "RUNNING")?.number ?? "preparation") + " failed", cause: error })).catch(() => undefined);
    }
    if (prepared !== undefined) {
      await recoverEnvironmentAfterFailure({
        services,
        facts,
        save,
        prepared,
        ...(input.fixtureHooks?.afterReset === undefined
          ? {}
          : { afterReset: input.fixtureHooks.afterReset }),
      });
    }
    const cancelled = input.signal?.aborted === true;
    const exitCode = cancelled ? 130 : error instanceof WorkflowStop ? error.exitCode : 4;
    const status = cancelled ? "CANCELLED" : error instanceof WorkflowStop ? error.status : "FAILED";
    const activeStep =
      facts.timeline.find((step) => step.status === "RUNNING") ??
      (reportPhase === "NOT_STARTED" ? undefined : facts.timeline[9]);
    if (activeStep !== undefined) replaceStep(facts, activeStep.number, { status: "FAILED", endedAt: new Date().toISOString(), failureGroups: uniqueGroups(facts.failures) });
    if (facts.run !== undefined && !["FINISHED", "FAILED", "CANCELLED"].includes(facts.run.state)) {
      try {
        const terminal = cancelled ? "CANCELLED" as const : "FAILED" as const;
        facts.run = await save.transition(transitionRuntimeProjection({ projection: facts.run, toState: terminal, reasonCode: cancelled ? "USER_CANCELLED" : "WORKFLOW_FAILED", occurredAt: new Date().toISOString(), failureRefs: facts.failures.map((failure) => refForImmutable(failure, failure.failureId)), patch: { operationalHealth: "FAILED", ...(facts.environment === undefined ? {} : { environmentFinalState: facts.environment.state }) } }));
      } catch {
        // The prior committed projection and FailureRecords remain authoritative.
      }
    }
    if (
      reportPhase === "NOT_STARTED" &&
      facts.run !== undefined &&
      facts.timeline[9]?.status === "PENDING"
    ) {
      replaceStep(facts, 10, {
        status: "BLOCKED",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        objectRefs: [`${facts.run.schema}:${facts.run.runId}@${facts.run.revision}`],
        failureGroups: uniqueGroups(facts.failures),
        hintCode: facts.failures.at(-1)?.reasonCode ?? "EVALUATION_NOT_COMPLETED",
      });
    }
    await updateStatus(services, facts, status, save.failure);
    let diagnosticReport: DeliveredReport | undefined;
    if (reportPhase === "NOT_STARTED" && hasReportGraph(facts)) {
      try {
        diagnosticReport = await persistAndDeliverReport({
          services,
          facts,
          save,
          runId,
          ...(input.executionCase === undefined ? {} : {
            resultRunId: input.executionCase.resultRunId,
            resultCaseId: input.executionCase.resultCaseId,
          }),
          phase: status,
          setReportPhase: (phase) => {
            reportPhase = phase;
          },
          ...(input.fixtureHooks?.beforeReportHtml === undefined
            ? {}
            : { beforeReportHtml: input.fixtureHooks.beforeReportHtml }),
        });
      } catch (reportError) {
        const scope = facts.attempt?.scope ?? facts.run!.scope;
        await save.failure(makeFailure(
          scope,
          "REPORT_FAILURE",
          "EVALDOCK",
          (reportPhase as ReportPhase) === "EXPORT" ? "EXPORTER" : "REPORTER",
          reportPhase,
          `${reportPhase}_DELIVERY_FAILED`,
          "Diagnostic report delivery failed",
        )).catch(() => undefined);
        await updateStatus(services, facts, status, save.failure);
        void reportError;
      }
    }
    if (lease !== undefined && !leaseReleased) {
      try {
        const released = await releaseLease(services.config.runRoot, lease);
        leaseReleased = true;
        if (facts.run !== undefined) await save.lease(released, facts.run.scope, "RELEASED");
      } catch (releaseError) {
        const scope = facts.run?.scope ?? facts.target?.scope ?? { targetId: input.descriptor.targetId };
        await save.failure(makeFailure(
          scope,
          "PERSISTENCE_FAILURE",
          "EVALDOCK",
          "PLATFORM",
          "LEASE_RELEASE",
          "LEASE_RELEASE_FAILED",
          "EvalDock could not release and persist ownership of the active Run lease",
        )).catch(() => undefined);
        void releaseError;
      }
    }
    return {
      ...summary(
        facts,
        runId,
        fixtureMode,
        exitCode,
        status,
        services.config.runRoot,
        input.stopAfter === "INSPECT" ? "inspect" : input.stopAfter === "PLAN" ? "plan" : "run",
      ),
      ...(diagnosticReport ?? {}),
    };
  } finally {
    if (lease !== undefined && !leaseReleased) {
      try {
        const released = await releaseLease(services.config.runRoot, lease);
        if (facts.run !== undefined) await save.lease(released, facts.run.scope, "RELEASED");
      } catch {
        // A mismatched lease is intentionally not stolen or unlinked.
      }
    }
  }
}

/** 报告交付进度，用于异常路径判断最后一个已完成的不可变事实。 */
type ReportPhase = "NOT_STARTED" | "JSON" | "HTML" | "EXPORT";

/** 报告 JSON、HTML 与导出目录全部成功提交后的路径集合。 */
interface DeliveredReport {
  readonly reportJson: string;
  readonly reportHtml: string;
  readonly delivery: string;
  readonly caseBundlePath: string;
}

/** 判断异常收尾时是否已有足够领域对象构造一份诊断报告。 */
function hasReportGraph(facts: MutableWorkflowFacts): boolean {
  return facts.run !== undefined &&
    facts.evaluationCase !== undefined &&
    facts.attempt !== undefined &&
    facts.target !== undefined &&
    facts.evaluationPlan !== undefined &&
    facts.observationPlan !== undefined;
}

/**
 * 按 JSON→验证→HTML→Export 的顺序交付最终报告；正常和异常收尾共同调用。
 */
async function persistAndDeliverReport(input: {
  readonly services: ApplicationServices;
  readonly facts: MutableWorkflowFacts;
  readonly save: ReturnType<typeof createPersistence>;
  readonly runId: string;
  readonly resultRunId?: string;
  readonly resultCaseId?: string;
  readonly phase: string;
  readonly setReportPhase: (phase: Exclude<ReportPhase, "NOT_STARTED">) => void;
  readonly beforeReportHtml?: () => Promise<void>;
}): Promise<DeliveredReport> {
  input.setReportPhase("JSON");
  const document = buildResult(buildView(input.facts,input.phase),EVALDOCK_VERSION);
  if (document.allTraceRef) {
    await readTraceDirectory(path.join(input.services.config.reportRoot, input.runId), document.allTraceRef, input.services.config.maxArtifactBytes);
    const judgeDirectory = path.join(input.services.config.reportRoot, input.runId, "judge");
    await mkdir(judgeDirectory, {recursive:true, mode:0o700});
    for (const score of document.scores) {
      const name = String(score.labelId).replaceAll("/", "_");
      await writeFile(path.join(judgeDirectory, name + ".json"), JSON.stringify(score) + "\n", {flag:"wx",mode:0o400});
    }
    await writeReportLoader(path.join(input.services.config.reportRoot, input.runId));
  }
  const reportJsonBytes = Buffer.from(serializeReportDocument(document), "utf8");
  assertSecretFreeBytes(reportJsonBytes, input.services.config, "report.json");
  await commitReportJson({
    reportRoot: input.services.config.reportRoot,
    runId: input.runId,
    bytes: reportJsonBytes,
    maxBytes: input.services.config.maxArtifactBytes,
  });
  const verifiedJson = await readCommittedReportJson({
    reportRoot: input.services.config.reportRoot,
    runId: input.runId,
    maxBytes: input.services.config.maxArtifactBytes,
  });
  const verifiedDocument = parseVerifiedReportDocument(verifiedJson.toString("utf8"));
  input.setReportPhase("HTML");
  await input.beforeReportHtml?.();
  const reportHtmlBytes = Buffer.from(renderReportHtml(verifiedDocument), "utf8");
  assertSecretFreeBytes(reportHtmlBytes, input.services.config, "report.html");
  const htmlCommit = await commitReportHtml({
    reportRoot: input.services.config.reportRoot,
    runId: input.runId,
    bytes: reportHtmlBytes,
    maxBytes: input.services.config.maxArtifactBytes,
  });
  input.setReportPhase("EXPORT");
  const caseBundle = await exportCaseBundle({
    resultRoot: input.services.config.resultRoot,
    runRoot: input.services.config.runRoot,
    artifactRoot: input.services.config.artifactRoot,
    reportRoot: input.services.config.reportRoot,
    agentId: String(input.facts.target!.targetId),
    runId: input.resultRunId ?? input.runId,
    sourceRunId: input.runId,
    caseId: input.resultCaseId ?? String(input.facts.evaluationCase!.caseId),
    maxFileBytes: input.services.config.maxArtifactBytes,
  });
  return {
    reportJson: caseBundle.reportJsonPath,
    reportHtml: caseBundle.reportHtmlPath ?? htmlCommit.path,
    delivery: caseBundle.directory,
    caseBundlePath: caseBundle.directory,
  };
}

/**
 * 主流程失败后的环境恢复入口：根据最后状态 Reset、独立复查、Cleanup 或隔离。
 * runEvaluationWorkflow 的 catch 路径调用，已形成的 Agent Gate 不在这里修改。
 */
async function recoverEnvironmentAfterFailure(input: {
  readonly services: ApplicationServices;
  readonly facts: MutableWorkflowFacts;
  readonly save: ReturnType<typeof createPersistence>;
  readonly prepared: PreparedEnvironment;
  readonly afterReset?: (workspacePath: string) => Promise<void>;
}): Promise<void> {
  const { services, facts, save, prepared } = input;
  const environment = facts.environment;
  if (
    environment === undefined ||
    ["CLEANED", "QUARANTINED", "CLEANUP_FAILED"].includes(environment.state)
  ) {
    return;
  }
  const scope = environment.scope;
  const runId = String(scope.runId);
  const caseId = String(scope.caseId);
  const attemptId = String(scope.attemptId);
  // 保存 Cleanup Failure，并把仍可变的 Environment 推进到 QUARANTINED。
  const quarantine = async (reasonCode: string, message: string): Promise<void> => {
    const failureRef = await save.failure(makeFailure(
      scope,
      "CLEANUP_FAILURE",
      "ENVIRONMENT",
      "ENVIRONMENT_CONTROLLER",
      "SAFE_CLOSE",
      reasonCode,
      message,
    ));
    if (
      facts.environment !== undefined &&
      !["CLEANED", "QUARANTINED", "CLEANUP_FAILED"].includes(facts.environment.state)
    ) {
      facts.environment = await save.transition(transitionRuntimeProjection({
        projection: facts.environment,
        toState: "QUARANTINED",
        reasonCode,
        occurredAt: new Date().toISOString(),
        failureRefs: [failureRef],
      }));
    }
  };

  let recoveryPhase: "RESET" | "RESET_VERIFY" | "CLEANUP" = "RESET";
  try {
    if (environment.state === "VERIFIED") {
      recoveryPhase = "CLEANUP";
      await cleanupEnvironment({
        workspaceRoot: services.config.workspaceRoot,
        workspacePath: prepared.workspacePath,
      });
      await cleanupRuntimeDshHome({
        runtimeDshHomeRoot: services.config.runtimeDshHomeRoot,
        runtimeDshHomePath: prepared.runtimeDshHomePath,
        runId,
        caseId,
        attemptId,
      });
      facts.environment = await save.transition(transitionRuntimeProjection({
        projection: facts.environment!,
        toState: "CLEANED",
        reasonCode: "SAFE_CLOSE_CLEANED",
        occurredAt: new Date().toISOString(),
      }));
      await save.control(scope, "ENV_CLEANUP", "SUCCEEDED");
      return;
    }

    if (facts.resetVerification !== undefined) {
      if (environment.state !== "RESETTING") {
        await quarantine(
          "SAFE_CLOSE_VERIFICATION_STATE_MISMATCH",
          "A committed ResetVerification did not match the current Environment lifecycle state",
        );
        return;
      }
      const verificationRef = refForImmutable(
        facts.resetVerification,
        facts.resetVerification.verificationId,
      );
      if (facts.resetVerification.result !== "MATCH") {
        await quarantine(
          facts.resetVerification.result === "MISMATCH" ? "RESET_MISMATCH" : "RESET_UNAVAILABLE",
          "The committed ResetVerification did not establish a clean environment",
        );
        return;
      }
      facts.environment = await save.transition(transitionRuntimeProjection({
        projection: facts.environment!,
        toState: "VERIFIED",
        reasonCode: "SAFE_CLOSE_EXISTING_RESET_VERIFIED",
        occurredAt: new Date().toISOString(),
        supportingRefs: [verificationRef],
        patch: { resetGeneration: facts.resetVerification.resetGeneration },
      }));
      recoveryPhase = "CLEANUP";
      await cleanupEnvironment({
        workspaceRoot: services.config.workspaceRoot,
        workspacePath: prepared.workspacePath,
      });
      await cleanupRuntimeDshHome({
        runtimeDshHomeRoot: services.config.runtimeDshHomeRoot,
        runtimeDshHomePath: prepared.runtimeDshHomePath,
        runId,
        caseId,
        attemptId,
      });
      facts.environment = await save.transition(transitionRuntimeProjection({
        projection: facts.environment,
        toState: "CLEANED",
        reasonCode: "SAFE_CLOSE_CLEANED",
        occurredAt: new Date().toISOString(),
      }));
      await save.control(scope, "ENV_CLEANUP", "SUCCEEDED");
      return;
    }

    if (environment.state === "CREATED" || environment.state === "PREPARED") {
      recoveryPhase = "RESET";
      await resetEnvironment({
        workspaceRoot: services.config.workspaceRoot,
        workspacePath: prepared.workspacePath,
        resetGeneration: environment.resetGeneration,
      });
      recoveryPhase = "CLEANUP";
      await cleanupEnvironment({
        workspaceRoot: services.config.workspaceRoot,
        workspacePath: prepared.workspacePath,
      });
      await cleanupRuntimeDshHome({
        runtimeDshHomeRoot: services.config.runtimeDshHomeRoot,
        runtimeDshHomePath: prepared.runtimeDshHomePath,
        runId,
        caseId,
        attemptId,
      });
      await quarantine(
        "SAFE_CLOSE_BEFORE_SEED_VERIFICATION",
        "The pre-seed environment was removed, but its lifecycle cannot claim a post-seed Reset Verification",
      );
      return;
    }

    if (environment.state !== "SEEDED" && environment.state !== "IN_USE" && environment.state !== "RESETTING") {
      await quarantine("SAFE_CLOSE_STATE_UNSUPPORTED", "The failed environment could not enter a verified cleanup path");
      return;
    }

    recoveryPhase = "RESET";
    const reset = await resetEnvironment({
      workspaceRoot: services.config.workspaceRoot,
      workspacePath: prepared.workspacePath,
      resetGeneration: environment.resetGeneration,
    });
    if (facts.environment!.state !== "RESETTING") {
      facts.environment = await save.transition(transitionRuntimeProjection({
        projection: facts.environment!,
        toState: "RESETTING",
        reasonCode: "SAFE_CLOSE_RESET_COMPLETED",
        occurredAt: new Date().toISOString(),
        patch: { resetGeneration: reset.resetGeneration },
      }));
    }
    await save.control(scope, "ENV_RESET", "SUCCEEDED");
    recoveryPhase = "RESET_VERIFY";
    await input.afterReset?.(prepared.workspacePath);

    const observationPlan = facts.observationPlan;
    const fileSource = facts.sources.find((source) => source.sourceType === "FILESYSTEM");
    const fileRequirement = observationPlan?.sourceRequirements.find(
      (requirement) => requirement.sourceType === "FILESYSTEM",
    );
    if (observationPlan === undefined || fileSource === undefined || fileRequirement === undefined) {
      throw new Error("safe close lacks the frozen File observation binding");
    }
    const captureEnvironment = {
      ...facts.environment!,
      resetGeneration: reset.resetGeneration,
    } as EnvironmentInstance & { readonly state: "RESETTING" };
    const binding = await issueObserverBinding({
      environmentInstanceId: captureEnvironment.environmentInstanceId,
      resetGeneration: reset.resetGeneration,
      sourceRequirementId: String(fileRequirement.sourceRequirementId),
      resourceBinding: fileRequirement.resourceBinding,
      sensorImplementationId: String(fileRequirement.sensorImplementationId),
      sensorImplementationVersion: fileRequirement.sensorImplementationVersion,
      sensorCapabilityDigest: fileRequirement.sensorCapabilityDigest,
      expiresAt: new Date(Date.now() + services.config.stableMaxWaitMs + 5_000).toISOString(),
      workspacePath: prepared.workspacePath,
    });
    const expectedCleanDigest = emptyWorkspaceManifestDigest(fileRequirement.resourceBinding);
    const request = {
      kind: "POST_RESET" as const,
      observationPlan,
      environment: captureEnvironment,
      resetGeneration: reset.resetGeneration,
      expectedCleanDigest,
      preparedBindings: [binding.binding],
      sensorRegistryDigest: FILE_SENSOR_REGISTRY_DIGEST,
    };
    const recoveryKey = digestValue({ attemptId, resetGeneration: reset.resetGeneration }).value.slice(0, 16);
    const sensor = services.fileSensor;
    const postResetDraft = (await sensor.verifyReset({
      request,
      sourceRequirementId: String(fileRequirement.sourceRequirementId),
      expectedSensorRegistryDigest: FILE_SENSOR_REGISTRY_DIGEST,
      rootPath: binding.workspacePath,
      snapshotId: `snapshot.recovery.${recoveryKey}`,
      attemptId,
      maxFileBytes: services.config.maxArtifactBytes,
    })).snapshot;
    const postReset = materializeFileSnapshot(postResetDraft, recordMetadata(scope));
    const postResetRef = await save.immutable(postReset, postReset.snapshotId);
    const postResetArtifact = await save.artifact(
      serializeFileSnapshotArtifact(postReset),
      scope,
      `raw-file-recovery.${recoveryKey}`,
      "FILE_SNAPSHOT_RAW",
      "file-post-reset-recovery.json",
      "application/json",
      "RESTRICTED",
    );
    const fileSourceRef = refForImmutable(fileSource, fileSource.sourceId);
    const postResetRaw = materializeFileObservation({
      observationId: `raw.file.recovery.${recoveryKey}`,
      scope,
      snapshot: postReset,
      snapshotRef: postResetRef,
      sourceRef: fileSourceRef,
      snapshotArtifact: postResetArtifact,
      snapshotArtifactRef: refForArtifact(postResetArtifact),
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    });
    await save.immutable(postResetRaw, postResetRaw.observationId);
    const collectionFailureRefs = await save.failures(fileCollectionFailureDrafts({
      scope,
      snapshots: [postReset],
      requiredPhases: ["POST_RESET"],
      stableWindowComplete: true,
      occurredAt: new Date().toISOString(),
      artifactRefs: [refForArtifact(postResetArtifact)],
    }));
    const collectionStatus = materializeFileCollectionStatus({
      collectionStatusId: `collection.recovery.${recoveryKey}`,
      scope,
      sourceRef: fileSourceRef,
      snapshots: [postReset],
      openedAt: postReset.scanStartedAt,
      closedAt: postReset.scanCompletedAt,
      requiredPhases: ["POST_RESET"],
      stableWindowComplete: true,
      failureRefs: collectionFailureRefs,
      createdAt: new Date().toISOString(),
      producerVersion: EVALDOCK_VERSION,
    });
    const collectionStatusRef = await save.immutable(
      collectionStatus,
      collectionStatus.collectionStatusId,
    );
    const verification = materializeResetVerification(
      verifyResetSnapshot({
        verificationId: `reset-recovery.${recoveryKey}`,
        environmentInstanceRef: refForProjection(facts.environment!),
        resetGeneration: reset.resetGeneration,
        expectedCleanDigest,
        postResetSnapshot: postResetDraft,
        postResetSnapshotRef: postResetRef,
        collectionStatusRef,
      }),
      recordMetadata(scope),
    );
    const verificationRef = await save.immutable(verification, verification.verificationId);
    facts.resetVerification = verification;
    facts.rawObservations.push(postResetRaw);
    facts.fileSnapshots.push(postReset);
    facts.collectionStatuses.push(collectionStatus);
    if (verification.result !== "MATCH") {
      await quarantine(
        verification.result === "MISMATCH" ? "RESET_MISMATCH" : "RESET_UNAVAILABLE",
        "Independent safe-close verification did not confirm a clean environment",
      );
      return;
    }
    facts.environment = await save.transition(transitionRuntimeProjection({
      projection: facts.environment!,
      toState: "VERIFIED",
      reasonCode: "SAFE_CLOSE_RESET_VERIFIED",
      occurredAt: new Date().toISOString(),
      supportingRefs: [verificationRef],
      patch: { resetGeneration: reset.resetGeneration },
    }));
    recoveryPhase = "CLEANUP";
    await cleanupEnvironment({
      workspaceRoot: services.config.workspaceRoot,
      workspacePath: prepared.workspacePath,
    });
    await cleanupRuntimeDshHome({
      runtimeDshHomeRoot: services.config.runtimeDshHomeRoot,
      runtimeDshHomePath: prepared.runtimeDshHomePath,
      runId,
      caseId,
      attemptId,
    });
    facts.environment = await save.transition(transitionRuntimeProjection({
      projection: facts.environment,
      toState: "CLEANED",
      reasonCode: "SAFE_CLOSE_CLEANED",
      occurredAt: new Date().toISOString(),
    }));
    await save.control(scope, "ENV_CLEANUP", "SUCCEEDED");
  } catch (error) {
    try {
      const details = recoveryPhase === "RESET"
        ? {
            category: "ENVIRONMENT_FAILURE" as const,
            actor: "ENVIRONMENT_CONTROLLER" as const,
            reasonCode: "SAFE_CLOSE_RESET_FAILED",
            message: "Failed-run Environment Reset did not complete",
          }
        : recoveryPhase === "RESET_VERIFY"
          ? {
              category: "OBSERVATION_FAILURE" as const,
              actor: "COLLECTOR" as const,
              reasonCode: "SAFE_CLOSE_RESET_VERIFICATION_FAILED",
              message: "Failed-run post-reset observation did not complete",
            }
          : {
              category: "CLEANUP_FAILURE" as const,
              actor: "ENVIRONMENT_CONTROLLER" as const,
              reasonCode: "SAFE_CLOSE_CLEANUP_FAILED",
              message: "Failed-run Environment cleanup did not complete",
            };
      const failureRef = await save.failure(makeFailure(
        scope,
        details.category,
        recoveryPhase === "RESET_VERIFY" ? "EVALDOCK" : "ENVIRONMENT",
        details.actor,
        recoveryPhase,
        details.reasonCode,
        details.message,
      ));
      if (recoveryPhase === "RESET") {
        await save.control(scope, "ENV_RESET", "FAILED", { failureRefs: [failureRef] });
      } else if (recoveryPhase === "CLEANUP") {
        await save.control(scope, "ENV_CLEANUP", "FAILED", { failureRefs: [failureRef] });
      }
      if (
        facts.environment !== undefined &&
        !["CLEANED", "QUARANTINED", "CLEANUP_FAILED"].includes(facts.environment.state)
      ) {
        facts.environment = await save.transition(transitionRuntimeProjection({
          projection: facts.environment,
          toState: "QUARANTINED",
          reasonCode: details.reasonCode,
          occurredAt: new Date().toISOString(),
          failureRefs: [failureRef],
        }));
      }
      void error;
    } catch {
      // The original failure and last committed Environment projection remain authoritative.
    }
  }
}

/**
 * 为 Workflow 创建一组绑定 Repository/ArtifactStore 的持久化函数。
 * 所有写入先做 Secret canary 检查，并同步更新 MutableWorkflowFacts。
 */
function createPersistence(services: ApplicationServices, facts: MutableWorkflowFacts) {
  let failureCounter = 0;
  /** 提交不可变领域记录并返回 Ref。 */
  const immutable = async <T extends object>(record: T, id: string): Promise<Ref<T>> => {
      assertSecretFreeValue(record, services.config, "immutable record");
      return requireSucceeded(`persist ${String((record as { schema?: string }).schema ?? "record")}`, await services.repository.putImmutable(services.operation("STORAGE", `put-${id}`), record)) as Ref<T>;
    };
  /** 创建生命周期对象的 revision 0 Projection。 */
  const projection = async <T extends EvaluationRun | EvaluationCase | ExecutionAttempt | EnvironmentInstance | ObservationSession>(record: T): Promise<Ref<T> & { revision: 0 }> => {
      assertSecretFreeValue(record, services.config, "lifecycle projection");
      return requireSucceeded(`create ${record.schema}`, await services.repository.createProjection(services.operation("STORAGE", `create-${record.aggregateId}`), record)) as Ref<T> & { revision: 0 };
    };
  /** 追加生命周期事件并返回调用方已经构造、现已提交的下一版 Projection。 */
  const transition = async <T extends EvaluationRun | EvaluationCase | ExecutionAttempt | EnvironmentInstance | ObservationSession>(transitionValue: Parameters<ApplicationServices["repository"]["appendTransition"]>[1]): Promise<T> => {
      assertSecretFreeValue(transitionValue, services.config, "lifecycle transition");
      requireSucceeded("append lifecycle transition", await services.repository.appendTransition(services.operation("STORAGE", `transition-${transitionValue.nextProjection.aggregateId}-${transitionValue.nextProjection.revision}`), transitionValue));
      return transitionValue.nextProjection as T;
    };
  /** 把 FailureDraft 提交为 FailureRecord，并加入 Workflow 事实集合。 */
  const failure = async (draft: FailureDraft): Promise<Ref<FailureRecord>> => {
      failureCounter += 1;
      const record = commitFailureDraft(draft, `failure.${String(facts.run?.runId ?? "planning")}.${failureCounter}`, EVALDOCK_VERSION);
      assertSecretFreeValue(record, services.config, "FailureRecord");
      const ref = requireSucceeded("persist FailureRecord", await services.repository.putImmutable(services.operation("STORAGE", `failure-${failureCounter}`), record)) as Ref<FailureRecord>;
      facts.failures.push(record);
      return ref;
    };
  /** 按顺序提交一组 FailureDraft，保留对应 Ref 顺序。 */
  const failures = async (drafts: readonly FailureDraft[]): Promise<readonly Ref<FailureRecord>[]> => {
      const refs: Ref<FailureRecord>[] = [];
      for (const draft of drafts) refs.push(await failure(draft));
      return refs;
    };
  /** 提交一般 Artifact；命中 Secret canary 时只允许明确的受限隔离记录。 */
  const artifact = async (
    bytes: Uint8Array | string,
    scope: ScopeRef,
    artifactId: string,
    artifactType: string,
    logicalName: string,
    mediaType: string,
    sensitivity: "EXPORTABLE" | "RESTRICTED",
    redactionState: "NOT_REQUIRED" | "APPLIED" | "FAILED" = "NOT_REQUIRED",
  ): Promise<ArtifactRef> => {
      const canaries = services.config.secretRefNames
        .map((name) => process.env[name])
        .filter((value): value is string => value !== undefined);
      const leaks = findSecretLeaks(
        typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes,
        canaries,
      );
      if (
        leaks.length > 0 &&
        !(sensitivity === "RESTRICTED" && redactionState === "FAILED")
      ) {
        throw new Error("Artifact matched a configured Secret canary without failed-redaction isolation");
      }
      const committed = requireSucceeded(`commit artifact ${artifactId}`, await services.artifacts.commit(services.operation("STORAGE", `artifact-${artifactId}`), bytes, { artifactId: validateStableId<"ArtifactId">(artifactId), scope, artifactType, logicalName, mediaType, producerVersion: EVALDOCK_VERSION, createdAt: new Date().toISOString() as IsoDateTime, sensitivity, redactionState }));
      facts.artifacts.push(committed);
      return committed;
    };
  /** 提交 Target stdout/stderr，并把 Secret 泄漏同时记录为 Target 安全故障。 */
  const outputArtifact = async (bytes: Uint8Array, scope: ScopeRef, artifactId: string, logicalName: string, config: ConfigSnapshot): Promise<ArtifactRef> => {
      const canaries = config.secretRefNames.map((name) => process.env[name]).filter((value): value is string => value !== undefined);
      const leaks = findSecretLeaks(bytes, canaries);
      const committed = await artifact(
        bytes,
        scope,
        artifactId,
        "TARGET_OUTPUT",
        logicalName,
        "text/plain; charset=utf-8",
        leaks.length === 0 ? "EXPORTABLE" : "RESTRICTED",
        leaks.length === 0 ? "NOT_REQUIRED" : "FAILED",
      );
      if (leaks.length > 0) {
        await failure({
          ...makeFailure(
            scope,
            "TARGET_SECURITY_VIOLATION",
            "TARGET",
            "TARGET",
            "TARGET_OUTPUT",
            "SECRET_CANARY_EXPOSED",
            "Target output contained a configured secret canary and was restricted",
          ),
          artifactRefs: [refForArtifact(committed)],
        });
      }
      return committed;
    };
  /** 提交一次环境或 Target 控制操作的时间、结果和 FailureRef。 */
  const control = async (
    scope: ScopeRef,
    operation: ControlEvent["operation"],
    result: ControlEvent["result"],
    options: {
      readonly startedAt?: IsoDateTime;
      readonly failureRefs?: readonly Ref<FailureRecord>[];
      /** Used only to make otherwise simultaneous receipts uniquely identifiable. */
      readonly identityRefs?: readonly Ref[];
    } = {},
  ): Promise<Ref<ControlEvent>> => {
      const endedAt = new Date().toISOString() as IsoDateTime;
      const startedAt = options.startedAt ?? endedAt;
      const failureRefs = options.failureRefs ?? [];
      const identityRefs = options.identityRefs ?? [];
      const event = withContentDigest({ schema: "evaldock.mvp.control-event/v1" as const, controlEventId: validateStableId<"ControlEventId">(`control.${String(scope.attemptId ?? scope.runId)}.${operation.toLowerCase()}.${digestValue({ startedAt, endedAt, identityRefs, failureRefs }).value.slice(0, 8)}`), scope, operation, startedAt, endedAt, result, failureRefs, createdAt: endedAt, producerVersion: EVALDOCK_VERSION });
      assertSecretFreeValue(event, services.config, "ControlEvent");
      return requireSucceeded("persist ControlEvent", await services.repository.putImmutable(services.operation("STORAGE", `control-${event.controlEventId}`), event)) as Ref<ControlEvent>;
    };
  /** 将平台文件锁事实转换为领域 LeaseRecord。 */
  const lease = async (leaseFact: LeaseFact, scope: ScopeRef, state: "ACTIVE" | "RELEASED"): Promise<void> => {
      const record = withContentDigest({ schema: "evaldock.mvp.lease/v1" as const, leaseId: validateStableId<"LeaseId">(`lease.${String(scope.runId)}.${state.toLowerCase()}`), scope, runId: scope.runId!, slotId: "vm-global" as const, state, ownerPid: leaseFact.ownerPid, ownerProcessStartToken: leaseFact.ownerProcessStartToken, acquiredAt: leaseFact.acquiredAt, ...(leaseFact.releasedAt === undefined ? {} : { releasedAt: leaseFact.releasedAt }), createdAt: state === "ACTIVE" ? leaseFact.acquiredAt : leaseFact.releasedAt!, producerVersion: EVALDOCK_VERSION });
      assertSecretFreeValue(record, services.config, "LeaseRecord");
      requireSucceeded("persist LeaseRecord", await services.repository.putImmutable(services.operation("STORAGE", `lease-${state}`), record));
    };
  return {
    immutable,
    projection,
    transition,
    failure,
    failures,
    artifact,
    outputArtifact,
    control,
    lease,
  };
}

/** 把冻结 Plan 的 JSON seedSpec 转成 Runtime Environment 接受的强类型条目。 */
function seedSpecs(plan: EvaluationPlan): readonly SeedEntrySpec[] {
  const seed = plan.casePlan.seedSpec as Record<string, unknown>;
  if (!Array.isArray(seed.entries)) throw new Error("frozen seedSpec.entries is missing");
  return seed.entries.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("seed entry is invalid");
    const entry = value as Record<string, unknown>;
    return {
      portablePath: String(entry.portablePath),
      entryType: entry.entryType as "DIRECTORY" | "FILE",
      mode: String(entry.mode),
      readOnlyForTarget: entry.readOnlyForTarget === true,
      ...(entry.content === undefined ? {} : { content: String(entry.content) }),
      ...(entry.encoding === undefined ? {} : { encoding: entry.encoding as "utf8" | "base64" }),
    };
  });
}

/** 为本次即时构造的不可变记录补齐统一 scope、时间和生产者版本。 */
function recordMetadata(scope: ScopeRef): { scope: ScopeRef; createdAt: string; producerVersion: string } {
  return { scope, createdAt: new Date().toISOString(), producerVersion: EVALDOCK_VERSION };
}

/** 重复采集 File After，直到两个连续摘要相同或达到稳定等待上限。 */
async function captureStableAfter(
  sensor: EnvironmentSensor,
  input: Omit<Parameters<EnvironmentSensor["captureAfter"]>[0], "snapshotId"> & {
    readonly stableWindowMs: number;
    readonly stableMaxWaitMs: number;
  },
): Promise<{ snapshot: FileSnapshotDraft; stable: boolean }> {
  const started = Date.now();
  let prior = (await sensor.captureAfter({ ...input, snapshotId: `snapshot.stability.${input.attemptId}.0` })).snapshot;
  let ordinal = 1;
  while (Date.now() - started <= input.stableMaxWaitMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, input.stableWindowMs));
    const current = (await sensor.captureAfter({ ...input, snapshotId: `snapshot.after.${input.attemptId}` })).snapshot;
    if (prior.snapshotDigest.value === current.snapshotDigest.value && prior.snapshotDigest.byteLength === current.snapshotDigest.byteLength) return { snapshot: current, stable: true };
    prior = current;
    ordinal += 1;
  }
  return { snapshot: { ...prior, snapshotId: `snapshot.after.${input.attemptId}` }, stable: false };
}

/** 将 TargetDriver 终止原因映射为 ExecutionAttempt 的终态。 */
function attemptTerminalState(result: TargetExecutionResult): "SUCCEEDED" | "TARGET_FAILED" | "TIMED_OUT" | "HARNESS_ERROR" | "CANCELLED" {
  if (result.terminationKind === "EXITED") return "SUCCEEDED";
  return result.terminationKind;
}

/** 把非成功 TargetExecutionResult 转成保持 Agent/Harness/取消归因的 FailureDraft。 */
function targetFailure(result: TargetExecutionResult, scope: ScopeRef): FailureDraft {
  if(result.errorMessage==="DSH_MODEL_TRANSPORT_ERROR")return makeFailure(scope,"TARGET_EXECUTION","EXTERNAL_DEPENDENCY","TARGET","TARGET_EXECUTION","MODEL_TRANSPORT_ERROR","DSH model API connection failed; no evidence of quota exhaustion");

  return makeFailure(scope, result.terminationKind === "TIMED_OUT" ? "TIMEOUT" : result.terminationKind === "CANCELLED" ? "CANCELLED" : "TARGET_EXECUTION", result.terminationKind === "HARNESS_ERROR" ? "EVALDOCK" : result.terminationKind === "CANCELLED" ? "USER" : "TARGET", result.terminationKind === "HARNESS_ERROR" ? "RUNTIME" : result.terminationKind === "CANCELLED" ? "USER" : "TARGET", "TARGET_EXECUTION", `TARGET_${result.terminationKind}`, "Target execution ended without a successful process exit");
}

/** 只读取共享 DSH Home 中稳定的 Session 目录名，用于把 Web 会话关联到当前 Case。 */
async function listDshSessionArchives(dshHomePath: string): Promise<ReadonlyMap<string, string>> {
  const sessionsRoot = path.join(dshHomePath, "sessions");
  const workspaceDirectories = await readdir(sessionsRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error),
  );
  const sessions = new Map<string, string>();
  for (const workspace of workspaceDirectories) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue;
    const entries = await readdir(path.join(sessionsRoot, workspace.name), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && /^session-[A-Za-z0-9-]+$/u.test(entry.name)) {
        sessions.set(entry.name, path.join(sessionsRoot, workspace.name, entry.name, "session.jsonl.zstd"));
      }
    }
  }
  return sessions;
}

/** 构造 Workflow 内部统一格式的 FailureDraft；save.failure 负责最终提交。 */
function makeFailure(scope: ScopeRef, category: FailureDraft["category"], origin: FailureDraft["origin"], actor: FailureDraft["actor"], phase: string, reasonCode: string, messageRedacted: string): FailureDraft {
  return { scope, category, origin, actor, phase, severity: category === "TARGET_SECURITY_VIOLATION" ? "CRITICAL" : "ERROR", retryable: false, messageRedacted, reasonCode, evidenceRefs: [], artifactRefs: [], occurredAt: new Date().toISOString() as IsoDateTime };
}

/** 用 Ref 的 ID 与摘要从内存索引解析完整 Artifact 元数据。 */
function requireFullArtifact(index: ReadonlyMap<string, ArtifactRef>, ref: Ref<ArtifactRef>): ArtifactRef {
  const artifact = index.get(String(ref.id));
  if (artifact === undefined || artifact.contentDigest.value !== ref.digest.value) throw new Error("committed ArtifactRef metadata is unavailable or mismatched");
  return artifact;
}

/** 更新一个十步流程节点的状态、时间、对象引用和当前失败分组。 */
function markStep(facts: MutableWorkflowFacts, number: WorkflowStepView["number"], status: WorkflowStepView["status"], refs: readonly Ref[] = []): void {
  const current = facts.timeline[number - 1]!;
  replaceStep(facts, number, { status, ...(status === "RUNNING" ? { startedAt: new Date().toISOString() } : { startedAt: current.startedAt ?? new Date().toISOString(), endedAt: new Date().toISOString() }), objectRefs: refs.map((ref) => `${ref.schema}:${ref.id}${ref.revision === undefined ? "" : `@${ref.revision}`}`), failureGroups: uniqueGroups(facts.failures) });
}

/** 对指定流程节点做不可变式局部替换；markStep 和故障收尾调用。 */
function replaceStep(facts: MutableWorkflowFacts, number: WorkflowStepView["number"], patch: Partial<WorkflowStepView>): void {
  const index = number - 1;
  facts.timeline[index] = { ...facts.timeline[index]!, ...patch };
}

/** 将 FailureRecord 映射为稳定、去重的五类用户可读故障分组。 */
function uniqueGroups(failures: readonly FailureRecord[]): readonly string[] {
  return [...new Set(failures.map(failureDisplayGroup))].sort();
}

/** 尝试原子替换非权威 status.html；失败只追加 REPORT_FAILURE，不覆盖已有事实。 */
async function updateStatus(
  services: ApplicationServices,
  facts: MutableWorkflowFacts,
  phase: string,
  recordFailure: (draft: FailureDraft) => Promise<Ref<FailureRecord>>,
): Promise<void> {
  if (facts.run === undefined || facts.attempt === undefined || facts.target === undefined) return;
  try {
    const html = renderStatusHtml(buildView(facts, phase));
    assertSecretFreeBytes(Buffer.from(html, "utf8"), services.config, "status.html");
    requireSucceeded(
      "replace status.html",
      await services.artifacts.replaceStatusHtml(
        services.operation("REPORTER", `status-${phase}`),
        html,
      ),
    );
  } catch (error) {
    await recordFailure(makeFailure(
      facts.attempt.scope,
      "REPORT_FAILURE",
      "EVALDOCK",
      "REPORTER",
      "STATUS_HTML",
      "STATUS_HTML_UPDATE_FAILED",
      "The non-authoritative status page could not be replaced; the prior committed page remains authoritative for diagnostics",
    )).catch(() => undefined);
    void error;
  }
}

/** 序列化结构化值后执行统一 Secret canary 扫描。 */
function assertSecretFreeValue(value: unknown, config: ConfigSnapshot, label: string): void {
  assertSecretFreeBytes(Buffer.from(JSON.stringify(value), "utf8"), config, label);
}

/** 检查待发布字节是否包含配置引用的 Secret 值，命中即拒绝发布。 */
function assertSecretFreeBytes(
  bytes: Uint8Array | string,
  config: ConfigSnapshot,
  label: string,
): void {
  const canaries = config.secretRefNames
    .map((name) => process.env[name])
    .filter((value): value is string => value !== undefined);
  if (findSecretLeaks(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes, canaries).length > 0) {
    throw new Error(`${label} matched a configured Secret canary and was not published`);
  }
}

/** 从已提交的内存事实投影当前 Viewer/Report 共用的只读视图。 */
function buildView(facts: MutableWorkflowFacts, phase: string): ResultData {
  return {
    evaluationMode:facts.evaluationMode,runId:String(facts.run!.runId),scope:facts.run!.scope,currentPhase:phase,runState:facts.run!.state,
    operationalHealth:facts.run!.operationalHealth,fixture:facts.fixture,
    securityIsolation:facts.securityIsolation??"NOT_VERIFIED",
    target:facts.target!,labels:facts.labels,scores:facts.scores,dimensions:facts.dimensions,
    environmentState:facts.environment?.state??"NOT_CREATED",
    failures:facts.failures,timeline:facts.timeline,artifacts:facts.artifacts,
    ...(facts.inspection?{inspection:facts.inspection}:{}),
    ...(facts.evaluationPlan?{plan:facts.evaluationPlan}:{}),
    ...(facts.caseData?{case:facts.caseData}:{}),
    ...(facts.attempt?{evaluationScope:facts.attempt.scope}:{}),
    ...(facts.execution?{execution:facts.execution}:{}),
    ...(facts.allTraceRef ? {allTraceRef:facts.allTraceRef} : facts.allTrace ? {allTrace:facts.allTrace} : {}),
    ...(facts.resetVerification?{reset:facts.resetVerification}:{}),
  };
}

/** stdout 为空时，从已物化的 DSH Session 事件恢复最终 assistant 文本。 */
function finalResponseFromTrace(observations: readonly RawObservation[]): string {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  for (const raw of [...observations].reverse()) {
    const envelope = record(raw.payloadInline);
    const data = record(envelope?.data);
    const event = record(data?.event) ?? record(record(data?.payload)?.event);
    const eventType = event?.type;
    if (eventType !== "assistant/message" && eventType !== "assistant/final" && eventType !== "message/assistant") continue;
    const eventData = record(event?.data);
    const message = record(eventData?.message);
    const content = message?.content ?? eventData?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => record(part))
        .filter((part): part is Record<string, unknown> => part !== undefined)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("");
      if (text.length > 0) return text;
    }
  }
  return "";
}

/** 根据扩展名标记真实交付物的媒体类型。 */
function deliverableMediaType(portablePath: string): string {
  switch (path.posix.extname(portablePath).toLowerCase()) {
    case ".json": return "application/json";
    case ".txt": case ".md": case ".py": case ".js": case ".ts": case ".tsx":
    case ".jsx": case ".css": case ".html": case ".xml": case ".yaml": case ".yml":
    case ".csv": case ".sql": case ".sh": return "text/plain; charset=utf-8";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

/** 生成报告用的 UTF-8 输出片段，并明确标记仅报告内联是否截断。 */
function outputPreview(bytes: Uint8Array): { text: string; truncated: boolean } {
  const buffer = Buffer.from(bytes);
  return {
    text: buffer.subarray(0, REPORT_OUTPUT_PREVIEW_BYTES).toString("utf8"),
    truncated: buffer.byteLength > REPORT_OUTPUT_PREVIEW_BYTES,
  };
}

/** 构造 CLI 最终摘要；所有提前结束、异常和正常完成路径共同调用。 */
function summary(
  facts: MutableWorkflowFacts,
  runId: string,
  fixture: boolean,
  exitCode: WorkflowSummary["exitCode"],
  status: WorkflowSummary["status"],
  runRoot: string,
  command: WorkflowSummary["command"] = "run",
): WorkflowSummary {
  return {
    schema: "evaldock.mvp.cli-summary/v1",
    command,
    status,
    runId,
    ...(facts.run === undefined ? {} : { runState: facts.run.state, operationalHealth: facts.run.operationalHealth }),
    scores:facts.scores,dimensions:facts.dimensions,
    fixture,
    ...(facts.securityIsolation === undefined ? {} : { securityIsolation: facts.securityIsolation }),
    failureGroups: uniqueGroups(facts.failures),
    reasonCodes: [...new Set(facts.failures.map((failure) => failure.reasonCode))].sort(),
    ...(facts.target === undefined ? {} : { targetSnapshotId: String(facts.target.targetSnapshotId) }),
    ...(facts.inspection === undefined ? {} : { inspectionId: String(facts.inspection.inspectionId) }),
    ...(facts.datasetSelection === undefined
      ? {}
      : {
          selectedLabelIds: facts.datasetSelection.evaluationLabelIds.map(String),
          datasetTestProfile: facts.datasetSelection.profile,
          selectedDatasets: facts.datasetSelection.selectedDatasets.map((selection) => ({
            datasetId: String(selection.datasetId),
            evaluationLabelIds: selection.evaluationLabelIds.map(String),
            caseCount: selection.caseCount,
            reason: selection.reason,
            ...(selection.matchType === undefined ? {} : { matchType: selection.matchType }),
            ...(selection.targetCapabilities === undefined ? {} : { targetCapabilities: selection.targetCapabilities }),
            ...(selection.evidence === undefined ? {} : { evidence: selection.evidence }),
            ...(selection.marginalValue === undefined ? {} : { marginalValue: selection.marginalValue }),
          })),
          totalCaseCount: facts.datasetSelection.totalCaseCount,
          datasetMatchModel: facts.datasetSelection.model,
          datasetMatchDurationMs: facts.datasetSelection.durationMs,
        }),
    ...(facts.evaluationPlan === undefined ? {} : { evaluationPlanId: String(facts.evaluationPlan.evaluationPlanId) }),
    ...(facts.agentTracePlan === undefined ? {} : { agentTracePlanId: String(facts.agentTracePlan.agentTracePlanId) }),
    ...(facts.observationPlan === undefined ? {} : { observationPlanId: String(facts.observationPlan.observationPlanId) }),
    ...(facts.execution?.dshSessionIds === undefined ? {} : { dshSessionIds: facts.execution.dshSessionIds }),
    recordsPath: path.join(runRoot, runId),
    exitCode,
  };
}
