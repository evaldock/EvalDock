"""The second, source-identity-deduplicated Harbor import (15 questions)."""

from typing import Any, Callable


# Per-case resources only; no vendored Docker images, installers or replay tools.
ESSENTIAL_PRIVATE_FILES = {
    "algotune": [(f"tests/{name}", name) for name in
                 ["evaluator.py", "oracle_solver.py", "test_outputs.py"]],
    "bix": [],
    "featurebench": [("environment/setup_patch.diff", "setup_patch.diff"),
                     ("environment/test_patch.diff", "test_patch.diff"),
                     ("tests/test.sh", "test.sh")],
    "gaia2": [("environment/scenario.json", "scenario.json")],
    "skillsbench": [("tests/test_outputs.py", "test_outputs.py")],
}

METADATA_KEYS = {
    "algotune": [],
    "bix": ["question_id", "record_uuid", "capsule_uuid"],
    "featurebench": ["repository", "base_commit", "test_identity"],
    "gaia2": ["config", "source_id", "scenario_id", "revision"],
    "skillsbench": [],
}


def additional_tasks(task: Callable[..., dict[str, Any]]) -> list[dict[str, Any]]:
    configs = []
    code_labels = ["artifact-delivery", "loop", "reasoning-planning", "tool-code"]
    def add(*args: Any, **kwargs: Any) -> dict[str, Any]:
        config = task(*args, **kwargs, private_files=ESSENTIAL_PRIVATE_FILES[args[0]])
        source_files = {"instruction.md", "task.toml"}
        source_files.update(source for source, _ in config["private_files"])
        source_files.update(source for source, _, _ in config["inputs"])
        if config["dataset"] == "bix":
            source_files.add("tests/ground_truth.json")
        elif config["dataset"] == "gaia2":
            source_files.update(["tests/oracle_events.json", "tests/oracle_answer.txt"])
        config["source_files"] = sorted(source_files)
        config["additional_import"] = True
        configs.append(config)
        return config

    for title, upstream_task, size, speed, description, process in [
        ("algotune-optimize-lti-sim", "lti_simulation", 24576, "60",
         "优化线性时不变系统的连续时间响应模拟，保持数值精度并交付高性能 Solver。",
         ["分析传递函数、输入信号与采样时间", "实现返回内置 list 类型 yout 的模拟器", "验证响应精度并在固定资源下测量相对 oracle 性能"]),
        ("algotune-optimize-ode-seirs", "ode_seirs", 1536, "3900",
         "优化 SEIRS 常微分方程积分，计算末态并满足人口守恒与精度要求。",
         ["分析 SEIRS 方程及多时间尺度", "实现保持精度和守恒的积分器", "检查末态、有限值及相对 oracle 性能"]),
        ("algotune-optimize-outer-product", "outer_product", 12288, "2.50",
         "优化大向量外积计算，交付数值正确的矩阵并通过相对 oracle 性能门槛。",
         ["分析矩阵规模、内存带宽和输出开销", "实现返回 NumPy 矩阵的外积算法", "验证相对误差并排除缓存及计时作弊"]),
        ("algotune-simplex-projection-speedup", "simplex_projection", 786432, "2.50",
         "优化高维向量到概率单纯形的欧氏投影，测数值算法、代码迭代与运行效率。",
         ["推导概率单纯形投影的阈值条件", "实现大向量投影及规定的 solution 返回接口", "核对非负性、和约束、参考精度与计时"]),
    ]:
        add("algotune", title, description, code_labels + ["efficiency-reliability"],
            "output/solver.py", 1800, ["Node.js >=22", "Python >=3.12", "NumPy", "SciPy", "pinned AlgoTune CPU/judge environment"], [],
            ["将 /app/solver.py 映射为 output/solver.py",
             "上游旧题面加速倍数与当前判分实现冲突；按 tests/test_outputs.py 改为 t_agent≤1.05×t_oracle",
             "仅保留私有问题生成器、oracle 与性能判分器；移除重复副本和环境搭建文件",
             "正式性能分需接通固定 CPU、隔离进程及缓存清理；当前 LLM check 不能替代上游性能 Judge"],
            process,
            [("/app/solver.py", "output/solver.py"),
             (f"Your solver's total runtime across the benchmark must be more than **{speed}x faster** than the reference to pass.",
              "To pass the pinned Harbor verifier, all correctness checks must pass and total agent runtime must be at most 1.05 times the live oracle runtime (oracle/agent ratio >= 1/1.05). The naive reference speedup is diagnostic only.")],
            upstream_metadata={"source_dataset": "oripress/AlgoTune", "task": upstream_task,
                               "problem_size": size, "instance_count": 100, "timed_repeats": 10})

    for title, question_id, record, capsule, description, process in [
        ("bix-cpg-density-jackdaw", "bix-52-q2", "cd3052ea-5e3b-4ee9-80b2-50862aeac5d5", "4dceea58-7d66-4576-bfc6-88c026d5b7a9",
         "按甲基化阈值筛选寒鸦基因组的年龄相关 CpG，计算全基因组平均染色体密度。",
         ["核对年龄相关 CpG、染色体长度与甲基化数据", "按 >90% 或 <10% 筛选并去重", "按每碱基密度口径计算平均值并交付数值"]),
        ("bix-filter-chip-variants", "bix-7-q2", "edff36ac-9775-4dff-afb3-3c55af836524", "a02b761a-02b6-46b5-9d5e-2964d5a74960",
         "过滤内含子、基因间区和 UTR 变异，计算每个样本平均 CHIP 变异数。",
         ["检查变异注释和样本标识", "排除 intronic、intergenic 与 UTR 变异", "按样本聚合计数、求平均并核对分母"]),
        ("bix-immune-pathway-enrichment", "bix-6-q5", "b4ba3afc-74cb-4cbc-ac16-28c5ab048240", "f4dcda89-678d-403d-b155-1483d0071765",
         "分析筛选条件的免疫相关通路富集，排除无 T 细胞对照并计算显著条件占比。",
         ["检查筛选条件、通路注释和调整后 p 值", "排除 no T cells 对照并识别免疫通路", "按 adjusted p<0.05 汇总显著条件百分比"]),
        ("bix-ordinal-logit-covid", "bix-10-q2", "ccde55e4-4cb0-4434-a1d7-a5f07657c0e4", "fbe0e950-76f2-4eb7-a216-a2d377970922",
         "构建有序 Logistic 回归，估计预期患者接触与 AESEV 严重程度的调整后优势比。",
         ["合并全部不良事件并为每位受试者生成唯一 AESEV", "将 patients_seen_cat 作为有序分数并控制接种状态", "拟合 ordered logit 并输出 expect_interact_cat 的优势比"]),
    ]:
        add("bix", title, description, ["artifact-delivery", "reasoning-planning", "tool-code", "tool-data"],
            "output/answer.txt", 1200, ["Node.js >=22", "Python/R scientific stack", f"BixBench capsule {capsule} seeded to input/"], [],
            ["将 /workspace/ 数据路径映射为 input/，答案映射为 output/answer.txt",
             "capsule 数据未打包，保留 UUID；正式运行前须将对应数据 Seed 到 input/",
             "答案及数值比较规则汇总于 private/final.json；LLM check 不等同于上游确定性 Judge"],
            process, [("/workspace/answer.txt", "output/answer.txt"), ("/workspace/", "input/")],
            upstream_metadata={"source_dataset": "futurehouse/BixBench v1.5", "question_id": question_id,
                               "record_uuid": record, "capsule_uuid": capsule})

    for title, repo, commit, identity, description, process in [
        ("featurebench-add-feature-lightning-hooks", "Lightning-AI/pytorch-lightning", "126fa6f1bf0dceb03643c59ff4130c701b61aca4", "test_hooks",
         "在固定 PyTorch Lightning 基线恢复 Trainer 接口及支持逻辑，通过真实训练中的 hook 顺序测试。",
         ["分析 Trainer 生命周期及回调依赖", "恢复推理、测试、验证、检查点及被移除的支持逻辑", "验证 hook 调用序列和五组回归测试并交付补丁"]),
        ("featurebench-add-feature-mlflow-bedrock-autolog", "mlflow/mlflow", "93dab383a1a3fc9882ebc32283ad2a05d79ff70f", "test_bedrock_autolog",
         "在固定 MLflow 基线恢复 Bedrock 自动日志、补丁安全性、告警及 tracing 相关功能。",
         ["梳理 gorilla、safe_patch 与 Bedrock tracing 的调用链", "实现同步异步补丁、会话和线程告警控制及支持逻辑", "通过自动日志 F2P 与五组 P2P 测试并交付补丁"]),
        ("featurebench-add-feature-mlflow-unity-catalog", "mlflow/mlflow", "93dab383a1a3fc9882ebc32283ad2a05d79ff70f", "test_unity_catalog_rest_store",
         "在固定 MLflow 基线实现 Unity Catalog 标签转换、Dataset、Schema 与 protobuf JSON 接口。",
         ["检查六个缺失接口及 Unity Catalog REST 调用", "实现标签、数据集、类型和 JSON 转换语义", "验证隐藏 F2P 与五组 P2P 测试并生成最小补丁"]),
    ]:
        add("featurebench", title, description, code_labels, "output/agent.patch", 1800,
            ["Node.js >=22", "Python", "pytest", f"sanitized {repo}@{commit} source fixture", "pinned upstream dependency environment"], [],
            ["将 /testbed 映射为 workspace；额外交付 output/agent.patch",
             "仅私有保留 setup/test patch 和测试入口，不向 Agent 暴露被移除的实现",
             "正式运行须从固定基线构建应用掩码后的 Seed，清理历史、补丁原件和字节码；不能直接提供未掩码上游仓库",
             "EvalDock 尚未接通 Harbor F2P/P2P Judge；当前 LLM check 不能替代确定性回归测试"],
            process, [("/testbed", "workspace")],
            append_instructions="\n\nAfter completing the repository changes, write a unified diff against the sanitized starting workspace to `output/agent.patch`. This patch is the required submission artifact.",
            upstream_metadata={"source_dataset": "LiberCoders/FeatureBench", "repository": repo,
                               "base_commit": commit, "test_identity": identity,
                               "dataset_revision": "e99d6efd", "recipe_revision": "445dcbae"})

    for title, mode, row, scenario, description, process in [
        ("gaia2-adapt-hard-2", "adaptability", "0626_cw20wcc87i9wq2c7i5yun18bbsybo9yr", "scenario_universe_25_uhqi5h",
         "在模拟应用中按犯罪率筛选并收藏房源，邮件通知联系人，依据后续回复调整收藏并发送消息。",
         ["读取用户请求、地点犯罪率和房源信息", "收藏目标房源并向数据科学家联系人发送汇总邮件", "监听回复、处理变更并遵守无回复时不通知的条件"]),
        ("gaia2-timed-1", "time", "0777_y3r2nol0ujohv1z7evrnx8llf1ce5hjh", "scenario_universe_26_6ko4br",
         "在模拟两分钟窗口监听邮件并间隔 30 秒双重回复，按后续来信安排日历和购物。",
         ["读取用户请求并确认模拟时间窗口", "对窗口内邮件即时回复、间隔 30 秒再回复并报告", "处理后续回复、可用日历窗口和每封初始邮件对应的订单"]),
        ("gaia2-timed-2", "time", "0857_l115ixer60dr5v00hxk5lchc0l83w62e", "scenario_universe_27_rhr2yy",
         "在模拟环境按一分钟邮件阈值触发联系人通知，再监听两分钟转介回复并完成邮件转发。",
         ["精确等待一分钟并统计指定发件人来信", "超过五封时联系侦探并报告已发邮件", "在两分钟内监听转介、联系律师并转发对应邮件"]),
    ]:
        add("gaia2", title, description,
            ["artifact-delivery", "efficiency-reliability", "loop", "reasoning-planning", "tool-external"],
            "output/response.txt", 1200, ["Node.js >=22", "GAIA2 ARE MCP sidecar with private scenario", "ARE event-log and provenance collection"], [],
            ["保留模拟 ARE 工具任务，并将实际用户消息镜像到 output/response.txt；该文件不是额外发信指令",
             "私有保留 scenario.json；oracle 事件 DAG 和最终回复合并至 private/final.json",
             "保留原始模拟时间、事件依赖 DAG 和动态 ID；不得把模拟邮件/购物动作改为现实世界操作",
             "正式运行需 ARE MCP sidecar 和事件证据；缺失时为 UNEVALUABLE，不能仅凭文本判通过"],
            process, [],
            append_instructions="\n\nMirror the final plain-text message actually sent to the user in `output/response.txt` (leave it empty if no user message is required). Do not send an extra user notification just to create this artifact. All actions stay inside the simulated ARE applications.",
            upstream_metadata={"source_dataset": "meta-agents-research-environments/gaia2", "config": mode,
                               "difficulty": "hard", "source_id": row, "scenario_id": scenario, "revision": "c128283"})

    add("skillsbench", "skillsbench-model-investment-shock-gdp",
        "基于 PWT、IMF WEO 和 ECB 数据构建格鲁吉亚投资冲击的潜在 GDP 模型，交付带 HP 滤波和公式的 Excel。",
        ["artifact-delivery", "loop", "reasoning-planning", "retrieval-grounding", "tool-data", "tool-document", "tool-web"],
        "output/test-supply.xlsx", 1800, ["Node.js >=22", "XLSX editing tools", "LibreOffice formula recalculation", "openpyxl", "Internet access to PWT 10.01, IMF WEO April 2025 and ECB"], [],
        ["模板以 assets/test-supply.xlsx 提供；先复制 input/test-supply.xlsx 到 output/test-supply.xlsx，再编辑并保存后者",
         "保留原始公开模板、private/final.json 和私有单元格检查；不打包整套上游环境及重复答案工作簿",
         "保留 WEO 数值容差 5%、折旧率相对容差 40% 和 HP 滤波结构检查，不要求所有单元格与 oracle 完全相同",
         "正式运行须接通 LibreOffice 重算及上游 XLSX Judge；外部数据需按指定来源取得，不能用 LLM check 替代"],
        ["按指定数据版本检索 PWT、WEO 和 ECB 并核对单位", "构建折旧率、HP 滤波、资本积累及有无投资的 GDP 公式", "重算工作簿并验证公式、数值量级、投影和数据来源"],
        [("The Excel file you'll be editing is at `/root/test-supply.xlsx` (your shell starts in `/root`).",
          "The original Excel template is at `input/test-supply.xlsx`. First copy it to `output/test-supply.xlsx`, then edit the output copy in your workspace."),
         ("/root/test-supply.xlsx", "output/test-supply.xlsx"),
         ("(overwriting the input file in place)", "(updating the output copy, leaving input/test-supply.xlsx unchanged)"),
         ("## Pre-installed Libraries", "## Required Runtime Libraries"),
         ("The following are already installed in the environment:", "The execution environment must provide the following before this case is run:")],
        upstream_metadata={"source_dataset": "benchflow-ai/skillsbench", "task_id": "shock-analysis-supply",
                           "source_revision": "748f2fffc63643d8874b7cb917a5cca2e22a2b03"},
        inputs=[("environment/test-supply.xlsx", "assets/test-supply.xlsx", "input/test-supply.xlsx")])
    return configs
