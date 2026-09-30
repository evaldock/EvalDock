#!/usr/bin/env python3
"""Build a compact high-signal Agent-evaluation batch from pinned upstream snapshots."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable


REVISIONS = {
    "browsecomp": "652c89d0ca9df547706735883097e9537d40dc47",
    "rhelm": "320de60546c78934eac6f61c57119b9fbbeaac60",
    "webwalkerqa": "c7ab3329a2a4a35ca569fdca369b61a3d1787e5b",
    "webwalker-code": "f72f75d8c3eb842f2bbbab096a12206ff66e270f",
    "deepresearch-bench-ii": "087c1b8d4a0ed46fd3dd8615a0b5e93ce3acf6f8",
    "sealqa": "b2ecadf036972d8471a5c4cdf92aa3b3c6ba96e7",
}

BROWSECOMP_BLOB_SHA256 = "7b24471cd5b3eb2a46830a14802b5c029ea62f488ff75a0f88af7923d1454abf"
COUNTS = {
    "browsecomp": 15,
    "rhelm": 10,
    "webwalkerqa": 10,
    "deepresearch-bench-ii": 10,
    "sealqa": 5,
}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def evenly_spaced(items: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    if count < 1 or count > len(items):
        raise ValueError(f"cannot select {count} from {len(items)} rows")
    if count == 1:
        return [items[len(items) // 2]]
    indexes = [round(index * (len(items) - 1) / (count - 1)) for index in range(count)]
    if len(set(indexes)) != count:
        raise AssertionError("evenly-spaced indexes must be unique")
    return [items[index] for index in indexes]


def proportional_quotas(groups: dict[str, list[dict[str, Any]]], total: int) -> dict[str, int]:
    if total < len(groups):
        raise ValueError("total must cover every stratum")
    quotas = {key: 1 for key in groups}
    while sum(quotas.values()) < total:
        candidates = [key for key, rows in groups.items() if quotas[key] < len(rows)]
        if not candidates:
            raise ValueError("not enough rows to fill quota")
        selected = max(candidates, key=lambda key: (len(groups[key]) / (quotas[key] + 1), key))
        quotas[selected] += 1
    return quotas


def stratified_sample(
    rows: list[dict[str, Any]],
    total: int,
    stratum: Callable[[dict[str, Any]], str],
) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[stratum(row)].append(row)
    quotas = proportional_quotas(groups, total)
    selected: list[dict[str, Any]] = []
    for key in sorted(groups):
        selected.extend(evenly_spaced(groups[key], quotas[key]))
    return selected


def manifest(dataset_id: str, case_count: int) -> dict[str, Any]:
    return {
        "schema": "evaldock.dataset/v1",
        "datasetId": dataset_id,
        "version": "1.1.0",
        "catalogRef": "../catalog.md",
        "casesFile": "cases.jsonl",
        "caseCount": case_count,
        "environmentId": "environment.macos/v1",
    }


def base_case(
    *,
    dataset: str,
    ordinal: int,
    question_id: str,
    question: str,
    reference_answer: dict[str, Any],
    metadata: dict[str, Any],
    evidence: list[str] | None = None,
    input_assets: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema_version": "1.0",
        "dataset": dataset,
        "sample_id": f"{dataset}-{ordinal:03d}",
        "question_id": question_id,
        "question": question,
        "reference_answer": reference_answer,
        "evidence": evidence or [],
        "choices": [],
        "evaluator": "label_llm_judges",
        "metadata": metadata,
    }
    if input_assets:
        result["input_assets"] = input_assets
    return result


def derive_key(password: str, length: int) -> bytes:
    digest = hashlib.sha256(password.encode()).digest()
    return digest * (length // len(digest)) + digest[: length % len(digest)]


def decrypt_browsecomp(value: str, canary: str) -> str:
    encrypted = base64.b64decode(value)
    key = derive_key(canary, len(encrypted))
    return bytes(left ^ right for left, right in zip(encrypted, key)).decode()


def build_browsecomp(source_root: Path) -> list[dict[str, Any]]:
    source = source_root / "browse_comp_test_set.csv"
    if sha256_file(source) != BROWSECOMP_BLOB_SHA256:
        raise ValueError("BrowseComp source blob does not match the pinned SHA-256")
    with source.open(encoding="utf-8", newline="") as handle:
        encrypted_rows = list(csv.DictReader(handle))
    rows = []
    for index, row in enumerate(encrypted_rows, 1):
        rows.append({
            "_source_index": index,
            "question": decrypt_browsecomp(row["problem"], row["canary"]),
            "answer": decrypt_browsecomp(row["answer"], row["canary"]),
            "topic": row["problem_topic"],
        })
    selected = stratified_sample(rows, COUNTS["browsecomp"], lambda row: row["topic"])
    result = []
    for ordinal, row in enumerate(selected, 1):
        result.append(base_case(
            dataset="browsecomp",
            ordinal=ordinal,
            question_id=f"browsecomp:{row['_source_index']}",
            question=(
                f"{row['question']}\n\n"
                "Search the public web persistently and cross-check competing candidates. Answer according to "
                "the historical facts targeted by the benchmark; if a live page changed, use an archived or dated "
                "source. Write the concise exact answer and URLs supporting the decisive clues to output/answer.txt."
            ),
            reference_answer={
                "required_artifact": "output/answer.txt",
                "requirements": [
                    "The exact answer is semantically equivalent to the upstream reference answer",
                    "The response cites URLs supporting the decisive clues",
                    "The deliverable is saved at output/answer.txt",
                ],
                "ground_truth": row["answer"],
            },
            metadata={
                "topic": row["topic"],
                "upstream_row": row["_source_index"],
                "source_dataset": "OpenAI/BrowseComp",
                "source_file": "browse_comp_test_set.csv",
                "source_url": "https://github.com/openai/simple-evals",
                "source_revision": REVISIONS["browsecomp"],
                "source_blob_sha256": BROWSECOMP_BLOB_SHA256,
                "benchmark_release_date": "2025-04-17",
                "selection_method": "topic-stratified proportional sample; evenly spaced within each of 10 topics",
                "canary_handling": "used only to decrypt upstream fields; omitted from public and private bundles",
            },
        ))
    return result


def profile_from_qa_file(path: Path) -> str:
    name = path.stem
    prefix = "low_score_qa_"
    suffix = "_all_validated"
    if not name.startswith(prefix) or not name.endswith(suffix):
        raise ValueError(f"unexpected RHELM QA filename: {path.name}")
    return name[len(prefix):-len(suffix)]


def profile_memory(source_root: Path, profile: str) -> dict[str, Any]:
    data_root = source_root / "data"
    conversations = []
    for path in sorted((data_root / "conversations" / profile).glob("*.json")):
        conversations.append({
            "source_id": path.relative_to(data_root).as_posix(),
            "content": json.loads(path.read_text(encoding="utf-8")),
        })
    emails = []
    for path in sorted((data_root / "emails" / profile).glob("*")):
        if path.is_file():
            emails.append({
                "source_id": path.relative_to(data_root).as_posix(),
                "content": path.read_text(encoding="utf-8"),
            })
    attachments = []
    for path in sorted((data_root / "attachments" / profile).glob("*")):
        if path.is_file():
            attachments.append({
                "source_id": path.relative_to(data_root).as_posix(),
                "content": path.read_text(encoding="utf-8"),
            })
    if not conversations or not emails or not attachments:
        raise ValueError(f"RHELM profile {profile} is missing a memory source type")
    return {
        "profile": profile,
        "conversations": conversations,
        "emails": emails,
        "attachments": attachments,
    }


def build_rhelm(source_root: Path) -> list[dict[str, Any]]:
    qa_files = sorted((source_root / "data" / "QA_final").glob("*.jsonl"))
    profiles = [profile_from_qa_file(path) for path in qa_files]
    if len(profiles) != COUNTS["rhelm"] or len(set(profiles)) != len(profiles):
        raise ValueError("RHELM batch expects exactly 10 distinct profiles")
    desired_types = [
        "fact", "temporal", "aggregation", "hallucination", "misleading",
        "attachment", "mixed", "fact", "temporal", "aggregation",
    ]
    result = []
    for ordinal, (qa_file, profile, question_type) in enumerate(zip(qa_files, profiles, desired_types), 1):
        candidates = []
        for source_row, row in enumerate(read_jsonl(qa_file), 1):
            if row["question_type"] == question_type:
                candidates.append({**row, "_source_row": source_row})
        if not candidates:
            raise ValueError(f"RHELM profile {profile} has no {question_type} question")
        row = sorted(candidates, key=lambda item: (-len(item["characteristics"]), item["id"]))[0]
        memory = profile_memory(source_root, profile)
        memory_counts = {key: len(memory[key]) for key in ("conversations", "emails", "attachments")}
        result.append(base_case(
            dataset="rhelm",
            ordinal=ordinal,
            question_id=f"rhelm:{row['id']}",
            question=(
                "Read the complete heterogeneous profile history in input/memory.json, including conversations, "
                "emails, and attachments. Resolve the following query as of "
                f"{row['question_date']}:\n\n{row['question']}\n\n"
                "Use only the supplied memory. Account for later updates, contradictions, misleading premises, and "
                "missing information. Write the concise answer and the relevant source IDs or conversation "
                "date/turn identifiers to output/answer.txt."
            ),
            reference_answer={
                "required_artifact": "output/answer.txt",
                "requirements": [
                    "The answer is semantically equivalent to ground_truth.answer",
                    "The response handles absence, temporal updates, or misleading premises when required by the reference",
                    "When supporting evidence exists, cite matching memory source IDs or conversation date/turn identifiers",
                    "The deliverable is saved at output/answer.txt",
                ],
                "ground_truth": {
                    "answer": row["answer"],
                    "supporting_evidence": row["supporting_evidence"],
                    "question_type": row["question_type"],
                    "characteristics": row["characteristics"],
                },
            },
            input_assets=[{
                "name": "memory.json",
                "destination": "input/memory.json",
                "content": memory,
            }],
            metadata={
                "profile": profile,
                "upstream_question_id": row["id"],
                "upstream_row": row["_source_row"],
                "question_date": row["question_date"],
                "question_type": row["question_type"],
                "characteristics": row["characteristics"],
                "memory_source_counts": memory_counts,
                "source_dataset": "microsoft/RHELM",
                "source_files": [
                    f"data/QA_final/{qa_file.name}",
                    f"data/conversations/{profile}",
                    f"data/emails/{profile}",
                    f"data/attachments/{profile}",
                ],
                "source_url": "https://github.com/microsoft/RHELM",
                "source_revision": REVISIONS["rhelm"],
                "selection_method": "one unique profile per case; all 7 question types covered; hardest characteristic-rich row selected per profile/type",
            },
        ))
    return result


def build_webwalkerqa(source_root: Path) -> list[dict[str, Any]]:
    source = source_root / "data" / "main-00000-of-00001.jsonl"
    rows = [{**row, "_source_index": index} for index, row in enumerate(read_jsonl(source), 1)]
    targets = [
        ("conference", "en", "single_source"),
        ("conference", "en", "multi_source"),
        ("education", "en", "single_source"),
        ("education", "en", "multi_source"),
        ("education", "zh", "single_source"),
        ("education", "zh", "multi_source"),
        ("game", "en", "multi_source"),
        ("game", "zh", "single_source"),
        ("organization", "en", "multi_source"),
        ("organization", "zh", "multi_source"),
    ]
    selected = []
    for domain, language, source_type in targets:
        candidates = [
            row for row in rows
            if row["info"]["domain"] == domain
            and row["info"]["lang"] == language
            and row["info"]["type"] == source_type
            and row["info"]["difficulty_level"] == "hard"
        ]
        if not candidates:
            raise ValueError(f"missing WebWalkerQA stratum {domain}/{language}/{source_type}/hard")
        https_candidates = [
            row for row in candidates
            if row["root_url"].startswith("https://")
            and all(url.startswith("https://") for url in row["info"]["source_website"])
        ]
        pool = https_candidates or candidates
        selected.append(pool[len(pool) // 2])
    result = []
    for ordinal, row in enumerate(selected, 1):
        info = row["info"]
        result.append(base_case(
            dataset="webwalkerqa",
            ordinal=ordinal,
            question_id=f"webwalkerqa:{row['_source_index']}",
            question=(
                f"Starting from {row['root_url']}, traverse the website to answer:\n\n{row['question']}\n\n"
                "Discover the relevant pages yourself. If a live page moved, use the site's navigation, search, or "
                "an archived copy. Write the concise answer and every visited URL used as evidence to output/answer.txt."
            ),
            reference_answer={
                "required_artifact": "output/answer.txt",
                "requirements": [
                    "The answer is semantically equivalent to ground_truth.answer",
                    "The response cites the relevant page or pages discovered from the root URL",
                    "Multi-source cases combine all required facts",
                    "The deliverable is saved at output/answer.txt",
                ],
                "ground_truth": {
                    "answer": row["answer"],
                    "root_url": row["root_url"],
                    "source_website": info["source_website"],
                    "golden_path": info["golden_path"],
                },
            },
            evidence=info["source_website"],
            metadata={
                "upstream_row": row["_source_index"],
                "root_url": row["root_url"],
                "domain": info["domain"],
                "language": info["lang"],
                "source_type": info["type"],
                "difficulty_level": info["difficulty_level"],
                "source_dataset": "callanwu/WebWalkerQA",
                "source_file": "data/main-00000-of-00001.jsonl",
                "source_url": "https://huggingface.co/datasets/callanwu/WebWalkerQA",
                "source_revision": REVISIONS["webwalkerqa"],
                "upstream_code_url": "https://github.com/Alibaba-NLP/DeepResearch/tree/main/WebAgent/WebWalker",
                "upstream_code_revision": REVISIONS["webwalker-code"],
                "selection_method": "verified main split only; 10 hard strata covering four domains, two languages, and single/multi-source traversal",
            },
        ))
    return result


def build_deepresearch_bench_ii(source_root: Path) -> list[dict[str, Any]]:
    source = source_root / "tasks_and_rubrics.jsonl"
    rows = read_jsonl(source)
    topics = ["Finance & Business", "Health", "Education & Jobs", "Software Development", "Science & Technology"]
    selected = []
    for language in ("zh", "en"):
        for topic in topics:
            candidates = sorted(
                [row for row in rows if row["language"] == language and row["theme"] == topic and row["license"] in {"CC BY 4.0", "CC0"}],
                key=lambda row: row["idx"],
            )
            if not candidates:
                raise ValueError(f"missing DeepResearch Bench II stratum {language}/{topic}")
            selected.append(candidates[len(candidates) // 2])
    result = []
    for ordinal, row in enumerate(selected, 1):
        if row["language"] == "zh":
            delivery = (
                "请开展独立网页研究并将完整报告写入 output/report.md。逐条满足任务要求，使用可点击来源支撑关键事实，"
                "不要引用题目所依据的原始专家报告；明确区分事实、推断与不确定性。"
            )
            requirements = [
                "逐条覆盖私有原子 rubric 中的信息召回、分析与呈现要求",
                "关键结论有独立、可追溯的高质量来源支持",
                "不得依赖 private blocked references 中列出的原始专家报告",
                "报告结构及格式遵循原始任务",
                "输出文件路径为 output/report.md",
            ]
        else:
            delivery = (
                "Conduct independent web research and write the complete report to output/report.md. Address every "
                "part of the request, cite key claims with clickable sources, do not rely on the expert report from "
                "which the task was derived, and distinguish facts, inferences, and uncertainty."
            )
            requirements = [
                "Cover the private atomic information-recall, analysis, and presentation rubrics",
                "Support key conclusions with independent, traceable, high-quality sources",
                "Do not rely on the original expert report listed in private blocked references",
                "Follow the requested report structure and presentation constraints",
                "Save the deliverable at output/report.md",
            ]
        rubric = row["content"]["rubric"]
        blocked = row["content"]["blocked"]
        result.append(base_case(
            dataset="deepresearch-bench-ii",
            ordinal=ordinal,
            question_id=f"deepresearch-bench-ii:{row['id']}",
            question=f"{row['content']['task']}\n\n{delivery}",
            reference_answer={
                "required_artifact": "output/report.md",
                "requirements": requirements,
                "ground_truth": {
                    "rubric": rubric,
                    "blocked_references": blocked,
                },
            },
            metadata={
                "upstream_id": row["id"],
                "upstream_index": row["idx"],
                "language": row["language"],
                "theme": row["theme"],
                "description": row["description"],
                "license": row["license"],
                "rubric_counts": {dimension: len(items) for dimension, items in rubric.items()},
                "source_dataset": "imlrz/DeepResearch-Bench-II",
                "source_file": "tasks_and_rubrics.jsonl",
                "source_url": "https://github.com/imlrz/DeepResearch-Bench-II",
                "source_revision": REVISIONS["deepresearch-bench-ii"],
                "selection_method": "paired zh/en sample across five themes; CC BY 4.0 or CC0 tasks only; midpoint by upstream index",
                "scoring_note": "EvalDock uses the official atomic rubrics and blocked-reference list with its configured Judge; scores are not official leaderboard scores",
            },
        ))
    return result


def build_sealqa(source_root: Path) -> list[dict[str, Any]]:
    payload = json.loads((source_root / "seal-0-rows.json").read_text(encoding="utf-8"))
    rows_by_index = {item["row_idx"]: item["row"] for item in payload["rows"]}
    selected_indexes = [10, 43, 78, 59, 65]
    if any(index not in rows_by_index for index in selected_indexes):
        raise ValueError("SealQA export does not contain the curated source rows")
    result = []
    for ordinal, source_index in enumerate(selected_indexes, 1):
        row = rows_by_index[source_index]
        result.append(base_case(
            dataset="sealqa",
            ordinal=ordinal,
            question_id=f"sealqa:seal-0:{source_index}",
            question=(
                f"{row['question']}\n\n"
                f"Answer using evidence applicable to the benchmark's effective period ({row['effective_year']}). "
                "Search the public web, explicitly resolve conflicting or unhelpful results, and reject a false "
                "premise when necessary. Write the concise answer and supporting URLs to output/answer.txt."
            ),
            reference_answer={
                "required_artifact": "output/answer.txt",
                "requirements": [
                    "The answer is semantically equivalent to the upstream reference answer",
                    "The response respects the benchmark effective period and resolves ambiguity or a false premise",
                    "The response cites URLs supporting the decisive facts",
                    "The deliverable is saved at output/answer.txt",
                ],
                "ground_truth": row["answer"],
            },
            evidence=row["urls"],
            metadata={
                "upstream_row": source_index,
                "source_split": "seal_0/test",
                "freshness": row["freshness"],
                "question_types": row["question_types"],
                "effective_year": row["effective_year"],
                "search_results": row["search_results"],
                "topic": row["topic"],
                "source_dataset": "vtllms/sealqa",
                "source_file": "seal-0.parquet",
                "source_url": "https://huggingface.co/datasets/vtllms/sealqa",
                "source_revision": REVISIONS["sealqa"],
                "selection_method": "manually curated five-topic stress sample covering conflicting/unhelpful results, three freshness levels, false-premise and cross-lingual reasoning",
                "canary_handling": "omitted from public and private bundles",
            },
        ))
    return result


def catalog_entries() -> list[dict[str, Any]]:
    web_labels = [
        "label.artifact-delivery/v1",
        "label.efficiency-reliability/v1",
        "label.loop/v1",
        "label.reasoning-planning/v1",
        "label.retrieval-grounding/v1",
        "label.tool-web/v1",
    ]
    return [
        {
            "datasetId": "dataset.browsecomp/v1",
            "name": "BrowseComp",
            "description": (
                "数据集: BrowseComp 英文原版\n最突出的测试对象: 持续网页检索、多跳实体消歧、长链线索排除与精确短答案\n"
                "当前输入形态: 15 个逐题 Question Bundle；从官方 1,266 题按 10 个 problem_topic 分层抽样，canary 仅用于解密且未写入 Bundle\n"
                "输出与评分: output/answer.txt；标准答案位于 private/final.json，Judge 检查语义正确性、来源与交付\n"
                "最适合的 Agent: 搜索 Agent、浏览器 Agent、开放域事实研究 Agent\n"
                "关键局限: 官方参考实现不提供完整浏览器执行环境；网页可能漂移，本地 Judge 分数不能直接等同官方 BrowseComp。\n\n"
                "标签与证据: artifact-delivery 检查文件交付；efficiency-reliability 检查长链搜索稳定性；loop 检查失败重试与候选排除；"
                "reasoning-planning 检查线索拆解；retrieval-grounding 检查答案与来源一致；tool-web 检查真实网页检索。"
            ),
            "labelIds": web_labels,
            "availableCaseCount": COUNTS["browsecomp"],
        },
        {
            "datasetId": "dataset.rhelm/v1",
            "name": "RHELM",
            "description": (
                "数据集: RHELM\n最突出的测试对象: 异构、演化长期记忆中的事实、时间、聚合、拒答、误导、附件和混合证据推理\n"
                "当前输入形态: 10 个逐题 Question Bundle；覆盖 10 个不同人物与全部 7 种 question_type，每题提供完整对话、邮件和附件 memory.json\n"
                "输出与评分: output/answer.txt；答案及 supporting_evidence 位于 private/final.json\n"
                "最适合的 Agent: 长期记忆 Agent、个人助理、企业知识与邮件/附件检索 Agent\n"
                "关键局限: 当前按题重复加载人物历史，尚未测一次建库、多次查询的真实持久化成本。\n\n"
                "标签与证据: artifact-delivery 检查答案文件；efficiency-reliability 检查大记忆输入下的稳定性；memory 检查跨时间更新；"
                "reasoning-planning 检查时间与冲突综合；retrieval-grounding 检查 supporting evidence；safety-boundary 检查误导前提、缺失信息与拒答。"
            ),
            "labelIds": [
                "label.artifact-delivery/v1",
                "label.efficiency-reliability/v1",
                "label.memory/v1",
                "label.reasoning-planning/v1",
                "label.retrieval-grounding/v1",
                "label.safety-boundary/v1",
            ],
            "availableCaseCount": COUNTS["rhelm"],
        },
        {
            "datasetId": "dataset.webwalkerqa/v1",
            "name": "WebWalkerQA",
            "description": (
                "数据集: WebWalkerQA\n最突出的测试对象: 从根网站发现入口、纵向遍历层级、多页面导航与跨页事实综合\n"
                "当前输入形态: 10 个逐题 Question Bundle；仅取人工验证 main split 的 hard 题，覆盖四个领域、中英文及单/多来源任务\n"
                "输出与评分: output/answer.txt；答案、参考页面和 golden path 位于 private/final.json，不向 Agent 泄漏\n"
                "最适合的 Agent: 浏览器 Agent、网站导航 Agent、垂直搜索与信息搜集 Agent\n"
                "关键局限: 依赖真实网页，页面迁移或失效会影响复现；运行时应保留访问 URL 和导航轨迹。\n\n"
                "标签与证据: artifact-delivery 检查答案文件；efficiency-reliability 检查网页漂移与导航稳定性；loop 检查回退和重试；"
                "reasoning-planning 检查路径规划；retrieval-grounding 检查跨页证据；tool-web 检查真实网站遍历。"
            ),
            "labelIds": web_labels,
            "availableCaseCount": COUNTS["webwalkerqa"],
        },
        {
            "datasetId": "dataset.deepresearch-bench-ii/v1",
            "name": "DeepResearch Bench II",
            "description": (
                "数据集: DeepResearch Bench II\n最突出的测试对象: 专家级深度研究、细粒度事实召回、分析、报告呈现和独立引用\n"
                "当前输入形态: 10 个逐题 Question Bundle；中英文各 5 题，成对覆盖五个主题，仅使用 CC BY 4.0 或 CC0 任务\n"
                "输出与评分: output/report.md；官方 atomic rubrics 与 blocked references 位于 private/final.json\n"
                "最适合的 Agent: Deep Research Agent、行业研究 Agent、网页调研与长报告生成 Agent\n"
                "关键局限: 官方评测使用 rubric 级三值 Judge；本地 EvalDock Judge 虽读取同一 rubric，但分数不可与官方榜单直接比较。\n\n"
                "标签与证据: artifact-delivery 检查报告；efficiency-reliability 检查长任务稳定性；loop 检查研究迭代；"
                "reasoning-planning 检查任务分解与分析；retrieval-grounding 检查独立引用并阻止 blocked source 取巧；tool-web 检查网页研究。"
            ),
            "labelIds": web_labels,
            "availableCaseCount": COUNTS["deepresearch-bench-ii"],
        },
        {
            "datasetId": "dataset.sealqa/v1",
            "name": "SealQA",
            "description": (
                "数据集: SealQA\n最突出的测试对象: 搜索结果冲突、低帮助度证据、错误前提、跨语言线索和时间有效性\n"
                "当前输入形态: 5 个逐题 Question Bundle；来自 Seal-0，覆盖五个主题、三种 freshness 及 conflicting/unhelpful 两类搜索结果\n"
                "输出与评分: output/answer.txt；答案与官方参考 URL 位于 private/final.json，canary 未写入 Bundle\n"
                "最适合的 Agent: 搜索增强 Agent、事实核验 Agent、对抗性网页研究 Agent\n"
                "关键局限: 这是窄域压力子集，不能单独代表整体 Agent 能力；快变信息必须按 effective_year 评分。\n\n"
                "标签与证据: artifact-delivery 检查答案文件；efficiency-reliability 检查噪声搜索下稳定性；loop 检查冲突消解；"
                "reasoning-planning 检查错误前提与时间推理；retrieval-grounding 检查来源；safety-boundary 检查不随错误前提作答；tool-web 检查搜索行为。"
            ),
            "labelIds": [
                "label.artifact-delivery/v1",
                "label.efficiency-reliability/v1",
                "label.loop/v1",
                "label.reasoning-planning/v1",
                "label.retrieval-grounding/v1",
                "label.safety-boundary/v1",
                "label.tool-web/v1",
            ],
            "availableCaseCount": COUNTS["sealqa"],
        },
    ]


def update_catalog(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    match = re.search(r"```json evaldock-dataset-catalog\s*\n([\s\S]*?)\n```", source)
    if match is None:
        raise ValueError("catalog Markdown is missing its evaldock JSON block")
    catalog = json.loads(match.group(1))
    replacements = {entry["datasetId"]: entry for entry in catalog_entries()}
    updated = []
    seen: set[str] = set()
    for entry in catalog["datasets"]:
        dataset_id = entry["datasetId"]
        if dataset_id in replacements:
            updated.append(replacements[dataset_id])
            seen.add(dataset_id)
        else:
            updated.append(entry)
    updated.extend(entry for entry in replacements.values() if entry["datasetId"] not in seen)
    catalog["datasets"] = updated
    payload = json.dumps(catalog, ensure_ascii=False, indent=2)
    path.write_text(source[:match.start(1)] + payload + source[match.end(1):], encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_root", type=Path, help="directory containing pinned upstream snapshots")
    parser.add_argument("repo_root", type=Path, nargs="?", default=Path.cwd())
    args = parser.parse_args()
    source_root = args.source_root.resolve()
    builders = {
        "browsecomp": ("dataset.browsecomp/v1", lambda: build_browsecomp(source_root)),
        "rhelm": ("dataset.rhelm/v1", lambda: build_rhelm(source_root / "rhelm")),
        "webwalkerqa": ("dataset.webwalkerqa/v1", lambda: build_webwalkerqa(source_root / "webwalkerqa")),
        "deepresearch-bench-ii": (
            "dataset.deepresearch-bench-ii/v1",
            lambda: build_deepresearch_bench_ii(source_root / "drb2"),
        ),
        "sealqa": ("dataset.sealqa/v1", lambda: build_sealqa(source_root)),
    }
    datasets_root = args.repo_root.resolve() / "datasets"
    for slug, (dataset_id, builder) in builders.items():
        rows = builder()
        if len(rows) != COUNTS[slug]:
            raise ValueError(f"{slug}: expected {COUNTS[slug]} rows, received {len(rows)}")
        directory = datasets_root / slug
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "dataset.json").write_text(
            json.dumps(manifest(dataset_id, len(rows)), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        write_jsonl(directory / "cases.jsonl", rows)
        print(f"{slug}: {len(rows)} cases")
    update_catalog(datasets_root / "catalog.md")
    print("catalog: updated")
    subprocess.run(
        [
            "node",
            str(args.repo_root.resolve() / "scripts" / "convert-flat-datasets-to-question-bundles.mjs"),
            str(args.repo_root.resolve()),
            *builders.keys(),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
