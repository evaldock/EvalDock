#!/usr/bin/env python3
"""Import 4 x 5 pinned specialist-agent tasks, without running agents or upstream code.

Use --print-downloads to reproduce the source cache, --fetch-dsbench for bounded
HTTP range downloads from the official ZIP, then --write --catalog. --check
regenerates all outputs and verifies their bytes. Only SWE Parquet reading needs
pyarrow (21.0.0); it may be installed in <cache>/python-libs, not in the project.
Generated repository text files are installed with apply_patch. Existing files
with different contents are never overwritten. Source archives are never extracted.
"""

from __future__ import annotations

import argparse
import ast
import concurrent.futures
import csv
import hashlib
import io
import json
import re
import struct
import subprocess
import sys
import tarfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BATCH = "agent-specialist-2026-09-10"
PINS = {
    "swe": ("scaleapi/SWE-bench_Pro-os", "ca10a60a5fcae51e6948ffe1485d4153d421e6c5"),
    "dsbench": ("LiqiangJing/DSBench", "ba786096137a5108af11c016ad3f09cdb97beefd"),
    "memory": ("ZexueHe/MemoryArena", "6cd9de14b71915e39ac742a20dc33785e14b6aab"),
    "research": ("imlrz/DeepResearch-Bench-II", "087c1b8d4a0ed46fd3dd8615a0b5e93ce3acf6f8"),
}
DATA_PINS = {
    "swe": ("ScaleAI/SWE-bench_Pro", "7ab5114912baf22bb098818e604c02fe7ad2c11f"),
    "dsbench": ("liqiang888/DSBench", "1196d6553ec200e1262841efc89cda5954ffe89f"),
    "memory": ("ZexueHe/memoryarena", "da1a37c8b19280e18627ca01cf368195a5e1d92e"),
    "memory-products": ("ai-hyz/MemoryArena-product-db", "46120a5c931d04a47bd791965d757207b7372b62"),
}
DS_CASES = ["titanic", "bike-sharing-demand", "playground-series-s3e12", "playground-series-s3e5", "nlp-getting-started"]
ZIP_SIZE, ZIP_CD_OFFSET = 3126493713, 3126346810
ZIP_SHA256 = "bed0c7b202389597aadbbc1f8769f459119c1a662c3e11905c4ae05825876087"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def jsonl(data):
    return [json.loads(line) for line in data.splitlines() if line.strip()]


def hf_url(family, relative):
    repo, revision = DATA_PINS[family]
    return f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{relative}"


class Source:
    def __init__(self, cache, family):
        self.cache, self.family = cache, family
        self.repo, self.commit = PINS[family]
        self.archive = tarfile.open(cache / f"{family}.tar.gz", "r:gz")
        self.members = {}
        prefix = self.repo.split("/")[1] + "-" + self.commit + "/"
        for member in self.archive.getmembers():
            if member.isdir() and member.name.rstrip("/") == prefix.rstrip("/"):
                continue
            if not member.name.startswith(prefix):
                raise ValueError("Unexpected archive root")
            relative = member.name[len(prefix):]
            if ".." in Path(relative).parts:
                raise ValueError("Unsafe archive member")
            if member.isfile() and not member.issym() and not member.islnk():
                self.members[relative] = member

    def read(self, relative):
        return self.archive.extractfile(self.members[relative]).read()

    def provenance(self, paths):
        return [{"path": p, "sha256": digest(self.read(p))} for p in dict.fromkeys(paths)]


class DSArchive:
    """Read only selected members from a pinned 3.1 GB ZIP, checking size and CRC."""
    def __init__(self, cache):
        self.cache = cache
        self.members = {}
        data = (cache / "dsbench-zip-directory.bin").read_bytes()
        if len(data) != ZIP_SIZE - ZIP_CD_OFFSET:
            raise ValueError("Wrong central-directory range")
        offset = 0
        while data[offset:offset + 4] == b"PK\x01\x02":
            h = struct.unpack_from("<4s6H3L5H2L", data, offset)
            size_name, size_extra, size_comment = h[10:13]
            name = data[offset + 46:offset + 46 + size_name].decode("utf-8")
            offset += 46 + size_name + size_extra + size_comment
            if ".." in Path(name).parts or name.startswith("/"):
                raise ValueError("Unsafe ZIP member")
            self.members[name] = {"flags": h[3], "method": h[4], "crc": h[7],
                                  "compressed": h[8], "size": h[9], "offset": h[-1]}
        end = struct.unpack_from("<4s4H2LH", data, offset)
        if end[0] != b"PK\x05\x06" or end[4] != len(self.members) or end[5] != offset or end[6] != ZIP_CD_OFFSET:
            raise ValueError("Central directory failed consistency check")

    def selected(self):
        paths = []
        for case in DS_CASES:
            paths.extend([f"data/task/{case}.txt", f"data/answers/{case}/test_answer.csv"])
            paths.extend(p for p in self.members if p.startswith(f"data/data_resplit/{case}/") and p.endswith(".csv"))
        if len(paths) != 25 or any(p not in self.members for p in paths):
            raise ValueError("Each DSBench task must have its instruction, answer and three input files")
        return sorted(paths)

    def chunk(self, name):
        member = self.members[name]
        start = member["offset"]
        end = min(ZIP_SIZE - 1, start + 30 + len(name.encode()) + 65535 + member["compressed"] - 1)
        return self.cache / f"dsbench-range-{start}-{end}.bin", start, end

    def fetch(self, name):
        file, start, end = self.chunk(name)
        if not file.exists():
            subprocess.run(["curl", "-fLsS", "--retry", "2", "--max-time", "60", "--range", f"{start}-{end}",
                            "--max-filesize", str(end - start + 1),
                            hf_url("dsbench", "data_modeling/data.zip") + f"?range={start}-{end}", "-o", str(file)], check=True)
        self.read(name)
        return name

    def read(self, name):
        member = self.members[name]
        file, start, end = self.chunk(name)
        data = file.read_bytes()
        if len(data) != end - start + 1 or data[:4] != b"PK\x03\x04":
            raise ValueError(f"Server did not return the requested local-header range: {name}")
        h = struct.unpack_from("<4s5H3L2H", data)
        if h[2] & 1 or h[3] != member["method"] or member["method"] not in [0, 8]:
            raise ValueError("Unsupported or encrypted ZIP member")
        size_name, size_extra = h[-2:]
        if data[30:30 + size_name].decode("utf-8") != name:
            raise ValueError("ZIP local and central names disagree")
        begin = 30 + size_name + size_extra
        raw = data[begin:begin + member["compressed"]]
        content = zlib.decompress(raw, -15) if member["method"] == 8 else raw
        if len(content) != member["size"] or zlib.crc32(content) & 0xffffffff != member["crc"]:
            raise ValueError(f"ZIP size/CRC mismatch: {name}")
        return content


def install(files, check=False):
    """Preflight the entire batch, then create only missing files with apply_patch."""
    for relative, data in files.items():
        if not relative.startswith("datasets/") or ".." in Path(relative).parts:
            raise ValueError(f"Unsafe output: {relative}")
        target = ROOT / relative
        for parent in [target, *target.parents]:
            if parent == ROOT:
                break
            if parent.is_symlink():
                raise ValueError(f"Refusing symlink: {parent}")
        if target.exists() and target.read_bytes() != data:
            raise ValueError(f"Refusing changed existing file: {relative}")
        if check and not target.is_file():
            raise ValueError(f"Missing file: {relative}")
        data.decode("utf-8")
        if not data.endswith(b"\n"):
            raise ValueError(f"Normalize final newline explicitly: {relative}")
    count = 0
    if not check:
        for relative, data in files.items():
            if (ROOT / relative).exists():
                continue
            patch = "*** Begin Patch\n*** Add File: " + relative + "\n"
            patch += "\n".join("+" + line for line in data.decode().split("\n")[:-1]) + "\n*** End Patch"
            subprocess.run(["apply_patch"], input=patch.encode(), cwd=ROOT, capture_output=True, check=True)
            if (ROOT / relative).read_bytes() != data:
                raise ValueError(f"Installed bytes differ: {relative}")
            count += 1
    return count


def download_plan(cache):
    plan = [{"url": f"https://codeload.github.com/{repo}/tar.gz/{sha}", "destination": str(cache / f"{family}.tar.gz")}
            for family, (repo, sha) in PINS.items()]
    for family, relative, name in [("swe", "data/test-00000-of-00001.parquet", "swe-data.parquet"),
                                   ("dsbench", "data_modeling/data.json", "dsbench-modeling.json"),
                                   ("memory", "bundled_shopping/data.jsonl", "memory-shopping.jsonl")]:
        plan.append({"url": hf_url(family, relative), "destination": str(cache / name)})
    plan.append({"url": hf_url("dsbench", "data_modeling/data.zip") + "?index=full", "range": f"{ZIP_CD_OFFSET}-{ZIP_SIZE - 1}",
                 "destination": str(cache / "dsbench-zip-directory.bin")})
    return plan


COMMON_RUBRIC = (
    "只根据实际产物及评测端独立采集的执行证据评分，不得因口头声称成功、抄写参考答案或伪造轨迹判通过。"
    "kind=llm 是既有题包格式的兼容字段，不代替本题规定的原生评分器。"
    "原始基准结果与 EvalDock 逐标签 0–4 分分别记录，不虚构官方通过阈值或官方榜单成绩。"
    "私有答案、测试补丁和后续会话仅由可信控制器/Judge 读取，不注入 Agent 的公开输入。"
    "缺少规定的运行环境、工具、记忆适配或评分器时返回 UNEVALUABLE，不能把缺环境计为 Agent 失败或成功。"
)


def make_bundle(source, family, slug, instruction, description, labels, paths, task_path,
                answer, primary_output, *, assets=None, private=None, constraints=None,
                metadata=None, extra_sources=None, changes=None, timeout=3600,
                process=None, local=None, rubric=""):
    assets, private = assets or {}, private or {}
    instructions = instruction.rstrip() + (
        "\n\nEvalDock execution boundary: work only inside the evaluator-provisioned, isolated benchmark "
        "workspace and tools. Never operate the user's real accounts or services. Do not access private "
        "answers, gold patches, hidden tests, later-session instructions, or online solutions for this case. "
        "Use actual tool feedback and verify your result. If a required prerequisite is missing, report "
        "UNEVALUABLE and identify it; do not replace execution with a proposed solution or claim success."
    )
    q = {
        "schema": "evaldock.question/v1", "id": f"{family}.{slug}", "version": "1.0.0", "title": slug,
        "matching": {"datasetId": f"dataset.{family}.{slug}/v1", "description": description},
        "source": {
            "repository": f"https://github.com/{source.repo}", "commit": source.commit,
            "taskPath": task_path, "files": source.provenance(paths) + (extra_sources or []),
            "adaptationChanges": [
                "按既有最小 Question Bundle 导入固定版本的完整真实案例；题干公开，答案和评分资源私有。",
                *(changes or []),
                "输出路径映射至 output/；增加 process/local 描述性证据，不把这些描述当作已采集的事实。",
                "仅完成题包导入；Question Bundle 运行入口、环境及原始评分器仍须接通，缺依赖判 UNEVALUABLE。",
            ],
        },
        "capabilityLabels": labels, "task": {"instructions": instructions},
        "environment": {
            "platform": "portable", "timeoutSeconds": timeout,
            "dependencies": ["isolated benchmark workspace", "task-specific pinned runtime", "trusted upstream evaluator"],
            "inputs": [{"source": f"assets/{name}", "destination": f"input/{name}", "sha256": digest(data)} for name, data in assets.items()],
            "setup": {"kind": "none"}, "reset": "fresh-workspace",
            "upstreamConstraints": {"required": True, "missingPrerequisiteResult": "UNEVALUABLE",
                                    "privateResourcesVisibility": "controller-and-judge-only", **(constraints or {})},
        },
        "final": {"checks": [{"id": "final-output", "kind": "llm", "output": primary_output, "reference": "private/final.json"}]},
        "evidence": {
            "process": {"description": "通过真实工具调用及返回结果评价执行过程，不从最终文字倒推工具使用。",
                        "checkpoints": [{"id": f"step-{i + 1}", "description": text} for i, text in enumerate(process or ["读取输入和约束", "执行任务并检查返回结果", "验证最终结果"])]},
            "local": {"description": "文件与环境结果由可信采集器保存，Agent 自述不能替代独立证据。",
                      "checkpoints": [{"id": f"result-{i + 1}", "description": text} for i, text in enumerate(local or [f"验证 {primary_output} 可读取且内容完整", "关联原生评分器结果及真实执行轨迹"])]},
        },
    }
    outputs = {"question.json": encoded(q), "private/final.json": encoded({"answer": answer, "rubric": COMMON_RUBRIC + rubric})}
    outputs.update({f"assets/{name}": data for name, data in assets.items()})
    outputs.update({f"private/{name}": data for name, data in private.items()})
    return {f"datasets/{family}/{slug}/{name}": data for name, data in outputs.items()}


def data_provenance(cache, family, relative, cached_name):
    return {"path": hf_url(family, relative), "sha256": digest((cache / cached_name).read_bytes())}


def decoded_string(text):
    # Some public SWE fields are JSON string literals inside a Parquet string.
    # Decode at most once; never eval code or replace arbitrary escapes.
    if text.startswith('"') and text.endswith('"'):
        try:
            decoded = json.loads(text)
            if isinstance(decoded, str):
                return decoded
        except json.JSONDecodeError:
            pass
    return text


SWE_CASES = {
    "instance_qutebrowser__qutebrowser-0833b5f6f140d04200ec91605f88704dd18e2970-v059c6fdc75567943479b23ebca7c07b5e9a7f34c": "qutebrowser-error-signal",
    "instance_flipt-io__flipt-05d7234fa582df632f70a7cd10194d61bd7043b9": "flipt-snapshot-etag",
    "instance_navidrome__navidrome-0130c6dc13438b48cf0fdfab08a89e357b5517c9": "navidrome-album-image-files",
    "instance_internetarchive__openlibrary-00bec1e7c8f3272c469a58e1377df03f955ed478-v13642507b4fc1f8d234172bf8129942da2c2ca26": "openlibrary-import-validation",
    "instance_element-hq__element-web-18c03daa865d3c5b10e52b669cd50be34c67b2e5-vnan": "element-markdown-links",
}


def literal_list(value):
    parsed = ast.literal_eval(value) if isinstance(value, str) else value
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise ValueError("Expected an upstream string list")
    return parsed


def generate_swe(cache):
    extra_packages = cache / "python-libs"
    if extra_packages.is_dir():
        sys.path.insert(0, str(extra_packages))
    import pyarrow.parquet as parquet
    source = Source(cache, "swe")
    rows = {row["instance_id"]: row for row in parquet.read_table(cache / "swe-data.parquet").to_pylist()}
    result = {}
    for instance, short_name in SWE_CASES.items():
        row = rows[instance]
        assert re.fullmatch(r"[0-9a-f]{40}", row["base_commit"])
        paths = ["LICENSE", "README.md", "swe_bench_pro_eval.py",
                 f"run_scripts/{instance}/run_script.sh", f"run_scripts/{instance}/parser.py",
                 f"dockerfiles/base_dockerfile/{instance}/Dockerfile", f"dockerfiles/instance_dockerfile/{instance}/Dockerfile"]
        private = {
            "gold.patch": row["patch"].encode(), "tests.patch": row["test_patch"].encode(),
            "run_script.sh": source.read(paths[3]), "parser.py": source.read(paths[4]),
            "base.Dockerfile": source.read(paths[5]), "instance.Dockerfile": source.read(paths[6]),
            "environment.json": encoded({"instanceId": instance, "repository": row["repo"], "baseCommit": row["base_commit"],
                                         "beforeRepoSetCmd": row["before_repo_set_cmd"], "executionScope": "disposable benchmark container only; never execute on the host"}),
        }
        answer = {"instanceId": instance, "goldPatch": "private/gold.patch", "testPatch": "private/tests.patch",
                  "failToPass": literal_list(row["fail_to_pass"]), "passToPass": literal_list(row["pass_to_pass"]),
                  "selectedTestFilesToRun": literal_list(row["selected_test_files_to_run"]),
                  "nativeEvaluator": {"repository": f"https://github.com/{source.repo}", "commit": source.commit, "path": "swe_bench_pro_eval.py"},
                  "metric": "resolved: all required fail_to_pass and pass_to_pass tests pass"}
        assert answer["failToPass"] and private["gold.patch"].startswith(b"diff --git") and private["tests.patch"].startswith(b"diff --git")
        instruction = (
            f"Repair the evaluator-provisioned checkout of {row['repo']} at base commit {row['base_commit']}. "
            "Inspect the repository, implement the change, and run relevant tests.\n\n"
            + decoded_string(row["problem_statement"]) + "\n\nRequirements\n" + decoded_string(row["requirements"])
            + "\n\nPublic interface requirements\n" + decoded_string(row["interface"])
            + "\n\nExport the actual changes as a unified diff to output/solution.patch, and write the commands run, "
              "test outcomes and remaining limitations to output/response.txt. Do not merely describe a patch. "
              "Do not modify the trusted evaluator or hidden tests."
        )
        result.update(make_bundle(source, "swe-bench-pro", "swe-bench-pro-" + short_name, instruction,
            "在真实仓库中定位并修复缺陷，以补丁、真实测试执行和原生回归测试结果验证。",
            ["tool-code", "reasoning-planning", "loop", "artifact-delivery"], paths, f"data/test-00000-of-00001.parquet#{instance}",
            answer, "output/solution.patch", private=private,
            extra_sources=[data_provenance(cache, "swe", "data/test-00000-of-00001.parquet", "swe-data.parquet")],
            metadata={"datasetRepository": DATA_PINS["swe"][0], "datasetRevision": DATA_PINS["swe"][1], "split": "test",
                      "instanceId": instance, "repository": row["repo"], "baseCommit": row["base_commit"], "language": row["repo_language"]},
            constraints={"repository": row["repo"], "baseCommit": row["base_commit"], "workspace": "runtime-provisioned checkout",
                         "dockerImage": "jefzda/sweap-images:" + row["dockerhub_tag"], "imageDigestStatus": "resolve and record immutable image digest before evaluation",
                         "controllerInitialization": "private/environment.json", "environmentReset": "new container at the pinned base for every trial",
                         "baseRepositoryBundled": False, "harnessVersionMustMatch": source.commit},
            changes=["仅选择公开 test split；完整保留 requirements/interface、参考补丁、测试补丁及 F2P/P2P 清单。",
                     "对本身是 JSON 字符串字面量的题干/要求只解码一层；不改需求含义。",
                     "Docker 镜像和完整仓库未打包；初始化脚本仅存于 private，绝不在宿主执行。"],
            process=["检查真实仓库、识别依赖与失败原因", "修改代码并根据编译/测试反馈纠正", "检查补丁范围并运行相关回归测试"],
            rubric="补丁不必与 gold.patch 文本相同；由固定版本测试判定行为等价。不得通过修改测试、绕过检查或仅解释修复思路通过。"))
    result["datasets/swe-bench-pro/LICENSE"] = source.read("LICENSE")
    result["datasets/swe-bench-pro/NOTICE.md"] = (
        "# Source and licensing notice\n\nThe included LICENSE is the MIT license of the SWE-bench Pro evaluation harness. "
        "It does not relicense benchmark records or patches derived from their original repositories. "
        "The selected records come from the public ScaleAI/SWE-bench_Pro test split; original repository and base commit are recorded per question. "
        "Review the original repository and data terms before redistribution. The harness currently documents leaderboard issues and historical test revisions; "
        "these are fixed-version local import samples, not independently certified benchmark scores.\n"
    ).encode()
    return result


DS_METRICS = {
    "titanic": ("PassengerId", "Survived", "accuracy", "maximize", "integer class 0 or 1"),
    "bike-sharing-demand": ("datetime", "count", "RMSLE", "minimize", "finite nonnegative numeric rental count"),
    "playground-series-s3e12": ("id", "target", "ROC AUC", "maximize", "finite probability between 0 and 1"),
    "playground-series-s3e5": ("Id", "quality", "quadratic weighted kappa, N=10", "maximize", "integer quality class in the training label range"),
    "nlp-getting-started": ("id", "target", "binary F1", "maximize", "integer class 0 or 1"),
}


def csv_rows(data):
    reader = csv.DictReader(io.StringIO(data.decode("utf-8")))
    rows = list(reader)
    assert reader.fieldnames and rows and all(None not in row for row in rows)
    return reader.fieldnames, rows


def generate_dsbench(cache):
    source, archive = Source(cache, "dsbench"), DSArchive(cache)
    listed = {r["name"]: r for r in jsonl((cache / "dsbench-modeling.json").read_bytes())}
    result = {}
    for case in DS_CASES:
        id_column, target, metric, direction, prediction_type = DS_METRICS[case]
        task_path = f"data/task/{case}.txt"
        train_path, test_path = [f"data/data_resplit/{case}/{name}.csv" for name in ["train", "test"]]
        answer_path = f"data/answers/{case}/test_answer.csv"
        train, test, gold = [archive.read(p) for p in [train_path, test_path, answer_path]]
        train_columns, train_rows = csv_rows(train)
        test_columns, test_rows = csv_rows(test)
        answer_columns, answer_rows = csv_rows(gold)
        assert target in train_columns and target not in test_columns and answer_columns == [id_column, target]
        assert [r[id_column] for r in test_rows] == [r[id_column] for r in answer_rows]
        assert len({r[id_column] for r in train_rows}) == len(train_rows)
        assert len({r[id_column] for r in test_rows}) == len(test_rows)
        assert not {r[id_column] for r in train_rows} & {r[id_column] for r in test_rows}
        sample_path = next(p for p in archive.selected() if p.startswith(f"data/data_resplit/{case}/") and p not in [train_path, test_path])
        sample_columns, sample_rows = csv_rows(archive.read(sample_path))
        assert sample_columns == answer_columns
        evaluator_path = f"data_modeling/evaluation/{case}_eval.py"
        instruction = (
            "This is the official DSBench data-modeling resplit, not the original Kaggle test split. "
            "Use only input/train.csv and input/test.csv for modeling. Do not join a competition, post messages, "
            "download original competition labels, or submit to an external leaderboard.\n\nOriginal task description:\n"
            + archive.read(task_path).decode()
            + f"\n\nDSBench local split and delivery contract (takes precedence over original competition sample sizes/paths): "
              f"train rows={len(train_rows)}; test rows={len(test_rows)}. The target is {target}. "
              f"Fit a model using training data; output {prediction_type}. Score: {metric} ({direction}). "
              f"Write output/submission.csv with exactly {len(test_rows)} rows and columns {id_column},{target}, "
              f"preserving every {id_column} and the exact row order of input/test.csv. "
              "The old competition sample submission is intentionally omitted because its IDs and size do not match this resplit. "
              "Deliver executable training/inference code as output/train.py and a brief validation/method summary as output/response.txt. "
              "Use a fixed random seed, check missing values and data leakage, and do not tune on hidden test answers."
        )
        native = source.read(evaluator_path)
        answer = {"competition": case, "metric": metric, "direction": direction, "idColumn": id_column,
                  "targetColumn": target, "testRowCount": len(test_rows), "answerFile": "private/test_answer.csv",
                  "nativeEvaluator": "private/evaluate.py", "officialPassThreshold": None,
                  "rowAlignment": "same IDs and same order as input/test.csv; validate before invoking upstream scorer"}
        result.update(make_bundle(source, "dsbench", "dsbench-" + case, instruction,
            "读取真实数据、完成预处理和建模，交付可重跑代码及测试集预测 CSV，以原生指标评分。",
            ["tool-data", "tool-code", "artifact-delivery"], ["LICENSE", "README.md", "data_modeling/data.json", evaluator_path],
            f"data_modeling/data.zip#{task_path}", answer, "output/submission.csv",
            assets={"train.csv": train, "test.csv": test}, private={"test_answer.csv": gold, "evaluate.py": native},
            extra_sources=[data_provenance(cache, "dsbench", "data_modeling/data.json", "dsbench-modeling.json"),
                           *[{"path": hf_url("dsbench", "data_modeling/data.zip") + "#" + p, "sha256": digest(archive.read(p))}
                             for p in [task_path, train_path, test_path, answer_path, sample_path]]],
            metadata={"datasetRepository": DATA_PINS["dsbench"][0], "datasetRevision": DATA_PINS["dsbench"][1],
                      "split": "official-data-modeling-resplit", "competition": case, "competitionUrl": listed[case]["url"],
                      "trainRows": len(train_rows), "testRows": len(test_rows), "omittedOriginalSampleRows": len(sample_rows),
                      "licenseRestriction": "educational/research and non-commercial; original competition terms also apply",
                      "archiveReportedSha256": ZIP_SHA256, "archiveVerification": "selected member CRC32, uncompressed sizes and SHA256 verified; full archive not downloaded"},
            constraints={"pythonPackages": ["numpy", "pandas", "scikit-learn"], "inputDataBundled": True,
                         "networkPolicy": "no original labels, solutions, competitions or external submissions",
                         "privateAnswerFile": "private/test_answer.csv", "nativeEvaluator": "private/evaluate.py",
                         "environmentReset": "fresh model/data workspace and fixed random seed per trial"},
            changes=["保留官方重新划分的 train/test 与隐藏答案，不裁剪行、不重新切分、不改标签。",
                     "上游示例提交对应原 Kaggle 测试集，与 DSBench resplit 行数/ID 不同，故不作为输入；明确本地输出列与行序。",
                     "评分器按原文件保存，先校验 ID 与行序再执行，避免上游部分 sort_values 未赋值造成错位；不改原生指标。"],
            process=["检查字段、缺失值、类型和训练/测试差异", "实际训练并用训练集内部验证，避免目标泄漏", "运行推断并核验预测 CSV 的 ID、行序、类型和完整性"],
            local=["验证 output/train.py 能重跑生成 output/submission.csv", "独立核验预测文件与 input/test.csv 一一对应", "使用私有答案和原生评分脚本记录连续指标，不要求预测等于全部真值"],
            rubric="先拒绝缺行、重复 ID、错序、非法预测和非有限值，再运行原生指标。不得用自然语言答案代替预测文件，也不得任意把原始连续指标解释为官方通过/失败。"))
    result["datasets/dsbench/LICENSE"] = source.read("LICENSE")
    result["datasets/dsbench/NOTICE.md"] = (
        "# DSBench data use and attribution\n\nSource: Liqiang Jing and DSBench contributors; "
        "https://github.com/LiqiangJing/DSBench and https://huggingface.co/datasets/liqiang888/DSBench. "
        "The included code LICENSE does not override the upstream README's data restriction: "
        "educational/research, non-commercial use only; commercial use requires the providers' written permission. "
        "Respect each original Kaggle competition's terms as well.\n\n"
        "These are complete official DSBench resplit cases, not original Kaggle test sets. "
        "Only the mismatched original sample submissions were omitted. No training/test rows or labels were changed. "
        "Original task text is embedded in question.json; test labels and native evaluators remain private.\n"
    ).encode()
    return result


def generate_memory(cache):
    source = Source(cache, "memory")
    rows = {r["id"]: r for r in jsonl((cache / "memory-shopping.jsonl").read_bytes())}
    result = {}
    paths = ["README.md", "setup_web_shopping.md", "run_shopping.py",
             "env/env_systems/web_shopping_env/runtime/runner/task_files.py",
             "env/env_systems/web_shopping_env/compute_reward.py",
             "env/env_systems/web_shopping_env/runtime/reward_helpers.py"]
    for number in [60, 66, 72, 78, 84]:
        row = rows[number]
        assert row["category"].startswith("electronics_item_") and len(row["questions"]) == len(row["answers"]) == 6
        scenario = {"taskId": row["category"], "hfId": number, "questions": row["questions"]}
        answer = {"taskId": row["category"], "answers": row["answers"], "stepCount": 6,
                  "nativeTaskReconstruction": "env/env_systems/web_shopping_env/runtime/runner/task_files.py:_reconstruct_task_def_from_hf_row",
                  "nativeEvaluator": "env/env_systems/web_shopping_env/compute_reward.py",
                  "scoring": "per-step native reward and whole-chain success; exact ASIN gives full reward, nonexact matching follows pinned native evaluator",
                  "scoringLimitations": "native HF reconstruction leaves structured total-budget/price constraints empty; task text still contains them; do not claim native reward fully verifies every textual constraint"}
        instruction = row["questions"][0] + (
            "\n\nThis is stage 1 of one six-stage MemoryArena shopping case in a simulated store, not a real purchase. "
            "Perform only the currently released stage using the store's search/click tools. The trusted controller "
            "will release later stages sequentially using the pinned split-step protocol. Preserve allowed memory "
            "across stages; do not request future-stage questions or private target products. "
            "After all six stages, write an honest completion summary to output/response.txt. "
            "Listing product IDs in the summary is not a substitute for executing purchases in the benchmark environment."
        )
        result.update(make_bundle(source, "memoryarena", f"memoryarena-electronics-{number:03d}", instruction,
            "在模拟商城中跨六个依赖阶段完成兼容配套商品选择，评记忆保持、历史利用、工具反馈和约束规划。",
            ["memory", "loop", "reasoning-planning", "tool-web"], paths, f"bundled_shopping/data.jsonl#id={number}", answer,
            "output/response.txt", private={"scenario.json": encoded(scenario)},
            extra_sources=[data_provenance(cache, "memory", "bundled_shopping/data.jsonl", "memory-shopping.jsonl")],
            metadata={"datasetRepository": DATA_PINS["memory"][0], "datasetRevision": DATA_PINS["memory"][1],
                      "config": "bundled_shopping", "split": "test", "hfId": number, "category": row["category"],
                      "stageCount": 6, "releaseStatus": "preview", "licenseStatus": "no dataset/root license declaration found in the selected revisions; redistribution requires clarification"},
            constraints={"controllerScenario": "private/scenario.json", "stagesPerCase": 6, "splitSteps": True,
                         "stageRelease": "one at a time; use original reconstruction, feedback and memory lifecycle from the pinned runner",
                         "memoryReset": "clear between cases/trials; preserve allowed memory within the six stages",
                         "historyProtocol": "record whether original correct-product feedback/history is enabled; do not silently replace it with agent-only history",
                         "memoryEvidence": "capture MEMORY_PROBE across stage boundaries; native reward alone does not score the memory label",
                         "runtimeRepository": f"https://github.com/{source.repo}", "runtimeCommit": source.commit,
                         "productDatabase": {"repository": DATA_PINS["memory-products"][0], "revision": DATA_PINS["memory-products"][1],
                                             "requiredPaths": ["items_shuffle.json", "items_ins_v2.json", "domain_data.json", "product_catalog/", "search_engine/indexes-full/"], "bundled": False},
                         "judgeMode": "pin native LLM attribute judge model/settings; --no-llm is a different evaluation mode",
                         "environmentReset": "restore simulated store per native stage; never perform real purchases"},
            changes=["只取 bundled_shopping 的电子设备配套子集，5 条完整任务链，每链 6 阶段；不将 30 阶段冒充 30 题。",
                     "当前题面仅公开第一阶段；完整阶段脚本与参考商品私有，控制器按原生协议逐步释放。",
                     "商品库、搜索索引和完整环境仍由固定版本运行器部署，不缩小候选商品池以制造简化题。",
                     "保留原生 correct-product feedback/history 协议；记忆实验须注明配置，不能混报为无提示历史记忆能力。",
                     "上游 HF 重建器未结构化恢复总预算/价格限制，故明确原生 reward 的覆盖边界；不伪称它是全约束确定性评分。"],
            process=["第一阶段检索并比较商品，执行模拟购买而非口头选项", "阶段切换时按原生协议保存/恢复记忆和反馈，禁止提前读取后续题目", "后续行动实际使用前序商品信息与兼容/预算约束", "观察每次工具结果并验证整条任务链完成情况"],
            rubric="必须核对可信控制器采集的六阶段真实交互。分别记录原生 reward 与约束检查结果，不从最终商品编号列表推断记忆能力。缺 MEMORY_PROBE 时 memory 标签不可评。"))
    result["datasets/memoryarena/NOTICE.md"] = (
        "# MemoryArena source and limitations\n\nSource: Zexue He et al., MemoryArena; "
        "https://github.com/ZexueHe/MemoryArena and https://huggingface.co/datasets/ZexueHe/memoryarena. "
        "The selected code revision describes itself as preview. No root project license or dataset license "
        "declaration was found in these selected revisions; public availability is not a redistribution license. "
        "These local evaluation samples do not grant rights to redistribute the upstream code/data.\n\n"
        "Five electronics bundled-shopping chains are retained in full (six stages each). "
        "Do not flatten later stages into the first prompt, reset memory between dependent stages, "
        "or replace store interaction with product-ID question answering. Use the pinned product database and full candidate pool. "
        "The original runner may provide correct-product history; report this configuration. Native HF reconstruction "
        "does not restore structured budget/price constraints, and nonexact attribute scoring can use an LLM judge. "
        "Keep native reward, additional constraint checks and EvalDock memory/loop scores distinct.\n"
    ).encode()
    return result


RESEARCH_CASES = {35: "quadrotor-control-zh", 38: "greenhouse-control-en", 45: "kubernetes-scheduling-zh",
                  46: "cloud-autoscaling-en", 74: "open-research-data-en"}


def generate_research(cache):
    source = Source(cache, "research")
    rows = {row["idx"]: row for row in jsonl(source.read("tasks_and_rubrics.jsonl"))}
    result = {}
    for idx, short_name in RESEARCH_CASES.items():
        row = rows[idx]
        assert row["license"] == "CC BY 4.0" and row["prompt"].startswith(row["content"]["task"])
        rubric = row["content"]["rubric"]
        assert set(rubric) == {"info_recall", "analysis", "presentation"} and all(rubric.values())
        instruction = row["prompt"] + (
            "\n\nDelivery: carry out the research using accessible, permitted sources; preserve the task's "
            "original time scope and blocked-article restrictions. Write the complete report in the requested "
            "language to output/report.md, with source citations that support its factual claims. "
            "Use the requested tables and sections. Verify the report and citations before finishing. "
            "Do not consult the benchmark rubrics, reference report, or other models' answers."
        )
        answer = {"taskId": row["id"], "taskIndex": idx, "rubric": rubric, "blocked": row["content"]["blocked"],
                  "nativeEvaluator": {"repository": f"https://github.com/{source.repo}", "commit": source.commit,
                                      "path": "run_evaluation.py", "entryPoint": "process_one_with_chunking", "defaultModel": "gpt-5.5"},
                  "scoreSemantics": {"1": "rubric satisfied by allowed-source evidence", "0": "rubric not mentioned", "-1": "support relies on a blocked reference"},
                  "officialPassThreshold": None}
        result.update(make_bundle(source, "deepresearch-bench-ii", f"deepresearch-bench-ii-{idx:03d}-{short_name}", instruction,
            "从允许来源检索并交叉核验信息，综合分析后交付带引文的研究报告，以专家报告派生的完整细粒度标准评分。",
            ["retrieval-grounding", "tool-web", "tool-document", "artifact-delivery"],
            ["tasks_and_rubrics.jsonl", "run_evaluation.py", "gpt_client.py", "aggregate_scores.py", "LICENSE", "DATA_LICENSE"],
            f"tasks_and_rubrics.jsonl#idx={idx}", answer, "output/report.md",
            metadata={"taskId": row["id"], "taskIndex": idx, "language": row["language"], "theme": row["theme"],
                      "description": row["description"], "license": row["license"],
                      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
                      "attribution": "Ruizhe Li and DeepResearch Bench II contributors; source article authors/title/URLs preserved in the original blocked-article notice",
                      "rubricCounts": {key: len(value) for key, value in rubric.items()}},
            constraints={"reportFormat": "Markdown", "requiredResearchTools": ["web search", "page/document access"],
                         "blockedReferences": row["content"]["blocked"], "networkPolicy": "only permitted sources; no reference report or benchmark answers",
                         "nativeEvaluatorModel": "gpt-5.5", "nativeEvaluatorCommit": source.commit,
                         "judgeApiRequired": True, "judgeSettingsMustBeRecorded": ["model snapshot", "temperature", "chunk_size", "max_paper_chars", "max_retries"],
                         "environmentReset": "new research workspace and empty agent history per trial",
                         "scoreScope": "native rubric scores assess report quality, not the complete browsing trajectory"},
            changes=["选取 2 道中文、3 道英文报告任务，保留每题全部三维 rubric，不抽减评分点。",
                     "完整保留原始 prompt、时间范围及禁用参考文章规则；不把参考文章作为公开附件。",
                     "采用固定提交的现行报告评分器，明确默认 Judge 和 API 依赖，不冒称与早期论文 Judge 同版本。",
                     "全部所选题为 CC BY 4.0，逐题保留作者/来源归属和许可证链接。"],
            process=["检索允许来源并记录页面、文档与证据位置", "交叉核对事实、数据及时间范围，遵守禁用参考文章规则", "整合证据并生成有引文、结构完整的 Markdown 报告"],
            local=["验证 output/report.md 的结构、表格、引文和文件可读性", "由固定评分器逐条检查全部 rubric，保留报告中的证据片段", "浏览及检索标签另用真实轨迹评分，不从报告质量反推过程"],
            rubric="不得删减 rubric 或用笼统整体印象替代逐项评分；保留三维结果及禁用来源扣分。报告正确不自动证明执行了检索工具。"))
    result["datasets/deepresearch-bench-ii/LICENSE"] = source.read("LICENSE")
    result["datasets/deepresearch-bench-ii/DATA_LICENSE"] = source.read("DATA_LICENSE")
    return result


def generate(cache):
    result = {}
    for generator in [generate_swe, generate_dsbench, generate_memory, generate_research]:
        additions = generator(cache)
        assert sum(p.endswith("/question.json") for p in additions) == 5
        assert not result.keys() & additions.keys()
        result.update(additions)
    normalized = set()
    for p, data in list(result.items()):
        if b"\r\n" in data:
            data = data.replace(b"\r\n", b"\n")
        if not data.endswith(b"\n"):
            data += b"\n"
        if data != result[p]:
            normalized.add(p)
            result[p] = data
    for p in list(result):
        if not p.endswith("/question.json"):
            continue
        q, prefix = json.loads(result[p]), p.removesuffix("question.json")
        adjusted = sorted(name.removeprefix(prefix) for name in normalized if name.startswith(prefix))
        if adjusted:
            q["source"]["adaptationChanges"].append("仅规范文本换行/终止换行，源 SHA256 仍对应原始字节，输入 SHA256 对应落盘字节：" + ", ".join(adjusted))
        for item in q["environment"]["inputs"]:
            item["sha256"] = digest(result[prefix + item["source"]])
        result[p] = encoded(q)
    return result


def catalog_description(name, focus, inputs, scoring, agents, sections):
    """Match the overview plus eight-section description used by recent entries."""
    headings = ["基本定位", "评测层级设计", "输入和环境", "输出与评分", "适配能力", "不适配情况", "匹配关键词", "当前局限"]
    assert len(sections) == len(headings) and all(sections)
    overview = (f"数据集: {name}\n最突出的测试对象: {focus}\n当前输入形态: {inputs}\n"
                f"输出与评分: {scoring}\n最适合的 Agent: {agents}\n"
                "数据可用状态: AVAILABLE；本地已保存 5 道题包，运行环境和原生评分器仍待适配")
    return overview + "".join(f"\n\n{i + 1}. {title}\n{body}" for i, (title, body) in enumerate(zip(headings, sections)))


CATALOG = {
    "swe-bench-pro": ("SWE-bench Pro", catalog_description(
        "SWE-bench Pro", "真实代码仓库修复、测试驱动迭代与补丁交付",
        "5 个公开 test split 题包，含原题、requirements/interface、私有参考补丁及测试资源",
        "代码补丁与真实执行记录；使用原生 F2P/P2P 回归测试判定修复是否成功",
        "代码 Agent、仓库维护 Agent、终端开发 Agent", [
            "在真实仓库中理解需求、定位缺陷、修改代码并验证行为；选取 qutebrowser、Flipt、Navidrome、OpenLibrary、Element 各一题，不以解释修复思路代替代码变更。",
            "第一层检查补丁能否应用及目标行为；第二层检查代码检索、编辑、测试和纠错轨迹；第三层由固定版本原生测试判定 resolved。任务结果与 EvalDock 逐标签分数分别记录。",
            "数据 revision 7ab5114912ba，评分代码 ca10a60a5fca。题包保留基准提交、初始化配置、Dockerfile、测试脚本与解析器；完整仓库及镜像仍须部署，并锁定镜像摘要。每题使用独立容器，初始化不得在宿主执行。",
            "交付 output/solution.patch 与 output/response.txt。可信评分端应用私有测试补丁，核验全部 fail_to_pass 和 pass_to_pass；不要求补丁与参考实现文字相同，不允许篡改测试。",
            "适配 tool-code、reasoning-planning、loop 和 artifact-delivery；代码执行及测试反馈可直接支持过程标签判分。",
            "不适合只有文本输出、不能编辑仓库或运行测试的模型；不适合没有隔离环境的真实生产仓库操作。",
            "SWE-bench Pro, repository repair, regression tests, coding agent, tool-code, loop, patch",
            "仅为 5 题导入样本，题量有限，不构成完整榜单成绩；上游曾修订测试并提示榜单问题。所附 MIT 许可证仅对应评测框架，原仓库补丁及数据条款仍须核实。未运行 Agent 或官方评测；缺环境或评分器判 UNEVALUABLE。",
        ])),
    "dsbench": ("DSBench", catalog_description(
        "DSBench", "真实数据预处理、建模实验、测试集推断与可重跑产物交付",
        "5 个 Data Modeling 完整官方 resplit，公开 train/test CSV，测试答案和评分器私有",
        "预测 CSV、训练推断代码和验证摘要；按任务使用 accuracy、RMSLE、ROC AUC、quadratic weighted kappa 或 F1",
        "数据科学 Agent、机器学习建模 Agent、代码执行 Agent", [
            "选择 Titanic、Bike Sharing Demand、Playground S3E12、Playground S3E5、NLP Getting Started 的真实建模任务；要求读取文件、训练模型并生成预测，不纳入纯分析问答。",
            "第一层核验提交文件与数据 ID；第二层观察数据检查、训练、内部验证和推断过程；第三层使用隐藏答案运行原生指标。连续指标与 EvalDock 标签分分别记录，不自行设定官方通过阈值。",
            "数据 revision 1196d6553ec2，代码 ba786096137a。全部训练、测试行及隐藏标签均已保存，未裁剪或重新切分；需隔离 Python 环境及 numpy、pandas、scikit-learn。原 Kaggle 示例提交与本地 resplit 不匹配，故不作为输入。",
            "交付 output/submission.csv、output/train.py 和 output/response.txt。先核验预测列、ID、行数、行序及有限值，再用 private/evaluate.py 评分；要求保持 test.csv 行序以规避上游部分排序调用未赋值的问题，不修改原生指标。",
            "适配 tool-data、tool-code 和 artifact-delivery；重点检查真实训练执行、数据处理质量及可复跑性。",
            "不适合仅凭题面给出建模建议的文本模型；不得访问外部竞赛标签、参考解或提交真实竞赛。未获授权的商业数据使用不在许可范围内。",
            "DSBench, data modeling, tabular prediction, NLP classification, machine learning, tool-data, tool-code",
            "仅覆盖 5 个建模任务，不代表完整 DSBench；数据限教育研究和非商业用途，商业用途须授权并遵循原竞赛条款。原生连续指标不直接等于 Agent 整体能力。题包已校验但尚未执行建模或接通评分入口；缺依赖判 UNEVALUABLE。",
        ])),
    "memoryarena": ("MemoryArena", catalog_description(
        "MemoryArena", "跨阶段记忆保持、前序信息利用与依赖约束下的多步工具行动",
        "5 条电子设备 bundled_shopping 完整任务链，每链 6 阶段；仅公开当前阶段，后续阶段及答案私有",
        "模拟商城交互轨迹、阶段结果及完成摘要；原生 reward 与记忆/约束检查分别记录",
        "带持久记忆的 Agent、多会话执行 Agent、模拟网页操作 Agent", [
            "在模拟商城中逐阶段选择兼容配套商品，后续行动依赖前序商品信息；5 条完整链合计 30 阶段，但 catalog 仅计 5 题，不将阶段拆成互不依赖的问答。",
            "第一层核验六阶段任务结果；第二层观察真实搜索、点击、反馈与纠错；第三层用跨阶段 MEMORY_PROBE 检查记忆保存及利用。不能从最终商品编号或原生 reward 倒推记忆能力。",
            "任务数据 revision da1a37c8b192，运行代码 6cd9de14b719，商品库 revision 46120a5c931d。完整商品库和搜索索引仍须部署，不缩小候选池。控制器按原生 split-step 协议逐阶段释放任务；跨题清空记忆，题内保留允许的记忆。",
            "保存各阶段真实模拟交互并交付 output/response.txt；使用原生商品/属性 reward，同时单独记录附加约束检查。固定 LLM 属性 Judge 配置；不得将无 Judge 模式与标准模式混报，缺 MEMORY_PROBE 时 memory 标签不可评。",
            "适配 memory、loop、reasoning-planning 和 tool-web；要求后续行动实际使用前序信息，并有独立轨迹支持标签评分。",
            "不适合一次性公开全部阶段的纯问答，也不适合每阶段清空全部记忆的实验配置；不得连接真实购物账户或发生真实购买。",
            "MemoryArena, bundled shopping, cross-session memory, dependent tasks, memory, loop, tool-web",
            "仅覆盖电子设备子集；代码为 Preview，未发现所选版本的根项目或数据许可证声明，公开再分发须核实。原生历史可能提供正确商品反馈，必须报告此配置；HF 重建器未结构化恢复预算/价格限制，原生 reward 不完整验证题面全部约束。尚未运行原生环境，缺环境或评分器判 UNEVALUABLE。",
        ])),
    "deepresearch-bench-ii": ("DeepResearch Bench II", catalog_description(
        "DeepResearch Bench II", "多来源检索、事实核验、证据综合与带引文研究报告交付",
        "5 个完整研究报告任务，中文 2 题、英文 3 题；全部 443 条三维评分项私有保存",
        "Markdown 研究报告与检索轨迹；原生 Judge 逐项评信息召回、分析及表达，并检查禁用来源",
        "深度研究 Agent、文档检索 Agent、报告生成 Agent", [
            "从固定提交 087c1b8d4a0e 选取无人机控制、温室控制、Kubernetes 调度、云扩缩容、开放科研数据任务。要求实际检索允许来源并综合报告，不以闭卷知识问答替代研究执行。",
            "第一层检查报告与引用完整性；第二层用真实轨迹观察检索、证据定位和交叉核验；第三层按专家报告派生的三维 rubric 逐条评分。报告质量分不等于浏览或工具过程分。",
            "完整保留原始 prompt、语言、时间范围及禁用参考文章规则，参考文章不作为公开附件。需网页搜索及页面/文档访问工具，每题使用空白研究工作区与独立历史；只允许检索未被禁止的来源。",
            "交付 output/report.md，保留全部 443 条评分项，不用笼统整体印象替代。沿用固定版本原生评分器，当前默认 Judge 为 gpt-5.5；运行前须固定模型和参数，记录满足、未提及及禁用来源扣分，不捏造官方通过阈值。",
            "适配 retrieval-grounding、tool-web、tool-document 和 artifact-delivery；检索与工具标签须有真实过程证据，不能只凭文笔推断。",
            "不适合没有搜索/文档工具的闭卷模型，也不适合允许直接读取参考报告或私有 rubric 的配置。不能当作完全确定性、无需 Judge API 的自动测试。",
            "DeepResearch Bench II, deep research, evidence synthesis, citation, report, retrieval-grounding, tool-document",
            "仅为 5 题导入样本，不代表完整榜单；全部所选题标注 CC BY 4.0，已保留来源归属和许可。尚未运行研究 Agent 或调用 Judge；评分有模型与分块设置依赖，网络来源也可能变化。缺研究环境或原生评分器判 UNEVALUABLE。",
        ])),
}


def update_catalog(files, check=False):
    target = ROOT / "datasets/catalog.md"
    old = target.read_text()
    match = re.search(r"```json evaldock-dataset-catalog\s*\n([\s\S]*?)\n```", old)
    if not match:
        raise ValueError("Catalog fence not found")
    catalog = json.loads(match.group(1))
    original = json.loads(match.group(1))["datasets"]
    targets = {f"dataset.{family}/v1" for family in CATALOG}
    for family, (name, description) in CATALOG.items():
        questions = [json.loads(data) for p, data in files.items() if p.startswith(f"datasets/{family}/") and p.endswith("/question.json")]
        entry = {"datasetId": f"dataset.{family}/v1", "name": name,
                 "description": description,
                 "labelIds": sorted({f"label.{label}/v1" for q in questions for label in q["capabilityLabels"]}),
                 "availableCaseCount": len(questions)}
        assert entry["availableCaseCount"] == 5
        prior = next((i for i, r in enumerate(catalog["datasets"]) if r["datasetId"] == entry["datasetId"]), None)
        if prior is None:
            catalog["datasets"].append(entry)
        else:
            catalog["datasets"][prior] = entry
    assert [r for r in original if r["datasetId"] not in targets] == [r for r in catalog["datasets"] if r["datasetId"] not in targets]
    new = old[:match.start(1)] + json.dumps(catalog, ensure_ascii=False, indent=2) + old[match.end(1):]
    if check:
        if old != new:
            raise ValueError("Catalog differs from the four imported groups")
    elif old != new:
        patch = "*** Begin Patch\n*** Update File: datasets/catalog.md\n@@\n"
        patch += "\n".join("-" + line for line in old.rstrip("\n").split("\n")) + "\n"
        patch += "\n".join("+" + line for line in new.rstrip("\n").split("\n")) + "\n*** End Patch"
        subprocess.run(["apply_patch"], input=patch.encode(), cwd=ROOT, capture_output=True, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--print-downloads", action="store_true")
    parser.add_argument("--fetch-dsbench", action="store_true")
    parser.add_argument("--inspect", nargs=2, metavar=("FAMILY", "PATH"))
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--catalog", action="store_true")
    args = parser.parse_args()
    if args.write and args.check:
        parser.error("--write and --check are mutually exclusive")
    if args.print_downloads:
        print(json.dumps(download_plan(args.cache), indent=2))
    elif args.fetch_dsbench:
        archive = DSArchive(args.cache)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for name in pool.map(archive.fetch, archive.selected()):
                print("verified", name, flush=True)
    elif args.inspect:
        family, relative = args.inspect
        source = DSArchive(args.cache) if family == "dszip" else Source(args.cache, family)
        print(source.read(relative).decode())
    else:
        files = generate(args.cache)
        summary = {"cases": sum(p.endswith("/question.json") for p in files), "files": len(files), "bytes": sum(map(len, files.values()))}
        if args.write or args.check:
            summary["writtenFiles"] = install(files, check=args.check)
            if args.catalog:
                update_catalog(files, check=args.check)
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
