# Re-score an archived Case / 历史 Trace 重评

## English

Build the source (`pnpm build`), then point the command at a **Case** `report.json` with its `all-trace/` and `output/` files intact:

```sh
pnpm rescore --report /path/to/case/report.json
pnpm rescore --report /path/to/case/report.json --revision rubric-v2 --labels labels
pnpm rescore --report /path/to/case/report.json --label label.tool.code/v1
```

Use an actual label ID from the archived report. `--labels` loads updated rubric files for those same IDs; without it, the original frozen rubrics are reused. `--label` scores only that dimension. A revision ID must be new. No Agent is launched and no dataset input is reloaded. The original `FULL` / `EFFECT` mode and grading references remain fixed. Missing private references remain unassessable; this command does not supply them.

Each invocation writes `score-revisions/<revision>/` beside the source report:

- `started.json`: source report, Case and Trace digests, selected rubrics and previous rubric digests.
- `judge/requests/`: private request/response audit records for the default Judge.
- `report.json` and `report.html`: the new scores, explanations, model names and dimensions.
- `failure.json`: interrupted or failed revisions; it is not a valid completed result.

The original result and workbench totals are **not replaced**. Open the revision's HTML directly to compare it with the baseline. Unknown labels, invalid digests, mismatched scopes or missing evaluation mode stop before a model call. Source files are checked again before publishing the revision. Individual Judge errors are retained as `SCORING_ERROR`; they are not zero scores. If the process exits abruptly, a started-only revision is incomplete.

Re-scoring sends **new, potentially billable Judge requests**. It is not replay of a saved provider response. Configure the same Judge environment as normal evaluation; the CLI also reads the evaluator's `models.env`. Check request journals before retrying interrupted work. Keep the entire result directory private when it contains grading references. Archives larger than the existing 20 MiB verified-read budget are rejected.

## 简体中文

先执行 `pnpm build`。命令中的路径指向单道 Case 的 `report.json`，旁边的 `all-trace/`、`output/` 必须完整保留。上面的三条命令分别对应：沿用原标准重评、使用指定目录的新标准重评、只重评一个标签。标签 ID 以原报告为准，版本名称不可重复。

重评复用原始证据、评分参考和 `FULL` / `EFFECT` 模式，不启动 Agent，也不重新加载题库。更新标准时仍使用原报告中的标签 ID；缺少私有参考的题目仍不可评分。

新结果放在原报告旁的 `score-revisions/<版本>/`，包含输入摘要、评分标准、请求日志，以及新的 JSON / HTML 报告。原报告和工作台汇总不会被替换，可直接打开新版 HTML 对照。未知标签、摘要不匹配、范围不一致或缺少评测模式时，在请求模型前报错；评分结束后还会复核源文件。单个标签调用失败保留 `SCORING_ERROR`，不算零分。只有 `started.json` 或存在 `failure.json` 的版本不能视为完成。

这是重新请求 Judge，会产生新的模型费用，并非重放旧响应。沿用现有 Judge 环境变量及 `models.env` 配置；中断后请先查看请求日志再重试。包含私有评分参考的结果目录请勿公开。归档验证沿用 20 MiB 读取预算，超限拒绝处理。
