/** Public dataset inputs are frozen by digest, then copied with bounded memory.
 * Host source paths are controller-only bindings; they never enter Case/Plan JSON.
 */
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const DEFAULT_MAX_DATASET_INPUT_BYTES = 1024 * 1024 * 1024;
export const INLINE_DATASET_INPUT_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;
export interface DatasetInputSource {
  readonly sourcePath: string;
  readonly publicRoot: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly maxBytes: number;
}
function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid dataset input byte limit");
}
async function openPublicInput(sourcePath: string, publicRoot: string): Promise<FileHandle> {
  const root = await realpath(publicRoot);
  const candidate = await realpath(sourcePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Dataset input resolves outside the public input directory");
  }
  const before = await lstat(sourcePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Dataset input must be a regular file");
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("Dataset input changed while opening");
    if (await realpath(sourcePath) !== candidate || await realpath(publicRoot) !== root) throw new Error("Dataset input changed while opening");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function scan(handle: FileHandle, maxBytes: number, writer?: FileHandle, collect = false): Promise<{ byteLength: number; sha256: string; bytes?: Buffer }> {
  validateLimit(maxBytes);
  const before = await handle.stat({ bigint: true });
  const size = Number(before.size);
  if (!before.isFile() || !Number.isSafeInteger(size) || size > maxBytes) throw new Error("Dataset input exceeds maxDatasetInputBytes");
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, size)));
  const small = collect && size <= INLINE_DATASET_INPUT_BYTES ? Buffer.allocUnsafe(size) : undefined;
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytesRead === 0) throw new Error("Dataset input changed while reading");
    const bytes = buffer.subarray(0, bytesRead);
    hash.update(bytes);
    small?.set(bytes, offset);
    if (writer) {
      let written = 0;
      while (written < bytesRead) {
        const result = await writer.write(bytes, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error("Dataset input copy made no progress");
        written += result.bytesWritten;
      }
    }
    offset += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error("Dataset input changed while reading");
  }
  return { byteLength: size, sha256: hash.digest("hex"), ...(small === undefined ? {} : { bytes: small }) };
}
export async function freezeDatasetInput(sourcePath: string, publicRoot: string, maxBytes = DEFAULT_MAX_DATASET_INPUT_BYTES): Promise<{ source: DatasetInputSource; inlineBytes?: Buffer }> {
  validateLimit(maxBytes);
  const handle = await openPublicInput(sourcePath, publicRoot);
  try {
    const frozen = await scan(handle, maxBytes, undefined, true);
    return { source: Object.freeze({ sourcePath, publicRoot, maxBytes, byteLength: frozen.byteLength, sha256: frozen.sha256 }), ...(frozen.bytes === undefined ? {} : { inlineBytes: frozen.bytes }) };
  } finally { await handle.close(); }
}
/** An exclusive physical copy; digest mismatch removes the partial destination. */
export async function copyDatasetInput(source: DatasetInputSource, destination: string, mode = 0o444): Promise<{ byteLength: number; sha256: string }> {
  validateLimit(source.maxBytes);
  const handle = await openPublicInput(source.sourcePath, source.publicRoot);
  let writer: FileHandle | undefined;
  let created = false;
  try {
    if (Number((await handle.stat()).size) !== source.byteLength) throw new Error("Dataset input changed after planning");
    writer = await open(destination, "wx", 0o600);
    created = true;
    const copied = await scan(handle, source.maxBytes, writer);
    if (copied.byteLength !== source.byteLength || copied.sha256 !== source.sha256) throw new Error("Dataset input digest changed after planning");
    await writer.sync();
    await writer.close(); writer = undefined;
    await chmod(destination, mode);
    return { byteLength: copied.byteLength, sha256: copied.sha256 };
  } catch (error) {
    await writer?.close(); writer = undefined;
    if (created) await unlink(destination).catch(() => undefined);
    throw error;
  } finally { await handle.close(); }
}
