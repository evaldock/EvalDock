/** Case input transport contract. No environment provisioning or grading checks. */
import { readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseInputFile } from "../datasets/loader.js";
export interface InputDeliveryReceipt {
  readonly status: "SUBMITTED" | "FAILED";
  readonly attachments: readonly { readonly portablePath:string; readonly attachmentId?:string }[];
  readonly reason?: string;
}
export async function prepareInputLaunch(home:string, inputs:readonly CaseInputFile[]) {
  const attachments=inputs.filter(input=>input.delivery==="chat-attachment");
  if(!attachments.length) return undefined;
  const manifestPath=path.join(home,"case-attachments.json");
  const runnerPath=path.join(home,"evaldock-input-runner.mjs");
  const patchPath=path.join(home,"case-input.patch.yml");
  const receiptPath=path.join(home,"input-delivery.json");
  await writeFile(manifestPath,JSON.stringify(attachments),{flag:"wx",mode:0o444});
  await writeFile(runnerPath,await readFile(fileURLToPath(new URL("./dsh-input-runner.js",import.meta.url))),{flag:"wx",mode:0o444});
  await writeFile(patchPath,"- id: headless-runner\n  disabled: true\n- insert:\n    - id: evaldock-input-runner\n      name: "+JSON.stringify(runnerPath)+"\n      inject: [headlessStartup, attachments]\n",{flag:"wx",mode:0o444});
  for(const file of [manifestPath,runnerPath,patchPath]) await chmod(file,0o444);
  return {manifestPath,patchPath,receiptPath};
}
