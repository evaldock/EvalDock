export function prepareConfig(config,runtime){return {...config,root:runtime.workspacePath,maxFileBytes:runtime.maxFileBytes,formal:true,attemptId:runtime.attemptId};}
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { observation } from "../../lib/core.mjs";

export const capabilities = ["FILE_DIGEST", "FILE_TYPE", "READ_ERRORS", "SYMLINK_NO_FOLLOW", "SHA256", "READ_ONLY", "SYMLINK_BOUNDARY"];

async function scan(root, current, entries, errors, maxFileBytes) {
  let children;
  try {
    children = await readdir(current, { withFileTypes: true });
  } catch {
    errors.push("FILESYSTEM_LIST_FAILED");
    return;
  }
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, child.name);
    const portablePath = path.relative(root, absolute).split(path.sep).join("/");
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        entries.push({ portablePath, type: "SYMLINK", target: await readlink(absolute) });
      } else if (info.isDirectory()) {
        entries.push({ portablePath, type: "DIRECTORY", mode: info.mode & 0o777 });
        await scan(root, absolute, entries, errors, maxFileBytes);
      } else if (info.isFile()) {
        if (info.size > maxFileBytes) {
          entries.push({ portablePath, type: "FILE", byteLength: info.size, digest: null });
          errors.push("FILESYSTEM_FILE_TOO_LARGE");
        } else {
          const bytes = await readFile(absolute);
          entries.push({ portablePath, type: "FILE", byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), mode: info.mode & 0o777 });
        }
      } else {
        entries.push({ portablePath, type: "OTHER" });
      }
    } catch {
      errors.push("FILESYSTEM_READ_FAILED");
    }
  }
}

export async function capture({ phase, config }) {
  if (config.formal === true) {
    const { captureFileSnapshot } = await import("../../../dist/observer-lab/adapters/filesystem/sensor.js");
    const snapshot = await captureFileSnapshot({
      snapshotId: "snapshot.observer", attemptId: config.attemptId,
      phase: phase === "BEFORE" ? "BEFORE" : "AFTER",
      rootPath: config.root, rootBinding: "attempt.workspace",
      maxFileBytes: config.maxFileBytes ?? 1048576,
    });
    return observation("filesystem", phase, { root: config.root, entries: snapshot.entries },
      snapshot.readErrors.map((item) => item.reasonCode),
      snapshot.scanStartedAt, snapshot.scanCompletedAt, capabilities);
  }
  const startedAt = new Date().toISOString();
  const root = path.resolve(config.root ?? "/tmp/evaldock-observer-lab/workspace");
  const entries = [];
  const errors = [];
  await scan(root, root, entries, errors, config.maxFileBytes ?? 1024 * 1024);
  return observation("filesystem", phase, { root, entries }, errors, startedAt, new Date().toISOString(), capabilities);
}
