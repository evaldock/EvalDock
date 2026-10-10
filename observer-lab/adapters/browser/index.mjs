import { command, observation } from "../../lib/core.mjs";

export const capabilities = ["ACTIVE_URL", "BROWSER_RUNNING", "TAB_TITLES", "TAB_URLS"];

async function browserTabs(application) {
  const titleGetter = application === "Safari" ? "tab.name()" : "tab.title()";
  const script = [
    `const browser = Application(${JSON.stringify(application)});`,
    "const rows = [];",
    "browser.windows().forEach((window, windowIndex) => {",
    "  window.tabs().forEach((tab, tabIndex) => rows.push({",
    "    windowIndex, tabIndex,",
    `    title: ${titleGetter},`,
    "    url: tab.url()",
    "  }));",
    "});",
    "JSON.stringify(rows);",
  ].join("\n");
  return command("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
}

export async function capture({ phase, config }) {
  const startedAt = new Date().toISOString();
  const errors = [];
  const browsers = [];
  const capturedCapabilities = ["BROWSER_RUNNING"];
  let runningCount = 0;
  let tabCaptureCount = 0;
  for (const browser of config.applications ?? ["Google Chrome", "Safari"]) {
    const running = await command("/usr/bin/pgrep", ["-x", browser]);
    const item = { name: browser, running: running.ok };
    if (running.ok) runningCount += 1;
    if (running.ok && config.appleEvents === true) {
      const tabs = await browserTabs(browser);
      if (tabs.ok) {
        try {
          item.tabs = JSON.parse(tabs.stdout);
          tabCaptureCount += 1;
        } catch {
          errors.push(`BROWSER_${browser.replaceAll(/\W/gu, "_").toUpperCase()}_TAB_PARSE_FAILED`);
        }
      } else errors.push(`BROWSER_${browser.replaceAll(/\W/gu, "_").toUpperCase()}_TAB_ACCESS_UNAVAILABLE`);
    }
    browsers.push(item);
  }
  if (config.appleEvents !== true) errors.push("BROWSER_TAB_CAPTURE_DISABLED_BY_CONFIG");
  if (tabCaptureCount > 0) capturedCapabilities.push("ACTIVE_URL", "TAB_TITLES", "TAB_URLS");
  const status = runningCount === 0 ? "IDLE" : errors.length === 0 ? "COMPLETE" : "PARTIAL";
  const reasonCodes = runningCount === 0 ? ["BROWSER_NO_ACTIVE_TARGET"] : errors;
  return observation("browser", phase, { browsers }, errors, startedAt, new Date().toISOString(), capabilities, {
    status,
    capturedCapabilities,
    reasonCodes,
  });
}
