import { readdir } from "node:fs/promises";
import path from "node:path";
import { command, lines, observation } from "../../lib/core.mjs";

export const capabilities = ["INSTALLED_APPLICATIONS", "RUNNING_APPLICATIONS", "APPLICATION_PATHS"];

async function applicationsAt(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.name.endsWith(".app") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => path.join(root, entry.name)).sort();
  } catch {
    return [];
  }
}

export async function capture({ phase, config }) {
  const startedAt = new Date().toISOString();
  const roots = (config.applicationRoots ?? ["/Applications", "/System/Applications"]).map((root) => root.replace(/^~(?=\/)/u, process.env.HOME ?? ""));
  const installed = (await Promise.all(roots.map(applicationsAt))).flat().sort();
  const ps = await command("/bin/ps", ["-axo", "pid=,uid=,comm="]);
  const running = ps.ok ? lines(ps.stdout)
    .filter((line) => line.includes(".app/Contents/MacOS/") || line.includes(".app/Contents/Frameworks/"))
    .sort() : [];
  return observation("application", phase, { installed, running }, ps.ok ? [] : ["APPLICATION_PROCESS_LIST_FAILED"], startedAt, new Date().toISOString(), capabilities);
}
