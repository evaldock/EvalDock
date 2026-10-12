/** Public Case metadata. Private assessment material belongs only in Judge input. */
import { digestValue, type JsonObject, type JsonValue } from "../core/models.js";
import type { DatasetCase } from "../datasets/loader.js";

export function publicCaseMetadata(data: Omit<DatasetCase, "seedEntries">): Omit<DatasetCase, "seedEntries"> {
  const { seedEntries: _seeds, ...view } = data as DatasetCase;
  const grading = data.grading;
  if (grading) {
    const publicGrading: Record<string, JsonValue> = { mode: grading.mode ?? "reference" };
    if (grading.weight !== undefined) publicGrading.weight = grading.weight;
    if (grading.mode === "unavailable" && grading.reason !== undefined) publicGrading.reason = grading.reason;
    else if (grading.reference !== undefined) publicGrading.referenceDigest = digestValue(grading.reference) as unknown as JsonObject;
    else if (grading.referenceDigest !== undefined) publicGrading.referenceDigest = grading.referenceDigest;
    view.grading = publicGrading;
  }
  if (data.question) {
    const question: Record<string, JsonValue> = {};
    for (const key of ["schema", "version", "id", "title", "task", "environment", "inputs", "capabilityLabels", "benchdock", "difficulty", "tags"]) {
      if (data.question[key] !== undefined) question[key] = data.question[key]!;
    }
    view.question = question;
  }
  return view;
}
