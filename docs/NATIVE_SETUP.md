# 原生 macOS 源码运行

这是当前源码的实际启动方式，不是 Docker 安装说明。Docker 镜像和 Runner 尚未交付，发行状态见 [发布说明](RELEASE.md)。

### 1. 准备环境

使用 macOS、Git、Node.js 24 和 `package.json` 指定的 pnpm 版本。桌面 Agent 需要可登录的图形会话，部分题目还需要独立的工具、数据或服务环境。

```sh
git clone https://github.com/evaldock/EvalDock.git EvalDock
cd EvalDock
npm install -g pnpm@11.24.0
pnpm install --frozen-lockfile
pnpm run build
```

### 2. 配置被测 Agent

首次配置时，复制目标模板：

```sh
cp config/agents.example.json config/agents.json
```

编辑 `config/agents.json`，只保留准备使用的目标，将 `/Users/your-user` 等示例路径替换为本机实际路径。此文件被 Git 忽略；模板不会安装 Agent，也不会自动开启扩展。

安装前核对[Agent 支持情况](../adapters/SUPPORT.md)中的应用身份、代码允许版本、历史验收范围与已知限制。存在适配器不代表所有版本兼容，版本预检通过也不等于真实任务已验收。

**当前工作台启动仍依赖 DSH 控制器。** 即使准备测试其他 Agent，也需要先按本机安装情况配置 [config/targets/real-dsh.json](../config/targets/real-dsh.json)，并准备可用的 DSH Web Profile：

| 配置项 | 含义 |
| --- | --- |
| `sourceRoot` | 本机 DSH 包的安装目录 |
| `dshExecutable` | 相对于安装目录的启动入口 |
| `dshHome` | 本机 DSH 的配置与状态目录 |
| `profile` | 当前控制器要求使用 `web` |
| `webEndpoint` | 本机 DSH Web 地址，例如 `http://127.0.0.1:3080` |

`config/targets/real-dsh.json` 中的 `dshHome` 使用 `/Users/your-user/.dsh` 占位路径，需替换为运行用户的实际目录。维护脚本 `backfill-dsh-run-groups.mjs` 与 `verify-probe-semantic-v2.mjs` 默认读取当前用户的 `.dsh`，也可通过 `DSH_HOME` 指定其他目录。

DSH、WorkBuddy 和其他目标的启动方式并非完全相同；详细准备要求见 [本地使用说明](RELEASE.md#本地使用现状) 与各适配器文档。首次在新机器上部署时，需要核对这些运行路径。

### 3. 启动工作台

```sh
pnpm run workbench
```

在浏览器打开 **[http://127.0.0.1:18767/](http://127.0.0.1:18767/)**。已有服务运行时，无需重复启动。若运行在虚拟机中，可通过 SSH 将该端口转发到本机浏览器。

### 4. 设置 Planner / Judge API Key

打开工作台 **「系统设置」**，填写各自的模型名称、完整接口地址和 API Key。Judge 可以复用 Planner 配置，也可以独立设置。

- 接口需兼容当前 Chat Completions 请求格式，填写完整请求地址，而非网站首页。
- 设置保存在运行 EvalDock 的用户目录 `~/.config/evaldock/models.env`，文件权限为 `0600`。
- 页面只返回密钥是否已配置；再次保存时，密钥留空会保留已有值。
- 修改用于后续评测。被测 Agent 自身的模型账号和凭据需另行配置。

模型服务必须能接收选定评测所需的任务与证据；额度、上下文窗口和响应时间受所使用的服务约束。

### 5. 运行第一轮评测

未导入其他题库、也未指定外部题库路径时，默认 `datasets/` 只有 1 道合成演示题，用于验证流程，不用于能力排名。它仍需完成上述 Agent、运行依赖及模型配置。使用自动选题需配置 Planner；需要评分时按题目要求配置 Judge。

其他公开任务通过 BenchDock 独立获取，按[固定版本导入指南](BENCHDOCK.md)准备依赖并设置 `EVALDOCK_DATASETS_ROOT`，再从同一环境启动工作台。该路径选择替代默认题库来源，不会自动合并外部目录记录。缺少授权评分参考的公开任务保持 `UNASSESSABLE`，不能将执行完成当作已评分或答案正确。

在相应 Agent 控制台确认就绪状态；支持启动预检的目标先检查插件冲突和启动条件。选择评测方案，建议先指定少量题目验证完整流程，再扩大规模。

启动后可以查看每道题的进度。评测结束后，在「测试记录」中打开结果，检查评分、实际交付物和 Trace；发现问题时可继续查看该题的 Judge 记录。

核对本次选题与实际执行范围时，按[题库说明](../datasets/README.md#distribution-loading-and-execution-counts)检查 `plan.json`、`run.json` 和逐题证据；分别记录完成、失败、取消及评分状态。目录规模不能替代本次运行记录。
