/** Tolerate presentation differences without inventing or changing a model score. */
import { roundScore } from "./scoring.js";
import type { JudgeInput, LabelScore } from "./types.js";

export class JudgeResponseError extends Error {}
type ScoreValue = Pick<LabelScore, "status" | "score" | "reason" | "evidenceIds"> & { warnings: string[] };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: RecordValue, key: string) => Object.hasOwn(value, key);
const MAX_BYTES = 20 * 1024 * 1024;

/** Extract complete outer JSON containers; braces inside quoted strings are not boundaries. */
function jsonContainers(text: string): string[] {
  const output: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) {
      if (char === "{" || char === "[") { start = i; depth = 1; quoted = false; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (--depth === 0) {
        output.push(text.slice(start, i + 1)); start = -1;
        if (output.length > 32) throw new JudgeResponseError("JUDGE_RESPONSE_TOO_COMPLEX");
      }
    }
  }
  return output;
}

export function normalizeJudgeResponse(content: unknown, input: JudgeInput): ScoreValue {
  const candidates: RecordValue[] = [];
  const warnings = new Set<string>();
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 128 || depth > 12) throw new JudgeResponseError("JUDGE_RESPONSE_TOO_COMPLEX");
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_BYTES) throw new JudgeResponseError("JUDGE_RESPONSE_TOO_LARGE");
      const text = value.trim().replace(/^\uFEFF/, "");
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch {
        const parts = jsonContainers(text);
        if (!parts.length) return;
        warnings.add("JSON_EXTRACTED_FROM_TEXT");
        for (const part of parts) {
          let item: unknown;
          try { item = JSON.parse(part); } catch { continue; }
          visit(item, depth + 1);
        }
        return;
      }
      // Plain JSON strings may contain another JSON document.
      if (typeof parsed === "string" && parsed === value) return;
      visit(parsed, depth + 1);
    } else if (Array.isArray(value)) {
      // Providers sometimes split JSON across text content blocks.
      const textBlocks = value.filter(item => record(item) && typeof item.text === "string");
      if (textBlocks.length === value.length && value.length > 0) {
        warnings.add("CONTENT_BLOCKS_UNWRAPPED");
        visit(textBlocks.map(item => (item as RecordValue).text).join(""), depth + 1);
      } else {
        for (const item of value) visit(item, depth + 1);
      }
    } else if (record(value)) {
      if (has(value, "score")) { candidates.push(value); return; }
      // Do not search inside evidence or rationale for possible scores.
      for (const key of ["content", "text", "result", "data", "evaluation", "output"]) {
        if (has(value, key)) {
          warnings.add("RESPONSE_WRAPPER_UNWRAPPED");
          visit(value[key], depth + 1);
        }
      }
    }
  }
  visit(content, 0);
  if (!candidates.length) throw new JudgeResponseError("JUDGE_SCORE_MISSING");

  const scale = input.label.scoringStandard.scoring_scale as {min: number; max: number};
  const knownIds = new Set(input.allTrace.entries.filter(entry => input.evaluationMode!=="EFFECT" || entry.layer==="DELIVERY").map(entry => entry.id));
  function normalize(raw: RecordValue): ScoreValue {
    const notes = new Set(warnings);
    if (Object.keys(raw).some(key => !["score", "status", "reason", "evidence_ids", "evidenceIds"].includes(key)))
      notes.add("EXTRA_FIELDS_IGNORED");
    let score = raw.score;
    if (typeof score === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(score.trim())) {
      score = Number(score.trim()); notes.add("NUMERIC_STRING_NORMALIZED");
    }
    if (score !== null && (typeof score !== "number" || !Number.isFinite(score)))
      throw new JudgeResponseError("JUDGE_SCORE_INVALID");
    if (typeof score === "number" && (score < scale.min || score > scale.max))
      throw new JudgeResponseError("JUDGE_SCORE_OUT_OF_RANGE");
    let status = raw.status;
    if (status === undefined) {
      status = score === null ? "UNASSESSABLE" : "SCORED"; notes.add("STATUS_INFERRED_FROM_SCORE");
    } else if (typeof status === "string") {
      status = status.trim().toUpperCase();
      if (status !== raw.status) notes.add("STATUS_NORMALIZED");
    }
    if (status !== "SCORED" && status !== "UNASSESSABLE") throw new JudgeResponseError("JUDGE_STATUS_INVALID");
    if ((status === "SCORED") !== (score !== null)) throw new JudgeResponseError("JUDGE_SCORE_STATUS_CONFLICT");
    let reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (!reason) {
      reason = "Judge 未提供评分理由；此结果仅保留模型明确返回的分数或不可评估状态。";
      notes.add("REASON_MISSING");
    }
    // Long explanations are valid evidence of the Judge's reasoning, not a format failure.
    let cited = raw.evidence_ids ?? raw.evidenceIds;
    if (typeof cited === "string") { cited = [cited]; notes.add("CITATION_STRING_NORMALIZED"); }
    if (!Array.isArray(cited)) {
      cited = []; notes.add("CITATIONS_MISSING_OR_INVALID");
    }
    const valid: string[] = [];
    for (const id of cited as unknown[]) {
      if (typeof id === "string" && knownIds.has(id)) valid.push(id);
      else notes.add("UNKNOWN_CITATIONS_OMITTED");
    }
    return { status, score: score as number | null, reason, evidenceIds: [...new Set(valid)], warnings: [...notes] };
  }
  const values = candidates.map(normalize);
  const first = values[0]!;
  if (values.some(value => value.status !== first.status || value.score !== first.score))
    throw new JudgeResponseError("JUDGE_SCORE_AMBIGUOUS");
  // Repeated representations of the same score can safely contribute valid citations.
  const rounded = first.score === null ? null : roundScore(first.score);
  return { ...first, score: rounded,
    evidenceIds: [...new Set(values.flatMap(value => value.evidenceIds))],
    warnings: [...new Set([...values.flatMap(value => value.warnings), ...(rounded !== first.score ? ["SCORE_ROUNDED_TO_2_DECIMALS"] : [])])],
  };
}
