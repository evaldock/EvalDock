import path from "node:path";
import { command, lines, observation, safeError } from "../../lib/core.mjs";

export const capabilities = ["FRONTMOST_APPLICATION", "SCREENSHOT", "VISIBLE_APPLICATIONS", "WINDOW_TITLES"];

export async function capture({ phase, config, outputDirectory }) {
  const startedAt = new Date().toISOString();
  const errors = [];
  const visible = await command("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of every application process whose visible is true']);
  if (!visible.ok) errors.push(safeError("desktop", visible.reasonCode));
  const frontmost = await command("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
  if (!frontmost.ok) errors.push(safeError("desktop-frontmost", frontmost.reasonCode));
  let windowTitles = [];
  if (config.windowTitles === true) {
    const windows = await command("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of every window of every application process whose visible is true']);
    if (windows.ok) windowTitles = windows.stdout.split(", ").filter(Boolean).sort();
    else errors.push("DESKTOP_WINDOW_ACCESS_UNAVAILABLE");
  }
  let screenshot;
  if (config.screenshot === true) {
    screenshot = path.join(outputDirectory, `desktop-${phase.toLowerCase()}.png`);
    const shot = await command("/usr/sbin/screencapture", ["-x", screenshot], { timeoutMs: 10_000 });
    if (!shot.ok) {
      screenshot = undefined;
      errors.push("DESKTOP_SCREEN_CAPTURE_UNAVAILABLE");
    }
  }
  const state = {
    visibleApplications: visible.ok ? visible.stdout.split(", ").filter(Boolean).sort() : [],
    frontmostApplication: frontmost.ok ? frontmost.stdout : null,
    windowTitles,
    ...(screenshot === undefined ? {} : { screenshot }),
  };
  const capturedCapabilities = [];
  if (visible.ok) capturedCapabilities.push("VISIBLE_APPLICATIONS");
  if (frontmost.ok) capturedCapabilities.push("FRONTMOST_APPLICATION");
  if (config.windowTitles === true && !errors.includes("DESKTOP_WINDOW_ACCESS_UNAVAILABLE")) capturedCapabilities.push("WINDOW_TITLES");
  if (screenshot !== undefined) capturedCapabilities.push("SCREENSHOT");
  return observation("desktop", phase, state, errors, startedAt, new Date().toISOString(), capabilities, {
    status: errors.length === 0 ? "COMPLETE" : "PARTIAL",
    capturedCapabilities,
  });
}
