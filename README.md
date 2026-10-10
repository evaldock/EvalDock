<p align="center">
  <a href="https://www.evaldock.ai/">
    <img src="docs/assets/evaldock-banner.png" alt="EvalDock — Real agents. Real evidence." width="100%" />
  </a>
</p>

<h1 align="center">EvalDock</h1>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-343b43?style=for-the-badge" alt="English" /></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-60646c?style=for-the-badge" alt="简体中文" /></a>
</p>

<p align="center"><strong>An end-to-end evaluation framework for heterogeneous agents and plugins.</strong></p>

<p align="center">
  <a href="https://www.evaldock.ai/"><img src="https://img.shields.io/badge/Website-EvalDock-1677b8?style=flat-square" alt="Website: EvalDock" /></a>
  <a href="#setup-and-datasets"><img src="https://img.shields.io/badge/Docker-in_preparation-2496ed?style=flat-square" alt="Docker: in preparation" /></a>
  <a href="https://github.com/evaldock/EvalDock/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/evaldock/EvalDock/ci.yml?branch=main&amp;style=flat-square&amp;label=CI" alt="CI" /></a>
  <a href="https://github.com/evaldock/EvalDock/stargazers"><img src="https://img.shields.io/github/stars/evaldock/EvalDock?style=flat-square&amp;color=b08b42" alt="GitHub Stars" /></a>
  <a href="#supported-agents"><img src="https://img.shields.io/badge/Agents-8-00897b?style=flat-square" alt="Agents: 8" /></a>
  <a href="#dataset-coverage"><img src="https://img.shields.io/badge/Public_tasks-1650-2e8b57?style=flat-square" alt="Public catalog: 1650" /></a>
  <a href="examples/datasets/README.md"><img src="https://img.shields.io/badge/Template-1_Case-d97706?style=flat-square" alt="Template: 1 Case" /></a>
  <a href="labels/README.md"><img src="https://img.shields.io/badge/Dimensions-15-c75578?style=flat-square" alt="Dimensions: 15" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-24-43853d?style=flat-square" alt="Node.js: 24" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/pnpm-11.24.0-c28b00?style=flat-square" alt="pnpm: 11.24.0" /></a>
  <a href="src/all-trace/types.ts"><img src="https://img.shields.io/badge/All%20Trace-v1-0891b2?style=flat-square" alt="All Trace: v1" /></a>
  <a href="#scoring"><img src="https://img.shields.io/badge/Scoring-0%E2%80%93100-d65a45?style=flat-square" alt="Scoring: 0–100" /></a>
</p>

<p align="center">
  <strong>Website: <a href="https://www.evaldock.ai/">https://www.evaldock.ai/</a></strong>
</p>

## Contents

- [Overview](#overview)
- [Workbench](#workbench)
- [Evaluation workflow](#evaluation-workflow)
- [Scoring](#scoring)
- [Supported agents](#supported-agents)
- [Dataset coverage](#dataset-coverage)
- [Setup and datasets](#setup-and-datasets)
- [Results](#results)
- [Development](#development)
- [Adding an agent](#adding-an-agent)
- [Contributing](#contributing)
- [Community](#community)

---

## Overview

EvalDock tests different agents and compares plugin configurations within the same agent. It selects tasks, runs them, records what happened, and scores the results in a local workbench.

Each agent has its own execution adapter. Datasets, the All Trace format, and the Judge are shared. Every case keeps its tool calls, output files, scores, and scoring explanations for review or later comparison.

The workbench lets you select agents and plugins, configure Planner and Judge API keys, choose tasks, and start or cancel runs.

## Workbench

Use the workbench to configure agents, plugins and models and inspect your own runs. See the [setup guide](docs/NATIVE_SETUP.md).

## Evaluation workflow

<p align="center">
  <a href="docs/assets/evaluation-workflow.png">
    <img src="docs/assets/evaluation-workflow.png" alt="EvalDock workflow: inspection, planning, execution, evidence capture, All Trace storage, judging and reports" width="100%" />
  </a>
</p>

The diagram uses DSH as an example. The current code supports the eight agent types listed below and runs up to three cases concurrently. The serial execution and score aggregation shown in the diagram are from an earlier design.

1. **Inspect and select.** Read the agent version, tools, and plugins. The Planner selects datasets from this information, or you can choose cases manually.
2. **Run.** Prepare a separate workspace and give the agent the task and public inputs. Private grading references stay with the Judge.
3. **Collect evidence.** The Probe records tool calls and responses. File observation records workspace changes and deliverables. Both are stored in All Trace.
4. **Score.** The Judge uses the task references, label criteria, and All Trace to score each dimension and produce JSON and HTML reports.

### Task selection

Select cases manually or let the Planner choose 3–10 datasets, with 3–7 cases each (all cases if fewer than three). Automatic sampling targets 20% easy, 40% medium, and 40% hard cases. [Selection rules](planning/case-sampling.md).

### Trace collection

The Probe collects evidence on events or task completion, merges duplicates, and limits trace size. Truncation and missing evidence are recorded. [Evidence policy](adapters/README.md#evidence-policy).

## Scoring

The current [15 capability labels](labels/README.md) use a 0–100 scale. Each label has five criteria. The Judge scores against those criteria using the task and recorded evidence.

| Category | Labels |
| --- | --- |
| Planning and execution | `reasoning.planning`, `loop`, `collaboration` |
| Information processing | `retrieval`, `memory`, `multimodal` |
| Tool use | `tool.code`, `tool.data`, `tool.document`, `tool.web`, `tool.external` |
| Delivery and efficiency | `artifact.delivery`, `efficiency.reliability`, `efficiency.cost`, `safety.boundary` |

A dimension with insufficient evidence is marked `UNASSESSABLE`. Judge request or parsing failures retain their error status. Neither contributes a valid score. A task with evidence of failure can still receive a low score. A score of 100 requires direct evidence that all applicable criteria were met; there is no quota for perfect scores.

`EFFECT` mode evaluates deliverables. `FULL` mode also uses execution evidence. Read aggregate scores alongside the assessed dimensions and task coverage. Historical reports retain their original criteria and are not converted to a new scale.

## Supported agents

Eight agents currently have adapters. Codex and Claude Code are planned additions.

Agents must be installed and configured separately. See the shared [support and validation record](adapters/SUPPORT.md) for application identities, allowed versions, public validation status and limitations. An implemented adapter, a passing version check and a validated real task are distinct states. Revalidation is required after upgrades.

| Logo | Agent | Integration | Required setup |
| :---: | --- | --- | --- |
| <img src="workbench/design-prototypes/assets/agents/dsh.svg" width="25" height="25" alt="" /> | DSH | Web Profile and runtime Probe | Web Profile, model, plugins |
| <img src="workbench/design-prototypes/assets/agents/pi.svg" width="37" height="37" alt="" /> | Pi | CLI JSON events | Executable, model, extensions |
| <img src="docs/assets/agents/codex.png" width="32" height="32" alt="" /> | Codex **(planned)** | Adapter pending | Setup guide will follow the integration |
| <img src="docs/assets/agents/claude.png" width="28" height="28" alt="" /> | Claude Code **(planned)** | Adapter pending | Setup guide will follow the integration |
| <img src="workbench/design-prototypes/assets/agents/openclaw.svg" width="24" height="24" alt="" /> | OpenClaw | CLI and session transcript | Node runtime, executable path, model |
| <img src="workbench/design-prototypes/assets/agents/hermes.png" width="30" height="30" alt="" /> | Hermes | CLI `stream-json` | Python environment, executable path, model |
| <img src="workbench/design-prototypes/assets/agents/workbuddy.svg" width="24" height="24" alt="" /> | WorkBuddy | Desktop sessions and events | App login, local debugging connection |
| <img src="workbench/design-prototypes/assets/agents/qwenwork.png" width="30" height="30" alt="" /> | Qwen Work (千问办公) | Desktop sessions and events | App login, local workspace |
| <img src="workbench/design-prototypes/assets/agents/doubaowork.png" width="33" height="33" alt="" /> | Doubao Work (豆包办公) | Desktop sessions and background tasks | App login, local office environment |
| <img src="workbench/design-prototypes/assets/agents/langgraph.svg" width="24" height="24" alt="" /> | LangGraph | graph stream / astream | Python environment, graph entrypoint, tool definitions |

Example LangGraph targets include DeepAgents and Agent Service Toolkit. Plugin selection is available for agents that support plugins or extensions.

Adapter notes: [shared interface](adapters/README.md) · [OpenClaw](adapters/openclaw/README.md) · [Hermes](adapters/hermes/README.md) · [Qwen / Doubao Work](adapters/OFFICE_AGENTS.md). Replace example installation paths with your own.

## Dataset coverage

**BenchDock: 1,650 task records across 146 subsets.** 1,150 include public content; 500 provide sources only. The framework's default `datasets/` includes **one synthetic demo task** for workflow checks, not capability rankings. [Public data](https://huggingface.co/datasets/EvalDock/BenchDock) · [BenchDock tools and documentation](https://github.com/evaldock/BenchDock) · [Pinned pilot import and separate scoring](docs/BENCHDOCK.md). External catalog counts must not be added to the bundled count or treated as loaded, executed or scored task counts; see the [dataset guide](datasets/README.md). Public availability does not imply verified execution or official upstream scores.

## Setup and datasets

Choose the source setup to run EvalDock today. Docker packaging is still in preparation.

| Option | Status | Guide |
| --- | --- | --- |
| macOS source | Available | [Installation and first run](docs/NATIVE_SETUP.md) |
| Docker / Compose | Not released | [Packaging progress](docs/RELEASE.md) |

After installation:

1. Install and configure the agent you want to test.
2. Open **System Settings** in the workbench and set the model, endpoint, and API key for the Planner and Judge. The agent uses its own credentials.
3. Prepare a dataset and its required tools or services, then start an evaluation from the agent console.

The Docker plan keeps the workbench and scoring services in a container, with a Runner on the agent's machine for execution and evidence collection. Desktop agents run on their native OS. Startup commands and volume paths will accompany the Compose release.

### Dataset packages

The [basic template](examples/datasets/minimal/) contains one task: read numbers from JSON, calculate their sum, and write the result to a file. Use it to check the setup and evaluation flow, or as a starting point for your own cases.

The default `datasets/` uses this demo; without external imports, it is the only task available for selection. Follow the [setup guide](docs/NATIVE_SETUP.md) to configure the Agent, runtime dependencies and required model services.

Public task packages are available from [BenchDock](https://huggingface.co/datasets/EvalDock/BenchDock). Use the [integration guide](docs/BENCHDOCK.md) for an explicit three-task pilot. Workbench import automation and full-collection runtime coverage are not provided. Existing result artifacts remain local and may include sensitive evaluator material.

```text
datasets/
├── catalog.md           # Dataset index
└── <dataset>/
    └── <case>/
        ├── question.json
        ├── input/       # Public inputs for the agent
        └── private/     # Grading references for the Judge
```

Prepare any tools, databases, or external services required by a dataset separately. Public tasks without authorized grading references remain `UNASSESSABLE`: no Judge call is made and no zero score is assigned. Scores on adapted tasks are not official results for the upstream benchmarks.

## Results

Open reports from the workbench to inspect scores, traces, output files, and Judge records.

For shared-adapter runs, `plan.json` records the selected queue; `run.json`, per-case sessions, reports and traces establish the actual execution evidence. See the [evidence guide](datasets/README.md#distribution-loading-and-execution-counts). Execution completion does not establish answer correctness or completed scoring.

The planned Docker release will persist results in a host-mounted directory. The mount path will be documented with the Compose release. The `var/` paths below apply to the current source version.

<details>
<summary>Current source version: paths and backups</summary>

Results are stored under `var/evaluation-results/agents/<agent>/runs/<run>/`. Each case includes `all-trace/`, `output/`, `judge/`, and JSON / HTML reports.

```text
var/
├── evaluation-results/  # Saved results
├── batch-runtime/       # Workspaces and intermediate data
├── workbench/           # Job state and caches
└── logs/                # Runtime logs
```

Back up the complete result directory. If you use VM snapshots, copy results outside the VM before restoring one. Separate workspaces and process cleanup do not restore the state of the entire machine.

</details>

## Development

These commands are for building and testing the source. They are not Docker installation steps.

<details>
<summary>Source development commands and repository layout</summary>

Install dependencies and run the checks:

```sh
pnpm install --frozen-lockfile
pnpm run verify
node --test workbench/lib/model-settings.test.mjs
```

The main CLI provides `inspect`, `plan`, `run`, and `report`. This example uses an already configured DSH target:

```sh
pnpm --silent cli -- help

pnpm --silent cli -- run \
  --target config/targets/real-dsh.json \
  --datasets datasets \
  --labels labels \
  --trace trace/dsh-runtime.json \
  --environment environments/macos.json \
  --config config/macos-vm.json \
  --test-profile STANDARD
```

Other agents run through their adapters. After changing an adapter, run the offline checks and a real-agent test covering execution, capture, scoring, and reporting.

### Repository layout

```text
adapters/       # Agent adapters and shared execution code
src/            # Planning, Trace, Judge, reports, and storage
workbench/      # Workbench pages and control service
labels/         # Capability labels and scoring criteria
planning/       # Selection policies, prompts, and difficulty annotations
config/         # Agent and runtime configuration
trace/          # Probe configuration
observer-lab/   # Environment observation
environments/   # Task environments and supporting services
examples/       # Basic case template
tests/          # Contract and regression tests
scripts/        # Import, migration, and maintenance tools
```

</details>

## Adding an agent

An adapter supplies three main parts: static information, task execution, and a Probe.

- Static information describes the version, tools, plugins, and runtime limits for the Planner.
- Execution prepares sessions, submits tasks, and handles cancellation and cleanup for the current run.
- The Probe converts native events into the shared Trace format and handles duplicates, long text, and observation gaps.

Register the target and workbench controller, then reuse the existing datasets, Judge, and result pages. Adapters return evidence and execution status; the Judge assigns scores.

DSH retains its original execution implementation. Most other adapters use `adapters/shared/`. See the [adapter interface](adapters/README.md).

## Contributing

Contributions to adapters, tasks, and scoring criteria are welcome. For bug reports, include the agent version, steps to reproduce, and logs or traces with credentials and other sensitive data removed.

The repository does not yet have a project-wide license. Third-party agents, datasets, and brand assets remain subject to their respective licenses.

## Community

For questions and feedback, use [GitHub Issues](https://github.com/evaldock/EvalDock/issues).

<p align="center">
  <a href="https://www.evaldock.ai/">Website</a> ·
  <a href="https://github.com/evaldock/EvalDock/issues">Report an issue</a> ·
  <a href="docs/RELEASE.md">Release notes</a>
</p>
