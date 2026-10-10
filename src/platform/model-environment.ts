import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

const modelSetting = /^EVALDOCK_(PLANNER|JUDGE)_(API_KEY|MODEL|MODEL_ENDPOINT|TIMEOUT_MS|MAX_RETRIES)$/u;

/** Evaluator credentials are separate from the target Agent's DSH environment. */
export async function loadModelEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  file = path.join(homedir(), ".config/evaldock/models.env"),
): Promise<void> {
  let contents: string;
  try { contents = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (modelSetting.test(key)) environment[key] ??= value;
  }
}

export function agentEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^EVALDOCK_(PLANNER|JUDGE)_/u.test(key)));
}
