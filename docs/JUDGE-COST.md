# Judge requests and token usage

[English](#english) · [简体中文](#简体中文)

## English

The default Judge scores up to four labels from the same Case in one request. It sends the complete shared evidence once, followed by each label's role, instructions and scoring standard. Each result keeps its own score, reason and evidence citations. Different Cases, evidence contents and evaluation modes are never grouped. `EFFECT` still exposes only delivery evidence.

Shared instructions and evidence precede changing label rubrics, so subsequent requests with an identical prefix can reuse the provider's cache. [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) is automatic; EvalDock does not create a local KV cache or force a cache hit. Concurrent cold requests may all miss. Batching reduces repeated evidence; concurrency primarily reduces waiting time.

Configure these environment variables on the process that launches evaluation:

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVALDOCK_JUDGE_BATCH_SIZE` | `4` | Labels per request, from 1 to 8. Set 1 for individual-label scoring. |
| `EVALDOCK_JUDGE_MAX_INPUT_BYTES` | `1048576` | Maximum serialized HTTP request body after lossless pooling; a byte limit, not a model token limit. |
| `EVALDOCK_JUDGE_MAX_OUTPUT_TOKENS` | `16384` | Maximum output tokens per request; choose a value supported by the model. |
| `EVALDOCK_JUDGE_TIMEOUT_MS` | `240000` | Per-request timeout, starting after the concurrency queue. |

Repeated long strings in shared evidence are pooled once with explicit JSON paths; the original JSON can be reconstructed without changing evidence IDs or rubrics. The exact serialized request is checked before journaling or dispatch. `JUDGE_INPUT_TOO_LARGE` sends no request and is not retried. Diagnostics record original bytes, saved bytes and the limit. This does not guarantee a provider context fit: tokenizer and output-token limits still apply. [Re-score archived evidence](RESCORE.md) after adjusting a budget or rubric.

At most four physical requests run concurrently **per process**, including separate Case Judge instances. Separate CLI processes have separate limits. No evidence is truncated by this optimization. If a group exceeds the provider's context limit, it remains an error; there is no automatic, potentially costly single-label fallback. Reduce the batch size before a deliberate rerun. Missing or malformed results affect the relevant labels; invalid whole responses affect the whole group.

`score.diagnostics.requests` records a UUID, label IDs, request bytes and provider usage for each physical attempt. The report counts each UUID once, even when several labels reference it. Input tokens already include cached input tokens. Missing usage remains unknown; totals of known usage and incomplete-request counts are displayed separately. Existing transient retries (up to three attempts) remain enabled and are counted; a network timeout may still have incurred provider charges. Usage summaries exclude payloads. A separate owner-only request journal stores the exact request body and public response, including private grading references when supplied; it excludes authorization headers, provider thinking fields and raw provider errors. Keep this journal private.

The journal is written before dispatch and immediately after receiving the public response, before parsing scores. A `STARTED` record after a crash means dispatch or billing may be unknown. An audit write failure stops further calls on that Judge instance and does not trigger an automatic retry. Use the provider's billing records for final charges. Historical and custom Judge scores without usage remain untracked. Batching can change model judgments: compare the same traces and rubrics in batch and individual modes before relying on score equivalence. Offline regression tests verify request sharing, identity, evidence boundaries and accounting; they do not establish real cache hit rates or scoring equivalence.

## 简体中文

默认同一道题每 4 个标签共用一次请求：先发送一份完整证据，再附上各标签的角色、指令与评分标准。每个标签分别返回分数、理由和证据引用。不同题目、不同证据、不同评测模式不会混合；`EFFECT` 仍只提供交付证据。

共享内容放在提示词前部，便于后续请求命中模型服务的前缀缓存。[DeepSeek 缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)默认开启，EvalDock 不在本地实现 KV Cache，也不能保证命中。并发的首次请求可能全部未命中；合并标签减少重复输入，并发主要减少等待。

在启动评测的进程中设置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `EVALDOCK_JUDGE_BATCH_SIZE` | `4` | 每次请求 1–8 个标签；设为 1 恢复逐标签请求。 |
| `EVALDOCK_JUDGE_MAX_INPUT_BYTES` | `1048576` | 无损压缩后 HTTP 请求正文的字节上限，不是模型 token 上限。 |
| `EVALDOCK_JUDGE_MAX_OUTPUT_TOKENS` | `16384` | 每次请求的输出上限，需符合所用模型限制。 |
| `EVALDOCK_JUDGE_TIMEOUT_MS` | `240000` | 单次请求超时毫秒数，从结束并发排队后开始计算。 |

共享证据中重复的长文本只保存一份，通过明确的 JSON 路径还原；证据 ID 和评分标准不变。发送和记录请求前检查实际序列化大小，超限返回 `JUDGE_INPUT_TOO_LARGE`，不调用、不重试。诊断保留原始大小、节省字节数和上限。这不是精确 token 预算，仍需符合服务商的上下文与输出限制。调整预算或标准后可[重评历史证据](RESCORE.md)。

每个进程最多同时发送 4 次请求；多题共用此限制，不同 CLI 进程分别计数。这次优化不截断证据。超过模型上下文限制会保留错误，不自动拆成逐标签请求重跑。可降低分组大小后主动复测。单个标签缺失、重复或引用无效时保留该标签错误，整份响应无效时整组报错。

评分记录中的 `diagnostics.requests` 保存实际请求 ID、覆盖标签、请求字节数和服务商返回的用量。报告按请求 ID 去重，并计入已有的瞬时故障重试（最多 3 次）。缓存命中 token 已包含在输入 token 内；未知用量不当作零。网络超时可能已经产生费用，报告会单列用量不完整的请求。用量摘要不保存正文。独立请求日志保存原始请求正文和公开评分响应，可能包含私有评分参考；目录仅属主可访问，不包含认证头、模型思考字段或服务商错误原文。请勿公开上传该日志。

请求发送前先落盘，收到公开响应后在解析评分前再次落盘。异常退出后只有 `STARTED` 的记录表示请求或计费状态待确认；日志写入失败会阻止该 Judge 实例继续调用，且不会自动重试。最终费用以服务商账单为准。旧记录和未提供用量的自定义 Judge 标为未跟踪。多标签请求可能改变模型判断，正式比较前应使用相同 Trace 和标准对照逐标签模式。离线回归只验证请求、证据边界与统计，不代表真实命中率或评分完全一致。

### Journal locations / 日志位置

- DSH Case: `cases/<case>/judge/requests/<request-id>.json` in the exported result bundle.
- Shared adapters: `runs/<run>/judge/requests/<request-id>.json`.
- Standalone default Judge: `var/judge-requests/`; override with `EVALDOCK_JUDGE_AUDIT_ROOT`.
- Embedded `OpenAiCompatibleLabelJudge` callers opt in with `auditDirectory` or `requestAudit`.

A stored public response can be inspected and reparsed without sending it to the provider again; this release does not add a replay button. / 可检查已保存的公开响应并重新解析，无需再次请求模型；本版尚未增加重放按钮。
