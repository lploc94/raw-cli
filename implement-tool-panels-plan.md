# Implement the raw.panel/1 tool side panel and the builtin todo tool

## Plan schema
loop-plan/v1

## Target

Implement `docs/panels-design.md` (the contract, Codex-approved, commits 3de9c31, e0a262d, 115ae8a) as written:

- tools publish typed panel documents (8 block kinds) through a result block, `context.panels`, MCP `_meta["raw/panel"]` or ACP client tool content; one `PanelHost` validates, applies, assigns revisions and commits them with the tool result;
- the model never sees panel bytes, only confirmation lines and, after compaction, an opt-in bounded reminder;
- state lives in `session_panels`, history gets small `panel_receipt` records;
- the dashboard right side becomes an always-present stack of collapsible sections (§13.1, D13): declared panels listed before any call, default then user order, hide, fixed heights, closed by default, opens only for `first_update` on a non-hidden section;
- user actions (`prompt`, `tool` through the unchanged dispatch), CLI receipts and `/panels`, `raw sessions panels`, ACP `plan` plus `_raw/panel/*`;
- the reference tool `builtin/todo` (§18), opt-in through `tools.use`.

The design doc is the source of truth. Where this plan and the doc disagree, the doc wins unless the user decides otherwise; a disagreement found during implementation is fixed in the doc first, in the same phase, and called out in the phase report.

## Scope

Included: everything in `docs/panels-design.md` §4–§18 and the verification map in §22, split into 9 phases (the doc's 7, with Core split into a pure protocol phase and a host/persistence phase, and Dashboard split into server and UI phases).

Excluded (the doc's non-goals and §21): tool-supplied HTML/iframes, images in panels, workspace-scoped panels, a model-facing panel tool, JSON Patch, storing every revision, tabs, split views, adding `builtin/todo` to the starter agent (D11), any config write from the dashboard.

## Invariants

1. **Degrade, never block** (D10): an invalid update never fails the tool call; unknown block kinds render their fallback; old clients ignore `panel` events.
2. **The model never sees panel bytes** (D5): panel blocks are removed in `ToolRegistry.dispatch` before `PostToolUse` hooks and `capResult`; provider request snapshots and cache keys are unchanged by panel-only data.
3. **Atomic commit**: the panel apply, the `session_panels` upsert and the `panel_receipt` rows are written in the same store transaction as the tool-result `commitMessage`; a failed transaction keeps no panel state.
4. **Ownership** (D8): an owner writes only `<canonical identity>#<id>`; `as` aliases cannot impersonate.
5. **Actions add no capability** (D7): `tool` actions go through the unchanged `dispatch` (exposure/deny → validate → PreToolUse → approval only for `ask` → handler → extraction → PostToolUse → cap).
6. **Config bytes are never modified** by the dashboard; stack order, hidden sections, expand state and heights live only in `localStorage` (`raw.dashboard.panels.v1`).
7. **No schema version bump**: `session_panels` uses `CREATE TABLE IF NOT EXISTS`, like `session_runtime_metadata`; `SESSION_SCHEMA_VERSION` stays 5.
8. Tools and agents that declare no panels behave byte-for-byte as before (tool schemas, cache key, history, ACP output).

## Baseline

Verified before planning (do not redo):

- Worktree clean at `c9e958c`. The design doc is committed; nothing of it is implemented.
- `ToolRegistry.dispatch` (`src/tools/registry.ts`) order: exposure → deny → `validateArgs`/`validate` → abort → `PreToolUse` via `context.onHook` → approval when `effect === "ask" || context.autoApprove === false` → `onStart` → `tool.handler` → `PostToolUse`/`PostToolUseFailure` → `finish` = `capResult`.
- `capResult` (`src/tools/results.ts`) handles `text`, `json`, and treats everything else as `image`; a new content type must be handled explicitly or it would be decoded as base64.
- `ToolContent` (`src/tools/types.ts`) is `text | json | image`; `ToolContext` is in `src/tools/primitives.ts`.
- The plugin loader (`src/tools/plugins/loader.ts`, `registration.handler`) builds a separate `pluginContext`; `parseToolManifest` (`src/tools/plugins/manifest.ts`) rejects any key outside `manifestKeys`.
- Bundled tools: source `src/tools/bundled/<name>/{tool.json,index.ts}`, entries in `tsup.tools.config.ts`, names in `bundledNames` (`loader.ts`), `scripts/copy-tool-manifests.mjs`, `scripts/build-tool-examples.mjs` (copies to `examples/tools/<name>`).
- `AgentSession` (`src/agent.ts`): `appendResult` projects the result and calls `commitMessage` → `store.appendAgentMessage(sessionId, owner, message, metadata, display, operationId)`, one transaction that inserts `model_context` and `history` rows. Dispatch context is built inline near `registry.dispatch(call.name, …)`. Compaction's skill reload notice is at `compactWork` (`[Raw skill reload notice]`, `skillNotice` metadata → `history` kind `skill_notice` in `replaceAgentContext`).
- `session_runtime_metadata` and `session_operations` are created with `CREATE TABLE IF NOT EXISTS` in `src/sessions/schema.ts` after the versioned block.
- Operations: `OperationIntent.kind` is `"turn" | "compact"` (`src/sessions/operation-types.ts`); `SessionOperations.execute` attaches a runtime (`attachSessionRuntime`, `src/sessions/runtime.ts`) and runs `agent.run` or `agent.compact`.
- Dashboard: routes in `src/dashboard/sessions.ts` (`sessionRoute` regex, `snapshot()`, `SessionSnapshot`), SSE in `src/dashboard/streams.ts` (`DashboardEventData`, `observe`, `publish`, text coalescing via `bufferText`). The session's saved agent is `SessionSummary.agentName`. Config-only agent metadata is read without credentials through `loadConfig({… requireModel:false})` (`composer()` in `sessions.ts`).
- Web: the inspector is a Radix `Dialog.Root` in `web/src/chat.tsx` with the "Session details" button, content in `web/src/inspector.tsx`; preferences pattern in `web/src/preferences.ts` and `web/src/workspace/workspace-state.ts`; markdown renderer `web/src/markdown.tsx`.
- MCP: result conversion in `src/tools/mcp-client.ts` (~line 199–224, calls `capResult`); config `mcpServersSpec` in `src/config.ts` (strict `keys(...)` per transport); MCP tool IDs are `mcp/<server>/<tool>`.
- ACP: `src/acp/methods.ts` — `initialize` advertises `_meta.raw`, `rawCapabilities(params._meta)` reads the peer's; `_raw/tool/register`, `_raw/tool/call` conversion calls `capResult` (~line 117); `session/load` replays via `storedAcpUpdates` (`src/sessions/display.ts`).
- CLI: REPL slash commands in `src/cli.ts` (`/exit`, `/compact`); `sessions show` parsing in `src/config.ts` `parseArgs` (~line 935).
- Packages: `hostCapabilities` in `src/packages/contract.ts`; export adds `raw.hook/1` in `src/packages/export.ts`.
- Tests: required list in `scripts/test.mjs`; `dashboardFixture` in `tests/fixtures/dashboard.ts`; mock provider `tests/fixtures/mock-provider.ts`; MCP server fixtures `tests/fixtures/mcp-*.ts`; Playwright specs in `tests/dashboard-ui/`, screenshots `tests/dashboard-ui/capture.ts`.
- Known unrelated baseline failures: the 3 PTY REPL tests in `tests/cli.test.ts`; occasional webkit flakes in `chat.spec.ts:32` and `shell.spec.ts:199` that pass on rerun.

## Design and project patterns

- **Module layout.** New `src/panels/`: `contract.ts` (types, limits, error codes, `PanelError`), `validate.ts` (declarations, documents, updates), `patch.ts` (ops engine), `render.ts` (text rendering, derived progress and summary, receipt line), `host.ts` (`PanelHost`). Mirrors `src/hooks/` (contract/dispatcher split).
- **Schema file.** `schemas/raw-panel.schema.json` documents the document and update shapes for tool authors, like the other files in `schemas/`. The runtime validator is hand-written (like `parseToolManifest`) so error messages carry the JSON pointer required by §15; a test checks the schema and the validator agree on the fixtures.
- **Declarations.** `PanelDeclaration` is attached to `ToolRegistration.panels` (local tools from `tool.json`, MCP tools from config or implicit, ACP from registration). `knownPanelDeclarations(runtimeConfig)` reads manifests and config only, reusing `selectedManifest`-style parsing without importing handlers.
- **Host.** One `PanelHost` per agent runtime, created in `AgentSession` with the persistence handle (or in-memory when there is none). It exposes `stage(callId, owner, updates)` for live application and returns what `appendResult` commits. Store work is a new optional parameter of `appendAgentMessage` (`panels: { upserts, receipts }`) so it is inside the existing transaction.
- **Stream.** A new `panel` event in `DashboardEventData`, coalesced per panel at 250 ms like `bufferText`; `SessionSnapshot` gains `agent` and `panels`.
- **Operations.** A new operation kind `panel_action` next to `compact`, executed by `SessionOperations.execute` through a new `AgentSession.runPanelAction` that calls `registry.dispatch` with `autoApprove: true` and commits in one transaction.
- **Web.** `web/src/panels/` holds `panel-state.ts` (pure: order, insertion rule, hidden, expand, heights, storage parse), `SidePanel.tsx` (stack), `Section.tsx`, `blocks/*.tsx` (8 widgets), `Receipt.tsx`. Radix `DropdownMenu` for `⋯`, existing `workspace-menu` classes, lucide icons.
- **Docs.** Update `docs/tools.md`, `docs/dashboard.md`, `docs/dashboard-api.md`, `docs/acp.md`, `docs/cli.md`, `docs/context.md`, `docs/mcp.md`, `docs/packages.md`, `docs/sessions.md` in the phase that ships each surface; flip the design doc Status to "Implemented" in the last phase.

## Global Gates

- `npm run typecheck`
- `npm test` (build + every required node test; only the 3 known PTY failures in `tests/cli.test.ts` are acceptable)
- `npm run test:web` for any phase touching `web/` or dashboard routes (3 browsers, axe; known webkit flakes must pass on one rerun)
- `npm run test:package` after Phases 3 and 4 (manifest and bundled tool changes)
- No change to provider request bytes, tool schemas or cache keys for agents that select no panel-declaring tool (asserted by an existing-fixture snapshot test added in Phase 2).
- `git status` clean except intended files at each phase commit.

## Plan Review

APPROVE — intent-fidelity and self-review completed on 2026-09-29 (phases cover §4–§18 and every §22 verification row; no scope beyond the design doc; paths and symbols checked against `c9e958c`; integration points re-checked with ctxe `find_usages`/`inspect_path`: all `capResult` callers, `nativeToolContent`, history renderers). Codex (gpt-6-astra) plan review APPROVE after 2 rounds on 2026-09-29 (round 1 fixed: persisted eviction deletes, rejection receipts, durable pending action notes).

## Phase 1: Panel protocol library

### Goal
A pure, fully tested implementation of the `raw.panel/1` data model: types, document and update validation, the patch engine, derived fields and text rendering.

### Current behavior and gap
Nothing exists. Everything later depends on one validator and one patch engine (D4, D6).

### Evidence
`docs/panels-design.md` §6, §7, §9, §14, §15, §17; `parseToolManifest` style of hand-written strict validation in `src/tools/plugins/manifest.ts`.

### Pattern
`src/hooks/contract.ts` for a contract module; `src/tools/plugins/manifest.ts` for strict key checks.

### Dependencies
None.

### Files and symbols
- `src/panels/contract.ts`: `PanelDocument`, `PanelBlock` (8 kinds), `PanelItemStatus`, `PanelUpdate` (`replace|patch|close`), `PanelPatch` (6 ops), `PanelDeclaration`, `PanelAction`, `PANEL_LIMITS`, `PanelErrorCode` (9 codes), `class PanelError`.
- `src/panels/validate.ts`: `validateDocument(value): PanelDocument`, `validateUpdate(value): PanelUpdate`, `validateDeclaration(value, where): PanelDeclaration`.
- `src/panels/patch.ts`: `applyUpdate(current | undefined, update): { document, closed }`.
- `src/panels/render.ts`: `derivedProgress`, `derivedSummary`, `renderPanelText(declaration, document)`, `receiptLine(receipt)`.
- `schemas/raw-panel.schema.json`.
- `tests/panels-protocol.test.ts` (added to `scripts/test.mjs` required list).

### Behavioral contract
- Every §7 block kind, field limit and ID grammar is enforced; errors are `PanelError("panel_invalid", "<json pointer>: <reason>")`, `panel_too_large` above 64 KiB serialized UTF-8.
- Unknown top-level fields and unknown fields inside a known block are rejected; an unknown block kind is accepted when it has valid common fields and renders `fallback` or `Unsupported block "<kind>"`.
- Control characters other than `\n`, `\t` rejected in strings.
- Patches apply atomically; the result is fully revalidated; `remove_items` selector must match the kind; removing a checklist item removes its children; `append_events` trims to `max`; `upsert_items` merges given fields and appends new items (under `parent` for a checklist).
- `patch`/`close` without a current document → `panel_unknown`.
- Derived progress/summary exactly per §6; text rendering per §7 (glyphs `[ ] [~] [x] [-] [!] [✗]`, table past 50 rows summarized).

### Documentation
None beyond the schema file (the doc already specifies this).

### Tests first
Table-driven tests per block kind: valid minimum, each limit at boundary and boundary+1, each ID grammar, unknown field, unknown kind with and without fallback, control characters, 64 KiB boundary; patch tests for every op including atomic rejection (first patch valid, second invalid → original unchanged), selector/kind mismatch, children removal, timeline trimming, `set` with `null`; derived fields with nested checklists, steps-only, none; text rendering snapshots per kind; schema file vs validator agreement on shared fixtures.

### Anti-shortcut coverage
Randomized-order patch sequences compared with an independent reference result; a limit test that builds 200 items with children at depth 3 (valid) and one more (invalid) so a count of top-level items only fails.

### Implementation obligations
Pure functions, no I/O; `structuredClone` input before mutation; byte length measured with `Buffer.byteLength(JSON.stringify(doc))`.

### Acceptance criteria
- [x] AC-1.1: All 8 block kinds validate and render text as in §7 — proven by `tests/panels-protocol.test.ts`.
- [x] AC-1.2: Every limit in §14 that applies to documents is enforced at boundary+1 with the §15 code — proven by the same file.
- [x] AC-1.3: A failing patch leaves the input document deep-equal to before — proven by the atomicity test.
- [x] AC-1.4: Unknown kind renders fallback; unknown field in known kind rejects — proven by tests.

### Focused verification
`node --import tsx --test tests/panels-protocol.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: add the raw.panel/1 document model, validator, patch engine and text rendering`

## Phase 2: PanelHost, extraction and persistence

### Goal
Panel updates flow from local tool handlers into one `PanelHost`, are stripped before hooks and caps, and commit atomically with the tool result into `session_panels` plus a `panel_receipt` history row.

### Current behavior and gap
`ToolContent` has no panel variant; `capResult` would treat one as an image; `dispatch` has no extraction; no store table.

### Evidence
§8.0, §8.1, §8.2, §9 revisions, §10 first bullet, §12, §13.4; baseline notes on `dispatch`, `capResult`, `appendAgentMessage`, loader `pluginContext`.

### Pattern
`hookReceipt`/`recordVisible` for history kinds; `session_runtime_metadata` for the table; `onHook` for a host-only context callback.

### Dependencies
Phase 1.

### Files and symbols
- `src/tools/types.ts`: `ToolContentPanel`, added to `ToolContent`.
- `src/tools/results.ts` `capResult`: pass `panel` blocks through uncounted (not in `retainedBytes`, `observedBytes`, image budget).
- `src/tools/primitives.ts` `ToolContext`: `panels?: PanelContext`, `onPanelUpdates?: (updates) => void`.
- `src/tools/registry.ts`: `ToolRegistration.panels?: readonly PanelDeclaration[]`; `dispatch` extracts panel blocks right after `tool.handler` returns (before PostToolUse and `finish`); registry-generated error results carry none.
- `src/tools/plugins/loader.ts`: forward `panels` (not `onPanelUpdates`) into `pluginContext`.
- `src/panels/host.ts`: `PanelHost` (per runtime; in-memory state loaded from store; `update/get` for `context.panels`; ownership `<identity>#<id>`, `panel_undeclared` for manifest tools, implicit declaration for MCP/ACP owners; 200 updates per panel per call → `panel_rate_limited`; 16-panel limit with closed eviction; `base_revision` conflict; revision assignment; live listener with 250 ms per-panel coalescing; `commit(callId)` returns upserts and receipts; after settle `update` rejects `panel_closed_context`).
- `src/sessions/schema.ts`: `CREATE TABLE IF NOT EXISTS session_panels` exactly as §12.
- `src/sessions/store.ts`: `appendAgentMessage(..., panels?)` with `panels = { upserts, deletes, receipts }` writes all three in the same transaction (deletes carry the closed panel evicted by the 16-panel limit), receipts right after the tool result;
- Rejection notices (§15): a rejected result-block, MCP or ACP update produces a receipt with `error: { code, message }` and the unchanged revision (no document write), so the dashboard section notice and the CLI line `▸ Todo update rejected: panel_invalid` come from the same committed record; streaming `update()` rejections stay in the tool (promise rejection) and produce no receipt. The §12 receipt payload in `docs/panels-design.md` is extended with the optional `error` field in this phase (doc first). `listSessionPanels(sessionId)`, `getSessionPanel`; delete cascades by FK.
- `src/agent.ts`: create `PanelHost`; set `panels` and `onPanelUpdates` in the per-call context; in `appendResult`, apply extracted updates, add §10 confirmation/rejection lines to the model-visible result, pass panel writes into `commitMessage`; emit `RunEvent` `panel_update` (live and committed).
- `src/sessions/view.ts` `projectHistoryItem`: `panel_receipt` → `view.panelReceipt`; `src/sessions/display.ts` `storedAcpUpdates`: `panel_receipt` → `[]` until Phase 8; `src/terminal/history.ts` `renderTerminalHistory`: `panel_receipt` → the §13.2 receipt line (its fallback prints raw JSON for unknown kinds, so resumed CLI history would otherwise dump the payload).
- Type boundary (found with ctxe): `nativeToolContent` (`src/llm/content.ts`) throws `unsupported_content` on any unknown block, and every provider adapter, `projectToolResult` and `reverseResult` iterate `ToolResult.content`. So the stored/provider `ToolResult.content` type stays `text | json | image`; only the handler return type (`ToolHandlerResult`, used by `ToolRegistration.handler`, `mcpResultToToolResult`, `reverseResult`) and `capResult`'s input admit `ToolContentPanel`. `dispatch` returns a plain `ToolResult`, so the compiler proves no panel block reaches providers or history.
- `src/index.ts`: export `getSessionPanels` (in `src/sessions/api.ts`) and panel types.
- Tests: `tests/panels-host.test.ts` (new, required), additions to `tests/registry.test.ts`, `tests/session-store.test.ts`, `tests/agent-tools.test.ts`.

### Behavioral contract
- A handler returning `[text, panel]` → model sees only text; `PostToolUse` hook payload and `capResult` input contain no panel block (asserted by a hook spy and a `capResult` spy).
- Result with only panel blocks → the model result has `panel <id> updated (revision N): <summary>`; rejected update → `panel <id> update rejected: <code> <message>`, tool call still `isError:false`.
- Streaming `context.panels.update` resolves with a revision and is visible live; the state at settle commits with the result (also for error/cancelled results).
- A store transaction failure after staging keeps no panel row and no receipt; in-memory host state is rolled back to the last committed revision.
- Restart: a new `AgentSession` on the same session sees the last committed document and revision.
- Sessions without panel-declaring tools: provider request bytes unchanged (snapshot test on existing mock-provider fixture).

### Documentation
`docs/tools.md`: "Panels" section for handler authors (result block, `context.panels`, limits, errors), linking to the design doc.

### Tests first
Registry extraction order test (hook and cap spies); `capResult` passthrough test with a 64 KiB panel and a small `maxOutputBytes`; host tests for ownership, alias impersonation (`as`), undeclared, rate limit at 200/201, 16-panel limit with and without a closed panel, `base_revision` conflict, revision not consumed on rejection, post-settle rejection; store test for same-transaction commit (inject failure after `model_context` insert), cascade delete, restart reload; limit eviction then restart (the evicted closed panel is gone from `session_panels` and the new panel is present); rejected update → receipt with `error`, previous revision and document unchanged, rendered by `projectHistoryItem` and `renderTerminalHistory`; agent test for model-visible lines and request snapshot unchanged.

### Anti-shortcut coverage
The transaction test forces a failure inside the transaction (not before it), so writing panels in a separate transaction fails the test. The hook spy asserts on the exact object passed to `PostToolUse`, so stripping only in `appendResult` fails.

### Implementation obligations
No `user_version` bump; no change to `capResult` behavior for existing types; live frames bounded by coalescing; `onPanelUpdates` never reaches plugin code.

### Acceptance criteria
- [x] AC-2.1: Panel blocks never reach `PostToolUse`, `capResult` counters, provider requests or `model_context` — proven by registry and agent tests.
- [x] AC-2.2: Panel upsert and receipt commit in the same transaction as the tool result — proven by the injected-failure store test.
- [x] AC-2.3: All host-side §15 codes are produced in their scenario — proven by `tests/panels-host.test.ts`.
- [x] AC-2.4: Documents survive compaction and restart; delete cascades — proven by store/agent tests (D1, D3).
- [x] AC-2.6: `ToolResult.content` (stored and provider type) excludes panel blocks at compile time, and a resumed CLI/dashboard history shows a receipt, never raw receipt JSON — proven by `npm run typecheck` and `tests/session-view.test.ts`/`tests/terminal-history.test.ts` additions.
- [x] AC-2.5: Request bytes for a panel-free agent equal the pre-change snapshot — proven by the snapshot test.

### Focused verification
`node --import tsx --test tests/panels-host.test.ts tests/registry.test.ts tests/session-store.test.ts tests/agent-tools.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: route tool panel updates through a PanelHost and commit them with tool results`

## Phase 3: Declarations across tool sources

### Goal
Tools declare panels in `tool.json`, MCP config, or ACP registration; MCP results carry `_meta["raw/panel"]`; ACP client tools may return panel content; stale panels are derived; known declarations per agent are computed without importing handlers.

### Current behavior and gap
`parseToolManifest` rejects `panels`; `mcpServersSpec` rejects `panels`; MCP/ACP conversions drop panel data; `raw.panel/1` is not a host capability.

### Evidence
§5, §8.0 table, §8.3, §8.4, §12 stale, §13.1 "Always present", §17.

### Pattern
`parseToolManifest` strict validation; `mcpServersSpec` `keys(...)`; `rawCapabilities`/`_meta.raw` negotiation in `src/acp/methods.ts`; `hostCapabilities` in `src/packages/contract.ts`.

### Dependencies
Phase 2.

### Files and symbols
- `src/tools/plugins/manifest.ts`/`contract.ts`: optional `panels` (≤4, validated with `validateDeclaration`, unknown icon → `panel` plus warning, second `acp_plan` ignored with warning at agent level).
- `src/tools/plugins/loader.ts`: set `registration.panels`.
- `src/config.ts` `mcpServersSpec`: optional `panels` per server with required `tool`; exposed on `McpServerConfig`.
- MCP owner identity is the registration's `canonicalName`, which is `mcp/<server>/<tool>` or, for package servers, `<canonicalIdentities[server]>/<tool>` (`mcp-client.ts` registration builder). Config `panels[].tool` names the original MCP tool; the owner is derived with the same rule, and a test covers a package-provided server.
- `src/tools/mcp-client.ts`: convert `_meta["raw/panel"]` (object or array) into `panel` blocks appended to converted content; attach config-declared panels to the MCP registration; implicit declaration otherwise (title = document title or panel ID).
- `src/acp/methods.ts`: `_raw/tool/register` accepts `panels`; `_raw/tool/call` keeps `{type:"panel"}` items only when the peer advertised `_meta.raw.panels: true`, else rejects as today.
- `src/packages/contract.ts`: add `raw.panel/1` to `hostCapabilities`; `src/packages/export.ts` adds it to `requires` when an exported tool declares panels.
- `src/panels/declarations.ts`: `knownPanelDeclarations(runtime: RuntimeConfig)` → ordered list (tool.json panels by `tools.use` then `panels` order; then config MCP panels by server order) reading manifests only; `isStale(panel, declarations)`.
- Tests: `tests/tool-plugins.test.ts`, `tests/config-mcp-policy.test.ts` or `tests/mcp.test.ts`, `tests/acp.test.ts`, `tests/package-manifest.test.ts`, new `tests/panels-declarations.test.ts` (required).

### Behavioral contract
- Manifest with invalid `panels` → `invalid tool manifest: <id>`; without `panels` → unchanged.
- The same logical update sent via result block, `context.panels`, MCP `_meta` and ACP content yields identical stored documents and revisions (D4).
- `knownPanelDeclarations` never imports `index.mjs` and never starts an MCP server (asserted with an entry that throws on import and a server command that does not exist).
- Stale: owner not selected by the agent, or declaration missing the panel ID.
- A package exporting a panel tool requires `raw.panel/1`.

### Documentation
`docs/tools.md` (manifest `panels`), `docs/mcp.md` (`_meta["raw/panel"]`, config `panels`), `docs/acp.md` (`panels` registration and capability, brief; full ACP in Phase 8), `docs/packages.md` (capability).

### Tests first
Manifest positive/negative matrix; MCP fixture server returning `_meta`; ACP registration with and without negotiation; D4 equivalence test across four paths; no-import/no-start test for known declarations; ordering test.

### Anti-shortcut coverage
The equivalence test compares full stored rows, so a path that bypasses `PanelHost` validation (different revision or derived fields) fails.

### Implementation obligations
Warnings go to the existing load-warning channel; no behavior change for servers/tools without `panels`.

### Acceptance criteria
- [x] AC-3.1: Four emission paths yield identical stored state — proven by `tests/panels-declarations.test.ts`.
- [x] AC-3.2: Known declarations are computed without importing handlers or starting MCP servers, in §13.1 default order — proven by tests.
- [x] AC-3.3: ACP panel content is rejected without negotiation and accepted with it — proven by `tests/acp.test.ts`.
- [x] AC-3.4: `raw.panel/1` is a host capability and export requires it for panel tools — proven by package tests.

### Focused verification
`node --import tsx --test tests/panels-declarations.test.ts tests/tool-plugins.test.ts tests/mcp.test.ts tests/acp.test.ts tests/package-manifest.test.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:package`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: declare tool panels in tool.json, MCP config and ACP registration`

## Phase 4: builtin/todo

### Goal
Ship the reference tool exactly as §18, opt-in through `tools.use`.

### Current behavior and gap
No todo tool.

### Evidence
§18 (schema, ID grammar, argument-only vs state validation, behavior, declaration, actions), D11.

### Pattern
Bundled tools (`src/tools/bundled/read_var`, `tsup.tools.config.ts`, `bundledNames`, copy/example scripts).

### Dependencies
Phase 3.

### Files and symbols
- `src/tools/bundled/todo/tool.json` (schema, description, `panels` with 5 actions), `src/tools/bundled/todo/index.ts` (`validateArgs`, `handler`).
- `tsup.tools.config.ts`, `loader.ts` `bundledNames`, `scripts/copy-tool-manifests.mjs`, `scripts/build-tool-examples.mjs`, generated `examples/tools/todo/`.
- `tests/todo-tool.test.ts` (new, required).

### Behavioral contract
Exactly §18: replace/merge, generated smallest unused `t<n>`, `parent` depth ≤2, one `in_progress`, done/skipped parent cannot have unfinished subtasks, `clear:"done"` merge-only, `invalid_todo` publishes nothing, model-visible text list with IDs, panel `todo` published with `op:"replace"`, `status:"done"` when all done/skipped, `context_summary` text list. Starter config unchanged (D11).

### Documentation
`docs/tools.md` todo section.

### Tests first
Generated ID reuse after removal; model-supplied IDs `t1`,`t3` then add → `t2`; 100 items; parent-of-parent rejected in validateArgs; merge unknown ID without content rejected in handler; completing parent with pending child → `invalid_todo` and revision unchanged; `clear` keeps unfinished; output text format.

### Anti-shortcut coverage
The ID test supplies non-sequential existing IDs, so a counter-based generator fails.

### Implementation obligations
No file I/O; state only via `context.panels.get`.

### Acceptance criteria
- [x] AC-4.1: All §18 validation rules and ID generation behave as specified — proven by `tests/todo-tool.test.ts`.
- [x] AC-4.2: `builtin/todo` loads only when selected; starter config bytes unchanged — proven by tests.
- [x] AC-4.3: `examples/tools/todo` is generated by the build — proven by `npm test` build step and a file check.

### Focused verification
`npm run build && node --import tsx --test tests/todo-tool.test.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:package`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: add the builtin todo tool with a live todo panel`

## Phase 5: Dashboard panel API and stream

### Goal
Server side of §13.1: the panel routes with `?agent=`, the SSE `panel` event with coalescing, and snapshots/resets carrying the saved agent and all panels.

### Current behavior and gap
No panel routes, no `panel` event; `SessionSnapshot` has no panels.

### Evidence
§13.1 "HTTP API", "Live and reload", "Stack agent".

### Pattern
`sessionRoute` handling and `composer()` credential-free config reads in `src/dashboard/sessions.ts`; `bufferText` coalescing in `streams.ts`.

### Dependencies
Phases 2–3 (4 only for fixtures).

### Files and symbols
- `src/dashboard/sessions.ts`: `GET /api/sessions/:id/panels[?agent=]`, `GET /api/sessions/:id/panels/:panel`; `SessionSnapshot.agent`, `.panels`.
- `src/dashboard/streams.ts`: `panel` in `DashboardEventData`; observe `panel_update` run events; 250 ms per-panel coalescing, latest wins.
- `tests/dashboard-panels.test.ts` (new, required).

### Behavioral contract
Items in default order for the agent; declared-without-data items have `revision:0`, `updatedAt:null`, `document:null`; unknown agent → `422 unknown_agent`; unknown panel → `404 unknown_panel`; stale computed against the requested agent; stream frames ≤4/s per panel; snapshot authoritative.

### Documentation
`docs/dashboard-api.md` routes, event and snapshot fields.

### Tests first
API ordering and empty declarations; `?agent` switches stale flags; coalescing (10 updates within 250 ms → ≤2 frames, last state wins); snapshot contains panels after reconnect.

### Anti-shortcut coverage
Coalescing test checks the final frame content equals the last update, rejecting a simple throttle that drops the tail.

### Implementation obligations
Same auth/origin checks; bounded frame sizes (≤64 KiB document).

### Acceptance criteria
- [x] AC-5.1: Panel routes return §13.1 shapes and errors — proven by `tests/dashboard-panels.test.ts`.
- [x] AC-5.2: `panel` frames are coalesced to 250 ms per panel with latest state — proven by the stream test.
- [x] AC-5.3: Snapshot/reset include `agent` and all panels — proven by the stream test.

### Focused verification
`node --import tsx --test tests/dashboard-panels.test.ts tests/dashboard-streams.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: serve tool panels over the dashboard API and session stream`

## Phase 6: Dashboard side panel stack

### Goal
The §13.1 UI: the Info button becomes the "Side panel" toggle; a stack of always-present collapsible sections with default/user order, insertion rule, hide, per-session expand, fixed heights and divider resize, 8 widgets, chat receipts, unseen dot, open preference, live region, narrow-viewport drawer.

### Current behavior and gap
The inspector shows only session details.

### Evidence
§13.1 in full, §6 status table, §7 dashboard bullets, D9, D13; `web/src/chat.tsx` inspector `Dialog.Root`.

### Pattern
`web/src/workspace/workspace-state.ts` (pure state + versioned localStorage key) and its node test `tests/web-workspace-state.test.ts`; Radix menus as in the chat header More menu.

### Dependencies
Phase 5.

### Files and symbols
- `web/src/panels/panel-state.ts` (pure): stack order from default order + stored user order, insertion rule, hidden set, expand map per session, heights per agent, first-open-once per session, storage parse at `raw.dashboard.panels.v1`.
- `web/src/panels/SidePanel.tsx`, `Section.tsx`, `Receipt.tsx`, `blocks/{Checklist,Steps,Progress,KeyValue,Table,Markdown,Timeline,Files}.tsx`.
- `web/src/chat.tsx`, `web/src/inspector.tsx` (Details becomes the last section), `web/src/timeline.tsx` (receipt rows), `web/src/pages/Preferences.tsx` + `web/src/preferences.ts` ("Open the side panel for tool updates": Follow the tool / Never), `web/src/styles.css`.
- Tests: `tests/web-panel-state.test.ts` (required), `tests/dashboard-ui/panels.spec.ts`, fixture support in `tests/dashboard-ui/fixtures.ts` to seed panels.

### Behavioral contract
Everything in §13.1 and D9/D13 verification rows: starts closed; `first_update` opens once without focus move, not for hidden sections, never on narrow viewports; updates never change expanded state, position or height; Move up/down and drag persist per agent; insertion rule with reversed neighbors; agent switch refetches with `?agent`, including after stream resume; hide persists, receipt click unhides and expands; snapshot with lower revision replaces state; a receipt with `error` shows "Update rejected: <code>" once in its section while the previous revision stays visible; unknown kind shows fallback; `@path` insertion on file refs; axe clean in light and dark.

### Documentation
`docs/dashboard.md` side panel section; screenshots via `tests/dashboard-ui/capture.ts`.

### Tests first
Node tests for `panel-state.ts` (order, insertion rule matrix, storage corruption → defaults). Playwright for each D9/D13 row, each widget render, keyboard accordion, axe.

### Anti-shortcut coverage
Height test measures section `getBoundingClientRect()` before and after a live update adding 50 items; insertion test reverses defaults first so an append-at-end or default-sort implementation fails.

### Implementation obligations
No config writes; corrupt storage never blocks; `prefers-reduced-motion` respected; progress glyphs have accessible labels.

### Acceptance criteria
- [x] AC-6.1: Every D9 and D13 row of the §22 verification map passes in 3 browsers — proven by `tests/dashboard-ui/panels.spec.ts`.
- [x] AC-6.2: All 8 widgets render and pass axe — proven by Playwright.
- [x] AC-6.3: Pure stack state is covered including corrupt storage — proven by `tests/web-panel-state.test.ts`.
- [x] AC-6.4: Existing specs still pass after the Info button change — proven by `npm run test:web`.

### Focused verification
`node --import tsx --test tests/web-panel-state.test.ts && npx playwright test tests/dashboard-ui/panels.spec.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:web`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: show tool panels as a stack of collapsible sections in the dashboard side panel`

## Phase 7: Panel actions

### Goal
§11: `prompt` actions in the browser, `tool` actions as a `panel_action` operation through the unchanged dispatch, with `agent_mismatch`, deny hiding, hooks with `source:"user_action"`, a model note, and the action UI.

### Current behavior and gap
Operations support only `turn` and `compact`.

### Evidence
§11, §10 third bullet, §13.1 "Actions during an unsent agent switch", HTTP route row, D7.

### Pattern
`compact` operation path (`OperationIntent`, `SessionOperations.execute`, `AgentSession.compact`).

### Dependencies
Phases 4 and 6.

### Files and symbols
- `src/sessions/operation-types.ts`: kind `panel_action` plus `action` payload.
- `src/sessions/operations.ts` `execute`: call `runtime.agent.runPanelAction(...)`.
- `src/agent.ts`: `runPanelAction({ panel, action, block?, item?, operationId })` resolves templates, dispatches with `autoApprove:true`, `approve`, `toolCallId = operationId`, hooks with `source:"user_action"`; commits updates, receipt (`source:"user_action"`) and a pending model note in one transaction.
- Pending note persistence: `src/sessions/schema.ts` adds `CREATE TABLE IF NOT EXISTS session_pending_notes (session_id REFERENCES sessions ON DELETE CASCADE, sequence, text, created_at, PRIMARY KEY(session_id, sequence))`; `src/sessions/store.ts` writes it in the action transaction, and `appendAgentMessage` for a user message (the `operationId`-consuming path) inserts the pending notes as a user-role text block immediately before the user message in `model_context` and deletes them, in the same transaction. The in-memory `AgentSession.messages` mirror is updated the same way.
- `src/hooks/*`: `source` field on tool hook payloads (default `"model"`).
- `src/dashboard/sessions.ts`: `POST /api/sessions/:id/panels/:panel/actions` with all §13.1 errors.
- Web: action menus, primary glyph button, confirm dialog, disabled tooltips (busy, unsent agent switch), error notice.
- Tests: `tests/panels-actions.test.ts` (required), `tests/dashboard-ui/panels.spec.ts` additions.

### Behavioral contract
All D7 verification rows: `allow` runs without approval; `ask` prompts even with `-y`/`autoApprove`; `deny` hides and returns 403 with nothing run; `409 agent_mismatch`, `409 session_busy`, `409 stale_panel`, `422 invalid_action` (unresolvable template, `when` mismatch); hooks see `source:"user_action"` in the existing order; the model note is in the next provider request after the user message.

### Documentation
`docs/dashboard-api.md` action route; `docs/hooks.md` `source` field; `docs/dashboard.md` actions.

### Tests first
Server tests per rule and error; provider request snapshot containing the note; action → close the runtime → new runtime → next turn: the note appears exactly once before the user message, and a second turn does not repeat it; a failed action transaction leaves no note; Playwright for unsent agent switch disabling tool actions but not prompt actions.

### Anti-shortcut coverage
The `ask` test sets `autoApprove: true` on the runtime, so implementing "click = approval" regardless of rule fails.

### Implementation obligations
No new trust path; templates only in string values; idempotent `clientRequestId`.

### Acceptance criteria
- [x] AC-7.1: Every D7 row passes — proven by `tests/panels-actions.test.ts` and Playwright.
- [x] AC-7.2: The model note precedes the next request's user message — proven by request snapshot.

### Focused verification
`node --import tsx --test tests/panels-actions.test.ts && npx playwright test tests/dashboard-ui/panels.spec.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:web`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: run declared panel actions through the tool dispatch path`

## Phase 8: CLI and ACP surfaces

### Goal
§13.2 and §13.3: receipt lines, `/panels`, `raw sessions panels ID [--json]`, stderr-only receipts in one-shot runs, ACP `plan`, `_raw/panel/update`, `_raw/panel/action`, capability, replay.

### Current behavior and gap
None of these exist.

### Evidence
§13.2, §13.3, D12.

### Pattern
`/compact` handling in `src/cli.ts`; `sessions-show` in `src/config.ts` `parseArgs`; `storedAcpUpdates` hook receipt replay in `src/sessions/display.ts`; `_raw/*` methods in `src/acp/methods.ts`.

### Dependencies
Phases 2, 3, 7.

### Files and symbols
`src/cli.ts`, `src/config.ts` (`sessions panels`), `src/terminal/renderer.ts`/`tools.ts` (receipt line), `src/sessions/display.ts`, `src/acp/methods.ts`. Tests: `tests/session-cli.test.ts`, `tests/repl.test.ts`, `tests/session-acp.test.ts`, `tests/acp.test.ts`.

### Behavioral contract
Receipt line `  ▸ Todo r5 · 3/7 · Fix the API` with color-independent glyphs; one-shot stdout contains only the answer; `raw sessions panels` needs no model credential; ACP `plan` entries flattened depth-first with mapped statuses; `_raw/panel/update` only after negotiation; `session/load` replays receipts as `agent_thought_chunk` in order, then current state once; `session/resume` sends current state once.

### Documentation
`docs/cli.md`, `docs/acp.md`, `docs/sessions.md`.

### Tests first
CLI golden outputs; ACP test client asserting `plan`, negotiation gate and replay order.

### Anti-shortcut coverage
Replay test has two panel updates interleaved with messages and checks both receipt positions and that only the latest state is sent once at the end.

### Implementation obligations
No color-only meaning; no receipts on stdout in one-shot mode.

### Acceptance criteria
- [ ] AC-8.1: CLI receipts, `/panels` and `raw sessions panels` match §13.2 — proven by CLI tests.
- [ ] AC-8.2: D12 row passes — proven by ACP tests.

### Focused verification
`node --import tsx --test tests/session-cli.test.ts tests/repl.test.ts tests/session-acp.test.ts tests/acp.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: show tool panels in the CLI and over ACP`

## Phase 9: Compaction reminder and final docs

### Goal
§10 compaction reminder for `context:"summary"` panels, and final documentation.

### Current behavior and gap
Compaction knows nothing about panels.

### Evidence
§10, `compactWork` skill reload notice in `src/agent.ts`.

### Pattern
`[Raw skill reload notice]` and `skillNotice` metadata.

### Dependencies
Phases 2 and 4.

### Files and symbols
`src/agent.ts` `compactWork`; `docs/context.md`, `docs/dashboard.md`, `docs/dashboard-api.md`, `docs/acp.md`, `docs/cli.md`; `docs/panels-design.md` Status → Implemented; `tests/compact.test.ts`.

### Behavioral contract
After a successful compaction only, one durable tail reminder per open `context:"summary"` panel, newest first, 2 KiB each, 8 KiB total, `…` truncation; never added on normal turns (prefix and cache key unchanged).

### Documentation
As listed.

### Tests first
Compaction with two panels (one `none`), size caps, no reminder on a normal turn (request snapshot equal).

### Anti-shortcut coverage
Cap test uses multibyte text so a character-based cut fails the byte limit.

### Implementation obligations
Reuse the existing notice mechanism; no change when no panel qualifies.

### Acceptance criteria
- [ ] AC-9.1: Reminder content, order and caps match §10 — proven by `tests/compact.test.ts`.
- [ ] AC-9.2: D5 row passes (no panel bytes in normal requests, cache key unchanged) — proven by request snapshot.
- [ ] AC-9.3: Every §22 verification row maps to a passing test — proven by the final audit table in the Progress Log.

### Focused verification
`node --import tsx --test tests/compact.test.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:web && npm run test:package`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: remind the model of summary panels after compaction and document tool panels`

## Completion Criteria

- All 9 phases committed with APPROVE reviews.
- Every row of the §22 verification map (D1–D13) is mapped to a passing test in the Progress Log.
- Global Gates pass on final `HEAD`.
- `docs/panels-design.md` Status says Implemented, with the commit range.

## Progress Log

| Phase | Status | Commit | Review | Notes |
| --- | --- | --- | --- | --- |
| 1 | complete | see git log | Codex gpt-6-astra APPROVE after 3 rounds (14 findings fixed) | 30 protocol tests; `npm test` only the 3 known PTY failures |
| 2 | complete | see git log | Codex gpt-6-astra APPROVE after 3 rounds (7 findings fixed) | 24 host tests, mutation-checked (extraction removed, panel write moved out of the transaction); `npm test` only the 3 known PTY failures |
| 3 | complete | see git log | Codex gpt-6-astra APPROVE after 2 rounds (5 findings fixed) | 7 declaration tests + ACP/MCP additions; `npm test` only the 3 known PTY failures; `npm run test:package` pass |
| 4 | complete | see git log | Codex gpt-6-astra APPROVE after 2 rounds (3 findings fixed) | 10 todo tests; `npm test` only the known PTY failures; `npm run test:package` pass; examples/tools/todo generated by build |
| 5 | complete | see git log | Codex gpt-6-astra APPROVE after 2 rounds (2 findings fixed) | 7 dashboard-panels tests; `npm test` only the 3 known PTY failures |
| 6 | complete | see git log | Codex gpt-6-astra APPROVE after 3 rounds (10 findings fixed) | 13 panel-state tests + 45 panels.spec runs (3 browsers), mutation-checked (offscreen/unknown visibility marked seen); `npm run test:web` 399 pass; `npm test` only the 3 known PTY failures |
| 7 | complete | see git log | Codex gpt-6-astra APPROVE after 3 rounds (10 findings fixed) | 15 panels-actions tests; panels.spec 63 passed, `npm run test:web` 417 passed; `npm test` only the 3 known PTY failures |
| 8 | pending | | | |
| 9 | pending | | | |
