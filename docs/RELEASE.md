# EvalDock 本地版本发布说明

## 当前公开版范围

本说明介绍公开框架仓库当前提供的功能、运行要求与发行计划。

当前导入包括 DSH、Pi、OpenClaw、Hermes、WorkBuddy、千问办公、豆包办公和 LangGraph 的适配及工作台入口，
有界事件证据采集、百分制评分、初版难度分层采样，以及 Planner/Judge 的本地 API 配置页面。
当前公开框架仓库的默认 `datasets/` 内置 1 道合成演示题，用于验证任务执行、证据采集、交付和评分流程，不用于能力排名。
其他任务材料通过 BenchDock 独立分发，并按[接入指南](BENCHDOCK.md)指定版本导入。外部目录记录数不代表已在 EvalDock 中完成执行或评分验证的题数。
源码内置、运行环境加载和本次实际执行的题数分别核对，见[题库说明](../datasets/README.md)。个人评测记录和私有评分材料不随源码分发。
这些是框架适配题目与评分，不等价于各上游 benchmark 的官方结果。

## 本地使用现状

这是原生 macOS 运行版本的源码快照，不是已验证的通用 Docker 发行版。
需要 Node.js 24（建议使用最新的 24.x 补丁版本）和 package.json 指定的 pnpm。
桌面 Agent 需另行安装、登录，并按[支持情况与验收范围](../adapters/SUPPORT.md)核对应用身份和版本；发布包不含它们的安装文件、账号或凭据。完整步骤见[原生安装指南](NATIVE_SETUP.md)。

```sh
pnpm install --frozen-lockfile
pnpm run verify
cp config/agents.example.json config/agents.json
```

编辑 `config/agents.json`，只保留本机已安装的目标，填写真实可执行文件和安装目录。
示例中的 `/Users/your-user` 必须替换；该文件被 Git 忽略。
现有工作台启动路径仍依赖 DSH 控制器：按本机安装位置调整 `config/targets/real-dsh.json`，
确保它指向已配置的 DSH Web Profile，然后执行：

```sh
pnpm run workbench
```

访问 `http://127.0.0.1:18767/?page=settings`，由用户配置 Planner 和 Judge。
服务端将模型设置保存至当前用户的 `~/.config/evaldock/models.env`，权限 0600。
不会将保存的密钥返回页面；空白密钥保留旧值，新设置用于后续评测。
被测 Agent 凭据与评测凭据分离，具体参见 `adapters/README.md`。

## 构建与源码包

```sh
pnpm run verify
node --test workbench/lib/model-settings.test.mjs
mkdir -p artifacts
git archive --format=tar.gz --prefix=EvalDock/ -o artifacts/EvalDock-source.tar.gz HEAD
```

源码包仅包含 Git 已提交文件，不包含 node_modules、dist、评测输出或个人配置。
`config/agents.example.json` 是模板，不会隐式启用已安装的扩展或 FULL_ACCESS 权限。

## Docker 数据集发行计划（尚未交付）

Docker 发行方案计划仅内置[一道基础演示题](../examples/datasets/README.md)，不随镜像分发正式题库。当前尚未交付可用的 Dockerfile、Compose 和配套 Runner；现阶段请按[原生源码安装指南](NATIVE_SETUP.md)使用。正式发布时将说明支持平台、运行边界、安装步骤和验收结果。

- **计划镜像内容**：框架、工作台、Probe/Observer、共享 Judge 标签，以及一道可编辑的基础题。Agent、模型配置及运行依赖仍需另行准备。
- **当前题库来源**：BenchDock 已提供独立的[公开数据入口](https://huggingface.co/datasets/EvalDock/BenchDock)，原生源码版按[接入指南](BENCHDOCK.md)导入指定试点。官网专用下载入口仍在计划中；也可按模板自行制作题目。
- **计划装载方式**：题库放入用户持久化目录，由容器挂载读取；计划在工作台完成导入校验、catalog 注册及展示索引更新。不能只解压文件却保留旧的题目索引。
- **计划运行约束**：示例按指定 Case 执行；正式选题范围只来自用户实际装载的题库。题目依赖的服务应随独立数据包说明和准备。
- **打包约束**：`.dockerignore` 已排除正式题库、题目展示副本、旧难度标注及测试集专用环境子目录。最终镜像仍须采用明确的复制范围并验收，避免通过构建产物或缓存重新带入题目。

当前已提供符合现有加载器格式的基础模板和构建上下文排除规则；Dockerfile、Compose、官网下载服务、装载入口及新机器端到端验证尚未完成。

## Docker 发行计划

目标是本机 Docker 中运行工作台、测试集调度、Planner/Judge；本机或 macOS 虚拟机上的 Runner 操作 Agent。
用户在本机浏览器使用工作台，登录和桌面交互仍留在各 Agent 的原生环境。
尚需实现并验收以下项目，完成前不发布可用性承诺或正式镜像标签：

1. 将工作台对本机进程的直接调用抽为已认证的 Runner 接口，保留预检、取消及收尾语义。
2. 使未安装 DSH 的机器也能启动工作台、配置模型、连接其他 Agent。
3. 参数化 Agent 路径、服务监听地址和持久化路径；保留来源校验和 CSRF 防护。
4. 增加 Dockerfile、Compose 及可单独安装的 Runner，凭据不进入镜像层或构建参数。
5. 新机器完成 CLI 与桌面 Agent 的真实端到端验证，以及断线、升级、回退和数据保留验证。
6. 验证 Linux ARM64/AMD64 镜像后，再通过 GitHub Actions 发布到 GHCR。

不能将 macOS 桌面应用直接打入 Linux 容器，也不能把工作台页面能打开当作完整评测链路已容器化。

## 文档发布核对

- 按[题库统计方法](../datasets/README.md)核对默认目录；另行记录外部导入版本，不把目录规模当作实际执行数量。
- 从 `labels/*.json` 统计标签并核对中英文 README；其他说明引用[标签定义](../labels/README.md)，历史报告保留当时冻结的标准。
- 更新适配器时同步[支持情况](../adapters/SUPPORT.md)，补充验收版本、日期、分项结果、材料位置与限制；契约测试不替代真实任务验收。
- 核对中英文 README、安装指南与本说明：历史记录注明环境和版本，规划明确标注未交付。
- 发布前运行 `pnpm run verify` 并核对实际提交范围，不引入私有题库、评分材料或运行产物。

工作台按实际来源展示加载数量、加载失败原因，以及选中、开始、完成、失败、取消、未开始数量和独立评分状态，属于后续产品改进，尚未在本次文档修订中实现或验收。

## 合作与归属

保留已有作者信息；新增提交使用实际维护者配置的 Git 身份。
请按真实功能分组提交，不为了贡献统计拆空提交或改写其他作者的历史。
各上游数据和 Agent 的许可仍适用；本源码快照不授予超出上游许可的再分发权。
