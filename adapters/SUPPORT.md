# Agent 支持情况与验收范围

核对日期：2026-10-09。本表区分代码允许的目标与公开验收状态；本次仅核对公开源码和已有文档，没有执行真实 Agent 验收。中英文 README 与安装指南统一引用本页。

## 桌面应用身份与接口检查

| 产品 / 适配器 | 应用身份（位于 `/Applications/`） | 准入条件 | 依据 |
| --- | --- | --- | --- |
| 千问办公 / `qwenwork` | `QwenWorkCN.app` / `cn.qwenwork.desktop.mac` | 应用身份、RPC 与流式事件接口、登录 | [适配器](qwenwork/adapter.mjs)、[身份与接口检查](shared/office-adapter.mjs) |
| WorkBuddy / `workbuddy` | `WorkBuddy.app` / `com.tencent.workbuddy.mac` | 应用身份、调用桥、事件传输接口、登录 | [状态检查](workbuddy/status.mjs) |
| 豆包办公 / `doubaowork` | `DoubaoWork.app` / `com.work.pc.doubao` | 应用身份、桌面接口、登录、本机运行环境 | [适配器](doubaowork/adapter.mjs)、[身份与接口检查](shared/office-adapter.mjs) |

应用身份必须精确匹配，否则状态为 `INCOMPATIBLE`。版本号仅用于记录，不作为准入白名单；连接后检查调用与事件接口、登录及运行环境。千问客户端 `Qianwen.app / com.alibaba.tongyi` 与千问办公不是同一适配目标。基础接口检查不保证所有任务兼容，执行、采集和清理仍需在实际运行时验证。

## 公开验收状态

本仓库提供上述应用的适配器代码，未附可独立复核的真实任务验收材料；因此不据此承诺其他版本或所有场景可用。部署时须在目标机器上验证执行、证据采集、文件交付、评分、取消与清理。缺少公开材料不代表从未进行过测试。

三个桌面适配器均不支持原生聊天附件；输入文件通过 Case 工作目录提供。可观测证据有截断与盲区，不采集内部推理；独立工作目录及会话清理不等于重置应用全局状态。豆包另需本机办公运行环境，后台任务必须结束后才进入评分。具体限制见各适配器及[办公适配说明](OFFICE_AGENTS.md)。

## 其他已实现的适配器

DSH、Pi、OpenClaw、Hermes、LangGraph 的接入方式见[主 README](../README.zh-CN.md#已接入的-agent)、[通用接口](README.md)、[OpenClaw](openclaw/README.md)及 [Hermes](hermes/README.md)。LangGraph 还须明确具体 graph 目标（如 DeepAgents 或 Agent Service Toolkit），不能只凭框架版本判定兼容。

这些文档中的安装环境与版本描述不自动构成真实验收结论。本次未逐一复核它们的原始验收材料；发布支持承诺前，须补齐具体版本、日期、环境、已验收项目、运行编号与产物位置。Codex、Claude Code 仍属于待接入计划。

## 状态与维护规则

- **适配器已实现，待验证**：有代码，缺少相应版本可复核的真实验收依据。
- **指定版本已通过列明项目的验收**：提供版本、日期、环境、分项结果和材料位置；不扩大为其他版本或场景通过。
- **新版本待验证或适配**：目标接口或环境发生变化，或超出已验收范围，需重新检查。

复核公开验收材料后再更新验收状态；契约测试、应用版本检查通过、页面可打开均不能替代真实任务验收。升级适配器时同时更新本页，分别记录执行、采集、交付、评分、取消与清理结果，缺项明确标为待验证。原始敏感产物保留在授权环境，公开文档只记录可公开的证据索引。

## 兼容性检查与支持凭证

当前正式入口增加了独立的行为验收，接口就绪后仍须通过所需能力检查。
本地支持凭证绑定实际指纹、协议驱动、固定套件、能力范围与证据；不会仅凭
版本号或无报错授予支持。用法和范围见[适配器说明](README.md#version-compatibility-admission)。
DSH Web、Headless 与共享适配器参加该检查；Headless 使用独立进程与会话归档验收，
不会复用 Web 支持凭证。公开支持状态仍以逐版本、逐能力的真实验收材料为准。

2026-10-10 首轮本地验收（Mac mini 测试工作树）：WorkBuddy 5.5.6 通过 v1
文本、文件与工具证据、连续会话隔离、取消及清理检查，并完成内置合成文件交付题的
执行、Trace、Judge 和报告链路。运行索引：`compat-e2e-1791613495589`。
原始材料保留在测试机，不随仓库或安装包分发；本记录仅覆盖上述版本与用例。
千问办公 1.2.1、豆包办公 2.31.10 当前需要登录，未完成真实任务验收。

2026-10-10 补充验收：DSH 0.1.5-rc.1 的 Headless profile 通过文本、文件与工具证据、
连续会话隔离、取消及进程组清理检查。兼容性检查索引：`5f4b4e84-88b8-4e6e-a05d-5f246ebae583`。
已验证 v3 会话归档；DSH Web 当前接口返回 HTTP 401，尚未完成该版本真实验收。

Headless 的正式合成评测 `compat-headless-e2e-20261010` 通过兼容性准入后，
在规划阶段因当前安装目录缺少旧流程要求的 `effective-config.json` 停止；
本轮未完成该目标的 Judge 与报告验收，不能将上述固定检查视为完整链路通过。

## 2026-10-10 扩展版本实测

以下为 Mac mini 独立安装的本地验收索引，原始结果不进入公共仓库。通过项均完成
v1 兼容性检查，以及 `dataset.basic-file-delivery/v1` Case 0 的执行、Trace、
两项 Judge 评分和报告；不代表业务题库或所有未来版本均兼容。

| 目标 | 实际版本 | 结论 | 运行索引 |
| --- | --- | --- | --- |
| DSH Headless | 0.1.2-rc.1 | 完整通过 | `matrix-dsh-0.1.2-rc.1-v4-regression-20261010` |
| DSH Headless | 0.2.0-rc.2 | 补齐 v4 归档及工具消息后完整通过 | `matrix-dsh-0.2.0-rc.2-v4-20261010` |
| Hermes | 0.21.3 | 不兼容：CLI 缺少 `--format`，未进入正式评测 | `matrix-hermes-0.21.3-1791618448380` |
| Hermes | 0.21.6 | 完整通过 | `matrix-hermes-0.21.6-1791618853260` |
| DeepAgents | 0.7.16 | 完整通过 | `matrix-deepagents-0.7.16-1791618640122` |
| DeepAgents | 0.7.23 | 完整通过 | `matrix-deepagents-0.7.23-1791618781599` |
| LangGraph / Agent Service Toolkit | 1.2.7 | 完整通过 | `matrix-langgraph-1.2.7-1791618841873` |
| LangGraph / Agent Service Toolkit | 1.2.14 | 完整通过 | `matrix-langgraph-1.2.14-1791618925468` |
| WorkBuddy | 5.7.7 | 完整通过 | `matrix-workbuddy-5.7.7-1791619118858` |
| WorkBuddy | 5.5.5 | 环境阻塞：会话 RPC 拒绝，取消与清理未通过 | `matrix-workbuddy-5.5.5-1791619591105` |
| DSH Headless（现用回归） | 0.1.5-rc.1 | 完整通过 | `matrix-dsh-0.1.5-rc.1-v4-regression-20261010` |
| WorkBuddy（现用回归） | 5.5.6 | 完整通过 | `matrix-workbuddy-5.5.6-1791619245022` |

Hermes 0.21.6 使用官方标签源码、官方安装戳脚本及 Python 3.14.7；旧版使用
Python 3.12。安装戳引用已核对的发布提交，不修改协议或伪装其他版本。
DeepAgents 两版均搭配 LangGraph 1.2.12；框架版本对照则使用相同的 Agent Service
Toolkit graph。依赖按各版本约束解析并保存锁定清单，因此这些是实际安装组合验证，
并非严格的单变量实验。Graph 取消验证基于观测到的 graph 活动，不涵盖 Shell 子进程。

WorkBuddy 5.5.5 曾通过文本、两次文件会话及工具证据，但创建取消测试会话时被拒绝；
重启独立实例后仍有 RPC 失败，不能登记为支持。磁盘不足导致的早期失败也保留，
不能当作协议不兼容。额外桌面实例已停止，现用安装与用户配置保留。
本轮不测试千问办公、豆包办公，不包含后台升级或自动编码修复。
