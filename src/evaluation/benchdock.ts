/** Trusted evaluator-side join. Never installs, executes or copies private checkers. */
import path from "node:path";
import { readEvidenceFile, readTraceDirectory } from "../all-trace/store.js";
import { digestBytes, digestValue, type JsonObject } from "../core/models.js";
import { parseVerifiedReportDocument } from "../reporting/record.js";
import { aggregateScores } from "./scoring.js";
import type { LabelJudge, LabelScore } from "./types.js";

export async function scoreBenchDockReport(input: {
  reportFile: string; referenceFile: string; judge: LabelJudge;
}) {
  const reportPath = path.resolve(input.reportFile), referencePath = path.resolve(input.referenceFile);
  const report = parseVerifiedReportDocument((await readEvidenceFile(path.dirname(reportPath), path.basename(reportPath), 20*1024*1024)).toString("utf8"));
  if (!report.case || !report.allTraceRef || report.case.grading.mode !== "unavailable") throw new Error("Not an execution-only BenchDock report");
  const origin = report.case.question.benchdock as JsonObject | undefined;
  if (!origin || origin.repo_id !== "EvalDock/BenchDock" || origin.task_id !== report.case.question.id) throw new Error("Missing BenchDock provenance");
  const evaluationMode = report.evaluationMode;
  if (evaluationMode !== "EFFECT" && evaluationMode !== "FULL") throw new Error("Report is missing its original evaluation mode");
  const weight = report.case.grading.weight;
  if (weight !== undefined && (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0)) throw new Error("Invalid grading weight");
  const raw = await readEvidenceFile(path.dirname(referencePath), path.basename(referencePath), 10*1024*1024);
  const bundle = JSON.parse(raw.toString("utf8"));
  if (bundle.schema !== "evaldock.benchdock-private-reference/v1" || bundle.taskId !== origin.task_id ||
      bundle.revision !== origin.revision || bundle.taskRecordSha256 !== origin.task_record_sha256 ||
      !bundle.reference || typeof bundle.reference !== "object" || Array.isArray(bundle.reference)) {
    throw new Error("Private reference identity does not match this public task revision");
  }
  const allTrace = await readTraceDirectory(path.dirname(reportPath), report.allTraceRef, 20*1024*1024);
  if (digestValue(allTrace.scope).value !== digestValue(report.evaluationScope ?? report.scope).value) throw new Error("Trace scope does not match the report");
  const body = {...report.case, seedEntries: [], grading: {mode:"reference", reference:bundle.reference, ...(weight === undefined ? {} : {weight})}};
  const caseData = {...body, contentDigest: digestValue(body, ["contentDigest"])};
  const scores: LabelScore[] = [];
  for (const label of report.labels) scores.push(await input.judge.evaluate({label, case:caseData, allTrace, evaluationMode}));
  const result = {schema:"evaldock.benchdock-deferred-scores/v1", taskId:origin.task_id,
    evaluationMode, datasetRevision:origin.revision, sourceReportDigest:report.contentDigest,
    privateReferenceDigest:digestBytes(raw), scoringMethod:"EVALDOCK_LLM_LABEL_JUDGE_NOT_UPSTREAM_OFFICIAL",
    scores, dimensions:aggregateScores(scores)};
  return {...result,contentDigest:digestValue(result)};
}
