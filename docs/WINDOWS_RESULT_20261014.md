# Windows 适配本轮结果（2026-10-14）

> 最新已结束的 CI #43 修正：N2 首项正常输出检查再次超时，8 项相关检查中 7 项通过，因此 N2 尚未最终验收。清理状态为 `STOPPED`，超时原因未确认。下文的“N2 通过”仅对应历史 CI #42，不是当前完成状态。接手以 [简版交接](WINDOWS_NIGHT_HANDOFF_20261014.md) 为准。

**N2 限定检查通过；N3 的 Windows 完整门禁仍阻塞。** 当前代码为 `c92b6ed66ebb210de12bd5aa28341638a536da40`，位于 `codex/windows-foundation`。[PR #1](https://github.com/evaldock/EvalDock/pull/1) 保持草稿，未合入 `app`。

| 阶段 | 已验证结果 |
| --- | --- |
| N0 | `1efe140` 合入 `app/a84d2c0`，保留既有 W1–W3；同步生命周期测试所需的平台函数。 |
| N1 | 原共享采集使用负 PID 终止；Windows CI 取消测试超时。Windows 清理不能沿用 POSIX 进程组方式验收。 |
| N2 | 新增 PowerShell/C# Job Object 辅助脚本，目标分配到 Job 后才恢复执行；取消、超时、根进程退出时清理所属进程，缺失回执仍为 `UNKNOWN`。CI #42 的 8 项限定检查通过。 |
| N3 | 本机及 Ubuntu 完整门禁通过；Windows 另有失败，runner 在 180 秒退出，套件未完成。NSIS、包审计和上传未执行。 |
| N4 | 更新交接和失败登记；实机、真实 Agent、升级验收继续阻塞。 |

## 验证证据

[CI #42](https://github.com/evaldock/EvalDock/actions/runs/38578414728) 实际检出 `3e8a10ed011b199dd65710f838de063438e7de21`，父提交为 `app/a84d2c0` 和源 `c92b6ed`。tree `8159931004f3641d0fe31c7534efe61b68da994f` 与源提交相同。

- 本机 macOS：契约 366 项，364 通过、2 项 Windows 专属检查跳过；Python 5、模型设置 4 通过；发布边界、类型检查、构建通过。
- Ubuntu job `115901539877`：契约 366 项，363 通过、3 项平台专属检查跳过；Python 5、模型设置 4 通过。
- Windows job `115901540282`：N2 正常输出/脱敏、根进程退出后清理、启动前取消、运行中取消、超时、Python 子进程及继承管道清理、参数/环境传递、缺失回执处理共 8 项检查通过。最后一项使用模拟辅助进程，不是原生故障注入。
- 本机运行资源暂存审计 1019 文件通过，辅助脚本与源码逐字节一致。这不是 Windows 安装包验收。

## 辅助脚本失败的定位与修复

CI #41 到达 `REQUEST_READ`，未到达 `COMPILE`：输入已读到，阻塞位于 `ConvertFrom-Json` 调用阶段。`c92b6ed` 限定模块路径并显式导入 Windows PowerShell 自带 Utility 模块后，N2 检查在 CI #42 通过。未追踪默认模块发现内部的具体等待点，不将某个目录或网络访问写成已确认根因。

经验：读取、解析、编译和启动分别记录固定阶段标记；以 Windows 实际回执确认修复，Mac/Ubuntu 通过不替代原生检查。

## 剩余问题与建议

Windows 日志另有 15 项失败输出，涉及 DSH 启动超时、Agent 档案/参数、日志、题库下载/导入、成本标签、包审计及难度标注。套件被总时限终止，没有完整断言汇总；这些不是已确认的 15 个独立根因。本轮只登记，未修改对应代码。位置见 [交接登记](WINDOWS_HANDOFF_20261014.md)。

建议下一张任务卡仅处理 `tests/contracts/dsh-preflight.test.mjs:30` 对应的启动超时。它调用 `workbench/lib/dsh-preflight.mjs` 自有的 spawn/负 PID 终止路径，不调用 N2 共享辅助脚本；精确运行阻塞点仍需定位。其余失败另行诊断。

未连接 Windows 或开发 VM，未运行真实 Agent/模型、未生成 Windows 候选包、未合并或发布。当前改动没有重新实现既有 W1–W3。
