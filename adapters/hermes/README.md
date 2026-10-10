# Hermes 适配

适配接口以 Hermes 0.21.4（上游 NousResearch/hermes-agent，提交 a932f22c）为基础。安装位置与 Python 环境通过 `config/agents.json` 配置，示例见 `config/agents.example.json`。使用独立 Python 3.12 venv，提前安装 Agent 所需依赖，避免在 Case 内等待安装；这不构成真实任务验收结论。

调用原生 hermes chat --query-file --oneshot --format stream-json。工具范围 terminal,file；每题独立 HERMES_HOME、工作目录、进程组，不继承历史会话。仅使用被测 Agent 的 DeepSeek 凭据，不传 Planner/Judge 凭据。

保留原生调用 ID 对应的工具调用/结果、最终回答、原生用量与失败状态。丢弃逐 token 文本；无原生 ID 不猜配对。沿用 Capture 的 192 KiB 事件预算、最多 128 组工具、64 KiB 最终回答；Hermes 原生工具结果还有 5000 字符限制，明确记入盲区。超时与取消清理所属进程组。

完整评测入口、Planner、题量难度抽样、Judge、报告均复用 adapters/shared；无需改动评分和 all-trace 核心格式。
