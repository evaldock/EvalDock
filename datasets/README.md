# Local runtime datasets

The default `datasets/` directory contains **one synthetic number-summing task** from `examples/datasets/minimal/`. It checks execution, evidence collection, file delivery and scoring, and is not a capability-ranking benchmark. Its demonstration answer is intentionally public. Without external imports, this is the only task in the default catalog; Agent setup, dependencies and model configuration are still required.

Download the reviewed public collection from [BenchDock on Hugging Face](https://huggingface.co/datasets/EvalDock/BenchDock). Follow [the integration guide](../docs/BENCHDOCK.md) to import a pinned pilot into `.evaldock/benchdock`. Real task packages and private grading bundles must not be committed here.

## Distribution, loading and execution counts

| Count | Meaning and evidence |
| --- | --- |
| Bundled tasks | Task files in this checkout's default `datasets/`: one synthetic demo. The copy under `examples/` and test fixtures are not additional default tasks. |
| Loaded tasks | Tasks successfully loaded from the selected catalog and root on a particular machine. Shared adapters use `EVALDOCK_DATASETS_ROOT`, defaulting to `datasets/`; the DSH CLI also supports an explicit `--datasets` path. Record the root and version or import receipt. Other machines' loaded counts have not been established here. |
| Selected and executed tasks | The selected plan and actual run evidence for a particular evaluation. Selection does not establish that execution started, completed or was scored. |

BenchDock catalog records describe a separately distributed collection. They must not be added to the bundled count or presented as tasks already executed or scored in EvalDock. Public-only tasks without authorized grading references remain `UNASSESSABLE`; see the integration guide for dependencies and separate scoring.

For shared-adapter runs, inspect `var/evaluation-results/agents/<targetId>/runs/<runId>/`:

- `plan.json` records the selected queue; `run.json` records case results and run status. A failure before planning may leave no plan.
- Per-case `session.json`, reports, `all-trace/` and `output/` provide execution and delivery evidence. A missing case result alone does not prove the task never started; inspect the available session, progress and trace evidence after interruptions.
- Check scores separately: execution completion does not establish answer correctness or successful scoring. Preserve the full result directory, import receipt and EvalDock revision when comparing runs.

## Count the source files

Run from the repository root (this checks file counts, not successful runtime loading or execution):

```sh
python3 - <<'PY'
import json
from pathlib import Path

questions = list(Path('datasets').rglob('question.json'))
labels = list(Path('labels').glob('*.json'))
label_ids = [json.loads(p.read_text())['labelId'] for p in labels]
print(f'Default task files: {len(questions)}')
print(f'Label files: {len(labels)}; unique label IDs: {len(set(label_ids))}')
assert len(label_ids) == len(set(label_ids)), 'Duplicate label IDs'
PY
```

Before publishing, compare these counts with both READMEs and the [release notes](../docs/RELEASE.md), then run `pnpm run verify`.
