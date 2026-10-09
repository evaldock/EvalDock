/**
 * 文件职责：构造一次评测运行所需的四个运行时投影，并统一生成受状态机约束的投影迁移。
 * 核心流程：校验冻结标识与作用域，创建 Run、Case、Attempt、Environment 初始投影，再以修订号和摘要封装后续迁移。
 * 与其他文件的真实交互：读取 core/models.ts 的领域模型、校验器和摘要工具；由 app/workflow.ts 编排创建、持久化这些投影。
 * 公开接口：RuntimeProjectionIds、RuntimeProjectionGraph、createRuntimeProjectionGraph、transitionRuntimeProjection。
 */
import {
  assertLegalTransition,
  type AttemptState,
  type CaseState,
  type EnvironmentInstance,
  type EnvironmentState,
  type EvaluationCase,
  type EvaluationPlan,
  type EvaluationRun,
  type ExecutionAttempt,
  type ObservationPlan,
  type Ref,
  type RunState,
  type ScopeRef,
  type SourceRunId,
  type StateTransition,
  type TargetSnapshot,
  validateIsoDateTime,
  validateScope,
  validateStableId,
  validateVersionedAssetId,
  withProjectionDigest,
  refForProjection,
} from "../core/models.js";
import type { FailureRecord } from "../core/errors.js";

/** 工作流为同一次运行预先分配的聚合标识集合。 */
export interface RuntimeProjectionIds {
  runId: string;
  caseId: string;
  attemptId: string;
  environmentInstanceId: string;
  sourceRunId: string;
}

/** 四个运行时聚合及其共享 Attempt 作用域组成的初始投影图。 */
export interface RuntimeProjectionGraph {
  run: EvaluationRun;
  evaluationCase: EvaluationCase;
  attempt: ExecutionAttempt;
  environment: EnvironmentInstance;
  scope: ScopeRef;
}

/**
 * 创建相互引用且摘要完整的初始投影图；由 app/workflow.ts 在准备环境前调用，内部依赖 core/models.ts 完成标识、作用域和版本化资产校验。
 */
export function createRuntimeProjectionGraph(input: {
  ids: RuntimeProjectionIds;
  targetId: string;
  targetSnapshotId: string;
  targetSnapshotRef: Ref<TargetSnapshot>;
  evaluationPlanRef: Ref<EvaluationPlan>;
  observationPlanRef: Ref<ObservationPlan>;
  casePlanId: string;
  environmentId: string;
  workspacePath: string;
  runtimeDshHomePath: string;
  now: string;
}): RuntimeProjectionGraph {
  const runId = validateStableId<"RunId">(input.ids.runId, "runId");
  const caseId = validateStableId<"CaseId">(input.ids.caseId, "caseId");
  const attemptId = validateStableId<"AttemptId">(input.ids.attemptId, "attemptId");
  const environmentInstanceId = validateStableId<"EnvironmentInstanceId">(
    input.ids.environmentInstanceId,
    "environmentInstanceId",
  );
  const sourceRunId = validateStableId<"SourceRunId">(
    input.ids.sourceRunId,
    "sourceRunId",
  ) as SourceRunId;
  const runScope = validateScope({
    targetId: input.targetId,
    targetSnapshotId: input.targetSnapshotId,
    runId,
  });
  const caseScope = validateScope({
    ...runScope,
    caseId,
  });
  const scope = validateScope({
    ...caseScope,
    attemptId,
  });
  const now = validateIsoDateTime(input.now, "now");

  const run = withProjectionDigest({
    schema: "evaldock.mvp.run/v1" as const,
    aggregateId: runId,
    runId,
    scope: runScope,
    state: "CREATED" as const,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    failureRefs: [] as readonly Ref<FailureRecord>[],
    targetSnapshotRef: input.targetSnapshotRef,
    evaluationPlanRef: input.evaluationPlanRef,
    observationPlanRef: input.observationPlanRef,
    caseId,
    operationalHealth: "HEALTHY" as const,
  }) as EvaluationRun;
  const evaluationCase = withProjectionDigest({
    schema: "evaldock.mvp.case/v1" as const,
    aggregateId: caseId,
    caseId,
    runId,
    scope: caseScope,
    state: "PENDING" as const,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    failureRefs: [] as readonly Ref<FailureRecord>[],
    casePlanId: validateStableId<"CasePlanId">(input.casePlanId, "casePlanId"),
    attemptId,
    scoreRefs: [],
  }) as EvaluationCase;
  const attempt = withProjectionDigest({
    schema: "evaldock.mvp.attempt/v1" as const,
    aggregateId: attemptId,
    attemptId,
    caseId,
    scope,
    state: "PENDING" as const,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    failureRefs: [] as readonly Ref<FailureRecord>[],
    ordinal: 1 as const,
    workspacePath: input.workspacePath,
    runtimeDshHomePath: input.runtimeDshHomePath,
    sourceRunId,
  }) as ExecutionAttempt;
  const environment = withProjectionDigest({
    schema: "evaldock.mvp.environment/v1" as const,
    aggregateId: environmentInstanceId,
    environmentInstanceId,
    attemptId,
    scope,
    state: "CREATED" as const,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    failureRefs: [] as readonly Ref<FailureRecord>[],
    environmentId: validateVersionedAssetId<"EnvironmentDefinitionId">(
      input.environmentId,
      "environmentId",
    ),
    workspaceBinding: "attempt.workspace",
    resetGeneration: 0,
  }) as EnvironmentInstance;
  return { run, evaluationCase, attempt, environment, scope };
}

/** 本模块允许通过统一入口迁移的四类运行时投影。 */
type RuntimeProjection = EvaluationRun | EvaluationCase | ExecutionAttempt | EnvironmentInstance;

/** 根据投影具体类型收窄其合法目标状态。 */
type RuntimeStateFor<Projection extends RuntimeProjection> = Projection extends EvaluationRun
  ? RunState
  : Projection extends EvaluationCase
    ? CaseState
    : Projection extends ExecutionAttempt
      ? AttemptState
      : EnvironmentState;

/**
 * 校验并构造单个运行时投影的下一次状态迁移；由 app/workflow.ts 的各阶段调用，并委托 core/models.ts 校验状态机、重算投影摘要与引用。
 */
export function transitionRuntimeProjection<Projection extends RuntimeProjection>(input: {
  projection: Projection;
  toState: RuntimeStateFor<Projection>;
  reasonCode: string;
  occurredAt: string;
  supportingRefs?: readonly Ref[];
  failureRefs?: readonly Ref<FailureRecord>[];
  patch?: Readonly<Record<string, unknown>>;
}): StateTransition<Projection> {
  const { projection } = input;
  assertLegalTransition(projection.schema, projection.state, input.toState);
  const occurredAt = validateIsoDateTime(input.occurredAt, "occurredAt");
  const failureRefs = input.failureRefs ?? projection.failureRefs;
  const { projectionDigest: _priorDigest, ...projectionWithoutDigest } = projection;
  const nextProjection = withProjectionDigest({
    ...projectionWithoutDigest,
    ...(input.patch ?? {}),
    state: input.toState,
    revision: projection.revision + 1,
    updatedAt: occurredAt,
    failureRefs,
  } as Omit<Projection, "projectionDigest">) as Projection;
  return {
    aggregateRef: refForProjection(projection),
    expectedRevision: projection.revision,
    fromState: projection.state,
    toState: input.toState,
    reasonCode: input.reasonCode,
    supportingRefs: input.supportingRefs ?? [],
    failureRefs,
    occurredAt,
    nextProjection,
  } as StateTransition<Projection>;
}
