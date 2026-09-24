# Batch-capable built-in tools with bounded file reads

## Plan schema
loop-plan/v1

## Target
Keep exactly three default built-ins while making each useful for several operations in one call. `read_file` must read multiple files with independent full/range/count choices without ever flooding a small model context. `write_file` must apply batches of full overwrite, append, exact-text replacement, and guarded line-range replacement. `bash` must run a batch of commands sequentially and report every command even after a nonzero exit. Update the installed `raw` after qualification.

## Scope
- Replace the unreleased single-operation tool input schemas. New inputs are `read_file({files:[...]})`, `write_file({operations:[...]})`, and `bash({commands:[...]})`; each array contains 1–16 items. Do not add compatibility aliases for the old shapes.
- Read entries accept `path`, optional 1-based `start_line`, and either inclusive `end_line` or `max_lines` (not both). No range fields means a full read that can page by complete lines when the output cap is reached. A lone `start_line` reads toward EOF within the response budget. Optional `max_bytes` further reduces that entry's budget. A count/range reaching EOF early succeeds with the available lines; a start past EOF succeeds with empty text and `eof: true`.
- Write entries use `mode: overwrite | append | replace_text | replace_lines`. `overwrite` and `append` use `content`; `replace_text` uses nonempty `old_text` and `new_text` and succeeds only for exactly one match; `replace_lines` uses 1-based inclusive `start_line`/`end_line`, `content`, and required `expected_sha256` of the selected original byte span returned by `read_file`. Empty replacement content deletes the range. All entries validate before the first side effect; runtime failures are recorded per entry and later entries continue. Same-path entries execute in array order. No rollback is promised.
- Bash entries use `command` and optional positive `timeout_ms`. Run them sequentially in array order using the existing process-group supervision; a nonzero exit does not stop later commands. Abort/timeout of the active command stops the batch and reports remaining indices as skipped. No parallel mode.
- Every batch response is an indexed, structured result with per-item status, metadata, and content. The existing `maxOutputBytes` (default 8192) is a **single cap for the whole serialized model-facing result**, not a fresh budget per item. CLI's separate 2,000-character/10-logical-line result preview remains display-only.

## Invariants
- Exactly three text-model built-ins; conditional `view_image` and dynamic MCP/ACP tools remain separate. Default system prompt stays at most 50 tokens; combined prompt plus built-in definitions stays at most 500 reference tokens. Schemas remain stable across turns for cache reuse.
- Full-file read returns the complete file when it fits, or a `partial` prefix with `next_line` when it does not. It never labels a prefix as full. Ranged reads emit complete UTF-8 lines only, a resumable `next_line` when budget-limited, and accurate actual range/EOF metadata. A selected first line too large for one response returns `line_too_large`. No successful item or batch may exceed its allocated model-facing byte budget, including JSON framing. A minimum-envelope budget failure happens before any write or Bash side effect.
- Preserve per-tool-call IDs, agent transcript order, provider replay, ACP event linkage, policy/whitelist/approval behavior, and cwd resolution. One explicit `ask` rule applies to the whole batch call; the approval display must summarize all item identities without dumping write contents. Default execution remains full-permission and automatic.
- Schema errors reject the complete call before approval/side effects. Runtime item errors do not erase successful earlier or later items. `ToolResult.isError` reports an actual item failure; Bash nonzero exits remain ordinary reported exit statuses. No symlink sandbox, transaction, or rollback is introduced.
- Read results and edit guards operate on the same original UTF-8 byte slices; preserve untouched file bytes, BOM, and CRLF. For line replacement, keep the following line separated even when replacement text lacks a terminal newline. Abort is checked between file entries; active Bash and descendants use existing cancellation behavior.

## Baseline
- Workspace `/Users/lploc94/projects/raw-cli`; Node >=22, TypeScript strict ESM. Existing UI changes were isolated in baseline commit `aa3ad25`; working tree was clean before this plan.
- `PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run check` passed **185/185** before batch changes. Existing default prompt is 25 reference tokens; three schemas plus prompt use 175 combined tokens. A local draft of the proposed flat array schemas measured about 406 combined tokens before final descriptions/limits, so the 500-token gate is achievable but must be measured again.
- Current contracts: `src/tools/registry.ts` declares/validates all three one-item schemas; `src/tools/primitives.ts` performs file work and invokes `runBash`; `src/tools/results.ts` caps UTF-8/JSON content; `src/tools/process.ts` supervises one shell process; `src/agent.ts` already dispatches multiple *distinct* model tool calls sequentially and links every result; `src/cli.ts` renders calls and bounded previews; `src/acp/methods.ts` maps tool events. Current `tests/primitives.test.ts`, `tests/registry.test.ts`, `tests/overhead.test.ts`, CLI/ACP/provider tests use the old argument shapes and must be updated at each owning phase.

## Design and project patterns
- Keep flat portable JSON Schemas in `builtIns` (`src/tools/registry.ts`), with item arrays and `additionalProperties:false`. Avoid provider-specific `oneOf`/conditional schema features; use `validateArgs` for cross-field mode/range rules, integer safety, nonempty arrays, and the 16-item maximum. Validate every entry before `onStart` and handler dispatch, following existing `ToolRegistry.dispatch` ordering.
- Reuse `ToolResult` and `capResult` (`src/tools/results.ts`). Add the smallest shared helper needed to account for UTF-8 bytes of serialized indexed JSON results and reserve minimal per-item status envelopes. Handlers should fit content into the remaining global budget **before** `capResult`; that function stays the final safety net, not the normal batch truncator. The JSON result shape is `{results:[{index,status,...}]}`; indices are 0-based and map directly to input arrays. Keep success/error metadata compact so 16 entries fit the default budget.
- Read files incrementally with bounded memory, preserving UTF-8 scalar boundaries and line-ending bytes. Compute SHA-256 only for selected bytes that were actually returned in a complete read/range; a partial range reports its actual end and digest for that returned span. Full reads that exceed their budget use `status:"partial"` with complete leading lines and `next_line`, following the user's later explicit decision. If even one selected line cannot fit, return `line_too_large` and its `next_line` without splitting it.
- `replace_lines` checks the selected original byte span's SHA-256 immediately before writing. Treat line numbers as 1-based and inclusive. Do not permit out-of-range writes. Replace only the selected span; if a later line exists and nonempty replacement does not end with a line break, add the original boundary line ending. `replace_text` requires one exact occurrence, no regex or silent replace-all. Empty `new_text`/`content` are valid where applicable.
- File batches execute sequentially, continue after runtime item errors, and report an item result for every index. Bash batches also continue after nonzero exit; reserve output space for every command status, then allocate bounded stdout/stderr space fairly so an early noisy command cannot hide later outcomes. Abort prevents later side effects and marks remaining entries skipped. Keep `runBash` as the single-command process supervisor.
- Update `src/cli.ts` to summarize nested write arguments (paths, modes, content byte counts) and display indexed batch result statuses without exposing full write bodies or changing the existing preview cap. ACP and provider adapters should reuse the registry result path rather than inventing a parallel batch protocol. No dependency or prompt change.

## Global Gates
- `git diff --check` passes at every phase and final HEAD.
- `PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run check` passes at each phase and final HEAD.
- `PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run test:overhead` reports three built-ins, prompt <=50 tokens, combined <=500 tokens.
- Final package qualification: `PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run test:package`; install with `PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm install -g .`; compare SHA-256 of `dist/raw.js` with `/opt/homebrew/lib/node_modules/raw-cli/dist/raw.js`; `raw --version` and `raw config list >/dev/null` succeed. The existing user credentials/config stay untouched.
- Each phase receives `gpt-6-astra` implementation review with verdict APPROVE, following the user's established review preference. Stage only phase-owned files and the plan bookkeeping; inspect for secrets; commit the phase once.

## Plan Review
APPROVE. Self-review verified current paths/symbols, phase ownership, 185/185 baseline, the exact three-tool/500-token gates, and the no-compatibility constraint. `gpt-6-astra` plan review (session `.codex-review/sessions/codex-plan-review-20260924-004`, one round) returned an explicit raw `APPROVE` with no blocking issues; its parser could not structure a verdict-only response, so the runner was finalized with that raw verdict. The reviewer could not use CTXE inside its read-only sandbox; local CTXE index/Ask and direct source/test inspection above provide the code-grounded evidence. The user explicitly approved implementation immediately after review.

## Phase 1: Bounded batch reads and shared result envelope
### Goal
One `read_file` call handles up to 16 independently selected files/modes without context overflow and establishes the indexed result/budget pattern used later.
### Current behavior and gap
`read_file({path})` returns a byte-capped prefix with no line selection or batch; a large file can masquerade as a full read. `capResult` alone can truncate a multi-item JSON envelope and hide later statuses.
### Evidence
`src/tools/registry.ts` `builtIns`/`validate`; `src/tools/primitives.ts` `readFileTool`; `src/tools/results.ts` `capResult`; `tests/primitives.test.ts`; `tests/overhead.test.ts`; `docs/tools.md`.
### Pattern
Keep one registry entry and `ToolResult`; validate before dispatch and account for serialized bytes before the shared cap. Preserve existing cwd and UTF-8/BOM behavior.
### Dependencies
Baseline commit `aa3ad25`; no new package.
### Files and symbols
`src/tools/registry.ts` (`builtIns`, validation); `src/tools/primitives.ts` (`readFileTool`); `src/tools/results.ts` (small indexed-result budget helper); `tests/primitives.test.ts`, `tests/registry.test.ts`, tests/fixtures that issue `read_file`; `docs/tools.md`; `tests/overhead.test.ts`.
### Behavioral contract
`{files:[{path,start_line?,end_line?,max_lines?,max_bytes?}]}`; 1–16 entries. `end_line` and `max_lines` are exclusive. Full means no line selectors and returns a complete result if it fits or a resumable partial prefix of whole lines. Start/count/range scans to EOF and may return fewer lines with `eof:true`. Output is indexed JSON; normal and error entries coexist; `next_line` enables paging. Global serialized bytes <= `maxOutputBytes` and per-entry `max_bytes` never raises it.
### Documentation
Update `docs/tools.md` first with exact shape, 1-based inclusive semantics, EOF/oversize/partial examples, and no old-shape compatibility.
### Tests first
Update old read fixtures and add tests for mixed batch modes, empty file, CRLF/BOM/Unicode, start past EOF, count larger than remaining lines, full large-file rejection, one line too large, missing/non-file item followed by success, and budget boundaries. Run the new focused test to RED before production.
### Anti-shortcut coverage
Test a huge full read plus a later small file: the huge entry returns only a bounded resumable prefix, the later result remains present, and the serialized result <= cap. Test range paging reconstructs exactly the original bytes across multiple calls, not a hardcoded prefix. Test `max_bytes` cannot bypass global cap and malformed entries cause zero reads/approval calls.
### Implementation obligations
Replace only `read_file` schema/handler; stream file bytes/lines with bounded memory; compute selected-span digest; reserve per-item envelope space; preserve array order and per-item statuses; update all read call sites/tests without a compatibility shim.
### Acceptance criteria
- [x] AC-1.1: Mixed full/range/count batch returns indexed correct content, range, EOF, and digest — proven by `tests/batch-read.test.ts`.
- [x] AC-1.2: Huge full file returns a bounded resumable partial prefix and later entries still execute under the shared byte cap — proven by `tests/batch-read.test.ts`.
- [x] AC-1.3: Old `{path}` shape and invalid cross-field combinations reject before side effects; exactly three schemas remain within overhead budget — proven by registry/overhead tests.
### Focused verification
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH node --import tsx --test tests/primitives.test.ts tests/registry.test.ts tests/overhead.test.ts`
### Phase gates
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run check`
### Review
Implementation review by `gpt-6-astra` is required; verdict must be APPROVE.
### Commit
`feat: add bounded batch file reads`

## Phase 2: Guarded batch writes with four modes
### Goal
One `write_file` call applies up to 16 ordered operations with per-item outcomes and four precise write modes.
### Current behavior and gap
`write_file({path,content})` always overwrites the entire file; it has no append, exact edit, line range, or batch result.
### Evidence
`src/tools/primitives.ts` `writeFileTool`; `src/tools/registry.ts` `builtIns`/`validate`; `src/tools/results.ts`; `tests/primitives.test.ts`, `tests/registry.test.ts`, `tests/registry-policy.test.ts`; `src/cli.ts` `toolArguments`.
### Pattern
Use existing sequential dispatch and `ToolResult` paths. Validate the complete batch before approval/onStart; file-level runtime errors become indexed results; no transaction layer.
### Dependencies
Phase 1 indexed result helper/digest contract.
### Files and symbols
`src/tools/registry.ts`, `src/tools/primitives.ts` (`writeFileTool`), `src/tools/results.ts` if needed; `src/cli.ts` nested argument summary; all tests/fixtures with `write_file`; `docs/tools.md`, `docs/cli.md`.
### Behavioral contract
`{operations:[{path,mode,content?,old_text?,new_text?,start_line?,end_line?,expected_sha256?}]}`; 1–16 items. Mode-specific fields required/exclusive. Overwrite creates parents and replaces full content; append adds exact content at EOF; replace_text changes exactly one unique old-text occurrence; replace_lines changes an inclusive existing range after digest match, preserving unaffected bytes and the following-line separator. Each runtime failure is recorded and later operations continue; all prior writes remain. Abort stops before the next item and marks remaining skipped.
### Documentation
Update `docs/tools.md`/`docs/cli.md` first with four mode examples, guard source, sequential/partial-success semantics, no rollback, and concise approval/log display.
### Tests first
Add RED tests for every mode, same-path ordering, empty content, line deletion, CRLF/BOM, mismatch/duplicate/no-match guards, out-of-range line edit, mixed fail/success batch, prevalidation before any write/approval, low-budget early failure, and abort between items. Migrate old write fixtures in CLI/ACP/provider tests to new inputs.
### Anti-shortcut coverage
Test that a changed selected span refuses a line edit while an unrelated later file still succeeds; `old_text` appearing twice refuses without touching bytes; replacing middle lines without a trailing newline does not join neighboring lines; input arrays are not mutated. Check CLI never prints nested write contents.
### Implementation obligations
Add mode-aware custom validation; implement ordered per-item writes and selected-span hash check; keep result envelope under shared cap; preserve unchanged bytes and explicit runtime errors; update all write call sites/tests without legacy form; summarize nested content lengths in TTY and approval UI.
### Acceptance criteria
- [x] AC-2.1: All four modes behave exactly as documented across normal, EOF, CRLF, empty, and same-path sequences — proven by `tests/batch-write.test.ts`.
- [x] AC-2.2: Guard failures and invalid schemas cause no unintended writes; later valid runtime items continue with accurate per-item status — proven by batch/registry tests.
- [x] AC-2.3: CLI/ACP/provider flows accept the new schema and do not echo write bodies in CLI/approval output — proven by CLI/ACP/provider tests.
### Focused verification
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH node --import tsx --test tests/primitives.test.ts tests/registry.test.ts tests/cli.test.ts tests/acp.test.ts`
### Phase gates
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run check`
### Review
Implementation review by `gpt-6-astra` is required; verdict must be APPROVE.
### Commit
`feat: add guarded batch file writes`

## Phase 3: Sequential batch Bash with complete status coverage
### Goal
One `bash` call executes up to 16 commands in order while keeping every outcome visible and respecting the single response budget.
### Current behavior and gap
`bash({command,timeout_ms?})` supervises one command; repeating model tool calls costs extra schema/result framing and does not guarantee one indexed batch result.
### Evidence
`src/tools/process.ts` `runBash`; `src/tools/primitives.ts` `bashTool`; `src/tools/registry.ts`; `tests/primitives.test.ts` Bash/abort tests; `src/agent.ts` abort behavior.
### Pattern
Loop over the existing `runBash` supervisor rather than spawn directly. Preserve its stdout/stderr, process-group, signal, timeout, and UTF-8 behavior.
### Dependencies
Phase 1 shared result helper; Phase 2 complete three-tool schema baseline.
### Files and symbols
`src/tools/registry.ts`, `src/tools/primitives.ts` (`bashTool`), `src/tools/process.ts` only if needed; Bash fixtures across tests; `docs/tools.md`, `docs/architecture.md`.
### Behavioral contract
`{commands:[{command,timeout_ms?}]}`; 1–16 entries. Sequential; nonzero exit is reported and later commands still run. Each index reports exit code/signal/timeout, bounded stdout/stderr, and truncation. Per-command output allocations reserve every later status under one `maxOutputBytes` cap. Abort kills the active process group, spawns no later command, and marks remaining indices skipped. One invalid command entry rejects the whole batch before spawn/approval.
### Documentation
Update `docs/tools.md` first with ordered execution, nonzero/timeout/abort semantics, status fields, and budget behavior.
### Tests first
Add RED tests for order-dependent commands, nonzero followed by success, separate stdout/stderr, first noisy command followed by later visible outcomes, Unicode cap, invalid entry before any spawn, timeout/abort with descendant cleanup and skipped indices. Migrate all old Bash fixtures.
### Anti-shortcut coverage
Use a first command that produces more than the entire budget, a second command that writes a marker, and a third command: all permitted commands must run in order and all statuses fit; the first cannot consume the later entries' reporting budget. Abort test proves the second marker is absent after cancelling the first active command.
### Implementation obligations
Replace Bash schema/handler; preserve `runBash` supervision; pre-reserve indexed status space, allocate bounded channel output fairly, aggregate under the global cap, and migrate tests without a single-command compatibility path.
### Acceptance criteria
- [x] AC-3.1: Ordered commands all report outcomes after nonzero exits, with distinct channels and shared byte cap — proven by `tests/batch-bash.test.ts`.
- [x] AC-3.2: Timeout/abort reaps the active process and prevents later spawns; invalid schema has zero side effects — proven by batch/process/registry tests.
- [x] AC-3.3: Tool count, prompt overhead, cache-stable schema, and provider transcript linkage remain valid — proven by overhead/cache/agent tests.
### Focused verification
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH node --import tsx --test tests/primitives.test.ts tests/registry.test.ts tests/agent-lifecycle.test.ts tests/overhead.test.ts`
### Phase gates
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run check`
### Review
Implementation review by `gpt-6-astra` is required; verdict must be APPROVE.
### Commit
`feat: run bounded sequential Bash batches`

## Phase 4: Cross-surface contract and installed qualification
### Goal
Prove real CLI/ACP/provider behavior for mixed batches, compact display, and unchanged model-context/cache guarantees; update the installed command.
### Current behavior and gap
Passing primitive tests alone does not prove arrays survive SDK function calling, ACP updates, CLI approval/log summaries, package build, and installed execution.
### Evidence
`src/agent.ts` tool-call/result linkage; `src/llm/content.ts` result serialization; `src/acp/methods.ts` `toolUpdate`; `src/cli.ts` `textRun`/approval; `tests/cli.test.ts`, `tests/acp.test.ts`, `tests/provider-content.test.ts`, `tests/package.test.ts`; `README.md`, `docs/architecture.md`, `docs/cli.md`, `docs/acp.md`.
### Pattern
Exercise the existing mock provider and ACP SDK fixtures through the production entrypoints. Keep the three built-in names, result preview limit, and credential redaction patterns.
### Dependencies
Phases 1–3 complete and reviewed.
### Files and symbols
`tests/cli.test.ts`, `tests/acp.test.ts`, `tests/provider-content.test.ts`, `tests/package.test.ts`, `tests/overhead.test.ts`; `src/cli.ts`, `src/acp/methods.ts` only for actual integration gaps; `README.md`, `docs/tools.md`, `docs/architecture.md`, `docs/cli.md`, `docs/acp.md`.
### Behavioral contract
One real model tool call per requested batch, stable schema across turns, correctly indexed full results in the next provider request, CLI result preview still <=2,000 characters and 10 logical lines, no write payload leakage in tool summary, ACP status updates preserve batch association, installed `raw` matches built bytes. No change to user config or credentials.
### Documentation
Finish user-facing examples for batch read/write/Bash, limits, exact edit guard, resumable full read, and differences between model-facing and CLI-display caps before integration code.
### Tests first
Add RED end-to-end fixture tests: mixed read modes in one call, mixed write modes with one guard failure and a later success, Bash nonzero then success, next-turn transcript/ACP update, bounded result display, and package consumer invocation. Use genuine SDK fixture routes, not direct handler-only tests.
### Anti-shortcut coverage
Inspect the second inference request to verify complete indexed batch status/content and stable system/tool-schema prefix. Change inputs/paths between cases to reject hardcoded responses. Assert installed artifact hash and `raw config list` without exposing secrets.
### Implementation obligations
Close only demonstrated cross-surface gaps; update documentation/examples and installed package; do not add fourth built-in, compatibility shim, configuration migration, dependency, or hidden prompt. Review cumulative diff for accidental model-context or cache regressions.
### Acceptance criteria
- [x] AC-4.1: CLI/ACP/provider/package tests prove the batch schemas and result linkage through real adapters — proven by `tests/batch-integration.test.ts` and `tests/package.test.ts`.
- [x] AC-4.2: Prompt/definition budget, global result cap, CLI preview cap, and cache-stable schema remain within contracts — proven by overhead, budget, and replay tests.
- [x] AC-4.3: Installed `raw` matches source build and runs with current config without credential exposure — proven by SHA-256 comparison and smoke commands.
### Focused verification
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH node --import tsx --test tests/cli.test.ts tests/acp.test.ts tests/provider-content.test.ts tests/package.test.ts tests/overhead.test.ts`
### Phase gates
`PATH=/Users/lploc94/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH npm run check`
### Review
Implementation review by `gpt-6-astra` is required; verdict must be APPROVE.
### Commit
`docs: qualify batch built-ins across CLI and ACP`

## Completion Criteria
- [x] Every AC-1 through AC-4 is checked with named evidence, every phase review returned raw APPROVE, all phase and global gates pass, and four cohesive phase commits plus plan bookkeeping exist.
- [x] The installed `/opt/homebrew/bin/raw` uses the final build, user config remains valid, no secrets appear in commits or test output, and the worktree is clean apart from explicitly recorded unrelated changes.

## Progress Log
| Phase | State | Evidence | Review | Commit |
|---|---|---|---|---|
| 1. Bounded batch reads | complete | 193/193 full tests; 15/15 focused; prompt/schema 267 tokens | Astra round 3 raw APPROVE (runner parser retained prior REVISE) | `feat: add bounded batch file reads` |
| 2. Guarded batch writes | complete | 200/200 full tests; 371 prompt/schema tokens; abort and dense-file regressions | Astra round 2 raw APPROVE (runner parser retained prior REVISE) | `feat: add guarded batch file writes` |
| 3. Sequential batch Bash | complete | 205/205 full tests; 408 prompt/schema tokens; escaped-output fairness regression | Astra round 2 raw APPROVE (runner parser retained prior REVISE) | `feat: run bounded sequential Bash batches` |
| 4. Cross-surface qualification | complete | 209/209 full tests; package consumer pass; 408 tokens; installed hash `83858857…`; config smoke pass | Astra round 2 raw APPROVE (runner parser retained prior REVISE) | `docs: qualify batch built-ins across CLI and ACP` |
