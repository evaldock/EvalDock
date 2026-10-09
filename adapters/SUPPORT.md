# Agent 支持情况与验收范围

核对日期：2026-10-09。本表区分代码允许的目标与公开验收状态；本次仅核对公开源码和已有文档，没有执行真实 Agent 验收。中英文 README 与安装指南统一引用本页。

## 桌面应用身份与版本检查

| 产品 / 适配器 | 应用身份（位于 `/Applications/`） | 代码允许版本 | 依据 |
| --- | --- | --- | --- |
| 千问办公 / `qwenwork` | `QwenWorkCN.app` / `cn.qwenwork.desktop.mac` | `1.2.1` | [适配器](qwenwork/adapter.mjs)、[身份与版本检查](shared/office-adapter.mjs) |
| WorkBuddy / `workbuddy` | `WorkBuddy.app` / `com.tencent.workbuddy.mac` | `5.5.6` | [状态检查](workbuddy/status.mjs) |
| 豆包办公 / `doubaowork` | `DoubaoWork.app` / `com.work.pc.doubao` | `2.31.3` | [适配器](doubaowork/adapter.mjs)、[身份与版本检查](shared/office-adapter.mjs) |

上述应用身份与版本必须精确匹配，否则状态为 `INCOMPATIBLE`；版本检查通过后仍需满足登录、调试连接及运行环境条件。千问客户端 `Qianwen.app / com.alibaba.tongyi` 与千问办公不是同一适配目标。超出表中范围的版本需验证或适配，不能通过改文档宣称兼容，也不能仅凭版本不匹配推断内部协议已经改变。

## 公开验收状态

本仓库提供上述版本的适配器代码，未附可独立复核的真实任务验收材料；因此不据此承诺其他版本或所有场景可用。部署时须在目标机器上验证执行、证据采集、文件交付、评分、取消与清理。缺少公开材料不代表从未进行过测试。

三个桌面适配器均不支持原生聊天附件；输入文件通过 Case 工作目录提供。可观测证据有截断与盲区，不采集内部推理；独立工作目录及会话清理不等于重置应用全局状态。豆包另需本机办公运行环境，后台任务必须结束后才进入评分。具体限制见各适配器及[办公适配说明](OFFICE_AGENTS.md)。

## 其他已实现的适配器

DSH、Pi、OpenClaw、Hermes、LangGraph 的接入方式见[主 README](../README.zh-CN.md#已接入的-agent)、[通用接口](README.md)、[OpenClaw](openclaw/README.md)及 [Hermes](hermes/README.md)。LangGraph 还须明确具体 graph 目标（如 DeepAgents 或 Agent Service Toolkit），不能只凭框架版本判定兼容。

这些文档中的安装环境与版本描述不自动构成真实验收结论。本次未逐一复核它们的原始验收材料；发布支持承诺前，须补齐具体版本、日期、环境、已验收项目、运行编号与产物位置。Codex、Claude Code 仍属于待接入计划。

## 状态与维护规则

- **适配器已实现，待验证**：有代码，缺少相应版本可复核的真实验收依据。
- **指定版本已通过列明项目的验收**：提供版本、日期、环境、分项结果和材料位置；不扩大为其他版本或场景通过。
- **新版本待验证或适配**：目标超出代码允许或已验收范围，需重新检查。

复核公开验收材料后再更新验收状态；契约测试、应用版本检查通过、页面可打开均不能替代真实任务验收。升级适配器时同时更新本页，分别记录执行、采集、交付、评分、取消与清理结果，缺项明确标为待验证。原始敏感产物保留在授权环境，公开文档只记录可公开的证据索引。
