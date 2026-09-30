#!/usr/bin/env python3
"""Build the first external Agent-evaluation dataset batch from pinned upstream snapshots."""

from __future__ import annotations

import argparse
import ast
import csv
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable


REVISIONS = {
    "deepsearchqa": "b2623f8653065c2672de6d941fc5434cd652376c",
    "browsecomp-zh": "86abe635e7deef89ec00c68ff1c2588f0e2f2099",
    "personamem-32k": "a8076d5608c93ba2a28983cd78aa99b01a163ae7",
    "deepresearch-bench": "469cce54ea7f6a63c163d3d9fec879cf289ec484",
}


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


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
    """Give every stratum one row, then distribute remaining slots with D'Hondt priorities."""
    if total < len(groups):
        raise ValueError("total must cover every stratum")
    quotas = {key: 1 for key in groups}
    while sum(quotas.values()) < total:
        candidates = [key for key, rows in groups.items() if quotas[key] < len(rows)]
        if not candidates:
            raise ValueError("not enough rows to fill quota")
        chosen = max(candidates, key=lambda key: (len(groups[key]) / (quotas[key] + 1), key))
        quotas[chosen] += 1
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
    memory: dict[str, Any] | None = None,
    choices: list[str] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema_version": "1.0",
        "dataset": dataset,
        "sample_id": f"{dataset}-{ordinal:03d}",
        "question_id": question_id,
        "question": question,
        "reference_answer": reference_answer,
        "evidence": [],
        "choices": choices or [],
        "evaluator": "label_llm_judges",
        "metadata": metadata,
    }
    if memory is not None:
        result["memory"] = memory
    return result


def build_deepsearchqa(source_root: Path) -> list[dict[str, Any]]:
    with (source_root / "deepsearchqa.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    indexed = [{**row, "_source_index": index + 1} for index, row in enumerate(rows)]
    selected = stratified_sample(indexed, 30, lambda row: row["problem_category"])
    result = []
    for ordinal, row in enumerate(selected, 1):
        answer_type = row["answer_type"]
        result.append(base_case(
            dataset="deepsearchqa",
            ordinal=ordinal,
            question_id=f"deepsearchqa:{row['_source_index']}",
            question=(
                f"{row['problem']}\n\n"
                "Use public web sources to answer the question. Treat 2025-12-17 as the dataset cutoff "
                "unless the question states another time range. Save a concise final answer and the URLs "
                "supporting the key facts to output/answer.txt."
            ),
            reference_answer={
                "required_artifact": "output/answer.txt",
                "requirements": [
                    "The answer is semantically consistent with the upstream reference answer",
                    "Set-answer questions include every required item without unsupported extras",
                    "Key factual claims include traceable source URLs",
                    "The deliverable is saved at output/answer.txt",
                ],
                "ground_truth": row["answer"],
            },
            metadata={
                "problem_category": row["problem_category"],
                "answer_type": answer_type,
                "upstream_row": row["_source_index"],
                "source_dataset": "google/deepsearchqa",
                "source_file": "DSQA-full.csv",
                "source_url": "https://huggingface.co/datasets/google/deepsearchqa",
                "source_revision": REVISIONS["deepsearchqa"],
                "dataset_cutoff": "2025-12-17",
                "selection_method": "category-stratified proportional sample; evenly spaced within category",
            },
        ))
    return result


def build_browsecomp_zh(source_root: Path) -> list[dict[str, Any]]:
    rows = json.loads((source_root / "browsecomp-zh.json").read_text(encoding="utf-8"))
    indexed = [{**row, "_source_index": index + 1} for index, row in enumerate(rows)]
    selected = stratified_sample(indexed, 30, lambda row: row["Topic"])
    result = []
    for ordinal, row in enumerate(selected, 1):
        result.append(base_case(
            dataset="browsecomp-zh",
            ordinal=ordinal,
            question_id=f"browsecomp-zh:{row['_source_index']}",
            question=(
                f"{row['Question']}\n\n"
                "请检索公开网页完成回答；除题目另有说明外，以 2025-05-14 前可核实的信息为准。"
                "请把简明最终答案及支撑关键事实的来源 URL 写入 output/answer.txt。"
            ),
            reference_answer={
                "required_artifact": "output/answer.txt",
                "requirements": [
                    "答案与上游标准答案语义一致",
                    "关键事实附有可追溯的来源 URL",
                    "输出文件路径为 output/answer.txt",
                ],
                "ground_truth": row["Answer"],
            },
            metadata={
                "topic": row["Topic"],
                "upstream_row": row["_source_index"],
                "source_dataset": "PALIN2018/BrowseComp-ZH",
                "source_file": "browsecomp_zh.xlsx",
                "source_url": "https://github.com/PALIN2018/BrowseComp-ZH",
                "source_revision": REVISIONS["browsecomp-zh"],
                "dataset_cutoff": "2025-05-14",
                "selection_method": "topic-stratified proportional sample; evenly spaced within topic",
            },
        ))
    return result


def load_persona_contexts(path: Path) -> dict[str, list[dict[str, str]]]:
    contexts: dict[str, list[dict[str, str]]] = {}
    for row in read_jsonl(path):
        contexts.update(row)
    return contexts


def persona_choices(raw: str) -> list[str]:
    choices = ast.literal_eval(raw)
    if not isinstance(choices, list) or not all(isinstance(choice, str) for choice in choices):
        raise ValueError("PersonaMem all_options must be a list of strings")
    return choices


def build_personamem(source_root: Path) -> list[dict[str, Any]]:
    with (source_root / "persona-questions-32k.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    contexts = load_persona_contexts(source_root / "persona-contexts-32k.jsonl")
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[row["question_type"]].append(row)
    quotas = proportional_quotas(groups, 30)
    selected: list[dict[str, Any]] = []
    for question_type in sorted(groups):
        selected.extend(evenly_spaced(groups[question_type], quotas[question_type]))

    result = []
    for ordinal, row in enumerate(selected, 1):
        shared_context_id = row["shared_context_id"]
        end_index = int(row["end_index_in_shared_context"])
        messages = contexts[shared_context_id][:end_index]
        choices = persona_choices(row["all_options"])
        answer_key = row["correct_answer"].strip().lower()
        matching = [choice for choice in choices if choice.lower().startswith(answer_key)]
        if len(matching) != 1:
            raise ValueError(f"cannot resolve answer {answer_key} for {row['question_id']}")
        result.append(base_case(
            dataset="personamem-32k",
            ordinal=ordinal,
            question_id=f"personamem:{row['question_id']}",
            question=(
                f"{row['user_question_or_message']}\n\n"
                "Use only the supplied conversation memory to select the response that best matches the user's "
                "remembered facts, preferences, and preference changes. Save the option letter and full option text "
                "to output/answer.txt."
            ),
            reference_answer={
                "required_artifact": "output/answer.txt",
                "requirements": [
                    f"Select option {answer_key}",
                    "The response is consistent with the supplied conversation memory",
                    "The deliverable is saved at output/answer.txt",
                ],
                "ground_truth": matching[0],
            },
            memory={
                "shared_context_id": shared_context_id,
                "messages": messages,
            },
            choices=choices,
            metadata={
                "persona_id": int(row["persona_id"]),
                "question_type": row["question_type"],
                "topic": row["topic"],
                "context_length_in_tokens": int(row["context_length_in_tokens"]),
                "distance_to_reference_in_tokens": int(row["distance_to_ref_in_tokens"]),
                "end_index_in_shared_context": end_index,
                "upstream_question_id": row["question_id"],
                "source_dataset": "bowen-upenn/PersonaMem-v1",
                "source_files": ["questions_32k.csv", "shared_contexts_32k.jsonl"],
                "source_url": "https://huggingface.co/datasets/bowen-upenn/PersonaMem-v1",
                "source_revision": REVISIONS["personamem-32k"],
                "selection_method": "question-type-stratified proportional sample; evenly spaced within type",
            },
        ))
    return result


def build_deepresearch_bench(source_root: Path) -> list[dict[str, Any]]:
    data_root = source_root / "deepresearch" / "data"
    queries = read_jsonl(data_root / "prompt_data" / "query.jsonl")
    criteria = {row["id"]: row for row in read_jsonl(data_root / "criteria_data" / "criteria.jsonl")}
    target_topics = ["Finance & Business", "Health", "Education & Jobs", "Art & Design", "Science & Technology"]
    selected = []
    for language in ("zh", "en"):
        for topic in target_topics:
            candidates = [row for row in queries if row["language"] == language and row["topic"] == topic]
            if not candidates:
                raise ValueError(f"missing DeepResearch Bench stratum {language}/{topic}")
            selected.append(candidates[len(candidates) // 2])

    result = []
    for ordinal, row in enumerate(selected, 1):
        rubric = criteria[row["id"]]
        if row["language"] == "zh":
            delivery_instruction = (
                "请开展网页研究，将完整报告写入 output/report.md。报告须区分事实、推断与不确定性，"
                "关键事实使用可点击来源链接并注明数据日期，结尾列出来源。"
            )
            requirements = [
                "完整响应原始研究任务及其全部子问题",
                "关键事实有高质量、可追溯且带日期的网页来源",
                "明确区分事实、推断与不确定性",
                "报告结构清晰，可供复核",
                "输出文件路径为 output/report.md",
            ]
        else:
            delivery_instruction = (
                "Conduct web research and write the complete report to output/report.md. Distinguish facts, "
                "inferences, and uncertainty; cite key claims with clickable sources and data dates; finish with "
                "a source list."
            )
            requirements = [
                "Fully address the research request and all of its subquestions",
                "Support key facts with high-quality, traceable, dated web sources",
                "Distinguish facts, inferences, and uncertainty",
                "Produce a clear report that can be audited",
                "Save the deliverable at output/report.md",
            ]
        result.append(base_case(
            dataset="deepresearch-bench",
            ordinal=ordinal,
            question=f"{row['prompt']}\n\n{delivery_instruction}",
            question_id=f"deepresearch-bench:{row['id']}",
            reference_answer={
                "required_artifact": "output/report.md",
                "requirements": requirements,
                "ground_truth": {
                    "dimension_weight": rubric["dimension_weight"],
                    "criterions": rubric["criterions"],
                },
            },
            metadata={
                "upstream_id": row["id"],
                "topic": row["topic"],
                "language": row["language"],
                "source_dataset": "Ayanami0730/deep_research_bench",
                "source_files": ["data/prompt_data/query.jsonl", "data/criteria_data/criteria.jsonl"],
                "source_url": "https://github.com/Ayanami0730/deep_research_bench",
                "source_revision": REVISIONS["deepresearch-bench"],
                "selection_method": "paired zh/en sample across five target topics",
                "scoring_note": "Local EvalDock label judges use the official per-case rubric; scores are not official RACE/FACT leaderboard scores",
            },
        ))
    return result


def catalog_entries() -> list[dict[str, Any]]:
    return [
        {
            "datasetId": "dataset.deepsearchqa/v1",
            "name": "DeepSearchQA",
            "description": (
                "数据集: DeepSearchQA\n最突出的测试对象: 公开网页深度检索、跨来源综合和精确短答案\n"
                "当前输入形态: 30 个逐题 Question Bundle；从官方 900 题中按 problem_category 分层抽样并覆盖全部 17 个类别\n"
                "输出与评分: output/answer.txt；标准答案位于 private/final.json，EvalDock 标签 Judge 同时检查来源和交付\n"
                "最适合的 Agent: 搜索 Agent、事实核验 Agent、Deep Search/RAG Agent\n"
                "关键局限: 这是固定到 2025-12-17 的开发子集，不等价于官方全量分数；当前通用 LLM Judge 不是官方 evaluator。\n\n"
                "运行时应允许网页检索，保留访问 URL 与检索轨迹。题目要求回答关键事实并引用来源。"
                "抽样对大类按比例分配、对小类至少保留 1 题，类内按原始顺序等距抽取。"
            ),
            "labelIds": [
                "label.artifact-delivery/v1",
                "label.efficiency-reliability/v1",
                "label.loop/v1",
                "label.reasoning-planning/v1",
                "label.retrieval-grounding/v1",
                "label.tool-web/v1",
            ],
            "availableCaseCount": 30,
        },
        {
            "datasetId": "dataset.browsecomp-zh/v1",
            "name": "BrowseComp-ZH",
            "description": (
                "数据集: BrowseComp-ZH\n最突出的测试对象: 中文网页检索、多跳实体消歧和长链线索求解\n"
                "当前输入形态: 30 个逐题 Question Bundle；从官方 289 题中按 11 个 Topic 分层抽样，且未把 canary 写入公开题面\n"
                "输出与评分: output/answer.txt；标准答案位于 private/final.json，由 EvalDock 标签 Judge 检查正确性、来源和交付\n"
                "最适合的 Agent: 中文搜索 Agent、浏览器 Agent、开放域事实研究 Agent\n"
                "关键局限: 固定到 2025-05-14 的小样本；网页内容可能漂移，当前通用 LLM Judge 不是官方精确匹配评分。\n\n"
                "正式运行应记录搜索词、访问 URL、关键证据和失败重试。抽样保证每个 Topic 至少 1 题，其余名额按题量分配。"
            ),
            "labelIds": [
                "label.artifact-delivery/v1",
                "label.efficiency-reliability/v1",
                "label.loop/v1",
                "label.reasoning-planning/v1",
                "label.retrieval-grounding/v1",
                "label.tool-web/v1",
            ],
            "availableCaseCount": 30,
        },
        {
            "datasetId": "dataset.personamem-32k/v1",
            "name": "PersonaMem 32K",
            "description": (
                "数据集: PersonaMem v1 32K\n最突出的测试对象: 超长个性化对话中的事实、偏好、偏好演化和推荐一致性\n"
                "当前输入形态: 30 个逐题 Question Bundle；按 7 种 question_type 分层抽样，对话记忆与候选项位于每题 assets/\n"
                "输出与评分: output/answer.txt；正确选项位于 private/final.json，由 EvalDock 标签 Judge 评分\n"
                "最适合的 Agent: 个人助理、长期记忆 Agent、个性化推荐 Agent\n"
                "关键局限: 当前运行器会按题重复传入记忆，不能体现一次建库多次查询的成本；标签 Judge 不是官方选择题 evaluator。\n\n"
                "运行时不需要联网，必须只根据 input/memory.json 和 input/options.json 回答。当前子集保留原始 UUID、persona、题型、主题、上下文长度和距离元数据。"
            ),
            "labelIds": [
                "label.artifact-delivery/v1",
                "label.efficiency-reliability/v1",
                "label.memory/v1",
                "label.reasoning-planning/v1",
                "label.retrieval-grounding/v1",
            ],
            "availableCaseCount": 30,
        },
        {
            "datasetId": "dataset.deepresearch-bench/v1",
            "name": "DeepResearch Bench",
            "description": (
                "数据集: DeepResearch Bench\n最突出的测试对象: 端到端深度研究、长报告综合、引用质量和洞察\n"
                "当前输入形态: 10 个逐题 Question Bundle；中英文各 5 题，成对覆盖 Finance、Health、Education、Art、Science & Technology\n"
                "输出与评分: output/report.md；官方四维 per-case rubric 位于 private/final.json，由 EvalDock 标签 Judge 检查产物与过程\n"
                "最适合的 Agent: Deep Research Agent、行业研究 Agent、网页调研与报告生成 Agent\n"
                "关键局限: 本地版未接入官方 RACE/FACT evaluator 和 reference report，因此分数不可与官方榜单直接比较。\n\n"
                "正式运行应允许网页访问并保存报告、来源 URL、检索轨迹与文件证据。当前 10 题用于先验证运行成本、上下文和 Judge 稳定性。"
            ),
            "labelIds": [
                "label.artifact-delivery/v1",
                "label.efficiency-reliability/v1",
                "label.loop/v1",
                "label.reasoning-planning/v1",
                "label.retrieval-grounding/v1",
                "label.tool-web/v1",
            ],
            "availableCaseCount": 10,
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
            replacement = dict(replacements[dataset_id])
            # catalog.md 中的长篇说明由人工维护；重新导入数据时只刷新结构化字段，避免退回简版文案。
            if "description" in entry:
                replacement["description"] = entry["description"]
            updated.append(replacement)
            seen.add(dataset_id)
        else:
            updated.append(entry)
    updated.extend(entry for entry in replacements.values() if entry["datasetId"] not in seen)
    catalog["datasets"] = updated
    payload = json.dumps(catalog, ensure_ascii=False, indent=2)
    path.write_text(source[:match.start(1)] + payload + source[match.end(1):], encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_root", type=Path, help="directory containing the downloaded upstream snapshots")
    parser.add_argument("repo_root", type=Path, nargs="?", default=Path.cwd())
    args = parser.parse_args()

    builders = {
        "deepsearchqa": ("dataset.deepsearchqa/v1", build_deepsearchqa),
        "browsecomp-zh": ("dataset.browsecomp-zh/v1", build_browsecomp_zh),
        "personamem-32k": ("dataset.personamem-32k/v1", build_personamem),
        "deepresearch-bench": ("dataset.deepresearch-bench/v1", build_deepresearch_bench),
    }
    datasets_root = args.repo_root.resolve() / "datasets"
    for slug, (dataset_id, builder) in builders.items():
        rows = builder(args.source_root.resolve())
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
