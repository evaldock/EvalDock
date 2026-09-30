# BenchDock public tasks and private evaluation

[BenchDock on Hugging Face](https://huggingface.co/datasets/EvalDock/BenchDock)
distributes 1,650 catalog records: 1,150 have public task content and 500 contain
source/acquisition information only. EvalDock supplies execution adapters, trace
collection and its own label Judge. These are separate release boundaries.

本指南连接公开数据包与 EvalDock。先执行、保存输出与轨迹，再由有权限的评测端评分。
没有参考材料时显示 `UNASSESSABLE` / `PRIVATE_EVALUATOR_NOT_DISTRIBUTED`，不调用
Judge、不记为零分，也不产生上游官方 benchmark 成绩。

## Scope of this integration

`config/benchdock-pilot.json` explicitly selects three tasks from the fixed public
revision `a27d5a593cb400ae94cbdeccff6224225a18f9f1`:

- `local.qcircuitbench-postprocessing-01`: Python standard-library task with two input files.
- `local.qcircuitbench-postprocessing-02`: another declared Python input contract.
- `omnimath-00020-finite-function-cover`: text-only reasoning with a file-delivery contract.

The profile records reviewed labels, writable paths, timeout, platform and dependencies.
It is not an automatic environment generator. Review a task's actual instructions
and prerequisites before adding it. Linux services, browser accounts and simulated
tools are not automatically provisioned. Source-only records cannot be imported.
Import/export checks do not establish that an Agent can solve a task.

## Prepare the public release

Use Python 3.10+ and the framework's normal Node/pnpm setup. If you already have a
standalone copy of the pinned release, use that directory with `--release` below.
Otherwise install the official client in your Python environment:

```sh
python3 -m pip install huggingface_hub
python3 - <<'PY'
import json
import shutil
from pathlib import Path
from huggingface_hub import snapshot_download

profile = json.loads(Path('config/benchdock-pilot.json').read_text())
destination = Path('.evaldock/benchdock-release')
if destination.exists():
    raise SystemExit('Choose a fresh destination; do not overwrite an existing release.')
snapshot = snapshot_download(profile['repo_id'], repo_type='dataset',
                             revision=profile['revision'], token=False)
shutil.copytree(snapshot, destination, symlinks=False)
PY
python3 scripts/import-benchdock.py \
  --release .evaldock/benchdock-release \
  --profile config/benchdock-pilot.json \
  --destination .evaldock/benchdock
```

The download is approximately 2.22 GB; allow space for both cache and copy.
No Hugging Face login is required. The importer verifies the pinned manifest,
catalog, selected task records, input bytes and notices. It copies only selected
task inputs and provenance, never runs release scripts and refuses existing
destinations. It does not copy the complete original task folders.

The output retains the task ID, release commit, source record hash, catalog and
manifest hashes, and the reviewed profile hash. Changes to a release require a new
reviewed profile. Keep the import receipt with your experiment. At load time the
framework rechecks `PROVENANCE.json`, task text (including any `prompt.md` override)
and the actual input hashes and destinations; local changes to those fail closed.
These hashes provide reproducibility checks, not signatures or remote attestation.

## Run and collect evidence

Build normally, then point EvalDock at the imported directory:

```sh
pnpm run build
export EVALDOCK_DATASETS_ROOT="$PWD/.evaldock/benchdock"
```

The shared adapters and workbench selection API honor this variable. Start the
workbench from the same environment, configure an installed agent, and choose
`BenchDock public pilot` in the task-selection dialog. The static resource preview
is deliberately empty; it does not embed benchmark questions or private documents.
Automatic Planner selection still requires Planner credentials; explicit case
selection avoids the Planner request. Agent credentials are independent.

For example, an already installed and configured Pi adapter can use its standard
CLI with explicit selection (consult [adapter setup](../adapters/README.md)):

```sh
node adapters/shared/run.mjs --target-id YOUR_CONFIGURED_PI_TARGET_ID --run-id benchdock-pilot-001 \
  --evaluation-config '{"mode":"FULL","selection":{"kind":"SELECTED","items":[{"datasetId":"dataset.benchdock-public/v1","caseIndices":[0,1,2]}]}}'
```

Use a new run ID each time. The DSH main CLI also accepts an explicit `--datasets`
path; if supplied, it overrides the environment variable.

Runs preserve delivered files, All Trace and JSON/HTML reports under the normal
`var/evaluation-results/` tree. With public-only cases every label remains
`UNASSESSABLE`, and aggregates remain null. A completed run means the execution
pipeline finished, not that the answer is correct. Reports retain the public task
revision in `case.question.benchdock`; retain the EvalDock Git commit and dirty-tree
status with the run when comparing tool versions.

## Score later on the trusted evaluator

Move the verified case result directory to a trusted evaluator location. Keep
reference bundles outside Agent-accessible workspaces and Git. A workspace path
alone is not an OS security boundary; use a separate account, container with
appropriate mounts, or separate host for the evaluator.

An authorized maintainer prepares a private JSON bundle:

```json
{
  "schema": "evaldock.benchdock-private-reference/v1",
  "taskId": "the-original-task-id",
  "revision": "the-full-public-commit-sha",
  "taskRecordSha256": "the-public-task-record-sha256",
  "reference": {"rubric": "privately maintained assessment material"}
}
```

The identity fields must match `case.question.benchdock` in the execution report.
Use the actual approved evaluator material; a placeholder is not a valid grading
reference. The command does not download private archives or create reference
answers. Configure the Judge using the existing environment/key-management setup,
then run:

```sh
node scripts/score-benchdock.mjs \
  --report /trusted/results/case/report.json \
  --reference /trusted/references/task.json \
  --output /trusted/results/case/deferred-scores.json
```

The scorer verifies the report and trace hashes, refuses mismatched task revisions,
preserves the original `EFFECT`/`FULL` mode and optional task weight, and compares
the complete execution scope. Reports missing their original mode are rejected. It
writes a fresh score document without overwriting the execution report. It uses
EvalDock's LLM label Judge, not an executable upstream grader. It records the private
bundle digest, not its contents; Judge explanations and results may still reveal
assessment information, so keep them private. No official upstream scoring claim
is made. Real model calls use the evaluator's configured provider and may incur cost.

## Publication boundary

The framework checkout contains only the synthetic number-summing demo and explicit
test fixtures. Real task packages, environment datasets, question-inventory snapshots
and task-specific difficulty hints are not distributed here. Runtime imports live
under the ignored `.evaldock/` directory. `pnpm run verify` checks this boundary.

Removing files from a new commit does not erase historical Git objects, cached pages,
clones or old release artifacts. Any historical cleanup is a separate administrator
operation; this integration does not rewrite history or assert that past exposure
has been removed.

## Checks

```sh
pnpm run verify
pnpm run test:benchdock-import
node --test workbench/lib/model-settings.test.mjs
```

Tests cover malformed imports, unavailable scoring, execution/trace/report flow
with a controlled synthetic adapter, and revision-bound deferred scoring with a
synthetic Judge. They do not claim a real Agent or official evaluator passed the
whole public collection.
