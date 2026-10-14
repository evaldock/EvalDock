# EvalDock App 原改动恢复与夜间整合

2026-10-14，本轮接续夜间问题核对，恢复原工作树材料并整合到已通过 CI 的 App 基线。Windows 适配继续暂停；真实业务评测、正式发行及原六项暂停事项没有恢复。

## 来源和整合范围

- 夜间远端基线为 `de8b4800f9758df0cec647e7d9b357a3f42002af`，产品代码最后修改于 `dff85f9`。
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

原生检查没有创建任务或结果：Job 和 Run 均为 0，没有模型调用或真实题目下载。隔离用户数据目录仍沿用本机已安装 Agent 和用户模型设置，不代表干净操作系统验收。临时签名包未正式签名、公证或发布；实际升级和真实 Agent 执行仍未验收。

日志及汇总位于 `artifacts/night-integration-20261014/verify.log`、`model-settings.log`、`package.log`、`package-inventory.json` 和 `native-package-validation.json`，不提交到公共仓库。原生控件树和截图由本轮电脑操作记录保留。

## WorkBuddy 5.7.7 当前诊断

本机实际安装身份为 `com.tencent.workbuddy.mac`，版本与构建均为 5.7.7。启动前没有 WorkBuddy 进程，现有检查返回 `UNAVAILABLE / WORKBUDDY_NOT_CONNECTED`，三个 readiness 均为 false。

通过原有启动连接入口打开该安装，使用既有回环端口 18491；调用桥、事件基础接口和现有登录状态检查通过，返回 `READY`，三个 readiness 为 true，协议为 `workbuddy.session-port/v1`。原生 App 详情显示同一版本及 READY。检查没有创建会话、调用模型、改变登录或新增协议。

本次确认了当前未连接条件和恢复路径。原截图没有原始原因码、日志和操作步骤，不能把这次结果写成已经复现或定位原截图的历史根因；待办 06 保留该限制，真实执行、证据采集、评分和报告另行验收。

## 同步和剩余边界

开发 VM 已恢复连接，并保留原目录 `~/Projects/EvalDock` 及其工作台。同步目标仍为 `evaldock-dev` 的 `~/Projects/EvalDock-app`，分支 `app`。完成同步后单独记录两端提交、内容摘要、依赖安装、标准检查和桌面资源更新结果；原始数据、配置、密钥和题库不参与源码覆盖。

后续优先完成同步验证，再确认获准的业务材料和运行范围。原六项暂停任务、正式发行及 Windows 工作不因本次整合自动恢复。已有历史验收适用于各自的旧基线；新的本机检查只覆盖本节列出的整合版场景。
