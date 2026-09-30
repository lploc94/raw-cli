# Refactor shared tool UI and extend Raw builtins

## Plan schema
loop-plan/v1

## Target

Give Raw one structured tool UI system that renders in chat or the sidebar, with reusable form responses and Mermaid diagrams. Ship `builtin/ask_user`, session-scoped process management, and patch support inside `builtin/write_file`. Provide a useful sidebar containing Todo, Files changed, and Commands without making every tool invocation create a section.

User authorized implementation, then clarified that this project is in development: no migration and no backward compatibility. This revision follows that decision. Implementation begins after the required independent plan review reaches APPROVE; no further approval is needed for the explicitly authorized contract replacement.

## Scope

- Replace the development panel/tool/hook contracts consistently across validation, host, storage, rendering, actions and surface adapters. No old-contract adapters, migration, aliases or dual parsers.
- Declare `placement: "chat" | "sidebar"` in tool UI metadata. Sidebar is the default. Use one block renderer and interaction service for both placements.
- Add a form block, a response action, and durable request/response records. Ask uses this common mechanism, not its own React workflow or the boolean approval service.
- Add `builtin/ask_user`, selected explicitly like Todo; keep starter tool selection unchanged.
- Add one `builtin/process` with start/list/status/output/stop operations, a host-owned supervisor, and a Commands sidebar projection shared with foreground Bash activity.
- Extend `write_file` with mutually exclusive `operations` and `patch` input shapes. Add Files changed for successful writes through this tool, including patches.
- Define typed `effects` alongside original arguments in the new policy/hook inspection contract. All repository configuration/examples/fixtures adopt explicit condition sources directly. Never synthesize an `operations` argument; no configuration migration feature.
- Add a Mermaid block and render fenced Mermaid in chat Markdown using the same diagram component. Provide a bundled local-tool example publishing a Mermaid block to the sidebar. No separate drawing builtin is needed in this iteration.
- Update dashboard, CLI, library, ACP adapters, package capability checks, generated examples, and documentation.

Explicit exclusions: search/find builtins; XML, SVG authoring, draw.io, arbitrary HTML, arbitrary plugin JavaScript or iframe apps; Git/workspace-wide change tracking; browser/web tools; multi-agent execution; image preview/zoom; an external persistent process daemon; interactive terminal/stdin/PTY; transparent resumption of JavaScript handlers after a host crash; auto-restart/re-run of commands; editing diagrams visually; a user-facing choice of placement on every model call; simultaneous chat/sidebar copies of the same interactive view.

## Invariants

1. One current tool/UI/hook contract is authoritative. All first-party tools, Todo actions, configs, packages and tests are updated to it. Keep established operations/Bash execution behavior unless the plan explicitly changes it. No migration or backward compatibility layer is built.
2. Canonical tool identity owns declarations, updates, and interactions. A display alias, posted owner string, or panel ID cannot grant authority.
3. Tool policy, input validation, hooks, and approval remain in effect for execution. Arguments remain the original validated call input; intended effects are a distinct, validated, immutable inspection value. A form response supplies data to an existing request; it does not grant tool permission or start a second turn.
4. UI-only bytes stay out of model tool results, provider payloads, and hooks. Every accepted Ask answer fits the call's actual output budget and reaches the model losslessly through normal registry/provider serialization. Historical chat cards never turn into the newest unrelated call's UI.
5. Ordinary panel updates retain the tool-result commit boundary. Requests waiting for a user and process events have explicit independent durability; they cannot be smuggled through a stale `PanelCall` after handler completion.
6. A reload/reconnect recovers authoritative state. A terminated host cannot truthfully claim to retain a waiting handler or control a child solely from a stored PID. Session deletion/expiry cannot remove live process ownership records, including through a foreign host or the public store API.
7. UI rendering failures degrade to readable source/text. Invalid response schemas fail the requesting interaction promptly; they must not leave an invisible indefinite wait.
8. Memory, logs, diagram source, history previews, and UI updates are bounded. No stdout or secrets resolved from `env_refs` are inserted into command metadata automatically.
9. Existing sidebar opening, focus, hidden-section, narrow-screen, and keyboard behavior is preserved. No output update steals focus.
10. Changes are docs-first and tests-first per phase, with one cohesive commit and an APPROVE implementation review before advancing.

## Baseline

- Workspace: `/Users/lploc94/projects/raw-cli`; baseline HEAD `983cd2f` (2026-09-30). Initial `git status --short` was clean.
- Existing panel implementation is complete; commits `5a28ed4..41a5a0d` and `implement-tool-panels-plan.md` are prior work, not work to repeat.
- Nine bundled tools: read_file, write_file, bash, view_image, list_skills, load_skill, list_vars, read_var, todo. Only Todo declares a panel.
- Read user-provided global instructions. No filesystem `AGENTS.md` was found in the repository discovery or the workspace ancestor paths.
- CTXE status was Ready/fresh. Ask record 79 provided a flow map but returned partial evidence and a planner error; it is not completeness proof. In particular some selected `tests/panels-host.test.ts` bodies were unavailable and several documentation excerpts partial. The relevant host, tests, contracts, operations, and surface code were verified by direct reads instead.
- `npm run typecheck` passed during planning. Full tests, build, and browser suites were not run; this plan changes no production code.
- Existing CI qualifies Ubuntu/macOS on Node 22.13.0 and 24; it has no Windows job. This plan does not silently expand the project's platform qualification scope.
- Product clarification: user selected **Mermaid first; XML later**.

## Design and project patterns

### Grounded integration map

| Existing code | Verified role / design consequence |
| --- | --- |
| `src/panels/contract.ts`, `validate.ts`, `patch.ts` | Shared typed blocks, strict validation, revisions, eight current block kinds; actions are currently prompt/tool only. Extend centrally. |
| `src/panels/host.ts`: `PanelHost`, `PanelCall` | Per-runtime provisional state; `begin()` rolls back unsettled state and `endWindow()` closes streaming. Do not reuse for background publishing. |
| `src/agent.ts`: `AgentSession`, result commit and panel actions | Creates panel contexts, strips UI through registry, commits result/receipts/state, reminds on compaction. Retain ordinary tool-result commit semantics while replacing the protocol. |
| `src/tools/registry.ts`, `plugins/manifest.ts`, `plugins/loader.ts` | Policy/validation/hook/approval boundary; manifest parsing; builtin allowlist. Services must pass through supported plugin context forwarding. |
| `src/sessions/schema.ts`, `store.ts`, `view.ts`, `restore.ts` | SQLite store, owner generations, result persistence and interrupted-call recovery. Existing auxiliary tables use additive creation at schema v5. |
| `src/sessions/operations.ts`, `runtime.ts` | Dashboard attaches and closes agent/runtime for each operation. Long-running process service must live above this scope. |
| `src/dashboard/approvals.ts`: `Approvals` | In-memory boolean permission wait, operation/call binding, abort/deadline handling. Reuse lifecycle principles, not its permission semantics or in-memory-only storage. |
| `web/src/timeline.tsx`: `ApprovalActions`, tool card | Existing inline interaction location; render common tool UI here without hardcoding Ask. |
| `web/src/panels/Blocks.tsx`, `SidePanel.tsx`, `use-panels.ts`, `panel-state.ts` | Reusable block dispatch and existing sidebar section/visibility preferences. Preserve sidebar UX. |
| `src/tools/primitives.ts`: `writeFileTool`, `bashTool`; `src/tools/process.ts`: `runBash` | Batched writes and foreground shell supervision. Existing write modes are not a multi-file patch parser. |
| `src/dashboard/live-output.ts` | Bounded UTF-8 output paging precedent. Process logs need independent retention, not operation-end deletion. |
| `src/acp/methods.ts`, `rpc.ts`, `panels.ts`, `client.ts`; `src/cli.ts` | Negotiated extensions, ACP permission requests, TTY input, text fallbacks. New interaction capability must not masquerade as permission. |
| `src/packages/contract.ts`, `export.ts`; build scripts | `raw.panel/1` capability and explicit builtin packaging lists require updates. |
| `web/src/markdown.tsx`: `Markdown`, `CodeBlock` | Fenced code currently gets syntax highlighting only; shared Mermaid component integrates here and in block dispatch. |

### D1 — One current shared UI/tool/hook contract

Replace `raw.panel/1` with `raw.panel/2` as the only supported panel protocol. Tool manifests use `api_version: 2` and `raw.tool-api/2`; hooks use required `protocol_version: 2` and `raw.hook/2`. Update all builtin/local-example/package fixtures and consumers directly. Do not retain v1 parsers, adapters, protocol selection per declaration, legacy capability names, migration commands or aliases. A panel declaration has `placement: "chat" | "sidebar"`, default sidebar, and every panel context reports `protocol: 2`. Retain the existing `panels` manifest key and shared update/commit architecture.

Replace `schemas/raw-panel.schema.json` in place with the new authoritative schema; no parallel v1/v2 schema files. Package capability export advertises only the current tool/hook/panel contracts plus effects where used. ACP negotiates `panelsV2` and `interactions`; remove the previous raw panels extension flag and update first-party ACP clients/fixtures. A peer without panelsV2 can still receive standard ACP text/plan updates and source fallbacks; this is capability absence handling, not an old Raw extension adapter.

Use session schema version 6 and the existing storage-version-directory convention (`storage-v6`) for new development databases. No migration of v5 sessions or UI preferences is required. Do not delete older state files automatically; leave them outside the current store, following existing obsolete-store behavior. Add/update tables under the current schema, and test continuity/reload/recovery within the new contract. The original schema/persistence fixtures are updated rather than maintained as supported old formats.

Placement is static tool metadata. It controls presentation, not permission or waiting semantics. A tool may declare separate named views if it intentionally needs both destinations; the host does not duplicate a form automatically.

### D2 — View identity and historical truth

Sidebar declarations keep session identity `<owner>#<panel>`. Chat declarations use an opaque host-generated instance ID bound to session, operation/run, toolCallId and declaration ID; repeated calls get distinct instances. A call may revise its instance until settlement. Persist final inline snapshots separately from latest sidebar state; history references the instance, never a latest-state lookup.

Keep the existing 16-panel session cap for sidebar state. Chat instances are history-backed and paged/retained with history, not counted against that cap. Existing document/block byte limits apply; no eager loading of all historical UI documents. Compaction reminders continue to target selected open sidebar summaries; old form answers already present in model context are not repeatedly injected.

### D3 — Reusable interactions, not an Ask-only branch

Add `context.interactions.request({ panel, document, timeout_ms? })` for local tools. It validates a declared v2 view containing exactly one form block, binds the current call, persists a pending request before publishing, and returns a typed terminal response. In-memory library use has the same lifecycle without claiming durability. No available response adapter means immediate `interaction_unavailable`.

The form block has 1–8 fields with stable unique IDs, labels and optional descriptions; kinds `text`, `single_select`, `multi_select`. Text supports multiline and a hard ceiling of 8 KiB; select fields have 1–32 unique option IDs and labels. Required fields and min/max selection counts are validated by host and browser. Entire answers have a hard ceiling of 16 KiB, further reduced by the actual call output budget as described below; these ceilings are not unconditional advertised capacities. Empty/unknown/duplicate fields and selections get precise errors. Plain text only; no arbitrary JSON Schema form builder, scripts, secret/password field, or attachment upload.

Budget-aware delivery: use one canonical response-result serializer for the interaction service and Ask handler. Capture `context.maxOutputBytes` at request creation, calculate the complete JSON result bytes (including status, question IDs, option IDs, escaping and any generated envelope fields), and publish the effective aggregate budget plus reduced field limits with the form. Reject a request with `interaction_budget_too_small` before publishing if even its minimum valid answer/result envelope cannot fit; inspect known option combinations and required selections. If declared maxima exceed capacity, lower the effective limits rather than promising 8/16 KiB. Browser and server share the byte-counting oracle; JSON escaping and multibyte text both count, and the aggregate encoded-result check is authoritative.

Before pending-to-answered CAS, serialize the full submitted result and verify it fits both the captured output budget and protocol limits. An over-budget submission returns a validation error, retains the pending request and form draft, and never records an accepted answer. Persist the exact accepted canonical result with the response acknowledgement. `ask_user` returns that single JSON block unchanged through ordinary `capResult` and provider conversion, with no extra result prefix or additional answer payload that could consume the reserved budget. UI receipts remain host-only. Generic local tools may use the same canonical result helper; their own deliberate transformation/additional output remains their tool contract and cannot claim Ask's lossless-delivery guarantee. No answer exemption from output limits and no global budget increase are introduced.

Declare block-scoped `kind: "response"` actions with `response: "submit" | "cancel"`. They use the same renderer/action resolver in either placement. Submission includes request ID, expected revision and an idempotency key, and is bound server-side to session/call/operation/owner. It atomically wins a pending-to-terminal transition. Same-key/same-body retry returns the recorded acknowledgement; conflicting replay or a second response is rejected. A response route must work while its parent turn owns the operation lease, without enqueueing a competing panel-action operation.

States: pending, answered, cancelled, expired, interrupted. Default timeout 30 minutes, caller-selectable positive timeout up to 24 hours. Abort cancels. Reload/reconnect with the host alive preserves the wait. Host loss leaves a durable interrupted question/answer record; recovery does not rerun arbitrary tools or revive a Promise. A model can issue a fresh Ask on a later turn. Accepted answers remain visible if the host dies before committing the tool result, but are not fabricated into a successfully completed call.

`builtin/ask_user` accepts 1–3 questions mapped to the common fields, an optional title and timeout; each question supports text/single/multiple choice plus optional free text via an explicit extra field. Return stable question IDs, selected option IDs and text, or a clear terminal cancellation/timeout error. Its declaration uses chat placement. A non-Ask fixture proves that sidebar forms use the identical service.

Approval remains separate: a response is information, never permission. Remote MCP tools may publish display-only v2 blocks but do not acquire a reverse waiting API in this iteration. Unsupported remote response forms show an unavailable notice; they do not expose dead Submit controls.

### D4 — Host-owned processes and the Commands projection

Add `builtin/process` with discriminated `action: start | list | status | output | stop`. Start requires `command`, accepts label, cwd relative to the session, env_refs and optional timeout; returns an opaque process ID once spawning is confirmed. No readiness claim without an explicit future readiness feature. Non-start operations take IDs/cursors, never OS PIDs. This is the same shell authority as Bash, explicitly selected and governed by its own canonical tool policy.

The supervisor belongs to the dashboard server, CLI invocation or ACP connection, keyed by session. It survives per-turn runtime teardown and browser disconnects. A turn abort terminates foreground Bash and in-flight starts not yet acknowledged; already acknowledged background jobs remain until Stop, their own deadline, session deletion or host shutdown. Host shutdown attempts bounded process-tree cleanup. A crashed host's rows become `lost`; do not signal or adopt stored PIDs. Detached grandchildren and crash-surviving OS processes are outside the guarantee and must be documented accurately.

Deletion/start admission is fenced in the store, not only at dashboard routes. Reserve a durable `starting` ownership record and check the session deletion fence in one transaction before spawning; no spawn follows a rejected reservation. Every `SessionStore.deleteSession` entry point, including `cleanupExpired`, public library deletion, CLI, ACP and dashboard, must reject/defer with a busy-process outcome while a live supervisor owns starting/running/stopping jobs. A free model-turn lease alone does not make the session deletable. Expiry skips these sessions without aborting the maintenance pass.

For owner-host deletion, atomically set a session deletion fence before stopping jobs, thereby rejecting new start reservations. Complete bounded supervised cleanup and settle ownership before final deletion; if any live job cannot be confirmed settled, retain session/process records and report deletion failure. A foreign store cannot stop the owner's jobs: explicit deletion fails clearly and expiry defers. After demonstrable host death, recovery marks its jobs lost without signalling recorded PIDs; deletion can then proceed with the documented crash limitation. Test admission-versus-delete races in both orders. This adds no daemon and no new shell authority.

Use a shared child supervisor primitive beneath foreground Bash and background Process, retaining existing Bash timeout, ordering, result budget and process-group behavior. States: starting, running, stopping, exited, failed, stopped, timed_out, lost. Store exit code/signal; nonzero normal exit is failed in UI even though current Bash transport `status: ok` still means it finished. Stop is idempotent for settled jobs. Initial managed background execution targets the already-qualified macOS/Linux hosts; on Windows, start returns `unsupported_platform` before spawning. Preserve existing foreground Bash behavior there. Adding qualified Windows tree supervision is follow-up scope, not a hidden implementation dependency.

Bound to 8 live jobs per session and 32 per host; retain 100 terminal records per session, evict oldest terminal records only. Keep at most 1 MiB recent UTF-8 output per job with absolute cursor, earliest available cursor and explicit dropped/truncated information; page at most 64 KiB. Coalesce live output at 250 ms. Separate stdout/stderr labels; do not claim total ordering across OS streams. Persist bounded snapshots/logs under existing private state storage, with retention cleanup.

Process rows have their own host token/generation and CAS revision, independent of model-turn leases. They do not mutate `PanelHost` working state. Commands is a host-composed sidebar view with stable ID, separate from canonical tool-owned panels; include foreground Bash rows and process rows together, with source owner metadata. Its status/output/Stop controls route to authorized process operations. Read/Stop must work while a model turn is active; use a dedicated audited control dispatch with policy/hooks/approval, not a concurrent model turn or a handler bypass. Each control gets its own control/call ID and durable service event; it never appends model messages or steals the active writer lease. Recheck the selected tool/policy before executing control and reuse registry dispatch with a restricted service context. Status/log reads do not execute shell commands. Host-authored terminal events carry no model command execution authority. Commands shows Stop only for managed background jobs in this iteration; foreground cancellation continues to use the existing turn cancel action.

### D5 — Patch support inside write_file and Files changed

Accept exactly one of `{ operations: [...] }` (unchanged) or `{ patch: string }`. Support one documented text patch dialect: `*** Begin Patch`, Add File, Update File with context hunks, optional Move to, Delete File, `*** End Patch`. Include explicit end-of-file/no-final-newline semantics and examples in docs; this is not arbitrary Git patch compatibility. Limit to 1 MiB source, 64 affected paths and 16 MiB UTF-8 source bytes per affected file. Reject binary patches, contradictory/repeated targets and ambiguous context matches. Added files require absent destinations; updates/deletes require existing regular files; renames must not clobber destinations. For this new patch mode reject symlink targets/destinations and symlinked parent paths; existing operations retain their path behavior.

For the patch grammar, added file lines start with `+`; update hunks start with bare `@@` and contain context (` `), added (`+`), or removed (`-`) lines. Context matching must be unique within the remaining ordered source; reject overlapping or out-of-order hunks. `*** End of File` anchors a hunk to EOF. A terminal `*** No newline at end of file` marker sets the resulting file's EOF to have no separator; absent that marker, additions end with LF and updates retain their original final-newline state. Do not accept numeric Git hunk headers or alternate patch dialects silently.

Parse, resolve paths and stage every resultant file before the first mutation. Capture source bytes/hashes and recheck before applying changes. Invalid syntax, missing/context-conflicting files, duplicate destinations, or known preflight conflicts produce zero file mutations. Preserve BOM and existing line separators; inserted lines use the adjacent source separator, falling back to the first separator in the file and then LF. No fuzzy whitespace matching. Filesystem races after a recheck remain possible and must not be described as a transactional concurrency guarantee.

Do not promise a cross-file filesystem transaction. Apply in documented patch order; use staged same-directory replacement where appropriate, preserve file permissions, and report applied/failed/skipped rows on an I/O error or an external edit detected during application. Stop subsequent patch changes on application failure; do not blindly roll back over an external writer. Tests must distinguish preflight all-or-nothing from partial I/O failure. Ordinary operations retain their current continue-after-runtime-error behavior.

Declare Files changed under `builtin/write_file`, `placement: sidebar`, title Files changed. Track successful tool operations only, deduplicated by normalized path with current session-relative status and bounded recent diffs. Renames show old/new paths. Record only completed changes, including completed operations in a partially failed call. State is session history of tool writes, not Git status or a promise to detect Bash edits. Bound files to 200 and include an omitted count; bound diff previews to the existing Markdown/document limits with explicit truncation. Counts describe emitted changes accurately, not uncomputed whole-workspace totals. No revert button in this iteration.

### D6 — Mermaid is a common visual block

V2 block: `{ id, kind: "mermaid", source, title?, fallback? }`; source at most 16 KiB. One lazy-loaded `MermaidDiagram` component renders this block in either placement and completed Mermaid code fences in `Markdown`. Streaming unfinished fences stay readable source until complete. Add diagram/source toggle, copy source, accessible caption/fallback and scroll-to-fit behavior. No separate drawing builtin; a local plugin example demonstrates sidebar publishing.

Use a pinned Mermaid dependency and lockfile, initialize explicitly with `startOnLoad: false`, `securityLevel: "strict"`, bounded text/edge limits, and protected configuration. Reject source-level init/frontmatter configuration overrides for this first version. Rendered output must reject scripts, event handlers, foreignObject, external resource URLs and navigable links; do not invoke generated callback bindings. Use supported sanitization rather than regular-expression HTML cleaning. Verify no network requests and no page script execution with hostile fixtures. CSS/theme integration must satisfy the dashboard's existing CSP without weakening it. Parse/render failure shows source and a bounded diagnostic; it never fails the tool/turn.

Official references checked 2026-09-30: [Mermaid usage](https://mermaid.js.org/config/usage.html), [configuration schema](https://mermaid.js.org/config/schema-docs/config.html). They document explicit initialization, strict mode encoding HTML/disabling clicks, and protected `secure` configuration keys. These features do not substitute for the application-level output/no-network tests above. Resolve and pin the exact compatible package version during the diagram phase, not an unverified version guessed in this plan.

### D7 — Explicit effects inspection for policy, approval and hooks

Arguments are the original validated call input. Intended effects are a separate typed inspection value. In the new tool API, a tool may declare `effects_schema` and allowed `condition_sources` in its manifest/registration, and export `describeEffects(args, {cwd})`. `condition_sources` lists allowed predicate sources; effects is allowed only with a declared schema/descriptor. Update all first-party manifests explicitly; effects-free tools use `["arguments"]`, while write_file uses `["effects"]`. These metadata fields never enter the model's input schema. `raw.tool-effects/1` identifies this new feature contract and is exported when used, not an old API compatibility feature.

The descriptor runs after exposure/unconditional deny and complete input validation, before conditional policy, PreToolUse and approval. It performs bounded parsing/lexical path normalization only: no file reads, shell execution, providers, variable resolution or mutation. Tool code is trusted like existing validators; this is an API obligation, not OS isolation. Reject invalid effects or descriptor failure before handler execution. Deep-freeze the prepared descriptor for the entire call. File preflight/application remains after approval, and uses the same parsed patch targets; no second interpretation may introduce an uninspected destination. Abort and output limits remain normal dispatch concerns.

Conditional predicates require `source: "arguments" | "effects"`. There is no omission default/old predicate adapter. Bind `any` to the selected declared schema at registration and evaluate only that source. Reject unavailable/disallowed sources rather than interpreting missing effects as no-match. Rule ordering and last-match behavior continue as designed. Share source-aware binding/evaluation between policies and hook subscriptions. Update all repository configs/docs/examples/fixtures directly to explicit sources. Obsolete conditions fail strict validation with a current-schema diagnostic; no migration behavior or automatic rewriting.

For write_file, effects schema is `{ files: [{ path: string, operation: "write" | "delete" | "rename_source" | "rename_destination" }] }`. Operations and patch mode both populate it. `path` is an absolute lexical normalization against session cwd (not realpath or a symlink security boundary); preserve raw path spelling in arguments. Deduplicating identical path/operation entries in the inspection projection is allowed; execution order/outcomes use the original operations or parsed patch. Rename contributes both source and destination. Overwrite describes an intended write regardless of file existence. Effects describe intention, not actual completion or a forecast of arbitrary Bash behavior.

Current write policy/hook examples use `{"source":"effects","any":"files[*].path","regex":"..."}`; conditions on intended operation types use `files[*].operation`. Byte/content-specific logic can inspect original arguments inside a hook script. Original arguments are not changed, enriched with fake operations, or evaluated as if they contained effects.

Replace the approval callback contract with one request object containing tool identity/name, original arguments, separate effects when declared, call/control identity and abort signal. Update dashboard, CLI, ACP and library callers/fixtures directly; no positional-callback adapter. Approval surfaces show affected files separately. Hook protocol 2 payloads include `tool.arguments` and optional `tool.effects`; the hook manifest explicitly declares protocol_version 2. Policies, model dispatch, user actions and process controls use the same effect preparation and source-aware gates. Effects remain immutable host metadata, excluded from provider arguments and model input except concise authorized outcomes.

Test write/patch intentions against identical files predicates; rename destinations; source-schema binding failures; malformed patch before publishing effects; descriptor/execution target consistency; conditional hook denial before I/O; exact original arguments in approval/hooks/history; required condition sources and single-contract package export. No matcher contains a hardcoded patch-to-operations fallback.

## Global Gates

- Before each phase: recheck Git state and relevant current source. Write normative docs and failing behavioral tests before implementation. Keep generated example edits consistent with the build scripts.
- After each production phase: `npm run typecheck` and its listed focused tests must exit 0. A passing test must actually exercise the production route/service, not only duplicate validation logic.
- Final repository regression gate: `npm run check` (includes build and all Node suites), `npm run test:web`, and `npm run test:overhead`. All must pass; record actual output, failures and resolutions in the Progress Log. Overhead is reported, not subject to an invented token ceiling.
- Packaging: `npm run test:package` and installed/forked tool fixtures must prove Ask/Process entrypoints and new schemas/assets are included without source-checkout imports.
- Browser evidence: chat/sidebar forms, ongoing/finished processes, Files changed, Mermaid diagram/source/error, light/dark, narrow viewport and keyboard/axe. Run the configured Chromium, Firefox and WebKit projects.
- POSIX process-group tests run on the existing macOS/Linux CI matrix. Test the Windows `unsupported_platform` branch with a platform-injected supervisor fixture that asserts no spawn. No Windows tree-cleanup claim is included; adding it later requires native qualification. Do not reuse CTXE-specific personal host authorization for this different project.
- Do not mark complete while a required gate is unrun or failing. Record unavailable infrastructure as a blocker, not a passing result. No deployment or release work is included.

## Plan Review

Status: **APPROVE — independent gpt-6-astra review, round 2, 2026-09-30.** All three high findings resolved; no remaining blockers.

Reviewed intent fidelity, existing protocol/package/surface seams, historical view identity, durability before waiting, response races, host-versus-turn process ownership, policy-preserving controls, patch failure semantics, diagram reachability, generated packaging, test commands and phase dependencies. Corrected platform scope to match current CI, made patch grammar explicit, and separated process control audit from model-turn writes. Confirmed all nine phases have the required contract sections and all 18 acceptance criteria have observable verification. New paths are identified as new; existing key paths were checked. This is not an external peer-review verdict or implementation approval.

User authorization: implementation requested. Latest decision replaces development contracts directly with no migration/backward compatibility. Proceed to implementation after independent plan review APPROVE; do not ask again for approval of this explicit decision.

Independent review: `codex-plan-review`, model `gpt-6-astra`, effort high, session `.codex-review/sessions/codex-plan-review-20260930-001`. Round 1 had three high findings. ISSUE-1 resolved with directly replaced contracts, typed effects and explicit predicate sources; ISSUE-2 with lossless budget-aware Ask responses; ISSUE-3 with transactional process admission/deletion fencing. Round 2 explicitly returned APPROVE with no remaining findings. The runner could not structure the verdict-only response; the raw reviewer text is the approval evidence. Session finalized and stopped normally.

## Phase 1: Replace the shared UI and inspection contracts
Status: complete.
### Goal
Define and validate the sole current shared UI, tool API, hooks and effects inspection contracts; update all first-party producers/consumers directly.
### Current behavior and gap
Panel declarations have no placement or response action; contract is v1 and manifests/package export assume it. Policy/hook predicates only inspect original arguments, so alternate write input needs a declared effects inspection source rather than argument synthesis.
### Evidence
`src/panels/contract.ts`, `validate.ts`, `src/tools/plugins/manifest.ts`, `src/packages/contract.ts`, `export.ts`, `docs/panels-design.md` §17; `src/tools/policy.ts`, `src/hooks/{contract,manifest,dispatcher}.ts`, `src/tools/registry.ts`.
### Pattern
Central typed contracts plus strict manifest/schema validation and explicit capability negotiation. Bind predicates to their selected source schema, with no implicit argument/effects substitution.
### Dependencies
Approved plan; no prior implementation phase.
### Files and symbols
Existing evidence files; `schemas/raw-panel.schema.json`; updated `schemas/raw-panel.schema.json`; `src/tools/plugins/{contract,loader,manifest}.ts`, `src/sessions/{schema,location,store}.ts`, `src/tools/{registry,policy,primitives}.ts`, `src/hooks/{contract,manifest,dispatcher,runner}.ts`, `src/config.ts`, `src/acp/rpc.ts`, `src/acp/methods.ts`, `src/index.ts`; relevant protocol/declaration/package/policy/hook tests.
### Behavioral contract
Implement D1 and D7 as the sole current contract; define form, Mermaid, response action and view/request identifiers from D2/D3/D6. Update every first-party manifest, config, registration, hook payload, exported API and example to the new contract. Condition source is explicit. Effects descriptors are optional only for tools that do not declare effects. Implement an operations-only write effects descriptor now; phase 7 extends it with patch targets. Remove old capability/parser branches; obsolete formats fail clearly.
### Documentation
Update `docs/panels-design.md` with the single current wire shape, placement rules, limits and capability fallback matrix. Document effects schema/descriptor, explicit predicate sources, current tool manifests and hook payloads in `docs/{tools,hooks,configuration}.md`. State that development formats are replaced directly; no migration guide or feature is included.
### Tests first
Update first-party fixtures in panel, package, registry and hook tests to the new contract; add `tests/tool-ui-protocol.test.ts` and `tests/tool-effects.test.ts` for strict schemas, source binding, descriptor lifecycle and obsolete-format rejection.
### Anti-shortcut coverage
Load the updated Todo and packaged/forked fixtures against only the new contract; reject obsolete manifests/payloads rather than adapting them. Unknown visual kinds still fall back within the current protocol. A fixture accepts patch-like input, exposes effects and gates approval/hooks by path without invented argument fields; omitted/mismatched/unavailable inspection sources fail clearly. Descriptor errors/abort prevent handlers from running.
### Implementation obligations
Replace schemas/capability export/public types and all declaration ingestion paths, remove old-contract support and update generated first-party artifacts. Add shared effect preparation and source-aware predicate evaluation/validation without hardcoded builtin patch logic. Retain dispatch deny/validation/hook/approval ordering with preparation inserted at the documented boundary. Do not expose form controls before a response adapter exists.
### Acceptance criteria
- [x] AC-1: All first-party producers/consumers use the sole current contract, obsolete/invalid formats fail clearly, and predicates/approval/hooks inspect effects without mutating arguments — protocol/declaration/effects tests; full regression 769/769 and focused 20/20.
- [x] AC-2: Exported/installed packages declare correct current tool/panel/effects/hook capabilities; no old-contract adaptation occurs — package and hook-contract tests; sharing gate 52/52, installed package workflow in full regression.
### Focused verification
`node --import tsx --test tests/panels-protocol.test.ts tests/panels-declarations.test.ts tests/tool-ui-protocol.test.ts tests/tool-effects.test.ts tests/package-manifest.test.ts tests/registry-policy.test.ts tests/hooks-config.test.ts`
### Phase gates
`npm run typecheck`
`npm run test:phase -- sharing`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: define shared tool UI and explicit effect inspection contracts`

## Phase 2: Persist call-scoped views and share chat/sidebar rendering
Status: complete.
### Goal
Display the same structured blocks at either placement with correct historical identity.
### Current behavior and gap
Latest panel state is keyed only by owner/declaration; timeline contains receipts, so simply embedding latest state would overwrite earlier calls' presentations.
### Evidence
`PanelHost.begin`, `PanelCall`, `AgentSession` result commit, `src/sessions/store.ts`, `web/src/timeline.tsx`, `web/src/panels/Blocks.tsx`.
### Pattern
Atomic tool-result persistence, history references, authoritative stream snapshots and one shared renderer.
### Dependencies
Phase 1.
### Files and symbols
`src/panels/{host,stack,render,contract}.ts`, `src/agent.ts`, `src/tools/types.ts`, `src/sessions/{schema,store,view,visible,maintenance}.ts`, `src/dashboard/{sessions,streams}.ts`, `web/src/session.ts`, `web/src/timeline.tsx`, `web/src/chat.tsx`, `web/src/panels/*`; new `web/src/panels/ToolView.tsx`.
### Behavioral contract
Implement D2. Chat views remain anchored to their own call; sidebar views retain latest session state. Ordinary updates remain provisional until tool result commit. Sidebar preferences and receipts follow the current contract. A chat-only declaration must not create an empty sidebar section or consume its 16-panel budget.
### Documentation
Update lifecycle, persistence and stream sections of `docs/panels-design.md`, `docs/dashboard-api.md`, `docs/sessions.md`.
### Tests first
New `tests/tool-ui-history.test.ts` and `tests/dashboard-ui/tool-ui.spec.ts`; extend host, replay, retention and web-panel-state tests.
### Anti-shortcut coverage
Publish the same declared chat view in 20 successive calls, reload and paginate backward: every old card keeps its old contents, no panel-limit error occurs. Abort before commit restores authoritative state. Deleting a session cleans its view payloads.
### Implementation obligations
Add additive instance tables and bounded history hydration; ensure result/hook stripping, compaction behavior and fallback adapters. Extract shared presentation without duplicating `Blocks` by placement.
### Acceptance criteria
- [x] AC-3: Repeated calls preserve distinct historical snapshots across reload/paging — 20-call durable and browser regressions, immutable-action/cross-session isolation and ACP replay tests passed. Implementation review round 2 explicitly APPROVE.
- [x] AC-4: Updated Todo receipts, ordering, opening and hidden preferences work — panel/browser regressions passed across all three engines. Implementation review round 2 explicitly APPROVE.
### Focused verification
`node --import tsx --test tests/tool-ui-history.test.ts tests/panels-host.test.ts tests/web-panel-state.test.ts tests/session-replay.test.ts tests/session-retention.test.ts`
`npm run test:web -- tests/dashboard-ui/tool-ui.spec.ts tests/dashboard-ui/panels.spec.ts`
### Phase gates
`npm run typecheck`
`npm run test:phase -- sessions`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: render persistent tool views in chat and sidebar`

## Phase 3: Add durable generic form requests and response actions
Status: complete.
### Goal
Any eligible local tool can request structured user input using the shared UI.
### Current behavior and gap
Only prompt/tool actions exist; approvals are boolean and in-memory, and normal panels cannot durably wait before tool completion.
### Evidence
`src/dashboard/approvals.ts`, `src/panels/actions.ts`, `src/tools/primitives.ts:ToolContext`, `src/sessions/operations.ts` writer ownership.
### Pattern
Operation/call binding and abort handling from approvals; transaction/CAS from the session store; common block/action rendering.
### Dependencies
Phases 1–2.
### Files and symbols
New `src/interactions/{contract,service}.ts`, `src/panels/forms.ts`, `web/src/panels/blocks/Form.tsx`; existing `ToolContext`, plugin loader context forwarding, agent dispatch, store/schema/recovery, dashboard routes/streams/auth, `web/src/panels/actions.tsx`, timeline/activity indicators.
### Behavioral contract
Implement D3 lifecycle, budget-aware canonical result serialization and idempotent response contract. Pending request is durable before UI publication; response does not compete with the active turn lease. Deadline, abort, unavailable adapter and recovery each produce an explicit terminal state. Validation is enforced server-side; over-budget answers do not settle the request.
### Documentation
Specify request/response HTTP shape, status codes, lifecycle and placement-independent behavior in panel design and dashboard API docs. Document host-restart interruption separately from browser reconnect.
### Tests first
New `tests/interactions.test.ts`, `tests/dashboard-interactions.test.ts`, `tests/dashboard-ui/interactions.spec.ts`; non-Ask local fixture declares sidebar form.
### Anti-shortcut coverage
Two browsers submit simultaneously, invalid option IDs bypass browser validation, same-key retry after lost HTTP acknowledgement, cross-session/stale IDs, abort-versus-submit race, response while turn is busy, accepted-answer crash before tool commit, and host restart while pending. Exercise 8,192-byte default budget, small budgets, quotes/control characters that expand under JSON escaping, multibyte text, aggregate answers from multiple fields, and option metadata overhead. An unrepresentable minimum answer fails before UI publication; an over-budget submission preserves pending state and draft. Ensure no permission approval is implied.
### Implementation obligations
Persist pending/terminal records, exact accepted response result and response audit atomically; safely settle waiters once; implement one canonical byte-count/result helper and publish effective limits. Implement inline/sidebar form controls with accessible labels/errors, disabled terminal state and a link to pending questions. Keep form drafts across ordinary stream rerenders and validation errors; reload need not persist unsent drafts.
### Acceptance criteria
- [x] AC-5: Exactly one valid, fully representable submission settles a request; over-budget answers remain pending and retries/races never execute a second tool or second turn — service/API budget and idempotency tests.
- [x] AC-6: Pending questions survive browser reload, terminal questions survive host restart, and sidebar/chat share one Form renderer — browser and recovery tests.
### Focused verification
`node --import tsx --test tests/interactions.test.ts tests/dashboard-interactions.test.ts tests/dashboard-approval.test.ts tests/panels-actions.test.ts`
`npm run test:web -- tests/dashboard-ui/interactions.spec.ts tests/dashboard-ui/approval.spec.ts`
### Phase gates
`npm run typecheck`
`npm run test:phase -- dashboard`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: support durable form requests and response actions`

## Phase 4: Ship Ask and complete CLI, library and ACP interaction adapters
Status: complete.
### Goal
Make Ask usable through normal tool selection on every supported host, with explicit fallback when input is unavailable.
### Current behavior and gap
No Ask builtin exists; CLI/ACP only offer permission responses and panel display.
### Evidence
`src/cli.ts` TTY/permission input, `src/acp/{client,methods,rpc}.ts`, `src/tools/plugins/loader.ts` builtin list, `tsup.tools.config.ts`, `scripts/build-tool-examples.mjs`.
### Pattern
Bundled Todo manifest/handler, explicit tool selection, negotiated ACP extensions and injected library callbacks.
### Dependencies
Phases 1–3.
### Files and symbols
New `src/tools/bundled/ask_user/{tool.json,index.ts}`; CLI input multiplexing; ACP client/server request adapters; `AgentOptions`, library exports; loader/config builtin lists, build/copy scripts, examples and package files allowlist.
### Behavioral contract
Ask uses the generic service and returns its accepted canonical JSON result unchanged. TTY collects validated, budget-aware field responses without competing with the main chat input loop. Headless returns `interaction_unavailable` promptly. ACP uses `_raw/interaction/request` only when negotiated, and maps returned answers through the same validator. Disconnect cancels its pending wait; no standard permission-method abuse. A peer without the new interaction capability receives a prompt unavailability result; normal text and standard ACP plan behavior remain available.
### Documentation
Update `docs/tools.md`, `docs/cli.md`, `docs/acp.md`, `docs/configuration.md`, `docs/architecture.md`; show selection and all terminal states.
### Tests first
New `tests/ask-tool.test.ts`, `tests/interactions-surfaces.test.ts`; extend `tests/panels-surfaces.test.ts`, `tests/acp-client.test.ts`, `tests/tool-plugins.test.ts`, installed package tests.
### Anti-shortcut coverage
Invoke the built packaged Ask handler with an injected interaction service; test TTY cancellation, non-TTY failure, unnegotiated ACP capability absence, malformed peer answers, approval-before-question order and hooks receiving only ordinary results. Inspect the provider request after a default-budget multi-question answer with escaped and multibyte text: it must contain every accepted ID/selection/text byte with no truncation or JSON-to-preview conversion.
### Implementation obligations
Package generated standalone examples and schemas; expose documented library callbacks; ensure all adapters honor cancellation/deadlines. Do not silently add Ask to starter configs.
### Acceptance criteria
- [x] AC-7: Selected Ask works in dashboard, TTY, library and negotiated ACP, every accepted answer reaches the provider losslessly under the captured budget, and unavailable surfaces return promptly — tool/surface/provider-payload tests.
- [x] AC-8: Installed/forked Ask works without source checkout; existing starter tool schemas are unchanged — package/overhead evidence.
### Focused verification
`node --import tsx --test tests/ask-tool.test.ts tests/interactions-surfaces.test.ts tests/panels-surfaces.test.ts tests/acp-client.test.ts tests/tool-plugins.test.ts`
### Phase gates
`npm run typecheck`
`npm run test:phase -- acp`
`npm run test:package`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: add ask_user with shared interaction adapters`

## Phase 5: Add host-scoped process supervision and Process builtin
Status: in_progress.
### Goal
Run bounded background jobs across turns with truthful status, paged output and stop control.
### Current behavior and gap
`runBash` awaits completion and its state dies with a tool call. Dashboard runtime closes every operation.
### Evidence
`src/tools/process.ts`, `src/tools/primitives.ts:bashTool`, `src/sessions/operations.ts:execute`, `src/sessions/runtime.ts:attachSessionRuntime`.
### Pattern
Existing group termination and UTF-8 decoding; owner/generation CAS and bounded output storage; host-owned services in dashboard context.
### Dependencies
Phase 1 contracts; phases 2–4 complete before this phase in the execution sequence.
### Files and symbols
New `src/processes/{contract,supervisor,store}.ts`, `src/tools/bundled/process/{tool.json,index.ts}`; `src/tools/process.ts`, `ToolContext`, registry/plugin forwarding, dashboard context/server, CLI and ACP lifecycles, session store/schema/maintenance, build/packaging lists.
### Behavioral contract
Implement D4 excluding visual projection (phase 6), including store-level start/deletion fencing across all deletion/expiry entry points. Supervisor and durable rows outlive per-turn runtime; background jobs do not inherit a completed turn's AbortSignal. Acknowledged starts return once, stopped jobs cannot be mistaken for live by PID reuse. Limits and deletion fences reject before spawn. Process selection/policy is separate from Bash.
### Documentation
Add `docs/processes.md` documenting lifetime, caps, cursor semantics, stop guarantees, platform limits and restart behavior; update tools/configuration/session docs.
### Tests first
New `tests/process-supervisor.test.ts`, `tests/process-tool.test.ts`, `tests/process-lifecycle.test.ts`; extend primitive/process/session shutdown tests.
### Anti-shortcut coverage
Start in turn A, close its runtime, retrieve output in turn B; cancel unrelated turn without killing acknowledged job. Exercise spawn failure, child/grandchild cleanup, nonzero exit, timeout, lost host, PID reuse fixture, over-limit starts, multibyte chunk boundaries, ring-buffer cursor expiry, env_refs validation before spawn and output floods with bounded memory/storage. Use two stores sharing one DB: after releasing the turn lease, foreign explicit deletion and expiry must leave live session/process rows intact. Race starting reservation against deletion fence in both orders; incomplete local cleanup retains records, and recovered lost ownership permits deletion without signalling a persisted PID.
### Implementation obligations
Extract supervision carefully to preserve Bash behavior; add host injection to all supported surfaces; storage updates use host ownership rather than a stale session writer token. Add store-level deletion guard and transactional admission fence, wire owner-host cleanup to dashboard/CLI/ACP/public API paths where a supervisor is available, and make foreign deletion/expiry reject/defer consistently. Failed cleanup must not remove records. Missing foreign supervisor is explicit, never silently adopted.
### Acceptance criteria
- [ ] AC-9: Process survives turn completion and is readable/stoppable later; shutdown/limits behave as documented and cross-store deletion/expiry cannot orphan live jobs or race new starts — lifecycle, two-store and admission-fence tests.
- [ ] AC-10: Existing foreground Bash timeout/abort/batch/env semantics pass unchanged — primitive and registry tests.
### Focused verification
`node --import tsx --test tests/process-supervisor.test.ts tests/process-tool.test.ts tests/process-lifecycle.test.ts tests/primitives.test.ts tests/registry-policy.test.ts tests/vars-tools.test.ts`
### Phase gates
`npm run typecheck`
`npm run test:phase -- tools`
`npm run test:package`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: manage session background processes across turns`

## Phase 6: Integrate foreground and background activity in Commands
### Goal
Provide one useful Commands section with current jobs, compact foreground results, output and Stop.
### Current behavior and gap
Bash cards currently say output appears only at completion; panels are exclusively tool-owned snapshots and cannot safely accept updates after handler settlement.
### Evidence
`web/src/timeline.tsx`, `src/panels/host.ts:PanelCall`, `src/dashboard/streams.ts`, `web/src/panels/SidePanel.tsx`, `src/dashboard/live-output.ts`.
### Pattern
Shared section/block renderer and authoritative SSE snapshots; separate host projection for a service with a different lifetime.
### Dependencies
Phases 2 and 5.
### Files and symbols
New `src/processes/presentation.ts`, dashboard process control/log routes; `src/dashboard/{sessions,streams,contract}.ts`, `src/tools/primitives.ts:bashTool` progress events; `web/src/session.ts`, `web/src/panels/SidePanel.tsx`, `web/src/panels/actions.tsx`, `web/src/panels/panel-state.ts`; new process detail component and shared text/ACP adapters.
### Behavioral contract
One Commands section, running jobs first and terminal rows collapsed/grouped. Foreground batches update during execution; all rows expose true state, command/cwd, elapsed time and exit outcome. Output opens a bounded detail view with explicit truncation. Stop respects policy/hooks/approval even while a model turn is active. Read-only operations and Stop do not start a competing model turn. No auto-open on every short Bash call; first background job may request one opening, honoring Never/hidden/narrow preferences.
### Documentation
Update panel ownership diagram for host projections, dashboard API and command controls, CLI and ACP status/log fallback behavior.
### Tests first
New `tests/dashboard-processes.test.ts`, `tests/dashboard-ui/processes.spec.ts`; extend web panel-state and surface tests.
### Anti-shortcut coverage
Process emits output after originating handler and runtime close; another tool commits a panel concurrently; stream reconnect during output flood; Stop during active model turn; deny/ask rule on Stop; wrong-session process ID; duplicate Stop; foreground nonzero exit shown as failure without changing Bash result semantics.
### Implementation obligations
Separate projection identity/authority from tool ownership; persist activity without routing background events through `PanelHost.begin`. Throttle updates, paginate logs, sanitize terminal control characters and preserve focus/accessibility.
### Acceptance criteria
- [ ] AC-11: One Commands section follows both Bash and Process live across turns/reconnect — integration/browser tests.
- [ ] AC-12: Stop works during an active turn and cannot bypass policy/approval or affect another session — API tests.
### Focused verification
`node --import tsx --test tests/dashboard-processes.test.ts tests/web-panel-state.test.ts tests/panels-surfaces.test.ts`
`npm run test:web -- tests/dashboard-ui/processes.spec.ts tests/dashboard-ui/panels.spec.ts`
### Phase gates
`npm run typecheck`
`npm run test:phase -- dashboard`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: show live commands and process controls in the sidebar`

## Phase 7: Extend write_file with multi-file patches and Files changed
### Goal
Offer patch editing through the existing write tool and a trustworthy summary of its successful changes.
### Current behavior and gap
Write supports four per-file operation modes but no multi-file patch dialect or panel publication.
### Evidence
`src/tools/bundled/write_file/{tool.json,index.ts}`, `src/tools/primitives.ts:WriteOperation,writeFileTool`, `src/terminal/tools.ts`, existing Files and Markdown blocks.
### Pattern
Validate full input before mutation, preserve bytes, return indexed outcomes, publish bounded structured state like Todo.
### Dependencies
Phases 1–2; executed after phase 6.
### Files and symbols
New `src/tools/file-patch.ts`, `src/tools/write-changes.ts`; existing write manifest/validator/primitives, terminal formatting, plugin schemas/examples, `tests/primitives.test.ts`; Files changed declaration and shared block rendering.
### Behavioral contract
Implement D5 and extend the D7 write effects descriptor from operations to patch. Keep operations execution behavior, reject both/neither input shapes. Effects expose every intended file for both modes, including both rename paths, before gates; unavailable/disallowed condition sources fail validation. Preflight errors make zero file mutations; runtime failures report truthful partial results and stop remaining patch applications. Files changed reflects successes only and accumulates across calls with bounded diffs.
### Documentation
Document full patch grammar, ambiguity/file/path limits, symlink restrictions and partial I/O semantics in tools docs; describe Files changed scope in dashboard docs. Supply current examples using effects files[*].path predicates for policies/hooks, absolute lexical path semantics and unchanged arguments. No migration paths/examples.
### Tests first
New `tests/write-patch.test.ts`, `tests/write-changes.test.ts`, `tests/dashboard-ui/write-changes.spec.ts`; extend primitive, tool-plugin and terminal output tests.
### Anti-shortcut coverage
One valid hunk plus a later conflicting file leaves all files unchanged; repeated matching contexts rejected; add/delete/rename destinations, EOF without newline, BOM/CRLF, UTF-8, empty files, symlink parents, permission bits, output budget, external edit after staging, injected I/O failure after first successful write. Prove old operations still continue on per-row runtime error while patch stops. Use the identical effects condition to require approval/deny hooks for an operations write and a patch write/delete; protect rename destination; prove invalid/disallowed condition sources fail before execution and raw arguments remain exact.
### Implementation obligations
Separate parser/staging from application; no shell patch command dependency. Share parsing/targets with the declared effects descriptor so inspected and executed destinations cannot diverge; file-content preflight is after gates. Use the explicit effects-only conditional contract established in phase 1, wire the extended descriptor through standalone packaging/forked examples, and update current configuration fixtures/examples directly. Reserve truthful result metadata before writes. Publish only successful filesystem changes, handle panel failure without misreporting file success, bound snapshots/diffs and regenerate standalone example.
### Acceptance criteria
- [ ] AC-13: Patch add/update/delete/rename and failure contracts match expected bytes; shared effects checks protect every intended path and invalid condition sources fail clearly — patch, policy/hook and effects tests.
- [ ] AC-14: Files changed survives reload, shows accurate successful paths/diffs, and does not claim Bash/Git coverage — state/browser tests.
### Focused verification
`node --import tsx --test tests/write-patch.test.ts tests/write-changes.test.ts tests/tool-effects.test.ts tests/registry-policy.test.ts tests/hooks-config.test.ts tests/primitives.test.ts tests/tool-plugins.test.ts`
`npm run test:web -- tests/dashboard-ui/write-changes.spec.ts`
### Phase gates
`npm run typecheck`
`npm run test:phase -- tools`
`npm run test:package`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: add patch editing and file change panels to write_file`

## Phase 8: Render Mermaid through the shared UI
### Goal
Make diagrams usable in chat and sidebar with readable fallback and one rendering implementation.
### Current behavior and gap
Markdown fences are code only; the panel catalog has no diagram renderer.
### Evidence
`web/src/markdown.tsx`, `web/src/panels/Blocks.tsx`, `src/panels/render.ts`, `src/dashboard/static.ts`, current dependency list and official sources in D6.
### Pattern
Known block dispatch, lazy browser dependencies, code/source fallback and existing Markdown accessibility/CSP conventions.
### Dependencies
Phases 1–2; executed after phase 7.
### Files and symbols
New `web/src/diagrams/MermaidDiagram.tsx`; Markdown and block renderers, styles, text renderer, `package.json`, `package-lock.json`; new sidebar diagram example under `examples/tools/diagram/` with explicit v2 declaration; package asset inclusion if needed.
### Behavioral contract
Implement D6. Fenced assistant Mermaid and tool Mermaid blocks use the same component, including in sidebar. No XML/SVG authoring, external renderer service, arbitrary HTML or standalone diagram builtin. CLI and ACP without diagram presentation show title/source/fallback instead of pretending a raster render.
### Documentation
Add `docs/diagrams.md` for Mermaid syntax usage, both placements, limits and failure behavior; update panel block catalog and example documentation with official reference links.
### Tests first
New `tests/mermaid-block.test.ts`, `tests/dashboard-ui/mermaid.spec.ts`; fixtures for flowchart/sequence, syntax error, large graphs, partial streaming fence, theme change and hostile diagram input.
### Anti-shortcut coverage
Verify actual diagram SVG appears, not merely a source string or screenshot stub. Assert no injected handlers execute, no external fetch/navigation occurs, init directives cannot weaken configuration, stale async render cannot overwrite new source, and failed rendering leaves the page usable. Test under actual served CSP.
### Implementation obligations
Pin dependency and lazy-load browser bundle; bound rendering input/edge complexity; reuse production sanitizer or introduce a maintained sanitizer dependency with tests. Do not weaken CSP to make diagrams pass. Provide copy/source controls and sensible overflow in narrow sections.
### Acceptance criteria
- [ ] AC-15: Flowchart and sequence diagrams render through both placements and Markdown; syntax failure shows source — browser tests.
- [ ] AC-16: Malicious/oversized fixtures cannot execute script, fetch resources or crash chat; CLI/ACP remain readable — browser and surface tests.
### Focused verification
`node --import tsx --test tests/mermaid-block.test.ts tests/panels-surfaces.test.ts`
`npm run test:web -- tests/dashboard-ui/mermaid.spec.ts tests/dashboard-ui/accessibility.spec.ts`
### Phase gates
`npm run typecheck`
`npm run build`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: render Mermaid diagrams in chat and tool views`

## Phase 9: Qualify the integrated workflow and document the shipped contract
### Goal
Prove the features work together on installed artifacts and leave an accurate operational handoff.
### Current behavior and gap
Feature suites alone do not establish that interactions, process updates, file writes and diagrams coexist with session ownership, reload and packaging.
### Evidence
`scripts/test.mjs`, `scripts/test-phase.mjs`, `playwright.config.ts`, existing dashboard fixture/provider and installed-package tests.
### Pattern
Real host/surface tests with deterministic provider fixtures; package installation smoke tests and evidence docs.
### Dependencies
Phases 1–8 approved and committed.
### Files and symbols
New `tests/tool-ui-workflow.test.ts`, `tests/dashboard-ui/tool-ui-workflow.spec.ts`, `docs/evidence/tool-ui-and-builtins.md`; final consistency updates to README and relevant docs/examples.
### Behavioral contract
End-to-end workflow: ask a question, answer once, start a process, finish the turn, apply a patch next turn, inspect Commands/Files changed, display Mermaid, reload, and stop the process. Preserve Todo and history; no duplicate questions/commands/writes on reconnect or retry. Verify current third-party tool fixtures alongside builtins, all on the single current UI contract.
### Documentation
Record executed commands, platform/browser results, package contents, restart limitations, visual captures and any resolved deviations. Distinguish completed qualification from unsupported claims.
### Tests first
Write deterministic workflow fixtures before fixing any integration gaps. Add a crash/recovery scenario and installed tool/provider fixtures; avoid external network or paid model dependencies in tests.
### Anti-shortcut coverage
Run actual built dashboard and installed tool artifacts; inspect old history after newer updates; execute controls while a model turn is pending; simulate disconnection/response retry and assert exactly-once acceptance with no side-effect replay.
### Implementation obligations
Resolve integration failures, verify generated artifacts/capability export, audit all new storage retention and shutdown paths, capture actual UI, and finish documentation. No unrelated cleanup or features.
### Acceptance criteria
- [ ] AC-17: Integrated workflow passes all configured browser projects and Node suite on built artifacts — workflow/regression output.
- [ ] AC-18: Installed tools and examples work, all required platform evidence is recorded, and protocol/docs/source agree — package/evidence review.
### Focused verification
`node --import tsx --test tests/tool-ui-workflow.test.ts`
`npm run test:web -- tests/dashboard-ui/tool-ui-workflow.spec.ts`
### Phase gates
`npm run check`
`npm run test:web`
`npm run test:package`
`npm run test:overhead`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`test: qualify shared tool UI and extended builtin workflows`

## Completion Criteria

- [ ] All AC-1 through AC-18 proven and every phase implementation review APPROVE.
- [ ] Shared blocks and forms work in chat/sidebar without Ask-specific rendering or loss of historical identity.
- [ ] Ask adapters, background process lifecycle, Commands, write patches/Files changed, and Mermaid are usable through shipped artifacts.
- [ ] All producers/consumers/configuration/examples use the new contract directly; starter selection, unconditional policy/approval, model isolation and established write/Bash execution behavior are verified. No migration or backward compatibility code is added.
- [ ] Reload/reconnect/recovery, idempotency, cancellation, retention and platform boundaries are tested and documented honestly.
- [ ] Global gates pass; final working tree contains only intended changes and all phase commits/evidence are recorded.

## Progress Log

- 2026-09-30: Planning only. Inspected baseline and implementation seams, verified CTXE readiness and direct source, checked Mermaid official docs, and passed baseline typecheck. User chose Mermaid now and XML later. Drafted nine dependent phases. No production changes or implementation tests added.
- 2026-09-30: Completed intent-fidelity and plan self-review; APPROVE for user review. Verified phase structure and existing key paths, clarified process control authority/platform scope and patch grammar, and confirmed only this plan is added to the working tree. Awaiting explicit user approval before `$loop-implement`.
- 2026-09-30: User requested `codex-plan-review` with `gpt-6-astra`. Round 1 REVISE, three high findings. Added budget-aware canonical Ask result acceptance/delivery and store-level process start/deletion/expiry fencing; conditional patch policy/hook behavior awaits an explicit user decision before rebuttal/resume. No production changes.
- 2026-09-30: User asked for a correct pattern/contract, permitting contract changes and rejecting workarounds. Added D7: distinct typed intended effects, explicit predicate sources, unchanged original arguments, versioned hook effects payloads and explicit conditional-write migration. Rejected the earlier implicit patch-to-operations normalization proposal. Revised plan remains pending review/user approval before implementation.

- 2026-09-30: User explicitly clarified development phase: no users, no migration, no backward compatibility. This supersedes all earlier compatibility/migration proposals in the Progress Log. Replaced D1/D7 and affected phase/AC sections with one current contract, explicit condition sources, direct first-party updates and no old-format adapters. Prior implement authorization stands; review continues before implementation.
- 2026-09-30: Independent gpt-6-astra round 2 APPROVE; all 3 findings resolved. Started loop implementation, phase 1 in_progress. No production changes at admission.
- 2026-09-30: Phase 1 docs-first contract replacement implemented; new effects/UI tests first failed (6 failures) then passed. First complete regression pass: 763/763, typecheck and sharing 51/51. Implementation review round 1 REVISE: six accepted in-scope findings (dynamic hook source binding, exact serialized effects validation, rejected async descriptors, complete effects-tool input validation, builtin export capabilities, host-owned view/request contracts). Added meaningful red regressions, fixed all six, and verified focused 20/20 plus real ACP dynamic-registration regression. Latest full `npm run check`: 769/769; `npm run typecheck` passed; exact `npm run test:phase -- sharing`: 52/52; `git diff --check` passed. Review round 2 pending in codex-impl-review-20260930-002; no phase commit yet.
- 2026-09-30: Phase 1 review round 2 raw verdict explicitly APPROVE: all six issues verified closed, no new defects. The runner did not parse the verdict-only format and its finalized metadata retained round-1 REVISE; raw round-2 approval is the review evidence, not that stale metadata. Session finalized/stopped normally. Phase 1 AC-1/AC-2 complete; advancing to Phase 2 after the phase commit.
- 2026-09-30: Phase 1 committed as `ebc4f55`. Phase 2 docs-first implementation now includes call-scoped immutable chat snapshots, shared renderer, bounded history fetch, historical actions, ACP replay and stream cleanup. Meaningful red evidence: absent view identity, abort-before-result persistence and committed-frame ordering. Focused command 56/56, state/action/stream integration 38/38, ACP surfaces 11/11, sessions gate 142/142, typecheck passed, sidebar/inline browser suite 66/66 across Chromium/Firefox/WebKit, and final inline browser rerun 3/3. An initial stale browser bundle and a concurrent build/test artifact race were resolved by finishing builds before tests; passing gates used complete artifacts.
- 2026-09-30: Phase 2 required implementation review `codex-impl-review-20260930-003` failed before returning a verdict: `turn_failed`, exit 3, non-recoverable `workspace routing discovery unauthorized (401)`, thread `01a0f0f4-0db7-7713-9f8c-4430ba72d736`. Runner stopped once without finalization or automatic retry per skill; session preserved. Read-only `codex login status` still reports `Logged in using ChatGPT`; root cause is not established. Phase 2 remains in_progress and uncommitted because required APPROVE evidence is absent. Phase 3 and later phases have not started. Full phase-2 regression is running while resolving this external review blocker.
- 2026-09-30: Final independent verification of current Phase 2 tree completed: `npm run check` 777/777, `npm run typecheck` passed, exact sessions gate 142/142, full targeted browser suite 66/66 and final inline rerun 3/3. `git diff --check` passed. AC-3/AC-4 behavior is verified; no review approval or phase completion is claimed. Worktree preserves the Phase 2 changes for the next authorized review invocation after the 401 routing issue is resolved.

- 2026-09-30: User reauthenticated and explicitly authorized continuation. Phase 2 review session 004 round 1 identified three accepted in-scope defects: cancelled action commit, hidden no-update action receipt, and historical action availability. All fixed with regression coverage. Final typecheck passed; focused Node suites 88/88; sessions gate 142/142; browser suites 69/69 across Chromium/Firefox/WebKit; full `npm run check` 778/778; diff check passed. Round 2 raw verdict explicitly APPROVE, all three issues closed, independent history/action tests 21/21. Runner again could not parse verdict-only output, so raw approval is evidence rather than stale finalized metadata. Session finalized/stopped normally. AC-3/AC-4 and Phase 2 complete; moving directly to Phase 3.

- 2026-09-30: Phase 2 committed as `ed1b8bb`; Phase 3 docs-first implementation is in progress. Generic service/store/API and shared Form controls cover budget-aware canonical results, owner fencing, atomic idempotent audit, deadlines/abort/recovery, cross-host streams and immutable question history. Review session 005 round 1 found three accepted defects (prototype-name drafts, old sidebar binding, in-memory session scope); round 2 verified them closed and found three further accepted defects (omitted prototype answers, foreign empty sidebar projection, late ACK state leakage). All six now have real regression coverage and repairs. Latest focused suites 57/57, exact dashboard gate 59/59, typecheck passed and browser suites 99/99 across all engines; full check previously 797/797 and final rerun is running. Round 3 verification pending; no Phase 3 completion/commit or later-phase implementation is claimed.

- 2026-09-30: Phase 3 review session 005 round 3 raw verdict explicitly APPROVE: ISSUE-1–6 verified closed, no new defects, independent focused tests 34/34 and browser repair regressions 9/9. Verdict-only parser again retained stale REVISE metadata; raw approval is evidence. Session finalized/stopped normally. Final exact dashboard gate 59/59, focused suites 57/57, typecheck and diff check passed, full targeted browser suite 99/99, and final `npm run check` 798/798. One preceding full run missed a CLI PTY startup prompt under the 3-second test deadline; isolated unchanged test passed 1/1, then the full suite passed after review stopped. No assertions/timeouts changed. AC-5/AC-6 and Phase 3 complete; advance directly to Phase 4 after committing.

- 2026-09-30: Phase 4 docs-first and tests-first: Ask missing packaged handler and terminal adapter produced expected module/loader failures. Added bundled ask_user (1–3 questions, explicit optional free text, one unchanged canonical JSON block), library-owned callback service, queue-sharing TTY adapter, and negotiated ACP callback using SDK cancellation. Real-surface/provider focused gate 41/41, typecheck, exact ACP phase gate 30/30 and package gate 4/4 passed, including installed and standalone Ask outside checkout. Hook log fixture initially parsed an extra blank input newline; fixed fixture reader without changing production or assertions. Phase 4 implementation review session 006 started, pending verdict.

- 2026-09-30: Phase 4 review session 006 round 1 raw verdict APPROVE, no findings; reviewer independently passed typecheck, four focused tests and answered/expired/abort/headless standalone lifecycle checks (read-only sandbox limited full surface/package reruns). Session finalized APPROVE/stopped normally. Final focused gate 43/43 includes copied Ask sidebar placement and bounded multiline retry; typecheck, ACP gate 30/30, package gate 4/4, overhead and diff checks passed after final changes. AC-7/AC-8 and Phase 4 complete; Phase 5 in progress.
