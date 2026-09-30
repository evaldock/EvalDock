#!/usr/bin/env node

/**
 * Fixture 功能：模拟 Attention + PyTorch 数据集需要的最小 DSH Headless 行为。
 * 它写入代码产物并产生 Probe Trace；故障行为由测试显式选择，结果始终标记为 Fixture。
 * 调用方：runtime/target.ts 以 `--profile fixture-attention -- <task>` 启动本文件。
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.length !== 4 || argv[0] !== "--profile" || argv[1] !== "fixture-attention" || argv[2] !== "--") {
  throw new Error("expected: --profile fixture-attention -- <task>");
}

const workspace = process.env.DSH_EVAL_WORKSPACE;
const probeOutput = process.env.DSH_EVAL_PROBE_OUTPUT;
const sourceRunId = process.env.DSH_EVAL_SOURCE_RUN_ID;
const behavior = process.env.EVALDOCK_FIXTURE_BEHAVIOR;
if (!workspace || !probeOutput || !sourceRunId || !behavior) {
  throw new Error("workspace, probe-output, source-run-id and fixture behavior are required");
}

await mkdir(path.dirname(probeOutput), { recursive: true });
const events = [];

async function emit(kind, data = {}) {
  const entry = {
    schema: "dsh-eval.probe/v1",
    runId: behavior === "foreign-probe-run" ? `${sourceRunId}-foreign` : sourceRunId,
    probeSeq: events.length,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, events.length)).toISOString(),
    monotonicNs: String(events.length * 1_000_000),
    pid: process.pid,
    kind,
    data,
  };
  events.push(entry);
  await appendFile(probeOutput, `${JSON.stringify(entry)}\n`, "utf8");
}

const attentionProgram = `import math
import torch

def scaled_dot_product_attention(query, key, value):
    scores = query @ key.transpose(-2, -1) / math.sqrt(query.size(-1))
    weights = torch.softmax(scores, dim=-1)
    return weights @ value

if __name__ == "__main__":
    torch.manual_seed(7)
    q = torch.randn(1, 2, 4)
    k = torch.randn(1, 2, 4)
    v = torch.randn(1, 2, 4)
    output = scaled_dot_product_attention(q, k, v)
    print(output.shape)
`;

const finalAnswer =
  "Attention 的核心是让每个 token 按相关性聚合其他 token 的信息；缩放点积先计算 QK^T，" +
  "再除以维度平方根并经过 softmax，最后对 V 加权求和。已在 output/attention.py 中实现并通过代码工具执行。";

await writeFile(probeOutput, "", "utf8");
await emit("probe/start", {
  outputPath: "probe/events.jsonl",
  contentMode: "DIGEST",
  captureDispatch: true,
  captureLogs: true,
  node: process.version,
  cwd: workspace,
});
await emit("session/event", {
  sessionId: "fixture-session",
  event: { seq: 0, type: "turn/start", data: { turn: 1 } },
});
await emit("session/event", {
  sessionId: "fixture-session",
  event: { seq: 1, type: "step/start", data: { turn: 1, step: 1 } },
});
await emit("session/event", {
  sessionId: "fixture-session",
  event: { seq: 2, type: "tool/call", data: { callId: "python-1", name: "python" } },
});

const artifactPath = path.join(workspace, "output", "attention.py");
if (behavior === "timeout" || behavior === "ignore-term-timeout") {
  if (behavior === "ignore-term-timeout") process.on("SIGTERM", () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 60_000));
} else if (behavior === "audit-launch-contract") {
  await writeFile(
    path.join(workspace, "output", "audit.json"),
    `${JSON.stringify({ argv, cwd: process.cwd(), environmentNames: Object.keys(process.env).sort() })}\n`,
    "utf8",
  );
} else if (behavior === "require-secret" || behavior === "leak-secret-probe") {
  if (process.env.MODEL_TEST_API_KEY !== "fixture-canary-secret-4e18d9") {
    throw new Error("expected the configured test Secret reference");
  }
  await writeFile(artifactPath, attentionProgram, "utf8");
  if (behavior === "leak-secret-probe") {
    await emit("runtime/log", { level: "error", message: process.env.MODEL_TEST_API_KEY });
  }
} else if (
  behavior === "attention-success" ||
  behavior === "tool-failed" ||
  behavior === "short-response" ||
  behavior === "missing-probe-stop" ||
  behavior === "foreign-probe-run" ||
  behavior === "nonzero-exit"
) {
  await writeFile(artifactPath, attentionProgram, "utf8");
} else if (behavior !== "missing-artifact") {
  throw new Error(`unknown fixture behavior: ${behavior}`);
}

await emit("session/event", {
  sessionId: "fixture-session",
  event: {
    seq: 3,
    type: "tool/result",
    data: {
      message: { source: { callId: "python-1" } },
      status: behavior === "tool-failed" ? "failed" : "completed",
    },
  },
});
await emit("session/event", {
  sessionId: "fixture-session",
  event: {
    seq: 4,
    type: "assistant/message",
    data: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: behavior === "short-response" ? "已完成。" : finalAnswer }],
      },
      usage: { outputTokens: behavior === "short-response" ? 4 : 120 },
    },
  },
});
await emit("session/event", {
  sessionId: "fixture-session",
  event: { seq: 5, type: "step/end", data: { turn: 1, step: 1 } },
});
await emit("session/event", {
  sessionId: "fixture-session",
  event: { seq: 6, type: "turn/end", data: { turn: 1 } },
});

if (behavior !== "missing-probe-stop") await emit("probe/stop");
if (behavior === "nonzero-exit") {
  process.stderr.write("fixture requested exit code 23\n");
  process.exitCode = 23;
}
