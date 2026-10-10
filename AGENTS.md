# Agent 工作指引

本文件适用于整个仓库。EvalDock 将 Agent 执行、证据采集和 Judge 评分分开；桌面应用复用现有评测服务与工作台能力。

## 开始修改前

- 桌面交互、工作空间、题库导入或打包：先读 [docs/MAC_APP.md](docs/MAC_APP.md)，再查看 `desktop/`、`workbench/` 和对应契约测试。
- Agent 接入、执行、取消或证据采集：先读 [adapters/README.md](adapters/README.md) 和相关 Agent 文档。适配器提供执行状态和证据，评分由 Judge 完成。
- 数据集导入或任务选择：先读 [datasets/README.md](datasets/README.md)；涉及 BenchDock 时再读 [docs/BENCHDOCK.md](docs/BENCHDOCK.md)。
- 评分或报告：先读 [labels/README.md](labels/README.md)，沿 `src/evaluation/` 和 `src/all-trace/` 检查评分与证据流转。
- 安装和发布：分别参考 [docs/NATIVE_SETUP.md](docs/NATIVE_SETUP.md) 和 [docs/RELEASE.md](docs/RELEASE.md)。运行命令和依赖版本以相应 `package.json` 为准。

## 必须保留的行为

- 私有评分参考仅供服务端 Judge 使用；被测 Agent 和前端只接收公开任务内容。
- 区分发现安装、接口检查通过、实际执行完成和评分完成。界面状态与报告必须来自真实记录。
- 保留 `UNASSESSABLE`、Judge 错误和有效零分的区别；历史报告保留原有量表，不混合不同标准的分数。
- 桌面升级保留用户配置、题库和评测结果。题库导入遵循现有校验、备份与失败恢复流程。
- 公共仓库及安装包只包含框架和明确的合成样例。真实题库、运行结果、密钥与个人绝对路径留在本地；发布边界由 `scripts/check-publication-boundary.mjs` 检查。
- 桌面资源暂存依赖 Git 跟踪的文件。新增运行资源时检查 `scripts/stage-desktop.mjs` 的收集规则，确认打包后资源可用。

## 本机与 Mac mini 虚拟机同步

- 本机 `app` 分支是桌面版开发源。完成本分支的代码或文档修改后，默认同步到 Mac mini 虚拟机的测试工作树；包括本文件及任务相关的未提交、新增和删除文件。工作树不会自动同步，仅拉取分支无法带上未提交改动。
- 使用已有 SSH 别名 `evaldock-mini-v15`，目标工作树为 `~/Projects/EvalDock-app`，分支为 `app`。连接配置以本机 `~/.ssh/config` 为准。
- 同步前检查两端分支、提交和工作区状态。远端有独立修改时先保留并核对差异，避免覆盖。虚拟机原目录 `~/Projects/EvalDock` 及其正在运行的工作台保留原状。
- 同步源码和必要文档；依赖及构建产物在虚拟机重新生成。保留远端用户配置、密钥、真实题库和评测结果，不用整目录镜像删除这些本地数据。
- 同步后核对提交及变更文件内容。依赖清单或锁文件变化时执行 `pnpm install --frozen-lockfile`，再按下节完成适用检查；桌面运行资源通过 `pnpm run desktop:prepare` 更新。
- 本机用于界面开发，虚拟机用于运行验证。真实 Agent 评测按当前任务范围启动；同步代码本身不自动启动评测。交付时说明同步目标、验证结果；连接失败时明确标记尚未同步。

## 验证与交付

- 每次完成代码修改后，执行适用检查并创建 Git commit；只提交本次任务相关的代码、测试和文档，保留其他未提交改动。交付时说明 commit ID、验证结果及未完成的检查。

- 修改源码后运行受影响的契约测试；直接运行 `tests/contracts/*.test.mjs` 前，确认 `pnpm run build` 已生成当前源码对应的产物。
- 代码变更完成后执行与 CI 一致的检查：`pnpm run verify` 和 `node --test workbench/lib/model-settings.test.mjs`。
- 桌面界面变更通过 `pnpm run desktop` 检查实际交互；打包变更按 `docs/MAC_APP.md` 验证生成的应用。
- 适配器变更还需在已配置的真实 Agent 环境验证执行、采集、评分与报告。环境缺失时明确说明未验证环节，离线测试通过不能作为真实运行验收。
- 仅文档变更检查链接、命令与 `git diff --check`；涉及公开内容时运行发布边界检查。
- 交付时说明行为变化、已完成的验证及剩余限制；用户可见行为改变时同步相应文档。
