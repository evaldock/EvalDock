# 千问办公 / 豆包办公适配

实现位置：VMmac `/Users/dsheval/Projects/EvalDock`。按已安装版本验证内部桌面协议；升级后拒绝自动沿用，需重新验收。未改动 Judge、测试集或 all trace 定义。

## 接口与执行

- 千问办公 `qwenwork`：QwenWorkCN 1.2.1，回环 CDP 18492。独立本地项目与子会话，接收 message-parts-patch / snapshot，按 toolCallId 合并。
- 豆包办公 `doubaowork`：DoubaoWork 2.31.3，回环 CDP 18493。本机办公模式（runtime_type=2），使用应用已有执行环境；每题创建独立目录、会话与 sandbox route。保留用户已有授权模式，不更改全局授权设置。
- 测试输入由公共 runner 放入 Case 工作目录，Agent 实际读取与写入文件；不把回复冒充文件交付。输出由原有证据收集器读取。
- 不导出登录 token、cookie 或账号文件。两者仍不支持 `chat-attachment` 原生附件投递；普通输入文件通过工作目录交付。
- 通过 `createOfficeAdapter` 复用状态检查、静态观测和公共 evaluation。豆包额外检查本机执行环境是否就绪。

## 豆包后台任务与 Probe

`desktop.mjs` 负责连接、deadline / AbortSignal、收尾；`workspace.mjs` 使用原生工作目录与 sandbox 接口；`collector.mjs` 负责事件与生命周期。

主会话订阅 native session 的已合并消息流。发现自己任务中新出现的后台 task card 后，只对这个 thread 初始化一次最多 20 条消息，原生服务会恢复对应事件流；之后订阅 thread store 的变更，仅检查自己发现的 thread。不会定时拉取消息历史或遍历用户其他会话。

主聊天结束不代表任务完成：必须确认所有已发现的后台任务终止，才进入 Judge。最终交付取后台真实完成回复；工具调用使用原生 block ID 去重，读取、写入、Shell 与其他可见工具映射到统一事件。隐藏思考、界面图标与重复文本不作为过程证据扩张保存。

取消仅作用于本次会话和发现的子 thread；通过原生终止接口及一次取消后状态查询确认。无法确认则 UNKNOWN，沿用现有控制器阻止继续启动。退出采集时解除订阅并释放本次 sandbox route。

事件集合最多 192 KiB、128 个工具调用对、64 个其他事件；最终回复最多 64 KiB；后台 thread 最多 32 个。沿用公共 evidence 的 1 MiB all trace 预算及 coverage 缺口说明。未暴露的工具参数、内部推理与结果不推断。

## 2026-09-23 验收证据

- 千问：`wb-2841772e-4953-4357-949e-559693438702`，1 题完整标准流程通过；Trace 8,552 bytes，实际文件与两项 Judge 分数正常。
- 豆包首题：`wb-efed9368-6032-4c9e-bccc-b6a100773ada`，memory-accurate-recall 1 题 COMPLETED，实际 `output/answer.json`，Trace 9,178 bytes，两个标签正常评分。
- 豆包并发验收：`wb-7214140f-df29-4efd-9d1d-8af8741e3cd4`，memory-accurate-recall 与 retrieval-hotpot-evidence 两套测试集共 4 题，并发 3，4/4 COMPLETED、8 项 Judge 均 SCORED、4 个独立会话均 STOPPED。四份 Trace 分别 9,348 / 9,319 / 11,739 / 12,630 bytes，各题生成自己的 answer.json。这是接入验收，不能视作全面能力排名。
- 豆包后台委派：`evaldock-760e4259-22fd-4a3b-854a-cabf35aac89b`，实际 thread `56334215978804994` 完成文件读取、写入和校验；1199 次推送合并为 8,995 bytes 的采集记录，cleanup STOPPED。证据位于 `var/workbench/office-validation/doubao-background-complete.json`。
- 主会话取消：`evaldock-95fdc83f-155a-4202-b9d2-1303e6d3ec73`，AGENT_CANCELLED / STOPPED，未生成取消后标记文件。
- 后台委派取消：`evaldock-background-cancel-20260923-2` / thread `56423605967696130`，已验证 AGENT_CANCELLED / STOPPED；采用最长 12 秒的事件等待确认，不轮询任务历史。首次发现的迟到确认保留在 `doubao-background-cancel-first.json`，复测记录 `doubao-background-cancel.json`。
- 专项与相关回归 44/44：后台委派完成条件、并发隔离、只取消自有任务、去重与预算、工作目录授权、Trace 存储，以及 DSH / WorkBuddy / Pi / LangGraph 相关接口。

旧版云端文本 MVP 的 `wb-656f7d7b-6bb9-4abf-8467-9a2cc84a0be1` 曾误把委派结束视为完成，已标为无效并保留 `invalidated-original/`。其他旧版文件不支持记录保留。旧异常不代表新版没有接通，也不能拿旧错误分数评价 Agent。

## 工作台与进度

控制台与其他 Agent 并列，显示本机独立工作目录能力。Case 表每 5 秒刷新已有 Job 进度，展示排队、准备、执行、证据整理、逐标签评分、保存报告与终态。这不是 Probe 对客户端历史的轮询；进度事件不复制任务正文、工具参数或回复。历史 DSH 无法细分时显示“执行 / 评分中”。

## 启动

正常退出应用后，使用对应可执行文件加 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=<port>`，保留原应用数据目录。控制台“打开应用”不会强制终止已有应用；此前未启用调试端口时，先正常退出再打开。登录和本机环境就绪后才显示可评测。
