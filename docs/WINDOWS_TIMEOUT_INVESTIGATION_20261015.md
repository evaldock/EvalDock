# Windows 超时定位与交接（2026-10-15）

**代码已上传，超时根因尚未确定，Windows 整体验收未通过。** 分支为 `codex/windows-foundation`，[PR #1](https://github.com/evaldock/EvalDock/pull/1) 保持草稿，未合入 `app`。

## 本轮做了什么

- 在 Windows 10 独立目录检出分支，未覆盖已有项目；冻结依赖安装、当前源码构建通过。
- 增加最多 32 条阶段时间记录，并在超时触发时记录最后收到的阶段。代码提交为 [`495f6e69ebb6537b53319d02b713d878ec1d842c`](https://github.com/evaldock/EvalDock/commit/495f6e69ebb6537b53319d02b713d878ec1d842c)。
- 只改动 `adapters/shared/capture.mjs` 和 `tests/contracts/agent-adapters.test.mjs`；执行、取消和清理逻辑未改，原请求时限仍为 5000 毫秒。
- 范围外失败只登记；未运行真实 Agent，未合并或发布。

## 实际验证

| 版本与环境 | 已核验结果 |
| --- | --- |
| `716611f`，Windows 10 | 三轮限定检查，每轮 8 项通过、0 失败、0 跳过。未复现此前超时。 |
| `495f6e6`，本机 | 364 项契约通过、2 项 Windows 专属检查跳过；Python 5 项、模型设置 4 项通过。 |
| `495f6e6`，Windows 10 | 一轮限定检查 8 项通过，另 7 次首项检查通过，共取得 8 份阶段时间线；检出工作区干净。 |
| `495f6e6`，[代码 CI](https://github.com/evaldock/EvalDock/actions/runs/38668183278) | Ubuntu 通过。两次 Windows 运行的相关 8 项检查均通过；完整套件两次均出现 15 条其他失败输出，并达到 180 秒总时限，整体失败。 |

上述代码 CI 的源分支为 `codex/windows-foundation`，源提交为完整的 `495f6e69ebb6537b53319d02b713d878ec1d842c`。实际检出 PR 合并提交 `e9826091a450a4e15fe39ab29f200e004a6cb5ff`，文件树 `82375a02e27f55f0f3f64fc87a288e1a6a2e0403` 与源提交一致。第 2 次只重跑 Windows，Ubuntu 沿用第 1 次成功结果。

Windows 原始 CI 日志：[第 1 次](https://github.com/evaldock/EvalDock/actions/runs/38668183278/job/116204815612)、[第 2 次](https://github.com/evaldock/EvalDock/actions/runs/38668183278/job/116206964929)。本机及实机原始日志保留在本地，未上传连接配置或原始运行资料。本文之后的文档提交触发的 CI，另在交付回复中按对应提交号报告，不以本表替代。

## 超时定位结论

此前 [失败运行](https://github.com/evaldock/EvalDock/actions/runs/38579789497) 的正常输出检查约 5.205 秒后超时，记录为 `AGENT_TASK_TIMEOUT`、`cleanup=STOPPED`、`exitCode=null`、最终阶段 `CREATE_JOB`，没有各阶段时间和目标启动回执。

源码中 `CREATE_JOB` 标记位于检查排队取消请求和调用系统创建 Job 接口之前。因此，旧日志不能证明该系统调用本身卡死。

| 本轮成功样本 | 目标启动 | 目标执行 | 辅助器退出 |
| --- | ---: | ---: | ---: |
| Windows 10，8 份串行或双进程并行样本 | 0.700–0.860 秒 | 各约 0.1 秒 | 0.828–1.031 秒 |
| 同提交 CI，第 1 次 Windows | 3.915 秒 | 0.099 秒 | 4.272 秒 |
| 同提交 CI，第 2 次 Windows | 3.615 秒 | 0.143 秒 | 4.053 秒 |

这些是接收端单调时钟观察到的间隔，不是系统调用 CPU 分析。可以确认当前 CI 启动准备占用了大部分 5 秒预算；不能据成功样本确定此前失败究竟慢在哪一步，CPU、磁盘或安全扫描等原因均未验证。

## 未完成及接手步骤

- **N2 最终验收未关闭**：尚未取得带新时间线的超时失败样本。下一步保留原时限和断言，捕获失败后核对超时触发时的最后阶段，再决定是否需要修复。
- **Windows 完整套件未通过**：15 条失败输出不等于 15 个独立根因；范围外问题沿用[已有登记](WINDOWS_HANDOFF_20261014.md)，本轮未修改。
- **安装包未生成**：完整门禁失败，后续构建和上传被跳过。
- **Windows 11 图形、安装/卸载、真实 Agent、升级验收未做**：本轮只验证 Windows 10 上的限定合成测试。

经验：成功样本能衡量启动开销；只有实际失败时的阶段记录，才能继续确认超时原因。

## 可直接转发

Windows 10 上的取消、超时和子进程清理相关测试通过了，也加上了每一步的耗时记录。代码和这份交接在 codex/windows-foundation 分支，还没合入 app。目前发现 CI 启动准备比较慢，但之前那次超时还没抓到，原因不能算查清。Windows 整体测试仍没全过，没有安装包；下一步先抓超时失败记录，其他问题暂时只登记。
