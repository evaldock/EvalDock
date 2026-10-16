# Windows x64 接续 TODO 与开发任务卡

> 2026-10-16 当前接续计划。下方历史 W1–W6/N0–N4 记录保留；本节负责当前顺序和边界。本次只完成拉取、沟通查重与规划，没有开始 Windows 修复或实机验收。
>
> **For agentic workers:** 实施时使用 `superpowers:executing-plans`，逐卡推进。每卡都有独立交付、证据和停止点；本计划不自动启动实施。

**Goal:** 沿用现有 Windows 分支，交付在既有目标机实际安装、启动并完成限定验收的 x64 `.exe` 候选包。

**Architecture:** 复用现有 Electron 界面、评测服务、题库事务、证据和报告。只承接已有上游修复、修正 Windows 差异及交付阻塞，不另建客户端或评测流水线。

**Tech Stack:** Electron、Node.js、TypeScript/JavaScript、Windows PowerShell、electron-builder/NSIS；执行工具按现有锁文件及 Windows CI，Node 24.x、pnpm 11.24.0，Python 3。

**Spec:** 用户 2026-10-16 提供的《window客户端交接文档.md》及本次请求。附件 SHA-256：`defe90bd2332ccec77250d1c5623266a7a84454eff3d4f1491bc8f99cfa096a5`。附件是规划依据，本次没有据其内容自动执行登录、安装或真实评测。

## 当前边界与证据规则

- “本轮只负责 Windows 适配，交付能实际安装、启动的 Windows x64 安装包。”
- “Mac 相关开发、环境准备、虚拟机、测试、打包和验收均不在本轮范围内，无需处理或等待 Mac 事项。”不把 Mac B02 隔离阻塞变成 Windows 前置条件。
- “运行验证以该 Windows 机器的实际结果为准，本机检查或 CI 结果不能替代目标机验证。”记录实际系统版本；不要求换成新 Windows 11 机器，也不泛化为所有 Windows 版本通过。
- “同步前核对目标机的分支、提交和未提交改动，保留已有配置、密钥、题库和评测结果。”不覆盖远端独立修改，不使用整目录删除镜像。
- “本轮先交付候选包，不合入 `app` 或 `main`，不正式发布。”本次未推送、触发 CI、修改 PR 或上传安装包。
- 只处理影响 Windows 运行、测试、打包和验收的实际问题。C02 历史复测入口、新 Agent 适配器、Judge/Planner 引擎、网站、ARM64/WSL、自动更新和跨版本升级不纳入。
- 区分代码已有、合成检查、CI、目标机界面、真实 Agent 与业务评分。缺证据写“未验证”；`SCORED`、`UNASSESSABLE`、`ERROR` 和有效零分不得混淆。未知清理不能写成完成。
- 不读取或提交真实密钥、题库、私有参考和原始评测记录。私有参考仍只交给既有 Judge；新增资源继续接受现有包内实际字节审计。

## 本次已核实的三个版本

| 用途 | 分支与提交 | 本次结果 |
| --- | --- | --- |
| 最新客户端源 | `app / 433b76535d99b3aaea1ef4faf9016619db3ecbaf` | 已 fetch；原 `EvalDock/` 从 `a84d2c0` 快进 7 个提交，工作区干净。与“客户端开发”早上取得的 app 起点相同，无更晚 app 提交 |
| Windows 接续起点 | `codex/windows-foundation / 8ef70d8b3a63ded2292a6330693e9509a693f1b7` | fetch 确认远端仍为此提交；继续使用原 `EvalDock-windows-w1-w3/` 工作树，没有合入 app 或客户端独立分支 |
| 已有客户端独立成果 | `codex/app-client-20261016 / 12f9677f25542d0f606d31d1a6f44d8ea9cc4026` | 远端与本地一致；C01 产品提交为 `85db251`，尚未进入 app/Windows，本轮不重写或自动搬入 |

[PR #1](https://github.com/evaldock/EvalDock/pull/1) 本次读回仍为 open、draft、未合并，head 为 `8ef70d8`。[CI #47](https://github.com/evaldock/EvalDock/actions/runs/38670210700) 本次读回 Windows 门禁失败、NSIS/摘要/上传跳过，Ubuntu 门禁成功；本机原始日志保留 180 秒总超时。上述结果不能作为本轮 Windows 实机结果。

## 与“客户端开发”沟通的去重结论

已读取该聊天全部 20 个历史回合；聊天 ID 为 `01a14259-7e7f-7cc2-bfcc-a9f5b327c510`。结论同时对照 Git 差异、现有记录与本地收尾结果，不把聊天中的建议当作新实施授权。

| 既有任务或证据 | 去重处理 | 仍然需要的工作 |
| --- | --- | --- |
| B01：Mac 独立目录工具链和 351 项源码基线 | 已有，不再克隆或重装同一 Mac 环境 | Windows 目标机当前工具链与源码仍需核实，环境不同不能沿用 Mac 结论 |
| C01：详情页未知/未结束计数及分阶段状态，`85db251` | 不重做；20 项相关检查包含在原 358 项内，不重复相加 | 实际界面未验；不因候选包任务自动引入这条独立分支 |
| C02：17 项字段核对、8 项提交前检查缺口核查，`0ee4e27`/`4e04ee1` | 直接引用已有结论，不再核对；按钮未实现 | 无现成完整题包比对和提交前重验；继续阻塞，排除 Windows 安装包范围 |
| 28/33/35B 文档对齐、已有 Mac 测试版 | 不重复改版、打包或发布；不增加原 26/36 统计 | 不证明 Windows 已有可安装包，也不替代 Windows 验收 |
| W1–W3、Windows Job 管理与最多 32 条阶段时间线，`495f6e6` | 源码复用，不重建平台层、图标、NSIS、题库事务或取消实现 | N2 间歇超时根因未明，完整门禁未过；限定成功样本不能关闭这两项 |
| app 的证据配对修复 `6c77478`、报告证据加载 `c7ddd4c` | 已修好的逻辑只做承接，见 WX01 | Windows 起点基于 `a84d2c0`，尚未含这两项，不能直接宣称 Windows 已具备 |
| C01 完成后的收尾完整复跑 | **确有重复执行。** `85db251..12f9677` 只有文档变化；原收尾 `7afedda` 又执行 358 项、5 项 Python、4 项模型设置，本地结果也记录 `newProductCodeChanges=false` | 当时用户要求收尾测试，记录保留；同源码、同环境无新失败时，后续文档收尾只查文档，不再主动复跑完整产品套件 |
| Windows 多轮限定成功样本及文档 CI | 为调查间歇故障取得样本有用途；不能重复算新功能。`495f6e6..8ef70d8` 仅改文档 | 对未解决故障只做有上限的定向采样；文档 CI 自动触发则记录，不另起相同手工运行 |

参考：[客户端交付记录](https://github.com/evaldock/EvalDock/blob/12f9677f25542d0f606d31d1a6f44d8ea9cc4026/docs/APP_CLIENT_HANDOFF_20261016.md)、[客户端既有 TODO](https://github.com/evaldock/EvalDock/blob/12f9677f25542d0f606d31d1a6f44d8ea9cc4026/docs/APP_CLIENT_TODO_20261016.md)、[C02 缺口](https://github.com/evaldock/EvalDock/blob/4e04ee1/docs/APP_CLIENT_C02_REVALIDATION_AUDIT_20261016.md)。本次只读回客户端最终[CI #38857934431](https://github.com/evaldock/EvalDock/actions/runs/38857934431)的 Ubuntu job 成功状态，没有重新运行其测试。

## 详细 TODO 与顺序

- [x] 下载并快进本地 app 到当前远端提交；保留 Windows 和客户端独立分支。
- [x] 读取附件、客户端全段沟通、原 Windows 交接及已有测试/代码证据。
- [x] 区分重复实现、可以省掉的复跑，以及 Windows 尚缺的实机验收。
- [x] 在本文件整理接续卡，在[超时交接](WINDOWS_TIMEOUT_INVESTIGATION_20261015.md)记录本阶段总结；不新建同类清单。
- [ ] **WX00 → 原机接续。** 核对 SSH 登录、实际系统、桌面会话、测试数据隔离、分支/改动和工具链；本次当前可用性未验证。
- [ ] **WX01 → 承接 app 必要修复。** 只接入上述两项已实现修复，保留 Windows 差异；不整文件覆盖，不搬 C01/C02。
- [ ] **WX02 → N2 超时。** 优先看已有失败证据，缺现场才定向采样；有失败依据才修，未复现就保留未解决状态。
- [ ] **WX03 → 完整门禁阻塞。** 先定位 DSH 预检及其他登记失败，按证实根因最小修复，再运行本轮必要完整检查。
- [ ] **WX04 → 原机生成候选。** 同源码生成 NSIS，审计包内文件并绑定源码、EXE、SHA-256。
- [ ] **WX05 → 原机安装与界面。** 安装、启动、主要页面、配置、合成导入/报告、退出、卸载保留/重装；实测失败只开对应小修复。
- [ ] **WX06 → 一个真实 Agent 的最小闭环。** 目标、账号、题目和调用上限明确后，用 1 道题核对执行/采集/评分/报告；不新增适配器。
- [ ] **WX07 → 候选交付。** 提供实际 `.exe` 获取位置、SHA-256、源码和 CI 链接、系统版本、安装说明、签名状态及剩余限制。

WX01 可先本地处理代码差异；WX02/WX03 可在各自前提满足后推进，不能因抓不到旧偶发样本而无限重跑或阻塞其他问题的定位。WX04 等门禁与未决风险被明确处理后进入；WX05/WX06 的实际结果才决定候选是否满足交接目标。当前没有 Windows 已整体验收完成的结论。

## Review Focus

1. 中文/空格路径、`.cmd` 及参数转义：目标机使用现有 supervisor 契约验证参数不变，归 WX02/WX05。
2. 取消、超时及子进程存活：只清理本次所属进程，缺回执为 UNKNOWN；不误杀无关进程，归 WX02。
3. 无 Node/DSH、缺配置和权限不足：App/设置/历史能读，失败明确显示，不伪报可评测，归 WX03/WX05。
4. 导入失败、取消及文件占用：旧题库/配置/报告仍完整可读；实际失败应有清楚提示，归 WX05。
5. 包与源码不一致、报告窗口权限或资源遗漏：受控报告能加载证据，控制接口仍拒绝；实际安装文件绑定包摘要与源码，归 WX01/WX04/WX05。

## 接续开发任务卡

### WX00：恢复既有 Windows 目标机的安全接续条件

**交付/依赖：** 一份目标机接续记录，供其余卡引用。复用已有 SSH 配置，不猜地址、不建 VM；本次不执行连接。

**文件范围：** 只读本机 SSH 配置和远端仓库/工具/系统信息；证据放忽略目录 `artifacts/windows-resume-20261016/`。不改业务代码、账号、共享配置或密钥。

- [ ] 用已有 Windows SSH 别名验证登录；记录认证结果，不在日志打印配置正文/凭据。失败只说明认证/网络实际报错，不断言机器不可用。
- [ ] 在目标仓库执行 `git status --short --branch`、`git rev-parse HEAD`、`git remote -v`，核对未提交修改归属；任何覆盖前先保留相关改动。
- [ ] 记录 Windows 产品名/版本/Build/架构、`node --version`、`pnpm --version`、可用 Python 和桌面会话；只核对现有专用测试用户和路径，不自动新建用户。
- [ ] 同步前后比对提交/文件；只同步源码和必要文档。锁文件或安装状态变化才在该机执行冻结安装，不复制 Mac `node_modules`。

**通过标准：** 同一目标机登录、仓库/测试数据边界和工具链可核实；SSH 成功与 GUI 可用分别记录。缺桌面会话只阻塞 GUI 卡，其他可独立事项继续。

**需要人工时一次列清：** 哪个入口需要登录、是否已有专用测试用户、需要在哪一步提升权限；不索要密码/私钥，不默认要求管理员权限。

### WX01：承接现成的证据配对及报告加载修复

**交付/依赖：** Windows 仍保留平台逻辑，并包含两个现成上游修复；不重新设计。可先本地实施，Windows 验证依赖 WX00。

**文件：** `adapters/shared/capture.mjs`、`desktop/main.mjs`；沿用 `tests/contracts/agent-adapters.test.mjs`、`tests/contracts/desktop-lifecycle.test.mjs` 及必要说明。来源固定为 `6c774787f27678bf170f0a293f1bbf720f54a46c`、`c7ddd4c02868bfcd94d16f92e32ea85546e53a47`。

**接口：** 复用 `Capture.add(type,data,at)` 的事件外壳与 `callId`；复用 `start()` 内现有报告窗口。Windows `runWindowsProcess`、菜单、PATH、打包配置和版本声明保留；没有新公开 API。

- [ ] 对照两个来源提交，仅移入其已有产品差异和回归，不整文件替换、不将 app 的 Mac 配置覆盖 Windows。
- [ ] 先构建当前源码，再运行上述两个契约文件；断言大工具载荷仍保留调用配对，报告能加载限定证据，控制接口和其他脚本仍拒绝。
- [ ] 核对没有 C01/C02、新量表、新题库或其他模块改动；按文件清单本地提交，记录来源和实际验证环境。

**停止点：** 发生超出两项修复的依赖冲突，先列具体差异，不扩大为整分支整合。此卡不重新运行已有 Mac 业务验收。

### WX02：沿原 N2 定位偶发超时，禁止重建进程管理

**交付/依赖：** 带阶段记录的失败依据及最小修复，或明确的“本批未复现、根因仍未确认”。依赖 WX00；WX01 修改捕获文件后只验证当前版本。

**文件/接口：** `adapters/shared/capture.mjs` 的 `runWindowsProcess({...})`、`adapters/shared/windows-process.ps1`、`tests/contracts/agent-adapters.test.mjs`。沿用 `capture.diagnostics.supervisor.trace`、`lastPhase`、`capture.cleanup`；无公开协议扩展。

- [ ] 先读已有失败与 `495f6e6` 时间线，区分启动准备、目标执行和收尾；`CREATE_JOB` 最后阶段不直接等于系统 API 卡死。
- [ ] 缺新失败样本时才运行定向命令：`node --test --test-reporter=tap --test-timeout=20000 --test-name-pattern="process capture|capture redacts|Windows job|Windows supervisor|Windows capture" tests/contracts/agent-adapters.test.mjs`。先确认 `pnpm run build` 产物对应当前源码，记录过滤项。
- [ ] 本计划采样上限为 3 轮或 10 分钟，先到即停；这是成本上限，不是超时根因或通过阈值。已有对应版本/环境的充分失败材料则不重复采样。
- [ ] 有失败依据才补最小回归、确认能失败、实施修复并复测；保持请求 5000ms、既有 120/180 秒门禁和断言，不跳过故障来换绿灯。

**验收：** 证据保留原错误、阶段时间、退出和清理回执；正常、取消、超时、非 Node 子孙、参数及无关进程保护通过。成功次数不能证明偶发故障消失；无现场则明确未解决，仍可推进 WX03。

### WX03：按证据解决完整 Windows 门禁的剩余阻塞

**交付/依赖：** 一份逐根因登记与必要修复；依赖 WX00，沿用旧失败表。15 条失败输出不预拆为 15 个开发任务。

**首查文件/接口：** `workbench/lib/dsh-preflight.mjs` 的 `preflightDsh({descriptor,profile,plugins,revision,secrets,timeoutMs})`，`tests/contracts/dsh-preflight.test.mjs`。该路径有独立 spawn/负 PID 清理，不能把 N2 的成功当作它已修好；不因此开发完整 Windows DSH 控制器。

**其余条件文件：** 原登记的 `agent-cost-evidence`、`agent-version-negotiation`、`background`、`benchdock-catalog`、`cost-label`、`desktop-publication`、`desktop`、`difficulty-sampling` 契约。只在具体断言证明后修改其直接拥有者；现有错误表见本文件历史区。

- [ ] 从原始日志提取断言、堆栈、输入与实际值；先单独运行 `node --test --test-reporter=tap --test-timeout=120000 tests/contracts/dsh-preflight.test.mjs`，复用原合成夹具。
- [ ] 区分产品缺陷、平台路径差异、夹具假设和工具权限，登记哪些尚未确认；不能仅凭测试名下根因结论。
- [ ] 每个证实根因一个小修复：先证明现有失败，再补必要回归、最小修改和定向复测；不重写已有题库事务、评分或适配器。已有 Windows Job 能力仅在适配其真实接口后复用，不默认直接替换即可工作。
- [ ] 本阶段产品改动完成后，在目标 Windows 运行 `pnpm run verify`、`node --test workbench/lib/model-settings.test.mjs`，记录实际计数、退出码和适用平台 skip。完整门禁不是每次查文档都跑。
- [ ] 沿现有工作流核对对应分支/提交的 Ubuntu 和 Windows CI；没有本次 CI 就标记未运行，不创建新一套 CI，也不以 Ubuntu 代替实机。需要共享分支写入/CI 调度时按明确的当前交付范围执行，不沿用旧聊天中的一次性收尾推送授权。

**通过标准：** 适用完整检查退出 0，无未解释的失败/跳过，工具/夹具修正不放宽产品断言。若 N2 仍未决，单独保留，不能借此卡关闭。

### WX04：在目标 Windows 生成和审计一个 x64 候选

**交付/依赖：** `.exe`、包审计、源码与摘要清单；依赖 WX03 门禁、WX02 未决问题的明确结论。未解决风险不得写为通过。

**文件：** 默认不改代码；复用 `package.json` 的 `desktop:nsis`、`scripts/stage-desktop.mjs`、`scripts/verify-desktop-package.cjs`、`scripts/audit-desktop-runtime.cjs` 和已有 ICO。仅实际构建失败才触及对应文件。

- [ ] 固定干净源码提交与工具版本；执行 `pnpm run desktop:nsis`。命令已包含 prepare 和 `--publish never`，不再串行重复 prepare、目录打包、NSIS 三套完整构建。
- [ ] 确认当前输出目录恰有一个本次 `*-setup.exe` 和 `win-unpacked/evaldock-package-audit.json`；旧产物只在任务输出目录整理，不动用户工作空间。
- [ ] 用既有包钩子审计实际 PE/ASAR/runtime；必要复查命令为 `node scripts/audit-desktop-runtime.cjs artifacts/windows/win-unpacked artifacts/windows/release-files.json`。不放宽资源白名单。
- [ ] `Get-FileHash -Algorithm SHA256` 计算实际 EXE 摘要，`Get-AuthenticodeSignature` 记录实际签名状态；清单绑定 source SHA、EXE 名称/字节/哈希和系统版本。

**通过标准：** 实际 Windows 产物与源码可追溯，审计退出 0；没签名就写未签名，不能借 Mac 签名或配置声明代替。CI 产物不替代目标机此项。

### WX05：原机安装、基础操作和数据保留验收

**交付/依赖：** 用户可看到的实际安装和操作结果；依赖 WX00 的 GUI、WX04 的固定候选，使用已核实的测试数据边界。

**文件：** 默认只记录；具体界面/路径/权限问题才修改 `desktop/` 或对应 `workbench/` 的直接拥有者，另附窄范围失败证据。复用现有五个页面，不改版。

- [ ] 在同一目标机安装该 EXE，记录标准用户/权限提示、安装位置、图标及实际启动。缺系统 Node/DSH 场景按实际已有环境验证，不卸载已有软件来造场景；未覆盖就注明。
- [ ] 检查页面导航、空状态、设置输入校验和脱敏、Agent 发现状态、合成小题库导入及已有报告证据；发现安装不等于接口通过，合成报告不等于真实评测。
- [ ] 验证中文/空格路径、导入失败/取消、可安全复现的文件占用及正常退出；比较测试配置、题库、备份和历史前后摘要。结果未知就如实显示。
- [ ] 仅在专用测试安装/测试数据上验证卸载默认保留和同候选重装可读，不操作原业务安装。无法隔离则备注该项未验证。

**通过标准：** 有同机安装、开窗、主要操作和退出的截图/日志及包摘要；没有运行的项目保持未验证。当前 Windows 明确 `DSH_PLATFORM_UNSUPPORTED`，验证提示与其他功能可用，不把它扩张为 DSH 移植任务。两版本升级另行安排。

### WX06：复用现有适配器，验收一个真实 Agent 最小闭环

**交付/依赖：** 目标机上 1 道真实题的执行、证据、Judge 与报告记录；依赖 WX05 及明确可用的目标与调用上限。本次未盘点可用 Windows Agent，不指定或猜测支持。

**文件/接口：** 沿现有发现、预检、运行与报告入口；默认不改适配器、题库格式或评分。私有材料只保留本地，不进入候选包。

- [ ] 一次明确第一种 Agent、版本/布局、登录与授权、1 道题及参考权限、题目外部依赖、最长时长和费用上限；缺必需信息则停真实调用，其他卡继续。
- [ ] 用该机真实安装的现有适配器执行 1 题，保存 Run/Case/Session 关联、实际交付物、Trace、Judge 和报告；核对报告从界面能打开证据。
- [ ] 有授权参考才验业务评分；缺参考记录 UNASSESSABLE，Judge 调用失败记录 ERROR，不凑零分。执行、收集、评分和清理分别按证据判断。
- [ ] 取消/超时能力先沿用 WX02；仅真实调用暴露不同故障时补最小样本，不为了重复证明同一结论再增加真实任务和费用。

**通过标准：** 真实闭环与界面呈现对应，调用条件和限制可追溯；缺环境或材料就写部分完成，不能宣称完整交付达标。新增适配器需另定范围。

### WX07：交付候选并完成小阶段总结

**交付/依赖：** 依赖 WX04–WX06 的实际结果。更新本文件和 [超时/阶段交接](WINDOWS_TIMEOUT_INVESTIGATION_20261015.md)，不新建第三份状态清单。

- [ ] 提供一个实际可取得的 `.exe` 文件位置和 SHA-256；若使用受控下载链接，核验权限和实际文件一致。不创建正式 Release，不修改 app/main。
- [ ] 写明源码分支/提交、对应 CI 的实际链接与 checkout、目标机 Windows 版本、安装步骤、签名状态和各项实际结果；无对应 CI/可下载文件就直说尚缺。
- [ ] 文档仅做链接、命令、格式与发布边界检查；依赖或产品代码没有变化时不再完整复测/重建候选。最终文档 CI 在最终回复报告，不循环回填、提交和触发。

**停止点：** 任一必需验收未完成，只能交付候选进展与明确缺口。不能用“8 项通过”“Ubuntu 通过”或“文件生成成功”关闭全部安装/业务验收。

## 每个小阶段的简短总结及复测触发条件

每卡完成更新一次已有记录，先用大白话说明用户现在能多做什么，再按五行交接：

1. **变化：** 改了什么/没改什么，用户能用到什么。
2. **证据：** 源码 SHA、环境、实际命令、退出码、关键结果和本地日志位置。
3. **未完成：** 失败、未验证与阻塞分别写清，不用测试数量代替产品验收。
4. **下一步：** 下一张卡及开始条件，不临时补新功能。
5. **经验：** 本阶段避免哪种重复工作、下次保留什么证据；没有新经验就不凑结论。

产品/依赖/构建资源变化、环境实质变化、新失败或旧证据不足才触发对应复测。Windows 首次实际安装及真实 Agent 是此前缺失的验收，不属于重复；同源码、同环境的文档整理不触发产品全套复跑。自动 CI 已触发则记录，无新依据不另调度同一套。

本次小阶段结果见 [2026-10-16 接续总结](WINDOWS_TIMEOUT_INVESTIGATION_20261015.md#2026-10-16-接续规划阶段)。下面按历史保留，旧“仅 W1–W3”“只登记范围外失败”“等待 Windows 11”是对应阶段的边界，不替代本次 Windows 目标和卡片条件。

---

## Windows 11 x64 基础适配历史任务卡

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
