import { command, lines, observation } from "../../lib/core.mjs";

export const capabilities = ["ESTABLISHED_CONNECTIONS", "LISTENING_PORTS", "TCP_ENDPOINTS", "UDP_ENDPOINTS"];

function parseLsof(stdout) {
  return lines(stdout).slice(1).map((line) => {
    const fields = line.split(/\s+/u);
    return { command: fields[0] ?? "", pid: Number(fields[1] ?? 0), user: fields[2] ?? "", endpoint: fields.at(-1) ?? "" };
  }).filter((item) => Number.isSafeInteger(item.pid)).sort((a, b) => a.pid - b.pid || a.endpoint.localeCompare(b.endpoint));
}

export async function capture({ phase, config }) {
  const startedAt = new Date().toISOString();
  const errors = [];
  const lsof = config.lsofPath ?? "/usr/sbin/lsof";
  const listeners = await command(lsof, ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  const listenersEmpty = !listeners.ok && listeners.stdout === "" && listeners.stderr === "";
  if (!listeners.ok && !listenersEmpty) errors.push("NETWORK_LISTENER_CAPTURE_FAILED");
  let established = { ok: true, stdout: "" };
  if (config.includeEstablished === true) {
    established = await command(lsof, ["-nP", "-iTCP", "-sTCP:ESTABLISHED"]);
    const establishedEmpty = !established.ok && established.stdout === "" && established.stderr === "";
    if (!established.ok && !establishedEmpty) errors.push("NETWORK_CONNECTION_CAPTURE_FAILED");
  }
  const udp = await command(lsof, ["-nP", "-iUDP"]);
  const udpEmpty = !udp.ok && udp.stdout === "" && udp.stderr === "";
  if (!udp.ok && !udpEmpty) errors.push("NETWORK_UDP_CAPTURE_FAILED");
  const capturedCapabilities = [];
  if (listeners.ok || listenersEmpty) capturedCapabilities.push("LISTENING_PORTS", "TCP_ENDPOINTS");
  if (config.includeEstablished === true && established.ok) capturedCapabilities.push("ESTABLISHED_CONNECTIONS");
  if (udp.ok || udpEmpty) capturedCapabilities.push("UDP_ENDPOINTS");
  return observation("network", phase, {
    listeners: listeners.ok ? parseLsof(listeners.stdout) : [],
    established: established.ok ? parseLsof(established.stdout) : [],
    udp: udp.ok ? parseLsof(udp.stdout) : [],
  }, errors, startedAt, new Date().toISOString(), capabilities, {
    status: errors.length === 0 ? "COMPLETE" : "PARTIAL",
    capturedCapabilities,
  });
}
