# Windows 开发总结（2026-10-14）

> 后续进展见 [2026-10-15 超时定位与交接](WINDOWS_TIMEOUT_INVESTIGATION_20261015.md)：已完成 Windows 10 限定实机验证并上传阶段计时诊断；此前超时根因和 Windows 整体验收仍未关闭。下文保留 2026-10-14 的历史结果。

**已上传，尚未完成 Windows 整体验收。** 分支为 `codex/windows-foundation`，[PR #1](https://github.com/evaldock/EvalDock/pull/1) 保持草稿，未合入 `app`。简版及转发话术见 [交接文档](WINDOWS_NIGHT_HANDOFF_20261014.md)。

## 已完成的修改

- N0：通过 `1efe140` 合入 `app/a84d2c0`，保留既有 Windows 适配，并修正生命周期测试夹具。
- N1/N2：定位原负 PID 终止路径，新增 Windows 专用辅助脚本，处理取消、超时及所属子进程清理；未收到清理回执时保留 `UNKNOWN`。
- 调整辅助脚本的内置模块加载，补充相关测试及诊断标记。最后代码提交为 `c92b6ed`。
- N4：保存交接和范围外失败登记；未修改范围外产品代码。

## 已核验结果

本节依据 [CI #44](https://github.com/evaldock/EvalDock/actions/runs/38580696078)，源分支 `codex/windows-foundation`，源提交 `62c9d3b7936d5c75f16314934c888fde2acffc37` 已核对远端收到。实际检出 `fa39cb31b6e4eac6157e7a63f15cf183b39debe8`，文件树与源提交一致。

| 检查 | 结果 |
| --- | --- |
| 本机代码验证 | 364 项契约通过、2 项 Windows 专属检查跳过；Python 5 项、模型设置 4 项通过。 |
| CI #44 Ubuntu | 363 项契约通过、3 项平台专属检查跳过；Python 5 项、模型设置 4 项通过。 |
| CI #44 Windows | N2 相关 8 项检查通过；另有 15 项失败输出，套件在 180 秒超时，整体失败。 |
| 运行资源暂存 | 本机审计 1019 文件通过，辅助脚本与源码一致；不是 Windows 安装包验收。 |

N2 的 8 项检查中，缺失回执检查使用模拟辅助进程，不是原生故障注入。[CI #43](https://github.com/evaldock/EvalDock/actions/runs/38579789497) 曾出现首项正常输出测试超时，原因未确认；#44 通过不等于该问题已彻底解决，因此 N2 最终验收仍未关闭。

## 未完成及原因

- N3 Windows 全套验证：仍有失败和总超时。15 项失败输出不代表已确认的 15 个独立根因，详见 [登记](WINDOWS_HANDOFF_20261014.md)。
- Windows 安装包：门禁失败，构建、包审计和上传被跳过，没有候选包。
- Windows 实机、真实 Agent、升级验收：按约定未连接 Windows，未开展这些验收。
- 合入 `app`、正式发布：未执行，Windows 验收尚未通过。

下一步先定位 N2 曾出现的超时，再单独处理 DSH 启动超时。经验：按固定阶段记录实际进度；一次通过不能关闭尚未查明的间歇失败。

本次仅更新文档，产品代码不变；文档提交的 CI 状态在交付回复报告。
