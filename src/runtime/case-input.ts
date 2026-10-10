import type {ObserverRegistration} from "../observation/registry.js";
/** 把已加载的 Case 与 Trace/Environment 配置组合为执行输入；与评分解耦。 */
import { readFile } from "node:fs/promises";
import { digestValue, validateStableId, type CaseExecutionInput, type DatasetId, type JsonObject } from "../core/models.js";
import type { DatasetCase } from "../datasets/loader.js";
import { parseSourceRequirement } from "./source-requirement.js";
export async function loadCaseExecutionInput(input: {
  case: DatasetCase; datasetId: DatasetId; traceFile:string; environmentFile:string;
  observerRegistry?: readonly ObserverRegistration[];
}): Promise<CaseExecutionInput> {
  const trace=JSON.parse(await readFile(input.traceFile,"utf8"));
  const environment=JSON.parse(await readFile(input.environmentFile,"utf8"));
  const components=Object.values(environment.components) as JsonObject[];
  const sources=[parseSourceRequirement(trace.sourceRequirement,"trace"),
    ...components.filter(component=>component===environment.components.workspace || (component.enabled!==false && input.observerRegistry?.find(observer=>observer.implementationId===component.observerAdapter)?.enabled!==false)).map(component=>parseSourceRequirement(component.sourceRequirement,"environment.component"))];
  if (new Set(sources.map(source=>source.sourceRequirementId)).size!==sources.length) throw new Error("Duplicate observation source");
  const workspace=parseSourceRequirement(environment.components.workspace.sourceRequirement,"workspace");
  const data={
    schema:"evaldock.case-execution-input/v1" as const,
    inputId:validateStableId<"CaseExecutionInputId">("case-input."+input.case.contentDigest.value.slice(0,24)),
    datasetId:input.datasetId,
    caseDigest:input.case.contentDigest,
    labelIds:input.case.labelIds,
    scenario: {
      scenarioId: input.case.caseId, agentTask:input.case.task, publicInputs:[],
      execution:{deadlineMs:input.case.deadlineMs,maxAttempts:1,stableWindowMs:250},
      pathPolicy:{allowedChanges:input.case.allowedPaths.map(portablePath=>({match:"PREFIX",portablePath})),
        forbiddenChanges:[{match:"PREFIX",portablePath:"input"}],permittedReads:["input"]},
    },
    environment:{environmentId:environment.environmentId,...environment.workspace,seedSpec:{entries:input.case.seedEntries}},
    runtimeSourceRequirementId:sources[0]!.sourceRequirementId,
    environmentObserverSourceRequirementId:workspace.sourceRequirementId,
    sourceRequirements:sources,
  };
  return Object.freeze({...data,contentDigest:digestValue(data)});
}
