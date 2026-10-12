/** One durable record per physical model request, independent of logical labels/retries. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface JudgeRequestUsage {
  /** Provider prompt_tokens includes cache hits; do not add cacheHitTokens to it. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
}
export interface JudgeRequestAuditRecord {
  readonly schema: "evaldock.judge-request-audit/v1";
  readonly requestId: string;
  readonly status: "STARTED" | "RESPONSE_RECEIVED" | "FAILED";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly model: string;
  readonly labelIds: readonly string[];
  /** The JSON wire body only. Authorization headers and endpoint credentials are never included. */
  readonly request: { readonly body: object; readonly sha256: string; readonly byteLength: number };
  readonly billingStatus: "UNKNOWN" | "REPORTED_USAGE";
  readonly response?: {
    /** Public message.content only; no provider reasoning/thinking fields. */
    readonly content?: unknown;
    readonly usage: JudgeRequestUsage;
    readonly httpStatus: number;
    readonly finishReason?: string;
    readonly receivedAt: string;
  };
  readonly error?: { readonly code: string };
}
interface AuditDocument extends JudgeRequestAuditRecord {
  readonly events: readonly { readonly status: JudgeRequestAuditRecord["status"]; readonly at: string }[];
}
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
function validateRecord(record: JudgeRequestAuditRecord): void {
  if (record.schema !== "evaldock.judge-request-audit/v1" || !requestIdPattern.test(record.requestId) ||
      !["STARTED", "RESPONSE_RECEIVED", "FAILED"].includes(record.status) || !record.model ||
      !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.updatedAt)) ||
      !/^[0-9a-f]{64}$/.test(record.request.sha256) || !Number.isSafeInteger(record.request.byteLength) || record.request.byteLength < 0)
    throw new Error("JUDGE_AUDIT_RECORD_INVALID");
}
function identity(record: JudgeRequestAuditRecord): string {
  return JSON.stringify([record.requestId, record.startedAt, record.model, record.labelIds, record.request]);
}
function stripEvents(document: AuditDocument): JudgeRequestAuditRecord {
  const { events: _events, ...record } = document;
  return record;
}
/** Atomic, owner-only journal. A failed sink must abort the request rather than silently retry it. */
export function createJudgeRequestAuditSink(directory: string): (record: JudgeRequestAuditRecord) => Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("JUDGE_AUDIT_DIRECTORY_MUST_BE_ABSOLUTE");
  const queues = new Map<string, Promise<void>>();
  async function persist(record: JudgeRequestAuditRecord): Promise<void> {
    validateRecord(record);
    // Walk from the root so a symlink ancestor is rejected before creating children.
    const resolved=path.resolve(directory),root=path.parse(resolved).root;
    let current=root;
    for(const segment of path.relative(root,resolved).split(path.sep).filter(Boolean)) {
      current=path.join(current,segment);
      await mkdir(current,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="EEXIST")throw error;});
      const info=await lstat(current);
      if(!info.isDirectory() || info.isSymbolicLink())throw new Error("JUDGE_AUDIT_DIRECTORY_UNSAFE");
    }
    await chmod(directory, 0o700);
    const filename = path.join(directory, `${record.requestId}.json`);
    const lockPath = `${filename}.lock`;
    // Exclusive cross-process guard: never replace a different request's evidence.
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let temporary: string | undefined;
    try {
      let previous: AuditDocument | undefined;
      try {
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1) throw new Error("JUDGE_AUDIT_FILE_UNSAFE");
          previous = JSON.parse(await handle.readFile("utf8")) as AuditDocument;
        } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (previous) {
        validateRecord(previous);
        if (identity(previous) !== identity(record)) throw new Error("JUDGE_AUDIT_REQUEST_CONFLICT");
        if (JSON.stringify(stripEvents(previous)) === JSON.stringify(record)) return;
        if (previous.status === "FAILED" || record.status === "STARTED" ||
            (previous.status === "RESPONSE_RECEIVED" && record.status !== "FAILED"))
          throw new Error("JUDGE_AUDIT_STATE_CONFLICT");
        if (previous.response && JSON.stringify(previous.response) !== JSON.stringify(record.response))
          throw new Error("JUDGE_AUDIT_RESPONSE_CONFLICT");
      } else if (record.status !== "STARTED") throw new Error("JUDGE_AUDIT_START_MISSING");
      const document: AuditDocument = { ...record, events: [...(previous?.events ?? []), { status: record.status, at: record.updatedAt }] };
      temporary = path.join(directory, `.${record.requestId}.${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, filename); temporary = undefined;
      // Persist the directory entry as well as its content before allowing a provider request/score.
      const folder = await open(directory, constants.O_RDONLY);
      try { await folder.sync(); } finally { await folder.close(); }
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await lock.close(); await unlink(lockPath);
    }
  }
  return async record => {
    // Capture the caller's event immediately; later mutations cannot change already-audited bytes.
    const snapshot = JSON.parse(JSON.stringify(record)) as JudgeRequestAuditRecord;
    const prior = queues.get(snapshot.requestId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(() => persist(snapshot));
    queues.set(snapshot.requestId, current);
    try { await current; } finally { if (queues.get(snapshot.requestId) === current) queues.delete(snapshot.requestId); }
  };
}
export function judgeRequestBodyDigest(serialized: string): { sha256: string; byteLength: number } {
  return { sha256: sha256(serialized), byteLength: Buffer.byteLength(serialized, "utf8") };
}
