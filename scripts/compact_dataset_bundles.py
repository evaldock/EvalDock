#!/usr/bin/env python3
"""Keep question bundles minimal without dropping inputs or grading fixtures.

Importers use compact_bundle before publishing. The CLI is a backed-up migration
for existing bundles; attention-pytorch and the five reference families are not
rewritten. No upstream code is executed.
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import io
import json
import tarfile
import tempfile
from pathlib import Path


ORIGINAL_HARBOR = {
    "algotune-optimize-matrix-sqrt", "bix-diff-expr-mirna",
    "featurebench-add-feature-xarray-backend-chunks", "gaia2-adapt-hard-1",
    "gaia2-ambiguous", "replicationbench-find-galactic-vz-peaks",
    "skillsbench-ocr-receipts-to-excel", "usaco-assign-cows-to-barns",
    "widesearch-list-bri-projects-2025",
}
ROOT_REDUNDANCIES = {
    "agentbench-db": {"README.md", "manifest.json"},
    "spreadsheetbench": {"README.md"},
}
SPREADSHEET_LICENSE = (
    "SpreadsheetBench — Ma et al.\n"
    "Source: https://github.com/RUCKBReasoning/SpreadsheetBench/tree/49b73a94775fb489063f60ca1865e3a650079a79\n"
    "Original data and this adaptation: CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/\n"
    "Changes: EvalDock question metadata, local path mapping and extracted grading references. "
    "Original instructions and input/reference workbook bytes are unchanged.\n"
)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def compact_bundle(original: dict[str, bytes], harbor_task: Path | None = None) -> dict[str, bytes]:
    """Pure transformation: unknown files are preserved, explicit duplicates removed."""
    files = dict(original)
    question = json.loads(files["question.json"])
    final = json.loads(files["private/final.json"])
    before = copy.deepcopy((question, final))
    title, source = question["title"], question["source"]

    def discard(*names):
        for name in names:
            files.pop(name, None)

    def ensure_source(relative, destination):
        if destination in files:
            content = files[destination]
        else:
            if harbor_task is None:
                raise ValueError(f"{title}: supply pinned Harbor source for {relative}")
            content = (harbor_task / relative).read_bytes()
        record = {"path": f"tasks/{title}/{relative}", "sha256": hashlib.sha256(content).hexdigest()}
        old = next((item for item in source["files"] if item["path"] == record["path"]), None)
        if old is not None and old != record:
            raise ValueError(f"{title}: source hash mismatch for {relative}")
        if old is None:
            source["files"].append(record)
        files[destination] = content

    if title.startswith("agentbench-db-"):
        line = int(title.rsplit("-", 1)[1])
        source["taskPath"] = f"data/dbbench/standard.jsonl#line={line}"
        source["adaptationChanges"] = [
            "保留所选 SELECT 题的原题干、完整表格及官方答案；来源行号见 taskPath。导入时执行原始 SQL 并核对官方 label。",
            "MySQL/Docker 改为只读内存 SQLite；全列 TEXT、NOCASE，数值需显式 CAST，不保证所有 MySQL 语义等价。",
            "表格、工具、使用说明和许可证映射到 input/；答案仅保留于 private/final.json。",
            "交付答案、实际 SQL 与查询结果；使用本地时间预算和 LLM 语义评分，不复现上游轮数、截断协议或官方总分。",
        ]
        if "private/source-record.json" in files:
            record = json.loads(files["private/source-record.json"])
            if json.loads(final["answer"]) != record["label"] or json.loads(files["assets/table.json"]) != record["table"]:
                raise ValueError(f"{title}: duplicate source record disagrees with retained data")
        discard("private/source-record.json", "private/reference.sql")

    if title.startswith("spreadsheetbench-") and "private/expected.json" in files:
        expected = json.loads(files["private/expected.json"])
        embedded = json.loads(final["answer"][final["answer"].index("{\n"):])
        if embedded != expected or hashlib.sha256(files["private/reference.xlsx"]).hexdigest() != expected["referenceSha256"]:
            raise ValueError(f"{title}: duplicate expected results disagree")
        final["answer"] = expected
        final["rubric"] = final["rubric"].replace("answer 文本所列", "answer.regions 所列").replace("；相同结构化结果保存在 private/expected.json", "")
        source["adaptationChanges"] = [
            "从固定 Verified 400 快照显式选取 12 题，每题一个原始 init/golden 工作簿对；原题干与工作簿字节不变。",
            "原始输入映射为 input/workbook.xlsx，交付 output/result.xlsx；参考工作簿与全部目标区域仅保留于 private/。",
            "来源作者 Ma et al.；原数据及本适配遵循 CC BY-SA 4.0：https://creativecommons.org/licenses/by-sa/4.0/。",
            "采用 LLM 语义判断及过程/交付证据；需接通 Question Bundle、XLSX 读取与必要的公式重算，不等同官方成绩。",
        ]
        discard("private/expected.json", "private/source-metadata.json")

    if title in ORIGINAL_HARBOR:
        source["files"] = [item for item in source["files"] if not item["path"].endswith(("/README.md", "/native_judge.py"))]
        metadata = source.get("upstreamMetadata", {})
        metadata.pop("source_dataset", None)
        if title.startswith("algotune-") or title.startswith("skillsbench-"):
            source.pop("upstreamMetadata", None)
        environment = question["environment"]
        constraints = environment.pop("upstreamConstraints", None)
        if title.startswith("algotune-") and constraints:
            environment["upstreamConstraints"] = {
                "agent": {key: constraints["agent"][key] for key in ["cpus", "memory_mb"]},
                "verifier": {"timeout_sec": constraints["verifier"]["timeout_sec"]},
            }
        for check in question["final"]["checks"]:
            check.pop("prompt", None)

        if title == "algotune-optimize-matrix-sqrt":
            for name in ["evaluator.py", "oracle_solver.py"]:
                old = f"private/reference/{name}"
                if old in files:
                    files[f"private/{name}"] = files.pop(old)
                ensure_source(f"tests/{name}", f"private/{name}")
            ensure_source("tests/test_outputs.py", "private/test_outputs.py")
            discard("private/reference/native_judge.py")
            source["adaptationChanges"][1] = "私有保留问题生成器、oracle 和性能判分入口，不打包通用 LLM Judge。"
            final["answer"]["judge"] = "private/test_outputs.py"
        elif title.startswith("featurebench-"):
            for name in ["setup_patch.diff", "test_patch.diff"]:
                old = f"private/reference/{name}"
                if old in files:
                    files[f"private/{name}"] = files.pop(old)
            ensure_source("tests/test.sh", "private/test.sh")
            source["adaptationChanges"][1] = "私有保留 setup/test patch 和测试入口；固定基线须先应用掩码并清理历史，不能向 Agent 暴露被移除的实现。"
            final["answer"]["judge"] = "private/test.sh"
        elif title == "bix-diff-expr-mirna":
            if "private/reference/ground_truth.json" in files:
                assert json.loads(files["private/reference/ground_truth.json"])["ideal_answer"] == final["answer"]
            discard("private/reference/ground_truth.json", "private/reference/verify.py")
        elif title.startswith("gaia2-"):
            if "private/oracle_events.json" in files:
                events = json.loads(files["private/oracle_events.json"])
                assert len(events) == len(final["answer"]["oracleActions"])
                assert files["private/oracle_answer.txt"].decode().strip() == final["answer"]["finalResponse"]
                assert files["private/oracle_task.txt"].decode().strip() in json.dumps(json.loads(files["private/scenario.json"]), ensure_ascii=False)
                final["answer"].pop("oracleActions")
                final["answer"].update(scenario="private/scenario.json", oracleEvents=events)
            discard("private/oracle_actions.json", "private/oracle_answer.txt", "private/oracle_events.json", "private/oracle_task.txt")
            source["adaptationChanges"][1] = "scenario 私有保留；原始 oracle 事件 DAG 与最终回复合并至 private/final.json，保留事件时间、父依赖与动态 ID。"
        elif title.startswith("replicationbench-"):
            discard("private/reference/config.json", "private/reference/test_outputs.py")
        elif title.startswith("skillsbench-"):
            assert len(final["answer"]["rows"]) == len(question["environment"]["inputs"]) == 22
            discard("private/stat_oracle.xlsx")
            final["rubric"] = final["rubric"].replace("private/stat_oracle.xlsx", "本文件 answer.rows")
            source["adaptationChanges"][1] = "22 张票据图片作为公开输入；工作表、列定义与全部行级期望只保留于 private/final.json。"
        elif title.startswith("widesearch-"):
            if "private/gold_answer.csv" in files:
                rows = list(csv.DictReader(io.StringIO(files["private/gold_answer.csv"].decode("utf-8-sig"))))
                assert rows == final["answer"]
            # Field-specific matching rules are not redundant with the gold rows.
            # Keep eval_config.json, but remove the duplicate CSV.
            discard("private/gold_answer.csv")
            source["adaptationChanges"][1] = "完整参考表合并至 private/final.json；仅额外保留字段级匹配规则 eval_config.json，不向 Agent 暴露。"
        elif title.startswith("usaco-"):
            # Keep the working hidden-test harness: stripping it would remove
            # executable comparison, sandboxing and per-test resource controls.
            discard("private/reference-tests/Dockerfile")

    if question != before[0]:
        files["question.json"] = json_bytes(question)
    if final != before[1]:
        files["private/final.json"] = json_bytes(final)
    return files


def read_tree(root):
    files = {}
    for file in sorted(root.rglob("*")):
        if file.is_symlink():
            raise ValueError(f"Refusing symlink: {file}")
        if file.is_file():
            files[file.relative_to(root).as_posix()] = file.read_bytes()
    return files


def publish(root, before, after):
    """Only replace inspected files; delete exact known files, never recursively."""
    if read_tree(root) != before:
        raise ValueError(f"Files changed during preflight: {root}")
    for relative, content in after.items():
        if before.get(relative) != content:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    for relative in before.keys() - after.keys():
        (root / relative).unlink()
    for directory in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        if not any(directory.iterdir()):
            directory.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("datasets", type=Path)
    parser.add_argument("--harbor-tasks", type=Path)
    parser.add_argument("--apply", action="store_true", help="Back up first, then apply the displayed migration")
    args = parser.parse_args()
    root = args.datasets.resolve()
    before = read_tree(root)
    after = dict(before)
    questions = 0
    for relative in sorted(before):
        parts = Path(relative).parts
        if len(parts) != 3 or parts[0] == "attention-pytorch" or parts[-1] != "question.json":
            continue
        questions += 1
        prefix = "/".join(parts[:2]) + "/"
        bundle = {name[len(prefix):]: data for name, data in before.items() if name.startswith(prefix)}
        compact = compact_bundle(bundle, args.harbor_tasks / parts[1] if args.harbor_tasks else None)
        for name in bundle:
            after.pop(prefix + name)
        after.update({prefix + name: data for name, data in compact.items()})
    for family, names in ROOT_REDUNDANCIES.items():
        for name in names:
            after.pop(f"{family}/{name}", None)
    after.pop(".DS_Store", None)
    if any(name.startswith("spreadsheetbench/") for name in before):
        after.setdefault("spreadsheetbench/LICENSE.md", SPREADSHEET_LICENSE.encode())
    deleted = sorted(before.keys() - after.keys())
    changed = sorted(name for name in after if before.get(name) != after[name])
    report = {"questions": questions, "deletedFiles": len(deleted), "writtenFiles": len(changed)}
    if args.apply and (deleted or changed):
        backup = Path(tempfile.mkdtemp(prefix="evaldock-datasets-compact-")) / "before.tar.gz"
        with tarfile.open(backup, "w:gz") as archive:
            for name, data in before.items():
                entry = tarfile.TarInfo("datasets/" + name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        publish(root, before, after)
        report["backup"] = str(backup)
    report["changed"] = changed
    report["deleted"] = deleted
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
