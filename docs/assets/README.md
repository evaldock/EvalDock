# README 品牌资源

- `evaldock-logo.png`：复用 EvalDock 官网原始小马头与文字组合标志，未重绘或裁切。来源：https://www.evaldock.ai/brand-horizontal-pony.png?v=20260919-pony1 （获取于 2026-09-28）。
- `evaldock-banner.svg`：可编辑的 README 横幅，内嵌上述原始 Logo。
- `evaldock-banner.png`：横幅的浏览器渲染版本，供 GitHub README 展示，保证字体与 Logo 显示一致。

配色与官网保持一致：主色 `#5b5bd6`，页面底色 `#f8f8ff`，主文字 `#1c2024`，次级文字 `#60646c`，描边 `#d5d5ef`。

品牌资源不代表对第三方授予商标权。

## 评测流程图

- `evaluation-workflow.png`：用户于 2026-09-28 提供的流程示意图，按原图收录。图中以 DSH 为例，串行执行、示例标签及评分汇总不作为当前实现的配置承诺；README 配有当前行为说明。

## 第三方 Agent 图标

- `agents/codex.png`：来自 [Lobe Icons 的 Codex 图标](https://github.com/lobehub/lobe-icons/blob/master/packages/static-png/light/codex-color.png)，原图保存。此文件来自第三方图标库，并非从 OpenAI 官方素材包下载；上游 MIT 许可见 `agents/lobe-icons-LICENSE`。
- `agents/claude.png`：来自 [Claude Code 官网](https://www.claude.com/product/claude-code) 使用的[官方图标资源](https://assets.claude.com/95a868946ac8a31e5ff832e2899f294aa368b836.png?w=32&h=32)，原图保存。

获取日期：2026-09-28。图标仅用于标识对应产品；商标归各自所有者所有，不表示官方合作或背书。

## V2 方案配图

- `tag-execution-graph.png`：用户于 2026-10-13 提供的执行图截图，原图收录，用于 V2 方向展示；不表示公开版已接入 TAG，也不作为评分有效性的验证结果。

- `small-sample-evaluation.png`：用户于 2026-10-13 提供的小样本评测概念图，原图收录；其中曲线为方案示意，不代表实测估计精度。

## 数据集覆盖图（2026-10-14）

- `dataset-coverage.png` / `dataset-coverage.zh-CN.png`：根据用户提供的覆盖图及其可编辑源数据重新绘制的英文、中文版本，去除图内说明小字；同名 SVG 保留矢量版本。
- `dataset-coverage.json`：只包含分类、系列和汇总数量，不包含题目、私有参考或运行记录；来源数据逐条去重核对为 144 个条目、1,658 道题后导出汇总。
- `scripts/render-dataset-coverage.py`：使用 matplotlib 与中文字体重新生成两种语言的 PNG / SVG；可通过 `EVALDOCK_CJK_FONT` 指定字体。
- 图示是开发题库覆盖快照，与公开 BenchDock 下载包数量口径不同；星标突出代表性基准，跨类别数量不可相加，也不代表已完成真实运行或评分验证。
