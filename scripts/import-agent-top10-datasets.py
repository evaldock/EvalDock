#!/usr/bin/env python3
"""Import pinned, execution-oriented tasks from entries 1–10 of the link catalog.

Reads upstream archives as data, never imports or executes upstream Python code.
Generated text files are installed with apply_patch, refusing changed existing files.
GAIA is deliberately not fetched from ungated mirrors. No agents or services run.
"""

from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import io
import json
import re
import subprocess
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPECS = {
    "agentbench": ("THUDM/AgentBench", "ed013ff9887b0c3d7864c56ae54d41eba54a99d8"),
    "tau-bench": ("sierra-research/tau-bench", "59a200c6d575d595120f1cb70fea53cef0632f6b"),
    "tau2-bench": ("sierra-research/tau2-bench", "672227c6b6676edc20d57ea53b7000262aae77b9"),
    "appworld": ("StonyBrookNLP/appworld", "42b5bcf3cd334fee33f0c37c02070a9f5807add5"),
    "bfcl": ("ShishirPatil/gorilla", "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"),
    "webarena": ("web-arena-x/webarena", "dce04686a56253aefba7b18a4fa0937cf1dc987b"),
    "visualwebarena": ("web-arena-x/visualwebarena", "89f5af29305c3d1e9f97ce4421462060a70c9a03"),
    "osworld": ("xlang-ai/OSWorld", "fc31a9049664292fcb35d6e501ee1dc839f2cf6d"),
    "workarena": ("ServiceNow/WorkArena", "a772230a94cf1caf4166b8ead3983f3b3786455b"),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


class Source:
    def __init__(self, cache, family):
        self.cache, self.family = cache, family
        self.repo, self.commit = SPECS[family]
        self.archive = None
        self.members = {}
        if family != "visualwebarena":
            self.archive = tarfile.open(cache / f"{family}.tar.gz", "r:gz")
            prefix = self.repo.split("/")[1] + "-" + self.commit + "/"
            for member in self.archive.getmembers():
                if member.isdir() and member.name.rstrip("/") == prefix.rstrip("/"):
                    continue
                if not member.name.startswith(prefix):
                    raise ValueError("Unexpected archive root")
                relative = member.name[len(prefix):]
                if ".." in Path(relative).parts:
                    raise ValueError("Unsafe archive member")
                if member.issym() or member.islnk():
                    continue  # Never extract or dereference repository links.
                if member.isfile():
                    self.members[relative] = member

    def read(self, relative):
        if self.family == "visualwebarena":
            file = self.cache / ("visual-" + relative.replace("/", "__"))
            if relative.startswith("config_files/vwa/"):
                file = self.cache / ("visual-" + relative.rsplit("/", 1)[-1])
            return file.read_bytes()
        return self.archive.extractfile(self.members[relative]).read()

    def json(self, relative):
        return json.loads(self.read(relative))

    def jsonl(self, relative):
        return [json.loads(line) for line in self.read(relative).decode().splitlines() if line.strip()]

    def provenance(self, paths):
        return [{"path": item, "sha256": digest(self.read(item))} for item in dict.fromkeys(paths)]


def literal(node):
    """Parse the original tau Task/Action constructors without executing code."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"Task", "Action"}:
        if node.args or any(k.arg is None for k in node.keywords):
            raise ValueError("Unsupported upstream constructor")
        return {k.arg: literal(k.value) for k in node.keywords}
    if isinstance(node, (ast.List, ast.Tuple)):
        return [literal(value) for value in node.elts]
    if isinstance(node, ast.Dict):
        return {literal(key): literal(value) for key, value in zip(node.keys, node.values)}
    return ast.literal_eval(node)


def tau_tasks(source, relative):
    tree = ast.parse(source.read(relative))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {"TASKS_TEST", "TASKS"} for t in node.targets):
            return literal(node.value)
    raise ValueError("Missing TASKS_TEST")


def appworld_zip(source):
    # The public download helper uses these openly published values to prevent
    # automated scraping, not to restrict authorized local use. Never publish
    # the decrypted bundle. Node's built-in crypto avoids installing packages.
    constants = ast.parse(source.read("src/appworld/common/constants.py"))
    values = {}
    for node in constants.body:
        if isinstance(node, ast.Assign):
            for name in node.targets:
                if isinstance(name, ast.Name) and name.id in {"PASSWORD", "SALT"}:
                    values[name.id] = ast.literal_eval(node.value)
    code = """const fs=require('fs'),c=require('crypto');
const b=fs.readFileSync(process.argv[1]);
const key=c.pbkdf2Sync(process.argv[2],Buffer.from(process.argv[3],'hex'),100000,32,'sha256');
const d=c.createDecipheriv('aes-256-cfb',key,b.subarray(0,16));
process.stdout.write(Buffer.concat([d.update(b.subarray(16)),d.final()]));"""
    result = subprocess.run(["node", "-e", code, str(source.cache / "appworld-data.bundle"),
                             values["PASSWORD"], values["SALT"].hex()], capture_output=True, check=True)
    return zipfile.ZipFile(io.BytesIO(result.stdout))


BOUNDARY = (
    "\n\nExecution contract: perform this task only in the evaluator-provisioned benchmark "
    "environment, never in the host's real accounts, websites, or operating system. "
    "Observe tool/environment feedback and verify the requested change. "
    "Write a concise, truthful completion summary to output/response.txt. "
    "That summary is an evidence artifact, not proof that the task succeeded. "
    "If the required benchmark environment, user simulator, or tools are unavailable, "
    "report UNEVALUABLE and the missing prerequisite; do not simulate success in prose."
)
RUBRIC = (
    "必须以评测端采集的真实环境结果及上游判分器为准。output/response.txt 仅作完成说明；"
    "不得因文字声称成功、复述参考动作、伪造轨迹或自行生成成功标志而判通过。"
    "本题包的 kind=llm 只兼容现有格式，不代替上游执行判分。"
    "缺少规定的环境、私有输入、用户模拟器或原始判分器时返回 UNEVALUABLE，不记为 Agent 失败或成功。"
    "私有资源不得注入 Agent 工作区；仅由可信环境控制器和 Judge 读取。"
)


def bundle(source, family, slug, instruction, description, labels, source_paths,
           task_path, answer, assets=None, private=None, constraints=None, metadata=None,
           changes=None, timeout=1200):
    assets, private = assets or {}, private or {}
    question = {
        "schema": "evaldock.question/v1", "id": f"{family}.{slug}", "version": "1.0.0",
        "title": slug,
        "matching": {"datasetId": f"dataset.{family}.{slug}/v1", "description": description},
        "source": {
            "repository": f"https://github.com/{source.repo}", "commit": source.commit,
            "taskPath": task_path, "files": source.provenance(source_paths),
            "adaptationChanges": [
                "按既有最小 Question Bundle 格式导入真实任务，固定源版本；评分信息仅留在 private/。",
                *(changes or []),
                "新增 output/response.txt 完成说明及 process/local 两层描述性证据，不改变原始任务目标。",
                "尚未接通本项目的原生运行环境和确定性 Judge；LLM 检查不能代替原指标，缺依赖为 UNEVALUABLE。",
            ],
        },
        "capabilityLabels": labels,
        "task": {"instructions": instruction.rstrip() + BOUNDARY},
        "environment": {
            "platform": "portable", "timeoutSeconds": timeout,
            "dependencies": ["pinned upstream benchmark runtime", "isolated benchmark environment", "trusted upstream evaluator"],
            "inputs": [{"source": f"assets/{name}", "destination": f"input/{name}", "sha256": digest(data)}
                       for name, data in assets.items()],
            "setup": {"kind": "none"}, "reset": "fresh-workspace",
            "upstreamConstraints": {
                "required": True, "missingPrerequisiteResult": "UNEVALUABLE",
                "environmentReset": "restore upstream initial state before each trial",
                "privateResourcesVisibility": "controller-and-judge-only",
                **(constraints or {}),
            },
        },
        "final": {"checks": [{"id": "task-completion", "kind": "llm", "output": "output/response.txt",
                              "reference": "private/final.json"}]},
        "evidence": {
            "process": {"description": "依据实际工具反馈执行任务，不用计划或文字描述代替操作。",
                        "checkpoints": [
                            {"id": "observe", "description": "读取本题隔离环境的初始状态及有效用户指令"},
                            {"id": "execute", "description": "实际调用工具，依据返回结果继续执行、澄清或纠错"},
                            {"id": "verify", "description": "确认目标状态成立，遵循权限边界且不意外修改无关对象"}]},
            "local": {"description": "保留完成说明；真实执行轨迹及环境终态由可信运行器在 Agent 不可写区域保存。",
                      "checkpoints": [
                          {"id": "summary", "description": "交付 output/response.txt，区分已完成、失败和环境不可评测"},
                          {"id": "trusted-state", "description": "关联可信运行器采集的工具轨迹、原生结果文件或最终状态，供上游判分器检查"}]},
        },
    }
    result = {"question.json": encoded(question), "private/final.json": encoded({"answer": answer, "rubric": RUBRIC})}
    result.update({f"assets/{name}": value for name, value in assets.items()})
    result.update({f"private/{name}": value for name, value in private.items()})
    return {f"datasets/{family}/{slug}/{name}": content for name, content in result.items()}


def agentbench(source):
    result = {}
    for group, index, name in [(5, 0, "calc"), (5, 1, "count-files"), (5, 2, "date-format"),
                               (6, 2, "shared-file-permissions"), (6, 4, "recursive-permissions")]:
        relative = f"data/os_interaction/data/{group}/new.json"
        row = source.json(relative)[index]
        paths = [relative, "configs/tasks/os.yaml", "src/server/tasks/os_interaction/task.py",
                 "data/os_interaction/res/dockerfiles/default", "LICENSE"]
        check = row["evaluation"]["check"]
        if "file" in check:
            check_path = f"data/os_interaction/scripts/{group}/{check['file']}"
            code = source.read(check_path)
            paths.append(check_path)
        else:
            code = (check["code"] + "\n").encode()
        create = row.get("create", {})
        result.update(bundle(source, "agentbench-os", f"agentbench-os-{name}", row["description"],
            "在隔离 Linux 中实现命令或修正文件权限，并通过原始执行检查。", 
            ["tool-code", "loop", "reasoning-planning", "artifact-delivery"], paths,
            f"{relative}#index={index}", {"check": "private/check.sh", "success": "upstream shell checker exits 0"},
            private={"check.sh": code, "environment.json": encoded({"create": create, "round_limit": 8}),
                     "Dockerfile": source.read("data/os_interaction/res/dockerfiles/default")},
            constraints={"guestOS": "Linux", "controllerConfig": "private/environment.json", "roundLimit": 8,
                         "dockerfile": "private/Dockerfile", "neverRunSetupOnHost": True},
            metadata={"linkCatalogIndex": 1, "split": "os-std", "sourceIndex": index},
            changes=["保留原题干、初始化定义、Dockerfile 及私有 shell 检查；不在导入时运行建用户或 chmod 等系统命令。"],
            timeout=900))
    return result


def tau(source, modern):
    result = {}
    selection = [("retail", 10), ("retail", 40), ("telecom", 0), ("telecom", 20), ("telecom", 40)] if modern else [
        ("retail", 0), ("retail", 22), ("retail", 68), ("airline", 0), ("airline", 20)]
    for domain, index in selection:
        if modern:
            base = f"data/tau2/domains/{domain}"
            task_file = f"{base}/tasks.json"
            row = source.json(task_file)[index]
            policy_paths = [f"{base}/policy.md"] if domain != "telecom" else [
                f"{base}/main_policy.md", f"{base}/tech_support_manual.md", f"{base}/tech_support_workflow.md"]
            db_paths = [f"{base}/db.json"] if domain != "telecom" else [f"{base}/db.toml", f"{base}/user_db.toml"]
            assets = {Path(p).name: source.read(p) for p in policy_paths}
            scenario = {key: value for key, value in row.items() if key != "evaluation_criteria"}
            evaluation = row["evaluation_criteria"]
            runtime = f"src/tau2/domains/{domain}/environment.py"
            task_id = row["id"]
        else:
            base = f"tau_bench/envs/{domain}"
            task_file = f"{base}/tasks_test.py"
            row = tau_tasks(source, task_file)[index]
            policy_paths = [f"{base}/wiki.md"]
            db_paths = [p for p in source.members if p.startswith(f"{base}/data/") and p.endswith(".json")]
            assets = {"policy.md": source.read(policy_paths[0])}
            scenario = {"user_id": row["user_id"], "instruction": row["instruction"]}
            evaluation = {"actions": row["actions"], "outputs": row.get("outputs", [])}
            runtime = f"{base}/__init__.py"
            task_id = index
        paths = [task_file, *policy_paths, *db_paths, runtime, "LICENSE"]
        instruction = (f"Act as the {domain} customer-service agent in the provisioned tau benchmark. "
                       "Read the domain policy provided in input/ and follow it. "
                       "The benchmark user simulator will initiate the request and supply information through the conversation. "
                       "Resolve the request using the provided domain tools; ask for missing information or confirmation as required. "
                       "Do not read the user simulator's private scenario. Keep agent/user roles separate.")
        family = "tau2-bench" if modern else "tau-bench"
        result.update(bundle(source, family, f"{family}-{domain}-{index:03d}", instruction,
            f"{domain} 多轮客服：遵循政策、通过模拟用户逐步获知需求并实际修改业务状态。",
            ["tool-external", "collaboration", "reasoning-planning", "loop", "safety-boundary"], paths,
            f"{task_file}#index={index}", evaluation, assets=assets,
            private={"scenario.json": encoded(scenario)},
            constraints={"domain": domain, "taskId": task_id, "userSimulator": "required; pin model, temperature and seed",
                         "scenario": "private/scenario.json", "databaseSeed": source.provenance(db_paths),
                         "databaseSeedLocation": "pinned upstream runtime; not copied into Agent workspace",
                         "dualControl": modern and domain == "telecom"},
            metadata={"linkCatalogIndex": 4 if modern else 3, "taskId": task_id, "sourceIndex": index,
                      "split": "base" if modern else "test", "domain": domain,
                      "versionNote": "tau2-bench repository current tau3 fixed tasks" if modern else "original frozen historical tau-bench"},
            changes=["用户背景、后续信息和初始状态仅交给模拟器；不把完整用户场景变成单轮 prompt。",
                     "保留原始动作、沟通信息与状态断言；完整数据库按固定源文件及哈希 Seed，不能缩成只含答案的表。",
                     "本批不调用 Agent 或用户模拟器；分别报告原版和修订版，不混报官方分数。"], timeout=1800))
    return result


def appworld(source):
    result = {}
    archive = appworld_zip(source)
    selection = [("test_normal", "3d9a636_1"), ("test_normal", "634f342_1"), ("test_normal", "0d01c76_1"),
                 ("test_challenge", "9bf2c8a_1"), ("test_challenge", "07bb666_1")]
    bundle_sha = digest((source.cache / "appworld-data.bundle").read_bytes())
    for split, task_id in selection:
        assert task_id in archive.read(f"data/datasets/{split}.txt").decode().splitlines()
        base = f"data/tasks/{task_id}"
        specs = json.loads(archive.read(f"{base}/specs.json"))
        ground = f"{base}/ground_truth"
        private = {"evaluation.py": archive.read(f"{ground}/evaluation.py")}
        answer = {
            "taskId": task_id, "evaluator": "private/evaluation.py",
            "groundTruthAnswer": json.loads(archive.read(f"{ground}/answer.json")),
            "privateData": json.loads(archive.read(f"{ground}/private_data.json")),
            "publicData": json.loads(archive.read(f"{ground}/public_data.json")),
            "testRequirements": json.loads(archive.read(f"{ground}/test_data.json")),
        }
        task_db_paths = [p for p in archive.namelist() if p.startswith(f"{base}/dbs/")]
        private["database-diffs.json"] = encoded({p.rsplit("/", 1)[-1]: archive.read(p).decode() for p in task_db_paths})
        payload = bundle(source, "appworld", f"appworld-{task_id.replace('_', '-')}",
            specs["instruction"] + "\n\n" + "Use only the provisioned AppWorld APIs, not real services. "
            "Identify available APIs through the runtime's API documentation. "
            f"Supervisor: {json.dumps(specs['supervisor'], ensure_ascii=False)}. "
            f"Simulation datetime: {specs['datetime']}. Finish using the supervisor task-completion API.\n"
            + specs["canary_string"],
            "在 AppWorld 隔离应用中完成跨应用状态同步、内容迁移或条件筛选，校验目标及无关状态。",
            ["tool-external", "tool-code", "reasoning-planning", "loop", "safety-boundary"],
            ["src/appworld/download.py", "src/appworld/common/constants.py", "src/appworld/evaluator.py", "LICENSE"],
            f"data-0.2.0.bundle::{base}/specs.json", answer, private=private,
            constraints={"dataVersion": "0.2.0", "taskId": task_id, "split": split,
                         "dataBundleUrl": "https://s3.us-west-2.amazonaws.com/appworld.dev/data-0.2.0.bundle",
                         "dataBundleSha256": bundle_sha, "taskDatabaseDiffs": "private/database-diffs.json",
                         "baseDatabases": "provision from the same upstream bundle, do not expose raw databases to agent",
                         "runtimeSpecs": specs},
            metadata={"linkCatalogIndex": 5, "taskId": task_id, "split": split, "dataVersion": "0.2.0",
                      "redistribution": "local/private use; protected content and derivatives must be encrypted before public redistribution"},
            changes=["使用真实 test_normal/test_challenge 任务；仅本地私有解包，保留原始 canary 和再分发限制。",
                     "逐题数据库 JSONL 差异按原始文本合并到 private/database-diffs.json，空差异也保留；保留原始 evaluation.py，评分参数合并到 private/final.json。",
                     "公共基库与 apps 实现需从相同版本 bundle 初始化；须检查副作用，不能仅比较完成说明。"], timeout=1800)
        qpath = next(p for p in payload if p.endswith("/question.json"))
        question = json.loads(payload[qpath])
        original_paths = [f"data/datasets/{split}.txt", f"{base}/specs.json", *task_db_paths,
                          *[f"{ground}/{name}" for name in ["evaluation.py", "answer.json", "private_data.json", "public_data.json", "test_data.json"]]]
        question["source"]["files"].extend([{"path": f"data-0.2.0.bundle::{p}", "sha256": digest(archive.read(p))} for p in original_paths])
        question["source"]["files"].append({"path": "https://s3.us-west-2.amazonaws.com/appworld.dev/data-0.2.0.bundle", "sha256": bundle_sha})
        payload[qpath] = encoded(question)
        result.update(payload)
    return result


def bfcl(source):
    result = {}
    base = "berkeley-function-call-leaderboard/bfcl_eval"
    for category, index in [("base", 1), ("base", 60), ("miss_param", 90), ("miss_func", 120), ("long_context", 150)]:
        relative = f"{base}/data/BFCL_v4_multi_turn_{category}.json"
        answer_path = f"{base}/data/possible_answer/BFCL_v4_multi_turn_{category}.json"
        row = source.jsonl(relative)[index]
        gold = next(r for r in source.jsonl(answer_path) if r["id"] == row["id"])
        assert len(row["question"]) == len(gold["ground_truth"])
        scenario = {k: v for k, v in row.items() if k not in {"id", "path"}}
        instruction = "This is a stateful, multi-turn BFCL task. Use the provided simulated tools. "
        instruction += "The controller reveals later user turns and any newly available functions only at their designated round. "
        instruction += "Do not invent missing parameters or functions. Preserve tool state between rounds.\n\nFirst user turn:\n"
        instruction += "\n".join(message["content"] for message in row["question"][0])
        result.update(bundle(source, "bfcl-multiturn", "bfcl-" + row["id"].replace("_", "-"), instruction,
            f"BFCL V4 {category} 多轮模拟工具任务，测跨轮状态、参数澄清及反馈驱动执行。",
            ["tool-external", "reasoning-planning", "loop", "collaboration"],
            [relative, answer_path, f"{base}/eval_checker/multi_turn_eval/multi_turn_checker.py", "LICENSE"],
            f"{relative}#id={row['id']}", {"groundTruth": gold["ground_truth"], "upstreamPathMetadata": row.get("path", [])},
            private={"scenario.json": encoded(scenario)},
            constraints={"scenario": "private/scenario.json", "turnCount": len(row["question"]),
                         "toolClasses": row["involved_classes"], "toolDefinitions": f"{base}/data/multi_turn_func_doc/",
                         "toolImplementation": f"{base}/eval_checker/multi_turn_eval/func_source_code/",
                         "protocol": "progressive turns; execute native tools; apply excluded/missed functions; native per-turn state and response/path checks"},
            metadata={"linkCatalogIndex": 6, "taskId": row["id"], "split": category, "sourceLine": index + 1},
            changes=["只选多轮执行题，不引入单轮 AST 问答题；完整各轮、初始状态和工具增删规则保留在私有 scenario。",
                     "参考调用轨迹放入 private/final.json，需原始工具实现和多轮判分器，不能退化为文本函数名匹配。"], timeout=1200))
    return result


def webarena(source, visual):
    result = {}
    selection = [("classifieds", 28), ("classifieds", 57), ("classifieds", 160), ("shopping", 36), ("shopping", 46)] if visual else [
        ("", i) for i in [389, 431, 475, 486, 809]]
    family = "visualwebarena" if visual else "webarena"
    for site, task_id in selection:
        relative = f"config_files/vwa/test_{site}.raw.json" if visual else "config_files/test.raw.json"
        row = next(r for r in source.json(relative) if r["task_id"] == task_id)
        assert "program_html" in row["eval"]["eval_types"]
        assert not row.get("image"), "External reference image must be separately imported"
        slug = f"{family}-{site + '-' if site else ''}{task_id:03d}"
        launch = {key: row[key] for key in ["sites", "require_login", "start_url", "geolocation", "viewport_size"] if key in row}
        launch["require_reset"] = True
        result.update(bundle(source, family, slug,
            row["intent"] + "\n\nUse the browser session provisioned for the benchmark. "
            "input/browser.json declares the initial site/page configuration; the controller resolves site placeholders to isolated local endpoints. "
            "Use live page feedback" + (" and visual page content" if visual else "") + "; do not use production sites.",
            "根据" + ("视觉页面与" if visual else "") + "网页状态完成实际修改，使用原生 URL/DOM/状态条件验证。",
            (["multimodal"] if visual else []) + ["tool-web", "reasoning-planning", "loop", "artifact-delivery"],
            [relative, "evaluation_harness/evaluators.py", "LICENSE"], f"{relative}#task_id={task_id}", row["eval"],
            assets={"browser.json": encoded(launch)},
            constraints={"nativeTaskId": task_id, "sites": row["sites"], "nativeRequireReset": row["require_reset"],
                         "authenticationState": "provision fresh benchmark account/session; never reuse real browser cookies",
                         "siteSnapshots": "official pinned benchmark environment snapshots required; not bundled here"},
            metadata={"linkCatalogIndex": 8 if visual else 7, "taskId": task_id, "split": site or "test",
                      "intentTemplateId": row["intent_template_id"],
                      **({"visualDifficulty": row.get("visual_difficulty"), "reasoningDifficulty": row.get("reasoning_difficulty")} if visual else {})},
            changes=["原题干不变，选取真实状态变更任务；原 eval 原样私有保留，comments 与参考 URL 不提供给 Agent。",
                     "公开输入仅含起始站点及视口参数。网站数据库/图片需由原生站点提供；每题从官方快照重置以免状态污染。",
                     "原生评测器必须执行；LLM 不得只凭网页操作说明或最终文本判断成功。"], timeout=1800))
    return result


def osworld(source):
    result = {}
    selection = [
        ("chrome", "030eeff7-b492-4218-b312-701ec99ee0cc"),
        ("gimp", "7b7617bd-57cc-468e-9c91-40c4ec2bcb3d"),
        ("libreoffice_impress", "2cd43775-7085-45d8-89fa-9e35c0a915cf"),
        ("vs_code", "930fdb3b-11a8-46fe-9bac-577332e2640e"),
        ("vlc", "a5bbbcd5-b398-4c91-83d4-55e1e31bbb81"),
    ]
    for app, task_id in selection:
        relative = f"evaluation_examples/examples/{app}/{task_id}.json"
        row = source.json(relative)
        assert not any(c["type"] in {"download", "googledrive"} for c in row["config"])
        init = {k: row[k] for k in ["id", "snapshot", "config", "related_apps", "proxy", "fixed_ip"] if k in row}
        result.update(bundle(source, "osworld", f"osworld-{app.replace('_', '-')}-{task_id[:8]}",
            row["instruction"] + "\n\nOperate the evaluator-provisioned OSWorld desktop only. "
            "Use the chosen benchmark action interface and observe the application after changes. "
            "Guest Linux paths and shortcuts are not macOS host paths or shortcuts.",
            f"在 OSWorld 的 {app} 桌面应用中执行设置变更并验证持久状态，不是回答操作步骤。",
            ["multimodal", "tool-external", "loop", "artifact-delivery"], [relative, "LICENSE"], relative,
            row["evaluator"], private={"environment.json": encoded(init)},
            constraints={"guestOS": "Linux", "snapshot": row["snapshot"], "controllerConfig": "private/environment.json",
                         "nativeTaskId": task_id, "nativeEvaluatorRoot": "desktop_env/evaluators/",
                         "actionSpace": "must be pinned by evaluation protocol; record whether computer-use or command tools are allowed",
                         "externalTaskDownloads": False},
            metadata={"linkCatalogIndex": 9, "taskId": task_id, "split": app, "benchmark": "OSWorld original/Verified, not OSWorld-V2"},
            changes=["保留原始 instruction、快照初始化配置与完整 evaluator；仅选无额外文件下载的五种应用设置任务。",
                     "这是入门接入子集，不代表 OSWorld 的复杂文档/跨应用全量难度；虚拟机与应用版本仍须固定。"], timeout=1200))
    return result


def workarena(source):
    result = {}
    base = "src/browsergym/workarena"
    selection = [
        ("sort_incident_list_task", 2, "SortIncidentListTask", "list"),
        ("sort_hardware_list_task", 1, "SortHardwareListTask", "list"),
        ("sort_user_list_task", 1, "SortUserListTask", "list"),
        ("order_developer_laptop_task", 0, "OrderDeveloperLaptopTask", "service_catalog"),
        ("order_ipad_mini_task", 1, "OrderIpadMiniTask", "service_catalog"),
    ]
    for name, index, task_class, module in selection:
        relative = f"{base}/data_files/task_configs/{name}.json"
        config = source.json(relative)[index]
        if "goal" in config:
            instruction = config["goal"]
        else:
            instruction = f'Go to the hardware store and order {config["quantity"]} "{config["item"]}"'
            if config["configuration"]:
                instruction += " with configuration " + str({k: v[1] for k, v in config["configuration"].items()})
        result.update(bundle(source, "workarena", f"workarena-{name.removesuffix('_task').replace('_', '-')}-{index:03d}",
            instruction + "\n\nUse only the provisioned WorkArena ServiceNow instance. "
            "Complete the real browser workflow; for an order, submit it in the benchmark instance and verify the created request.",
            "在 WorkArena ServiceNow 隔离实例中完成多字段列表排序或指定配置订购，验证浏览器及业务状态。",
            ["tool-web", "reasoning-planning", "loop", "artifact-delivery"],
            [relative, f"{base}/tasks/{module}.py", "LICENSE"], f"{relative}#index={index}",
            {"taskClass": f"browsergym.workarena.tasks.{module}.{task_class}", "fixedConfig": config,
             "requiredReward": 1, "validator": f"{task_class}.validate", "seed": 42},
            constraints={"runtimeClass": f"browsergym.workarena.tasks.{module}.{task_class}", "seed": 42,
                         "fixedConfigSource": "private/final.json#answer.fixedConfig",
                         "instance": "authorized WorkArena ServiceNow benchmark instance required",
                         "initialization": "official task.setup with fixed_config; reset and teardown each trial",
                         "validator": f"{task_class}.validate", "level": "L1"},
            metadata={"linkCatalogIndex": 10, "sourceIndex": index, "split": "L1", "taskClass": task_class},
            changes=["从官方固定配置选取 3 个多字段排序、2 个订购任务；排序原 goal 不变，订购目标按官方 setup 的字符串模板生成。",
                     "仅覆盖 WorkArena-L1，不冒充 WorkArena++ 长流程任务；ServiceNow 实例仍需用户取得授权。"], timeout=1500))
    return result


GENERATORS = {
    "agentbench": agentbench, "tau-bench": lambda source: tau(source, False),
    "tau2-bench": lambda source: tau(source, True), "appworld": appworld, "bfcl": bfcl,
    "webarena": lambda source: webarena(source, False),
    "visualwebarena": lambda source: webarena(source, True), "osworld": osworld, "workarena": workarena,
}
FAMILIES = {"agentbench": "agentbench-os", "bfcl": "bfcl-multiturn"}
CATALOG = {
    "agentbench-os": ("dataset.agentbench-os/v1", "AgentBench OS",
        "数据集: AgentBench OS\n最突出的测试对象: Linux 终端操作、命令实现、文件权限修改与执行结果核验\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含计算、文件计数、日期格式化命令实现和两道权限修改任务\n"
        "输出与评分: 终端执行轨迹、文件及权限状态；使用原始 shell 检查器判定任务成功\n"
        "最适合的 Agent: 终端 Agent、代码执行 Agent、系统操作 Agent\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\n在隔离 Linux 环境中理解目标、执行命令并检查实际结果，重点观察工具使用与执行闭环，不以口头给出命令作为完成。\n\n"
        "2. 评测层级设计\n第一层检查目标结果；第二层检查命令调用、报错处理和结果复核；第三层由原始检查器验证文件、权限及程序行为。\n\n"
        "3. 输入和环境\n使用原题干、初始化配置和私有 shell 检查，OS 交互上限为 8 轮。需要隔离 Linux/Docker 环境，每题重置；初始化不得在 macOS 宿主执行。\n\n"
        "4. 输出与评分\n交付 output/response.txt 并保留工具结果，以原始检查器的执行结果为任务成功依据。标签评分观察终端操作、步骤规划、纠错及产物交付，文本评分不能替代执行检查。\n\n"
        "5. 适配能力\n适配代码与终端工具、推理与规划、执行闭环和产物交付；可直接观察命令效果及失败后的调整。\n\n"
        "6. 不适配情况\n不适合没有终端工具的纯文本模型，也不适合无法隔离或重置操作系统状态的评测配置。\n\n"
        "7. 匹配关键词\nAgentBench OS, Linux, shell, command execution, file permissions, tool-code, loop\n\n"
        "8. 当前局限\n仅覆盖 AgentBench v0.2 的 5 道 OS 任务，与既有 DBBench 16 题独立；不是完整 AgentBench 成绩。固定版本与来源见 question.source，缺少原生环境或检查器时应判 UNEVALUABLE。"),
    "tau-bench": ("dataset.taubench/v1", "τ-bench",
        "数据集: τ-bench\n最突出的测试对象: 多轮需求澄清、业务政策遵循、API 操作和数据库状态核验\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含 retail 3 题、airline 2 题\n"
        "输出与评分: 用户对话、工具调用和最终业务状态；使用原始参考动作及沟通条件评价\n"
        "最适合的 Agent: 客服 Agent、业务 API Agent、多轮任务助理\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\nAgent 通过对话逐步获取需求，在业务政策约束下调用工具完成零售或航空任务，重点观察沟通与真实业务操作的结合。\n\n"
        "2. 评测层级设计\n第一层检查用户目标和必要沟通是否满足；第二层检查信息澄清、政策执行及工具反馈处理；第三层检查数据库最终状态。\n\n"
        "3. 输入和环境\n公开业务政策与工具接口，私有用户指令仅交给用户模拟器。需要同版本官方数据库、用户模拟器及可重置的业务环境，数据库按题内来源哈希初始化。\n\n"
        "4. 输出与评分\n保存完整对话、工具返回及 output/response.txt，使用私有参考动作和沟通条件接入原生状态 Judge。标签评分关注 API 使用、规划、闭环及政策边界，不能只匹配最终回复。\n\n"
        "5. 适配能力\n适配 API 与业务系统工具、推理与规划、执行闭环、安全与权限边界，以及与模拟用户的信息协作；可观察是否取得必要信息并在允许范围内修改状态。\n\n"
        "6. 不适配情况\n不适合单轮静态问答配置；不能将模拟用户的完整背景预先公开给 Agent，也不能在真实业务账号上执行测试操作。\n\n"
        "7. 匹配关键词\nτ-bench, retail, airline, user simulator, policy compliance, API, database state\n\n"
        "8. 当前局限\n本组是原版 τ-bench 的 5 题历史对照子集，不与 τ²/τ³ 修订任务混报成绩。固定版本见 question.source；缺少用户模拟器、数据库或原生评分器时应判 UNEVALUABLE。"),
    "tau2-bench": ("dataset.tau2-bench/v1", "τ²-bench",
        "数据集: τ²-bench\n最突出的测试对象: 多轮协作、用户与 Agent 双向工具操作、业务政策和环境状态推理\n"
        "当前输入形态: 5 个逐题 Question Bundle，取自 tau2-bench 仓库的 τ³ 修订任务，包含 retail 2 题、telecom 3 题\n"
        "输出与评分: 双端对话与工具轨迹、业务状态及设备状态；按原生动作和环境断言评价\n"
        "最适合的 Agent: 交互式客服 Agent、电信故障处理 Agent、业务 API Agent\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\n在用户与 Agent 共同影响环境的任务中澄清问题、遵循政策并协调操作，重点观察多轮决策和状态变化后的策略调整。\n\n"
        "2. 评测层级设计\n第一层检查业务目标是否完成；第二层检查双方沟通、工具调用与信息依赖；第三层检查业务数据库及电信设备状态断言。\n\n"
        "3. 输入和环境\n公开政策和技术手册，用户背景及初始状态保存在私有资源中。需要同版本官方数据库、用户模拟器和双端工具环境，固定双方模型与随机种子，每题重置。\n\n"
        "4. 输出与评分\n保存双端交互记录及 output/response.txt，依据原始参考动作、设备初始化和环境断言接入原生 Judge。应验证真实状态改变，不能将参考动作名称匹配或自然语言总结当作成功。\n\n"
        "5. 适配能力\n适配 API 与业务系统工具、推理与规划、执行闭环、安全与权限边界，以及可观察的双方协作。\n\n"
        "6. 不适配情况\n不适合只提供 Agent 单侧工具反馈的配置；不应一次性公开用户背景，也不能省略电信任务的用户设备环境。\n\n"
        "7. 匹配关键词\nτ²-bench, τ³-bench, telecom, retail, dual-control, user simulator, environment assertions\n\n"
        "8. 当前局限\n名称沿用清单中的 τ²-bench，但所选固定提交实际是 τ³ 修订任务，不代表原 τ² 论文快照或全量成绩。版本见 question.source；缺少双端环境或原生评分器时应判 UNEVALUABLE。"),
    "appworld": ("dataset.appworld/v1", "AppWorld",
        "数据集: AppWorld\n最突出的测试对象: 多应用 API 编排、数据处理、跨应用任务完成与副作用控制\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含 test_normal 3 题、test_challenge 2 题\n"
        "输出与评分: 应用数据库最终状态及执行记录；使用逐题原始 evaluation.py 检查目标和无关副作用\n"
        "最适合的 Agent: 个人助理 Agent、代码驱动 API Agent、多应用工作流 Agent\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\n通过应用 API 完成联系人同步、Spotify 播放列表整理、笔记迁移及购物车条件转移，重点观察跨应用数据依赖和实际执行能力。\n\n"
        "2. 评测层级设计\n第一层检查用户目标；第二层检查 API 选择、数据处理与调用顺序；第三层由原始测试验证目标状态，并检查不应改变的其他应用数据。\n\n"
        "3. 输入和环境\n使用官方 data-0.2.0 数据和对应代码版本，题包保留数据库差异及私有评测代码。需要同版本基库、apps 运行时和隔离执行环境，每次试验重新初始化。\n\n"
        "4. 输出与评分\n交付 output/response.txt 并保存代码和 API 执行结果，以私有 evaluation.py 及其完整参数检查数据库变化。标签评分观察 API 与代码工具、规划、闭环和副作用边界，不以回复声称完成为依据。\n\n"
        "5. 适配能力\n适配 API 与业务系统工具、代码与终端工具、推理与规划、执行闭环及安全与权限边界，检查目标外的数据是否保持不变。\n\n"
        "6. 不适配情况\n不适合没有应用运行时或无法执行 API 的系统；不能只提供最终答案，也不能省略无关数据库的副作用检查。\n\n"
        "7. 匹配关键词\nAppWorld, application APIs, cross-app workflow, database diffs, code execution, side effects\n\n"
        "8. 当前局限\n5 题仅覆盖有限应用流程，不代表全量成绩；缺少基库、运行时或原生评分器时应判 UNEVALUABLE。解包内容仅限本地或私有使用，公开再分发及衍生内容须遵守随目录保留的加密分发许可要求。"),
    "bfcl-multiturn": ("dataset.bfcl-multiturn/v1", "BFCL V4 Multi-Turn",
        "数据集: BFCL V4 Multi-Turn\n最突出的测试对象: 有状态多轮函数调用、参数澄清、工具缺失处理和上下文保持\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含 base 2 题及 miss_param、miss_func、long_context 各 1 题\n"
        "输出与评分: 各轮工具执行、状态和调用路径；使用原生多轮评测器评价\n"
        "最适合的 Agent: 函数调用 Agent、API 助理、多轮工具使用 Agent\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\n在连续对话中选择工具、补齐参数、处理工具不可用情形，并延续前序操作产生的状态。仅选择有状态多轮任务，不包含单轮 AST 匹配题。\n\n"
        "2. 评测层级设计\n第一层检查每轮目标；第二层检查参数澄清、工具可用性判断和跨轮信息使用；第三层检查执行后的状态及原生评测器要求的调用路径。\n\n"
        "3. 输入和环境\n私有 scenario 保存完整轮次、初始配置及工具增删规则，由控制器逐轮释放。需要原生工具类、可重置状态和多轮驱动，不能提前公开后续对话。\n\n"
        "4. 输出与评分\n保存每轮工具返回和最终 output/response.txt，依据私有 ground truth 接入原生多轮状态与路径评测。不能仅匹配函数名称，也不能把多轮任务扁平化后做单次文本评分。\n\n"
        "5. 适配能力\n适配 API 与业务系统工具、推理与规划、执行闭环，以及与对话方的参数澄清和信息协作；不等同于子 Agent 委派或跨会话长期记忆测试。\n\n"
        "6. 不适配情况\n不适合只能输出静态函数调用而不能接收执行反馈的系统，也不适合缺少逐轮控制器的单轮评测配置。\n\n"
        "7. 匹配关键词\nBFCL V4, multi-turn, function calling, missing parameter, missing function, long context, stateful tools\n\n"
        "8. 当前局限\n5 题是四类多轮任务的接入子集，不代表 BFCL 全量或单轮能力。固定版本见 question.source；缺少工具运行时、多轮控制器或原生评分器时应判 UNEVALUABLE。"),
    "webarena": ("dataset.webarena/v1", "WebArena",
        "数据集: WebArena\n最突出的测试对象: 多步网页导航、信息比较、表单操作和网站状态变更\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含评论、跨页比较后加购、新建仓库、修改 CMS 标题和创建 issue\n"
        "输出与评分: 浏览器轨迹与网站最终状态；使用私有 program_html 断言和原生 URL/DOM 评测器\n"
        "最适合的 Agent: 浏览器 Agent、网页工作流 Agent、网站操作助理\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\nAgent 在受控网站中完成真实页面操作，任务结果体现为评论、购物车、仓库、内容或工单状态的改变，不是只从网页查找答案。\n\n"
        "2. 评测层级设计\n第一层检查任务目标；第二层检查导航、跨页比较、字段填写和提交后的确认；第三层检查网站中的目标对象及其属性。\n\n"
        "3. 输入和环境\n公开起始站点配置，完整 eval 仅供私有评测。需要官方自托管网站、隔离账号、浏览器和原生评测器，每题恢复网站状态与登录态。\n\n"
        "4. 输出与评分\n交付 output/response.txt 并保留浏览器轨迹，以 program_html 等原始状态断言判定成功。应核对评论、购物车商品和 issue 指派及到期日等真实结果，不能仅凭自然语言总结评分。\n\n"
        "5. 适配能力\n适配浏览器与网络工具、推理与规划、执行闭环和产物交付，可观察多步操作及提交后的结果核验。\n\n"
        "6. 不适配情况\n不适合只读网页检索系统或没有网站重置能力的配置；不能用真实业务网站替代隔离基准实例。\n\n"
        "7. 匹配关键词\nWebArena, browser automation, navigation, form filling, program_html, DOM, website state\n\n"
        "8. 当前局限\n仅选取原版 WebArena 的 5 道状态变更题，不是 WebArena-Verified，也不代表全量难度。固定版本见 question.source；缺少网站快照、浏览器或原生评分器时应判 UNEVALUABLE。"),
    "visualwebarena": ("dataset.visualwebarena/v1", "VisualWebArena",
        "数据集: VisualWebArena\n最突出的测试对象: 网页视觉理解、图文目标定位、多步浏览器操作和状态核验\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含 Classifieds 3 题、Shopping 2 题，视觉素材来自站点页面\n"
        "输出与评分: 视觉与浏览器操作轨迹、评论或购物状态；使用原始 program_html 状态检查\n"
        "最适合的 Agent: 多模态浏览器 Agent、视觉网页操作 Agent\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\n根据页面图片识别商品或对象，再执行评论、加入愿望单或购物车等操作，重点观察视觉识别能否支撑真实网页任务完成。\n\n"
        "2. 评测层级设计\n第一层检查图文目标是否识别正确；第二层检查视觉定位、页面导航及操作反馈；第三层检查评论、愿望单或购物车的最终状态。\n\n"
        "3. 输入和环境\n需要官方站点快照、完整页面图片、浏览器视觉输入、固定视口和登录态，每题重置。所选题没有独立题面图片，不能因此省略网页中的视觉素材。\n\n"
        "4. 输出与评分\n保存页面观察、浏览器轨迹和 output/response.txt，以私有 program_html 断言验证最终状态。多模态标签核对视觉事实与操作对象，文本描述或单次图像问答不能替代网站执行评分。\n\n"
        "5. 适配能力\n适配多模态理解、浏览器与网络工具、推理与规划、执行闭环及产物交付。\n\n"
        "6. 不适配情况\n不适合只接收纯文本网页的系统，也不适合无法加载图片、固定视口或重置网站的评测环境。\n\n"
        "7. 匹配关键词\nVisualWebArena, visual grounding, multimodal browser, classifieds, shopping, program_html\n\n"
        "8. 当前局限\n5 题只覆盖两个站点和有限操作类型，不代表完整视觉网页能力。固定版本见 question.source；缺少必要图片、站点环境或原生评分器时应判 UNEVALUABLE。"),
    "osworld": ("dataset.osworld/v1", "OSWorld",
        "数据集: OSWorld\n最突出的测试对象: 桌面视觉操作、应用设置修改、交互反馈处理和应用状态核验\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含 Chrome、GIMP、LibreOffice Impress、VS Code、VLC 各 1 题\n"
        "输出与评分: 桌面操作轨迹和应用最终状态；使用题内原始 evaluator 检查\n"
        "最适合的 Agent: 桌面 GUI Agent、计算机操作 Agent、多模态应用助理\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\n在隔离桌面环境中完成应用设置变更，通过界面观察、操作和复核达成目标，重点观察计算机使用能力及实际状态改变。\n\n"
        "2. 评测层级设计\n第一层检查任务目标；第二层检查界面观察、动作反馈和错误恢复；第三层由原始 evaluator 检查应用配置或文件状态。\n\n"
        "3. 输入和环境\n题包保留完整虚拟机初始化和私有 evaluator。需要固定 Linux VM 快照、应用版本与动作接口，每题重置；guest 路径及应用设置操作不得迁移到宿主机。\n\n"
        "4. 输出与评分\n保存桌面观察、动作结果及 output/response.txt，以原始 evaluator 的 result 与 expected 配置判定成功。标签评分观察多模态输入、应用工具操作、闭环和交付，不能只比较最终文字。\n\n"
        "5. 适配能力\n适配多模态理解、外部应用工具操作、执行闭环及产物交付，适用于具有桌面动作接口的 Agent。\n\n"
        "6. 不适配情况\n不适合没有截图输入或桌面操作接口的系统；只有静态屏幕定位答案不能构成本组任务完成。\n\n"
        "7. 匹配关键词\nOSWorld, desktop GUI, computer use, application settings, virtual machine, visual interaction\n\n"
        "8. 当前局限\n本组来自原始/Verified 主基准，是无需额外任务文件下载的 5 道设置变更题，不是 OSWorld-V2，也不代表复杂文档任务难度。固定版本见 question.source；缺少 VM、应用或原生评分器时应判 UNEVALUABLE。"),
    "workarena": ("dataset.workarena/v1", "WorkArena",
        "数据集: WorkArena\n最突出的测试对象: 企业网页列表操作、服务目录配置、订单提交和业务状态核验\n"
        "当前输入形态: 5 个逐题 Question Bundle，包含 WorkArena-L1 的 3 道多字段排序和 2 道指定配置订购任务\n"
        "输出与评分: 浏览器操作轨迹和 ServiceNow 测试实例状态；使用官方任务类的 validate 方法评价\n"
        "最适合的 Agent: 企业浏览器 Agent、ServiceNow 助理、业务流程自动化 Agent\n"
        "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配\n\n"
        "1. 基本定位\n在隔离 ServiceNow 实例中完成 incidents、hardware、users 列表排序，或按指定配置订购开发笔记本和 iPad mini，重点观察企业页面操作与结果核验。\n\n"
        "2. 评测层级设计\n第一层检查排序或订购目标；第二层检查字段选择、配置填写及提交后的确认；第三层检查列表状态或实际创建的请求。\n\n"
        "3. 输入和环境\n使用官方 fixed_config、任务类和 setup/teardown，固定 seed=42。需要已获授权的 WorkArena ServiceNow 测试实例与浏览器，每题初始化并清理。\n\n"
        "4. 输出与评分\n保存浏览器轨迹和 output/response.txt，以对应任务类 validate 返回的 reward=1 作为任务成功条件。核对多字段排序和完整订单配置，不能把进入正确页面或口头描述步骤当作完成。\n\n"
        "5. 适配能力\n适配浏览器与网络工具、推理与规划、执行闭环及产物交付，可观察企业页面操作和业务结果确认。\n\n"
        "6. 不适配情况\n不适合没有授权测试实例或浏览器操作能力的系统；不得在真实企业实例执行评测订购和记录修改。\n\n"
        "7. 匹配关键词\nWorkArena, ServiceNow, enterprise workflow, list sorting, service catalog, fixed_config, validate\n\n"
        "8. 当前局限\n本组仅覆盖 WorkArena-L1 的 5 道任务，不代表 WorkArena++ 的长流程难度。固定版本见 question.source；缺少授权实例、官方任务环境或原生评分器时应判 UNEVALUABLE。"),
}


def update_catalog(files, check=False):
    target = ROOT / "datasets/catalog.md"
    old = target.read_text()
    match = re.search(r"```json evaldock-dataset-catalog\s*\n([\s\S]*?)\n```", old)
    if match is None:
        raise ValueError("Missing catalog JSON block")
    catalog = json.loads(match.group(1))
    original = copy.deepcopy(catalog["datasets"])
    for family, (dataset_id, name, description) in CATALOG.items():
        questions = [json.loads(data) for p, data in files.items()
                     if p.startswith(f"datasets/{family}/") and p.endswith("/question.json")]
        if not questions:
            continue
        entry = {
            "datasetId": dataset_id, "name": name,
            "description": description,
            "labelIds": sorted({f"label.{label}/v1" for q in questions for label in q["capabilityLabels"]}),
            "availableCaseCount": len(questions),
        }
        index = next((i for i, item in enumerate(catalog["datasets"]) if item["datasetId"] == dataset_id), None)
        if index is None:
            catalog["datasets"].append(entry)
        else:
            catalog["datasets"][index] = entry
    # Keep this imported batch together at the end of the catalog.  The order
    # follows CATALOG (the same order used by the benchmark link list).
    target_order = [row[0] for row in CATALOG.values()]
    target_ids = set(target_order)
    by_id = {entry["datasetId"]: entry for entry in catalog["datasets"]}
    missing = [dataset_id for dataset_id in target_order if dataset_id not in by_id]
    if missing:
        raise ValueError(f"Catalog entries missing before reorder: {missing}")
    catalog["datasets"] = ([entry for entry in catalog["datasets"] if entry["datasetId"] not in target_ids]
                            + [by_id[dataset_id] for dataset_id in target_order])
    targets = target_ids
    assert [r for r in original if r["datasetId"] not in targets] == [r for r in catalog["datasets"] if r["datasetId"] not in targets]
    payload = json.dumps(catalog, ensure_ascii=False, indent=2)
    new = old[:match.start(1)] + payload + old[match.end(1):]
    if check:
        if old != new:
            raise ValueError("Catalog does not match imported tasks")
    elif old != new:
        patch = "*** Begin Patch\n*** Update File: datasets/catalog.md\n@@\n"
        patch += "\n".join("-" + line for line in old.rstrip("\n").split("\n")) + "\n"
        patch += "\n".join("+" + line for line in new.rstrip("\n").split("\n")) + "\n*** End Patch"
        subprocess.run(["apply_patch", patch], cwd=ROOT, capture_output=True, check=True)


def download_plan(cache, families):
    items = []
    for family in families:
        repo, commit = SPECS[family]
        if family == "visualwebarena":
            for relative in ["LICENSE", "README.md", "evaluation_harness/evaluators.py", *[
                f"config_files/vwa/test_{site}.raw.json" for site in ["classifieds", "shopping", "reddit"]]]:
                local = "visual-" + (relative.rsplit("/", 1)[-1] if relative.startswith("config_files/") else relative.replace("/", "__"))
                items.append({"url": f"https://raw.githubusercontent.com/{repo}/{commit}/{relative}", "destination": str(cache / local)})
        else:
            items.append({"url": f"https://codeload.github.com/{repo}/tar.gz/{commit}", "destination": str(cache / f"{family}.tar.gz")})
        if family == "appworld":
            items.append({"url": "https://s3.us-west-2.amazonaws.com/appworld.dev/data-0.2.0.bundle", "destination": str(cache / "appworld-data.bundle")})
    return items


def generate(cache, selected):
    result = {}
    for family in selected:
        source = Source(cache, family)
        additions = GENERATORS[family](source)
        if len([p for p in additions if p.endswith("/question.json")]) != 5:
            raise ValueError(f"{family}: expected 5 tasks")
        if result.keys() & additions.keys():
            raise ValueError("Duplicate generated paths")
        result.update(additions)
        license_text = source.read("LICENSE")
        if family == "appworld":
            license_text += ("\n\nThe task data are protected portions of AppWorld. Any public redistribution "
                             "of this content or its derivatives must be in encrypted format. "
                             "These decoded question bundles are for local/private use only.\n").encode()
        result[f"datasets/{FAMILIES.get(family, family)}/LICENSE"] = license_text
    # apply_patch emits terminated text files. Only add a missing final newline;
    # the source hashes still refer to original upstream bytes, input hashes to
    # the installed bytes. Embedded JSONL strings remain byte-for-byte intact.
    normalized = {p for p, data in result.items() if data and not data.endswith(b"\n")}
    for p in normalized:
        result[p] += b"\n"
    for p in list(result):
        if not p.endswith("/question.json"):
            continue
        q = json.loads(result[p])
        prefix = p.removesuffix("question.json")
        adjusted = [name.removeprefix(prefix) for name in normalized if name.startswith(prefix)]
        if adjusted:
            q["source"]["adaptationChanges"].append("仅为以下文本补终止换行，源哈希仍对应原始字节：" + ", ".join(sorted(adjusted)))
        for item in q["environment"]["inputs"]:
            item["sha256"] = digest(result[prefix + item["source"]])
        result[p] = encoded(q)
    return result


def install(files, check=False):
    changed = 0
    # Validate every path and all existing files before making any edits.
    for relative, data in files.items():
        target = ROOT / relative
        if not relative.startswith("datasets/") or ".." in Path(relative).parts:
            raise ValueError(f"Unsafe output: {relative}")
        for parent in [target, *target.parents]:
            if parent == ROOT:
                break
            if parent.is_symlink():
                raise ValueError(f"Refusing symbolic link: {parent}")
        if target.exists() and target.read_bytes() != data:
            raise ValueError(f"Refusing changed existing file: {relative}")
        if check and not target.is_file():
            raise ValueError(f"Missing generated file: {relative}")
        data.decode("utf-8")
        if not data.endswith(b"\n"):
            raise ValueError(f"Source lacks terminal newline; normalize explicitly: {relative}")
    if not check:
        for relative, data in files.items():
            if (ROOT / relative).exists():
                continue
            content = data.decode("utf-8")
            # apply_patch writes a final newline. Preserve exact source bytes.
            if not content.endswith("\n"):
                raise ValueError(f"Source lacks terminal newline; normalize explicitly: {relative}")
            patch = "*** Begin Patch\n*** Add File: " + relative + "\n" + "\n".join("+" + line for line in content.split("\n")[:-1]) + "\n*** End Patch"
            subprocess.run(["apply_patch", patch], cwd=ROOT, capture_output=True, check=True)
            if (ROOT / relative).read_bytes() != data:
                raise ValueError(f"Written bytes differ: {relative}")
            changed += 1
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--inspect", nargs=2, metavar=("FAMILY", "PATH"))
    parser.add_argument("--list", nargs=2, metavar=("FAMILY", "PATTERN"))
    parser.add_argument("--families", nargs="+", choices=list(SPECS), default=list(SPECS))
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--catalog", action="store_true")
    parser.add_argument("--print-downloads", action="store_true")
    args = parser.parse_args()
    if args.print_downloads:
        print(json.dumps(download_plan(args.cache, args.families), indent=2))
    elif args.inspect:
        family, relative = args.inspect
        source = Source(args.cache, family)
        if family == "appworld" and relative.startswith("data/"):
            content = appworld_zip(source).read(relative)
        elif relative.endswith("tasks_test.py"):
            content = encoded(tau_tasks(source, relative))
        else:
            content = source.read(relative)
        print(content.decode())
    elif args.list:
        family, pattern = args.list
        source = Source(args.cache, family)
        paths = appworld_zip(source).namelist() if family == "appworld" else source.members
        print("\n".join(p for p in paths if re.search(pattern, p)))
    else:
        files = generate(args.cache, args.families)
        summary = {"cases": len([p for p in files if p.endswith("/question.json")]), "files": len(files),
                   "bytes": sum(map(len, files.values())), "families": args.families}
        if args.write or args.check:
            summary["writtenFiles"] = install(files, check=args.check)
            if args.catalog:
                update_catalog(files, check=args.check)
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
