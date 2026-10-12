# EvalDock Mac App

桌面版新增概览、我的 Agent、测试集、评测记录和设置页面。现有工作台保留为高级入口；也可用菜单「导航 → 主界面」或 Command+1 返回。支持原有六类配置目标和 WorkBuddy；DSH 与其他被测 Agent 使用同一评测入口；执行前仍由现有控制器检查服务和插件状态。

## 开发和打包

使用项目指定的 pnpm 和 Node.js 22 以上版本：

```sh
pnpm install --frozen-lockfile
pnpm run desktop
pnpm run desktop:pack
pnpm run desktop:dmg
```

`desktop:pack` 生成当前 Mac 架构的 `.app`，`desktop:dmg` 生成安装镜像，均位于 `artifacts/mac/`。默认使用临时（ad-hoc）签名封装应用及其嵌套组件，并在签名后执行 `codesign --verify --deep --strict`，避免打包修改破坏 Electron 原始签名后被报告损坏。临时签名仅证明包内文件完整，不提供 Apple 认可的开发者身份，也不等于公证；首次打开仍可能被 macOS 拦截。对外发行并通过默认 Gatekeeper 检查，需要配置 Developer ID Application 证书、Apple 公证凭据并完成公证。不得将 `spctl` 显示 `override=security disabled` 的本机结果视为分发验收通过。应用、Dock 和安装镜像使用白色圆角方形的 EvalDock 小马头图标（`desktop/assets/icon.png` / `icon.icns`），四周保留透明边距；1024 像素 PNG 与包含各尺寸的 ICNS 使用同一图案。打包检查会核对应用图标文件与声明，防止回退到 Electron 默认图标。

图标白底宽高固定为画布的约 80.5%（1024 像素画布、824 像素圆角底、四周各 100 像素留白），与本机 Chrome 图标的可见尺寸比例一致。保留原始小马图案 `desktop/assets/pony-source.png`；需要重新生成图标时，在装有 Xcode Command Line Tools 的 Mac 上执行 `pnpm run desktop:icon`，使用固定几何模板同时更新 PNG 与 ICNS。

打包脚本只选取 Git 跟踪的运行资源、明确列出的桌面文件和编译产物；不会携带源码目录中的运行结果、下载题库、用户 Agent 配置或密钥。内置 Node 运行时用于 EvalDock，自行安装的 Agent 及 Python、浏览器等题目依赖仍需另行准备。

## 首次运行

1. 打开 App，在「设置」填写 Planner / Judge 接口及密钥。
2. 「我的 Agent」自动扫描本机安装，显示品牌图标、版本和接入状态。点击「重新扫描」更新结果；支持自动接入的安装可点击「接入评测」，立即加载并检查运行条件。自定义路径和 LangGraph 的 graph 入口仍可通过「高级配置」补充；DSH 的服务与插件管理保留在高级工作台，Agent 卡片不作为工作台入口。
3. 首次打开时，未修改的内置演示题库会自动从 Hugging Face 按需下载并校验 3 道 BenchDock 试点题，无需安装 Python 下载工具或手动导入。下载进度、取消和重试显示在概览与测试集页面；完成后开始评测默认自动选题。也可导入自己的完整本地题库，自定义题库不会被自动替换。
4. 点击「开始评测」，选择可连接的 Agent，默认由 Planner 自动选题；也可以切换为手动选择具体题目。在「评测记录」查看进度、取消任务或打开已有报告。

App 关闭时会请求取消本应用启动的评测并等待收尾。不要在任务中退出 App。缺少 Agent、登录、模型配置或外部依赖时，评测会被阻止或报告具体运行失败；下载题库不代表已具备所有执行条件。

## 本地数据与题库

工作空间位于 `~/Library/Application Support/EvalDock/workspace/`：

- `config/`：用户 Agent 配置，升级不覆盖。
- `datasets/`：当前题库，升级不覆盖。
- `dataset-history/`：每次导入前的题库备份。
- `var/evaluation-results/`：评测结果。
- `var/batch-runtime/`、`var/workbench/`：执行目录和任务状态。
- `desktop.log`：服务诊断日志。

模型密钥沿用现有的 `~/.config/evaldock/models.env`（0600 权限），与源码版共用。其余桌面运行数据独立于源码目录。程序代码随 App 启动更新到工作空间。

导入选择包含 `catalog.md` 的完整文件夹，格式与仓库 `datasets/` 一致。目前是**整体切换**，不是合并；旧题库保留在历史目录。导入拒绝符号链接和非普通文件，限制 2 GB / 100000 文件，使用核心加载器验证题目、输入和评分参考后再切换。运行中禁止导入。`evaldock-import.json` 记录导入时间、题量和 SHA-256；现有评测报告继续保存题目内容摘要。

题库仅由服务端加载，前端只读取目录元数据和公开任务要求，不返回评分参考答案。当前自动下载仅覆盖 `config/benchdock-pilot.json` 中核对过的 3 道公开题，固定发行版本并校验目录、题目及输入文件 SHA-256，复用校验通过的文件缓存和现有导入备份流程。下载失败或取消会保留原题库，自动评测等待准备完成，不静默回退为演示题评测。模型密钥不会发送给 Hugging Face；下载使用现有 HTTPS 代理环境变量或 macOS 系统 HTTPS 代理。公开题缺少私有评分材料时保留 `UNASSESSABLE`，不会变成零分。题目声明的 Python 等执行依赖仍需另行准备。完整线上目录的自动匹配、ZIP 导入、其他 Agent 的完整图形化配置和自动更新尚未实现。主界面不提供虚构运行数据。

## 验证

```sh
pnpm run verify
node --test workbench/lib/model-settings.test.mjs
```

桌面契约测试覆盖 Agent 状态失败隔离、题库校验、历史保留和导入失败后的数据完整性。真实 Agent 执行仍需在已配置环境完成一次执行、采集、评分与报告验收。

## 本机 Agent 发现

启动主界面时自动扫描，结果缓存至手动「重新扫描」。扫描 `/Applications`、`~/Applications`、PATH、Homebrew、用户级 CLI 目录和最多 20 个 NVM Node 安装。只检查已知应用/命令入口和安装元数据，不执行扫描到的命令、不启动 Agent、不读取登录凭据。CLI 符号链接按真实路径去重；不同安装位置分别显示。无权限或损坏的安装不会让整个扫描失败。

可识别 DSH、Pi、OpenClaw、Hermes、WorkBuddy、千问办公、豆包办公、Codex 和 Claude 的常见安装入口。Codex / Claude 只显示发现结果，目前没有评测适配器。LangGraph 需要用户指定实际 graph 入口，不能仅凭 Python 环境推断。非标准安装路径可能需要高级配置。

「接入评测」只接受本次重新检查后仍存在的安装，不覆盖已有配置，不启动评测、不打开调试端口，也不改变登录状态。Pi、Hermes、OpenClaw 仍使用现有适配器的模型和凭据策略；发现 CLI 并不代表可复用其所有原生模型配置。办公 Agent 的调用与事件接口、登录及连接由适配器检查，版本号不作为准入门槛。

Agent 卡片统一显示待安装、已发现或可评测状态；未发现安装时不显示配置按钮。安装路径和配置详情不在卡片展示，已有高级配置仍可从设置访问。

## 产品页面

概览展示就绪状态、准备步骤、运行中任务和最近记录。测试集支持搜索、任务预览、逐题勾选和跨测试集选题；选择结果以 SELECTED 方案提交。评测记录支持状态筛选、搜索、逐题评分和回答预览、日志、取消和已有 HTML 报告。评分保留各自量表，零分与证据不足分开显示，不合并不同标准的分数。

## 桌面应用启动

启动办公应用时移除子进程继承的 `ELECTRON_RUN_AS_NODE`，避免应用进入后台 Node 模式；主界面为已接入但未连接的千问/豆包提供「启动连接」入口。

## WorkBuddy 接口准入

WorkBuddy 的版本号用于记录，不再作为评测准入白名单。连接时检查调用桥、事件传输基础接口和登录状态；会话创建、任务提交、事件回传及清理由实际运行验证。未连接或接口缺失会显示具体原因，基础检查通过不等同于所有任务已通过兼容验收。

千问与豆包同样按接口检查准入，豆包额外检查本机执行环境。千问检查 RPC 请求与响应入口及流式消息、完成、错误事件的订阅入口。执行环境检查失败会清除可评测状态。DSH、Pi、Hermes、OpenClaw、LangGraph 同样不按版本号拒绝评测。Pi 通过无任务 RPC get_state 预检；Hermes 与 OpenClaw 检查实际执行子命令的必要参数；LangGraph 在临时目录中加载配置的 Graph 并检查 stream / astream，随后释放上下文，不调用 Graph 执行任务。DSH 继续验证服务与会话接口，主界面也检查模型配置、配置重启需求及忙碌状态。CLI 参数检查不能保证运行期事件格式兼容；所有适配器继续在真实运行中检查完成、采集和收尾。这不表示每个新版本均已完成真实评测验收。

## 评测前兼容性检查

正式评测在投递题目前会执行兼容性验收，工作台与直接 CLI 共用入口。首次检查会创建合成小任务，验证文本、独立会话、文件交付、工具证据和取消清理；豆包还验证后台子任务。检查会消耗被测 Agent 自身的调用额度，但不调用 Planner／Judge。日志以 `[evaldock:compatibility]` 展示分项进度。

接口可连接与兼容性验收通过仍是不同状态。检查返回兼容、不兼容、待判定或环境阻塞；只有本次所需能力全部通过才继续评测。缺少登录、未能触发目标行为或清理未确认时保留证据并停止，不产生零分代替失败。

验证记录保存在工作空间的 `var/compatibility/`，绑定客户端、驱动、配置和验收套件指纹，有效期为 24 小时。命中记录后仍做轻量接口检查；版本或关键配置变化会重新验收。源码工作树可用 `pnpm run compatibility --list` 查看入口（已安装应用的工作空间使用 `node adapters/compatibility/cli.mjs --list`），通过 `--target-id` 指定目标、`--force` 强制复验，详见[适配器说明](../adapters/README.md#version-compatibility-admission)。DSH Web 使用原有真实执行器参加验收；DSH Headless 使用独立进程及会话归档专项验收，只有所需检查通过后才准入，且不复用 Web 凭证。源码命令可用 `--descriptor /path/to/local-target.json` 指定本机 DSH 配置。

本轮没有自动编码适配、自动修复客户端或后台升级。兼容性检查通过不等于真实评测、Judge 评分和报告已经通过验收。
