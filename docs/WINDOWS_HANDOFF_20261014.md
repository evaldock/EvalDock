# Windows x64 接续 TODO 与开发任务卡

> 2026-10-16 接续记录。下方各阶段和历史 W1–W6/N0–N4 记录保留；当前状态以“本轮提交与交接收尾”为准。规划、只读核查、本地实现和 Windows 实机验收分别记录，不互相代替。
>
> WX00 接续：用户随后只授权原 Windows 机器的只读核查，现已登录并取得系统、会话及仓库证据；完整运行隔离仍未确认。未同步源码、安装依赖、启动 App 或运行旧测试，详见下方 WX00 结果。
>
> WX01 接续：用户暂缓专用账号/桌面准备并要求继续其他工作。本地已承接两项现成修复并完成相关合成检查，实际 Windows 验证仍等待隔离条件。没有连接原机、处理 Mac 原生事项或扩大到 WX02/WX03。
>
> WX03 接续：用户随后授权本地只读核查，并要求将 DSH 诊断覆盖缺口记录后暂缓，继续其余失败项。本次只更新原有交接，不改产品或测试代码、不运行测试、不连接 Windows、不处理 Mac。当前分流结果见 WX03 卡内记录。
>
> WX03 最新批次：用户要求一次处理剩余项目。批次起点 `a6a4785`，剩余 11 条失败输出分为 6 组；本批完成 1 条的明确夹具修正，其余 10 条记录阻塞，DSH 另 1 条继续暂缓。没有把本地检查写为 Windows 门禁通过，详见 WX03 批次清单。
>
> **For agentic workers:** 实施时使用 `superpowers:executing-plans`，逐卡推进。每卡都有独立交付、证据和停止点；本计划不自动启动实施。

**Goal:** 沿用现有 Windows 分支，交付在既有目标机实际安装、启动并完成限定验收的 x64 `.exe` 候选包。

**Architecture:** 复用现有 Electron 界面、评测服务、题库事务、证据和报告。只承接已有上游修复、修正 Windows 差异及交付阻塞，不另建客户端或评测流水线。

**Tech Stack:** Electron、Node.js、TypeScript/JavaScript、Windows PowerShell、electron-builder/NSIS；执行工具按现有锁文件及 Windows CI，Node 24.x、pnpm 11.24.0，Python 3。

**Spec:** 用户 2026-10-16 提供的《window客户端交接文档.md》及本次请求。附件 SHA-256：`defe90bd2332ccec77250d1c5623266a7a84454eff3d4f1491bc8f99cfa096a5`。附件是规划依据，本次没有据其内容自动执行登录、安装或真实评测。

## 2026-10-16 本轮提交与交接收尾

**范围与版本：** 项目 `evaldock/EvalDock`，开发分支 `codex/windows-foundation`，继续使用 `EvalDock-windows-w1-w3` 工作树。本次按用户明确要求推送当前分支，不合入 `app/main`，不连接原 Windows、不处理 Mac、不发布。代码交付点为 [`9291f3a004668d147e5909393bb6ba9e63aa75d6`](https://github.com/evaldock/EvalDock/commit/9291f3a004668d147e5909393bb6ba9e63aa75d6)：从远端 `8ef70d8` 正常快进推送 7 个相关提交，`git ls-remote` 与 PR head 均已读回同一 SHA，没有空代码提交或强推。收尾文档另行提交推送，其 SHA 与最终 CI 状态只在最终回复报告，不回填循环提交。

| 当前任务 | 实际状态及原因 |
| --- | --- |
| 接手/查重/任务规划、WX00 只读核实 | **该范围已完成。** 已有系统、会话、仓库及配置边界证据；专用账号、可操作 GUI 和完整运行隔离仍**未确认**，WX00 全卡不关闭 |
| WX01 | **本地实现及相关检查完成，实机未验证。** 复用两项现成修复，保留 Windows 差异；未同步原机、未进行实际 Electron 界面或完整 Windows 门禁验收 |
| WX02 | **未完成。** 偶发超时没有已确认根因或修复结果；现有成功样本不能证明它消失 |
| WX03 | **本地批次收尾完成，全卡未通过。** 累计 4 条有本地夹具修正；另 10 条缺充分失败现场/原生契约而阻塞，DSH 1 条按用户要求暂缓。逐组条件见下方批次清单；原 Windows 失败是否恢复仍未验证 |
| WX04–WX07 | **未完成/未验证。** 未在原机打包、安装及验收一个真实 Agent，未交付可取得的 `.exe`；仍受隔离、门禁和真实调用条件限制，不以代码已写代替交付完成 |

**本次实际执行的最小测试：** 在代码交付点合并核验 4 个受影响夹具用例，命令如下，实际 **4 通过、0 失败、0 跳过，退出 0**；没有扩大到整套旧测试，没有真实 Agent/模型调用。

```sh
node --test --test-reporter=tap --test-timeout=120000 --test-name-pattern='^(Pi omits unavailable optional flags while retaining isolated runtime and explicit extensions|native Hermes completion is accepted only from one completed owned session|annotations bind to question bytes; stale annotation becomes UNKNOWN, hints never contain private answers|release audit rejects nested history, secrets, home paths and external links)$' tests/contracts/agent-version-negotiation.test.mjs tests/contracts/difficulty-sampling.test.mjs tests/contracts/desktop-publication.test.mjs
```

WX01 的 `pnpm run build`、`pnpm run check` 及四文件 30 项检查结果仍归原本地实现阶段（28 通过、2 项原生 Windows 跳过），不是此次新跑。`241a1e1..9291f3a` 的 TS/探针源码、依赖清单和锁文件无差异，继续使用当时构建产物，没有为收尾重复构建。此次未运行 `pnpm run verify` 或完整契约套件；`node --test workbench/lib/model-settings.test.mjs` 沿用 WX01 已有证据，本次未重跑。文档提交仅做链接、命令存在性、格式与发布边界检查，不再次执行产品测试。

**对应 CI：已配置，代码提交未触发，未通过。** 本轮推送后同时查询 GitHub Actions 全事件运行与 check-runs，本 SHA 均为 0；没有本提交的运行链接，不能引用历史 CI #47 作为本次结果。[PR #1](https://github.com/evaldock/EvalDock/pull/1)当前 open、draft、未合并，API 返回 `mergeable=false`、`mergeable_state=dirty`。[本提交检查页](https://github.com/evaldock/EvalDock/commit/9291f3a004668d147e5909393bb6ba9e63aa75d6/checks)用于核对缺失检查，不代表通过。现有 `.github/workflows/ci.yml` 的 push 分支仅 `main/app/release/**`，当前分支依赖 PR 事件；本次未为绕过合并阻塞修改工作流、合并基线或手动重跑全套。无运行可等待时记录“未触发”，不写为“运行中”或“失败测试已修复”。

**接手位置与访问：** 使用仓库 `https://github.com/evaldock/EvalDock.git` 的 `codex/windows-foundation`；先读本节、WX03 批次阻塞表及现有超时交接，不按旧 PR 正文中的历史状态重新实施。GitHub 元数据确认仓库为 public，当前 Git 凭据已实际成功推送。没有提供具体接手人的账号，其推送与 Actions 权限**未核验**；不要索取或传递用户密码/令牌。源码和文档随 Git 交付，本机忽略目录中的原始诊断日志、用户配置及运行产物不进入公开仓库。

**下一步与停止点：** 原 Windows 隔离/桌面准备仍由用户暂缓；PR 合并冲突和缺失 CI 单独保留。条件变化后先处理对应阻塞，取得未解决项的首个断言/异常再最小修复，不能直接进入已验收的安装包交付。没有新证据不重新逐条循环核查，也不把本次提交推送收尾当作整个 Windows 项目完成。

## 当前边界与证据规则

- “本轮只负责 Windows 适配，交付能实际安装、启动的 Windows x64 安装包。”
- “Mac 相关开发、环境准备、虚拟机、测试、打包和验收均不在本轮范围内，无需处理或等待 Mac 事项。”不把 Mac B02 隔离阻塞变成 Windows 前置条件。
- “运行验证以该 Windows 机器的实际结果为准，本机检查或 CI 结果不能替代目标机验证。”记录实际系统版本；不要求换成新 Windows 11 机器，也不泛化为所有 Windows 版本通过。
- “同步前核对目标机的分支、提交和未提交改动，保留已有配置、密钥、题库和评测结果。”不覆盖远端独立修改，不使用整目录删除镜像。
- “本轮先交付候选包，不合入 `app` 或 `main`，不正式发布。”用户后续已明确授权当前开发分支的代码/文档推送和 CI 核验，结果见本轮收尾；没有上传安装包或发布。
- 只处理影响 Windows 运行、测试、打包和验收的实际问题。C02 历史复测入口、新 Agent 适配器、Judge/Planner 引擎、网站、ARM64/WSL、自动更新和跨版本升级不纳入。
- 区分代码已有、合成检查、CI、目标机界面、真实 Agent 与业务评分。缺证据写“未验证”；`SCORED`、`UNASSESSABLE`、`ERROR` 和有效零分不得混淆。未知清理不能写成完成。
- 不读取或提交真实密钥、题库、私有参考和原始评测记录。私有参考仍只交给既有 Judge；新增资源继续接受现有包内实际字节审计。

## 接续规划时核实的三个版本（历史快照）

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
| app 的证据配对修复 `6c77478`、报告证据加载 `c7ddd4c` | 已修好的逻辑只做承接，见 WX01 | Windows 接手起点未含两项；WX01 现已在本地承接并合成验证，未同步原机，不能宣称 Windows 实机已具备 |
| C01 完成后的收尾完整复跑 | **确有重复执行。** `85db251..12f9677` 只有文档变化；原收尾 `7afedda` 又执行 358 项、5 项 Python、4 项模型设置，本地结果也记录 `newProductCodeChanges=false` | 当时用户要求收尾测试，记录保留；同源码、同环境无新失败时，后续文档收尾只查文档，不再主动复跑完整产品套件 |
| Windows 多轮限定成功样本及文档 CI | 为调查间歇故障取得样本有用途；不能重复算新功能。`495f6e6..8ef70d8` 仅改文档 | 对未解决故障只做有上限的定向采样；文档 CI 自动触发则记录，不另起相同手工运行 |

参考：[客户端交付记录](https://github.com/evaldock/EvalDock/blob/12f9677f25542d0f606d31d1a6f44d8ea9cc4026/docs/APP_CLIENT_HANDOFF_20261016.md)、[客户端既有 TODO](https://github.com/evaldock/EvalDock/blob/12f9677f25542d0f606d31d1a6f44d8ea9cc4026/docs/APP_CLIENT_TODO_20261016.md)、[C02 缺口](https://github.com/evaldock/EvalDock/blob/4e04ee1/docs/APP_CLIENT_C02_REVALIDATION_AUDIT_20261016.md)。本次只读回客户端最终[CI #38857934431](https://github.com/evaldock/EvalDock/actions/runs/38857934431)的 Ubuntu job 成功状态，没有重新运行其测试。

## 详细 TODO 与顺序

- [x] 下载并快进本地 app 到当前远端提交；保留 Windows 和客户端独立分支。
- [x] 读取附件、客户端全段沟通、原 Windows 交接及已有测试/代码证据。
- [x] 区分重复实现、可以省掉的复跑，以及 Windows 尚缺的实机验收。
- [x] 在本文件整理接续卡，在[超时交接](WINDOWS_TIMEOUT_INVESTIGATION_20261015.md)记录本阶段总结；不新建同类清单。
- [ ] **WX00 → 只读核查已完成，后续准备由用户暂缓。** SSH、系统、桌面存在及两个检出状态已核实；GUI 操作入口和专用测试账号/运行隔离未确认。未创建账号、改配置、同步或启动，详见下方结果。
- [ ] **WX01 → 本地承接与相关合成检查完成，Windows 原生未验。** 两项修复已移入并随 `9291f3a` 推送，Windows 差异保留；不搬 C01/C02。未同步原机，当前 PR 冲突/缺 CI 与实机验收限制见收尾记录。
- [ ] **WX02 → N2 超时。** 优先看已有失败证据，缺现场才定向采样；有失败依据才修，未复现就保留未解决状态。
- [ ] **WX03 → 本地批次已收尾，全卡未通过。** 4 条已有本地夹具修正，10 条缺充分依据而阻塞，DSH 1 条暂缓；原 Windows 失败是否恢复及完整门禁未验证。缺新依据不循环核查，详情见批次表和收尾记录。
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

**交付/依赖：** 一份目标机接续记录，供其余卡引用。复用已有 SSH 配置，不猜地址、不建 VM。下列只读核查已经执行，后续变更和运行仍受本卡停止点约束。

**文件范围：** 只读本机 SSH 配置和远端仓库/工具/系统信息；证据放忽略目录 `artifacts/windows-resume-20261016/`。不改业务代码、账号、共享配置或密钥。

- [x] 通过已有 Windows SSH 别名完成无交互认证；没有改 SSH 配置、接受新指纹或加载原初始化脚本。
- [x] 在两个既有 EvalDock 检出执行只读 Git 状态、HEAD、分支和 remote 核对，均无未提交改动。设置当前进程的 `GIT_OPTIONAL_LOCKS=0`，避免状态检查刷新索引；未 fetch/pull/reset 或覆盖文件。
- [x] 记录实际 Windows 版本、登录用户、控制台会话、现有用户/配置路径存在性和相关进程。仅检查工具入口；没有安装、运行工具链检查或旧产品测试。
- [ ] 完整运行隔离与 GUI 操作条件尚未确认；工具链实际版本/原环境加载后的可用性未核实。同步、冻结安装和启动不在用户本次只读授权内，未执行。

**通过标准：** 同一目标机登录、仓库/测试数据边界和工具链可核实；SSH 成功与 GUI 可用分别记录。缺桌面会话只阻塞 GUI 卡，其他可独立事项继续。

**需要人工时一次列清：** 哪个入口需要登录、是否已有专用测试用户、需要在哪一步提升权限；不索要密码/私钥，不默认要求管理员权限。

**WX00 只读核查结果（2026-10-16）：**

| 核对项 | 本次实际证据与结论 |
| --- | --- |
| 连接 | `windows-lan` 的 BatchMode SSH 退出 0，已有主机身份校验通过；旧控制 socket 已不存在，不影响本次直接认证成功。没有复用失效会话或重新配置认证 |
| 系统 | Microsoft Windows 10 家庭中文版，64-bit，`10.0.19045 / Build 19045`。这是本次目标机系统，不写成 Windows 11 验收 |
| 桌面 | 控制台登录用户与 SSH 相同；Explorer 位于 `Console / Session 3`，SSH 进程在 Session 0。`tasklist` 状态为 Unknown，因此只确认已有桌面登录，桌面是否解锁、是否能由当前入口操作仍未验证 |
| 旧验证检出 | `EvalDock-windows-check-20261015-01/EvalDock`：`codex/windows-foundation / 716611f419bab5fb3b2d8b94a1a8cd8aac678c03`，Git 工作区干净 |
| 超时调查检出 | 同目录下 `timeout-investigation/EvalDock`：`codex/windows-foundation / 495f6e69ebb6537b53319d02b713d878ec1d842c`，Git 工作区干净；仍为已有调查版本，未更新到本地文档提交 |
| 其他已有内容 | 原初始化脚本仅静态解析仓库路径，没有执行；发现既有 Studio 工作树有本地领先提交，保持原状，不纳入本轮开发 |
| 配置与进程 | 当前账号默认的模型配置、Agent 配置、旧 `.dsh/.env` 和默认 EvalDock workspace 路径均不存在；仅查存在性，未读凭据。该账号已有多个 Node/Python 进程及监听端口，归属/空闲状态未确认，未停进程或占用其端口 |
| 独立环境 | 两个源码目录已经分开；5 个隔离相关源文件在两个检出中的哈希，与本地版本按 CRLF 规范化后全部对应。现有桌面入口仍使用当前系统用户的模型/Agent 配置默认路径与回退；换源码目录不足以证明运行隔离。现有其他启用账号用途和桌面可用性未确认，不擅自使用 |
| 工具入口 | 无 Profile 的 SSH 环境能定位 Git/Node、WindowsApps Python/py 入口，未找到 pnpm。未据入口推定版本、Python 真实可执行性或 pnpm 未安装，也未加载原环境补查 |

**保持阻塞：** 原生 App/安装及真实 Agent 阶段所需的完整运行隔离与可操作 GUI 尚未确认。后续需要环境持有人明确本项目可用的专用 Windows 测试账号/桌面入口，再核实配置来源和现有服务边界；本次没有要求或执行创建用户、改配置、切换桌面或停止服务。源码可只读核对，不代表运行条件已就绪，不自动进入 WX01–WX06。

**证据与限制：** 原机 `query.exe` 指定路径不可用，已用控制台用户、Explorer 和交互式登录记录替代核实，没有将替代结果写成 GUI 操作通过。初次清单辅助器发生本地输出解码错误，后续通过内存标准输入采集成功，不记为产品缺陷。完整本地材料在忽略目录 `artifacts/windows-resume-20261016/` 的 `wx00-result.json`、`wx00-desktop-result.json`、`wx00-source-comparison.json`、只读脚本及日志；不上传主机/账号信息或原始清单。

### WX01：承接现成的证据配对及报告加载修复

**交付/依赖：** Windows 仍保留平台逻辑，并包含两个现成上游修复；不重新设计。可先本地实施，Windows 验证依赖 WX00。

**文件：** `adapters/shared/capture.mjs`、`desktop/main.mjs`；沿用 `tests/contracts/agent-adapters.test.mjs`、`tests/contracts/desktop-lifecycle.test.mjs` 及必要说明。来源固定为 `6c774787f27678bf170f0a293f1bbf720f54a46c`、`c7ddd4c02868bfcd94d16f92e32ea85546e53a47`。

**接口：** 复用 `Capture.add(type,data,at)` 的事件外壳与 `callId`；复用 `start()` 内现有报告窗口。Windows `runWindowsProcess`、菜单、PATH、打包配置和版本声明保留；没有新公开 API。

- [x] 对照两个来源提交，移入已有产品差异、回归及 adapter 说明；没有整文件替换或覆盖 Windows 平台逻辑。
- [x] 两个上游回归在移入产品代码前先失败、承接后通过；当前 TypeScript 输入构建/类型检查通过，两个受影响文件及 Windows 基础、模型设置相关合成检查通过。Windows 原生两项按既有平台条件跳过，不算通过。
- [x] 已检查没有 C01/C02、新量表、新题库或其他模块产品改动；产品逻辑与指定上游对应，既有 Windows 文件和进程段保持一致。本阶段仅本地保存提交，最终提交号在回复报告。
- [ ] Windows 原生 App、真实 Agent/模型、安装包及完整门禁仍未验证；不因上述合成检查关闭本卡整体验收。

**停止点：** 发生超出两项修复的依赖冲突，先列具体差异，不扩大为整分支整合。此卡不重新运行已有 Mac 业务验收。

**WX01 本地执行记录（2026-10-16）：**

- 用户现在可期待的变化：大工具输入/输出被截断时仍保留调用标识、工具名和错误状态；截断继续明确标记，不冒充完整证据。报告窗口允许执行限定的 `report-data.js` 加载 Trace，仍拒绝控制 API、写请求、外域/文件访问、其他脚本、导航和权限。这些是本地代码与合成结果，实际 Windows 点击效果尚未验证。
- 产品逻辑复用 `6c77478`、`c7ddd4c`；只改 `adapters/shared/capture.mjs`、`desktop/main.mjs`，携带对应两份回归及 `adapters/README.md` 的原说明。报告回归增加合成 `win32` 上下文，确认 Windows 标题栏和 ICO 入口继续保留，没有启动 Electron。
- 以 `2720ce4` 为本阶段起点。源码比对确认 `Capture` 类和报告窗口限制与指定上游一致；既有 Windows process reader/supervisor 段、`desktop/platform.mjs`、更新/工作空间模块、PowerShell supervisor、`package.json`、CI 配置均未改。原 Windows 机器、app 分支和客户端独立分支未修改。

| 本阶段实际命令 | 实际结果与边界 |
| --- | --- |
| `pnpm --config.verify-deps-before-run=false run build` | 退出 0；复用已准备的 Node 24.19.0 / pnpm 11.24.0 和依赖，没有重新安装。随后产品变化均为直接加载的运行时 JS，TypeScript 构建输入未改变 |
| `node --test --test-reporter=tap --test-name-pattern='large Pi tool payloads\|desktop reports load Trace' tests/contracts/agent-adapters.test.mjs tests/contracts/desktop-lifecycle.test.mjs` | 承接前两项均按缺口失败：调用配对不完整、报告脚本禁用；承接后 2 通过。这里的两项包含在下方相关检查内，不相加 |
| `pnpm --config.verify-deps-before-run=false run check` | 退出 0；类型检查通过 |
| `node --test --test-reporter=tap --test-timeout=120000 tests/contracts/agent-adapters.test.mjs tests/contracts/desktop-lifecycle.test.mjs tests/contracts/windows-foundation.test.mjs workbench/lib/model-settings.test.mjs` | 退出 0；30 项中 28 通过、0 失败、2 项 Windows 原生检查按既有条件跳过。运行环境为本机 Node；VM 平台分支与进程/HTTP 均为合成材料，无真实 Agent/模型 |

相关检查允许本机临时回环服务；没有修改时限、放宽断言或新增跳过来换结果。未运行 `pnpm run verify`：该入口包含本轮排除的 Mac 原生签名检查，而目标 Windows 完整运行仍受隔离阻塞。上述 30 项是受影响范围检查，不能当作完整门禁通过；没有运行 Mac 原生、App 启动、打包或跨版本验收。

一次独立只读代码审查未发现本次移植新增的 P1/P2 问题；审查没有重新运行测试，也未验证真实 Electron/Windows 行为。代码、回归及两份已有 Windows 交接在本地保存，不推送、不触发 CI。证据保留在忽略目录 `artifacts/windows-resume-20261016/wx01/` 的 build/check/red/green/affected 日志、退出码和 `integration-checks.json`；审查与执行进度在本卡专属忽略工作目录中。

经验：已有修复直接移植并保留归属；只对移植后的新组合验证，不重写已完成功能或重复历史 C02 核查。合成检查能证明代码边界，不能解除隔离或替代实机验收。隔离准备继续暂缓，本阶段不自动恢复 WX02/WX03。

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

- [ ] 从原始日志提取断言、堆栈、输入与实际值。DSH 只读核查和暂缓事项见下方记录，当前不运行其旧测试；将来获准实施时复用原合成夹具，不另建 DSH 支持。
- [ ] 区分产品缺陷、平台路径差异、夹具假设和工具权限，登记哪些尚未确认；不能仅凭测试名下根因结论。
- [ ] 每个证实根因一个小修复：先证明现有失败，再补必要回归、最小修改和定向复测；不重写已有题库事务、评分或适配器。已有 Windows Job 能力仅在适配其真实接口后复用，不默认直接替换即可工作。
- [ ] 本阶段产品改动完成后，在目标 Windows 运行 `pnpm run verify`、`node --test workbench/lib/model-settings.test.mjs`，记录实际计数、退出码和适用平台 skip。完整门禁不是每次查文档都跑。
- [ ] 沿现有工作流核对对应分支/提交的 Ubuntu 和 Windows CI；没有本次 CI 就标记未运行，不创建新一套 CI，也不以 Ubuntu 代替实机。需要共享分支写入/CI 调度时按明确的当前交付范围执行，不沿用旧聊天中的一次性收尾推送授权。

**通过标准：** 适用完整检查退出 0，无未解释的失败/跳过，工具/夹具修正不放宽产品断言。若 N2 仍未决，单独保留，不能借此卡关闭。

#### 2026-10-16 WX03 批次处理与阻塞清单

**批次范围：** 用户要求不再逐条等待确认。本批从 `a6a4785` 开始，一次处理剩余 11 条失败输出，归入下方 6 组；失败数量不代表独立根因数量。只修正证据充分的测试夹具，缺依据的项目明确阻塞，不反复重查、不重跑整套旧测试、不连接 Windows、不处理 Mac。

**批次前已完成的本地修正（本批不重跑）：** `c3d508e` 在同一测试文件处理 Hermes 文件 URL 转换和 Pi 路径断言，两个定向用例通过；`a6a4785` 只规范难度标注夹具的清单路径，一个定向用例通过。均有本地路径语义检查，Windows 实机与历史 CI 是否恢复仍未验证。

| 组 / 原失败输出数 | 本批结论及修改范围 | 阻塞与重新开启条件 |
| --- | --- | --- |
| `agent-cost-evidence` / 2 | **阻塞，未改。** WorkBuddy 档案目录编码仅替换 `/`，不能据此发明 Windows 原生档案命名；Hermes 流式夹具使用 Unix shebang、chmod 和 Python 符号链接，不能将其失败直接归为计数解析错误。位置分别为测试第 34、118–128 行及 `adapters/workbuddy/usage.mjs:10` | WorkBuddy 需要真实 Windows 档案目录编码依据；Hermes 需要具体失败阶段和可复用的 Windows 启动方式依据。两项均缺完整断言现场，不扩展产品启动接口、不改进程管理、不以模拟替换原集成断言 |
| `background` / 1 | **阻塞，未改。** 测试依次检查截断、原描述符继续追加及链接拒绝；`workbench/lib/background-io.mjs:31` 使用 `O_NOFOLLOW`。现有失败名称不能说明哪一步失败 | 需要首个失败断言/异常和原生文件句柄、链接权限依据；不猜改截断或清理逻辑，不跳过链接断言 |
| `benchdock-catalog` / 4 | **阻塞，未改。** 四项均有失败记录；安装路径经过 `importLibrary`，且下载入口捕获异常后保存失败状态（`workbench/lib/benchdock-catalog.mjs:166,227`）。这不能证明四项共享根因 | 需要各项首个失败断言、实际下载/安装状态及原始受控异常；不重写下载或导入事务、不放宽校验，不新建四套实现 |
| `cost-label` / 1 | **阻塞，未改。** 同一用例包含标签、Case 加载与总数断言，只有整体失败记录 | 需要实际异常或期望/实际值，才能决定是输入字节、标签、加载还是计数问题；不猜改标签和摘要 |
| `desktop-publication` / 2 | **1 条完成本地夹具修正，1 条阻塞。** 仅改 `tests/contracts/desktop-publication.test.mjs`：个人路径由平台 `path.join` 改为两个明确的合成路径样例；外部链接改为测试自建目录的 junction，不再依赖机外固定文件。保持原拒绝断言，不改审计器或资源白名单。ASAR 项未改 | 路径问题的本地探针在修改前未触发应有拒绝，修改后两样例均被真实审计器拒绝；定向用例通过。原生 junction、整条旧失败是否恢复仍未验证。ASAR 项需要创建、枚举、提取或白名单检查中首个实际失败点，不猜修改 |
| `desktop` / 1 | **阻塞，未改。** 导入用例同时检查 Case 数、摘要、备份与进度；旧日志只登记整体失败 | 需要 `importLibrary` 异常或具体断言实际值；不猜改事务、摘要或数据保留逻辑 |

**核对基数：** 11 条 = Agent 2 + 后台 1 + 目录下载 4 + 成本标签 1 + 发布审计 2 + 导入 1。本批只完成其中 1 条的明确夹具修正，10 条仍阻塞；另有 DSH 1 条继续按用户要求暂缓。连同此前 3 条，原 15 条中累计 4 条已有本地夹具修正，11 条保留阻塞/暂缓。这里的“本地修正”不等于原 Windows 失败已消失。

**本批最小验证：** 语法检查、`git diff --check`；只运行 `node --test --test-reporter=tap --test-timeout=120000 --test-name-pattern='^release audit rejects nested history, secrets, home paths and external links$' tests/contracts/desktop-publication.test.mjs`，1 项通过。另将夹具表达式按 Windows 路径规则解释，再交给真实审计器：修改前 1 个样例未被拒绝，修改后 2 个样例均被拒绝。这是本地语义/文件审计检查，没有原生 Windows 执行。既有 TS 和产品源码未变，复用 WX01 的构建产物，不重复构建、跑整套检查或已完成的 Hermes/Pi/难度用例。

**证据与停止点：** 旧失败登记仍为 `artifacts/windows-ci-repair-20261014/n2-repair/ci42-failure-register.json`，不改写历史记录。CI #47 本地日志第 287、296、350、363、366–367、371、391、402、405、412 行对应本批 11 条；第 436 行记录完整套件 180 秒超时，未保留足以区分各项首个失败点的完整断言现场。本批新探针及定向检查结果另存本机忽略文件 `artifacts/windows-resume-20261016/wx03-batch-validation.json`。无新的失败现场、原生契约依据或环境条件变化时，不重新开启上表阻塞项，不另拆小卡反复核查。

**后续整体阻塞：** WX02 偶发超时未解决；WX04–WX07 仍依赖门禁结论及用户暂缓的原 Windows 隔离/桌面条件，不能绕过为已验收。本批不推送、不触发 CI、不生成或发布候选包。WX03 全卡保持未通过。

**经验：** 可从源码和受控探针闭合的夹具问题合并修正；缺少失败现场的产品问题一次登记清楚，等待新依据，避免用反复查看和重复运行制造进度。

#### 2026-10-16 本地分流记录：DSH 暂缓，转查其余失败

**历史只读阶段：** 以下为 `1dad1ec` 的分流记录，保留当时依据；当前状态以上方批次清单为准。当时只登记异常、定位最小修改范围，没有修改产品/测试代码或重新执行测试，WX03 未关闭。

| 项目 | 已有依据及当前结论 | 最小范围与阻塞 |
| --- | --- | --- |
| DSH 插件冲突诊断 | **暂缓、未解决。** 现有结构化错误尚未证明覆盖仅写 stderr、异常被吞或消息截断时的插件及冲突信息。校验、限长、脱敏后传递捕获异常的方案尚未实施，完整诊断覆盖**未验证** | 不透传原始 stderr，不重建 Windows Job/进程管理，不开发完整 Windows DSH。该覆盖缺口冻结，后续仅在取得新的结构化样本或明确需求时重新开启，不阻塞其他失败的本地定位 |
| Hermes 原生会话完成用例 | **已定位夹具中的脚本路径问题，未修复。** 本地旧日志 `artifacts/windows-timeout-investigation-20261015/ci47-windows.log:320–321` 明确记录 Python 因重复盘符的脚本路径无法打开文件，随后该用例失败；尚未进入证据解析逻辑。当前 `tests/contracts/agent-version-negotiation.test.mjs:59` 仍用文件 URL 的 `.pathname` 作为脚本路径 | 实施时仅在这个测试文件导入 `fileURLToPath` 并替换该处 `.pathname`；产品 `adapters/hermes/adapter.mjs` 已在同一脚本调用中使用该转换，直接沿用。无需改 Hermes 产品、Python 脚本或进程管理。修复及 Windows 通过结果均未验证 |
| Pi 可选参数用例 | **确认存在路径分隔符断言差异；是否为该次失败的唯一原因未验证。** 同一旧日志第 318 行登记该用例失败；测试第 31 行以 `home+'/.pi/agent'` 作严格字符串期望，产品 `adapters/pi/launch.mjs:6,21` 则返回 `path.join` 的平台路径。没有完整断言现场，不能据此推定其他行为有错 | 最小候选修改仍在上述同一测试文件，将路径期望改为平台路径；保留全部参数和隔离断言，不改 Pi 产品。暂不实施、不重跑旧用例 |
| 其余 12 条失败输出 | **根因仍未确认。** 沿用原登记，未把失败数量等同于独立缺陷数量 | 尚未取得足以决定修改的具体断言、输入和实际值；不猜修、不拆成 12 张开发卡 |

**下一步顺序：** 实施阶段先处理上表同一测试文件内的路径问题，再仅针对修改取得新证据；当前的“不改代码、不跑测试”边界继续保留。目标 Windows 复测仍受隔离准备暂缓影响，不能将静态定位写为门禁通过。

**经验：** 没有完整断言堆栈不等于日志毫无定位价值；已有 Python 报错足以区分“脚本没启动”和“解析行为失败”，无需重跑全套来重新寻找这条线索。

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
