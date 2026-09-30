#!/usr/bin/env python3
"""Select evaluation datasets for a DSH + plugins static snapshot.

The CLI renders planning/prompts/standard.json, calls an OpenAI-compatible
DeepSeek endpoint once, and validates the returned Dataset allocation locally.
It deliberately does not execute a Dataset or infer Labels from the model.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from .plugin_static_cli import (
        DEFAULT_CATALOG_URL,
        CliError,
        build_snapshot as build_agent_snapshot,
        load_json,
        parse_plugin_names,
    )
except ImportError:  # direct execution: python planning/dataset_selection_cli.py
    from plugin_static_cli import (
        DEFAULT_CATALOG_URL,
        CliError,
        build_snapshot as build_agent_snapshot,
        load_json,
        parse_plugin_names,
    )


POLICIES: dict[str, dict[str, int]] = {
    "QUICK": {
        "min_datasets": 1,
        "max_datasets": 6,
        "min_cases_per_dataset": 1,
        "max_cases_per_dataset": 3,
        "max_total_cases": 12,
    },
    "STANDARD": {
        "min_datasets": 1,
        "max_datasets": 8,
        "min_cases_per_dataset": 1,
        "max_cases_per_dataset": 10,
        "max_total_cases": 60,
    },
    "DEEP": {
        "min_datasets": 1,
        "max_datasets": 12,
        "min_cases_per_dataset": 1,
        "max_cases_per_dataset": 30,
        "max_total_cases": 240,
    },
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def load_catalog(path: str) -> tuple[dict[str, Any], str]:
    file_path = Path(path)
    try:
        source = file_path.read_text(encoding="utf-8")
    except OSError as error:
        raise CliError(f"无法读取 Dataset Catalog: {path} ({error})") from error
    if file_path.suffix.lower() == ".md":
        match = re.search(r"```json\s+evaldock-dataset-catalog\s*\n([\s\S]*?)\n```", source)
        if match is None:
            raise CliError("Dataset Markdown 缺少 evaldock-dataset-catalog JSON 区块")
        source = match.group(1)
    try:
        payload = json.loads(source)
    except json.JSONDecodeError as error:
        raise CliError(f"Dataset Catalog 不是有效 JSON: {path} ({error})") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("datasets"), list):
        raise CliError("Dataset Catalog 必须包含 datasets 数组")
    return payload, str(file_path.resolve())


def dataset_candidates(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for index, item in enumerate(catalog["datasets"]):
        if not isinstance(item, dict):
            raise CliError(f"datasets[{index}] 必须是对象")
        required = ("datasetId", "name", "description", "labelIds", "availableCaseCount")
        missing = [field for field in required if field not in item]
        if missing:
            raise CliError(f"datasets[{index}] 缺少字段: {', '.join(missing)}")
        unknown = sorted(set(item) - set(required))
        if unknown:
            raise CliError(f"datasets[{index}] 不支持字段: {', '.join(unknown)}")
        if not isinstance(item["labelIds"], list) or not item["labelIds"]:
            raise CliError(f"datasets[{index}].labelIds 必须是非空数组")
        if not isinstance(item["availableCaseCount"], int) or item["availableCaseCount"] < 1:
            raise CliError(f"datasets[{index}].availableCaseCount 必须是正整数")
        output.append({
            "dataset_id": item["datasetId"],
            "name": item["name"],
            "description": item["description"],
            "label_ids": sorted(str(value) for value in item["labelIds"]),
            "available_case_count": item["availableCaseCount"],
        })
    return output


def load_snapshot(path: str) -> dict[str, Any]:
    try:
        snapshot = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"无法读取静态快照: {path} ({error})") from error
    if not isinstance(snapshot, dict):
        raise CliError("静态快照必须是 JSON 对象")
    return snapshot


def acquire_snapshot(args: argparse.Namespace) -> tuple[dict[str, Any], str]:
    """Load a frozen snapshot or build one by reusing plugin_static_cli."""
    if args.static_snapshot:
        if args.plugin:
            raise CliError("--static-snapshot 与 --plugin 不能同时使用")
        return load_snapshot(args.static_snapshot), str(Path(args.static_snapshot).resolve())

    requested = parse_plugin_names(args)
    plugin_catalog_source = args.plugin_catalog_file or args.plugin_catalog_url
    payload, resolved_source = load_json(plugin_catalog_source, args.timeout)
    snapshot, errors = build_agent_snapshot(
        requested,
        resolved_source,
        payload,
        args.timeout,
        args.dsh_static,
    )
    if errors:
        raise CliError("插件静态快照不完整: " + "; ".join(errors))
    if args.snapshot_output:
        output = Path(args.snapshot_output)
        output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        source = str(output.resolve())
    else:
        source = f"generated:{resolved_source}"
    return snapshot, source


def render_prompt(
    template_path: str,
    profile: str,
    policy: dict[str, int],
    snapshot: dict[str, Any],
    candidates: list[dict[str, Any]],
    capability_ledger: dict[str, Any] | None = None,
    eligibility_index: dict[str, Any] | None = None,
) -> str:
    try:
        template = Path(template_path).read_text(encoding="utf-8")
    except OSError as error:
        raise CliError(f"无法读取 Planner Prompt: {template_path} ({error})") from error
    replacements = {
        "{{TEST_PROFILE}}": profile,
        "{{POLICY_JSON}}": json.dumps(policy, ensure_ascii=False, indent=2),
        "{{AGENT_STATIC_SNAPSHOT_JSON}}": json.dumps(snapshot, ensure_ascii=False, indent=2),
        "{{AVAILABLE_DATASETS_JSON}}": json.dumps(candidates, ensure_ascii=False, indent=2),
        "{{CAPABILITY_LEDGER_JSON}}": json.dumps(capability_ledger or {}, ensure_ascii=False, indent=2),
        "{{ELIGIBILITY_INDEX_JSON}}": json.dumps(eligibility_index or {}, ensure_ascii=False, indent=2),
    }
    placeholders = re.findall(r"\{\{[A-Z0-9_]+\}\}", template)
    expected = set(placeholders)
    if not expected.issubset(replacements) or any(placeholders.count(key) != 1 for key in expected):
        raise CliError("Planner Prompt 的占位符必须各出现一次，且不能有未知占位符")
    for key, value in replacements.items():
        template = template.replace(key, value)
    return template


def call_planner(endpoint: str, api_key: str, model: str, prompt: str, timeout: float, max_output_tokens: int) -> dict[str, Any]:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": max_output_tokens,
        "response_format": {"type": "json_object"},
    }, ensure_ascii=False).encode("utf-8")
    request = Request(endpoint, data=body, method="POST", headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "evaldock-dataset-selection-cli/0.1",
    })
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - configured OpenAI-compatible endpoint
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise CliError(f"Planner 请求失败: HTTP {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise CliError(f"Planner 请求或响应解析失败: {error}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("choices"), list) or not payload["choices"]:
        raise CliError("Planner 响应缺少 choices")
    choice = payload["choices"][0]
    if not isinstance(choice, dict) or not isinstance(choice.get("message"), dict):
        raise CliError("Planner 响应缺少 choices[0].message")
    content = choice["message"].get("content")
    if not isinstance(content, str):
        raise CliError("Planner message.content 必须是字符串")
    content = content.strip()
    if not content:
        finish_reason = choice.get("finish_reason", "unknown")
        raise CliError(
            f"Planner 没有返回可解析内容（finish_reason={finish_reason}）；"
            "请增大 --max-output-tokens 或缩短 Catalog 描述"
        )
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.I | re.S).strip()
    try:
        result = json.loads(content)
    except json.JSONDecodeError as error:
        raise CliError(f"Planner 返回的内容不是有效 JSON: {error}") from error
    if not isinstance(result, dict):
        raise CliError("Planner 返回结果必须是 JSON 对象")
    return result


def validate_selection(result: dict[str, Any], candidates: list[dict[str, Any]], policy: dict[str, int]) -> tuple[list[dict[str, Any]], list[str], int]:
    if set(result) != {"selected_datasets"} or not isinstance(result.get("selected_datasets"), list):
        raise CliError("Planner 只能返回 selected_datasets 字段")
    selected = result["selected_datasets"]
    max_datasets = min(policy["max_datasets"], len(candidates))
    if not policy["min_datasets"] <= len(selected) <= max_datasets:
        raise CliError("Planner 返回的 Dataset 数量不符合 profile policy")
    by_id = {str(item["dataset_id"]): item for item in candidates}
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    labels: set[str] = set()
    total = 0
    for index, item in enumerate(selected):
        allowed_fields = {
            "dataset_id", "case_count", "reason", "match_type",
            "target_capabilities", "evidence", "marginal_value",
        }
        required_fields = {"dataset_id", "case_count", "reason"}
        if not isinstance(item, dict) or not required_fields.issubset(item) or not set(item).issubset(allowed_fields):
            raise CliError(f"selected_datasets[{index}] 字段不符合要求")
        dataset_id = item["dataset_id"]
        if not isinstance(dataset_id, str) or dataset_id in seen or dataset_id not in by_id:
            raise CliError(f"selected_datasets[{index}] 的 dataset_id 无效或重复")
        case_count = item["case_count"]
        if not isinstance(case_count, int) or isinstance(case_count, bool):
            raise CliError(f"selected_datasets[{index}].case_count 必须是整数")
        candidate = by_id[dataset_id]
        if not policy["min_cases_per_dataset"] <= case_count <= policy["max_cases_per_dataset"]:
            raise CliError(f"{dataset_id} 的 case_count 超出 profile policy")
        if case_count > candidate["available_case_count"]:
            raise CliError(f"{dataset_id} 的 case_count 超过 available_case_count")
        reason = item["reason"]
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
            raise CliError(f"{dataset_id} 的 reason 必须是 1-500 字符")
        match_type = item.get("match_type")
        if match_type is not None and match_type not in {"DIRECT", "PROXY", "BASELINE"}:
            raise CliError(f"{dataset_id} 的 match_type 必须是 DIRECT、PROXY 或 BASELINE")
        target_capabilities = item.get("target_capabilities", [])
        if not isinstance(target_capabilities, list) or any(not isinstance(value, str) or not value.strip() for value in target_capabilities):
            raise CliError(f"{dataset_id} 的 target_capabilities 必须是字符串数组")
        evidence = item.get("evidence", [])
        if not isinstance(evidence, list) or any(not isinstance(value, str) or not value.strip() for value in evidence):
            raise CliError(f"{dataset_id} 的 evidence 必须是字符串数组")
        marginal_value = item.get("marginal_value", "")
        if not isinstance(marginal_value, str) or len(marginal_value) > 500:
            raise CliError(f"{dataset_id} 的 marginal_value 必须是 0-500 字符")
        seen.add(dataset_id)
        labels.update(candidate["label_ids"])
        total += case_count
        normalized = {
            "dataset_id": dataset_id,
            "evaluation_label_ids": candidate["label_ids"],
            "case_count": case_count,
            "reason": reason.strip(),
        }
        # Keep optional benchmark evidence so it can be scored without
        # scraping free-form reasons. Legacy three-field responses remain valid.
        if match_type is not None:
            normalized["match_type"] = match_type
        if target_capabilities:
            normalized["target_capabilities"] = list(dict.fromkeys(target_capabilities))
        if evidence:
            normalized["evidence"] = evidence
        if marginal_value:
            normalized["marginal_value"] = marginal_value.strip()
        output.append(normalized)
    if total > policy["max_total_cases"]:
        raise CliError("Planner 返回的总题量超过 profile policy")
    return output, sorted(labels), total


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="调用 DeepSeek Planner 输出 DSH + 插件组合的 Dataset 选择计划")
    parser.add_argument("--plugin", action="append", help="插件名称；可重复指定。不提供静态快照时直接调用 plugin_static_cli 能力")
    parser.add_argument("--plugin-catalog-url", default=DEFAULT_CATALOG_URL, help="EvalDock 插件目录 JSON URL")
    parser.add_argument("--plugin-catalog-file", help="可选：离线插件目录 JSON")
    parser.add_argument("--dsh-static", help="可选：已有的本地 DSH 静态能力 JSON，生成组合快照时合并")
    parser.add_argument("--static-snapshot", help="可选：读取已有 DSH + 插件静态快照，跳过 README 获取")
    parser.add_argument("--capability-ledger", help="可选：预计算 capability ledger JSON，供 v3 Prompt 使用")
    parser.add_argument("--eligibility-index", help="可选：预计算 Dataset eligibility index JSON，供 v3 Prompt 使用")
    parser.add_argument("--snapshot-output", help="可选：保存本次生成的 DSH + 插件组合静态快照")
    parser.add_argument("--catalog", default="evaldock/datasets/catalog.md", help="Dataset Catalog Markdown/JSON 路径")
    parser.add_argument("--prompt", default="planning/prompts/standard.json", help="Planner Prompt 模板")
    parser.add_argument("--profile", choices=sorted(POLICIES), default="STANDARD")
    parser.add_argument("--model", default=os.environ.get("EVALDOCK_PLANNER_MODEL", "deepseek-v4-pro"))
    parser.add_argument("--endpoint", default=os.environ.get("EVALDOCK_PLANNER_MODEL_ENDPOINT", "https://api.deepseek.com/chat/completions"))
    parser.add_argument("--api-key", default=os.environ.get("EVALDOCK_PLANNER_API_KEY") or os.environ.get("DEEPSEEK_API_KEY"))
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--max-output-tokens", type=int, default=16384, help="Planner 最大输出 token 数（默认 16384，含推理模型预算）")
    parser.add_argument("--output", help="输出计划 JSON 文件；不指定则输出到 stdout")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if not args.api_key:
            raise CliError("请设置 --api-key、EVALDOCK_PLANNER_API_KEY 或 DEEPSEEK_API_KEY")
        if args.timeout <= 0:
            raise CliError("--timeout 必须大于 0")
        if args.max_output_tokens < 512:
            raise CliError("--max-output-tokens 不能小于 512")
        snapshot, snapshot_source = acquire_snapshot(args)
        catalog, catalog_source = load_catalog(args.catalog)
        candidates = dataset_candidates(catalog)
        policy = {"profile": args.profile, **POLICIES[args.profile]}
        capability_ledger = load_json(args.capability_ledger) if args.capability_ledger else None
        eligibility_index = load_json(args.eligibility_index) if args.eligibility_index else None
        prompt = render_prompt(args.prompt, args.profile, policy, snapshot, candidates, capability_ledger, eligibility_index)
        model_result = call_planner(args.endpoint, args.api_key, args.model, prompt, args.timeout, args.max_output_tokens)
        selected, labels, total = validate_selection(model_result, candidates, POLICIES[args.profile])
        dsh_snapshot = snapshot.get("dsh")
        dsh_unknown = isinstance(dsh_snapshot, dict) and dsh_snapshot.get("status") == "UNKNOWN"
        provisional = snapshot.get("mode") == "README_ONLY" or dsh_unknown
        plan = {
            "schema": "evaldock.mvp.unified-planner-result/v1",
            "status": "PROVISIONAL" if provisional else "READY_FOR_PLAN_COMPILATION",
            "profile": args.profile,
            "model": args.model,
            "generated_at": utc_now(),
            "catalog_source": catalog_source,
            "static_snapshot_source": snapshot_source,
            "selected_datasets": selected,
            "evaluation_label_ids": labels,
            "total_case_count": total,
        }
        rendered = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            Path(args.output).write_text(rendered, encoding="utf-8")
            print(f"Dataset 选择计划已写入: {Path(args.output).resolve()}")
        else:
            print(rendered, end="")
        return 0
    except CliError as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
