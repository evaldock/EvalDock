/** Complete small deliverables, bounded text excerpts, or an explicit existence-only index. */
import path from "node:path";
import { createHash } from "node:crypto";
import { sampleFileWithDigest, type FileSample } from "./file-sample.js";
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
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength > SUBMISSION_CONTENT_BUDGET_BYTES) {
    if(!safeTextExtension(portablePath)) return submissionIndex("FILE_TOO_LARGE");
    const window=previewWindow(remainingBytes);
    if(window===0)return submissionIndex("CASE_CONTENT_BUDGET");
    const samples=[...new Set([0,Math.max(0,Math.floor((buffer.length-window)/2)),Math.max(0,buffer.length-window)])].map(start=>({start,end:Math.min(buffer.length,start+window),bytes:buffer.subarray(start,Math.min(buffer.length,start+window))}));
    return sampledTextPreview(samples,buffer.length,createHash("sha256").update(buffer).digest("hex"),remainingBytes);
  }
  const extension = path.posix.extname(portablePath).toLowerCase();
  const textual = safeTextExtension(portablePath) || (!buffer.includes(0) && extension === "");
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

const PREVIEW_TEXT_EXTENSIONS=new Set([".txt",".md",".log",".csv",".tsv",".json",".jsonl",".ndjson",".py",".js",".mjs",".cjs",".ts",".tsx",".jsx",".css",".html",".xml",".yaml",".yml",".sql",".sh",".bash",".c",".h",".cpp",".hpp",".go",".rs",".java",".r",".toml"]);
function safeTextExtension(portablePath:string):boolean{return PREVIEW_TEXT_EXTENSIONS.has(path.posix.extname(portablePath).toLowerCase());}
function previewWindow(remaining:number):number{return Math.max(0,Math.min(4096,Math.floor((remaining-2048)/18)));}
function utf8Sample(sample:FileSample,byteLength:number):{start:number;end:number;text:string}|undefined {
  let start=0,end=sample.bytes.length;
  if(sample.start>0)while(start<Math.min(end,3)&&(sample.bytes[start]!&0xc0)===0x80)start++;
  // Remove only an incomplete final code point, not arbitrary invalid bytes.
  let last=end-1;
  while(last>=start&&(sample.bytes[last]!&0xc0)===0x80)last--;
  if(last>=start) {
    const lead=sample.bytes[last]!;
    const width=lead>=0xc2&&lead<=0xdf?2:lead>=0xe0&&lead<=0xef?3:lead>=0xf0&&lead<=0xf4?4:0;
    if(sample.end<byteLength&&width>0&&end-last<width)end=last;
  }
  try {
    const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(sample.bytes.subarray(start,end));
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))return undefined;
    return {start:sample.start+start,end:sample.start+end,text};
  } catch {return undefined;}
}
function sampledTextPreview(samples:readonly FileSample[],byteLength:number,sha256:string,remaining:number):SubmissionContent {
  const decoded=samples.map(sample=>utf8Sample(sample,byteLength));
  if(decoded.some(sample=>sample===undefined))return submissionIndex("FILE_TOO_LARGE");
  const content=[`[PARTIAL FILE PREVIEW: ${byteLength} bytes; sha256=${sha256}. Only the byte ranges below were included; omitted content was not evaluated. Offsets are zero-based, end-exclusive.]`,...decoded.map(sample=>`[bytes ${sample!.start}..${sample!.end})\n${sample!.text}`)].join("\n\n");
  const cost=Buffer.byteLength(JSON.stringify(content),"utf8");
  if(cost>Math.max(0,remaining))return submissionIndex("CASE_CONTENT_BUDGET");
  return {representation:"TEXT",content,contentTruncated:true,contentOmittedReason:"FILE_TOO_LARGE",evaluationScope:"CONTENT",consumedBytes:cost};
}
/** Large originals are archived separately; this function never loads the full file into memory. */
export async function submissionFilePreview(sourcePath:string,sourceRoot:string,portablePath:string,remainingBytes:number,maxSourceBytes=4*1024*1024*1024):Promise<{preview:SubmissionContent;sha256?:string;byteLength?:number}> {
  if(!safeTextExtension(portablePath))return {preview:submissionIndex("ARCHIVE_LIMIT")};
  const window=previewWindow(remainingBytes);
  if(window===0)return {preview:submissionIndex("CASE_CONTENT_BUDGET")};
  try {
    const sampled=await sampleFileWithDigest(sourcePath,sourceRoot,maxSourceBytes,window);
    return {preview:sampledTextPreview(sampled.samples,sampled.source.byteLength,sampled.source.sha256,remainingBytes),sha256:sampled.source.sha256,byteLength:sampled.source.byteLength};
  } catch(error) {
    if(error instanceof Error && error.message==="FILE_PREVIEW_SIZE_LIMIT")return {preview:submissionIndex("ARCHIVE_LIMIT")};
    throw error;
  }
}
