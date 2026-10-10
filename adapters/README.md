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

真实多版本回归的安装隔离、验证步骤与结论边界见[跨版本实测流程](../docs/AGENT_VERSION_VALIDATION.md)。

## Version compatibility admission

Before a formal run, the shared runner executes the host-owned `adapters/compatibility/`
checks. This is also the entry point used by desktop/workbench jobs; direct adapter
CLI runs cannot skip it. DSH's formal CLI uses the same gate with its native Web
executor, and rechecks identity around each Case. Headless DSH runs the same fixed
tasks through its native process executor and validates its own session archives,
completed turns and process-group cleanup. Web and Headless use separate protocols
and receipts. Headless inspection requires a configured headless profile.

```sh
pnpm run build
pnpm run compatibility --list
pnpm run compatibility --target-id <configured-target-id>
pnpm run compatibility --target-id workbuddy --force
pnpm run compatibility --target-id dsh
pnpm run compatibility --target-id dsh --descriptor /path/to/local-target.json
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

DSH accepts `session.v4.jsonl.zstd`, `session.v3.jsonl.zstd` and legacy
`session.jsonl.zstd` archives, preferring the newest known format when present. A corrupt current archive never falls back to stale legacy
evidence. Both legacy tool-result blocks and v4 tool messages preserve result content,
error status and call ownership. Compacted argument references are resolved
before acceptance. The configured DSH home is used consistently for Headless checks
and formal session-separated runs. HTTP 401/403 from Web is an authentication
blocker; the checker does not disable authentication or change a running service.

### 已安装版本的补充适配

DSH Headless 在 `SESSION_SEPARATED` 模式下使用已安装的可执行文件与现有 Headless profile；缺少生成式 `effective-config.json` 时读取安装清单，并从绑定当前指纹的兼容性验收会话获取实际权限和沙箱信息。没有真实信息时保留 `UNKNOWN`，不能推断为通过。Planner 核对冻结版本与 Inspector 的版本一致，不再硬编码旧版本号；更强隔离模式仍保留原有运行时暂存要求。

Hermes CLI 缺少工具调用 ID 时，只从本题独立状态目录的原生会话数据库恢复 ID 与工具结果。数据库证据数量、工具名与 CLI 记录必须一致，不能按到达顺序猜测并行工具的配对；缺失时停止准入。

LangGraph 有 Shell 工具时用延迟写入验证取消；没有 Shell 时等真实节点开始事件后取消，报告注明 `OBSERVED_GRAPH_ACTIVITY`。后者不代表已验证 Shell 子进程清理；纯聊天 Graph 也不声明文件能力。

DSH Web 支持从本地受控服务日志的同源启动链接交换登录 Cookie，凭据仅存内存，不进入报告。协议层先用只读会话列表检查旧式点分 RPC；仅在接口返回 404 时探测新版 Remote RPC。两种已知协议都不可用时停止准入，不按版本号猜测支持情况。

新版 Remote 使用命名参数 RPC、`session/follow` 会话快照和 `/api/remote.mux` 事件流；权限命令通过 `commands/execute` 提交。执行器、工作台状态查询和实时观察共用协议适配层。快照必须匹配当前会话，自动审批与提问应答携带服务端关联 ID；Case 只应答自己会话的请求，其他会话交回服务端处理。取消后仍需确认会话停止，不能把接口受理当作清理完成。

2026-10-10，Mac mini 虚拟机上的 DSH CLI `0.1.5-rc.1`（Web/base 组件 `0.1.5-rc.2`）通过新版 Web 的文本、文件、工具、会话隔离和延迟写入取消检查，并完成真实执行 → 会话证据归档 → Judge 评分 → HTML 报告。另以独立合成任务验证了真实提问与审批自动应答。旧式 RPC 保留契约回归覆盖；本轮没有重新部署旧版 Web 进行真实验收，也不代表任意未来协议自动兼容。
