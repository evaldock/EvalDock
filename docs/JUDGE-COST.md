# Judge requests and token usage

[English](#english) · [简体中文](#简体中文)

## English

The default Judge scores up to four labels from the same Case in one request. It sends the complete shared evidence once, followed by each label's role, instructions and scoring standard. Each result keeps its own score, reason and evidence citations. Different Cases, evidence contents and evaluation modes are never grouped. `EFFECT` still exposes only delivery evidence.

Shared instructions and evidence precede changing label rubrics, so subsequent requests with an identical prefix can reuse the provider's cache. [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) is automatic; EvalDock does not create a local KV cache or force a cache hit. Concurrent cold requests may all miss. Batching reduces repeated evidence; concurrency primarily reduces waiting time.

Configure these environment variables on the process that launches evaluation:

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVALDOCK_JUDGE_BATCH_SIZE` | `4` | Labels per request, from 1 to 8. Set 1 for individual-label scoring. |
| `EVALDOCK_JUDGE_MAX_OUTPUT_TOKENS` | `16384` | Maximum output tokens per request; choose a value supported by the model. |
| `EVALDOCK_JUDGE_TIMEOUT_MS` | `240000` | Per-request timeout, starting after the concurrency queue. |

At most four physical requests run concurrently **per process**, including separate Case Judge instances. Separate CLI processes have separate limits. No evidence is truncated by this optimization. If a group exceeds the provider's context limit, it remains an error; there is no automatic, potentially costly single-label fallback. Reduce the batch size before a deliberate rerun. Missing or malformed results affect the relevant labels; invalid whole responses affect the whole group.

`score.diagnostics.requests` records a UUID, label IDs, request bytes and provider usage for each physical attempt. The report counts each UUID once, even when several labels reference it. Input tokens already include cached input tokens. Missing usage remains unknown; totals of known usage and incomplete-request counts are displayed separately. Existing transient retries (up to three attempts) remain enabled and are counted; a network timeout may still have incurred provider charges. Payloads, API keys and provider error text are not added to usage records.

These records are saved with completed scoring results, not as a crash-proof billing journal. Use the provider's billing records for final charges. Historical and custom Judge scores without usage remain untracked. Batching can change model judgments: compare the same traces and rubrics in batch and individual modes before relying on score equivalence. Offline regression tests verify request sharing, identity, evidence boundaries and accounting; they do not establish real cache hit rates or scoring equivalence.

## 简体中文

默认同一道题每 4 个标签共用一次请求：先发送一份完整证据，再附上各标签的角色、指令与评分标准。每个标签分别返回分数、理由和证据引用。不同题目、不同证据、不同评测模式不会混合；`EFFECT` 仍只提供交付证据。

共享内容放在提示词前部，便于后续请求命中模型服务的前缀缓存。[DeepSeek 缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)默认开启，EvalDock 不在本地实现 KV Cache，也不能保证命中。并发的首次请求可能全部未命中；合并标签减少重复输入，并发主要减少等待。

在启动评测的进程中设置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `EVALDOCK_JUDGE_BATCH_SIZE` | `4` | 每次请求 1–8 个标签；设为 1 恢复逐标签请求。 |
| `EVALDOCK_JUDGE_MAX_OUTPUT_TOKENS` | `16384` | 每次请求的输出上限，需符合所用模型限制。 |
| `EVALDOCK_JUDGE_TIMEOUT_MS` | `240000` | 单次请求超时毫秒数，从结束并发排队后开始计算。 |

每个进程最多同时发送 4 次请求；多题共用此限制，不同 CLI 进程分别计数。这次优化不截断证据。超过模型上下文限制会保留错误，不自动拆成逐标签请求重跑。可降低分组大小后主动复测。单个标签缺失、重复或引用无效时保留该标签错误，整份响应无效时整组报错。

评分记录中的 `diagnostics.requests` 保存实际请求 ID、覆盖标签、请求字节数和服务商返回的用量。报告按请求 ID 去重，并计入已有的瞬时故障重试（最多 3 次）。缓存命中 token 已包含在输入 token 内；未知用量不当作零。网络超时可能已经产生费用，报告会单列用量不完整的请求。用量记录不保存请求正文、API Key 或服务商错误原文。

用量随评分结果落盘，进程异常退出前尚未保存的请求可能缺失，最终费用以服务商账单为准。旧记录和未提供用量的自定义 Judge 标为未跟踪。多标签请求可能改变模型判断，正式比较前应使用相同 Trace 和标准对照逐标签模式。离线回归只验证请求、证据边界与统计，不代表真实命中率或评分完全一致。
