# Windows 适配本轮结果（2026-10-14）

源码和文档已 commit、push 到公开仓库的 `codex/windows-foundation` 分支，同事可查看 [草稿 PR #1](https://github.com/evaldock/EvalDock/pull/1)。尚未合入 `app`。

## 已完成

- W1：跨平台测试入口、Python 3 选择、Windows CI，超时按失败退出。
- W2：Windows PATH/窗口/环境处理，DSH 缺失及初始化失败隔离。
- W3：x64 NSIS/ICO/包审计配置，题库导入的 Windows 路径校验及取消边界。
- 校验：代码 `ba41ad7` 本机契约 340、Python 5、模型设置 4 全部通过；`3b085af` 的实际 Mac 包 1451 文件审计及签名完整性通过。[CI #31](https://github.com/evaldock/EvalDock/actions/runs/38536361338) 检查 `app/16d1270` 与分支 `29793a8` 的合并版本 `0a69291`：Ubuntu 契约 357 通过、1 项 Mac 专属检查跳过，Python 5、模型设置 4 通过。

## 未完成及真实原因

| 未完成 | 原因 |
| --- | --- |
| Windows 全套校验 | 取消契约 120 秒、runner 180 秒超时，退出 1，套件未完成；W4 收尾路径的根因及修复范围待确认。 |
| Windows 安装包及包审计 | 门禁失败，NSIS 构建、摘要和上传跳过，未生成包。 |
| Windows 11 安装、开窗、权限、文件占用、卸载保留 | 用户稍后提供 Windows 11 x64 环境，尚未实测。 |
| W4 原生 Agent 接入及所属子孙进程回收 | 超出本轮 W1–W3 范围；Agent、版本、安装布局待确认。 |
| W5 真实 Agent、Trace、Judge、报告验收 | 未进入该阶段；题目、参考、账号及费用上限待确认。 |
| W6 两版本 Windows 升级与 Mac 回归 | 尚无两份明确的 Windows 候选包，未开始。 |
| 合并、正式发行、自动更新 | 本轮未授权，Windows 验收尚未通过。 |

W1–W3 尚未整体验收完成，详细证据见 [Windows 交接](WINDOWS_HANDOFF_20261014.md)。
