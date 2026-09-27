# Add configurable agent hooks

## Plan schema
loop-plan/v1

## Target
Let a Raw agent select small, shareable hooks for turn and tool lifecycle events. A user can write a hook beside a config or in `~/.config/raw/hooks/`, select it in an agent, see what it did in terminal and dashboard history, and export that agent with its hooks. Hooks behave the same for CLI, dashboard, and ACP. Marketplace/discovery is later work.

## Scope
- Add `agents.<name>.hooks.use`, an ordered list of exact `agent/<id>`, `local/<id>`, or `pkg/<alias>/hooks/<export>` IDs. Omitted/empty means no hook work or new process. No implicit scan or auto-enable.
- A hook is a folder containing `hook.json` and its script/assets. `hook.json` declares `name`, an ordered nonempty `events` array of `{ "name": EVENT, "match"?: GLOB, "when"?: ARGUMENT_FILTER }`, `command`, optional `args`, and bounded `timeout_ms` (default 5000, maximum 30000). `match` matches a tool's canonical ID; `when` reuses the validated argument-filter syntax from `tools.rules`. Non-tool events reject `match`/`when`. `command` is an executable name on PATH or a path contained in the hook folder; `./` script arguments resolve inside that folder. Raw invokes it with `spawn(..., { shell: false })` from the session cwd. Bash, Python and Node are all supported through explicit commands/args.
- Define `raw.hook/1`: one bounded UTF-8 JSON request on stdin; stdout may be empty for success or contain exactly one bounded UTF-8 JSON object. Request contains protocol version, event name, agent/session/turn identifiers when available, cwd, and event-specific data. The v1 events are `SessionStart` (attach; `source: create|resume`), `UserPromptSubmit` (user input), `PreToolUse` (canonical/model-visible name and validated arguments), `PostToolUse` (successful handler result), `PostToolUseFailure` (failed handler result), `Stop` (terminal run result) and `SessionEnd` (runtime close). `SessionStart`/`SessionEnd` refer to an attached runtime, not creation/deletion of stored session data. No credentials, whole transcript, or variable values are added by Raw. The script runs as the current OS user and can read the same files/environment as Raw.
- For `UserPromptSubmit` and `PreToolUse`, exit 0 with empty stdout or `{ "decision": "continue" }` continues; exit 2 or `{ "decision": "deny", "reason": "..." }` blocks, with exit 2 winning if they conflict. A response may include a bounded `message` for host display. Other nonzero exit, invalid output, timeout or spawn failure is a **blocking hook error** for these two gates. For notification events, exit/output errors emit a visible warning and never reverse completed work. This fail-closed gate choice is deliberate because Raw's explicit `tools.rules` and selected hooks are both user-authored policy, and an accidentally broken gate must not silently permit the action. There is no `allow` response that bypasses an existing `ask` or `deny` rule. No mutation of model input, tool arguments/results, prompt, active tool set, or request options in v1.
- Add package export/install/binding for hooks, a dashboard hook catalog/editor and agent selection, English docs/examples, a dedicated `create_hook` setup skill, and updates to `configure_raw`, `create_agent`, and `create_package` so the shipped agent can create/select/share hooks. The starter agent does not enable a side-effecting hook by default.
- Exclude marketplace, remote publication, HTTP/MCP/prompt/agent hook handlers, context mutation, async/background hooks, custom event registration, shell command strings, subagents, and legacy config migration. Additional events and handler types can extend the explicit contract later.

## Invariants
- Existing agents without `hooks` produce the same model-visible prompt/tool schema, approval behavior, cache key, session data, and runtime overhead apart from a trivial absent-hook branch. Hook source/selection changes alone do not rotate a model prefix key; any actual result/denial is an ordinary new conversation result. Resume applies the current selected hooks at the next attach/turn without rejecting older sessions.
- Policy deny and unexposed/invalid tool calls never execute a hook. `PreToolUse` runs after validation and policy visibility, before user approval or handler execution; it cannot bypass a configured `ask` or `deny`. `PostToolUse` and `PostToolUseFailure` run only when the handler was invoked, based on actual outcome, once per invocation in the live process. A denied approval never fires a post hook.
- Ordered hooks run serially. The first gate denial or failure stops later gate hooks, returns a bounded error (`hook_denied` or `hook_error`) to the model for a tool call, and prevents approval/handler execution. Prompt denial/failure ends that turn without provider request; persist and expose a clear terminal result without an orphaned pending operation. An abort takes precedence over a hook response. Every **executed** hook emits one bounded host-visible `hook_event` receipt with hook ID, event, outcome (`continued`, `denied`, or `error`), duration and optional short message/error code. Persist the same receipt in visible history for terminal/dashboard/ACP; do not expose raw stdin/stdout. A hook excluded by matcher emits no receipt. Notification-hook failures cannot change the already committed tool/run result. Never replay a hook after crash recovery; a new user operation may run it again.
- Gates use the active turn's abort signal. When cancellation aborts a running handler, its `PostToolUseFailure` and the turn's `Stop` still run as **terminal notifications** under a fresh host-owned cleanup signal with a single 2-second total budget for both boundaries; each hook's own timeout is capped by the remaining budget. `SessionEnd` runs once during runtime close under a separate host-owned 2-second budget. Each boundary is awaited before final result/receipt or runtime close; when a cleanup budget expires, kill the child/process group, emit a bounded error receipt for the attempted hook and do not start further hooks at that boundary. Host shutdown must await or cancel these children before releasing session ownership. The same budgets apply after normal completion so a hung notification never stalls indefinitely.
- Hook children obey cancellation, timeout, input/output caps, process-group cleanup, and the session/operation ownership boundary. No zombie child survives cancellation or shutdown. No side effect is hidden as a successful hook if parsing, exit, or cleanup fails. `SessionStart`/other pre-operation notifications use the startup/operation signal and a bounded timeout; an aborted startup skips them and cannot leave a pending operation.
- A hook cannot change the transcript or model prefix directly. Hook diagnostics stay out of model context unless a gate blocks, in which case the bounded denial/error is a normal result. Redact/cap diagnostic content and avoid writing raw hook input or stdout to logs by default. A hook response is never an approval grant.
- Package-selected hook bytes are pinned/snapshotted consistently with selected tool assets. Only selected hooks load; install/catalog inspection never executes hook code. Exported agent hooks are portable and recipient-bindable like tools and skills.

## Baseline
- HEAD `9bc566a`, clean worktree at plan start. No hook contract or `agents.*.hooks` parser exists. `src/config.ts:agentSpec` rejects unknown agent fields; `src/packages/contract.ts:componentKinds` and `schemas/raw-package.schema.json` omit hooks.
- `src/tools/registry.ts:ToolRegistry.dispatch` owns exposure, validation, policy, approval, and execution. `src/agent.ts:AgentSession.execute` owns user/tool commits and `run_end`; `src/sessions/runtime.ts:runtimeAgentOptions` supplies shared agent options. CLI (`src/cli.ts`) and ACP (`src/acp/methods.ts`) construct agents separately; dashboard operations use `src/sessions/operations.ts` and `attachSessionRuntime`.
- `src/vars/provider.ts:runVariableProvider` is the subprocess, timeout, abort, output-limit, and process cleanup pattern. `src/tools/plugins/loader.ts` and `src/skills/loader.ts` are selected component location/containment patterns. Package resolution/export and dashboard component management already handle tools/skills but not hooks.
- Existing tests include `tests/registry.test.ts`, `tests/agent-lifecycle.test.ts`, `tests/session-operations.test.ts`, `tests/acp.test.ts`, `tests/dashboard-sessions.test.ts`, `tests/package-export.test.ts`, `tests/package-runtime.test.ts`, and dashboard Playwright suites. `npm run check`, `npm run test:web`, and `npm run test:package` are the full regression gates.

## Design and project patterns
- Industry research (official primary sources, checked 2026-09-27): [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) and [guide](https://code.claude.com/docs/en/hooks-guide) show lifecycle events, matchers, JSON on stdin, exit-code/JSON decisions, timeouts and host parity. [OpenCode plugin hooks](https://opencode.ai/v2/docs/build/plugins) expose typed tool/session/permission callbacks. [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) expose ordered lifecycle callbacks and package them through [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md). **There is no cross-product wire standard for hooks.** Raw adopts the common event/matcher/decision shape and documents its own `raw.hook/1` protocol rather than claiming Claude/Pi/OpenCode compatibility.
- Unlike Claude Code's command-hook default (many nonzero errors and timeouts are non-blocking), Raw fails closed on `UserPromptSubmit`/`PreToolUse` hook failures; this is a specific Raw policy choice and must be explicit in docs/examples. Unlike Pi/OpenCode in-process callbacks, v1 command hooks use subprocesses so Bash/Python/Node scripts work and timeout/abort can terminate a hung hook. Both choices need positive and negative tests.
- Use an explicit agent selection, as for `tools.use`/`skills.use`; resolve `agent/` beside the selected config and `local/` under the canonical global config directory. Strict JSON/unknown-field rejection follows `src/config.ts`; portable package references follow `src/packages/resolve-agent.ts`.
- Keep the hook runner separate from tool plugin imports. Reuse the child-process discipline of `src/vars/provider.ts`, including abort and process-tree cleanup; add shared helper only if it reduces duplicated correctness logic. A hook gets a fresh process per event, so state across events belongs in explicit files or other user-owned storage.
- Keep lifecycle decisions at the common runtime boundary: `SessionStart`/`SessionEnd` at attach/close, `UserPromptSubmit`/`Stop` in `AgentSession`, and tool events in `ToolRegistry`. Make the registry accept an optional hook dispatcher/context rather than wrapping individual built-in, local, MCP, or ACP tools. Hook execution needs the outer turn's abort signal and IDs. Filter `PreToolUse`/post hooks by canonical tool ID and optionally by arguments **before spawning**.
- Define a stable, small request envelope and narrow responses. `UserPromptSubmit`/`PreToolUse` are gates; other events are notifications. Fire one of `PostToolUse`/`PostToolUseFailure` after handler outcome and before committing the tool message; fire `Stop` once for every terminal `RunResult`, before emitting `run_end` where practical. `SessionStart` fires once per attach; `SessionEnd` fires once per close. Explicitly resolve an exception/cancel race so one terminal event/receipt wins.
- Expose `hook_event` as a host-visible run/history receipt on **every executed hook**, including success, denial and failure, not as a model message. Update terminal renderer, dashboard stream/timeline, and ACP update mapping so live and persisted receipts appear in every surface without breaking event serialization. A success with empty stdout still renders as “hook <id> ran (<event>)”; a bounded JSON `message` adds human-readable detail. Decide exact wire shape once in phase 1 and use it consistently.
- Add hooks as package kind/capability (`raw.hook/1`) and as a selection in agent bindings. `src/packages/export.ts` must copy selected hook trees and rewrite references, and package inspection must validate `hook.json`/entry containment without executing it. A package update applies at next runtime attach/turn; no old session format migration is needed.
- Dashboard management follows `src/management/components.ts` and `web/src/pages/Components.tsx` for owned-file revision checks, source badges and editor diagnostics. Agent editor uses the existing ordered component selector in `web/src/pages/Agents.tsx`. Keep UI changes confined to create/edit/select/inspect for hooks; no marketplace page.

## Global Gates
- Focused tests per phase with deterministic local scripts; no paid provider requests and no external service.
- `npm run check` — complete Node tests, CLI/tool build and both TypeScript projects.
- `npm run test:web` — browser UI and accessibility suites in Chromium, Firefox, and WebKit.
- `npm run test:package` — packed consumer outside the checkout; include an exported agent hook in at least one installed-consumer path.
- `git diff --check` and `npm pack --dry-run --json` — whitespace and shipped files contract. Do not overlap a build with browser/package tests that consume `dist`.

## Plan Review
APPROVE — self-reviewed for intent, current paths, parity, failure ordering, package completeness, and phase boundaries. This is a plan self-review, not an external Codex review or an implementation approval. Implementation starts only after the user's approval as required by the repository loop workflow.

## Phase 1: Define and load the hook contract
### Goal
Make selected hook definitions valid, location-safe, and runnable with a bounded child-process protocol.
### Current behavior and gap
`agentSpec` has no hooks; packages and loaders only resolve other component types; there is no hook runner.
### Evidence
`src/config.ts:agentSpec/loadConfig`; `src/tools/plugins/loader.ts:selectedManifest`; `src/vars/provider.ts:runVariableProvider`; `src/packages/resolve-agent.ts:resolvePackageSelections`.
### Pattern
Strict config parsing and selected component resolution; bounded subprocess protocol.
### Dependencies
None.
### Files and symbols
Add `src/hooks/{contract,manifest,loader,runner}.ts`; edit `src/config.ts`, `src/sessions/runtime.ts` as needed; add `tests/hooks-config.test.ts`, `tests/hooks-runner.test.ts`.
### Behavioral contract
Resolve selected IDs in order; reject malformed IDs, duplicate IDs, bad manifest fields/events/paths, invalid `match`/`when`, and escaping symlinks before inference. Spawn without a shell using declared `command`/`args`, with relative script assets contained in the hook folder. Stdin is one strict bounded JSON request; stdout is empty or one strict bounded JSON object. Exit 2 blocks a gate; exit 0 with empty stdout continues; other exit/parse/timeout/abort/output errors have distinct stable codes. Non-tool events reject tool matchers. Hook input has no automatic secret projection.
### Documentation
Draft `docs/hooks.md` protocol/schema examples and state limits; add `agents.<name>.hooks.use` field type, ID formats, selection/order and an exact config example to `docs/configuration.md`.
### Tests first
Add Bash/Python/Node fixtures for empty-output continue, exit-2 denial, JSON denial, Unicode JSON, invalid manifest/matcher, conflicting exit/JSON decisions, timeout, abort, over-limit stdout/stderr, and process-tree cleanup. Skip a language fixture only if that interpreter is unavailable, while the Node path remains required.
### Anti-shortcut coverage
A script that prints a valid JSON prefix plus trailing bytes must fail; `exit 2` plus JSON continue must still deny; a selected path that resolves outside its root must fail; an unselected broken hook must not block an unrelated agent. A tool matcher that does not match must prevent process spawn, checked with a marker file.
### Implementation obligations
Define typed events/results/errors, validate config and manifest without executing, resolve paths safely, implement spawned runner with cleanup and bounded diagnostics. Do not add model-visible material.
### Acceptance criteria
- [ ] AC-1: Selected hooks validate and execute in declared order; malformed/escaping selected hooks fail before provider request — proven by config/loader tests.
- [ ] AC-2: Runner bounds, cancellation, timeout and strict request/response behavior hold, including descendant cleanup — proven by runner tests.
- [ ] AC-3: Agent without hooks loads unchanged — proven by existing config and baseline agent tests.
### Focused verification
`node --import tsx --test tests/hooks-config.test.ts tests/hooks-runner.test.ts`
### Phase gates
`npm run typecheck && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: define selected agent hook protocol and runner`

## Phase 2: Wire turn and tool lifecycle across hosts
### Goal
Run lifecycle hooks once at common boundaries and surface bounded outcomes in CLI, dashboard and ACP.
### Current behavior and gap
`ToolRegistry.dispatch` currently goes from policy/approval to handler. `AgentSession.execute` commits turns and sends terminal events without a hook step. Host renderers only understand existing `RunEvent` variants.
### Evidence
`src/tools/registry.ts:dispatch`; `src/agent.ts:execute`; `src/sessions/runtime.ts:runtimeAgentOptions`; `src/cli.ts:runCli`; `src/acp/methods.ts:startSession`; `src/dashboard/streams.ts`; `src/terminal/renderer.ts`.
### Pattern
One agent/registry runtime, separate host presentation; durable terminal receipts in `src/sessions/operations.ts`.
### Dependencies
Phase 1.
### Files and symbols
Edit `src/tools/registry.ts`, `src/agent.ts`, `src/sessions/runtime.ts`, `src/cli.ts`, `src/acp/methods.ts`, `src/dashboard/streams.ts`, `src/sessions/presentation.ts`, `src/terminal/renderer.ts`, `web/src/timeline.tsx`; add/extend lifecycle, registry, dashboard, ACP tests.
### Behavioral contract
`SessionStart`/`SessionEnd` fire once per runtime attach/close, including resume and cleanup. `UserPromptSubmit` precedes user/provider work; `PreToolUse` follows exposure/validation/policy and precedes approval/handler. Explicit denial or gate failure skips the guarded side effect. Exactly one of `PostToolUse`/`PostToolUseFailure` observes a handler invocation's actual outcome; `Stop` observes terminal run status, including error/cancellation. Every executed hook gets one live and persisted `hook_event` receipt, including empty-stdout success; notification failures preserve completed results. Gate hooks use the turn signal; terminal notifications use bounded host cleanup budgets and complete/abort before the durable terminal operation receipt. Ordering and cancellation are identical in CLI, web and ACP.
### Documentation
Complete lifecycle/ordering/error table in `docs/hooks.md`; update `docs/dashboard.md`, `docs/acp.md`, `docs/terminal-output.md` only where users see new events.
### Tests first
Use fake provider, fake tool and recording scripts to assert exact seven-event lifecycle order, selected-tool matcher/argument filtering before spawn, approval not bypassed, denied/invalid calls not hooked, gate failure no handler, notification failure preserved result, abort race, resume with changed hooks, and a single terminal operation receipt. Verify one live/persisted receipt per executed hook in each host, including an empty-stdout success. Cancel during handler, during `PostToolUseFailure`/`Stop`, and during runtime close; prove bounded completion, descendant cleanup, and one receipt per attempted hook.
### Anti-shortcut coverage
A hook added only to a CLI adapter must fail dashboard/ACP parity tests; a successful hook that leaves no visible/persisted receipt must fail; a notification-hook exception that changes an already successful tool result or creates a second terminal event must fail; a matched `ask` still prompts after a continue decision. SessionStart must not fire on every REPL turn, SessionEnd must not imply durable session deletion, and a canceled turn's terminal hooks must not inherit the already-aborted signal or leave child processes.
### Implementation obligations
Pass selected dispatcher through each construction path, attach turn IDs/signals and host-owned terminal-cleanup budgets, make common boundaries await hooks, persist/emit all hook receipts, update host renderers and no-hook fast path. Maintain `run_end` and durable operation receipt ordering.
### Acceptance criteria
- [ ] AC-4: `UserPromptSubmit`/`PreToolUse` gates block without permission/handler/model side effects and cannot bypass policy — proven by registry/agent tests.
- [ ] AC-5: `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionStart` and `SessionEnd` fire at their documented boundary; **every executed hook** leaves one live/persisted receipt, including success; notification errors are bounded without changing completed work — proven by lifecycle/history tests.
- [ ] AC-6: CLI, dashboard, ACP and resumed sessions use the same selected hooks, cancellation and event contract; cancel during a handler/terminal hook/close leaves no child or duplicate terminal receipt — proven by transport/integration tests.
### Focused verification
`node --import tsx --test tests/registry.test.ts tests/agent-lifecycle.test.ts tests/session-operations.test.ts tests/acp.test.ts tests/dashboard-sessions.test.ts`
### Phase gates
`npm run typecheck && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: run agent hooks at session, turn and tool boundaries`

## Phase 3: Make hooks editable and portable
### Goal
Let users create/select hooks in the dashboard and share a complete agent with its hooks in a local package.
### Current behavior and gap
Dashboard component APIs/forms cover tools and skills; package kind, export, binding and inspection omit hooks.
### Evidence
`src/management/components.ts:ComponentManager`; `web/src/pages/Components.tsx`; `web/src/pages/Agents.tsx`; `src/packages/contract.ts:componentKinds`; `src/packages/export.ts:exportAgentPackage`; `src/packages/resolve-agent.ts`; `schemas/raw-package.schema.json`.
### Pattern
Owned component tree editing and revision checks; explicit package exports/selection; installed consumer outside checkout.
### Dependencies
Phases 1–2.
### Files and symbols
Edit `src/management/components.ts`, dashboard management/routes, `web/src/pages/{Components,Agents,Packages}.tsx` and related types/router, `src/packages/{contract,manifest,resolve-agent,export,inspect}.ts`, `schemas/raw-package.schema.json`; add/extend management, package and Playwright tests.
### Behavioral contract
Dashboard can create/fork/edit/validate a hook folder and select it on an agent in order, with visible event/matcher/command/timeout fields. Package export copies local/agent/package hook trees and rewrites them to portable references. Install/bind/update resolves selected hooks by immutable package identity and current recipient model, never executes code while browsing/inspecting/installing. Deleted/in-use assets get the same usage and revision guards as tools/skills. A manually authored `raw-package.json` can export a standalone hook.
### Documentation
Add `examples/hooks/` and a complete agent example; update `docs/packages.md`, `docs/management.md`, `docs/dashboard.md`, `README.md`.
### Tests first
Export/install/bind/update/resume a package agent that has a hook; verify selected-only loading, missing export, path traversal/symlink rejection, dashboard draft revision conflict, and package catalog read with a script that would leave a marker if accidentally run.
### Anti-shortcut coverage
An exported agent that works only while its original `~/.config/raw/hooks` folder exists must fail the outside-checkout test. A catalog browse that imports or runs the hook must fail marker test.
### Implementation obligations
Extend package kind/capability/reference/schema and export paths, inspect without execution, expose managed hook files and agent selector, update package UI labels/actions, add installed consumer fixture. Keep package schema version 1 because this is additive in the unreleased format; do not migrate old test data.
### Acceptance criteria
- [ ] AC-7: A hook can be created, edited, validated, selected and saved through the dashboard with revision checks — proven by management and browser tests.
- [ ] AC-8: A local or package hook survives export/pack/install/bind/update and executes from an installed consumer with original paths absent — proven by package tests.
- [ ] AC-9: Browsing, inspection and installation never execute hook code — proven by side-effect marker tests.
### Focused verification
`node --import tsx --test tests/management-components.test.ts tests/package-export.test.ts tests/package-runtime.test.ts tests/dashboard-management.test.ts`
### Phase gates
`npm run typecheck && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: manage and package agent hooks`

## Phase 4: Ship setup guidance and qualify the installed artifact
### Goal
Make hooks discoverable and teach Raw's setup agent to create and attach one correctly.
### Current behavior and gap
The starter has six setup skills for config/agents/tools/packages, but none describe hooks. README and installed examples do not teach hook authoring.
### Evidence
`src/management/starter.ts:createStarterConfig`; `src/skills/bundled/{configure_raw,create_agent,create_package}` and their `references/` files; `scripts/copy-bundled-skills.mjs`; `tests/setup-skill-examples.test.ts`; `tests/dashboard-installed.test.ts`.
### Pattern
English bundled skills with references and verifiable examples; build copies them into npm artifact.
### Dependencies
Phases 1–3.
### Files and symbols
Add `src/skills/bundled/create_hook/SKILL.md` and supporting `references/`; update `src/skills/bundled/configure_raw/SKILL.md` with the exact `hooks.use` schema, value types, event/matcher/when/command/args/timeout validation and a config example; update `src/skills/bundled/create_agent/SKILL.md` with the agent composition workflow and hook selection example; update `src/skills/bundled/create_package/SKILL.md` plus `references/manifest.md`/`references/packages.md` with hook exports and recipient binding; update the corresponding dashboard references, `src/management/starter.ts`, `README.md`, `docs/hooks.md`, `docs/configuration.md`, installed example and tests.
### Behavioral contract
Fresh `raw config init` selects `builtin/create_hook` and skill tools, but no hook is active by default. `create_hook` teaches creation, validation and attachment; `configure_raw` teaches every config field and value type; `create_agent` teaches when/how to select ordered hooks; `create_package` teaches packaging a hook and binding a package agent that uses one. Each relevant skill has complete, consistent examples for named events, `match`/`when` filters, exit-0/exit-2/JSON decisions, gate-versus-notification failures, local testing and dashboard editing. Existing users may add the skill through config; no automatic config migration.
### Documentation
Finalize `docs/hooks.md` with runnable `PreToolUse` gate and `PostToolUse` notification examples in more than one scripting language, plus a no-network smoke recipe for CLI and dashboard. State clearly that `raw.hook/1` follows common industry patterns but is Raw's own protocol.
### Tests first
Validate the new skill frontmatter, links and example files; parse the `configure_raw` and `create_agent` hook config examples with `loadConfig`, load their selected hook manifests and check event matching, and validate the `create_package` manifest/reference example. Installed `npm pack` consumer runs a selected hook and checks visible outcome without a model service, using local fake provider/fixture or equivalent existing consumer harness.
### Anti-shortcut coverage
The installed-artifact test must fail if the skill/example is omitted from `npm pack`, or if the hook only works from the repository checkout. A fresh starter config must not invoke a hook on an ordinary turn.
### Implementation obligations
Ship and link the skill/docs/examples, update build/package allowlist when necessary, run exact artifact tests and full gates, record test outcomes and limitations. Do not globally install or publish without a fresh user request.
### Acceptance criteria
- [ ] AC-10: Starter exposes `create_hook` guidance and no active hook; `configure_raw`, `create_agent`, and `create_package` document the exact new schema and their examples validate and run — proven by starter/skill/example tests.
- [ ] AC-11: Packed consumer can create/select and execute a hook using only shipped docs/examples — proven by installed package test.
- [ ] AC-12: Full Node, browser, installed package and whitespace gates pass — proven by Global Gates.
### Focused verification
`node --import tsx --test tests/bundled-skills.test.ts tests/setup-skill-examples.test.ts tests/dashboard-installed.test.ts`
### Phase gates
`npm run check && npm run test:web && npm run test:package && git diff --check && npm pack --dry-run --json`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`docs: ship hook setup guidance and installed qualification`

## Completion Criteria
- All 12 acceptance criteria pass; each phase has an APPROVE implementation review and cohesive commit.
- A user can author a hook, attach it to one agent, observe it in CLI/dashboard/ACP, resume after a config change, and export/install that agent on another machine without retaining the source hook folder.
- No-hook agents preserve their existing model prefix and behavior. Failures/cancellation cannot bypass policy, duplicate terminal receipts, or orphan child processes.
- Marketplace remains out of scope.

## Progress Log
- 2026-09-27: Plan drafted from current source and self-reviewed; no production implementation started.
- 2026-09-27: GPT-6 Astra review approved in round 2 after two accepted corrections. Phase 1 in_progress.
- 2026-09-27: Phase 1 APPROVE (self-review): hook config/manifest/loader/runner added; 5 focused tests pass, including denied/invalid output, timeout, abort, escaped asset and descendant cleanup; typecheck and whitespace gate pass. Phase 2 next.
- 2026-09-27: Phase 2 APPROVE (self-review): common turn/tool/session boundaries, persisted live receipts and host projections added; 14 new focused hook tests and 38 existing ACP/dashboard/session tests pass, typecheck and whitespace pass. Phase 3 next.
