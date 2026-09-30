# README 品牌资源

- `evaldock-logo.png`：复用 EvalDock 官网原始小马头与文字组合标志，未重绘或裁切。来源：https://www.evaldock.ai/brand-horizontal-pony.png?v=20260919-pony1 （获取于 2026-09-28）。
- `evaldock-banner.svg`：可编辑的 README 横幅，内嵌上述原始 Logo。
- `evaldock-banner.png`：横幅的浏览器渲染版本，供 GitHub README 展示，保证字体与 Logo 显示一致。

配色与官网保持一致：主色 `#5b5bd6`，页面底色 `#f8f8ff`，主文字 `#1c2024`，次级文字 `#60646c`，描边 `#d5d5ef`。

品牌资源不代表对第三方授予商标权。

## 工作台截图

- `workbench-console.png`：用户提供的 DSH 控制台截图，展示 Agent 导航、插件配置、预检和评测入口。

两张截图均于 2026-09-28 提供，按原图收录，未改写界面状态或评分。

## 评测流程图

- `evaluation-workflow.png`：用户于 2026-09-28 提供的流程示意图，按原图收录。图中以 DSH 为例，串行执行、示例标签及评分汇总不作为当前实现的配置承诺；README 配有当前行为说明。

## 评分结果截图

- `scoring-overview.png`：用户于 2026-09-28 提供的 Agent 能力分布截图，按原图收录，展示该批次 8 个评分维度、分数和有效 Case 数量；不代表所有 Agent 的统一成绩。

## 第三方 Agent 图标

- `agents/codex.png`：来自 [Lobe Icons 的 Codex 图标](https://github.com/lobehub/lobe-icons/blob/master/packages/static-png/light/codex-color.png)，原图保存。此文件来自第三方图标库，并非从 OpenAI 官方素材包下载；上游 MIT 许可见 `agents/lobe-icons-LICENSE`。
- `agents/claude.png`：来自 [Claude Code 官网](https://www.claude.com/product/claude-code) 使用的[官方图标资源](https://assets.claude.com/95a868946ac8a31e5ff832e2899f294aa368b836.png?w=32&h=32)，原图保存。

获取日期：2026-09-28。图标仅用于标识对应产品；商标归各自所有者所有，不表示官方合作或背书。

## 数据集覆盖图

- `dataset-coverage.png` / `dataset-coverage.zh-CN.png`：英文 / 中文版本，另有 SVG 和 PDF。
- 来源：用户于 2026-09-30 提供的双维度覆盖图及其 catalog 分类明细，共 144 个唯一目录条目、1,658 道题。替换此前 49 个来源、899 题的统计图。
- `dataset-coverage.json` 保存条目 ID、题量、能力与行业分类；`scripts/render-dataset-coverage.py` 生成图片。
- 能力依据 labelIds 归类，行业依据任务题材整理。同一条目可以跨类出现，分类题量不能相加；两个通用条目共 65 题仅归入能力分类。
- 题量为 catalog 声明值，不表示全部完成运行环境与 Judge 适配。星标表示选取的代表性基准；每卡超过六个系列时展示前五个及其余合计。

## 交流群

- `community/wechat-group.jpg`：用户提供的 EvalDock 微信交流群二维码，保留原图；有效期为 2026 年 10 月 6 日前。
