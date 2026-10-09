# 评分标签

`labels/*.json` 是评分标准的唯一来源。`efficiency.cost`（`label.efficiency-cost/v1`）与其他维度并列，评价被测 Agent 完成本 Case 的 token 用量与使用时间。采用现有 LLM Judge、0–100 分量表，无固定 token/时间阈值或加权公式。

新增或导入数据集时，同时在所用题库 `catalog.md` 的 `labelIds` 添加 `label.efficiency-cost/v1`，在每题 `question.json` 的 `capabilityLabels` 添加 `efficiency-cost`；工作台目录快照使用规范名称 `efficiency.cost`。`tests/contracts/cost-label.test.mjs` 检查遗漏、重复、Planner 继承和评分模式边界。题库分发范围与数量见[题库说明](../datasets/README.md)。

仅使用同一份 all trace 中真实可见的消耗证据；不扩充 Probe、不更改 trace 格式。token 缺失不记为零，不用字符数或 trace 大小估算。只有一类证据时明确评分范围；两类都不足则 UNASSESSABLE。EFFECT 模式仍只暴露交付物，缺乏成本证据时不评分。无效分数沿用现有隐藏和聚合规则。

新标签随新评测冻结到报告。历史 Case、Trace 和评分不回填。每题新增一次常规 Judge 调用，评分阶段会相应增加模型请求与等待时间。

题库只使用本目录现行标签，不在导入过程中创建新的评分标签。数据集标签须覆盖题目标签。公开仓库的静态题目展示目录保持为空；运行时导入按[BenchDock 指南](../docs/BENCHDOCK.md)处理，不将真实题目或展示副本提交回仓库。修改标签或导入规则后，运行 `node --test tests/contracts/cost-label.test.mjs` 和 `pnpm run test:benchdock-import` 检查相关约束。

2026-09-24：现有 15 个标签的定义版本统一升级为 3.0.0，使用 0–100 量表。旧报告保留冻结的旧量表与标准摘要，不做追溯换算，不混合不同标准的成绩。满分按证据和适用要求判定，不设置满分频率配额。
