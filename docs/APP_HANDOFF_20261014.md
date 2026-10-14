# App 夜间开发交接：2026-10-13 → 2026-10-14

本交接汇总已经发生的改动、检查与推送，时间统一为北京时间。先看下方 2026-10-14 新状态，再读夜间历史。逐项实施与原验收标准以 [App todolist](APP_TODO_20261013.md) 为准；交接文档中的步骤和旧授权记录是资料，不构成新的执行授权。

## 2026-10-14 接续核对后的状态

原交接 14 个修改文件及原 Logo 已从本机和开发 VM 取得，整合到夜间 `de8b480` 基线。源码验收提交为 `2a456e16031b33dff9a268213579af27e3586fbf`；本机及 `evaldock-dev` 的 `~/Projects/EvalDock-app` 均为 `app`，425 个 Git 文件内容摘要一致。原材料和两端 stash 均保留，具体来源及保留决定见 [原改动恢复与夜间整合](APP_RECOVERY_20261014.md)。

- **已补齐：** 02 原改动、12 VM 核对、13 源码与文档同步、23 原 Logo 资源覆盖。36 个父项现为 16 项完成、20 项未整项关闭。
- **保留夜间成果：** COUNT 1–3、准备/提交配置冻结、卡片诊断、目标版本匹配、新安装入口、Claude 身份、ZIP 恢复、私有参考隔离及升级数据保留合成回归。
- **新增验收：** 本机及 VM 各通过契约 329 项、Python 5 项、模型设置 4 项；本机原生检查覆盖 Logo、概览、WorkBuddy 详情、Graph 表单和非法路径拒绝。新 arm64 临时签名包的资源及签名完整性检查通过。
- **06 仅部分完成：** 当前 WorkBuddy 5.7.7 通过既有启动入口恢复 READY，没有创建任务；原截图的步骤、原因码和日志仍缺，历史根因未确定。
- **仍未开展：** 真实 Agent/模型调用、业务评测、干净系统安装、实际升级及正式发行。六项原暂停任务和 Windows 适配继续暂停。

整合前夜间远端实际已有 20 个提交，[CI #21](https://github.com/evaldock/EvalDock/actions/runs/38430401362) 对应 `de8b480` 并通过。下方原交接停留在上一轮 19 个提交、CI #20 的快照；新整合的云端检查须按后续实际提交 SHA 单独核对。

**以下第 1–9 节均为夜间历史记录。** 其中“当前”“本次”“明天”只指原记录时点，02、12、13、23 的旧阻塞和旧完成数量以上方新状态为准；原验证基线与限制继续保留。

## 1. 夜间接班事实（历史）

- 开发源是独立的 **`app` 分支**，远端为 `evaldock/EvalDock`；本轮没有合并到 `main`，也没有合入起点核对时主线另有的四个提交。
- 夜间起点：`da5c97cab13fdcf01557d1e2a7ac4df05ee16ea1`。当前已上传的交接基线：**`c8057b6b19ac1084053305adf2cf6c494563c9d5`**，起点之后共 19 个提交、26 个仓库文件发生变化。
- 最新正常快进推送为 `21303b4 → c8057b6`，未强推；仅同步 todolist 与交接文档中的 CI #19、截至 `21303b4` 的 18 个提交和无遗漏代码核对记录及验收边界，两个文档 blob 均与本地该提交一致。产品代码仍为 `dff85f9`，没有新增功能或验收项。
- **[CI #20 已通过](https://github.com/evaldock/EvalDock/actions/runs/38429044601)**，对应上述完整 SHA；北京时间 2026-10-14 00:15:46 启动，00:16:48 更新为 `completed / success`。代码树为 `0dea34c90733dc82959fba167c1a66e2deea796b`，清单 blob 为 `62fe8f327bc8c1d324226c7c0a574d1f3746e514`，交接 blob 为 `833fb0df657988e5cf6fc44e763f70081690d9c5`。CI #19 仍只对应 `21303b4`；CI #17 和原生合成证据保留 `dff85f9` 原修复基线，不能改称本次重新验收。
- “上传成功”在本文中指 **GitHub `app` 上的源码、测试及文档提交**。本地 App 安装包、截图、控件树和原始测试日志位于忽略目录，未上传为 Release 或 Git 文件，开发 VM 也未同步。
- 全部 36 个父项中，按原限定标准整项关闭 12 项，未整项关闭 24 项。12 项为 P0 的 01、03、04、05、07、08、10、11，以及 P1 的 09、22、26、34；其中 22 仅完成本地临时签名打包与资源审计。另有六个 A 部分已完成，父项仍未关闭。后续审核发现的 07/08 两处卡片缺陷已在 `dff85f9` 补修并完成限定合成验收；没有因此新增关闭业务、安装或发行项。
- 当前可立即独立开发剩余 **0 项**。14、18B、17、21B、24、27B 已按用户要求暂停开发及验收准备，等明天沟通后明确恢复范围；02、06 保持阻塞。真实评测、其他 P1 和全部 P2 均不推进。

**交接文档自身的交付边界：** 初版 `2758d1a` 随 `dff85f9` 推送，`e834218`、`21303b4`、`c8057b6` 三次状态同步也已推送，分别通过 CI #18、#19 和 #20。当前这次记录 CI #20 与提交完整性的文档修改另作本地提交，不计入上述 19 个已推送提交；尚未推送、没有对应 CI。源码同步、合成验证、真实验收与正式发行分别记录。

## 2. 已提交并进入远端 app 的内容

以下 19 个提交均在已核对的远端基线历史内。三个中间提交随 `d911965` 一起推送，由 CI #12 验证该轮组合，不能说它们各自都有独立 CI 运行。

| 提交 | 实际内容 | 对应云端检查 |
| --- | --- | --- |
| [843f503](https://github.com/evaldock/EvalDock/commit/843f5038e4e5d2e899f0be47b8efac34f6ec88ab) | P0：COUNT 1–3、准备/提交配置冻结、卡片诊断与目标绑定、回归测试、`app` CI 触发 | [#5](https://github.com/evaldock/EvalDock/actions/runs/38395232459)，成功 |
| [72322fc](https://github.com/evaldock/EvalDock/commit/72322fced86d563e00918c761e9e902a5ad7d5f5) | 记录前轮推送、CI 及 P0 阻塞 | [#6](https://github.com/evaldock/EvalDock/actions/runs/38396233574)，成功 |
| [0fcdc99](https://github.com/evaldock/EvalDock/commit/0fcdc997498cac0ea088fa5dfc32a63b8ab55b24) | 修复标准/手选模式下应隐藏标签仍显示的问题，记录原生合成验收 | [#7](https://github.com/evaldock/EvalDock/actions/runs/38399003718)，成功 |
| [d4392b1](https://github.com/evaldock/EvalDock/commit/d4392b15b629bdfe5113bea3d7050b54545e8cb6) | 根据限定验收与 CI 关闭 P0 11，保留 02、06 | [#8](https://github.com/evaldock/EvalDock/actions/runs/38399809848)，成功 |
| [8d10a4e](https://github.com/evaldock/EvalDock/commit/8d10a4e8676ca4ae1a4c6db7f46f08043080144a) | 记录只做可独立完成内容的边界 | [#9](https://github.com/evaldock/EvalDock/actions/runs/38400393165)，成功 |
| [968b06f](https://github.com/evaldock/EvalDock/commit/968b06fb85e6041289546550f442963459a6d369) | P1 独立性、实施步骤、依据、验收及停止点清单 | [#11](https://github.com/evaldock/EvalDock/actions/runs/38402549055)，成功 |
| [198a0a0](https://github.com/evaldock/EvalDock/commit/198a0a0b849f7a3504c7cdef2842f330e868d3b1) | 34：App 分支接班入口、工具链和命令前提 | 随 `d911965`，CI #12 |
| [1aa00ce](https://github.com/evaldock/EvalDock/commit/1aa00ce3dae317613178634bbcf022855b5241db) | 09：区分 Claude CLI/桌面安装身份、版本及元数据异常 | 随 `d911965`，CI #12 |
| [6443455](https://github.com/evaldock/EvalDock/commit/6443455636f6b28604166478185b919143047cfa) | 26：新增 ZIP 回滚、备份恢复、取消等三项回归；该干净基线还用于 22 的本地打包 | 随 `d911965`，CI #12；安装包本身未上传 |
| [d911965](https://github.com/evaldock/EvalDock/commit/d91196574ae81ae99081d6fde8030555f617442e) | 记录 34、09、26、22 的验证及限定关闭 | [#12](https://github.com/evaldock/EvalDock/actions/runs/38406581974)，成功 |
| [a5aa904](https://github.com/evaldock/EvalDock/commit/a5aa90489f4b64923becee456c6dd983a4c66949) | 六项 A：两份测试、证据索引模板、事实说明及 todolist；未改产品运行逻辑 | [#13](https://github.com/evaldock/EvalDock/actions/runs/38410931110)，成功 |
| [dac98fa](https://github.com/evaldock/EvalDock/commit/dac98fae54da09e11c0994e20146f0317be03c20) | CI #13、剩余待办及材料/授权清单 | [#14](https://github.com/evaldock/EvalDock/actions/runs/38413152644)，成功 |
| [80c4827](https://github.com/evaldock/EvalDock/commit/80c4827829dd5258edec8fce46546c1cacd43d0a) | CI #14、“立即独立开发剩余 0 项”和六项条件事项 | [#15](https://github.com/evaldock/EvalDock/actions/runs/38415712219)，成功 |
| [736f9e9](https://github.com/evaldock/EvalDock/commit/736f9e9b09303af787e07d868bdcfe0442e2d541) | CI #15、六项最低条件/分工/验收/停止点，以及用户最新暂停指令 | [#16](https://github.com/evaldock/EvalDock/actions/runs/38417995694)，成功 |
| [2758d1a](https://github.com/evaldock/EvalDock/commit/2758d1a56a7ae8b2bfb6240f251da4844b03a578) | 初版夜间交接文档，未新增产品实现 | 随 `dff85f9`，CI #17；没有独立 CI |
| [dff85f9](https://github.com/evaldock/EvalDock/commit/dff85f909775522d99c052dd0929d6b8e2d5077e) | 07/08：路径冲突不借用旧版本，恢复新安装接入入口；新增 4 项回归并更新 todolist | [#17](https://github.com/evaldock/EvalDock/actions/runs/38424535648)，成功 |
| [e834218](https://github.com/evaldock/EvalDock/commit/e834218d03e1456f2a9c634aca4ce3380287f2cb) | 仅同步两份文档中的 CI #17、卡片修复及限定验收状态 | [#18](https://github.com/evaldock/EvalDock/actions/runs/38425921230)，成功 |
| [21303b4](https://github.com/evaldock/EvalDock/commit/21303b492b0ff1e63928c31e18198d1376c002cb) | 仅记录 e834218 推送、CI #18 及合成/真实验收边界 | [#19](https://github.com/evaldock/EvalDock/actions/runs/38427971719)，成功 |
| [c8057b6](https://github.com/evaldock/EvalDock/commit/c8057b6b19ac1084053305adf2cf6c494563c9d5) | 仅记录 CI #19、截至 21303b4 的 18 个提交已推送及无遗漏代码核对结果 | [#20](https://github.com/evaldock/EvalDock/actions/runs/38429044601)，成功 |

旧 CI 核对记录保留；本次只重新读取 CI #20 的准确提交与日志，不为旧版本或中间提交补造新验收。

**遗漏代码复核（2026-10-14，本次文档编辑前）。** 本仓库 `app`、`origin/app` 与 GitHub 分支均为 `c8057b6`；夜间起点至该提交共 19 个提交，reflog 中当晚的 19 个 commit 均确认是远端 `app` 的祖先。工作区无暂存/未暂存改动、无未跟踪文件，stash 为空，所有本地分支均无未推送提交；本仓库仅有当前一个注册工作树。检查使用 `git status --porcelain=v1 --untracked-files=all`、`git stash list`、`git log --branches --not --remotes`、`git worktree list --porcelain` 及逐提交祖先检查。未发现应补交的代码；本次新文档提交另计，不将编辑前快照表述为它也已推送。

忽略目录 `node_modules/`、`dist/`、`src/agent-trace/native-probe/lib/`、`artifacts/` 为依赖、构建产物和本地证据，不一并上传。本结论仅覆盖当前仓库及其注册工作树；02 所缺原工作树的 14 个改动和图片仍未找回，不能据此认定已恢复或已上传。

## 3. 具体修改了哪些文件和行为

以下路径覆盖起点至 `c8057b6` 的 26 个变化文件；打包产物不计入 Git 文件数量。`dff85f9` 只修改卡片模块、对应回归和 todolist 三个既有文件；`e834218`、`21303b4` 和 `c8057b6` 只更新清单与交接两份文档。

| 变化范围 | 文件 | 实际变化 |
| --- | --- | --- |
| 自动选题和请求 | [app-evaluation.js](../workbench/design-prototypes/app-evaluation.js)、[app.js](../workbench/design-prototypes/app.js)、[app.html](../workbench/design-prototypes/app.html)、[online-selection.mjs](../workbench/lib/online-selection.mjs) | 默认 COUNT 1，可选 1–3；冻结准备和提交配置，准备中禁用相关控件；线上准备拒绝超限计划，保留标准和手选入口 |
| Agent 卡片 | [agent-cards.js](../workbench/design-prototypes/agent-cards.js)、[product-pages.js](../workbench/design-prototypes/product-pages.js) | 展开原始原因、目标和版本，恢复入口按状态展示；按当前目标投影；审核后补修明确路径冲突时的版本回退，并恢复失效旧配置下新安装的接入入口 |
| 显示与 Claude 发现 | [app.css](../workbench/design-prototypes/app.css)、[agent-discovery.mjs](../workbench/lib/agent-discovery.mjs) | 修复隐藏标签；区分 Claude Code CLI 与 Claude 桌面版，分别读取对应元数据，保留版本未知/读取失败的安装身份；没有新增评测适配器 |
| 回归测试 | [app-controls.test.mjs](../tests/contracts/app-controls.test.mjs)、[online-selection.test.mjs](../tests/contracts/online-selection.test.mjs)、[agent-discovery.test.mjs](../tests/contracts/agent-discovery.test.mjs)、[library-archive.test.mjs](../tests/contracts/library-archive.test.mjs) | 配置边界、卡片行为、发现身份、ZIP 失败回滚/取消/备份恢复；使用受控输入，不执行真实 Agent；`dff85f9` 新增保留 ID 改路径、新安装接入、全部配置去重及操作优先级 4 项回归 |
| 六项 A 的测试 | [private-scoring.test.mjs](../tests/contracts/private-scoring.test.mjs)、[desktop.test.mjs](../tests/contracts/desktop.test.mjs) | 加强私有参考隔离断言；补合成配置/题库/历史结果的完整摘要及旧报告量表保留回归 |
| CI 与资源暂存 | [ci.yml](../.github/workflows/ci.yml)、[stage-desktop.mjs](../scripts/stage-desktop.mjs) | `app` 推送触发原有 CI；新增前端运行模块纳入桌面暂存 |
| 计划和证据模板 | [APP_TODO_20261013.md](APP_TODO_20261013.md)、[AGENT_VERSION_VALIDATION.md](AGENT_VERSION_VALIDATION.md) | 36 项实施/验收/依据、实际结果及阻塞；真实业务证据索引字段、模板和只读关联检查 |
| 接班与事实说明 | [MAC_APP.md](MAC_APP.md)、[NATIVE_SETUP.md](NATIVE_SETUP.md)、[BENCHDOCK.md](BENCHDOCK.md)、[RELEASE.md](RELEASE.md)、[SUPPORT.md](../adapters/SUPPORT.md)、[README.md](../README.md)、[README.zh-CN.md](../README.zh-CN.md) | 对齐分支、工具链、COUNT/标准选题、源码示例与桌面空库、发现与适配、私有参考以及本地打包/正式发行边界 |
| 本交接 | [APP_HANDOFF_20261014.md](APP_HANDOFF_20261014.md) | `2758d1a` 新增交接、`e834218` 同步修复状态、`21303b4` 记录 CI #18、`c8057b6` 记录 CI #19，均已进入远端；本次 CI #20 与提交复核记录另作未推送文档提交 |

未修改 Judge 评分规则、适配器协议、用户真实配置或历史业务报告；ZIP 产品运行逻辑本轮没有重写，相关新增内容是回归测试。没有恢复原交接丢失的 14 个改动和图片，也没有将同名新改动冒充原成果。

## 4. 已验收的范围，以及不能据此声称的结果

| 事项 | 真正操作、核验过的内容 | 验收范围和剩余限制 |
| --- | --- | --- |
| P0 05、07、08、10、11（原验收） | 契约、浏览器及隔离 Electron 原生交互；题数 1–3、模式隐藏、未知原因详情、恢复入口、两阶段目标/配置一致；取消/失败正式提交为 0，成功场景合成提交 1 次 | 后端为合成服务；P0 原生后半程使用 `--disable-gpu`，只证明软件渲染下该段交互；没有真实 Agent、模型、下载或任务报告。原始请求另保留排障期间一次 COUNT 3 合成提交，没有删记录凑数 |
| 34 | 接班入口、命令定义、工具链、文档链接和发布边界核对 | 没有因编写步骤就声称真实服务、VM 已运行 |
| 09 | 合成 CLI/package 与桌面 plist 被实际发现器读取；原生双安装、版本异常/恢复、重新扫描通过，未执行候选 Claude 命令 | 默认渲染；只完成身份和显示，Claude 仍待适配，未执行真实 Claude |
| 26 | 隔离工作空间真实读写合成 ZIP；合法导入、损坏拒绝、忙碌/记录错误/下载/准备门禁、取消与重试；摘要核对旧库/配置保留及备份 | 默认渲染；没有业务题导入或真实评测。定向 10/10 包含在全量中，不重复累计 |
| 22 | `6443455` 上生成 arm64 `.app`，暂存 1014、实际包 1444 文件审计，严格签名完整性通过、空库 0 题，六个关键运行文件与源码匹配 | 仅本地 ad-hoc 临时签名，明确未发布；不是 Developer ID、公证、默认 Gatekeeper、干净系统安装或升级验收 |
| 18A | 假适配器/假 Judge 与唯一合成私有标识；Judge 可得到参考，Agent 工作目录和公开 JSON/HTML/前端无参考原文；零分和历史文件保留，定向 6/6 | 仅合成边界；18B 的真实授权参考核对未完成 |
| 21A | 现有索引模板；1 个合成正例通过，缺文件、ID 不符、摘要不符、重复、越界五个反例按预期拒绝 | 索引关联检查不验证答案、评分质量或授权；21B 未填真实业务结论 |
| 23A | 18 个现有页面资源的 Git/源码/包内/加载副本摘要对应；原生加载无错误、10 个 Agent 图标可见 | 默认渲染；原 logo 未找回，23B 未完成 |
| 25A | 原生缺模型→设置、空库→测试集、坏 ZIP 拒绝、好 ZIP 导入 1 道合成题、配置/备份保留、缺就绪 Agent 门禁 | 默认渲染；只有一次受控 `pi/run` 回执，记录页仍为 0、无结果目录；25B 首轮真实评测未完成 |
| 27A | 临时工作空间升级逻辑；合成配置/题库/结果摘要保留，旧报告原量表、零分、UNASSESSABLE、ERROR 可读且不改原文件；定向 6/6 | 没有实际旧/新 App 替换，27B 未完成 |
| 35A | README、支持说明、Mac 及发布文档当前事实对齐 | 没有新增真实支持结论；35B 新发行说明未做 |

### 审核后两个卡片问题的修复状态

两处缺陷均已在 `dff85f9` 实现并推送。验收结论仅覆盖已复现条件、合成回归及受控原生交互：

| 问题 | 实际修复与验证 | 状态及限制 |
| --- | --- | --- |
| 08：目标 ID 保留但路径改变时借用旧版本 | 有明确安装路径时优先按路径匹配，旧 ID 不覆盖冲突；缺匹配显示“版本未读取”。回归覆盖当前安装存在/缺失及扫描顺序变化；默认渲染原生窗口确认旧版本不再出现 | 代码已实现、合成验证通过、源码已推送、CI #17 通过；不是实际 Agent 版本兼容性通过 |
| 07：无效旧配置挡住新安装入口 | 保留旧目标诊断/重新检查，同时为未接入安装提供绑定新 ID 的按钮；排除所有已配置目标，保留就绪、启动、模型及清理操作优先级。默认渲染原生点击仅产生 1 次合成 `discovery/connect`，载荷为新安装 ID；刷新后新目标及版本对应，模型门禁保留 | 代码已实现、合成验证通过、源码已推送、CI #17 通过；接入回执来自替换后端，不证明真实安装可连接或可评测 |

新增 4 项回归中，两个缺陷用例先在旧实现失败、修复后通过。修复轮本地 macOS 契约 322/322、Python 5/5、模型设置 4/4；Linux CI 为 321 通过、1 平台跳过，不能混写。原生验证保留实际 main/preload 和页面，7 个文件摘要对应修复源码，真实 Agent/模型调用及评测提交均为 0，无结果目录；测试窗口和服务已关闭。这一小范围默认渲染验证不覆盖其他 P0 场景，不消除原 P0 软件渲染限制。没有重新打包安装包、干净安装或正式发行。

原生测试保留 Electron main/preload、页面及相关工作空间/导入实现，只在隔离副本替换后端为受控响应。23A/25A 使用实际包提取的资源和代码；原包与正式仓库后端不因该测试修改。桌面窗口确实操作过，但其模型/Agent 状态为合成条件；“评测已启动”的受控回执不代表真实执行。

## 5. 测试证据与核对方法

### 云端证据：已推送提交的 CI

| 基线 | 契约测试（Linux） | Python / 模型设置 | 证据 |
| --- | --- | --- | --- |
| `843f503`、`0fcdc99` | 各 310 项：309 通过、1 跳过、0 失败 | 各 5/5、4/4 | [CI #5](https://github.com/evaldock/EvalDock/actions/runs/38395232459)、[CI #7](https://github.com/evaldock/EvalDock/actions/runs/38399003718) |
| `d911965` | 317 项：316 通过、1 跳过、0 失败 | 5/5、4/4 | [CI #12](https://github.com/evaldock/EvalDock/actions/runs/38406581974) |
| `a5aa904` | 318 项：317 通过、1 跳过、0 失败 | 5/5、4/4 | [CI #13](https://github.com/evaldock/EvalDock/actions/runs/38410931110) |
| `736f9e9` | 318 项：317 通过、1 跳过、0 失败 | 5/5、4/4 | [CI #16 任务日志](https://github.com/evaldock/EvalDock/actions/runs/38417995694/job/115367466415) |
| `dff85f9` | 322 项：321 通过、1 跳过、0 失败；新增 4 项卡片回归均通过 | 5/5、4/4 | [CI #17 任务日志](https://github.com/evaldock/EvalDock/actions/runs/38424535648/job/115390335282) |
| `e834218` | 322 项：321 通过、1 跳过、0 失败；产品代码与 `dff85f9` 相同 | 5/5、4/4 | [CI #18 任务日志](https://github.com/evaldock/EvalDock/actions/runs/38425921230/job/115395155784) |
| `21303b4` | 322 项：321 通过、1 跳过、0 失败；产品代码与 `dff85f9` 相同 | 5/5、4/4 | [CI #19 任务日志](https://github.com/evaldock/EvalDock/actions/runs/38427971719/job/115402284272) |
| `c8057b6` | 322 项：321 通过、1 跳过、0 失败；产品代码与 `dff85f9` 相同 | 5/5、4/4 | [CI #20 任务日志](https://github.com/evaldock/EvalDock/actions/runs/38429044601/job/115406053504) |

这些 CI 的发布边界、类型检查和构建通过。唯一跳过项是 [macOS 签名检查的平台条件](../tests/contracts/desktop-signature.test.mjs)：`desktop signature check rejects missing sealed resources`。不能写成 Linux 上 318 或 322 项全部通过。CI 不包含原生窗口操作、真实 Agent/业务验收或正式发行验收。

### 本地证据：已发生的合成测试和受限原生操作

以下是仓库根目录下的**本地忽略路径**，不是 GitHub 附件；新克隆不会自带。今晚开发机器留存记录，具体保管/转交人待用户确认。需要原始截图或日志时由保管者通过受控方式交接，公共文档仅保留摘要和定位信息。原有汇总、卡片修复日志与原生记录按此前核对结果保留；本次只核对 CI #20、文档同步和遗漏代码证据，不重跑产品验收。

| 本地路径 | 可核对内容 |
| --- | --- |
| `artifacts/native-p0-20261013/verify.log`、`model-tests.log`、`request-validation.json`、`source-hashes-after-fix.json` | P0 本地 macOS 契约 310/310、Python 5/5、模型 4/4；取消/失败/成功合成载荷及资源摘要。原生控件树/截图在同目录 |
| `artifacts/native-p1-20261013/09-request-validation.json`、`09-verify.log`、`26-targeted.log`、`26-native-final.json`、`26-verify.log`、`26-model-tests.log` | 09 只有三次合成重新扫描；26 库/配置/备份核对；最终本地契约 317/317、Python 5/5、模型 4/4 |
| `artifacts/native-p1-20261013/22-package-validation.json`、`22-bundle-files.json`、`22-pack.log` | 原打包基线、资源清单、空库、签名和构建记录；不是本轮重新验包 |
| `artifacts/p1-partial-20261013/18-private-scoring.log`、`21-index-validation.json`、`23-resource-map.json`、`23-25-native-validation.json`、`27-workspace-upgrade.log` | 六项 A 的对应局部证据；原生资源 18 个、错误 0、合成提交 1、真实 Agent/模型/下载 0、无结果目录 |
| `artifacts/p1-partial-20261013/verify.log`、`model-settings.log` | 六项 A 阶段的本地契约 318/318、Python 5/5、模型 4/4，0 失败和跳过；不与历次/定向数量相加 |
| `artifacts/p1-partial-20261013/ci-736f9e9.json` | 历史推送对应 CI #16、完整提交、远端树/清单摘要、任务步骤与测试数量 |
| `artifacts/card-fixes-20261013/verify-pinned.log`、`model-settings.log`、`stage.log` | 卡片修复的 pnpm 11.24.0 全量检查：契约 322/322、Python 5/5、模型 4/4；1014 文件资源暂存审计，不是新安装包审计 |
| `artifacts/card-fixes-20261013/01-version.txt`、`02-new-install.txt`、`03-connected.txt/png`、`native-requests.jsonl`、`native-validation.json` | 默认渲染原生合成卡片操作、1 次新安装接入载荷、0 真实执行、7 个源码摘要及服务关闭记录 |
| `artifacts/card-fixes-20261013/ci-dff85f9.json` | CI #17、完整提交、远端树和三个同步文件 blob、任务步骤及测试数量 |
| `artifacts/card-fixes-20261013/ci-e834218.json` | CI #18、准确提交、两个文档 blob 及测试数量；不新增真实验收结论 |
| `artifacts/card-fixes-20261013/ci-21303b4.json` | CI #19、准确提交、两个文档 blob、测试数量及编辑前 18 个提交均已推送/工作区干净的核对记录 |
| `artifacts/card-fixes-20261013/ci-c8057b6.json` | CI #20、准确提交、两个文档 blob、测试数量及编辑前 19 个提交均已推送/工作区干净/无未推送提交的核对记录 |

本地验证环境记录为 Node 24.19.0、pnpm 11.24.0、Electron 44.7.0；CI 使用 Ubuntu、Node 24、pnpm 11.24.0。P0 的软件渲染限制不消失；后来 P1 的默认渲染验收只覆盖其列出的场景，不能倒推所有 P0 场景都已在默认 GPU 重验。

便于核验原交接留存证据的 SHA-256（初版整理时计算，本次未重算）：

| 文件 | SHA-256 |
| --- | --- |
| `artifacts/native-p0-20261013/request-validation.json` | `964f477e4a60ef93dd287529946ebde683fdcae9b5629ce13077c2d16b3dabb8` |
| `artifacts/native-p1-20261013/26-native-final.json` | `22762e9a0b11bbf2e733e49c50ef32136e15eda0a52e3891a959a261a6c61f29` |
| `artifacts/p1-partial-20261013/23-25-native-validation.json` | `46f52b1dac28864d74322508783154cc0246dc430f6015c030078a05173fbad7` |
| `artifacts/p1-partial-20261013/verify.log` | `5bf101ee8dd20ee0aec30827342c3488d1f27840df592d2e8c025eb27bc423ae` |

历史实际包位置为 `artifacts/mac/mac-arm64/EvalDock.app`；原验收记录中的 `app.asar` SHA-256 为 `9b757dad0371a721471e177eb8b7a74ee8aaff30f12450a0e3f2f9d89c171d19`，资源清单 SHA-256 为 `9c5b71f690613fe3908312926673bf20e378de2780bf1dcddec9c3f511e51045`。本次没有重算安装包摘要、安装或启动该包；使用前需按获准范围核对，不能据历史摘要宣称它就是已验收的新旧升级包。

## 6. 未完善内容、所缺材料与待确认的责任方

这里的“责任方”是待确认的材料/环境持有角色，并非已指派的同事。当前没有足够依据填写个人姓名、承诺交付时间或认定必须由他人开发。恢复开发须以材料及范围确认后的实际缺陷为依据，不能把“缺证据”直接改写成“需要补功能”。

### 六项明确暂停的分段事项

| 项目 | 最低条件及用户/同事需提供 | 恢复后 Codex 可做的部分 | 停止点与责任方 |
| --- | --- | --- | --- |
| 14 | 至少一题获准读取的题目、受控位置、来源版本/Case ID 和任务要求；完成准备另需输入、参考、依赖及候选 Agent 身份 | 文件清单/摘要、格式和版本核对；具备必要文件后隔离加载校验，登记缺口 | 不下载、导入当前库或调用 Agent；用户/业务题持有人确认材料及授权，具体人待确认 |
| 18B | 与题目对应的真实参考、来源、授权、版本及受控位置 | 参考摘要、题目对应关系和已有服务端加载关系核对 | 不调用 Agent/Judge，不关闭真实运行边界验收；用户/参考持有人待确认 |
| 17 | 获准只读的既有业务目录、run/Case 身份、已知代码/环境/目标基线及实际报告或交付物 | 核对已有文件、引用、原量表、状态；缺 Trace/Judge/参考则记缺证 | 不重评、不补跑、不改原文件；用户/原结果持有人待确认 |
| 21B | 已有真实证据、可追溯身份和允许写入索引的受控目录 | 复用模板填写已知部分、计算摘要；必需关联完整后才运行现有检查 | 不造占位证据，不以索引通过代替业务正确；用户/证据持有人待确认 |
| 24 | 包核对需明确包或可构建基线；安装另需干净 Mac/新系统用户/VM、架构、归属及访问范围 | 获准后核对包/来源；必要时按明确基线构建；环境就绪再验安装、初始空库/配置和设置入口 | 无干净环境停在包记录；真实接入/兼容性/模型/下载前停止；用户或设备管理员确认环境，凭据由其输入 |
| 27B | 明确旧包历史基线、新候选基线与独立环境；只有一侧可先核对一侧 | 获准后核对或按确定基线构建并注明重建性质；旧侧合成数据准备；两包齐备后手动替换及摘要/旧报告核对 | 缺环境停在包记录，缺新包停在旧侧准备；不碰生产数据、不自动更新。用户/包保管者/环境管理者具体人待确认 |

完整局部验收标准和依据已在 [六项分段清单](APP_TODO_20261013.md#当前可立即独立开发数量与六项条件事项) 中，全部仍暂停。无需等六项材料全齐才能将来恢复某一段，但日期到来或同事上班不会自动恢复，已有 A 部分不重复开发。

### 其他未关闭项

| 待办 | 已做与未完成之处 | 需要谁提供什么；当前处理 |
| --- | --- | --- |
| 02、关联 23B | 原交接 14 个改动文件和 1 个图片未恢复，当前资源检查不代表找回原 logo | 原工作树/补丁/备份持有人提供原材料及基线，具体人待确认；保持阻塞，不扩大搜索或制作替代成果 |
| 06 | 仅有本机 WorkBuddy 5.7.6 的历史状态，不能解释原 5.7.7 截图 | 原故障环境/日志持有人提供 5.7.7 安装身份、实际目标、步骤、reasonCode、阶段及日志；保持阻塞，不升级/替换/改登录 |
| 12、13 | 开发 VM 连接配置未确认，源码未同步，远端独立改动未知 | 用户/VM 管理者提供现有别名、目标与工作树访问范围；有独立改动再找其持有人。当前不连接或同步，GitHub 推送不等于 VM 同步 |
| 15、16、19、20、25B | 真实兼容性、手选业务执行、自动选题实测、取消/失败收尾、真实首轮均未执行 | 用户确认目标/环境/调用及费用范围，账号或配额需其管理者支持时再确认角色。当前真实运行仍禁止，不用合成回执关闭 |
| 35B、28–33 | 新发行说明、版本渠道、正式签名/公证、候选材料、真实自动更新及异常验证未完成 | 属 P2 范围限制；今夜不开展，不提前索取签名凭据或新增发行工作 |
| 36 | Claude Code 评测适配器未开发；09 只解决发现和展示 | 当前范围之外，无新增适配器任务授权，不把支持发现写成支持评测 |

上述六项暂停、其他保留项及 02/06 合计覆盖 24 个未整项关闭父项；A 部分已交付的 18、21、23、25、27、35 只各计一个父项。没有新关闭任何条目。

## 7. 明天可直接照着执行的接班步骤

这些是对已有成果的复核和既有待办的恢复条件，不是新增任务；本次没有执行下列安装、测试、App 或 VM 操作。

1. **先核对 Git 状态和交接对象。** 在现有克隆中读取下面信息，确认远端确为 `evaldock/EvalDock`。有未提交改动或他人工作树时先保留并确认归属，不重置或覆盖。

   ```sh
   git status --short --branch
   git remote -v
   git fetch origin app
   git rev-parse origin/app
   git merge-base --is-ancestor c8057b6b19ac1084053305adf2cf6c494563c9d5 origin/app
   git log --reverse --oneline da5c97cab13fdcf01557d1e2a7ac4df05ee16ea1..c8057b6b19ac1084053305adf2cf6c494563c9d5
   git show --stat c8057b6b19ac1084053305adf2cf6c494563c9d5
   ```

   远端后续可能有新提交，不能把新 HEAD 自动当作已通过 CI #20 的对象。完整验证对象固定为 `c8057b6`；使用上方 CI 链接核对 `app`、完整 head SHA 和 `success`。

2. **需要复跑离线检查时，在独立源码目录复核该基线。** 下列新目录名必须尚不存在；安装依赖可能访问包仓库，但这些检查不启动真实 Agent 或模型。本轮没有重跑这些命令。工作树隔离只隔离源码，不等于干净操作系统，不能用来关闭 24。

   ```sh
   git worktree add --detach ../EvalDock-app-review-20261014 c8057b6b19ac1084053305adf2cf6c494563c9d5
   cd ../EvalDock-app-review-20261014
   node --version
   pnpm --version
   pnpm install --frozen-lockfile
   pnpm run verify
   node --test workbench/lib/model-settings.test.mjs
   git diff --check
   ```

   按 [现有工具链说明](MAC_APP.md) 使用 Node 24.x、pnpm 11.24.0；声明最低 Node >=22 不是所有 Node 22 已实测。`verify` 已包含发布边界、Python、类型检查、构建和契约，不要只运行依赖旧构建产物的定向测试后声称全量通过。Linux 预期有上述平台跳过，macOS 322/322 留存记录来自产品代码相同的 `dff85f9`，不是 `c8057b6` 的新本地验收；若实际不同，以新日志为准，不改写旧结果。

3. **核对原生证据，而不是把 CI 当作原生验收。** 先取得第 5 节的本地忽略目录，通过摘要及请求/资源记录检查相应场景。新克隆缺这些文件时记录“原始证据未转交”；现有 Git 文档和 CI 链接仍可复核，但不能声称已重新检查原截图。不要直接用正式后端启动 App 来重演合成验收；原受控服务、隔离条件和 P0 软件渲染限制必须保留。

4. **与对应材料/环境持有人沟通。** 按第 6 节逐项确认“谁持有、受控位置、版本/基线、可用部分、缺失部分、允许操作范围”。题目与真实参考、现成业务结果、干净环境和旧/新包各自独立确认；不能由 Codex 生成所谓真实证据来填空。凭据留在本地，由用户或管理员输入。

5. **沟通后再指定恢复条目和分段。** 六项目前全部暂停；满足某一段最低条件可只恢复那一段，未满足的继续停止。02/06 无新来源继续阻塞；不因此追加其他 P1/P2，不调用真实 Agent、Planner/Judge、不下载真实题目、不执行自动更新或正式发布。只记录实际材料支持的结果，整项标准不足时保留“局部/未验收”。

## 8. 初版交接整理记录（2758d1a，历史）

初版整理时正常推送 `736f9e9`、核对远端分支/树/清单摘要、检查 CI #16 全部步骤及日志；只读核对 14 个提交、25 个变化文件、todolist 36 项状态和已有本地证据，然后生成本文。六项开发及准备仍暂停，没有重新验包、安装、启动 App、连接 VM 或运行真实评测。本文只做链接/命令、事实一致性、差异格式及发布边界检查，不能被解释为又完成一轮产品验收。

文档检查通过：29 个相对链接/锚点、14 个提交与远端历史对应、25 个变化文件覆盖、所列本地证据存在性及四个摘要、两段 shell 命令语法、工具链与脚本、差异格式及发布边界。当时 todolist 保持 `736f9e9` 原样；该轮仅新增本文，检查记录保存在本地忽略目录 `artifacts/p1-partial-20261013/handoff-doc-validation.json`。初版当时尚未推送；后来已随 `dff85f9` 进入远端并由 CI #17 检查组合提交。此处的 14 提交/25 文件及文档检查数量仅指初版整理时的范围。

## 9. 本次文档同步范围

本次只更新 todolist 和本交接，记录 `c8057b6` 正常推送、两个文档摘要一致及 CI #20 的准确提交、日志和跳过项，并复核截至该基线夜间 19 个提交均已推送、编辑前无未提交改动且未发现遗漏代码。没有修改代码、重跑本地产品测试、启动 App、连接 VM、运行真实评测或推进其他 P1/P2。两个卡片问题沿用 `dff85f9` 的修复与合成验收结论；CI #20 通过不增加真实 Agent、安装或发行验收。02、06 保持阻塞，六项分段工作继续暂停；材料、责任方和恢复授权仍按第 6 节处理。本次新文档提交不计入前述 19 个已推送提交，尚未推送，不借用 CI #20 标成已通过云端检查。

此前文档检查记录在 `artifacts/card-fixes-20261013/docs-ci17-validation.json`、`docs-ci18-validation.json` 和 `docs-ci19-validation.json`，均只对应其原轮次。本次检查结果另存 `artifacts/card-fixes-20261013/docs-ci20-validation.json`；没有重跑产品测试，也没有新增真实验收结论。
