# Persistent sessions, history, and resume

## Plan schema
loop-plan/v1

## Target
Make `raw` sessions survive CLI/ACP process exit. Users can list sessions by workspace, resume a prior coding conversation, and page through its full user-visible history. Persist the exact active model context needed for the next request, reclaim obsolete detail after a successful compact, and delete inactive sessions after configurable `sessions.retention_days` (default 7). A future chat UI must be able to fetch the newest 20 history items and then fetch older items without loading an entire session.

## Scope
- One global, local SQLite database under `$XDG_STATE_HOME/raw/sessions.sqlite` or `~/.local/state/raw/sessions.sqlite`; it indexes workspaces and sessions. Large active-context payloads may live under the same state directory as referenced files so a single tool result cannot permanently inflate the SQLite file. This is still one global store, not a database in each project.
- Persist new one-shot, REPL, and ACP sessions; add CLI session list, resume, history, delete, and storage statistics; add standard ACP list/load/resume/delete. Expose a small library history API usable by a later chat UI. The chat UI itself is outside scope.
- Store session context and display history separately. Display history preserves what the user actually saw through that session's surface: complete user/assistant text, CLI tool arguments as printed (including full Bash arguments), CLI result previews, visible reasoning, and ACP tool input/output updates as sent. Keep timestamps and interrupted/error statuses. Coalesce streaming text into logical display messages rather than retaining one event or full snapshot per token. Retain provider opaque blocks, tool linkage, and full tool content needed for model continuation only while they are part of active model context; content already visible in history is independently retained until session expiry.
- A successful compact atomically installs the new model context and releases detailed payloads no longer referenced by either active context or visible history; older display history remains pageable. Failed, cancelled, `noop`, and `not_smaller` compactions leave durable context and old payloads intact.
- `sessions.retention_days` is global, a positive integer, default 7. The canonical global `$XDG_CONFIG_HOME/raw/config.json` (or `~/.config/raw/config.json`) alone controls retention for the global DB; an alternate `--config` controls model/profile selection but cannot override this global setting. Expiry is measured from the last committed conversational activity, not creation, list, page view, or process launch. Expired sessions are invisible to list/resume and are deleted with dependent data by an opportunistic cleanup pass. An actively owned session is not deleted until it closes. No pin exemption is part of this version.
- No compatibility parser for pre-release session/config formats. Do not alter model-facing tools or insert storage rules into the system prompt.

## Invariants
- A session has one active writer across processes; different sessions may run concurrently. CLI/ACP disconnect cancels work and releases runtime resources, but does not erase committed history.
- Never replay or automatically execute an interrupted tool call on resume. A recovered pending call has an explicit uncertain/interrupted result and valid assistant/tool linkage; the user can inspect the workspace and issue a new prompt.
- A committed model-context sequence is sufficient to reconstruct the next provider request exactly when model, system prompt, tool schema, and endpoint are unchanged. Preserve the session cache key across process restarts; provider cache hits remain best effort. Compact deliberately changes the message prefix once.
- History pagination reads only one bounded page. No read/list request renews the seven-day expiry. No history deletion or blob reclamation is allowed before the replacement compact checkpoint commits. Garbage collection cannot unlink a file owned by a live writer before its DB reference commits.
- Credentials, live MCP connections, ACP peer callbacks, process handles, and approval callbacks are never serialized. Re-resolve credentials on resume. DB/state directory permissions are private to the user.
- `cwd` and profile rules still confer full local OS permissions as today; persistence does not add a sandbox or a new permission prompt.

## Baseline
- `src/agent.ts:48` owns in-memory `messages`, `originalTask`, `summaryText`, raw usage, random `cacheKey`, fixed schema view, run/compact state, and cancellation. It appends assistant tool declarations before dispatch and then tool results. `clear()` currently erases the in-memory transcript.
- `src/compact.ts:80` builds a validated smaller replacement from original task, summary, and retained complete turns. `src/agent.ts:139` installs it only on success; cancellation/failure does not replace the transcript.
- `src/cli.ts:188` creates one in-memory session per process. It connects selected MCP servers, handles one-shot/REPL, `/clear`, `/compact`, signals, and final cleanup. `bin/raw.ts:18` and `src/config.ts:575` own CLI syntax; `src/config.ts:497` resolves one selected profile.
- `src/acp/methods.ts:143` keeps peer sessions in a Map. It implements `session/new`, `session/prompt`, `session/cancel`, and raw extensions, but no persistent `session/list`, `session/load`, `session/resume`, or `session/delete`. `docs/acp.md:1` states no persistence.
- `src/llm/cache.ts:112` uses a stable per-session key where the upstream method supports it. `src/llm/types.ts:62` has typed user, assistant, tool, image, resource-link, and opaque provider content that cannot be reconstructed from CLI display output.
- ACP SDK 1.5.0 local declarations define `loadSession`, `sessionCapabilities.list/resume/delete`, `session/list` cursor, `session/load` replay semantics, and `session/resume` without replay in `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`. Existing CI covers macOS/Linux with Node 22/24 in `.github/workflows/ci.yml`.
- Git baseline: clean `main`, head `48184b4`. No SQLite/session store currently exists. Prior project phases and package tests passed; this plan adds new behavior.

## Design and project patterns
1. **Storage model.** Add `src/sessions/store.ts` and schema/migration module. Tables: `workspaces` (stable ID, canonical/display path), `sessions` (ID, workspace ID, title, timestamps, profile/config identity, model/endpoint identity, effective system prompt, cache key, active owner/lease generation), `history` (session ID + monotonically increasing sequence, timestamp, visible kind/payload/status), and `model_context` (session ID + ordered position, canonical `ModelMessage` payload). Add a schema version. Index `(workspace_id, updated_at DESC, id DESC)`, `(updated_at DESC, id DESC)`, and `(session_id, sequence DESC)`. Store a compact summary/original task, effective ordered tool selection/schema digest, and usage aggregate with the session or active context. No append-only full-snapshot event table.
2. **Payload size and safe publication.** Persist exactly the CLI/ACP data actually exposed, without introducing a new display cap. CLI tool results already have a 10-line/~2,000-character preview, but Bash arguments and ACP `rawInput`/`rawOutput` can be larger and must remain viewable after compact. Place large display or model-context fields over a documented threshold (proposed 64 KiB) in referenced files under the state directory; rows contain IDs/length/checksums. Stage each file under its writer's live owner token, fsync, publish the DB reference transactionally, and only then make it eligible for reclamation. An orphan sweep skips every live writer's staging and published files, checks references and owner liveness before unlinking, and later reclaims abandoned files after writer death. Reuse references for the same content when both active context and visible history need it; never copy a large `write_file` argument, Bash result, diff, or image into repeated event snapshots. A deterministic interleaving test must cover sweep while a writer is paused between file creation and DB commit.
3. **Context and history ownership.** `AgentSession` remains the sole owner of provider-facing transcript state. Add an explicit, validated hydrate/export or persistence-hook API. The store owns append/compact transactions; the CLI renderer and ACP notifier provide the actual visible projection through a shared surface-aware formatter rather than becoming the source of model context. Preserve complete Bash arguments, visible reasoning and ACP raw tool updates; keep the current CLI result-preview behavior unchanged. Coalesce streamed assistant/reasoning text into one display record per logical message; on graceful cancel/provider error flush the partial visible text with `interrupted`/`error` status without fabricating a successful model response. Hard process death may lose only the last unflushed display fragment; committed model/tool transitions remain recoverable. Persist provider opaque items, raw tool arguments/IDs/results, original task, current summary, token calibration, schema revision, effective selected tool aliases and ordered schema digest, and cache key while active. Derive a session title from the first user prompt locally, without an extra LLM request.
4. **Tool crash boundary.** Before dispatch, durably record the assistant declaration and pending call IDs. After each tool returns, durably record its result before starting the next command. If the process dies after a side effect but before the result commit, recovery marks that call `outcome_unknown` and all remaining declared calls cancelled; it never reruns them. This is at-least-once observation with no automatic re-execution, not an impossible exactly-once shell guarantee. New prompts require the user/agent to inspect the workspace.
5. **Per-session ownership.** Claim a session with a short SQLite transaction and an owner token/generation plus heartbeat. A second writer gets a busy error. Every write checks the generation, and losing ownership aborts the agent before a later tool dispatch. Crash recovery may reclaim an expired owner only after checking the owner process is gone where available; ambiguous ownership fails closed. Do not hold a global SQLite write transaction over inference or Bash. Readers/listing remain independent. Cancelling an operation keeps ownership if the CLI REPL or ACP session remains attached and reusable; release only after pending work and durable writes settle on session close or peer/process disconnect.
6. **Resume compatibility.** On load, recover the saved config path/profile; re-resolve current credentials, reconnect selected MCP servers, and recreate registry/approval callbacks. Reject a changed model ID, wire method, provider, endpoint, or missing cwd/config with a clear error; never silently use the current default profile. The effective saved system prompt and cache key are restored. Rebuild the registry, apply the saved selected aliases before computing the ordered schema digest, and expose no tool outside that selection. If selected tools are missing or schemas changed, report an explicit schema/cache boundary; unavailable aliases stay unavailable until reselected/re-registered. A compatible unchanged selection must yield byte-identical next-request tool definitions. Never execute a historical ACP callback as if it were still registered. No credentials or executable callback definitions are persisted.
7. **User commands.** `raw sessions [--all] [--before CURSOR]` lists current workspace or all workspaces in bounded pages and prints the opaque next cursor; `raw sessions show ID` prints the latest 20 display items, `raw sessions show ID --before CURSOR` loads older items, `raw sessions delete ID` deletes one inactive session, and `raw sessions stats` shows counts/bytes. List rows include ID, local title, workspace, profile/model, updated time, and expiry; no provider request is made for titles. `raw --continue [task]` resumes the latest session in the current workspace; `raw --resume ID [task]` resumes a selected ID using its stored cwd, showing that cwd. With no task, resume enters REPL and renders the latest 20 items; with a task it prints only the new response. REPL `/clear` starts a new saved session and leaves old history intact. Resume conflicts with a different explicit `--profile` or `--config` rather than switching identities silently.
8. **ACP and future UI.** Advertise standard `loadSession` plus `sessionCapabilities.list/resume/delete`. Implement `session/list` with opaque keyset cursor and optional exact cwd filter, `session/load` with stored display-history replay as `session/update`, `session/resume` without replay, and `session/delete`; respect SDK request `cwd` and `mcpServers`. Keep standard ACP updates for live work and raw extensions for optional capabilities. A library `listSessions`, `getSessionHistory({sessionId,before,limit})`, `resumeSession`, and `deleteSession` under `src/index.ts` supports future chat pagination without loading the full transcript.
9. **Retention authority and maintenance.** Read `sessions.retention_days` only from the canonical global config path, independently of any per-run `--config` profile file. A noncanonical config containing a `sessions` block fails with a clear global-setting error; it cannot silently override shared retention. Re-read the canonical value for each expiry/list/cleanup operation so a long-lived ACP process cannot keep a stale value. On startup/list/resume, filter expired rows immediately; schedule a bounded cleanup pass during idle/startup and periodically in a long-lived ACP process. Delete session rows, referenced payloads, and stale leases together; clean only orphan files whose owner is confirmed dead; checkpoint WAL and reclaim SQLite free pages only when idle and worthwhile. `sessions stats` reports DB/WAL/payload bytes and per-session heavy data. Avoid full `VACUUM` on every launch.

## Global Gates
- Before each implementation phase, add or update the named documentation and failing tests, then implement. Keep changes within that phase's boundary; review the diff before committing. Do not modify user credentials or use live DeepSeek/Vast requests in tests.
- All tests using session persistence set a temporary `XDG_STATE_HOME`; `scripts/test.mjs` and spawned process fixtures must never touch the user's real state DB. Use mock providers/MCP and deterministic clocks where possible.
- Every phase runs `npm run typecheck && npm test`; final phase also runs `npm run build && npm run test:package && npm run test:overhead`. Run Node 22 and Node 24 CI matrix before completion. `node:sqlite` requires Node >=22.13.0; update `engines.node` and verify its experimental API/packaged entrypoint on the minimum version. If that runtime gate proves unsuitable, resolve the driver decision before implementation rather than silently introducing a native dependency.
- Review each implementation phase with GPT-6 Astra, as previously requested by the user; verdict must be APPROVE before its commit. No production code is written during this planning turn.
- Docs must state privacy/retention semantics, inspectable history limits, exact resume compatibility rules, loss of full pre-compact tool outputs, and the fact that cache hits are provider controlled.

## Plan Review
APPROVE — GPT-6 Astra reviewed four rounds. Seven original plan defects and one contradictory Phase 3 sentence were corrected; final structured verdict found no open issues. Current CLI/ACP-visible reasoning and tool data remain viewable after compact; only obsolete model-only detail is pruned. Implementation assumptions: `--continue` is scoped to current cwd; explicit `--resume ID` uses stored cwd; no pin exemption in v1.

## Phase 1: Global store, config, and pageable history
### Status
complete
### Goal
Create the SQLite storage boundary, strict global retention config, and indexed session/history APIs without connecting them to the agent.
### Current behavior and gap
`src/config.ts` accepts only models/profiles/MCP at the root; no state path, DB, metadata index, or history query exists.
### Evidence
`src/config.ts:158`, `src/config.ts:446`, `src/config.ts:497`; `src/index.ts:1`; `tests/config-v2.test.ts`; `.github/workflows/ci.yml`.
### Pattern
Follow strict key validation and typed exported APIs in `src/config.ts`, isolated temporary homes in tests, and private file creation like `bin/raw.ts:54`.
### Dependencies
None.
### Files and symbols
`src/config.ts` (`parseDocument`, `RuntimeConfig`), new `src/sessions/store.ts`, `src/sessions/schema.ts`, `src/index.ts`, `package.json`, `scripts/test.mjs`, `docs/configuration.md`, `docs/architecture.md`, `tests/session-store.test.ts`, `tests/config-v2.test.ts`.
### Behavioral contract
One private global DB; strict `sessions.retention_days` positive integer, default 7; stable workspace/session IDs; create, list with keyset cursor, get latest 20 history items, page older with `before`, append ordered display items, delete with cascades; no N+1 file scans; no profile needed to list. Future UI can call the same library API. Reject malformed/foreign cursors and unsupported schema versions deterministically.
### Documentation
Document DB location/permissions, schema ownership, history pagination, expiry meaning, and no migration for unreleased data.
### Tests first
Create many workspaces/sessions with equal timestamps, verify stable page order and no duplicates/omissions; save >40 items and page 20/20/remainder; check config defaults/invalid values, canonical-vs-alternate config authority and conflicting-config rejection, DB mode, unknown schema, concurrent independent reads, and temp-state isolation.
### Anti-shortcut coverage
A test with 1,001 sessions and duplicate `updated_at` values must still return deterministic bounded pages via `(updated_at,id)`; a test with 41 history items must prove older records are stored rather than discarded at 20.
### Implementation obligations
Use prepared indexed queries and transactions, version schema, choose `node:sqlite` with minimum runtime gate, expose explicit store methods, and avoid storing rendered stream deltas as events.
### Acceptance criteria
- [x] AC-1.1: Strict canonical global config accepts omitted/default 7 and valid positive `sessions.retention_days`; invalid values and noncanonical files attempting to set it are rejected, and conflicting `--config` files cannot change global expiry — proven by config/store tests.
- [x] AC-1.2: 1,001 mixed-workspace sessions list in stable bounded pages, exact cwd filter and global listing — proven by store tests and index inspection.
- [x] AC-1.3: Newest 20 history items and older cursor pages recover all 41 ordered items without scanning/loading the entire history — proven by store tests/query inspection.
- [x] AC-1.4: Tests, including spawned packaged-entrypoint tests, never create a DB in the real user's state directory — proven by temp-state tests/inspection.
### Focused verification
`node --import tsx --test tests/session-store.test.ts tests/config-v2.test.ts`
### Phase gates
`npm run typecheck && npm test`
### Review
Implementation review is required with GPT-6 Astra; verdict must be APPROVE.
### Commit
`feat: add global session store and history paging`

## Phase 2: Durable agent context, compact, and crash recovery
### Status
complete
### Goal
Connect canonical agent transitions to durable state while preserving exact provider replay and safe recovery.
### Current behavior and gap
`AgentSession` mutates in-memory transcript, key, summary, usage, and tool state; `compact()` installs an in-memory replacement. Rendering events cannot recover opaque/provider content.
### Evidence
`src/agent.ts:48`, `src/agent.ts:139`, `src/agent.ts:208`, `src/agent.ts:330`, `src/compact.ts:80`, `src/llm/types.ts:62`, `tests/agent-lifecycle.test.ts`, `tests/compact.test.ts`, `tests/auto-compact.test.ts`.
### Pattern
Preserve existing idle/running/compacting state machine and complete-turn compaction. Introduce typed durable transition hooks or validated hydration inside the agent layer; do not serialize CLI output.
### Dependencies
Phase 1 store/API.
### Files and symbols
`src/agent.ts` (`AgentSession`, `run`, `compact`, `clear`), `src/compact.ts`, `src/sessions/store.ts`, new `src/sessions/restore.ts`, shared display formatter extracted from `src/cli.ts`, `src/llm/types.ts` only if typed state needs it, `docs/context.md`, `tests/session-agent.test.ts`, `tests/session-process.test.ts`.
### Behavioral contract
New user input, accepted assistant response, tool declaration, every tool result, cancellation, and compact checkpoint have durable boundaries. Gracefully interrupted visible text/reasoning is flushed into display history with an incomplete status, without entering model context as a successful assistant message. A new process restores original task, summary, active `ModelMessage` order, opaque blocks, usage aggregate, token calibration, cache key, and effective selected tool view/schema identity. A compact transaction changes only active model context and releases only full payloads that neither active context nor visible history references; display history still pages with all previously shown content. Crash recovery fills pending call linkage with `outcome_unknown`/cancelled records and never dispatches those calls automatically. No provider call is made merely to list/load history.
### Documentation
Describe recovery uncertainty, model context vs visible history, and prefix/cache behavior across resume and compact.
### Tests first
Round-trip text, resource link, long visible Bash arguments, CLI tool-result preview, ACP raw tool input/output, visible reasoning, image/opaque Responses block, cache key, selected tool view, summary and usage through a new AgentSession; inject failure before/after each commit seam; cancel/error after several streamed text deltas and verify incomplete display history after restart; kill a process during Bash and assert no repeated side effect; pause a writer after staging a large payload while another process runs orphan maintenance, then commit and restore it; compact success/failure/abort and verify retained display pages and active context exactly.
### Anti-shortcut coverage
An interrupted side-effecting Bash increments a marker at most once across crash+resume; a restored provider request is deeply equal to the pre-exit expected request, including selected tool definitions, tool IDs/opaque state and cache key. Long Bash arguments, reasoning, and ACP raw results remain in history after compact, while gracefully interrupted streamed text remains marked incomplete. The staged-file race test rejects an orphan sweep that blindly deletes unreferenced files. This rejects serializing only final text or relying on a final `run_end` save.
### Implementation obligations
Await durable declaration before tool dispatch and durable result before next dispatch; guard writes with owner generation; hydrate through a validated API; preserve existing cancellation and compact rollback; coalesce visible stream fragments and finalize them on graceful error/cancel; stage large payloads under protected live-owner namespace and remove only dead-owner or safely unreferenced files after commit.
### Acceptance criteria
- [x] AC-2.1: Restored next request equals the saved context including opaque/provider blocks, tool linkage, effective selected tool definitions, system/tool prefix, and cache identity when runtime is compatible — proven by session-agent tests.
- [x] AC-2.2: A crash before a tool-result commit never re-executes the tool and leaves an explicit uncertain result; a crash after commit retains the result — proven by subprocess tests.
- [x] AC-2.3: Successful compact preserves actual CLI/ACP-visible history, including long args/reasoning/raw ACP result, while model-only old payloads are reclaimed; failed/aborted/non-shrinking compact preserves durable state — proven by fault-injection and compact tests.
- [x] AC-2.4: Simultaneous writers to one session reject the second, while two different sessions can progress — proven by cross-process ownership tests.
- [x] AC-2.5: Cancelled/error streaming leaves one incomplete display record, and concurrent orphan sweep cannot remove a live writer's unpublished payload — proven by cancellation and deterministic two-process staging tests.
### Focused verification
`node --import tsx --test tests/session-agent.test.ts tests/session-process.test.ts tests/compact.test.ts tests/auto-compact.test.ts`
### Phase gates
`npm run typecheck && npm test`
### Review
Implementation review is required with GPT-6 Astra; verdict must be APPROVE.
### Commit
`feat: persist agent context and recover interrupted sessions`

## Phase 3: CLI session list, resume, and terminal history
### Status
complete
### Goal
Give local users explicit session discovery, resume, history paging, and deletion without a resident daemon.
### Current behavior and gap
`raw` starts a new in-memory session every invocation; `/clear` erases it; process exit loses conversation. CLI argument parser supports no session commands.
### Evidence
`bin/raw.ts:18`, `bin/raw.ts:117`, `src/config.ts:575`, `src/cli.ts:188`, `tests/repl.test.ts`, `tests/cli.test.ts`, `tests/package.test.ts`.
### Pattern
Keep `bin/raw.ts` as command dispatch and `src/cli.ts` as one renderer; resolve persistent session before connecting MCP and constructing the agent. Preserve signal and TTY approval behavior.
### Dependencies
Phases 1–2.
### Files and symbols
`bin/raw.ts` (`help`, `run`), `src/config.ts` (`parseCliArgs`, `RawFlags`, `CliCommand`, `loadConfig`), `src/cli.ts` (`runCli`, `textRun`), `src/index.ts`, `docs/cli.md`, `README.md`, `tests/session-cli.test.ts`, `tests/repl.test.ts`, `tests/package.test.ts`.
### Behavioral contract
`raw "task"` and `raw` create durable sessions; `raw --continue [task]` finds the latest unexpired session for current workspace; `raw --resume ID [task]` uses saved cwd/config/profile. `raw sessions [--all] [--before CURSOR]` lists bounded pages and prints a next cursor; `show` loads latest 20 and older cursor pages; `delete` refuses active session; `stats` reports storage. No-task resume displays latest 20 then REPL; task resume emits only new output. `/clear` begins a new saved session. SIGINT cancels the current operation but keeps ownership while the REPL remains open; exit releases it. No hidden prompt/tool change or extra approval.
### Documentation
Add exact syntax/examples, cwd/profile mismatch errors, retention notice, history display limits, and exit behavior.
### Tests first
Spawn separate CLI processes against a temporary DB/mock provider; verify one-shot then resume, latest-current-workspace selection, explicit cross-workspace ID, list continuation past the first page, view/history page, `/clear` creates a second session, profile mismatch fails before model/tool work, and SIGINT during a run retains the claim/history while REPL continues. After restart and compact, `raw sessions show ID` must reproduce a long Bash argument exactly as originally printed. Exit then releases the claim.
### Anti-shortcut coverage
Two workspaces with different latest sessions must prove `--continue` selects the current workspace, while explicit ID uses stored cwd. List pages beyond the first must expose an ID that can be resumed. Restarting the process must preserve the tool history in the next model request; REPL output alone is insufficient.
### Implementation obligations
Select/configure before MCP connection; reopen runtime resources on resume; release ownership/clients in `finally`; keep commands read-only where appropriate. `show` faithfully renders stored visible content, including complete Bash arguments; list metadata and diagnostic errors must not expose credentials that were never part of visible history.
### Acceptance criteria
- [x] AC-3.1: One-shot/REPL sessions can be listed and resumed in another process, with stored cwd/profile/model context — proven by spawned CLI tests.
- [x] AC-3.2: CLI session-list and newest-20 history cursors traverse all stored entries; `show` reproduces long previously displayed Bash arguments after compact/restart, an ID found beyond the first list page resumes, and `--continue` is workspace-scoped — proven by CLI/store tests.
- [x] AC-3.3: `/clear` leaves old session visible and starts a new ID; explicit deletion removes only an inactive selected session — proven by REPL/CLI tests.
- [x] AC-3.4: SIGINT during a REPL operation cancels only that operation, rejects a competing writer, and allows another prompt in the original REPL; SIGTERM/exit then release ownership/MCP resources without dropping committed messages — proven by process tests.
### Focused verification
`node --import tsx --test tests/session-cli.test.ts tests/repl.test.ts tests/cli.test.ts`
### Phase gates
`npm run typecheck && npm test`
### Review
Implementation review is required with GPT-6 Astra; verdict must be APPROVE.
### Commit
`feat: add CLI session listing and resume`

## Phase 4: Standard ACP persistent session lifecycle
### Status
complete
### Goal
Let an IDE or parent agent list, load/replay, resume, and delete persisted sessions through standard ACP.
### Current behavior and gap
ACP advertises no persistence and uses a per-peer Map with only `session/new`, `session/prompt`, and `session/cancel`.
### Evidence
`src/acp/methods.ts:143`, `src/acp/methods.ts:181`, `src/acp/methods.ts:193`, `src/acp/methods.ts:233`, `src/acp/transport.ts`, `docs/acp.md`, `tests/acp.test.ts`, ACP SDK declarations noted in Baseline.
### Pattern
Use the installed SDK's typed standard methods/capabilities and existing `session/update` mapping. Keep per-peer runtime ownership while durable store is global.
### Dependencies
Phases 1–3.
### Files and symbols
`src/acp/methods.ts` (`createAcpServer`, `SessionRecord`, `toolUpdate`), `src/acp/client.ts` if parent helper needs methods, `src/acp/transport.ts` only if lifecycle tests show a gap, `docs/acp.md`, `examples/parent-agent.ts`, `tests/session-acp.test.ts`, `tests/acp.test.ts`, `tests/acp-transport.test.ts`.
### Behavioral contract
Advertise and implement `session/list` with `cwd` filter and opaque cursor; `session/load` replays stored user-visible history through standard updates, including the ACP raw tool fields originally sent, then allows prompt; `session/resume` attaches without replay; `session/delete` removes inactive persisted session. SDK `cwd` must match the stored cwd, and selected MCP definitions are reconnected for this peer. Persist `_raw/session/configure` selected aliases; on restart reapply the same selection before computing the provider-facing ordered schema. A changed/missing alias is reported and never broadens exposure. `session/cancel` aborts only the current operation and retains the peer's claim for its next prompt. An ACP disconnect aborts active work, settles writes, and releases claims but does not delete durable sessions. A new peer may resume after old owner closes; simultaneous peers cannot both write one session. Ephemeral reverse tool callbacks are not deserialized or invoked from historical records.
### Documentation
State precise capability flags, replay vs resume semantics, expiry, peer ownership, and tool-schema/cache boundary when a resumed peer changes tools.
### Tests first
Run standard ACP client across two server lifetimes; list/load/replay/prompt with long raw ACP tool input/output, resume without replay, delete, pagination, cwd mismatch, active busy, disconnect/cancel, and dynamic tool re-registration without replaying an old callback. Persist `_raw/session/configure` selecting one of two available tools, restart, and assert the next request includes exactly that tool. Test cancel → competing resume rejected → another prompt by the original peer. Check stdio/WebSocket transcript parity.
### Anti-shortcut coverage
Close the first ACP process and create a new server object: `session/load` must replay the same display history and then continue from exact active model context. `session/resume` must emit no historical updates. This rejects retaining only the old Map.
### Implementation obligations
Use SDK methods and capabilities rather than custom raw stand-ins; validate peer/cwd ownership; reconnect MCP; keep standard live update order; close and release resources on every error path.
### Acceptance criteria
- [x] AC-4.1: Standard ACP client lists, pages, loads with faithful replay of visible raw tool fields, resumes without replay, and deletes persisted sessions across process restart — proven by session-acp tests.
- [x] AC-4.2: Mismatched cwd, concurrent owner, expired/unknown ID, and disconnected peer produce bounded explicit errors and no tool execution — proven by ACP tests.
- [x] AC-4.3: Existing cancel, permission, injected-tool, and transport behavior still pass with persistence — proven by ACP regression suite.
- [x] AC-4.4: A saved `_raw/session/configure` whitelist survives restart without exposing formerly excluded tools; operation cancel retains writer ownership until close/disconnect — proven by ACP restart/concurrency tests.
### Focused verification
`node --import tsx --test tests/session-acp.test.ts tests/acp.test.ts tests/acp-transport.test.ts`
### Phase gates
`npm run typecheck && npm test`
### Review
Implementation review is required with GPT-6 Astra; verdict must be APPROVE.
### Commit
`feat: support persistent sessions over standard ACP`

## Phase 5: Expiry, storage reclamation, and packaged qualification
### Status
complete
### Goal
Enforce seven-day inactivity retention and bounded storage behavior across CLI/ACP without making active work or startup unsafe.
### Current behavior and gap
No expiry, DB cleanup, state statistics, or packaged SQLite qualification exists. SQLite deletion alone may leave reusable free pages and WAL sidecars.
### Evidence
`src/config.ts:158`, `src/cli.ts:188`, `src/acp/methods.ts:143`, `scripts/test.mjs`, `tests/package.test.ts`, `.github/workflows/ci.yml`.
### Pattern
Reuse the store's transactional delete/cascade, existing process cleanup, and package/CI gates. Keep cleanup outside the LLM/tool path except cheap expiry checks.
### Dependencies
Phases 1–4.
### Files and symbols
`src/sessions/store.ts`, new `src/sessions/maintenance.ts`, `src/config.ts`, `bin/raw.ts`, `src/acp/methods.ts`, `scripts/test.mjs`, `package.json`, `.github/workflows/ci.yml`, `docs/configuration.md`, `docs/verification.md`, `tests/session-retention.test.ts`, `tests/session-process.test.ts`, `tests/package.test.ts`.
### Behavioral contract
At the seven-day default cutoff, a session with no committed activity expires; list/resume reject it even before physical cleanup. Viewing/listing does not extend TTL. Canonical global config alone determines the TTL even when a process uses `--config` for a different profile; long-lived ACP reloads the canonical value per operation. Cleanup skips live claims, deletes dependent history/context/payloads after claims release, sweeps only dead-owner crash orphans, and reports actual DB/WAL/payload bytes. Idle maintenance checkpoints/truncates WAL and reclaims free pages without running a full VACUUM during active work. Both Node 22.13+ and Node 24 packaged entrypoints work.
### Documentation
Explain automatic permanent deletion, exact inactivity clock, configurable duration, cleanup timing, storage statistics, and backup/export implications.
### Tests first
Use an injected clock to test cutoff at `N days - 1 ms` and exact boundary; verify reads do not renew, messages do renew, two processes with conflicting alternate config files still use canonical retention, active session survives until close, crash-stale claims recover safely, only dead-owner orphan payloads disappear, no leaked user state, and DB file can reclaim space after deleting large expired data.
### Anti-shortcut coverage
Create large pre-compact model-only and visible payloads across many compacted sessions: assert only model-only old payloads disappear while all visible history still pages; after expiry all related rows/payloads disappear and reported occupied bytes fall after idle maintenance. A mere `DELETE FROM sessions` without payload cleanup or free-space handling fails.
### Implementation obligations
Use bounded opportunistic cleanup plus periodic ACP maintenance, transactional expiry/deletion, idempotent orphan sweep, size-aware maintenance thresholds, and explicit process/driver compatibility errors; avoid unbounded startup scans.
### Acceptance criteria
- [x] AC-5.1: Authoritative canonical global `sessions.retention_days` defaults to 7; exact inactivity boundary excludes expired sessions, no read renews it, and alternate `--config` files cannot change the shared DB policy — proven by retention/config tests.
- [x] AC-5.2: Active sessions are not deleted; after close, expired history/context/payloads are removed and storage stats reflect reclamation — proven by retention/process tests.
- [x] AC-5.3: Node 22.13/24 macOS/Linux local matrix, package, and overhead gates pass with session storage enabled and isolated user state; CI workflow matches the matrix, but no remote Actions run is available because this checkout has no Git remote — proven by [verification evidence](docs/verification.md).
### Focused verification
`node --import tsx --test tests/session-retention.test.ts tests/session-process.test.ts tests/package.test.ts`
### Phase gates
`npm run check && npm run test:package && npm run test:overhead`
### Review
Implementation review is required with GPT-6 Astra; verdict must be APPROVE.
### Commit
`feat: enforce session retention and reclaim storage`

## Completion Criteria
- Users can list many sessions, resume an old one in another process, view its latest 20 history items, page backward, append new turns, and remove one session explicitly.
- Active model context after restart equals the committed pre-exit context, including tool/opaque content and stable cache key; compact safely reduces only that active context while visible history survives.
- Seven-day configurable inactivity retention permanently removes expired session data and large payloads; disk metrics and maintenance make growth observable and reclaimable.
- Standard ACP lifecycle methods work for IDEs; no daemon, extra model tool, prompt rule, secret persistence, or automatic replay of uncertain side effects is introduced.
- All phase acceptance checks, required reviews, test/CI/package gates, documentation, and commits are complete.

## Progress Log
- 2026-09-25: Phase 5 complete. Enforced exact canonical inactivity expiry, bounded session cleanup, indexed crash-safe payload staging/retirement, orphan-journal sweep, idle WAL/SQLite reclamation, and physical storage statistics. Regression tests cover active/dead claims, failed commits/unlinks, compacted visible history, and two-process policy authority. The four macOS/Linux × Node 22.13/24 local runtime gates passed on source SHA-256 `80f1b6a45908b802a01daaec0a44f289b492b09ccb9eff71818a122943c0d0e5` (278/278 tests and packed consumer 1/1 each); overhead remained 41/1,315 tokens. GPT-6 Astra returned APPROVE after all findings were fixed. The configured remote GitHub Actions matrix could not run without a Git remote; local equivalent evidence is in `docs/verification.md`.
- 2026-09-25: Phase 4 complete. Standard ACP list/load/resume/delete now use the global session store while live runtimes remain peer-owned. Load replays ordered visible history, including long raw tool fields; resume does not replay. Stored MCP selections survive restart, unavailable reverse callbacks are dropped with a cache boundary, and cancel retains ownership. Tests cover stdio/WebSocket parity, pagination, expiry, busy peers, early MCP claim, replay concurrency, and retained-schema validation. `npm run typecheck && npm test` passed (262 tests), `npm run test:package` passed. GPT-6 Astra returned APPROVE after three P2 fixes.
- 2026-09-25: Phase 3 complete. Added saved CLI one-shot/REPL sessions, workspace-scoped continue, explicit cross-workspace resume, list/show/delete/stats commands, bounded cursors, and library session APIs. Spawned process tests cover restart, paging, `/clear`, SIGINT/SIGTERM ownership, and complete Bash arguments after compact. Fixed crash-recovery display of `outcome_unknown` after Astra review; regression failed before the fix and passed after. `npm run typecheck && npm test` passed (253 tests), `npm run test:package` passed, and GPT-6 Astra returned APPROVE.
- 2026-09-25: Phase 2 complete. Agent transitions now commit user/assistant/tool state and visible projections, restore exact active context and selected schema, and recover pending calls without replay. Large payloads use private checksum-verified files with reference tracking; compact retains display history and reclaims model-only detail. Focused verification passed; `npm run typecheck && npm test` passed (245 tests), as did `npm run test:package`. GPT-6 Astra reviewed three rounds and returned APPROVE after fixes for reclamation/republication, JSON prototype safety, and persistence error reporting.
- 2026-09-25: Phase 1 complete. Added global private SQLite store, strict canonical retention config, stable IDs, bounded indexed cursors and history APIs. TDD red evidence covered missing store/config exports and three Astra review defects; the latter were fixed with regression tests. `npm run typecheck && npm test` passed (222 tests); `npm run test:package` passed after preserving `node:sqlite` in bundles. GPT-6 Astra final review: APPROVE, three findings resolved.
- 2026-09-25: Created plan from current conversation and CTXE-anchored repository evidence. No production implementation started. Awaiting user approval of the plan before `$loop-implement`.
- 2026-09-25: GPT-6 Astra round 1 returned REVISE with seven issues. Updated scope, invariants, design, and phase tests/contracts for exact visible-history fidelity; partial streams; live-writer payload staging; cancel-vs-close ownership; saved tool selection/schema; canonical global retention authority; and CLI list continuation. Prepared revised plan for re-verification.
- 2026-09-25: GPT-6 Astra round 2 resolved six issues and identified one remaining conflicting Phase 3 redaction sentence. Corrected `show` to reproduce stored visible content, restricted redaction to list metadata/errors, and added CLI fidelity test. Prepared for re-verification.
- 2026-09-25: GPT-6 Astra round 3 stated APPROVE in prose; runner could not parse a verdict-only response. Round 4 repeated the same APPROVE in parseable format with no open issues. Plan status updated to APPROVE; implementation still awaits the user's separate approval under the loop workflow.
