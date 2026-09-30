import { changeEvent, observation } from "./core.mjs";

/** Capture all samples, emit only changes; health covers the entire observation window. */
export async function watchChanges({
  adapter, component, config, outputDirectory, scope = {}, requiredCapabilities = [],
  intervalMs = 250, durationMs, finalOnly = false, shouldStop = () => false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onReady = () => {}, onEvent = () => {},
}) {
  const openedAt = new Date().toISOString();
  const started = Date.now();
  const reasons = new Set();
  const captured = new Set();
  const missing = new Set();
  let previous;
  let captureCount = 0;
  let eventCount = 0;
  let degraded = false;
  let configuredSamples = 0;
  let idleSamples = 0;
  let lastStatus = "UNAVAILABLE";
  async function sample(phase) {
    const now = new Date().toISOString();
    let current;
    try {
      current = config.enabled === false
        ? observation(component, phase, {}, ["OBSERVER_DISABLED"], now, now, adapter.capabilities,
            { status: "NOT_CONFIGURED", capturedCapabilities: [] })
        : await adapter.capture({ phase, config, outputDirectory });
    } catch {
      current = observation(component, phase, {}, ["OBSERVER_CAPTURE_FAILED"], now,
        new Date().toISOString(), adapter.capabilities,
        { status: "UNAVAILABLE", capturedCapabilities: [] });
    }
    captureCount++;
    lastStatus = current.runtime?.status ?? current.completeness;
    const capabilities = current.runtime?.capturedCapabilities ?? [];
    capabilities.forEach((item) => captured.add(item));
    const absent = requiredCapabilities.filter((item) => !capabilities.includes(item));
    if (lastStatus !== "IDLE") absent.forEach((item) => missing.add(item));
    const errors = [...(current.errors ?? []), ...(current.runtime?.reasonCodes ?? [])];
    errors.forEach((item) => reasons.add(item));
    const available = !["NOT_CONFIGURED", "UNAVAILABLE"].includes(lastStatus);
    if (available) configuredSamples++;
    if (lastStatus === "IDLE") idleSamples++;
    if (!available || current.completeness !== "COMPLETE" ||
        (lastStatus !== "IDLE" && (absent.length > 0 || lastStatus === "PARTIAL"))) degraded = true;
    // Failed samples are not environmental deletions. Re-establish the baseline after a gap.
    const comparable = available && current.completeness === "COMPLETE";
    if (previous && comparable) {
      const event = changeEvent({ component, sequence: eventCount + 1,
        before: previous, after: current, intervalMs, scope });
      if (event) {
        eventCount++;
        await onEvent(event);
      }
    }
    previous = comparable ? current : undefined;
  }
  await sample("BEFORE");
  await onReady();
  while (!shouldStop() && (durationMs === undefined || Date.now() - started < durationMs)) {
    await sleep(intervalMs);
    if (shouldStop() || (durationMs !== undefined && Date.now() - started >= durationMs)) break;
    if (!finalOnly) await sample("ACTIVE");
  }
  // Always flush one final sample, including a stop arriving during sleep.
  await sample("AFTER");
  if (missing.size > 0) reasons.add("OBSERVER_CAPABILITIES_MISSING");
  const runtimeStatus = configuredSamples === 0 ? lastStatus
    : degraded ? "PARTIAL"
    : idleSamples === captureCount ? "IDLE" : "COMPLETE";
  return {
    schema: "evaldock.observer.runtime-status/v1", status: "COMPLETED", component, action: "watch",
    openedAt, closedAt: new Date().toISOString(), runtimeStatus, eventCount, captureCount,
    comparison: finalOnly ? "BEFORE_AFTER" : "POLLING",
    changeStatus: eventCount > 0 ? "CHANGED"
      : ["COMPLETE", "IDLE"].includes(runtimeStatus) ? "UNCHANGED" : "UNKNOWN",
    adapterCapabilities: [...adapter.capabilities].sort(),
    requiredCapabilities: [...requiredCapabilities].sort(),
    capturedCapabilities: [...captured].sort(), missingCapabilities: [...missing].sort(),
    reasonCodes: [...reasons].sort(),
  };
}
