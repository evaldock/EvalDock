/** 唯一 all trace 装配入口：保留实际内容、来源和覆盖状态，不生成旧 Judge 的派生事实。 */
import { digestValue, digestEquals, type JsonValue, type ArtifactRef, type CollectionStatus, type RawObservation, type ScopeRef, type SourceDescriptor } from "../core/models.js";
import { environmentFinalEntry } from "./environment-summary.js";
import { freezeJson } from "../core/models.js";
import type { AllTrace, FinalResponse, SubmissionFile, TraceEntry } from "./types.js";

export function assembleAllTrace(input: {
  traceId: string; scope: ScopeRef; createdAt: string; producerVersion: string;
  agentObservations: readonly RawObservation[];
  agentContents?: ReadonlyMap<number,JsonValue>;
  /** Other adapters declare their Agent sources; DSH remains the default. */
  agentSourceTypes?: readonly string[];
  environmentChanges: readonly RawObservation[];
  pausedComponents?: readonly string[];
  sources: readonly SourceDescriptor[]; coverage: readonly CollectionStatus[];
  artifacts: readonly ArtifactRef[];
  finalResponse: FinalResponse; files: readonly SubmissionFile[];
}): AllTrace {
  const integrity: {code:string; id:string}[] = [];
  const agentSourceTypes = new Set(input.agentSourceTypes ?? ["DSH_PROBE"]);
  const sourceIds = new Set(input.sources.map(source => String(source.sourceId)));
  const entries: TraceEntry[] = [];
  const ids = new Set<string>();
  for (const [layer, records] of [["AGENT",input.agentObservations],["ENVIRONMENT",input.environmentChanges]] as const) {
    for (const observation of records) {
      const id = String(observation.observationId);
      if (ids.has(id)) throw new Error(`Duplicate all trace entry: ${id}`);
      ids.add(id);
      if (!digestEquals(observation.contentDigest, digestValue(observation,["contentDigest"]))) integrity.push({code:"RECORD_DIGEST_MISMATCH",id});
      if (observation.scope.attemptId !== input.scope.attemptId) throw new Error(`Cross-attempt trace entry: ${id}`);
      if (!sourceIds.has(String(observation.sourceRef.id))) integrity.push({code:"UNKNOWN_SOURCE",id});
      if (layer === "ENVIRONMENT") continue;
      entries.push({ id, layer, sourceId:String(observation.sourceRef.id), content: layer==="AGENT" ? input.agentContents?.get(Number(observation.captureMetadata.lineNumber)) ?? observation.payloadInline ?? null : observation.payloadInline ?? null });
    }
  }
  entries.push(environmentFinalEntry(input.environmentChanges, input.coverage, input.sources.filter(source=>!agentSourceTypes.has(source.sourceType)), input.pausedComponents));
  entries.push({ id:`${input.traceId}.final-response`, layer:"DELIVERY", content:JSON.parse(JSON.stringify(input.finalResponse)) });
  for (const [index,file] of input.files.entries()) entries.push({ id:`${input.traceId}.file.${index+1}`, layer:"DELIVERY", content:JSON.parse(JSON.stringify(file)) });
  const record = {
    schema:"evaldock.all-trace/v1" as const, traceId:input.traceId, scope:input.scope,
    createdAt:input.createdAt, producerVersion:input.producerVersion,
    entries,
    sources:input.sources.filter(source=>agentSourceTypes.has(source.sourceType)),
    coverage:input.coverage.filter(status=>input.sources.some(source=>agentSourceTypes.has(source.sourceType) && String(source.sourceId)===String(status.sourceRef.id))),
    artifacts:input.artifacts.filter(artifact=>input.files.some(file=>String(file.artifactRef?.id)===String(artifact.artifactId)) || String(input.finalResponse.artifactRef.id)===String(artifact.artifactId)), integrity,
  };
  return freezeJson({...record, contentDigest:digestValue(record)});
}
