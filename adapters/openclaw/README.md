# OpenClaw 适配

适配接口以官方 npm `openclaw@2026.9.6` 为基础。安装位置、可执行文件和 Node 运行时通过 `config/agents.json` 配置，示例见 `config/agents.example.json`。为目标准备兼容的独立 Node 运行时；这不构成真实任务验收结论。

调用官方 agent exec --config --state-dir --cwd --message-file --json，每题独立配置/状态目录；只连接模型，不接聊天渠道，采用原生 headless coding 工具。密钥使用环境变量引用，Planner/Judge 密钥不下发。

Probe：进程结束（含超时/取消）触发一次只读 SQLite 原生 transcript 采集，不轮询。按 CLI 返回的 native session ID 读取，失败路径只允许本题状态中唯一会话。只提取原生工具 ID、参数、工具结果、最终回答；不读取用户题目副本、thinking、全量状态快照和重复细节。上游工具钩子在该版本 headless 路径没有提供完整记录，因此最终实现不加载观察插件。

最多读取末尾 256 行，每行限制 512 KiB（压缩数据限制解压大小），逐行处理；Capture 继续限制 192 KiB 事件、128 组工具、64 KiB 最终回答。省略计数与采集盲区写入 Trace；原生记录不可读则标记 Probe 错误，不伪造工具证据。原生数据库结构绑定当前版本，升级必须重跑适配契约。

所有 Agent 复用统一 all trace、Planner、Judge、题库、难度抽样与工作台结果格式。MVP 未覆盖原生图片附件和外部聊天渠道。
