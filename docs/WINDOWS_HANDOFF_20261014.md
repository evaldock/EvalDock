# Windows 11 x64 基础适配任务卡

> 最新状态见 [2026-10-15 超时定位与交接](WINDOWS_TIMEOUT_INVESTIGATION_20261015.md)：Windows 10 限定检查通过，代码 `495f6e6` 已加入阶段计时；同提交两次 CI 的相关 8 项检查通过，但完整套件仍失败，N2 根因及最终验收未关闭。以下按原日期保留历史任务卡和证据。

> 截至已核验的 [CI #44](https://github.com/evaldock/EvalDock/actions/runs/38580696078)：源提交 `62c9d3b` 已上传，Ubuntu 通过；Windows 的 8 项 N2 检查通过，但另有 15 项失败输出，完整套件在 180 秒超时，未生成安装包。CI #43 曾出现 N2 首项超时，原因仍未确认，因此 N2 最终验收未关闭。下文 #42 证据为历史记录，当前总结见 [简版交接](WINDOWS_NIGHT_HANDOFF_20261014.md)。

## CI #42 的 N2/N3 历史证据与失败登记

**该次运行：N2 限定检查通过；N3 Windows 完整门禁阻塞；N4 保存交接。** 代码 `c92b6ed` 已推送，PR 保持草稿。本轮不连接 Windows/开发 VM，不修改范围外失败，不合并、不发布。

N0 通过 `1efe140` 合入 `app/a84d2c0`。N2 相对该基线仅修改 `adapters/shared/capture.mjs`、新增 `adapters/shared/windows-process.ps1`，以及 `tests/contracts/agent-adapters.test.mjs`、`tests/contracts/hermes-openclaw.test.mjs`。既有 W1–W3 复用；Hermes/OpenClaw 测试调整限于文件 URL 和复制依赖。

[CI #42](https://github.com/evaldock/EvalDock/actions/runs/38578414728) 实际 checkout 为 `3e8a10ed011b199dd65710f838de063438e7de21`，tree `8159931004f3641d0fe31c7534efe61b68da994f` 与源 `c92b6ed66ebb210de12bd5aa28341638a536da40` 一致。Windows job `115901540282` 的 8 项 N2 检查通过；回执故障检查使用模拟辅助进程，其余包含原生启动、取消、超时和所属子进程清理。Ubuntu job `115901539877` 成功。完整计数和边界见 [本轮结果](WINDOWS_RESULT_20261014.md)。

CI #41 在读到输入后的 `ConvertFrom-Json` 调用阶段阻塞；显式加载 Windows PowerShell 自带 Utility 模块后，CI #42 的 N2 检查通过。未确定默认模块发现内部的具体等待路径。未增加超时阈值、删除断言或跳过失败测试；缺失清理完成回执仍记录 `UNKNOWN`。

Windows 完整套件在 180 秒总时限退出；后续模型设置、NSIS 构建、包审计和上传未运行，附件列表为空。以下是该次日志的 15 项失败输出，只登记位置，**未确认各项根因，未修改对应代码**：

| 登记项 | 数量 | 测试位置（tests/contracts/ 下） |
| --- | ---: | --- |
| DSH 启动超时 | 1 | `dsh-preflight.test.mjs:30` |
| WorkBuddy 档案、Hermes 计数/完成、Pi 可选参数 | 4 | `agent-cost-evidence.test.mjs:31`、`:118`；`agent-version-negotiation.test.mjs:27`、`:55` |
| 日志截断与链接限制 | 1 | `background.test.mjs:22` |
| 题库下载、取消、进度及路由 | 4 | `benchdock-catalog.test.mjs:69`、`:117`、`:145`、`:203` |
| 成本标签目录 | 1 | `cost-label.test.mjs:16` |
| 发布资源审计 | 2 | `desktop-publication.test.mjs:13`、`:40` |
| 题库导入备份及摘要 | 1 | `desktop.test.mjs:32` |
| 难度标注绑定 | 1 | `difficulty-sampling.test.mjs:52` |

DSH 测试调用 `workbench/lib/dsh-preflight.mjs` 独立的 spawn/负 PID kill 路径，不调用 N2 的 `runProcess`。建议另立单张任务卡定位并修复该路径；本轮不实施。其他登记项先取得完整断言证据，再判断产品代码还是测试夹具问题，不能由失败名称推断原因。

本机原始证据位于忽略目录 `artifacts/windows-ci-repair-20261014/n2-repair/`：`result.json`、`ci42-windows.log`、`ci42-ubuntu.log`、`ci42-failure-register.json`、`module-verify.log`、`module-model.log`、`final-stage.log`。原始日志不随 Git 推送。暂存审计 1019 文件通过，辅助脚本源码/暂存 SHA-256 均为 `a6f6b8e5d8e1f0c9011361d0ec48dabeeec67024cbbfbe94a3336e80ff27bf54`。

Windows 11 图形、权限、安装/卸载保留、真实 Agent 和升级继续阻塞。下文为先前 W1–W3 的历史任务与证据；其中 W4 未实施、负 PID 路径待授权等旧状态已由本节限定的 N2 更新，不代表其余 W4–W6 完成。最终文档提交触发的 CI 状态只在交付回复报告，不递归追加文档。

## 历史 W1–W3 任务与证据

2026-10-14，来源：用户上传《EvalDock Windows 适配开发交接 2026-10-14.md》及本轮 W1–W6 只读查重；用户已要求按建议开始。开发基线为 app 的 `5f38918b0c5d05149bb067f59cc4a55760ff003e`，包含 `2a456e1` 的恢复功能。使用独立工作树，原本地文档分叉和未提交修改保留。旧附件 SHA 仅为历史定位，不用于重置。

本轮实施 W1–W3 的代码与合成验证。Windows 11 x64 图形环境由用户稍后提供；原生安装、权限和文件占用证据保持待验收。W4–W6、ARM64、WSL、更多 Agent、签名发行和自动更新不在本轮实施范围。原 Mac 六项暂停工作保持暂停，不 SSH/同步开发 VM。

简明的真实完成项、未完成项和原因见 [本轮总结](WINDOWS_RESULT_20261014.md)。源码和文档已推送至公开仓库的 `codex/windows-foundation` 分支，同事可通过 [草稿 PR #1](https://github.com/evaldock/EvalDock/pull/1) 查看；尚未合入 `app`。

## 复用和边界

复用 COUNT 1–3 和配置冻结、卡片身份版本、既有 ZIP 校验/事务备份、用户工作空间保留、Planner/Trace/Judge/报告。保持私有参考隔离、有效零分/不可评分/错误、历史量表不改写。W4 的所属进程树与 .cmd 接入、线上取消末端竞态均已有单独审查结论，本轮不以基础运行变更宣称这些能力完成。

## W1：工具和 Windows CI（基础代码已实现，Windows 门禁失败）

- 目标：标准 verify 不依赖 shell 通配符或固定 python3 名称；保留 Ubuntu 门禁，增加 Windows x64 离线门禁与候选包构建。
- 白名单：package.json、.github/workflows/ci.yml、scripts/run-contract-tests.mjs、scripts/run-python-tests.mjs、tests/contracts/windows-foundation.test.mjs、tests/contracts/python-support.mjs；agent-adapters / agent-cost-evidence / agent-interface-checks / agent-version-negotiation 的 Python 夹具，以及两份模型设置测试的平台权限断言。
- 实施：Node 显式枚举全部契约；探测 Python 3，执行失败时不换解释器掩盖错误；Windows job 固定工具版本并使用完整 verify；候选包不发布。单项契约 120 秒、测试子进程总计 180 秒超时均判失败，不跳过契约，不把未执行完的套件报为通过。
- 验收：pnpm run verify；node --test workbench/lib/model-settings.test.mjs；断言所有适用检查通过，任何 skip 必须注明其平台范围。原生 Windows CI 必须另核对 run/job 与实际 checkout SHA。
- 责任：代码/合成测试由本任务负责；用户已授权独立分支推送、草稿 PR 和 CI，实际创建及运行状态见下文；Windows 本机环境由用户稍后提供。

## W2：后台、DSH 和环境（本机合成验证通过，Windows 原生待验收）

- 目标：Windows 使用 Electron 自带 Node、正确 PATH 和原生窗口菜单；缺失或无效 DSH 配置不妨碍 App/设置/历史；目标环境只增加必要系统变量，不泄漏评测密钥。
- 白名单：desktop/main.mjs、desktop/platform.mjs、desktop/workspace.mjs、desktop/updates.mjs、workbench/control-server.mjs、workbench/lib/initialize-dsh.mjs、adapters/shared/platform-environment.mjs、adapters/shared/registry.mjs、adapters/shared/cli-interface.mjs、adapters/pi/preflight.mjs、对应契约测试。
- 实施：平台化后台环境与窗口菜单、签名检查按目标系统执行；DSH 初始化失败保留只读历史并拒绝 DSH 操作；不改已有凭据位置，保留保存和空值语义。
- 验收：真实本地 HTTP 服务在缺失/无效 DSH 配置时返回 App、设置和历史，DSH 写操作失败；合成 Windows 环境验证 Path/PATH 去重、系统变量保留、Planner/Judge 密钥排除；Mac 分支行为回归。
- 外部条件：干净标准 Windows 用户实际开窗、凭据文件访问权限、无系统 Node/DSH 场景。0600 合成断言不代表 Windows ACL 通过。

## W3：候选包及导入（配置和本机合成验证通过，Windows 构建被门禁阻塞）

- 目标：win x64 NSIS 候选、已有图案生成 ICO、按目标平台执行包钩子；实际运行资源和 ASAR 继续严格审计；增补 Windows 文件名和取消边界。
- 白名单：package.json、scripts/stage-desktop.mjs、scripts/build-windows-icon.mjs、desktop/assets/icon.ico、scripts/verify-desktop-package.cjs、scripts/verify-desktop-signature.cjs、scripts/audit-desktop-runtime.cjs、desktop/library-paths.mjs、desktop/library-archive.mjs、desktop/workspace.mjs、对应契约测试。
- 实施：候选命令带 --publish never；保留 Mac 构建；Windows 资源定位和 ASAR 路径规范化；拒绝 Windows 设备名/尾点尾空格等歧义，沿原事务切换并补提交前取消。
- 验收：pnpm run desktop:prepare；pnpm run desktop:pack:win；pnpm run desktop:nsis；包钩子必须扫描实际 bytes；合成题库成功、失败、取消均检查旧题库/备份与临时目录；不得通过扩大资源白名单放入用户数据。
- 外部条件：Windows runner 生成实际候选；图形环境验证安装/卸载默认保留、中文路径、占用和恢复。不能用 Mac 产物关闭 W3。

## 后续阶段（未实施）

- W4：用户确认第一种原生 Agent、版本和安装布局后，限定发现/身份/脚本启动与所属进程树文件；验收需超时、取消、退出及子孙进程证据，不按进程名批量终止。
- W5：沿现有流水线执行 1–3 题；先明确 Case/来源、授权参考或无参考、账号与费用/时间上限；证据包含实际 Agent、Trace、Judge 和报告。无参考不能关闭业务评分。
- W6：先明确两个 Windows 候选的版本、源码 SHA 和包摘要；验收配置/库/备份/历史报告保留，并验证受影响的 Mac 功能；重建旧候选须明确标记。

## 证据与收尾

本文件集中记录实际命令、环境、退出码、代码 SHA、日志和未覆盖项。用户已授权独立分支推送、草稿 PR、Windows/Ubuntu CI，以及使用已登录的 Chrome 创建 PR；不把这些授权当作合并或发布许可。收尾采用代码提交→核对 CI 实际检出及文件树→统一文档→文档提交→最终核验，末次文档 CI 只回复，不循环回填本文。

## 本轮实施与实际证据（2026-10-14，Asia/Shanghai）

最终代码提交 C：`ba41ad71c62e8d3e44f3dc6a353832762714574d`。相对上述 `5f38918` 基线，共 31 个代码、测试及构建文件，443 行增加、57 行删除。已推送到独立分支 `codex/windows-foundation`；[草稿 PR #1](https://github.com/evaldock/EvalDock/pull/1) 指向 `app`，未合并、未发布。

产品实现提交为 `3b085af00014151b63253617515eb201cced2608`；随后 `04f0c59ddd0983a1dde9e157e1711224636cbb8c` 和 C 仅修改测试入口的超时诊断。未修改 W4 的进程终止实现。每次代码修改后重跑本机完整门禁及模型设置测试；最终逐文件 SHA-256 比对确认 31 个文件与 C 一致。本文与四份关联文档集中提交为文档提交 D，其最终 SHA 和最后一次 CI 结果在交付回复给出。

### 已实现

- 标准测试入口由 Node 枚举完整 `.test.mjs` 列表；Python 测试及相关 Node 契约统一使用探测到的 Python 3，支持 `EVALDOCK_PYTHON` 指定可执行文件。执行测试失败不尝试其他解释器。
- CI 保留既有事件/分支和 Ubuntu job，新增 Windows 完整 verify、模型设置回归、NSIS 构建及候选 SHA-256/包内清单上传。没有为 Windows 删除或跳过既有进程收尾契约。实际 CI #28 的取消契约超时，套件未完成，后续模型设置测试、NSIS 构建和附件上传均未执行。
- Windows 后台继续使用 Electron 的 Node，Path/PATH 合并为一个键；按白名单保留必要系统环境。窗口使用原生标题栏，菜单不加入 Mac 隐藏角色，Windows 不运行 codesign，也不启用自动更新。已有凭据位置不迁移。
- DSH 缺失、初始化或 Profile 读取失败时保留历史控制器；Windows 明确返回 DSH_PLATFORM_UNSUPPORTED。设置、其他 Agent 和历史仍可读，DSH 操作拒绝。损坏的历史记录仍显示错误，不用空列表掩盖。
- 既有 ICNS 的 256px PNG 原样转换为 ICO；增加 win x64 NSIS 和目录候选命令，均不发布。包钩子按目标平台执行，Windows 检查 x64 PE、审计实际 runtime/ASAR、比对携带的 ICO 资源；Windows EXE 实际显示图标和最终安装器行为仍需原生验证。
- ZIP 保留既有校验/备份/回滚，补父目录的大小写及 Unicode 别名检测。Windows 额外拒绝设备名、尾点/尾空格等；其他平台保留原有合法文件名。取消信号传入原事务并在切换前检查，失败/取消保留旧题库。

### 本机验证

环境为 macOS 27.0 arm64，Node 24.21.0、pnpm 11.24.0、Python 3.9.6。Node 使用已有工具运行时；pnpm 位于本任务临时目录。依赖来自原工作区现有 node_modules 的独立文件副本，依赖声明和锁文件未修改。pnpm 11 会因副本元数据尝试重装，所以本机使用 `--config.verify-deps-before-run=false`；它只关闭运行前自动重装，不删除 verify 中的任何检查。Windows CI 使用全新 `pnpm install --frozen-lockfile`，CI #28 中该步骤通过。

| 命令 | 退出码与实际断言 | 证据文件 |
| --- | --- | --- |
| `pnpm --config.verify-deps-before-run=false run verify` | C：0；发布边界、类型检查、构建通过；Python 5；契约 340 通过 / 0 失败 / 0 跳过 | `verify-runner-deadline.log` |
| `node --test workbench/lib/model-settings.test.mjs` | C：0；4 通过；密钥不返回前端、空值保留和保存语义不变 | `model-settings-runner-deadline.log` |
| `node scripts/stage-desktop.mjs`（紧接当前 build） | 0；真实暂存 1018 个运行资源通过字节审计，首次题库为空 | `stage-frozen.log` |
| `pnpm --config.verify-deps-before-run=false exec electron-builder --mac --dir --publish never` | 0；标准 Mac arm64 包 1451 个资源通过审计，codesign 完整性通过；未公证 | `mac-package-frozen.log` |
| `git diff --check`、冻结文件 SHA-256 比对 | 0；代码冻结后未漂移 | `code-ba41ad7-verification.json` |

日志保存在本任务独立证据目录，交付回复给出本机链接。暂存和 Mac 包验证基于 `3b085af` 的冻结产品文件；其后两次提交仅改测试入口，打包输入未变化。Mac 产物为 `artifacts/mac/mac-arm64/EvalDock.app`；包内清单为同目录的 `evaldock-package-audit.json`。这只是共享打包回归，没有启动图形窗口、干净用户安装或升级；不关闭原 Mac 暂停项。

首次在受限沙箱跑 HTTP 合成测试因回环监听 EPERM 失败，经允许监听的执行环境复跑后通过。首次以自定义 electronDist 复用本地目录时，审计拒绝 default_app.asar；随后使用标准分发路径通过，未扩大白名单。这些失败日志一并保留。

### 实际 CI 与版本绑定

[CI #28](https://github.com/evaldock/EvalDock/actions/runs/38534831008) 已结束，源分支为 C。PR 工作流实际检出合并提交 `300bb60094172f7dc8b6d09469a11fbd3cf7bfab`，父提交为 `5f38918` 和 C；其 tree `71138fa0846ef1106e12f48bc9a6b7b849ebc8bf` 与 C 相同。两份 job 日志均记录实际 checkout，不能把合并 SHA 写成源分支 SHA。

| Job | 已确认结果与覆盖 | 未覆盖 |
| --- | --- | --- |
| Ubuntu `115755275536` | 成功；完整 verify；契约 339 通过、1 项 Mac 签名检查跳过；Python 5、模型设置 4 通过 | Windows 运行及图形安装 |
| Windows `115755275043` | 失败；Windows Server 2025 x64 runner，Node 24.21.0；工具、冻结依赖安装、发布边界、类型检查、构建和 Python 5 通过；取消契约在 120 秒超时，契约进程在 180 秒被总时限判为未完成并退出 1 | 全套契约结果、后续模型设置测试、NSIS 构建、候选摘要及附件上传；run 附件列表为空 |

Windows runner 是 `windows-2025-vs2026`，不替代 Windows 11 x64 图形验收。完整证据为 `ci28-ubuntu.log`、`ci28-windows.log`、`ci28-result.json`。

前两次诊断运行 [CI #26](https://github.com/evaldock/EvalDock/actions/runs/38533406359)（源 `3b085af`）和 [CI #27](https://github.com/evaldock/EvalDock/actions/runs/38534078996)（源 `04f0c59`）的 Ubuntu 成功，Windows 被后续推送取消，均不是完整 Windows 验收。#26 的部分日志还有 WorkBuddy/Hermes 契约失败摘要，没有完整错误堆栈；这些仍待后续完整运行核实，不据此宣布取消问题是唯一阻塞。

### 已推送文档与 CI #31

文档提交为 `5cd49be78bc542cbbb468bc78db8e0f419fd9e33`；随后 `29793a88b328821bcea4da934d9671de1a5c4c39` 仅协调 `NATIVE_SETUP.md` 与并行 app 改动的文档冲突，产品代码未变。按用户本次要求，将已确认的校验结果同步到 todo、App 交接和简明总结。

[CI #31](https://github.com/evaldock/EvalDock/actions/runs/38536361338) 的源分支提交为 `29793a8`，实际检出 `0a692915920766d6573d73cbb65a502d6a027b9a`，父提交为 `16d12708432ef5dd8202da0fa2d6096e03c37a07` 和 `29793a8`，tree 为 `0b15a3c594d10fc6735802e4174512c1ca9b0917`。该结果包含同期 app 修复，与本机 C 的文件树不同。

| Job | 通过的校验 | 未完成的校验 |
| --- | --- | --- |
| Ubuntu `115760088726`，成功 | 发布边界、类型检查、构建；契约 357 通过、1 项 Mac 专属签名检查跳过；Python 5、模型设置 4 通过 | Windows 运行及图形验收 |
| Windows `115760089029`，失败 | 工具与冻结依赖安装、发布边界、类型检查、构建、Python 5 通过 | 取消契约 120 秒超时，runner 180 秒超时退出 1；全套契约未完成；后续模型设置、NSIS 构建、摘要及上传跳过；没有候选包或附件 |

证据为 `ci31-ubuntu.log`、`ci31-windows.log`、`final-version-binding.json`；CI 日志链接可由同事直接查看，本机原始证据不随 Git 推送。上述结果不关闭 W1–W3 的 Windows 验收。此次新增文档提交及其最终 CI 只在交付回复报告。

### 文档 68117e6 与 CI #32

`68117e605b896fc5c04f8b5b9329bda220fc2373` 已提交推送本轮简明总结，并同步 todo 与交接文档，仅修改四份文档。按用户再次要求，现补入该提交已结束的 [CI #32](https://github.com/evaldock/EvalDock/actions/runs/38539144917) 结果。

两份 job 日志确认实际检出 `b8aef59dfb44f0c799cad7bff890f8e7a65f1939`，父提交为 `16d12708432ef5dd8202da0fa2d6096e03c37a07` 与 `68117e6`，tree 为 `80db848cd45056d1978a1dca5285fdd8a3704d72`，不是独立分支原始文件树。

| Job | 通过的校验 | 仍未通过或未执行 |
| --- | --- | --- |
| Ubuntu `115769306050`，成功 | 发布边界、类型检查、构建；358 项契约中 357 通过、1 项 Mac 专属签名检查跳过；Python 5、模型设置 4 通过 | Windows 原生验收 |
| Windows `115769306647`，失败 | 工具与冻结依赖安装、发布边界、类型检查、构建、Python 5 通过 | 取消契约 120 秒、runner 180 秒超时，ETIMEDOUT、退出 1，全套契约未完成；后续模型设置、NSIS 构建、摘要及上传跳过 |

证据为 `ci32-ubuntu.log`、`ci32-windows.log`、`ci32-result.json`。W1–W3 的 Windows 验收及 W4–W6 状态不变；本次文档提交产生的 CI 状态仅在回复报告。

### 阻塞、责任和下一步

1. **Windows 门禁：已确认失败，W1 验收未关闭。** `tests/contracts/agent-adapters.test.mjs:39` 的取消契约调用 `runProcess`，取消后等待进程关闭。既有 `adapters/shared/capture.mjs:100` 的 `terminate` 对负 PID 发送信号，`127` 行等待 `close`；实际 Windows 运行出现上述超时。该调用链是后续应先核查的 W4 平台进程收尾路径，日志尚未给出其内部精确阻塞行，修复需另行确认 W4 范围。本轮只增加有限时失败诊断，不删测试、不放宽断言、不为等待结果重复触发 CI。后续先解决该依赖，再完整重跑并核实是否仍有其他 Windows 失败。
2. **Windows 候选：因门禁失败未执行构建，W3 验收未关闭。** 没有实际 NSIS 候选、摘要或 Windows 包审计可交付。门禁通过后按原工作流构建和审计，再交给原生环境验收；不绕过失败门禁生成可用性结论。
3. **Windows 图形验收：等待用户稍后提供 Windows 11 x64。** EXE 图标、标准用户凭据访问权限、无系统 Node/DSH 启动、文件占用/恢复及安装/卸载保留均未原生验收。Unix 0600 断言仅在 Unix 执行，不代替 Windows ACL。
4. **W4–W6：未实施。** 原生 Agent 发现/身份/.cmd/所属子孙进程、真实 Agent 与题目及调用预算、两版本升级仍按原目标执行，等待相应范围及材料。线上自动选题末端取消竞态未在本轮顺带修复。无合并、发布、真实 Agent/模型调用、VM 同步或暂停任务恢复。
5. 原始上传附件已通过当前 Library 流程保存到本机独立证据目录，并完整读取。文件为 28931 字节，SHA-256 为 `a347a732a84e0a0a703dc8e6f9aa4e762e54fd722bb9df055a46a33d711fefba`，Library 身份已保留。本文是本轮任务卡，不是原附件的本机副本。
6. GitHub 连接器创建 PR 曾返回 403，浏览器替代路径曾被自动审批拒绝。用户随后明确授权使用已登录 Chrome，PR #1 已成功创建并核对，授权阻塞已解除。最终文档提交后的 CI 仅在交付回复报告，保持草稿 PR，待上述阻塞解决后再判断阶段验收。
