# Architecture and state ownership

`raw` keeps model-facing input small. The ordinary request contains one literal system prompt, selected tool schemas, the user's messages, and committed assistant/tool history. Configuration, provider discovery, logs, approval text, and usage statistics stay in host state. Tool schemas are measured together with the prompt, not mistaken for free context.

The configuration loader resolves one named LLM agent per session. Provider adapters stream through official SDKs into a small common event shape. The agent loop owns transcript and step count. The registry owns schema validation and exposure before execution. External MCP tools join that registry only when explicitly selected. ACP owns independent session state and protocol transport. The CLI renders events but does not reimplement the agent loop.

The global session store uses a private SQLite database in the user's state directory. It assigns stable workspace and session IDs, records ordered display history separately from model context, and exposes indexed keyset pages for session lists and the newest 20 history items. Older items remain available through an opaque cursor. A readable format-6 store stays at `raw/sessions.sqlite`. If that location holds an unsupported old format, Raw preserves it and uses `raw/stores/storage-v6/sessions.sqlite` for new sessions. Each store owns its payload files and maintenance; an old format cannot block an unrelated new conversation. There is no automatic migration of old session content. Expiry is based on the last committed conversational activity, and a read does not renew it.

Committed conversation blocks do not change between ordinary turns; new user messages and tool results append. This preserves reusable cache prefixes. A failed or cancelled tool batch must retain valid call/result linkage. At resume, recovery results for unresolved calls are committed before any skill reload notice. The session compares ordered model-facing definitions with source identities for selected plugin entries and skills. Identical generations keep the generated cache key; changed tool definitions or selected entry bytes rotate it; changed skill bytes alone keep it and add a tail notice only when prior visible skill data is stale. An explicit OpenAI cache key still wins on the wire. Manual `/compact` or agent-triggered automatic compact atomically replaces eligible older model context with a labeled summary and reminds the agent to reload any removed loaded skill text; `/clear` starts another conversation while idle. The starter agent selects three primitive tools; a vision agent may select `view_image`.

Session storage separates canonical history from the effective request view. Runtime changes update a durable generation and may mark old provider/tool messages for neutral historical replay, while retaining their original saved content. The provider request builder and token estimator use one projected view. A selected local tool runs from a content-addressed snapshot of its owned files, so an imported helper edit is detected and used on the next attachment even when the host process stays alive. Unchanged snapshots and effective settings keep the same generated key and request prefix after the change.

One ordinary inference request counts as one step. The default maximum is 25. When the last allowed request asks for a tool, the run stops before that tool executes because it cannot consume the result in another inference step. Compact requests use separate usage accounting and do not consume a tool step.

## Host operations

The shared session-operation service owns durable submit receipts, startup leases, per-turn runtime attachment and cleanup. Transports observe it without owning execution. User-input consumption commits with the first model/history write; retries return the receipt instead of running again. Successful compact summaries commit with replacement context while visible history remains available. See [Sessions](sessions.md) for identities, interrupted outcomes and read-only projections.

## Windows process trees

Windows has no process groups that Raw can signal, and Git Bash re-parents its children, so `taskkill /T` misses grandchildren whose parent has exited. Raw therefore starts hooks, variable providers, MCP stdio servers and the ACP child through a small job launcher: `src/platform/job-launcher.cs`, compiled on first use with the .NET Framework C# compiler that ships with Windows and cached as `<state dir>/bin/raw-job-<hash>.exe`. The launcher puts itself in a Job Object with kill-on-close and without breakaway (Cygwin/MSYS would otherwise move every child it starts out of the job) and runs the command, which Raw has already quoted, from base64 arguments; stopping the launcher, or the command exiting, ends every process left in the job. When the compiler is missing or the build fails, Raw logs once and stops trees with the system `taskkill.exe /T` instead (`src/platform/windows.ts`).

## Agent session loop

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> running: run(user text)
    running --> idle: completed / max_steps / error
    running --> cancelling: abort
    cancelling --> idle: cleanup + linked results
    idle --> compacting: explicit compact
    compacting --> idle: complete / rollback
    idle --> closing: close
    running --> closing: close + abort
    cancelling --> closing: close
    closing --> closed: cleanup
```

Each `run` appends one user message and makes at most `maxSteps` inference requests. Assistant text deltas may be shown immediately. A completed assistant response is committed only after its stream finishes. A tool request on the last permitted step ends as `max_steps` before committing declarations or executing tools. Otherwise the assistant's whole call batch is committed, then calls are dispatched in declared order. Matching results, including malformed-argument, unknown-tool, denial and cancellation errors, are appended before another inference request. One `bash` tool call runs one command; a nonzero exit is reported in its status line, not as a tool error. A timeout or abort stops the command's process group.

`text_delta`, `reasoning_delta`, `tool_call`, `tool_start`, `tool_result`, `usage`, `compact_start`, `compact_end`, `compact_error`, `compact_warning`, and one `run_end` are host events. `tool_call` announces each committed declaration before validation; `tool_start` is emitted after authorization and directly before execution. Denied calls have a declaration and result, without an execution-start event. Image bytes are kept in the model transcript but removed from public `tool_result` events. Abort during inference leaves the pending user message and earlier completed history intact; partial assistant deltas are not committed. Abort during a batch retains already completed results and appends `cancelled` results for every unresolved call. A later run appends new user input to this valid transcript; it never replays side effects. A session rejects another run while busy, and closed sessions reject all new work. Separate sessions own separate cwd, transcript, controller and usage state.

Event payloads are detached snapshots. A renderer cannot mutate authorized arguments, usage or committed tool results. A renderer exception aborts the active turn, fills unresolved call results as cancelled, and returns `event_handler_error`; the agent attempts `run_end` once. An exception from the terminal event sink cannot cause a second terminal event or rewrite the completed run result.

`raw` has full permissions of its invoking OS account. Session cwd resolves relative file paths and shell working directories, without limiting access to absolute paths. Approval and whitelists decide which registered handlers raw will dispatch; they are not OS isolation mechanisms.

## Session agents

The hosts (dashboard operations, the CLI and the REPL) run turns through one narrow interface, `SessionAgent` (`src/backends/types.ts`): start, run, run a panel action, compact, abort, close, usage stats, context size and tool identity/display. `AgentSession` (Raw's own loop) is one implementation; an agent with a `backend` block is run by an external CLI backend that implements the same interface ([backends](backends.md)). `createSessionAgent` (`src/backends/factory.ts`) picks the implementation; a session runtime without a Raw model config supplies its own `measure` for the dashboard metrics.

An ACP backend (`src/backends/acp-agent.ts`) runs inside an `AgentSession` as its provider: `AcpBackendProvider` (`method: "acp"`) turns each request into one `session/prompt`, so input commit, queued delivery, visible history, cancel and the single `run_end` are Raw's loop unchanged. The CLI's own tool calls travel through `ProviderRequest.onExternal`; the loop records them like its own and never executes them. Each runtime owns one adapter process (`spawnAcpPeer`, `src/acp/peer.ts`: its own process group on POSIX, a job on Windows, a 16 MiB frame limit).

Lifecycle of a turn:

- Start, under the `request_timeout_ms` deadline: spawn if needed, `initialize`, then `session/load` when the session's `external` record (runtime metadata) has the same backend kind and profile digest (kind, executable, system prompt, prompt mode) and the CLI can load; otherwise `session/new`, the configured model, effort and mode, and the baseline captured from the CLI's options. Updates that replay a loaded conversation are not recorded again. A fresh conversation in a session that had turns gets the notice "This <CLI> conversation starts here; it does not see earlier turns".
- Options: per turn, the override or else the baseline, applied model → effort → mode against the list the CLI shows at that moment; a value it does not list is reported as a `backend_notice` and the turn runs.
- Prompt: only messages the CLI has not been sent (`external.delivered`), so the input of a cancelled turn is not sent twice. An inactivity watchdog (`request_timeout_ms`) is paused while a permission request waits on a person.
- Cancel and the watchdog send `session/cancel`, wait up to 5 s for the answer, then stop the whole tree; a crash ends the turn `backend_exited` with the stderr tail. The next turn starts a new adapter and loads the conversation. A turn starts only after the previous one stopped its adapter.

| ACP `session/update` | Raw |
| --- | --- |
| `agent_message_chunk`, `agent_thought_chunk` | `text_delta`, `reasoning_delta` |
| `tool_call`, `tool_call_update` | `tool_start` once the input is known, one `tool_result` at `completed`/`failed` (content text, `Edited <path>` for diffs, terminal output from `_meta`); identity `cli:<kind>/<name>` |
| `plan` | `reasoning_delta` lines `[x]` / `[ ]` |
| `usage_update`, prompt `usage` | context measure (`source: "provider"`), `usage` (input includes cache reads and writes) |
| `config_option_update` | the runtime's option list |
| `notice` | `backend_notice` (recorded) |
| `available_commands_update`, `session_info_update`, `current_mode_update` | ignored |
| any other kind | dropped before the SDK, one stderr line per kind |

Permission requests go to the host's approval channel; without one, `auto_approve` allows and otherwise Raw refuses with a notice. `compact` answers `unsupported_backend`; a panel action runs in Raw, and the CLI hears of it with the next prompt.

Raw's own tools reach Claude Code and Codex through the bridge (`src/backends/bridge/`): a loopback MCP server per runtime with a random token, which the CLI starts through `raw __bridge-proxy` (stdio). A bridged call runs inside the active turn through `ProviderRequest.runTool`, the same dispatch path as Raw's loop (rules, approvals, panels, `ask_user`, output cap), one call at a time.

`agy` (`src/backends/agy.ts`) has no ACP mode: `AgyBackendProvider` runs `agy` once per turn in print mode with stream-json on stdin and stdout (`spawnLinePeer`), continues the conversation with `--conversation`, and maps its events in `src/backends/agy-events.ts`. The agent's prompt and tool list go into an agent file in agy's plugin directory, named by its content. `agy models` is read once per runtime to check model and effort; a value agy refuses at run time is dropped and the turn runs again once.

The dashboard lists a backend's model, effort and mode before a session runs by asking the CLI once per dashboard process and agent setup (`src/backends/discovery.ts`: a throwaway `session/new`, or `agy models`); a running session lists what its own CLI conversation offered last, kept in its `external` record (`offered`). Both are display only: the runner checks a chosen value at turn time.

## Runtime variables

Variable definitions are validated config; the runtime-tools instance owns its resolver and TTL cache. CLI and ACP use the same plugin context service. Session storage owns history but never stores a separate variable cache or expanded env bindings. Definitions remain fixed within a runtime; restart/resume loads current definitions. File/env/provider values are read lazily. This adds no session schema revision.

## Portable package resolution

`raw-package.json` and `.rawpkg` archives are data contracts. Install/link/update writes a per-config atomic alias index and publishes content-addressed artifacts outside session state. `loadConfig` resolves only the selected agent and its referenced package exports into the existing runtime config. Selected tools and skills are then loaded by the ordinary registry/catalog paths; package tool helpers use immutable snapshots. Vars and MCP definitions pass through the existing validators and startup paths. The package release label and installation path are provenance, while effective prompt/schema/source bytes determine runtime transitions. Session history remains canonical and the current selection wins on resume. Package commands and agent binding avoid provider/plugin/MCP/session initialization.

## Local dashboard adapter

The loopback HTTP host authenticates commands and fetch-SSE with one process token.
`SessionOperations` owns durable request receipts and writer leases across runtime
attachment, inference/compaction and MCP cleanup. Disconnecting a browser affects
its observer only. Reconnect replays bounded events or replaces transient state
with a history-watermarked snapshot; it never submits a prompt again. Each new
operation attaches the current config and immutable selected source snapshots.

The React application renders structured history/tool/compaction views, not terminal
output. History pagination, usage estimates and the active model summary remain
separate projections. Browser appearance/navigation preferences never enter the
model request or become an additional Raw config layer. Lazy CodeMirror assets are
bundled locally, with a per-document style nonce under the host content policy.

Management routes call shared revision-aware config/component services. Static
catalogs and package operations remain passive. Explicit var/MCP checks own their
signals, deadlines and cleanup independently from chat operations. Package upload
staging validates an immutable artifact before installation; activation separately
writes recipient bindings. Dirty drafts and stale revisions are UI state, while
config files, component files and the package lock remain authoritative.

The build ships `dist/dashboard` with the CLI. Installed qualification packs Raw,
installs it into an unrelated consumer, configures it through the browser, reloads
an active real tool, updates a package, and resumes the same ID with the installed
CLI. No source-server test substitutes for that artifact path. See the
[dashboard API](dashboard-api.md). Contributors record qualification in the
repository's `docs/evidence/local-dashboard.md`.

Structured input belongs to the host-scoped interaction service. Agent dispatch binds the service to the current session/run/call, declared view, signal and output budget, and forwards only `context.interactions.request` to local plugin handlers. Dashboard responds through durable CAS routes; TTY, library and negotiated ACP callbacks return the same scoped submission and use the same canonical answer validator. Agent-owned callback services close with their agent; injected host services outlive per-turn runtime attachment. `ask_user` is a bundled caller of this API and has no dispatcher or UI special case.
