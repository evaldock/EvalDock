/** One shared, bounded result of external BEFORE/AFTER observations. Never a per-label filter. */
import type { CollectionStatus, JsonObject, JsonValue, RawObservation, SourceDescriptor } from "../core/models.js";
import type { TraceEntry } from "./types.js";
export const ENVIRONMENT_RESULT_MAX_BYTES = 1024;
const object = (v: unknown): JsonObject | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : undefined;

export function environmentFinalEntry(
  observations: readonly RawObservation[], coverage: readonly CollectionStatus[], sources: readonly SourceDescriptor[], pausedComponents: readonly string[] = [],
): TraceEntry {
  const components: Record<string, string> = Object.fromEntries(pausedComponents.map(name=>[name,"PAUSED"]));
  const candidates: JsonValue[] = [];
  for (const source of sources.filter(s=>s.sourceType!=="DSH_PROBE")) {
    const name = source.sourceType.toLowerCase();
    if(components[name]==="PAUSED")continue;
    const statuses = coverage.filter(s=>String(s.sourceRef.id)===String(source.sourceId));
    const status = statuses.at(-1);
    const raw = observations.filter(o=>String(o.sourceRef.id)===String(source.sourceId));
    const changes = raw.flatMap(o=> {
      const payload=object(o.payloadInline);
      return Array.isArray(payload?.changes) ? payload.changes : [];
    });
    const watermark = object(status?.finalWatermark);
    components[name] = watermark?.runtimeStatus === "NOT_CONFIGURED" ? "NOT_CONFIGURED"
      : !status || status.completeness!=="COMPLETE" ? "UNKNOWN"
      : changes.length ? "CHANGED" : "UNCHANGED";
    // An incomplete observation is not a trustworthy final diff.
    if (components[name] !== "CHANGED") continue;
    for (const change of changes) {
      const c = object(change);
      if (c) {
        const file=object(c.value);
        // File identity and size describe the result; mode/hash wrappers need not consume the summary.
        candidates.push(name==="filesystem" && typeof file?.portablePath==="string"
          ? {component:name,op:c.op ?? "CHANGE",path:file.portablePath,
             ...(typeof file.byteLength==="number"?{bytes:file.byteLength}:{}),
             ...(typeof file.entryType==="string"?{type:file.entryType}:{})}
          : {component:name,...c});
      }
    }
  }
  const content: Record<string, JsonValue> = {
    comparison:"BEFORE_AFTER", transientChangesObserved:false, causality:"NOT_PROVEN",
    components, changeCount:candidates.length, omittedChanges:candidates.length, changes:[],
  };
  const entry: TraceEntry = {id:"environment.final",layer:"ENVIRONMENT",content};
  const changes = content.changes as JsonValue[];
  // Small concrete changes fit first; no fixed component priority.
  candidates.sort((a,b)=>Buffer.byteLength(JSON.stringify(a))-Buffer.byteLength(JSON.stringify(b)));
  content.omittedComponents=0;
  while(Buffer.byteLength(JSON.stringify([entry]))>ENVIRONMENT_RESULT_MAX_BYTES && Object.keys(components).length){
    delete components[Object.keys(components).at(-1)!];
    content.omittedComponents=Number(content.omittedComponents)+1;
  }
  for (const candidate of candidates) {
    changes.push(candidate);
    content.omittedChanges = candidates.length-changes.length;
    if (Buffer.byteLength(JSON.stringify([entry]))>ENVIRONMENT_RESULT_MAX_BYTES) {
      changes.pop();
      content.omittedChanges = candidates.length-changes.length;
    }
  }
  if (Buffer.byteLength(JSON.stringify([entry]))>ENVIRONMENT_RESULT_MAX_BYTES) {
    throw new Error("Environment status metadata exceeds 1024 bytes");
  }
  return entry;
}
