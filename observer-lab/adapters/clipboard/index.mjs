import { command, observation, sha256Text } from "../../lib/core.mjs";

export const capabilities = ["BYTE_LENGTH", "CONTENT_DIGEST", "READ_ONLY"];

export async function capture({ phase, config }) {
  const startedAt = new Date().toISOString();
  const result = await command("/usr/bin/pbpaste");
  const errors = result.ok ? [] : ["CLIPBOARD_READ_FAILED"];
  const state = result.ok ? {
    byteLength: Buffer.byteLength(result.stdout),
    sha256: sha256Text(result.stdout),
    ...(config.includeContent === true ? { content: result.stdout } : {}),
  } : { available: false };
  return observation("clipboard", phase, state, errors, startedAt, new Date().toISOString(), capabilities);
}
