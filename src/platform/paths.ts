import path from "node:path";
/** Persistent outputs, transient execution, UI state and diagnostics have separate owners. */
export function projectPaths(root: string) {
  const base = path.resolve(root, "var");
  return Object.freeze({
    results: path.join(base, "evaluation-results"),
    runtime: path.join(base, "batch-runtime"),
    workbench: path.join(base, "workbench"),
    logs: path.join(base, "logs"),
  });
}
