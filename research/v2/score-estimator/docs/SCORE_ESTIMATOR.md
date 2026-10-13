# 离线全量分数估计器（实验版）

本模块可在真实成绩表到位前开发和验证。它提供数据校验、IRT 风格的连续分数模型、按 agent 表现动态选题、随机审计估分、验证集融合权重校准和留出 agent 离线回放。合成实验只验证程序，不证明真实评测精度。

入口为 `node tools/score-estimator/cli.mjs`，也可使用 `pnpm score:estimator`。仅使用 Node 内置模块，无新增依赖、API 请求、真实 Agent、队列操作或服务启动。不会改变现有 Planner、Judge、页面均分或工作台端口。

## 1. 当前实现与方案边界

- 支持任意数量的 agent、case 和标签；演示默认 5 个 agent、1,514 个 case、30 个标签，每题 2～7 个适用标签。
- 同题多个标签共用一次执行，不把它们算作多道独立题或多笔费用。
- 默认模型是**逐标签、固定区分度、带正则的 1PL 均值模型**，不是 tinyBenchmarks 的完整多维 2PL。五个 agent 的初始面板不适合直接宣称高维自由参数已可靠估计。
- 直接以归一化连续 rubric 分数拟合 fractional logistic loss，模型输出用于预测同一分数量表上的均值；不把通过概率冒充原始分数。该损失是准似然，曲率只用于选题，不充当已校准置信区间。
- 默认估分使用“冻结预测 + 独立随机审计残差”。另提供从独立验证 agent 学习固定 lambda 的直接估计/p-IRT 融合，但不自动宣称精度已认证。
- 当前支持固定预算和预先指定的多个预算离线比较，不提供生产 Controller 的在线扩测调度。未来扩测必须在看结果前确定阶段规则及错误概率分配。
- 当前仅支持一次运行协议。重复运行、聚类/跨会话任务须先确定独立抽样单位和聚合规则，不选择性保留成功结果。
- 真实题目参数、正则强度/模型选择、融合权重和迁移误差，均需用真实训练/验证/最终测试数据确定。

## 2. 输入数据

输入是一份 `evaldock.estimator-data/v1` JSON，里面是长表数组，不是把不适用标签填 0 的稠密矩阵。字段如下：

| 数组/对象 | 必要字段 | 含义 |
| --- | --- | --- |
| protocol | id、judge_version、repeat_policy | 冻结协议；repeat_policy 当前必须为 single_attempt |
| agents | agent_id、config_hash | 每行是一个固定 agent 配置；推荐提供 split_group 将近似变体绑定在同一切分组 |
| labels | label_id、min、max、rubric_version | 每个标签固定量表，分别归一化到 [0,1] |
| cases | case_id、case_version、labels | 原始题目 ID、内容版本；labels 是 label_id → 正原始权重映射 |
| executions | execution_id、agent_id、agent_config_hash、case_id、case_version、protocol_id、status | 每个 agent×case 一条执行；可附 repeat_id=1、tokens、cost、elapsed_seconds 和证据位置 |
| scores | execution_id、label_id、raw_score、status、rubric_version、judge_version | 每个 execution×适用 label 一行；可附证据路径、理由 |

protocol 还应记录环境/运行预算/seed 策略等版本字段，它们全部进入 corpus_digest；case_version 应使用涵盖有效题干、输入、参考和评分脚本的版本或内容摘要。程序能检查记录是否一致，无法仅靠自报版本证明实际运行环境没有改变。

cases 可有 `expected_cost`（正数，默认 1）供选题使用；应在目标 agent 的未测成绩出现前固定，不能偷看未测实际耗时。目标权重按每个标签在完整适用题库内归一化。schema 当前要求适用组合权重为正；排除不适用组合用不建立映射表示。

结构示意：

```json
{
  "schema": "evaldock.estimator-data/v1",
  "protocol": {
    "id": "scope-v1",
    "judge_version": "judge-frozen-v1",
    "repeat_policy": "single_attempt",
    "environment_version": "env-v1",
    "synthetic": false
  },
  "agents": [
    {"agent_id": "agent-A", "config_hash": "config-sha256", "split_group": "family-A"}
  ],
  "labels": [
    {"label_id": "tool.code", "min": 0, "max": 100, "rubric_version": "code-v1"},
    {"label_id": "artifact.delivery", "min": 0, "max": 100, "rubric_version": "delivery-v1"}
  ],
  "cases": [
    {
      "case_id": "case-001",
      "case_version": "case-content-sha256",
      "labels": {"tool.code": 1, "artifact.delivery": 1},
      "expected_cost": 1
    }
  ],
  "executions": [],
  "scores": []
}
```

这个示意可通过结构校验，仍显示成绩未完成；不足两个完整训练 agent 时不能训练。实际长表行示例：

```json
{
  "execution_id": "execution-A-001",
  "agent_id": "agent-A",
  "agent_config_hash": "config-sha256",
  "case_id": "case-001",
  "case_version": "case-content-sha256",
  "protocol_id": "scope-v1",
  "repeat_id": 1,
  "status": "COMPLETED",
  "tokens": 8000,
  "elapsed_seconds": 120,
  "cost": null
}
```

```json
{
  "execution_id": "execution-A-001",
  "label_id": "tool.code",
  "raw_score": 85,
  "status": "SCORED",
  "rubric_version": "code-v1",
  "judge_version": "judge-frozen-v1",
  "evidence_path": "path/to/frozen-report.json"
}
```

另一适用标签需要另一条 score 行，共用同一 execution_id。真实 EvalDock `LabelScore` 的 score 对应 raw_score，labelId 对应 label_id；导出时必须保留原始 question.id 映射、评分标准摘要及执行配置，不能拿页面按有效样本重新归一化后的均分替代逐题数据。现有报告的自动导出适配需要待真实成绩样例确定；本模块不会猜测旧结果的协议版本。

### 缺失状态

- 不适用：case.labels 没有该标签；不生成评分行。
- 尚未执行：没有 execution；选中后保持 WAITING_FOR_SCORES。
- 能力失败：execution.status 可为 AGENT_FAILED，按 rubric 生成 SCORED 数值（允许 0）。
- agent 达到预定运行上限：AGENT_TIMEOUT，仍按已冻结 rubric 判分，不由估计器自动补 0。
- 基础设施故障：INFRA_ERROR，禁止同时记录 SCORED。
- 评分不足/失败：UNASSESSABLE 或 ERROR，raw_score 必须为 null。
- 任一已选题适用分数不完整：EVALUATION_INCOMPLETE；保留原请求，不能换一道容易测的题。
- 不知道的费用/token 为 null，报告 known_sum 和 unknown_executions，不冒充零消耗。
- 同一 agent×case 重复执行或同一 execution×label 重复评分直接报错，要求先冻结去重/重复运行规则。

## 3. 合成数据完整演示

在 EvalDock 项目根目录运行。输出位于已忽略的 `var/`。所有 CLI 输出文件使用独占创建，存在同名文件则失败；重复演示请更换目录名，不覆盖旧实验。

```sh
node tools/score-estimator/cli.mjs synthetic --out var/score-estimator-demo/data.json --agents 5 --cases 1514 --labels 30 --seed 42
node tools/score-estimator/cli.mjs validate --data var/score-estimator-demo/data.json
node tools/score-estimator/cli.mjs fit --data var/score-estimator-demo/data.json --agents synthetic-agent-0,synthetic-agent-1,synthetic-agent-2 --out var/score-estimator-demo/model.json
node tools/score-estimator/cli.mjs calibrate --data var/score-estimator-demo/data.json --model var/score-estimator-demo/model.json --agents synthetic-agent-3 --budgets 100 --seeds 3 --out var/score-estimator-demo/fusion.json
node tools/score-estimator/cli.mjs replay --data var/score-estimator-demo/data.json --model var/score-estimator-demo/model.json --agents synthetic-agent-4 --budgets 100 --seeds 3 --out var/score-estimator-demo/audit-replay.json
node tools/score-estimator/cli.mjs replay --data var/score-estimator-demo/data.json --model var/score-estimator-demo/model.json --fusion var/score-estimator-demo/fusion.json --agents synthetic-agent-4 --budgets 100 --seeds 3 --out var/score-estimator-demo/fusion-replay.json
```

这是训练 3 个、验证 1 个、最终回放 1 个的**流程示范**，不表示这个划分足以验证真实迁移精度。多个随机 seed 仍然是同一个 agent，报告单独保留 independent_agent_count。

省略 `--fusion` 使用默认残差审计估计器。默认预算 100、探针 20、随机审计 20，其余 60 道动态选题。预算必须不超过题库大小；调整预算时同步调整 probes/audit，三部分题数相加必须匹配预算。目标 agent 全量分数只在选题完成后用于报告。

回放可使用 `--budgets 50,100,150` 比较预先声明的预算。每个预算是单独的一次实验，不是复用同一个嵌套样本；各标签与预算的区间通过 alpha/(标签数×预算数) 分配错误概率。输出逐标签 MAE、误差 P95、最大误差、区间覆盖、达标比例、p-IRT 和同题量简单随机估计对照，以及完整选题记录。所有分数与误差为 [0,1] 单位，展示百分制乘以 100。

## 4. 真实数据到位后的逐步选题接口

```sh
node tools/score-estimator/cli.mjs init --data path/to/data.json --model path/to/model.json --agent new-agent --budget 100 --probes 20 --audit 20 --out var/estimator-session-0.json
node tools/score-estimator/cli.mjs step --data path/to/updated-data.json --model path/to/model.json --session var/estimator-session-0.json --out var/estimator-session-1.json
node tools/score-estimator/cli.mjs estimate --data path/to/updated-data.json --model path/to/model.json --session var/estimator-session-1.json --out var/estimator-report-1.json
```

init 输出 pending case ID。真实执行仍由原有团队队列完成，补入这些 case 的逐标签成绩后调用 step。每次 step 只读取 pending 的响应；信息题一次请求一题，审计题一次冻结一批。即便数据文件已有全部成绩，选题模块也只揭示被选中的题。

会话包含模型/题库摘要、agent 配置、选题理由、随机 seed、角色、选择概率、已消费响应和冻结审计预测。已消费成绩改变时拒绝继续。审计开始后不得重新拟合该轮审计所用预测；部分审计题缺失时保留同一批请求。

## 5. 统计实现

### 连续分数 IRT 基线

每个标签分别拟合：

`predicted_mean(agent, case) = sigmoid(intercept + agent_ability - case_difficulty)`

使用连续 [0,1] 响应的 logistic cross-entropy，加 agent/item 的 L2 正则。区分度固定为 1。训练产物保留训练 agent、输入响应摘要、题库摘要、参数、迭代/收敛诊断。对新 agent 只更新能力，题目参数保持不变。

初始探针优先补能力覆盖；后续信息题根据预测分数方差下降的近似量、覆盖和预计成本选择。使用带均匀探索分量的随机选择，记录 conditional_draw_probability。它不是最终样本入样概率，不进入经典 HT 求和。

### 预测加审计校正

令 A 为审计前已测的自适应题，B 为剩余 M 道题；在 B 上简单随机不放回抽 n 道 R，pi=n/M。权重 w 是完整标签题库的固定归一化权重，不适用标签的 w=0。

```text
frozen_baseline = sum_A(w*y) + sum_B(w*prediction)
audit_estimate  = frozen_baseline + (M/n)*sum_R(w*(y-prediction))
pirt_estimate   = frozen_baseline + sum_R(w*(y-prediction))
direct_estimate = sum_A(w*y) + (M/n)*sum_R(w*y)
```

校正基线仍包含 R 的预测，不先替换成 R 的真实成绩，因此没有重复残差校正。对固定成绩表，在给定 A 的历史后，该审计估计是设计无偏的。未校正的模型预测和经过裁剪的展示值不因此获得同样的无偏保证。

审计从 case 总体抽样；某标签未在该题出现时贡献 0 权重。这保证每个未测目标 case 都有正入样概率，但稀有标签可能抽得很少，区间应如实变宽。不能把“其他标签抽到的题”伪称为该标签独立抽样。

### 区间与状态

残差 z_i=w_i(y_i-p_i) 在所有 B 中有已知公共上下界。对 SRS 使用保守 Hoeffding 半宽：

`M * (max_i w_i(1-p_i) - min_i(-w_i*p_i)) * sqrt(log(2*D*K/alpha)/(2*n))`

D 是标签数，K 是预声明查看阶段/预算数。结合已经观测的真实分数和未测权重所界定的可行范围；全量观测时区间收缩为一个点。它针对冻结响应表上的抽样误差，不覆盖 Judge 随机性、执行波动或远程环境漂移。

- CENSUS_COMPLETE：该标签的目标题全部获得有效分数。
- PRECISION_MET：默认审计区间相对展示估计的最大端点距离不超过预定 tolerance。
- BUDGET_LIMITED：本轮预算用完，保守区间仍过宽。
- MODEL_ONLY_UNVALIDATED：没有审计，不宣称模型精度。
- EVALUATION_INCOMPLETE / WAITING_FOR_SCORES：有未解决的入选成绩。
- FUSION_UNCERTIFIED：启用了验证集融合；不自动颁发精度达标。

30 个标签共同要求很窄的区间，100 题可能远远不够。代码允许如实输出 BUDGET_LIMITED，不用窄模型后验替代随机审计保证。

### 可选融合

在独立验证 agent 上离线回放，按标签和预算拟合 [0,1] 内固定 lambda，使 `lambda*direct_estimate+(1-lambda)*pirt_estimate` 的验证均方误差最小。最终测试不能再用这些验证 agent、相同 config_hash 或 split_group。

融合结果的区间相对原审计区间按中心位移保守扩大，不直接沿用原区间或宣称 tinyBenchmarks 原始 gp-IRT 理论保证。训练/验证 agent 少时，该权重只能视为实验产物。

## 6. 测试与后续接入

```sh
pnpm test:score-estimator
pnpm check
node scripts/check-publication-boundary.mjs
```

专用测试覆盖输入合同、未知/重复/非适用分数、零分与缺失、版本冻结、全量恢复、非等权残差无偏的可枚举校验、无未来成绩泄漏、训练/验证/测试分离、确定性重放、部分失败不换题、会话恢复、审计冻结、模型损坏和 CLI 流程。

真实成绩到位后：先 validate → 按家族冻结训练/验证/测试分组 → 拟合并检查诊断 → 在验证组选择参数与策略 → 最终留出回放 → 独立端到端重复评测。真实 Agent 的执行、环境重置与评测仍必须通过团队公共队列。

本模块不自动收集评分、不改题库标签、不替换现有工作台统计，也不把合成文件作为真实模型发布。
