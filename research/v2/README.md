# V2 reference modules

**Source snapshots only. Neither module is called by the public EvalDock application.**

These files were copied byte-for-byte from committed code in the development VM on 2026-10-13. They are outside the application's source tree and default TypeScript build. No CLI command, Agent adapter, workbench route, model call or asset-copy hook has been registered. Existing evaluation behavior is unchanged.

| Module | Source | Contents | Public integration |
| --- | --- | --- | --- |
| [Score estimator](score-estimator/) | `acae5a8411385b7bd3bf081ba781aa3f4cfa56b4` | Offline data validation, regularized 1PL mean-response model, selection, audit-based estimation, calibration and synthetic tests | Not connected to task selection, results export or scoring |
| [TAG](tag/) | `07016effcd00e03b7b2f823c337768fa7b0f44c5` | Trace graph construction, grouping, action-level Judge, graph UI assets and original contract tests | Not connected to CLI, adapters, workbench or reporting |

[manifest.json](manifest.json) records the original repository-relative paths, source commits and SHA-256 of every imported file. Source commits identify the internal snapshots; they are not links to commits in the public repository. No real datasets, trained model parameters, credentials or evaluation results are included.

## Reading the source

- **Small-sample estimation:** start with [model.mjs](score-estimator/tools/score-estimator/model.mjs), [policy.mjs](score-estimator/tools/score-estimator/policy.mjs) and the [original design notes](score-estimator/docs/SCORE_ESTIMATOR.md). This is an experimental continuous-score estimator, not a complete reproduction of tinyBenchmarks. Synthetic checks do not establish real Agent estimation accuracy.
- **TAG:** start with [graph.ts](tag/src/evaluation/tag/graph.ts), [judge.ts](tag/src/evaluation/tag/judge.ts) and [pipeline.ts](tag/src/evaluation/tag/pipeline.ts). The snapshot includes its existing five-dimensional action analysis. This supplementary analysis does not replace each Case's scoring criteria, and importing the source does not enable a new scoring mode.

## Deliberately unadapted

The snapshots preserve the internal repository layout inside each module directory. TAG's `AllTrace` type import, integration tests, test helpers and asset-copy script refer to surrounding internal code that is not duplicated here. Its HTML is a template, not a populated demo. The original copy script also refers to shared evaluation assets outside this snapshot. Do not wire these into the public build without a separate integration review.

The estimator's original notes mention internal `pnpm` aliases; those aliases do **not** exist in the public package. Its synthetic tests can be run explicitly from the snapshot directory, independently of normal EvalDock use:

```sh
cd research/v2/score-estimator
node --test tests/contracts/score-estimator.test.mjs
```

Default `pnpm run verify` checks snapshot integrity and isolation without executing either module. TAG's original integration tests are retained as reference, not included in the public test glob. No real model or Agent evaluation is part of this source import.

## 简体中文

这里保存两个模块的原始代码快照，**公开版运行时不会调用**。源码位于正式构建范围之外，没有注册 CLI、工作台入口、适配器或资源复制步骤。

- 小样本估计器：来自开发虚拟机中云朵工作树的已提交版本，包含离线估计、选题、校准和合成测试。尚未对接公开版题库、结果导出或评分流程；合成测试不代表真实 Agent 估计精度。
- TAG：来自开发虚拟机集成版本，包含执行图、分组、动作级 Judge 和页面资源。保留原有五维动作分析代码，但不替代 Case 原评分标准，也不启用新的评测模式。

原文件逐字节保留，来源路径与摘要记录在 `manifest.json`。内部依赖、导入路径、脚本及测试均未做公开版适配。原说明中的 pnpm 别名不适用于公开仓库；TAG 模板也不是可直接使用的完整演示。此目录不含真实题库、训练参数、凭据或评测结果。

## Import verification — 2026-10-13

- All 23 imported files match their recorded source commits byte-for-byte.
- Public `pnpm run verify`: 170 contract tests, 5 workbench tests and 5 import tests passed, including snapshot integrity and application isolation checks.
- Estimator: 24 original synthetic tests passed when invoked explicitly in its snapshot directory.
- TAG: source/assets inspected and hashes verified; original integration tests were not run because this import intentionally does not provide the internal integration. No TAG accuracy or real Agent results are claimed.
