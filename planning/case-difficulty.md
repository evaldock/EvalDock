# 题目难度标注

`case-difficulty.json` 定义整题难度的格式与判定原则，版本 1.0.0，状态 PROVISIONAL。公开框架的 `cases` 列表为空，不附带外部题库的难度记录。

每题记录 question ID、路径、原文件 SHA-256、难度与依据。题目内容变化后应复核难度。不根据 benchmark 名称、环境故障或 Agent 分数直接定级，也不代表同一题对每个标签的难度相同。

运行时按实际加载的题库核对标注；未标注或摘要不匹配时按 UNKNOWN 处理，详见[抽题规则](case-sampling.md)。难度用于分层选题，不改变 Judge 完成度评分或题目权重。
