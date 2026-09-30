# EvalDock 本地版本发布说明

## 版本与历史

`release/evaldock-local-20260928` 保存本地 VMmac 上已集成的 EvalDock 版本。
它从既有提交 `ecfcf828880a5b292db61d8b21fae8e7e3e5341d` 延续，保留原提交的 SHA、作者和日期。
根据仓库维护者要求，`main` 的文件内容已切换为此发布版本，并通过双亲合并提交保留两边历史。
替换前 main 的数据集、诊断和适配实现仍可从 `backup/main-before-evaldock-20260928` 查阅、恢复或逐项整合。
此操作保留其提交及作者归属，但不表示已把两个版本的全部功能融合。

当前导入包括 DSH、Pi、OpenClaw、Hermes、WorkBuddy、千问办公、豆包办公和 LangGraph 的适配及工作台入口，
有界事件证据采集、百分制评分、初版难度分层采样，以及 Planner/Judge 的本地 API 配置页面。
随本分支发布的是启用的 40 个测试集、143 道题；冻结题库和个人评测记录不包含在内。
这些是框架适配题目与评分，不等价于各上游 benchmark 的官方结果。

## 本地使用现状

这是原生 macOS 运行版本的源码快照，不是已验证的通用 Docker 发行版。
需要 Node.js 24（建议使用最新的 24.x 补丁版本）和 package.json 指定的 pnpm。
桌面 Agent 需另行安装、登录，并按相应适配器说明配置；发布包不含它们的安装文件、账号或凭据。

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

## Docker 数据集发行边界

Docker 版本只内置 [一个基础 Case 模板](../examples/datasets/README.md)，不随镜像分发正式题库。现有源码分支中的 40 个数据集、143 道题不等于 Docker 内置内容。

- **镜像内容**：框架、工作台、Probe/Observer、共享 Judge 标签，以及一道可编辑、无额外服务依赖的基础题。
- **正式题库来源**：用户从 [EvalDock 官网](https://www.evaldock.ai/) 另行下载数据包，或按模板自行制作。官网专用下载入口尚未交付，此处不声明已有可下载的数据包。
- **装载方式**：题库放入用户持久化目录，由容器挂载读取；计划在工作台完成导入校验、catalog 注册及展示索引更新。不能只解压文件却保留旧的题目索引。
- **运行约束**：示例按指定 Case 执行；正式选题范围只来自用户实际装载的题库。题目依赖的服务应随独立数据包说明和准备。
- **打包约束**：`.dockerignore` 已排除正式题库、题目展示副本、旧难度标注及测试集专用环境子目录。最终镜像仍须采用明确的复制范围并验收，避免通过构建产物或缓存重新带入题目。

当前已提供符合现有加载器格式的基础模板和构建上下文排除规则；Dockerfile、Compose、官网下载服务、装载入口及新机器端到端验证尚未完成。

## Docker 发行计划

目标是本机 Docker 中运行工作台、测试集调度、Planner/Judge；本机或 VMmac 的 Runner 操作 Agent。
用户在本机浏览器使用工作台，登录和桌面交互仍留在各 Agent 的原生环境。
尚需实现并验收以下项目，完成前不发布可用性承诺或正式镜像标签：

1. 将工作台对本机进程的直接调用抽为已认证的 Runner 接口，保留预检、取消及收尾语义。
2. 使未安装 DSH 的机器也能启动工作台、配置模型、连接其他 Agent。
3. 参数化 Agent 路径、服务监听地址和持久化路径；保留来源校验和 CSRF 防护。
4. 增加 Dockerfile、Compose 及可单独安装的 Runner，凭据不进入镜像层或构建参数。
5. 新机器完成 CLI 与桌面 Agent 的真实端到端验证，以及断线、升级、回退和数据保留验证。
6. 验证 Linux ARM64/AMD64 镜像后，再通过 GitHub Actions 发布到 GHCR。

不能将 macOS 桌面应用直接打入 Linux 容器，也不能把工作台页面能打开当作完整评测链路已容器化。

## 合作与归属

保留已有作者信息；新增提交使用实际维护者配置的 Git 身份。
请按真实功能分组提交，不为了贡献统计拆空提交或改写其他作者的历史。
各上游数据和 Agent 的许可仍适用；本源码快照不授予超出上游许可的再分发权。
