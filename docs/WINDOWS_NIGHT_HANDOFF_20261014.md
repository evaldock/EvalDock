# EvalDock 开发交接（2026-10-14）

> 最新接手请看 [2026-10-15 超时定位与交接](WINDOWS_TIMEOUT_INVESTIGATION_20261015.md)，其中包含 Windows 10 实机结果、新诊断提交及更新后的转发话术。下文为昨晚交接记录。

**代码和已有交接已上传，Windows 整体验收尚未完成。** 查看 `codex/windows-foundation` 分支或 [PR #1](https://github.com/evaldock/EvalDock/pull/1)，改动尚未合入 `app`。

## 已做

- 将 `app/a84d2c0` 合入 Windows 开发分支，保留已有适配。
- 新增 Windows 辅助脚本，处理取消、超时和所属子进程清理，并调整内置模块加载。
- 补充相关测试；本机与 Ubuntu 完整检查通过。
- 代码提交为 `c92b6ed`；本次总结依据的已上传提交为 `62c9d3b`。

## 未完成及原因

| 未完成 | 原因 |
| --- | --- |
| N2 最终验收 | CI #44 的 8 项相关检查通过，但 #43 曾有一项超时，原因尚未确认，不能据一次通过宣布问题完全解决。 |
| Windows 全套验证 | CI #44 另有 15 项失败输出，套件在 180 秒超时。范围外问题只登记，未修复；尚未确认各项根因。 |
| Windows 安装包 | 完整检查失败，打包被跳过，没有生成候选包。 |
| 实机、真实 Agent 和升级验收 | 按约定未连接 Windows，也未开展这些验收。 |
| 合入 app、正式发布 | 未执行，Windows 验收尚未通过。 |

## 接手建议

先定位 N2 曾出现的超时，再单独处理 DSH 启动超时及其他已登记问题，不重复开发已有适配。

证据：[CI #44](https://github.com/evaldock/EvalDock/actions/runs/38580696078)、[CI #43](https://github.com/evaldock/EvalDock/actions/runs/38579789497)、[详细登记](WINDOWS_HANDOFF_20261014.md)。GitHub CI 日志可在线查看，本机原始日志未上传。本次仅更新文档，后续文档提交的 CI 状态在交付回复报告。

## 可直接转发

今晚做了 Windows 取消、超时和子进程清理相关的修复，代码和交接都上传了。这轮相关测试通过了，但上一轮超时的原因还没查清，Windows 整体测试也没全过，所以还没有安装包，也没做实机验证。明天先接着排查超时。改动在 codex/windows-foundation 分支和 PR #1，还没合入 app。
