# Agent adapters

DSH, WorkBuddy, Pi and LangGraph share the existing dataset catalog, Planner policy,
current Judge labels, all-trace/v1 store and report schema. Label definitions are
maintained in [labels/*.json](../labels/README.md). Agent-specific code must not
change these contracts.

An implemented adapter is not evidence of validation on every product version.
See [application identities, version restrictions and validation evidence](SUPPORT.md)
before selecting a target. Historical results apply only to the recorded version
and test scope; version checks passing do not establish end-to-end validation.

The process/desktop adapters use shared/evaluation.mjs for planning, workspace
inputs, the bounded three-Case queue, judging and reports. Each adapter supplies:

- kind, targetId, name and supportsAttachments.
- inspect(): availability, actual version, declared tools/components and limitations.
- staticInfo(inspection): the public capability input used by the common Planner.
- prepare(context), run(caseContext), dispose(context): lifecycle and cancellation.
- Optional workspaceDescription(cwd): describe native versus virtual filesystem paths.
- trace: source identity, event normalization and known observation gaps.

run returns captured evidence, final text, termination information and cleanup
status. It never computes scores. Only public task and input files reach the target;
the Judge receives the existing private rubric through the common evaluation path.
DSH retains its existing execution path. Its migration to this interface is not
required to add another Agent.

## Targets and runtime ownership

config/agents.json declares Pi and the concrete LangGraph targets DeepAgents and
Agent Service Toolkit. Installed runtime sources and separate Python environments
use the user-configured installation paths in config/agents.json. Credentials are read locally and are not stored in
this configuration. Child Agents receive the target API key, not Planner/Judge keys.

Pi extensions are installed but disabled until selected in the Pi console. Its
isolated home disables automatic extension, skill and prompt discovery. Extension
names are frozen into each run's inspection. Extension-internal hooks are not
attributed when the public event stream does not identify their origin.

DeepAgents uses virtual filesystem paths; its task context describes that mapping
without changing the Case task or answer. Each LangGraph target has an explicit Python executable, entrypoint and tool
declaration. The bridge calls the real graph's stream/astream. A LangGraph runtime
version alone is not a complete target identity: use the concrete target ID and
the installation manifest beside its source.

## Evidence policy

Collection is driven by Pi JSON stdout and LangGraph stream events, not message
history polling. Preserve tool calls/results by call ID, task termination, final
answer and delivered files. Drop token deltas and full state snapshots. LangGraph
also keeps bounded node/checkpoint/interrupt evidence; repeated messages are
deduplicated. No unobserved thoughts or tools are fabricated.

The common capture has a 192 KiB event budget, up to 128 tool call pairs and 64
other events. Individual long values are excerpted with digest/omission metadata.
Final text is capped at 64 KiB, delivered text evidence at 192 KiB, and assembled
all-trace at 1 MiB. Coverage records clipping and blind spots. The existing 20 MiB
storage/transport guard and Judge settings remain unchanged.

Each Case starts its own process group and workspace. Cancellation, timeout and
normal completion clean the owned process group, including remaining tool
children. Unconfirmed cleanup blocks another run for that target. This is
workspace/process isolation, not an OS sandbox or global machine reset.

## Compatibility and validation

node --test --test-concurrency=1 tests/contracts/*.test.mjs

Contract tests cover existing DSH/WorkBuddy behavior, common Trace storage,
bounded/deduplicated event capture, cancellation/descendant cleanup, static identity,
CSRF protection and cross-Agent run exclusion. Real validation must additionally
exercise Planner -> target execution -> Trace -> Judge -> report for each concrete
target. Fixture tests never substitute for that check.

## Version compatibility admission

Before a formal run, the shared runner executes the host-owned `adapters/compatibility/`
checks. This is also the entry point used by desktop/workbench jobs; direct adapter
CLI runs cannot skip it. DSH's formal CLI uses the same gate with its native Web
executor, and rechecks identity around each Case. Headless DSH has an explicit
`AGENT_DSH_HEADLESS_SUITE_UNAVAILABLE` result until its specialist suite is available;
it is not implicitly certified by the Web checks.

```sh
pnpm run build
pnpm run compatibility --list
pnpm run compatibility --target-id <configured-target-id>
pnpm run compatibility --target-id workbuddy --force
pnpm run compatibility --target-id dsh
```

The compatibility command needs the tested Agent's own environment and credentials,
but does not select datasets or invoke Planner/Judge. `--force` reruns behavior checks
and revokes an older receipt before testing. The suite creates only synthetic tasks
in separate workspaces under `var/compatibility/checks/`; original results and private
rubrics are not inputs. A successful compatibility check is not an evaluation score.

The four outcomes are `COMPATIBLE`, `INCOMPATIBLE`, `INDETERMINATE` and
`ENVIRONMENT_BLOCKED`. Reports include protocol ID, required/passed capabilities,
identity digest, individual checks and evidence paths. A version change is a cache
miss, not an automatic rejection: unchanged working protocols can pass without code
changes. Missing or unexercised capabilities remain unverified.

The fixed v1 suite checks a text response, two distinct sessions, hidden file
challenges with read/write evidence, cancellation and confirmed cleanup. Doubao also
must exercise child-task creation and completion. Text-only Graphs are not required
to use file tools; their cancellation check needs observed execution. The host reads
the delivered files independently; a successful final response cannot replace tool
pairs or child terminal events. Cancellation checks also observe the owned output
directory after the scheduled write time. These checks do not prove the absence of
all possible background activity or reset global application state.

A protocol ID denotes a driver family, not a product-version whitelist. The initial
registry contains the existing implementations only; there is no guessed fallback
or automatic code generation. Receipts expire after 24 hours and bind the target,
configuration digest, OS/architecture, client build/runtime files, adapter code and
suite. Configured Graph dependencies and runtime source/extension files contribute
to the fingerprint. Relevant identity changes require revalidation; documentation
changes alone do not. Each reuse still performs the adapter's live interface and
login check. Receipt files and their matching evidence stay local.

A machine-wide target lease excludes compatibility checks from formal runs across
worktrees. Interrupted leases are not stolen automatically. Unknown cleanup creates
local and machine-wide blockers and prevents further checks/runs. Inspect the saved session, stop
only its owned work, and confirm cleanup before removing the corresponding blocker
in `var/compatibility/blocked/` and the system temporary `evaldock-compatibility-<uid>/blocked/` (or an interrupted lease under the system temporary
`evaldock-compatibility-<uid>/` directory). This release does not automate recovery,
client upgrades, code patches or background monitoring.

Real validation still requires execution → collection → Judge → report on the
configured machine. Passing the synthetic suite or the offline mutation tests does
not certify untested product versions or capability combinations.
