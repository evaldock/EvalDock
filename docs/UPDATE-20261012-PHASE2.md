# Evaluation efficiency update — 2026-10-12

## Plan

1. Check serialized Judge input size before dispatch; pool repeated evidence losslessly without dropping rubric text or evidence IDs.
2. Re-score verified archived Trace in a separate revision with original mode and grading references; keep baseline reports intact.
3. Freeze and copy large public dataset inputs with bounded memory and SHA-256 verification in DSH and shared adapters.

## Judge input

`EVALDOCK_JUDGE_MAX_INPUT_BYTES` defaults to 1 MiB of serialized request body. It includes shared context, rubric, output limit and model fields. It is not an exact tokenizer estimate. Long repeated strings use an explicit path dictionary that reconstructs the original JSON. Oversized requests fail before dispatch and incur no model call. See [Judge configuration](JUDGE-COST.md).

## Score revisions

`pnpm rescore --report <case-report>` reuses verified archived evidence. Updated rubrics and individual-label selection are optional. Source report and Trace digests are checked before grading and again before publication. The command creates independent JSON / HTML results and request journals; it does not promote a revision into workbench totals. See [re-scoring](RESCORE.md).

## Dataset inputs

Public input files larger than 256 KiB are represented in Case and Plan records by portable paths and hashes, not Base64 bodies. A controller-only binding holds the actual source path. Files are scanned and copied in 64 KiB chunks into an independent workspace file. Source changes, quota violations and unbound/deserialized file seeds fail closed; failed copies remove partial files. Small inputs keep the existing inline format.

`EVALDOCK_MAX_DATASET_INPUT_BYTES` defaults to 1 GiB **per input file**, independent of the existing 64 MiB artifact limit. It is supported by the DSH configuration and shared adapter process environment. This bounds preparation memory for each file, not total disk usage, metadata size or provider-specific chat attachment uploads. A persisted file seed cannot be replayed without loading the Case again to establish its source binding.

## 中文说明

- Judge 发送前检查实际请求字节数，并对重复长文本做无损合并；超限不会调用模型。字节上限不等于模型 token 上限。
- 历史重评生成独立版本，可更换评分标准或只重评一个标签；原报告、执行记录和工作台汇总不变。
- 大于 256 KiB 的公开输入改为记录路径与摘要，按 64 KiB 分块校验和复制。默认单文件上限 1 GiB，可用 `EVALDOCK_MAX_DATASET_INPUT_BYTES` 调整；原有交付物归档限额不变。

## Validation

Use synthetic files and mocked Judge responses. Verify byte-exact decompression, UTF-8 request boundaries, no dispatch on budget failures, EFFECT evidence separation, immutable score baselines, corrupted archives, changed inputs, quota enforcement and both workspace preparation paths. Then run `pnpm run verify`. No paid model call or server deployment is part of this update.

## Verification outcome

`pnpm run verify` passes: 168 contract tests, 5 workbench tests and 5 import tests, plus type checks, build and publication-boundary checks. The added tests include a 101 MiB synthetic input through both preparation paths, exact wire-byte budget boundaries and source mutation during re-scoring. All Judge responses are mocked; no real cache savings or scoring equivalence is claimed.
