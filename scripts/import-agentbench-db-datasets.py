#!/usr/bin/env python3
"""Import a verified, portable SELECT subset of original AgentBench v0.2.

Only Python's standard library is required. Upstream bytes are pinned and hashed;
the importer never silently overwrites a changed question or fabricates labels.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import urllib.request
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path

from compact_dataset_bundles import compact_bundle


REPOSITORY = "https://github.com/THUDM/AgentBench"
COMMIT = "ed013ff9887b0c3d7864c56ae54d41eba54a99d8"
SOURCE_HASHES = {
    "data/dbbench/standard.jsonl": "d1ac4d67ec39fad083c38944972e392ff100257c755361ee63eaef608ddafcb3",
    "src/server/tasks/dbbench/__init__.py": "8b7b78cc7e5ae04897110083da3be1e17e5cb4b61b9caf14200fad27936df4e8",
    "src/server/tasks/dbbench/Interaction.py": "8cabfeb2f1afa856f036b76059ba4fe47503198d14dbf10775daeb0822f7ab3c",
    "LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
}
# One-based physical line numbers. Selected by question/table/label agreement,
# plus direct execution of unmodified upstream SQL in the documented adapter.
SELECTED_LINES = (1, 8, 13, 17, 27, 31, 34, 42, 51, 60, 61, 69, 74, 77, 81, 96)
LABELS = ["tool-data", "reasoning-planning", "artifact-delivery"]


DB_TOOL = '''#!/usr/bin/env python3
"""Execute read-only SQLite queries over the complete supplied benchmark table."""
import argparse
import json
import sqlite3
from pathlib import Path


def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--schema", action="store_true")
    group.add_argument("--sql")
    group.add_argument("--sql-file", type=Path)
    args = parser.parse_args()
    table = json.loads(Path(__file__).with_name("table.json").read_text(encoding="utf-8"))
    columns = table["table_info"]["columns"]
    rows = table["table_info"]["rows"]
    if args.schema:
        print(json.dumps({"table": table["table_name"], "columns": [
            {"name": col["name"], "sqlite_type": "TEXT", "collation": "NOCASE",
             "upstream_metadata_type": col["type"]} for col in columns
        ], "row_count": len(rows)}, ensure_ascii=False, indent=2))
        return
    query = args.sql if args.sql is not None else args.sql_file.read_text(encoding="utf-8")
    with sqlite3.connect(":memory:") as connection:
        table_name = quote_identifier(table["table_name"])
        definitions = ", ".join(quote_identifier(col["name"]) + " TEXT COLLATE NOCASE" for col in columns)
        connection.execute("CREATE TABLE " + table_name + " (" + definitions + ")")
        connection.executemany("INSERT INTO " + table_name + " VALUES (" + ",".join("?" for _ in columns) + ")", rows)
        connection.commit()
        connection.execute("PRAGMA query_only=ON")
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}
        if hasattr(sqlite3, "SQLITE_RECURSIVE"):
            allowed.add(sqlite3.SQLITE_RECURSIVE)

        def authorize(action, arg1, arg2, database, origin):
            if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() == "load_extension":
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY

        steps = [0]

        def stop_expensive_query():
            steps[0] += 1
            return int(steps[0] > 1000)

        connection.set_authorizer(authorize)
        connection.set_progress_handler(stop_expensive_query, 1000)
        cursor = connection.execute(query)
        result = cursor.fetchmany(1001)
        if len(result) > 1000:
            raise ValueError("Query produced more than 1000 rows; refine the query.")
        print(json.dumps({"columns": [col[0] for col in cursor.description], "rows": result}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
'''

PUBLIC_README = """# Local database task

The complete table is in `input/table.json`. `input/db_tool.py` builds an in-memory
SQLite database from it on every invocation and executes one read-only statement.
It uses Python 3.9+ and its standard-library sqlite3 module; no service, network,
database installation, or credentials are needed.

```sh
python3 input/db_tool.py --schema
python3 input/db_tool.py --sql 'SELECT COUNT(*) FROM "your table name";'
mkdir -p output
# Write your own SQL to output/query.sql, then execute it:
python3 input/db_tool.py --sql-file output/query.sql > output/query-result.json
```

Use the supplied table to answer the question. Preserve every supplied record.
The benchmark's original initializer creates every column as TEXT, regardless of
its metadata type; this adapter also uses TEXT, with SQLite NOCASE collation.
For numerical comparisons or sorting, inspect the values and use explicit CAST
where needed. Quoted identifiers preserve spaces and punctuation. SQLite syntax
is required; this helper does not emulate every MySQL feature or collation.

Put the answer values in `output/answer.txt` as a JSON array, e.g. `["value"]`.
Also deliver the SQL you actually executed in `output/query.sql` and its actual
JSON response in `output/query-result.json`. Do not edit the input files. You may
inspect the schema, execute diagnostic queries, and revise a query after an error.

This is a local adaptation of the original AgentBench v0.2 DBBench SELECT tasks.
It retains the task's full table; it is not the full MySQL/Docker environment.
It does not claim equivalence to the original AgentBench leaderboard metric.
The supplied table contents are benchmark fixtures, not verified real-world facts.
"""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def fetch_sources(cache: Path) -> dict[str, bytes]:
    result = {}
    for relative, expected in SOURCE_HASHES.items():
        target = cache / relative
        if not target.exists():
            url = f"https://raw.githubusercontent.com/THUDM/AgentBench/{COMMIT}/{relative}"
            with urllib.request.urlopen(url, timeout=90) as response:
                content = response.read()
            if digest(content) != expected:
                raise ValueError(f"Downloaded source hash mismatch: {relative}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        content = target.read_bytes()
        if digest(content) != expected:
            raise ValueError(f"Cached source hash mismatch: {relative}")
        result[relative] = content
    return result


def normalized(values: list[object]) -> set[tuple[str, object]]:
    result = set()
    for value in values:
        try:
            number = Decimal(str(value))
            if not number.is_finite():
                raise InvalidOperation
            result.add(("number", number))
        except (InvalidOperation, ValueError):
            result.add(("text", str(value)))
    return result


def verify_execution(table: dict, sql: str, label: list) -> None:
    """Run the delivered helper, not a second implementation of the SQL adapter."""
    with tempfile.TemporaryDirectory(prefix="evaldock-dbbench-") as directory:
        root = Path(directory)
        (root / "table.json").write_bytes(json_bytes(table))
        (root / "db_tool.py").write_text(DB_TOOL, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(root / "db_tool.py"), "--sql", sql],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode:
            raise ValueError(f"Delivered SQL helper failed: {result.stderr}")
        payload = json.loads(result.stdout)
        if any(len(row) != 1 for row in payload["rows"]):
            raise ValueError("Selected task requires a one-column result")
        if normalized([row[0] for row in payload["rows"]]) != normalized(label):
            raise ValueError("Upstream SQL result and upstream label disagree")


def output_file(path: Path, content: bytes, verify_only: bool) -> None:
    if path.is_symlink():
        raise ValueError(f"Refusing symlink: {path}")
    if path.exists():
        if path.read_bytes() != content:
            raise ValueError(f"Existing generated file differs; refusing overwrite: {path}")
        return
    if verify_only:
        raise ValueError(f"Missing generated file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def create_bundle(line_number: int, row: dict, sources: dict[str, bytes]) -> dict[str, bytes]:
    task_id = f"agentbench-db-{line_number:04d}"
    original_type = row["type"][0]
    if original_type in ("INSERT", "UPDATE", "DELETE"):
        raise ValueError("Only answer-based SELECT tasks belong in this adaptation")
    verify_execution(row["table"], row["sql"]["query"], row["label"])
    assets = {
        "table.json": json_bytes(row["table"]),
        "db_tool.py": DB_TOOL.encode("utf-8"),
        "README.md": PUBLIC_README.encode("utf-8"),
        "LICENSE": sources["LICENSE"],
    }
    question = {
        "schema": "evaldock.question/v1",
        "id": f"thudm.{task_id}",
        "version": "1.0.0",
        "title": task_id,
        "matching": {
            "datasetId": f"dataset.thudm.{task_id}/v1",
            "description": f"对完整本地数据表 {row['table']['table_name']} 执行 SQL，完成 {original_type} 查询；需要检查表结构、解释筛选和聚合条件，并交付查询结果。材料为公开表格 JSON 和 Python 标准库 SQLite 工具。",
        },
        "source": {
            "repository": REPOSITORY,
            "commit": COMMIT,
            "taskPath": "data/dbbench/standard.jsonl",
            "files": [{"path": path, "sha256": hash_value} for path, hash_value in SOURCE_HASHES.items()],
            "adaptationChanges": [
                f"采用原 AgentBench v0.2 standard.jsonl 第 {line_number} 行（1-based），保留 description、完整 table、官方 label 和 SQL；只选择已核验题意、表格、SQL 与 label 相容的 SELECT 子集。",
                "MySQL/Docker 交互改为公开 Python 标准库工具，在内存 SQLite 中实际执行只读 SQL；沿用上游初始化器全列 TEXT，使用 NOCASE 并明确数值 CAST 与 MySQL 差异。",
                "表格、工具、说明和许可证映射到 input/；官方 label、参考 SQL 及原始记录仅保存在 private/，不给 agent。",
                "原 Action/Answer 文本协议、最多 5 轮与 800 字符截断改为本地工具交互及 600 秒预算；要求交付 answer.txt、query.sql 和 query-result.json。",
                "原始精确答案集合/数值比较改为 EvalDock LLM 语义判断，过程与本地交付分别采集证据；不声称是原始 AgentBench 总分或完整环境复现。",
            ],
        },
        "capabilityLabels": LABELS,
        "task": {
            "instructions": (
                f"Use the supplied local database table to answer this question:\n\n{row['description']}\n\n"
                f"{row['add_description']}\n\n"
                "Read `input/README.md`. Inspect the database schema with `python3 input/db_tool.py --schema`, "
                "then formulate and actually execute SQLite SQL using `input/db_tool.py`. "
                "Use only the complete supplied table in `input/table.json` as the factual source. "
                "You may run diagnostic queries and correct errors. All columns are stored as TEXT; "
                "inspect values and explicitly convert numerical text when necessary.\n\n"
                "Write the answer values as a JSON array to `output/answer.txt`. "
                "Save the SQL actually used to `output/query.sql` and its actual tool JSON response to "
                "`output/query-result.json` (for example: `python3 input/db_tool.py --sql-file output/query.sql "
                "> output/query-result.json`). Keep the input materials unchanged. You have up to 600 seconds."
            ),
        },
        "environment": {
            "platform": "portable",
            "timeoutSeconds": 600,
            "dependencies": ["Python >=3.9 with standard-library sqlite3"],
            "inputs": [{"source": f"assets/{name}", "destination": f"input/{name}", "sha256": digest(content)} for name, content in assets.items()],
            "setup": {"kind": "none"},
            "reset": "fresh-workspace",
        },
        "final": {"checks": [{"id": "final-answer", "kind": "llm", "output": "output/answer.txt", "reference": "private/final.json"}]},
        "evidence": {
            "process": {
                "description": "评价是否实际读取表结构、执行与题意一致的 SQL，并依据工具返回值确定答案；如有错误，能否利用反馈修正。",
                "checkpoints": [
                    {"id": "inspect-schema", "description": "读取 input/README.md 并检查目标表与列名，可使用 db_tool.py --schema。"},
                    {"id": "execute-query", "description": f"围绕题目的 {original_type} 条件构造并实际执行 SQL，适当处理文本数值、大小写和标点。"},
                    {"id": "ground-answer", "description": "核对实际查询返回行，确认结果对应所问实体、数量或聚合值，必要时修正查询。"},
                ],
            },
            "local": {
                "description": "评价本地交付是否包含有效答案、实际执行的 SQL 与相应查询结果，且保留输入材料。",
                "checkpoints": [
                    {"id": "write-answer", "description": "创建 output/answer.txt，包含答案值的 JSON 数组。"},
                    {"id": "save-query", "description": "创建 output/query.sql，保留实际用于求解的 SQL。"},
                    {"id": "save-result", "description": "创建 output/query-result.json，保存与交付 SQL 相符的真实工具返回结果。"},
                ],
            },
        },
    }
    final = {
        "answer": json.dumps(row["label"], ensure_ascii=False),
        "rubric": (
            "标准答案直接取自固定提交中该行的官方 label。比较答案值的语义集合；顺序和重复项不影响判定，"
            "数值等价表示（如整数和对应 .0）可接受，单位和实体含义必须一致；不得接受额外错误值。"
            "答案为 JSON 数组是交付格式，亦可接受无歧义的等价文本表达。"
            "只根据正确值判断本层对错，SQL 调用及交付过程由独立 process/local 证据层评价。"
        ),
    }
    files = {"question.json": json_bytes(question), "private/final.json": json_bytes(final),
             "private/source-record.json": json_bytes(row),
             "private/reference.sql": (row["sql"]["query"].rstrip() + "\n").encode("utf-8")}
    files.update({f"assets/{name}": content for name, content in assets.items()})
    return compact_bundle(files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=Path(tempfile.gettempdir()) / f"evaldock-agentbench-{COMMIT}")
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parents[1] / "datasets" / "agentbench-db")
    parser.add_argument("--docs-root", type=Path, help="Optional separate directory for import provenance reports; not written by default")
    parser.add_argument("--verify-only", action="store_true", help="Verify generated files and execute reference SQL without writing bundles")
    args = parser.parse_args()
    sources = fetch_sources(args.cache_dir)
    lines = sources["data/dbbench/standard.jsonl"].splitlines(keepends=True)
    manifest_rows = []
    for number in SELECTED_LINES:
        row = json.loads(lines[number - 1])
        task_id = f"agentbench-db-{number:04d}"
        files = create_bundle(number, row, sources)
        for relative, content in files.items():
            output_file(args.output_root / task_id / relative, content, args.verify_only)
        manifest_rows.append({"id": f"thudm.{task_id}", "directory": task_id, "sourceLine": number, "sourceType": row["type"][0],
                              "sourceLineSha256": digest(lines[number - 1]), "tableRows": len(row["table"]["table_info"]["rows"])})
    if args.docs_root is None:
        print(json.dumps({"status": "verified" if args.verify_only else "imported", "questions": len(manifest_rows),
                          "outputRoot": str(args.output_root)}, ensure_ascii=False))
        return
    manifest = {"repository": REPOSITORY, "commit": COMMIT, "sourceFile": "data/dbbench/standard.jsonl",
                "sourceSha256": SOURCE_HASHES["data/dbbench/standard.jsonl"], "questionCount": len(manifest_rows),
                "selection": "Manually reviewed question/table/label agreement; unmodified upstream reference SQL executed by delivered SQLite helper and matched to official labels.",
                "capabilityLabels": LABELS, "tasks": manifest_rows}
    output_file(args.docs_root / "manifest.json", json_bytes(manifest), args.verify_only)
    categories = dict(Counter(row["sourceType"] for row in manifest_rows))
    readme = f"""# AgentBench DBBench — local SELECT subset

16 question bundles from original AgentBench v0.2, fixed commit `{COMMIT}`.
Each task directory in `datasets/agentbench-db/` follows
`question.json` + `assets/` + `private/final.json`, like the reference datasets.
The collection root contains only question directories. This optional report and
`manifest.json` are exported separately when `--docs-root` is supplied.

- Official dataset: [{REPOSITORY}/blob/{COMMIT}/data/dbbench/standard.jsonl]({REPOSITORY}/blob/{COMMIT}/data/dbbench/standard.jsonl)
- Official environment and evaluator: [{REPOSITORY}/blob/{COMMIT}/src/server/tasks/dbbench/__init__.py]({REPOSITORY}/blob/{COMMIT}/src/server/tasks/dbbench/__init__.py)
- Repository license: [Apache-2.0]({REPOSITORY}/blob/{COMMIT}/LICENSE), copied into each bundle.
- Paper: [AgentBench: Evaluating LLMs as Agents](https://arxiv.org/abs/2308.03688).
- Capabilities: `tool-data`, `reasoning-planning`, `artifact-delivery`.
- Category counts: `{json.dumps(categories)}`.

Every selected question retains its original wording, complete table and official
label. A delivered Python helper performs actual SQLite
queries locally. All selected reference SQL statements run without rewriting and
produce values equivalent to the upstream labels. Only the final answer is kept
in `private/`; table, tool, usage notes, and license
are mapped to the agent's `input/` directory.

Selection is a curated smoke/diagnostic subset of the 300-row standard split,
not a random or representative sample. Source file hashes and line numbers are
recorded in each `question.source`; this optional report also includes per-line
hashes in [manifest.json](manifest.json). Some upstream
rows have inconsistent wording, tables, SQL or labels; those rows were excluded,
not repaired with invented answers. The source table may contain augmented
fixture data and must not be treated as verified real-world information.

The upstream runner uses MySQL in Docker, up to 5 interaction rounds, 800-character
responses, and exact label comparison. This adaptation uses Python 3.9+ with
standard-library SQLite, an in-memory read-only tool, a 600-second task budget,
and EvalDock's LLM semantic final judgment with separate process/local evidence.
Both initializers use TEXT for every column; the adapter uses SQLite NOCASE,
which is not a complete implementation of MySQL collation or numeric coercion.
No INSERT/UPDATE, network service, original action protocol, or full AgentBench
score is claimed. Output SQL and its real result make local tool execution
reviewable. No model/agent run was used to select tasks or measure accuracy.

The repository's current main runner reads the legacy flat `dataset.json` and
`cases.jsonl` format. These question bundles need a Question Bundle loader adapter
before that runner can execute them end to end. The standalone helper and source
verification work now; this import does not connect them to the main runner.

Reproduce from pinned, hash-checked upstream bytes (standard library only):

```sh
python3 scripts/import-agentbench-db-datasets.py
python3 scripts/import-agentbench-db-datasets.py --verify-only
```

The source cache defaults to the system temporary directory. `--cache-dir` can
reuse a predownloaded snapshot with its repository-relative paths. Existing files
are verified byte-for-byte; differing files are never silently overwritten.
The import verifies upstream hashes and runs the delivered SQL helper for all
16 official reference queries. Keep `private/` unavailable to evaluated agents.
"""
    output_file(args.docs_root / "README.md", readme.encode("utf-8"), args.verify_only)
    print(json.dumps({"status": "verified" if args.verify_only else "imported", "questions": len(manifest_rows), "categories": categories, "outputRoot": str(args.output_root)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
