# 自动选题的难度比例与随机性

配置入口：`planning/case-sampling.json`。默认简单 EASY 20%、中等 MEDIUM 40%、困难 HARD 40%，这是题量比例，不是评分权重。

Planner 仍按 Agent 能力选择数据集和每集题量，并获得初版难度库存提示。随后 DSH 与其余 Agent 共用 `src/planning/case-sampling.ts`：在所选数据集及各集题量约束内尽可能满足目标比例，各档内随机无放回抽题，并打乱执行顺序。总量不能整除时按最大余数取整；相同余数随机打破平局。

每轮生成新随机种子。同一轮不重复，跨轮允许再次出现；相同题库、数据集配额及种子可复现选择。`plan.json` 保存实际 Case 索引、难度和 `caseSampling`，`run.json` 保存抽题统计，包括目标题数、实际题数、缺口、种子和难度版本。

题库不足或各集配额导致比例无法满足时，保留题量并从剩余可用题补齐，记录实际比例与警告。难度与 question.json 的 SHA-256 绑定，题目变化或未标注时标成 UNKNOWN 并记录警告，不推断为某档。

手动选择具体题目、ALL 模式和 DSH 单题/旧调试限量入口保留原行为。选题仅使用实际加载的题库。不修改 Judge 标准、评分权重或历史结果。以后调整比例也应同步检查 Planner 的库存提示。

验证命令：`node --test tests/contracts/difficulty-sampling.test.mjs`（先运行 `pnpm run build`）。离线测试不替代真实 Agent 验收。
