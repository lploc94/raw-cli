# Add per-turn reasoning/effort and service-tier controls to the Raw dashboard composer

## Plan schema
loop-plan/v1

## Target

The dashboard chat composer lets the user choose, for the next turn, how hard the model reasons and which service tier it runs on, without editing config:

- a pill in the composer toolbar, on the right before Send/Stop, showing the current choice (`Reasoning: medium`, `Effort: high · priority`, or just the label when the agent default is in effect);
- clicking it opens a popover with a discrete stepped slider (a leading "Agent default" stop, then the provider's levels) and, when the provider has tiers, a radio group of service tiers with cost/speed hints;
- the controls, their labels and their options are described by the server per provider, so the UI hardcodes no provider knowledge and shows nothing for providers without such settings;
- the choice is a per-turn override sent with the turn, remembered per session, and never written to config.

## Scope

Included:

1. A single server-side description of request controls per provider (level + service tier) derived from the same enums `requestSpec` validates (`src/config.ts`), exposed in `GET /api/agents/:name/composer` as `controls`.
2. A validated per-turn `request` override on `POST /api/sessions/:id/operations` (turns only), carried in memory through `SessionOperations.submit` to `attachSessionRuntime`, where it is merged over the agent's configured `request` for that operation's provider only.
3. Web: pill, popover, Radix slider and radio group, per-session remembered choice, send body, error surfacing.
4. Docs, design record (`docs/dashboard-composer-design.md` D13), Playwright + node tests, screenshot refresh.

Excluded:

- Writing the choice to `agents.<name>.request` or any config file.
- OpenAI `reasoning_mode` (standard/pro), DeepSeek `thinking` on/off as its own control, Anthropic `thinking` type/budget, Google `thinking_budget`, `max_output_tokens`: not exposed in this iteration (one level control + one tier control per provider). The descriptor shape must let a later control be added without changing the UI code.
- `/reasoning` and `/tier` slash commands (optional in the discussion; not shipped now).
- Guessing which models support which levels or tiers: options are the provider-level enums, never filtered per model.
- Changing the storage format or persisting the override on operation rows, and changing CLI/ACP request handling.
- Server-side memory of the last choice (the per-session memory lives in the browser tab like drafts and pending receipts).

## Invariants

1. Config bytes are never modified by a turn or by choosing a control (existing dashboard invariant; asserted by a byte comparison test).
2. The override is per operation and in memory only, like turn `blocks`: operation rows keep text, a duplicate `clientRequestId` returns the original receipt and ignores the override, and nothing is replayed after a crash.
3. **Degrade, never block.** A control never disables Send or gates the turn on guessed capability. The chosen value is sent as is; if the provider rejects it, only that turn fails with the provider's message, the composer stays usable, and "Agent default" is always selectable. Server validation only rejects values outside the provider's documented enum (a client bug/race), with a message naming the field.
4. Compaction operations never carry an override and keep using the agent's configured request options.
5. The web client holds no provider tables: labels, options, hints and the agent-configured current value come from `controls`.
6. IME composition, `preferences.sendMode`, per-session drafts, attachment chips, popovers and the durable pending-receipt flow behave as before.
7. A provider without controls (generic/ollama/openrouter, etc.) shows no pill and accepts no `request` override.

## Baseline

Verified before planning (do not redo):

- Request options live per agent: `agents.<name>.request`, parsed by `requestSpec` (`src/config.ts` ~418–478) into `ModelRequestOptions` (`src/llm/types.ts`): OpenAI `serviceTier` (`auto|default|flex|fast|priority`), `reasoningEffort` (`none|minimal|low|medium|high|xhigh|max`), `reasoningMode`; DeepSeek `thinking`, `reasoningEffort` (`low|high|max`, invalid with `thinking: disabled`); Anthropic `thinking`, `effort` (`low|medium|high|xhigh|max`), `serviceTier` (`auto|standard_only`); Google `thinkingLevel` (`minimal|low|medium|high`) xor `thinkingBudget`; everything else `generic`. Enums are inline `new Set([...])` literals today.
- Adapters already map them: `src/llm/openai.ts:79–82`, `responses.ts:80`, `anthropic.ts:60–64`, `google.ts:66–68`.
- The runtime is rebuilt for every operation: `attachSessionRuntime` (`src/sessions/runtime.ts`) calls `loadConfig` then `createProvider(runtime.modelConfig!)`; `ResolvedModelConfig.request` is the frozen merged value (`src/config.ts` ~649). So an override can be merged there without touching config.
- `SessionOperations.submit(intent, blocks?)` keeps `blocks` in the in-memory `ActiveOperation` and `execute` calls `attach({ store, session, operation, owner, signal, approve?, env? })` (`src/sessions/operations.ts`); `AttachSessionRuntime` is an injectable type (`server.ts` option `attach`).
- `composer(name)` in `src/dashboard/sessions.ts` already calls `loadConfig({ requireModel:false, flags:{agent} })` and returns `{vision, skills, attachmentKinds}`; `runtime.modelConfig` carries `provider`, `method`, `request`.
- The turn route validates `attachments`/`files` and rejects them on `compact` (Phase 2 of the composer plan); `dashboardFixture` (`tests/fixtures/dashboard.ts`) uses provider `openai` + `openai-chat-completions` with `model` and `agent` options; Playwright `test.use({ scenario: { agent, model } })` supports both.
- Composer UI: `web/src/composer/Composer.tsx` toolbar (`AttachMenu`, spacer, Stop/Send), `web/src/chat.tsx` (`meta` state fetched from `/agents/:name/composer`, `send()` body, per-session `sessionStorage` use for pending receipts), Radix `radix-ui` package (Popover/Slider/RadioGroup available), `lucide-react`.
- Tests: node tests via `scripts/test.mjs` required list; Playwright projects chromium/firefox/webkit; the 3 PTY REPL failures in `tests/cli.test.ts` fail identically on the pre-change baseline and are unrelated.

## Design and project patterns

- **One source of truth for enums**: new `src/request-controls.ts` exports the level/tier value lists and hints per request kind, `requestKind(provider, method)` (moving the `isOpenAi/isDeepSeek/isAnthropic/isGoogle` predicate out of `requestSpec`), `requestControls(provider, method, current?)` → descriptors, and `applyRequestOverride(model, override)` → a new frozen `ResolvedModelConfig`. `requestSpec` imports the value lists so validation and UI options cannot drift. Pattern: `AttachmentKinds` registry (`src/dashboard/attachments.ts`) as the descriptor-driven UI source.
- **Descriptor shape** (in `controls`): `{ id: "effort" | "serviceTier", label, kind: "level" | "choice", options: {value, label, hint?}[], current?: string }` where `current` is the agent's configured value (so the UI can say "Agent default (medium)"). Labels: Anthropic `Effort`, OpenAI/DeepSeek `Reasoning`, Google `Thinking`; tier control label `Service tier`. Tier options exist only for OpenAI and Anthropic. Level options are the provider enum in ascending order.
- **Override mapping** (neutral request keys `effort`, `serviceTier`): OpenAI → `reasoningEffort` / `serviceTier`; Anthropic → `effort` / `serviceTier`; DeepSeek `effort` → `reasoningEffort` and `thinking: "enabled"` (a chosen level implies thinking, avoiding the config-time conflict with `thinking: disabled`); Google `effort` → `thinkingLevel` and removes `thinkingBudget` (xor rule). All other configured fields (`maxOutputTokens`, `reasoningMode`, Anthropic `thinking`) are preserved. Generic kinds have no controls and reject overrides.
- **Transport**: `SessionOperations.submit(intent, blocks?, request?)` stores the override on `ActiveOperation`; `execute` passes `request` to `attach`; `attachSessionRuntime` applies it to `runtime.modelConfig` before `createProvider` and returns the effective `modelConfig` (so metrics reflect it). Pattern: how `blocks` travel today.
- **Turn route**: `request` must be an object with only `effort` and/or `serviceTier` string values that belong to the agent's descriptor options; otherwise 422 `invalid_request_option` naming the field. Rejected on `compact`. The agent's descriptors come from the same helper `composer(name)` uses.
- **Web**: `RequestControls.tsx` in `web/src/composer/`: Radix `Popover` (non-modal, focus returns to the pill), Radix `Slider` (`min 0`, `max = options.length`, `step 1`, stop 0 = "Agent default"), Radix `RadioGroup` for the tier, hint text under each option, `aria-valuetext` with the option label. State lives in `chat.tsx` (`requestChoice`), persisted per session in `sessionStorage` (`raw.dashboard.request.<id>`), pruned only after `controls` have loaded successfully for the currently selected agent and no longer offer the stored value (agent switch); while metadata is loading, cleared for an agent change in flight, or unavailable, the stored choice is retained but no `request` is sent, because an override cannot be matched to confirmed controls (a metadata failure therefore degrades to Agent default for that send, never blocks it). Pill text: `Label` when default, `Label: value` otherwise, plus ` · tier` when a non-default tier is chosen. The pill and popover are wired into `Composer` through a `controls` slot before Send/Stop.
- **Docs pattern**: same as the composer plan: `docs/dashboard-api.md` (route/field), `docs/dashboard.md` (behavior), `docs/dashboard-composer-design.md` new D13 and verification-map rows.

## Global Gates

- `npm run typecheck`
- `npm test` (builds, then runs every required node test file; only the 3 known baseline PTY failures in `tests/cli.test.ts` are acceptable)
- `npm run test:web` (all Playwright projects) for any phase touching `web/`
- `npm run test:package` after Phase 3
- No change to existing provider request-body assertions for turns without an override.
- `git status` clean except intended files at each phase commit.

## Plan Review

APPROVE — intent-fidelity and self-review completed; Codex (gpt-6-astra) plan review APPROVE in 2 rounds (3 findings fixed: provider-failure display path, metadata-loading prune rule, duplicate-receipt ordering). Every user-approved decision maps to a phase; exclusions (config writes, `/` commands, extra controls, per-model guessing) are explicit; paths and symbols verified on 2026-09-29.

## Phase 1: Server: request controls, override validation and runtime merge

### Goal
The server describes reasoning/tier controls per provider and applies a validated per-turn override to that operation's provider request only.

### Current behavior and gap
Request options are only readable/settable in config; `composer` metadata has no controls; the turn route ignores unknown fields; `attachSessionRuntime` cannot receive an override.

### Evidence
`src/config.ts` `requestSpec` and inline enum sets; `src/llm/types.ts` `ModelRequestOptions`; `src/llm/{openai,responses,anthropic,google}.ts` request mapping; `src/sessions/operations.ts` `submit`/`execute`/`AttachSessionRuntime`; `src/sessions/runtime.ts` `attachSessionRuntime`; `src/dashboard/sessions.ts` `composer` and the turn route; `tests/dashboard-attachments.test.ts` (composer metadata, turn validation patterns); `tests/fixtures/dashboard.ts`.

### Pattern
`AttachmentKind` descriptors served through the composer metadata (`src/dashboard/attachments.ts`); `blocks` carried in memory through `submit` → `execute`; `textField`/`DashboardError` validation in `sessions.ts`.

### Dependencies
None (composer plan complete at `54406ba`).

### Files and symbols
New `src/request-controls.ts` (`requestKind`, `LEVELS`/`TIERS` value lists, `requestControls`, `parseRequestOverride`, `applyRequestOverride`); edits to `src/config.ts` (`requestSpec` imports the value lists and `requestKind`), `src/sessions/operations.ts` (`submit(intent, blocks?, request?)`, `ActiveOperation.request`, `AttachSessionRuntime` option `request?`), `src/sessions/runtime.ts` (apply override), `src/dashboard/sessions.ts` (`composer` returns `controls`; turn route parses/validates `request`, refuses it on compact), `tests/request-controls.test.ts` (new, added to `scripts/test.mjs`), `tests/dashboard-attachments.test.ts` or a new `tests/dashboard-request-controls.test.ts` (added to `scripts/test.mjs`), `docs/dashboard-api.md`.

### Behavioral contract
- `GET /api/agents/:name/composer` gains `controls`: for an OpenAI-family agent `[{id:"effort", label:"Reasoning", kind:"level", options:[none…max], current?}, {id:"serviceTier", label:"Service tier", kind:"choice", options:[auto, default, flex, fast, priority with hints], current?}]`; Anthropic `[{effort "Effort" low…max}, {serviceTier auto, standard_only}]`; DeepSeek `[{effort "Reasoning" low, high, max}]`; Google `[{effort "Thinking" minimal…high}]`; generic → `[]`. `current` is the configured agent value when set. A broken config still returns `controls: []` (metadata stays best-effort, never blocks).
- `POST /api/sessions/:id/operations` turn accepts `request: {effort?, serviceTier?}`. Duplicate detection runs first: once `sessionId` and `clientRequestId` are known, an existing operation with that id returns its original receipt (202) before `request` is validated, exactly like `attachments`/`files` today (`store.findOperation` short-circuit in `src/dashboard/sessions.ts`), so a retry carrying a stale or invalid override never turns a completed receipt into a 422. For a new id, values outside the agent's options, unknown keys, non-object bodies, or any `request` on a provider with no controls → 422 `invalid_request_option` before the operation is accepted. On `compact` → 422 as for attachments. An empty object is a no-op.
- For the operation, `applyRequestOverride` produces the effective `ResolvedModelConfig.request` per the mapping in Design; the provider request body carries the override (e.g. OpenAI chat `reasoning_effort` and `service_tier`), while a following turn without an override uses the configured values again. Config bytes are unchanged. Operation rows/receipts never contain the override; a duplicate `clientRequestId` returns the original receipt and does not re-run or apply the override.
- Provider rejection of an override surfaces as that operation's normal `error` terminal state with the provider message; the session accepts the next turn.

### Documentation
`docs/dashboard-api.md`: `controls` in the composer metadata, the `request` field, error code, non-persistence, compact refusal.

### Tests first
Node: `tests/request-controls.test.ts` — table test per kind (openai chat/responses, deepseek, anthropic, google, generic): descriptors (labels, ascending options, tier presence, `current`), `parseRequestOverride` accept/reject matrix, `applyRequestOverride` exact result (preserves `maxOutputTokens`/`reasoningMode`/Anthropic `thinking`; DeepSeek forces `thinking:"enabled"`; Google drops `thinkingBudget`; input model not mutated and result frozen), and a drift test that every value in the lists is accepted by `requestSpec` via `loadConfig` for its provider (and vice versa for the enum). Dashboard: composer metadata per configured provider; turn with `request` reaches the mock provider body (`reasoning_effort`, `service_tier`) over an agent configured with a different `reasoning_effort`; next turn without override sends the configured value; config file bytes identical before/after; invalid value/key/compact/generic provider → 422 and no operation accepted; duplicate `clientRequestId` with a different override, and with an invalid override, returns the original receipt (202) without a second provider request or a 422; provider 400 on the overridden turn → operation `error` with the message, then a normal turn completes.

### Anti-shortcut coverage
Vary the values across effort levels and tiers (not one hardcoded pair); compare the raw provider JSON, not internal state; assert the configured value returns on the next turn (proves no sticky mutation); assert `Object.isFrozen` and the original model object unchanged; the drift test fails if an enum is added in one place only; assert `submit` without `request` yields byte-identical provider requests to the pre-change baseline.

### Implementation obligations
Move value lists and the kind predicate out of `config.ts` without changing config validation behavior or messages; keep `attach` signature backward compatible (`request` optional); merge only for `operation.kind === "turn"`; never persist the override; no provider capability guessing; keep metadata best-effort with try/catch like the existing `composer`.

### Acceptance criteria
- [x] AC-1: `controls` describes level and tier per provider from the shared enums and is empty for generic providers — proven by `tests/request-controls.test.ts` and the dashboard metadata test.
- [x] AC-2: A validated per-turn override changes only that operation's provider request and leaves config bytes and the next turn untouched — proven by the dashboard wire test.
- [x] AC-3: Invalid overrides are refused before acceptance with `invalid_request_option`; compact refuses them — proven by the 422 matrix.
- [x] AC-4: A provider rejection fails only that turn and the session continues — proven by the provider-400 test.
- [x] AC-5: Enum drift between validation and UI options is impossible — proven by the drift test.

### Focused verification
`node --import tsx --test tests/request-controls.test.ts tests/dashboard-request-controls.test.ts tests/config.test.ts tests/session-operations.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: describe and apply per-turn reasoning and service tier overrides`

## Phase 2: Web: reasoning and service-tier controls in the composer

### Goal
The composer shows the pill and popover (slider + radio group) driven by `controls`, remembers the choice per session and sends it with each turn.

### Current behavior and gap
No UI for request controls; `chat.tsx` `send()` body has no `request`.

### Evidence
`web/src/composer/Composer.tsx` toolbar and props; `web/src/chat.tsx` (`meta`, `send`, `sessionStorage` pending-receipt keys, agent change effect); `web/src/composer/AttachMenu.tsx` (Radix menu pattern, `onCloseAutoFocus`); `web/src/styles.css` `.composer-toolbar`, `.menu`; `tests/dashboard-ui/composer.spec.ts`, `attachments.spec.ts`, `fixtures.ts` (`scenario.agent`, `scenario.model`).

### Pattern
Radix primitives from `radix-ui` styled with existing CSS variables; the `meta` fetch effect in `chat.tsx`; per-session `sessionStorage` (`raw.dashboard.pending.<id>`).

### Dependencies
Phase 1.

### Files and symbols
New `web/src/composer/RequestControls.tsx` and `web/src/composer/request-choice.ts` (storage + pruning helpers, pill text); edits to `web/src/composer/Composer.tsx` (`controls` slot before Send/Stop), `web/src/chat.tsx` (`meta.controls`, `requestChoice` state, storage, send body), `web/src/styles.css`, tests `tests/dashboard-ui/request-controls.spec.ts` (new), a node test for the pure helpers `tests/web-request-choice.test.ts` (added to `scripts/test.mjs`).

### Behavioral contract
- No pill when `controls` is empty (generic provider or metadata failure).
- Pill sits in the toolbar right before Send/Stop; text `Label` (default), `Label: value` (level chosen), plus ` · tier` for a non-default tier. Accessible name states the full current state. It never disables Send and is usable while an operation runs (affects the next turn).
- Clicking opens a non-modal popover: level slider with stops `Agent default (current)?`, then options in order, labels under the stops, `aria-valuetext` = option label; keyboard: ←/→/↑/↓ change, Home = Agent default, End = last; Escape closes and returns focus to the pill. Tier radio group lists options with their hints, first entry "Agent default". A "Reset" affordance restores both defaults.
- The choice is sent as `request: {effort?, serviceTier?}` only when at least one is non-default; the body is otherwise unchanged. Remembered per session via `sessionStorage`; values no longer offered by successfully loaded `controls` for the selected agent (agent switch) are dropped silently and the pill returns to default; during metadata loading or failure the saved choice is kept (not erased) and not sent, and the pill shows the default state.
- A turn that fails keeps the choice so the user can adjust and retry; Agent default remains selectable. Two distinct failure paths, both already rendered by existing UI and reused unchanged: a refused submit (422 `invalid_request_option`, network error) appears in the composer `ErrorMessage` via `errorText`; a provider rejection happens after the turn was accepted, so it arrives as the terminal `runResult` and is shown in the timeline note `error · <runResult.message>` (`web/src/timeline.tsx` ~531–536), which carries the provider's message.
- Narrow viewports: the pill collapses to icon + short value and the popover fits the viewport (uses available width, scrolls); toolbar never overflows at 320 px.

### Documentation
`docs/dashboard.md` composer section (deferred to Phase 3 for screenshots; a short behavior paragraph lands here).

### Tests first
Playwright (`request-controls.spec.ts`, all three projects, axe on the open popover): pill absent for a generic provider; present with provider-specific labels for an OpenAI agent (`Reasoning`) and an Anthropic-labelled model config (`Effort`) if the fixture can express it, otherwise covered by the node descriptor test plus a mocked composer response via `page.route`; slider by keyboard and pointer changes the pill text; Home resets; tier radio + hint text; sending with a choice puts `reasoning_effort`/`service_tier` in the mock provider request and a turn after resetting sends the configured values; choice survives navigating to another session and back and a page reload; a provider 400 with a distinctive message (`unsupported tier xyz`) is visible verbatim in the timeline terminal note, the choice is kept, Send stays enabled, and resetting then sending succeeds; a 422 from a mocked invalid submit shows in the composer error area; agent switch prunes an unsupported stored value only after the new agent's controls load; reload with a slow/failed `/composer` response (via `page.route`) keeps the remembered choice, sends no `request`, and restores it once metadata loads; narrow viewport has no overflow. Node: pure helpers (pill text, prune/restore, body building).

### Anti-shortcut coverage
Assert on the provider's received JSON for several levels/tiers; the reload/session-switch tests prove storage rather than component state; a `page.route` mocked `controls` with an unknown extra control id shows how unknown descriptors are handled (rendered generically as a slider/choice or ignored, never crashing) to prove there are no hardcoded provider tables; assert `Send` `toBeEnabled` while a rejected choice is active.

### Implementation obligations
No provider tables in `web/`; all text from descriptors except fixed UI strings ("Agent default", "Reset"); abort/ignore stale metadata responses after agent change and track a `loaded-for-agent` marker so pruning never runs on empty initial metadata; Escape closes the popover and returns focus to the pill (documented, unlike the `/` popover which keeps focus in the textarea); respect `prefers-reduced-motion`; no `dangerouslySetInnerHTML`; do not touch draft/receipt logic.

### Acceptance criteria
- [x] AC-1: Pill and popover render only when the server describes controls, with provider-supplied labels — proven by Playwright specs.
- [x] AC-2: Keyboard and pointer operation of slider and radio group with correct ARIA, passing axe — proven by spec.
- [x] AC-3: The choice reaches the provider request for that turn only and persists per session/reload — proven by spec.
- [x] AC-4: Provider rejection never disables Send or traps the user — proven by spec.
- [x] AC-5: No overflow at 320/800/1440 px in both themes — proven by spec.

### Focused verification
`npx playwright test tests/dashboard-ui/request-controls.spec.ts tests/dashboard-ui/composer.spec.ts tests/dashboard-ui/attachments.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm test && npm run test:web`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: choose reasoning effort and service tier from the dashboard composer`

## Phase 3: Documentation, design record and qualification

### Goal
Docs, design record and screenshots describe the shipped controls, and the packaged artifact carries them.

### Current behavior and gap
Docs and `docs/dashboard-composer-design.md` end at D12; screenshots do not show the pill.

### Evidence
`docs/dashboard.md`, `docs/dashboard-api.md`, `docs/dashboard-composer-design.md` (verification map), `docs/evidence/local-dashboard.md`, `tests/dashboard-ui/capture.ts`, `tests/dashboard-assets.test.ts`, `tests/dashboard-installed.test.ts`.

### Pattern
Phase 6 of `add-chat-composer-attachments-and-commands-plan.md`.

### Dependencies
Phases 1–2.

### Files and symbols
`docs/dashboard.md`, `docs/dashboard-api.md`, `docs/dashboard-composer-design.md` (new D13: per-turn override, descriptors, mapping table, exclusions, degrade rule; verification-map rows), `docs/evidence/local-dashboard.md` (dated section), `tests/dashboard-ui/capture.ts` (pill visible in the chat screenshots and a popover-open screenshot `chat-dark-controls.png`), `tests/dashboard-assets.test.ts` (bundle contains the control strings), regenerated `docs/dashboard/*.png`.

### Behavioral contract
Docs state: which providers expose which controls, labels, the mapping (including DeepSeek forcing thinking and Google dropping the budget), per-turn and not persisted, remembered per session in the tab, tier cost/speed hints, that options are not filtered per model and a provider rejection only fails that turn, exclusions (`reasoning_mode`, budgets, slash commands). The design doc's D13 and verification map match the implementation, recording any deviation.

### Documentation
This phase is documentation.

### Tests first
Extend `tests/dashboard-assets.test.ts` to require the new UI strings in the built bundle and the CSP still forbidding `blob:`; capture script fails on overflow as today.

### Anti-shortcut coverage
Screenshots regenerated by running the capture script (content differs), not copied; docs values checked against `src/request-controls.ts` lists by inspection during review.

### Implementation obligations
Do not push, publish or install globally; do not hand-edit generated mirrors.

### Acceptance criteria
- [x] AC-1: Docs and design record match routes, fields, labels, mapping and exclusions — proven by inspection against Phase 1–2 tests.
- [x] AC-2: Refreshed screenshots show the pill and the open popover at desktop/tablet/narrow, light and dark — proven by the capture run.
- [x] AC-3: Packaged artifact passes the package gates with the new UI — proven by `test:package`.

### Focused verification
`npm run build && node --import tsx --test tests/dashboard-assets.test.ts && node --import tsx tests/dashboard-ui/capture.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:web && npm run test:package`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`docs: document dashboard reasoning and service tier controls`

## Completion Criteria

- [x] All phase acceptance criteria checked; each phase committed separately with reviewer verdict APPROVE.
- Global Gates pass on the final commit, including all three Playwright projects and `test:package`.
- In the dashboard an OpenAI-family agent can send one turn with a chosen reasoning level and service tier and the provider receives exactly those values, the next turn returns to the agent default, and config bytes never change; Anthropic, DeepSeek and Google agents show their own labelled controls; generic providers show none.
- A provider rejection fails only that turn; Send is never disabled by these controls.
- No storage format change; turns without an override produce byte-identical provider requests to before.

## Progress Log

- 2026-09-29: Plan drafted and Codex-reviewed (APPROVE) after user-approved design (per-turn override, server-described controls, pill before Send with popover slider + tier radio group, no `/` commands, config untouched).
- 2026-09-29 Phase 1 (Codex gpt-6-astra review APPROVE in 2 rounds; 2 test findings fixed): `src/request-controls.ts` (value lists shared with `requestSpec`, descriptors, `parseRequestOverride`, `applyRequestOverride`), `SessionOperations.submit(intent, blocks?, request?)` and `attachSessionRuntime` merge, composer `controls`, turn route with replay-first ordering. Tests `tests/request-controls.test.ts` (4) and `tests/dashboard-request-controls.test.ts` (5). `npm run typecheck` clean; `npm test` 577/580 (3 baseline PTY). Note: `request` on `compact` is refused with 400 `invalid_input` like `attachments` (the plan text said 422; the existing pattern wins).
- 2026-09-29 Phase 2 (Codex gpt-6-astra review APPROVE in 2 rounds; 4 findings fixed: tier-only pill text, generic tooltip, dashboard.md paragraph, real agent-switch test): `RequestControls.tsx`, `request-choice.ts`, `useRequestChoice.ts`, Composer `controls` slot, chat.tsx wiring, styles, fixture `extraAgents`. `tests/dashboard-ui/request-controls.spec.ts` 13 specs x 3 browsers, `tests/web-request-choice.test.ts` 5. typecheck clean; `npm test` 582/585 (3 baseline PTY); `npm run test:web` 231 passed. Deviation: the pill is absent (not default) while metadata loads or fails; the choice is retained and not sent.
- 2026-09-29 Phase 3 (Codex gpt-6-astra review APPROVE in 2 rounds; 1 doc-link finding fixed): D13 and verification rows, evidence section, dashboard.md link, capture.ts pill + `chat-dark-controls.png`, assets test strings, regenerated screenshots (no overflow), wider popover with unclipped stop labels. typecheck clean; `npm test` 582/585 (3 baseline PTY); `test:web` 231; `test:package` 4/4.
- 2026-09-29 Finalization: Global Gates on the final tree (identical to fa8c12d): typecheck clean, `npm test` 582/585 (3 baseline PTY), `test:web` 231 passed on chromium/firefox/webkit, `test:package` 4/4. Cumulative audit found no cross-phase defect. Nothing pushed or installed.
