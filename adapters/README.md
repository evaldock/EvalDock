# Agent adapters

DSH, WorkBuddy, Pi and LangGraph share the existing dataset catalog, Planner policy,
14-label Judge, all-trace/v1 store and report schema. Agent-specific code must not
change these contracts.

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
live under /Users/dsheval/Agents. Credentials are read locally and are not stored in
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
