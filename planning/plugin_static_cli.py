#!/usr/bin/env python3
"""README-only DSH + plugins static capability snapshot CLI.

This is intentionally a discovery prototype.  It consumes the public dsh-top100
JSON index, resolves one or more user supplied names, reads the selected
repository README, and emits one combined DSH + plugins capability *claim*
snapshot.

README-derived capabilities are marked CLAIMED_README_ONLY.  They are not proof
that a plugin is installed, loaded, executable, or observable by EvalDock.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


DEFAULT_CATALOG_URL = "https://www.dsheval.ai/data/rankings-search.json"
GITHUB_HOSTS = {"github.com", "www.github.com"}


class CliError(RuntimeError):
    """A user-facing CLI error."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def read_url(url: str, timeout: float, accept: str = "*/*") -> bytes:
    request = Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "evaldock-plugin-static-cli/0.1",
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - allowlisted sources below
            return response.read()
    except (HTTPError, URLError, TimeoutError) as error:
        raise CliError(f"读取 URL 失败: {url} ({error})") from error


def load_json(source: str, timeout: float) -> tuple[Any, str]:
    path = Path(source)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8")), str(path.resolve())
        except (OSError, json.JSONDecodeError) as error:
            raise CliError(f"无法读取 JSON 文件: {source} ({error})") from error
    if not source.startswith(("https://", "http://")):
        raise CliError(f"目录文件不存在，且不是 URL: {source}")
    raw = read_url(source, timeout, "application/json")
    try:
        return json.loads(raw.decode("utf-8")), source
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CliError(f"目录不是有效 JSON: {source} ({error})") from error


def normalize_name(value: str) -> str:
    value = value.strip().lower().lstrip("@")
    return re.sub(r"[^a-z0-9]+", "", value)


def first_string(record: dict[str, Any], keys: Iterable[str]) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def github_url_from(value: str | None) -> str | None:
    if value is None:
        return None
    match = re.search(r"https?://(?:www\.)?github\.com/([^/]+/[^/#?]+)", value, re.I)
    if match is None:
        return None
    owner_repo = match.group(1).rstrip("/")
    if owner_repo.endswith(".git"):
        owner_repo = owner_repo[:-4]
    return f"https://github.com/{owner_repo}"


def github_repo(value: str | None) -> tuple[str, str] | None:
    url = github_url_from(value)
    if url is None:
        return None
    parts = urlparse(url).path.strip("/").split("/")
    if len(parts) != 2:
        return None
    return parts[0], parts[1]


def number_value(record: dict[str, Any], keys: Iterable[str]) -> float | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            match = re.search(r"-?\d+(?:\.\d+)?", value)
            if match:
                try:
                    return float(match.group(0))
                except ValueError:
                    pass
    return None


def iter_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_dicts(child)


def catalog_candidates(payload: Any) -> list[dict[str, Any]]:
    """Extract repository records from rankings-search or compatible JSON."""
    output: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for index, record in enumerate(iter_dicts(payload), start=1):
        repo_url = github_url_from(first_string(record, (
            "githubUrl", "github_url", "repositoryUrl", "repository_url",
            "repoUrl", "repo_url", "htmlUrl", "html_url", "url", "repository",
        )))
        if repo_url is None:
            owner = first_string(record, ("owner", "ownerLogin", "owner_login"))
            repo = first_string(record, ("repo", "repoName", "repo_name"))
            if owner and repo:
                repo_url = f"https://github.com/{owner}/{repo.removesuffix('.git')}"
        if repo_url is None:
            full_name = first_string(record, ("fullName", "full_name"))
            if full_name and re.fullmatch(r"[^/\s]+/[^/\s]+", full_name):
                repo_url = f"https://github.com/{full_name.removesuffix('.git')}"
        if repo_url is None:
            continue
        name = first_string(record, (
            "pluginName", "plugin_name", "name", "title", "repoName", "repo_name",
            "fullName", "full_name", "slug", "id",
        )) or repo_url.rstrip("/").split("/")[-1]
        repo_key = github_repo(repo_url)
        if repo_key is None or repo_key in seen:
            continue
        seen.add(repo_key)
        rank = number_value(record, ("rank", "position", "ranking", "order"))
        score = number_value(record, ("score", "topScore", "top_score", "stars"))
        output.append({
            "name": name,
            "repo_url": repo_url,
            "rank": rank if rank is not None else float(index),
            "score": score if score is not None else 0.0,
            "raw": record,
        })
    return output


def aliases(candidate: dict[str, Any]) -> set[str]:
    raw = candidate["raw"]
    values = [candidate["name"], candidate["repo_url"]]
    for key in ("pluginName", "plugin_name", "name", "title", "repoName", "repo_name", "fullName", "full_name", "slug", "id"):
        if isinstance(raw.get(key), str):
            values.append(raw[key])
    repo = github_repo(candidate["repo_url"])
    if repo:
        values.extend((repo[0], repo[1], f"{repo[0]}/{repo[1]}"))
    return {normalize_name(value) for value in values if value}


def resolve_plugin(query: str, candidates: list[dict[str, Any]]) -> dict[str, Any]:
    normalized = normalize_name(query)
    if not normalized:
        raise CliError("插件名称不能为空")
    exact = [item for item in candidates if normalized in aliases(item)]
    matches = exact or [
        item for item in candidates
        if any(normalized in alias or alias in normalized for alias in aliases(item) if alias)
    ]
    if not matches:
        raise CliError(f"目录中未找到插件: {query}")
    # 网站排名越靠前，数字越小。缺失排名时使用目录顺序。
    selected = min(matches, key=lambda item: (item["rank"], -item["score"], item["repo_url"]))
    return {**selected, "requested_name": query, "match_count": len(matches)}


def readme_url(candidate: dict[str, Any]) -> str | None:
    raw = candidate["raw"]
    explicit = first_string(raw, ("readmeUrl", "readme_url", "readme", "readmeURL"))
    if explicit and explicit.startswith("http"):
        return explicit
    repo = github_repo(candidate["repo_url"])
    if repo is None:
        return None
    owner, name = repo
    return f"https://api.github.com/repos/{owner}/{name}/readme"


def fetch_readme(candidate: dict[str, Any], timeout: float) -> tuple[str, str]:
    repo = github_repo(candidate["repo_url"])
    if repo is None:
        raise CliError(f"不是 GitHub 仓库 URL: {candidate['repo_url']}")
    api_url = readme_url(candidate)
    if api_url:
        try:
            raw = read_url(api_url, timeout, "application/vnd.github.raw+json")
            # GitHub may return raw Markdown or a JSON content envelope.
            try:
                envelope = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                envelope = None
            if isinstance(envelope, dict) and isinstance(envelope.get("content"), str):
                content = base64.b64decode(envelope["content"]).decode("utf-8", errors="replace")
            else:
                content = raw.decode("utf-8", errors="replace")
            return content, api_url
        except CliError:
            pass
    owner, name = repo
    for branch in ("main", "master"):
        url = f"https://raw.githubusercontent.com/{owner}/{name}/{branch}/README.md"
        try:
            return read_url(url, timeout, "text/plain").decode("utf-8", errors="replace"), url
        except CliError:
            continue
    raise CliError(f"无法读取 GitHub README: {candidate['repo_url']}")


CAPABILITY_RULES: dict[str, tuple[str, ...]] = {
    "long_term_memory": ("long-term memory", "cross-session", "persistent memory", "memory.search", "memory.write", "knowledge graph"),
    "code_execution": ("code execution", "python", "terminal", "shell command", "run code", "sql"),
    "web_navigation": ("browser", "web automation", "web navigation", "playwright", "web page"),
    "retrieval_grounding": ("retrieval", "search", "knowledge base", "rag", "citation", "document search"),
    "document_understanding": ("pdf", "document", "ocr", "docx", "spreadsheet", "table extraction"),
    "tool_orchestration": ("tool", "api", "mcp", "function calling", "workflow", "orchestration"),
    "multimodal": ("image", "vision", "screenshot", "audio", "video", "multimodal"),
    "safety": ("safety", "permission", "sandbox", "prompt injection", "security"),
}


def readme_evidence(readme: str, terms: tuple[str, ...]) -> list[str]:
    lines = [line.strip() for line in readme.splitlines() if line.strip()]
    evidence: list[str] = []
    for line in lines:
        if any(term.lower() in line.lower() for term in terms):
            evidence.append(line[:300])
        if len(evidence) >= 3:
            break
    return evidence


def infer_from_readme(readme: str) -> dict[str, Any]:
    capabilities: list[dict[str, Any]] = []
    for capability, terms in CAPABILITY_RULES.items():
        evidence = readme_evidence(readme, terms)
        if evidence:
            capabilities.append({
                "id": capability,
                "status": "CLAIMED_README_ONLY",
                "evidence": evidence,
                "matched_terms": [term for term in terms if term.lower() in readme.lower()],
            })

    tools = sorted(set(re.findall(
        r"(?<![A-Za-z0-9])(?:dsh_[A-Za-z0-9_-]+|[a-z][A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+)(?![A-Za-z0-9])",
        readme,
    )))
    permissions: list[str] = []
    permission_terms = {
        "network": ("network", "http", "api key", "web access"),
        "filesystem": ("file", "filesystem", "workspace", "write file"),
        "process": ("subprocess", "shell", "command", "terminal"),
        "browser": ("browser", "playwright", "chromium"),
        "credentials": ("api key", "token", "credential", "environment variable"),
    }
    for permission, terms in permission_terms.items():
        if any(term in readme.lower() for term in terms):
            permissions.append(permission)

    limitation_lines = [
        line.strip()[:300]
        for line in readme.splitlines()
        if re.search(r"\b(limitations?|known issues?|requirements?|requires|does not support|not supported)\b", line, re.I)
    ][:5]
    return {
        "claimed_capabilities": capabilities,
        "mentioned_tools": tools[:30],
        "mentioned_permissions": sorted(permissions),
        "readme_limitations": limitation_lines,
    }


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_dsh_static(path: str | None) -> dict[str, Any]:
    if path is None:
        return {
            "status": "UNKNOWN",
            "source": "NOT_PROVIDED",
            "reason": "本 CLI 只读取插件 README，未提供本地 DSH InspectionSnapshot",
        }
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CliError(f"无法读取 --dsh-static: {path} ({error})") from error
    if not isinstance(value, dict):
        raise CliError("--dsh-static 必须是 JSON 对象")
    return {"status": "PROVIDED", "source": str(Path(path).resolve()), "snapshot": value}


def build_snapshot(
    requested: list[str],
    catalog_source: str,
    payload: Any,
    timeout: float,
    dsh_static_path: str | None,
) -> tuple[dict[str, Any], list[str]]:
    candidates = catalog_candidates(payload)
    if not candidates:
        raise CliError("插件目录中没有可识别的 GitHub 仓库记录")

    plugins: list[dict[str, Any]] = []
    errors: list[str] = []
    combined: dict[str, dict[str, Any]] = {}
    for query in requested:
        try:
            candidate = resolve_plugin(query, candidates)
            readme, source_url = fetch_readme(candidate, timeout)
            inferred = infer_from_readme(readme)
            plugin = {
                "requested_name": query,
                "resolved_name": candidate["name"],
                "repository_url": candidate["repo_url"],
                "catalog_rank": candidate["rank"],
                "catalog_match_count": candidate["match_count"],
                "readme_source": source_url,
                "readme_sha256": sha256_text(readme),
                "status": "README_ONLY",
                **inferred,
                "limitations": [
                    "README 只代表项目声明，未验证插件是否安装或加载",
                    "未读取插件源码、Manifest、Tool Registry 或运行时 Trace",
                ],
            }
            plugins.append(plugin)
            for capability in inferred["claimed_capabilities"]:
                entry = combined.setdefault(capability["id"], {
                    "id": capability["id"],
                    "status": "CLAIMED_README_ONLY",
                    "plugins": [],
                    "evidence": [],
                })
                entry["plugins"].append(candidate["name"])
                entry["evidence"].extend(capability["evidence"])
        except CliError as error:
            errors.append(f"{query}: {error}")
            plugins.append({
                "requested_name": query,
                "status": "UNRESOLVED",
                "error": str(error),
            })

    snapshot = {
        "schema": "evaldock.dsh-agent-static-snapshot/v1",
        "generated_at": utc_now(),
        "mode": "README_ONLY",
        "catalog": {
            "source": catalog_source,
            "record_count": len(candidates),
            "ranking_rule": "smaller numeric rank is higher",
        },
        "dsh": load_dsh_static(dsh_static_path),
        "plugins": plugins,
        "effective_capabilities": [
            {**value, "plugins": sorted(set(value["plugins"])), "evidence": value["evidence"][:6]}
            for value in sorted(combined.values(), key=lambda item: item["id"])
        ],
        "limitations": [
            "本快照只读取 evaldock.ai 目录和 GitHub README",
            "README 推断结果不能证明能力已安装、已加载、可执行或可观测",
            "DSh 核心静态能力只有在 --dsh-static 提供时才会合并",
        ],
    }
    if errors:
        snapshot["errors"] = errors
    return snapshot, errors


def parse_plugin_names(args: argparse.Namespace) -> list[str]:
    values = list(args.plugin or [])
    if not values:
        raw = input("请输入插件名称（多个名称用逗号分隔）：").strip()
        values = [part.strip() for part in re.split(r"[,，;；]", raw) if part.strip()]
    if not values:
        raise CliError("至少输入一个插件名称")
    return values


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="读取插件 GitHub README，生成 README-only DSH + 插件静态能力快照")
    parser.add_argument("--plugin", action="append", help="插件名称；可重复指定")
    parser.add_argument("--catalog-url", default=DEFAULT_CATALOG_URL, help=f"插件目录 JSON URL（默认：{DEFAULT_CATALOG_URL}）")
    parser.add_argument("--catalog-file", help="本地插件目录 JSON；指定后优先于 --catalog-url")
    parser.add_argument("--dsh-static", help="可选：已有的本地 DSH 静态快照 JSON")
    parser.add_argument("--output", help="输出 JSON 文件；不指定则输出到 stdout")
    parser.add_argument("--timeout", type=float, default=20.0, help="单次网络读取超时秒数（默认 20）")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.timeout <= 0:
            raise CliError("--timeout 必须大于 0")
        requested = parse_plugin_names(args)
        catalog_source = args.catalog_file or args.catalog_url
        payload, resolved_source = load_json(catalog_source, args.timeout)
        snapshot, errors = build_snapshot(
            requested,
            resolved_source,
            payload,
            args.timeout,
            args.dsh_static,
        )
        rendered = json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            Path(args.output).write_text(rendered, encoding="utf-8")
            print(f"静态能力快照已写入: {Path(args.output).resolve()}")
        else:
            print(rendered, end="")
        if errors:
            print("部分插件未能解析，详情见输出 JSON 的 errors。", file=sys.stderr)
            return 2
        return 0
    except CliError as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
