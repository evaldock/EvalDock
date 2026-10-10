/** First-version deliverables: complete small bodies, otherwise an explicit existence-only index. */
import path from "node:path";
import type { JsonValue } from "../core/models.js";
import type { SubmissionFile } from "./types.js";

/** Both individual raw files and the Case's serialized content budget are bounded. */
export const SUBMISSION_CONTENT_BUDGET_BYTES = 256 * 1024;
export type SubmissionContent = Pick<SubmissionFile,
  "representation" | "content" | "contentTruncated" | "contentOmittedReason" | "evaluationScope"> & {
  readonly evaluationScope: "CONTENT" | "EXISTENCE_ONLY";
  readonly consumedBytes: number;
};

export function submissionIndex(reason: NonNullable<SubmissionFile["contentOmittedReason"]>): SubmissionContent {
  return { representation: "INDEX_ONLY", content: null, contentTruncated: false,
    contentOmittedReason: reason, evaluationScope: "EXISTENCE_ONLY", consumedBytes: 0 };
}

export function submissionContent(bytes: Uint8Array, portablePath: string,
  remainingBytes: number, restricted: boolean): SubmissionContent {
  if (restricted) return submissionIndex("RESTRICTED");
  if (bytes.byteLength > SUBMISSION_CONTENT_BUDGET_BYTES) return submissionIndex("FILE_TOO_LARGE");
  const buffer = Buffer.from(bytes);
  const extension = path.posix.extname(portablePath).toLowerCase();
  const textual = new Set([
    ".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".css", ".html",
    ".xml", ".yaml", ".yml", ".csv", ".sql", ".sh",
  ]).has(extension) || (!buffer.includes(0) && extension === "");
  let representation: "JSON" | "TEXT" | "BASE64";
  let content: JsonValue;
  if (extension === ".json") {
    const text = buffer.toString("utf8");
    try { content = JSON.parse(text) as JsonValue; representation = "JSON"; }
    catch { content = text; representation = "TEXT"; }
  } else if (textual) { content = buffer.toString("utf8"); representation = "TEXT"; }
  else { content = buffer.toString("base64"); representation = "BASE64"; }
  // Count the actual JSON payload, including Base64 expansion and escaped text.
  const cost = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (cost > Math.max(0, remainingBytes)) return submissionIndex("CASE_CONTENT_BUDGET");
  return { representation, content, contentTruncated: false, evaluationScope: "CONTENT",
    consumedBytes: cost };
}
