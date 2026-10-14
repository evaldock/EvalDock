# EvalDock App 原改动恢复与夜间整合

2026-10-14，本轮接续夜间问题核对，恢复原工作树材料并整合到已通过 CI 的 App 基线。随后按用户要求恢复 24、27B 的无真实模型验收，详见 [安装与手动替换验收](APP_INSTALL_UPGRADE_20261014.md)。真实业务评测、正式发行和 Windows 适配继续暂停，原六项中其余四项未恢复。

## 当前结论

源码验收提交为 `2a456e16031b33dff9a268213579af27e3586fbf`。本机 `app` 和开发 VM 的 `app` 已同步，原文件、补丁、摘要清单和两端 stash 均保留。02、12、13、23 及后续 27 的限定数据保留标准已完成；36 个父项现为 17 项完成、19 项未整项关闭。24 的包已准备，新系统用户仍受管理员认证阻塞。

找回的功能包括原 Logo、紧凑界面、LangGraph 接入和独立目标卡片、本机 Pi/OpenClaw 发现及含空格路径的 OpenClaw 会话读取。夜间的少量选题、配置冻结、诊断详情、目标版本绑定和 Claude 身份展示继续保留。本机和 VM 均通过标准源码检查，新的 Mac arm64 临时签名包已生成并审计。

WorkBuddy 5.7.7 的当前连接已恢复为 READY，但原截图的故障步骤、原因码和日志仍缺失，06 仅部分完成。27B 已验证不同源码构建的实际包手动替换与合成数据保留；真实执行、证据采集、Judge 评分、干净系统安装、自动更新和正式发行均未验收。

## 已确认错误修复（2026-10-14）

用户随后要求持续修复既有错误并提交；测试用户创建暂缓，不恢复真实模型、真实 Agent 任务、正式发行或 Windows 适配。本次修复起点为 `5f38918`，下述结果独立于原整合提交的旧验证。

**DSH 配置缺失导致历史接口失败。** 合成回归在修复前稳定复现：Web Profile 不存在时，`GET /api/control/status` 返回 404，其他 Agent 的记录读取次数为 0。只恢复 Profile 元数据后接口恢复，确认故障发生在配置读取、早于记录合并。缺失、损坏的 Profile 或不可读的 DSH 安装现在显示 `UNVERIFIED` 和检查提示；已有配置元数据与磁盘历史保留可读，DSH 操作继续被拒绝。主界面按目标与 run 合并归档和控制器记录，保留不同目标的同名 run，避免重复显示。

本机 Node 24.19.0 / pnpm 11.24.0 的 `pnpm run verify` 通过：契约 332 项、Python 5 项，0 失败、0 跳过；模型设置另 4 项通过。`pnpm run desktop` 的独立合成后端确认接口返回 200、仅 1 条 fixture 历史 Job/Run，三个 HTML 报告可读，0–10 旧量表及有效零分、UNASSESSABLE、ERROR 保留。

新 Mac arm64 ad-hoc 包暂存审计 1015 个文件、实际包审计 1445 个文件，严格签名完整性检查通过。原生实际点击历史记录并打开其中一个 HTML 报告；高级工作台显示缺失 DSH 配置及禁用操作，菜单退出正常停止测试包和后端。28 个配置、题库和历史文件摘要不变。开发模式有另一个已有窗口，本轮没有关闭它；自有开发测试窗口通过进程清理收尾，该清理不计作菜单退出验收。以上交互发生在本机现有系统用户，不能关闭 24 或补写 VM 原生验收。

原生检查另发现：缺少批次进度日志的历史记录有三个已结束 Case，却显示“0 / 3”。该计数问题另行复现和修复，不以 Job 成功状态推算完成数量。

本次证据位于忽略目录 `artifacts/app-bugfix-20261014/`，包括 `verify.log`、`model-settings.log`、`package.log`、`native-api.json`、`native-validation.json` 和保护文件摘要。开发 VM 的新源码同步与验证在完成后另记，不借用此前 329 项结果。36 项完成数量保持 17/36；24 仍未完成。

## 来源和整合范围

- 夜间远端基线为 `de8b4800f9758df0cec647e7d9b357a3f42002af`，夜间起点后 20 个提交均在远端历史内，[CI #21](https://github.com/evaldock/EvalDock/actions/runs/38430401362) 对应该基线并通过；该时点的产品代码最后修改于 `dff85f9`。旧 CI 不用于声称新整合已经通过云端验证。
- 本机原 `app` 工作树为 `da5c97c`，原交接列出的 14 个修改文件和 1 张未跟踪图片全部存在。逐文件保留原字节、完整 SHA-256 和差异补丁，未用同名文件代替原内容。
- 开发 VM 的 `app` 为 `f200338`，也保留这 15 个文件。6 个文件与本机不同；按各自基线比较后，VM 新增代码行已包含在本机原改动中，HTML 的 Logo、Graph 表单和既有控件也对应。两端原材料分别备份。
- 新整合以夜间基线为起点。HTML 和卡片调用发生重叠，逐处保留双方意图；不回退夜间选题限制、详情、版本匹配、新安装入口和 Claude 身份展示。

本地原始备份、完整摘要和 VM 差异在忽略目录 `artifacts/night-integration-20261014/`；VM 另有自己的备份。以下摘要前缀用于定位，完整值以原始清单为准。

| 原文件 | 原 SHA-256 前缀 | 保留决定 |
| --- | --- | --- |
| `adapters/openclaw/transcript.mjs` | `b1dc73c7d8cc` | 保留 fileURLToPath 修复，恢复含空格桌面路径的会话读取。 |
| `desktop/main.mjs` | `1c8fa90d7365` | 保留窗口底色；继续保留较新基线的 ZIP 导入与更新逻辑。 |
| `docs/MAC_APP.md` | `8a480013aec1` | 合并 LangGraph 表单、本机发现及界面说明，保留夜间验收边界。 |
| `scripts/stage-desktop.mjs` | `60d511c3e7aa` | 新增原 Logo，并保留夜间新增的卡片与评测配置模块。 |
| `tests/contracts/agent-discovery.test.mjs` | `016e73b725ee` | 保留本机安装和 Graph 接入测试，继续覆盖 Claude 身份发现。 |
| `tests/contracts/hermes-openclaw.test.mjs` | `97494e34fa5e` | 保留含空格路径的原生会话 CLI 回归。 |
| `tests/contracts/product-pages.test.mjs` | `e7ecd433df9a` | 保留紧凑概览和具体 Graph 名称的报告检索回归。 |
| `workbench/control-server.mjs` | `0362a731bf31` | 保留 LangGraph 接入口、CSRF、忙碌门禁和已有配置保护。 |
| `workbench/design-prototypes/app.css` | `e8620253c8ea` | 合并紧凑样式，并保留诊断详情和模式隐藏规则。 |
| `workbench/design-prototypes/app.html` | `7b66f6ffad1c` | 保留原 Logo 和 Graph 表单，同时保留 COUNT 1–3 控件。 |
| `workbench/design-prototypes/app.js` | `5b584fda117b` | 通过新卡片模块展示各 Graph；保留准备与正式提交配置冻结。 |
| `workbench/design-prototypes/product-pages.js` | `7f1b61410ada` | 保留具体目标名称、转义及紧凑概览。 |
| `workbench/lib/agent-control.mjs` | `fe64fca4e65b` | 保留任务目标名称，历史记录优先读取其冻结名称。 |
| `workbench/lib/agent-discovery.mjs` | `af990f894da6` | 保留本机 Pi/OpenClaw 发现和 Graph 路径校验，同时保留 Claude 修复。 |
| `workbench/design-prototypes/assets/evaldock-logo.png` | `5b418e775309` | 保留原文件，132444 字节，加入 Git 跟踪与包资源。 |

## 行为和回归

原改动恢复了 LangGraph 表单及具体目标卡片、本机 Pi/OpenClaw 安装入口、目标名称对应的报告搜索、紧凑界面和原 Logo。OpenClaw 会话 CLI 改用文件 URL 转换，避免默认桌面工作空间包含空格时不输出原生会话 JSON。

Graph 卡片适配到夜间新增的共享卡片模块。每个具体 Graph 绑定自己的目标、版本、诊断与操作，名称正确转义；未配置时显示待接入，已配置但未就绪时显示已接入待检查。新增两项回归在整合前失败、修复后通过，保护多目标绑定和未配置状态。

既有未知错误详情、连接/登录/清理操作优先级、多安装版本绑定、Claude CLI/桌面身份、COUNT 1–3、标准和手选入口继续保留。Judge、量表、私有参考规则和适配器协议没有变化。

## 本机验证

工具为 Node 24.19.0、pnpm 11.24.0、Electron 44.7.0。执行结果：

- 先构建当前源码，再运行四份受影响契约：41 项通过。
- `pnpm run verify`：发布边界、Python 5 项、类型检查、构建和契约 329 项通过，0 失败、0 跳过。
- `node --test workbench/lib/model-settings.test.mjs`：4 项通过。
- `pnpm run desktop`：在隔离用户数据目录以默认渲染打开原生窗口，核对 Logo、概览、WorkBuddy 版本及可展开详情、Graph 表单；提交不存在的合成路径被拒绝，配置目标仍为 0。
- `pnpm run desktop:pack`：生成 Mac arm64 本地临时签名包。暂存审计 1015 个文件，实际包审计 1445 个文件，严格签名完整性检查通过；卡片、评测配置、入口、发现、OpenClaw 会话读取和 Logo 共 6 个关键资源与源码摘要一致。

本机开发源已快进到验收提交并重新执行冻结依赖安装、`desktop:prepare`。验证通过的新包保存在 `artifacts/mac/mac-arm64/EvalDock.app`，原本机旧包另行保留；复制后的实际包再次通过资源审计和严格签名完整性检查。没有替换系统应用或用户工作空间。

本节本机原生检查没有创建任务或结果：Job 和 Run 均为 0，没有模型调用或真实题目下载。隔离用户数据目录仍沿用本机已安装 Agent 和用户模型设置，不代表干净操作系统验收。临时签名包未正式签名、公证或发布；后续 VM 的 27B 单独使用合成历史材料，范围及限制见安装验收记录，真实 Agent 执行仍未验收。

日志及汇总位于 `artifacts/night-integration-20261014/verify.log`、`model-settings.log`、`package.log`、`package-inventory.json` 和 `native-package-validation.json`，不提交到公共仓库。原生控件树和截图由本轮电脑操作记录保留。

## WorkBuddy 5.7.7 当前诊断

本机实际安装身份为 `com.tencent.workbuddy.mac`，版本与构建均为 5.7.7。启动前没有 WorkBuddy 进程，现有检查返回 `UNAVAILABLE / WORKBUDDY_NOT_CONNECTED`，三个 readiness 均为 false。

通过原有启动连接入口打开该安装，使用既有回环端口 18491；调用桥、事件基础接口和现有登录状态检查通过，返回 `READY`，三个 readiness 为 true，协议为 `workbuddy.session-port/v1`。原生 App 详情显示同一版本及 READY。检查没有创建会话、调用模型、改变登录或新增协议。

本次确认了当前未连接条件和恢复路径。原截图没有原始原因码、日志和操作步骤，不能把这次结果写成已经复现或定位原截图的历史根因；待办 06 保留该限制，真实执行、证据采集、评分和报告另行验收。

## 开发 VM 同步与验证

实际连接目标为已有别名 `evaldock-dev`，测试工作树为 `~/Projects/EvalDock-app`，分支 `app`。同步前为 `f200338`，有交接对应的 14 个修改文件与原图；原文件和备份共 15 项摘要逐项一致。6 个与本机不同的文件按各自基线核对后，确认原功能均在本机整合中保留，没有用同名文件覆盖未核对的改动。

先保留 VM 文件备份、差异补丁、清单和 stash，再经 Git bundle 快进到 `2a456e1`。两端 425 个 Git 文件 SHA-256 一致；VM 检查后工作区干净。原 `~/Projects/EvalDock` 工作台及 VM 用户配置、密钥、真实题库和结果保留；构建产物在 VM 重新生成，同步没有启动评测。

VM 使用 Node 24.19.0、pnpm 11.24.0，实际执行并通过：

```sh
pnpm install --frozen-lockfile
pnpm run verify
node --test workbench/lib/model-settings.test.mjs
pnpm run desktop:prepare
```

发布边界、类型检查、构建、契约 329 项（0 失败、0 跳过）、Python 5 项及模型设置 4 项通过。桌面暂存审计 1015 个文件，6 个关键运行资源摘要与源码对应。VM 原生 Agent 的实际执行、采集、评分和报告仍未验证。

本机忽略目录保存 `vm-synced-content.json`、`vm-validated-content.json`、`vm-install.log`、`vm-verify.log`、`vm-model-settings.log`、`vm-desktop-prepare.log`；VM 自身也保留原备份和本轮日志。后续仅状态文档修改再次同步并核对摘要，不重复表述为新的源码或真实业务验收。

## 剩余问题与继续条件

1. **06 历史故障：** 仍需原 5.7.7 故障的操作步骤、实际目标、原因码、检查阶段和日志，才能判断与当前恢复场景是否相同；当前 READY 不能补造历史根因。
2. **业务验收：** 14、18B、17、21B 等待明确的 1–3 道授权题、对应私有参考或可追溯既有结果。15、16、19、20、25B 还需要明确实际 Agent、环境、调用及费用范围。
3. **安装：** 27B 的实际包手动替换已完成限定验收；24 仍需在 VM 获得管理员执行入口或创建并登录新系统用户。开发用户临时目录不能替代干净安装，后续正常菜单退出及原生报告点击另保留未验限制。
4. **正式发行及后续功能：** 28–33、35B 和 Claude 评测适配器 36 按各自范围保留；Windows 适配继续暂停。

已有历史验收适用于各自旧基线；本机和 VM 检查只覆盖对应记录中的场景。24、27B 已由用户明确恢复无真实模型验收，其他四项原暂停任务、真实运行、正式发行及 Windows 工作未恢复。
