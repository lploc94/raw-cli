# Refactor tools into profile-selected plugins

## Plan schema
loop-plan/v1

## Target
Make Raw a small agent host whose four shipped tools use the same plugin contract as tools authored by a user. A user can place one tool per folder under the global Raw tools directory, select exact tools in a profile, edit the tool code/description/JSON Schema, and run or resume a session without losing stable model request prefixes when nothing changed. Profiles can also carry agent instructions. Add argument-aware tool policy so a profile can ask for a matching Bash command such as `rm` while allowing other Bash calls automatically. Keep MCP as an extension source and leave agent sharing/installing to later work.

## Scope
- Introduce one versioned on-disk tool manifest and handler contract. Shipped `read_file`, `write_file`, `bash`, and `view_image` become actual bundled plugin folders and pass through the same asynchronous loader as user tools. Preserve their current model names, schemas, descriptions, results, and limits when selected.
- Discover user manifests in `$XDG_CONFIG_HOME/raw/tools/<folder>/tool.json` or `~/.config/raw/tools/<folder>/tool.json`; each selected folder contains an `index.mjs` handler. The global tools directory is independent of `--config` and cwd. Read manifests without executing code; import only selected user handlers. Support one model-facing tool per folder in v1.
- Require exact profile selection `tools.use` over canonical IDs `builtin/<name>`, `local/<id>`, and `mcp/<server>/<original-name>`. `raw config init` writes the current default trio explicitly; `view_image` is explicitly selected only for a vision profile. Remove `profile.mcp` and wildcard selection from the profile contract; keep `mcp.servers` only as connection definitions. Do not parse, translate, or migrate old profile files.
- Add optional profile `instructions_file`, resolved relative to the config file, with precedence `--system-prompt` > `RAW_SYSTEM_PROMPT` > profile file > built-in prompt. File content is part of session identity; credentials and local paths are not embedded in a future shared-agent format.
- Extend `tools.rules` with optional `when: { any: "<argument path>", regex: "<pattern>" }`. The v1 path grammar is dot-separated object fields with an optional `[*]` array step, e.g. `commands[*].command`. Conditional rules support `effect: "ask"` only in v1; unconditional allow/ask/deny retain ordered last-match-wins and unconditional deny still hides the tool. Conditional ask runs after argument validation and only tightens a statically allowed tool. No matching rule means allow.
- Support controlled tool-definition changes on a later process run/resume for sessions created under the new contract: unchanged effective tools/prompt retain the exact ordered provider schema and cache key; changed effective tools create a new schema revision and cache key before inference, while committed transcript/history remain intact. An interactive session keeps its loaded local modules until it closes; no filesystem hot reload is required. Pre-refactor config and session data are disposable development state; no compatibility or migration work is required. Provider cache hits remain best effort.
- Exclude automatic install/share/export of agents, remote plugin download, transitive dependency management, sandboxing, project-directory auto-loading, and hot reload during an active inference/tool call. A selected local plugin executes with the user's OS permissions; document this plainly. The `when` regex is a configurable UX trigger, not a proof that all destructive shell actions were detected.

## Invariants
- Profiles under the new contract have one explicit tool list; there are no implicit built-ins. Breaking changes to config, public factory calls, and pre-refactor resume are accepted. The starter profile still selects the current three default tools, and each selected shipped tool retains its old model-facing definition and result behavior.
- Only an explicitly selected local tool's code may be imported. An unselected plugin and an unselected MCP server have no startup side effect. Duplicate canonical IDs or two selected tools with the same model-facing name fail before the first provider request; no implicit shadowing of a shipped tool.
- Plugin manifest and policy validation happen before handler import/dispatch. Handler arguments are validated against the declared JSON Schema; results keep current byte caps, typed image behavior, cancellation, approval, and error normalization. A conditional ask cannot hide a tool at schema-list time because arguments are not yet known.
- Profile selection, tool ordering, descriptions, schema key ordering, effective instructions, and provider adapter serialization are deterministic. No-op reconfiguration does not bump revision or rotate cache key. A changed tool generation never replays an unresolved call or executes an old call under a newly selected handler.
- An agent/session is never silently given a tool omitted by its explicit profile list. ACP peer callback tools remain separately negotiated, ephemeral, and governed by existing `acp:<name>` policy.
- Selected MCP tools still connect, discover, validate, dispatch, return supported typed content, time out/cancel, and close through the existing MCP client; selected stdio and Streamable HTTP transports remain supported. ACP standard sessions and negotiated reverse tools, all provider adapters, CLI/REPL output, compaction, and new-contract session/history behavior remain functional. Their configuration/tool-identity syntax may change only as explicitly stated in Scope.
- No plugin code, connection handles, secrets, or absolute user plugin paths are serialized into model history. Runtime source/version identity may be stored as private session metadata; model-visible identity is the actual ordered provider tool definition.

## Baseline
- Clean `main` at `8c2e40d`; the prior uncommitted footer and reasoning-order work was committed as `d209b86` and `8c2e40d`. Immediately before these commits, `npm run check` passed 281 tests and `npm run test:package` passed; the commits did not change those bytes. No plugin-plan production work exists.
- `src/tools/registry.ts:1-281` hardcodes three built-ins plus conditional `view_image`, exposes synchronous `createToolRegistry`, sorts definitions independently of whitelist order, filters by tool-name policy, and dispatches with validation/approval/output cap. Its generic validator at `src/tools/registry.ts:191` only checks a narrow subset of JSON Schema; MCP/ACP compile schemas with Ajv.
- `src/tools/primitives.ts`, `src/tools/process.ts`, and `src/tools/image.ts` own current handler behavior. `src/tools/mcp-client.ts:226` connects selected MCP servers and registers aliases in the same registry. `src/acp/methods.ts:369` already accepts ephemeral peer-registered callback tools.
- `src/config.ts:438` accepts profile `mcp` and `tools.rules`, but no explicit built-in/local selection or profile instructions. `bin/raw.ts:51` creates a starter config; `bin/raw.ts:100` renders `config list`.
- `src/cli.ts:144` and `src/acp/methods.ts:190` independently assemble a built-in registry, MCP connections, and an agent. `src/agent.ts:101-134,181-191` freezes the schema view and restores selection/cache key; `src/sessions/store.ts:297-356,384-396` compares JSON-stringified tool schema digests on resume and currently rejects a changed schema. `setToolView` increments revision even for an identical view.
- `tsup.config.ts` bundles `dist/raw.js` and `dist/index.js`; `package.json` publishes only `dist` and README. `tests/registry.test.ts`, `tests/registry-policy.test.ts`, `tests/config-mcp-policy.test.ts`, `tests/mcp.test.ts`, `tests/session-agent.test.ts`, `tests/session-cli.test.ts`, `tests/session-acp.test.ts`, and `tests/package.test.ts` provide the established test seams. CI runs Node 22.13.0 and 24 on macOS/Linux.

## Design and project patterns
1. **One loader and one execution path.** Define a normalized ToolPlugin carrying canonical ID, version, ToolDefinition fields, and async handler. Build four shipped source folders into non-minified `dist/tools/builtin/<name>/tool.json` + `index.mjs` assets. The same async loader reads manifests/imports selected entries from the package-owned and user-owned roots before creating a ToolRegistry; MCP registrations join that same registry. Replace the synchronous bundled factory with this async assembly path across CLI, ACP, library API, and tests. `ToolRegistry` remains a plain registration/dispatch container.
2. **Manifest and identity.** A strict `tool.json` has `api_version: 1`, `id`, `version`, `name`, `description`, `input_schema`, and `entry: "./index.mjs"`. The full ID is `builtin/<folder>` under the package root or `local/<folder>` under the user root; reject namespace spoofing, unknown fields, path traversal, symlinked entry escape, duplicate IDs, duplicate selected model-facing names, invalid schemas, and nonfunction exports. Canonical policy IDs are `builtin/<name>`, `local/<id>`, `mcp/<server>/<original-name>`, and existing negotiated `acp/<name>`. There are no legacy rule-name aliases. Give handlers a narrow `{cwd, signal, maxOutputBytes, toolCallId, bashPath?}` context; approval/whitelist callbacks remain host-owned. Selected plugin code still runs in-process with full user OS permissions; no claim of isolation.
3. **Profile as agent preset.** `tools.use` is required for every profile and is the sole tool-selection list, in declared order after resolving each ID. It is separate from `tools.rules`: selection controls visibility/startup, rules control call authorization. Old `profile.mcp` and profiles without `tools.use` are rejected. `instructions_file` is optional and resolved/read once when loading a profile; explicit CLI/env prompt overrides keep current precedence. The future sharing format is not defined in this plan.
4. **Argument policy.** Use the pure-JS, linear-time RE2JS engine (pin `re2js@2.8.6`; [upstream syntax/API](https://github.com/le0pard/re2js)) rather than backtracking JS RegExp for model-controlled strings. Compile regexes and validate the restricted argument path at config load; evaluate the predicate against validated arguments before approval and `onStart`. `any` means at least one scalar string at that path matches. A Bash batch with one matching `rm` command asks once for the whole batch; nonmatching Bash commands run automatically. Keep unconditional deny filtering and ordered unconditional rules; conditional ask can only tighten an otherwise allowed call. Document that arbitrary Bash syntax can evade a string pattern.
5. **Tool generations.** Canonicalize the effective model-facing tool array before persistence and provider calls. Persist both its digest and a selected-plugin source digest derived from ordered IDs, declared versions, manifest bytes, and entry-file bytes in the new session schema; users must bump a plugin version when changing an external dependency not covered by those bytes. Compare on each new process run/resume and explicit idle tool-view change. When equal, preserve saved revision, cache key, ordered definitions, and transcript exactly. When different, atomically update selection/digests/revision and rotate key before the next model request, retaining committed history and crash recovery. Keep existing ACP ephemeral-peer drop behavior. Do not claim to force a provider cache miss when the provider ignores Raw's cache key.

## Global Gates
- Each implementation phase starts with the named documentation and meaningful failing tests, then production code. Use temporary `XDG_CONFIG_HOME` and `XDG_STATE_HOME` in tests; never load the user's real tools directory or touch real sessions. Do not call live model/MCP services.
- Update existing fixtures to the new config contract without deleting their behavioral assertions. Keep MCP transport/content, ACP protocol/reverse-tool, provider, session, and compaction suites in the full regression gate; a breaking config format is not permission to remove runtime coverage.
- Before each phase commit: focused tests, `npm run check`, `git diff --check`, an implementation review with an APPROVE verdict, and inspection that no unrelated files entered the phase. Run `npm run test:package` after phases affecting installed assets/startup and at final completion; run `npm run test:overhead` after bundled/model-visible definitions change.
- The final gates are `npm run check`, `npm run test:overhead`, `npm run test:package`, and the existing macOS/Linux Node 22.13.0/24 CI matrix. The test runner must build the plugin assets before source/packed tests; no test may depend on stale `dist`. Cache-hit counts themselves are not acceptance criteria; exact provider request prefixes and keys are.
- Do not install or execute downloaded/shared tool code. Package tests use fixture plugins in temporary directories. When a new-contract saved session has a changed profile tool generation, transition it only at an idle, owned boundary; failures leave the saved generation and context intact. Do not add a parser or DB migration for pre-refactor development state.

## Plan Review
APPROVE — Self-review on 2026-09-25 checked the user's latest intent against all six phases: one real loader/contract, explicit profile-selected tools, matching-only Bash ask, stable unchanged-session prefixes, MCP/ACP and other runtime regression coverage, and intentional breaking changes with no compatibility parser or migration. Source paths, test seams, phase dependencies, packaging gates, and all required phase fields were checked. Material design assumptions are package-owned bundled folders plus global user-owned folders, in-process execution only for explicitly selected local code, and RE2JS-backed conditional ask patterns; agent sharing/installation remains out of scope.

## Phase 1: Establish the plugin contract and move shipped tools
### Goal
Create real package-owned plugin folders, the versioned contract, and the bundled-root portion of the one loader, ready for the runtime cutover in Phase 3.
### Current behavior and gap
Definitions/validators are centralized in `src/tools/registry.ts`; handlers live separately. There is no common manifest/plugin normalization boundary.
### Evidence
`src/tools/registry.ts:1-281`, `src/tools/primitives.ts`, `src/tools/image.ts`, `src/tools/results.ts`, `src/index.ts:15`, `tests/registry.test.ts`, `tests/batch-*.test.ts`.
### Pattern
Reuse ToolRegistration/ToolRegistry and current handler/result functions while moving each definition/handler into `src/tools/bundled/<name>/`. Compile each entry as a readable standalone ESM asset under `dist/tools/builtin/<name>/`; copy its manifest beside it. Resolve the package-owned root from the installed package, not cwd. Keep the old registry assembly wired only until Phase 3; do not add a permanent compatibility adapter. Build assets before direct source tests.
### Dependencies
None.
### Files and symbols
`src/tools/registry.ts` (ToolRegistration, dispatch), `src/tools/primitives.ts`, `src/tools/image.ts`, new `src/tools/plugins/contract.ts`, new `src/tools/plugins/loader.ts`, new `src/tools/bundled/*`, `tsup.config.ts`, `scripts/test.mjs`, `scripts/test-phase.mjs`, `package.json`, `src/index.ts`, `docs/tools.md`, `tests/registry.test.ts`, `tests/batch-integration.test.ts`, `tests/vision.test.ts`, `tests/package.test.ts`.
### Behavioral contract
The eventual starter profile will select read_file, write_file, bash; view_image is available only to vision models that select it. Same inputs produce the same tool result shapes and errors; current batch/vision limits remain. Each bundled folder exposes a readable editable manifest and executable ESM handler. The existing caller path remains live until the Phase 3 cutover.
### Documentation
Describe the bundled plugin contract and mark the loader as not yet wired to profiles. Do not advertise user-directory loading until Phase 3.
### Tests first
Snapshot exact pre-refactor model-facing definitions and compare loaded bundled assets with the old registry; run existing read/write/Bash/image behavior tests through both paths; assert installed package assets are present.
### Anti-shortcut coverage
A parity test compares complete descriptions and nested schema, not only tool names; another runs all four handlers through registry dispatch so a cosmetic folder move cannot pass.
### Implementation obligations
Extract definition metadata and handlers, retain existing result caps and typed content, introduce the bundled-root loader and centralized plugin normalization, emit manifest+ESM assets, and build before tests. Defer removal of the old factory/caller path to Phase 3, when the new loader can replace it everywhere in one commit.
### Acceptance criteria
- [ ] AC-1.1: Selected bundled tool arrays, including the vision tool when selected, are byte-for-byte equivalent to the pre-refactor definitions — proven by definition snapshot tests.
- [ ] AC-1.2: Read/write/Bash/image registry dispatch retains current results, limits, and abort behavior — proven by existing and parity tests.
- [ ] AC-1.3: Shipped plugins are distinct readable packaged folders using one manifest/handler contract — proven by packed asset and source inspection tests.
### Focused verification
`npm run build && node --import tsx --test tests/registry.test.ts tests/batch-integration.test.ts tests/vision.test.ts`
### Phase gates
`npm run check && npm run test:overhead && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`refactor: register shipped tools as bundled plugins`

## Phase 2: Build one selected-only plugin loader
### Goal
Load package-owned and trusted user-authored `tool.json` plus `index.mjs` through one asynchronous selected-only loader.
### Current behavior and gap
Phase 1 has bundled plugin assets, but no shared discovery/loading path or global tools directory. Direct library registration and ACP callbacks are the only existing non-MCP native paths.
### Evidence
`src/config.ts:138-160`, `src/tools/registry.ts:17-27,201-279`, `src/tools/mcp-client.ts:240-346`, `tests/config-mcp-policy.test.ts:10-36`, `tests/registry-policy.test.ts`.
### Pattern
Follow strict JSON key validation in config, Ajv schema compilation in MCP/ACP, selected-only MCP startup, and registry dispatch/output normalization. Both bundled and local roots return the same normalized registration type.
### Dependencies
Phase 1.
### Files and symbols
New `src/tools/plugins/loader.ts`, `src/tools/plugins/contract.ts`, `src/tools/registry.ts`, `src/index.ts`, `docs/tools.md`, new `tests/tool-plugins.test.ts`, fixture folders under `tests/fixtures/tools/`.
### Behavioral contract
Resolve the package-owned bundled root and the global XDG/Home tools directory. Discover folder names without importing code; parse/validate manifests and import entry modules only for selected IDs. Validate the selected manifest, full supported JSON Schema, handler export, ID/name collisions, and entry containment. Dispatch through the existing registry with output cap, cancellation, and policy. A missing/invalid selected tool fails before provider work; an unrelated invalid or unselected folder does not block the session or execute code.
### Documentation
Specify both roots, directory layout, manifest fields, handler signature/result types, Node ESM `.mjs` requirement, full OS permissions, and selected-only import.
### Tests first
Use temporary homes and sentinel side-effect modules: unselected never imports, selected does; bundled and local manifests resolve through the same API; malformed/duplicate/traversal/symlink selected entries fail while malformed unselected entries remain inert; nested schema rejects invalid args; valid JSON/image/error results keep host limits; a thrown handler yields a normalized tool error.
### Anti-shortcut coverage
One fixture writes a sentinel at module top level and must remain untouched when unselected; a second fixture has a nested schema that the old shallow validator would accept incorrectly. Neither test may rely on a live provider.
### Implementation obligations
Parse manifests before import, compile schema once with the existing Ajv draft-07/2020-12 support while rejecting async/remote-reference schemas, use file URLs for import, do not shell-evaluate entry paths, pass only the narrow plugin context to handlers, register only normalized selected tools, and keep module-load failures contextual without leaking secrets.
### Acceptance criteria
- [ ] AC-2.1: The same loader registers selected bundled/local handlers and imports no unselected local handler — proven by parity and sentinel tests.
- [ ] AC-2.2: Invalid manifests/schema/entry escapes/collisions fail before a handler or provider runs — proven by negative fixtures.
- [ ] AC-2.3: Selected local tools obey the registry's validation, approval, abort, and result cap — proven by dispatch tests.
### Focused verification
`npm run build && node --import tsx --test tests/tool-plugins.test.ts tests/registry-policy.test.ts`
### Phase gates
`npm run check && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: load selected local tool plugins`

## Phase 3: Select tools and agent instructions in profiles
### Goal
Give each profile an exact tool set and optional instruction file; cut CLI, ACP, and library assembly over to one asynchronous plugin/MCP path.
### Current behavior and gap
Profile `mcp` selects only external tools; built-ins are implicit. System prompt comes from CLI/env/default, so a profile alone does not define an agent preset. This old profile contract will be removed.
### Evidence
`src/config.ts:214-238,438-470,540-583`, `src/cli.ts:144-181`, `src/acp/methods.ts:190-257`, `src/llm/prompt.ts`, `tests/config-mcp-policy.test.ts`, `tests/session-acp.test.ts`.
### Pattern
Extend strict profile parsing and immutable RuntimeConfig; reuse selected-only MCP connection and the existing CLI/ACP registry assembly, extracted to one shared runtime builder.
### Dependencies
Phases 1-2.
### Files and symbols
`src/config.ts` (ProfileSpec, profileSpec, loadConfig), `src/cli.ts` (runCli), `src/acp/methods.ts` (startSession), `src/tools/registry.ts` (remove createToolRegistry), `src/tools/mcp-client.ts`, new `src/tools/plugins/runtime.ts`, `src/index.ts`, `bin/raw.ts` (config init/list/help), `docs/configuration.md`, `docs/mcp.md`, `tests/fixtures/config.ts`, `tests/config-mcp-policy.test.ts`, `tests/session-cli.test.ts`, `tests/session-acp.test.ts`, `tests/mcp.test.ts`, `tests/mcp-content.test.ts`, `tests/acp.test.ts`, and all callers/tests of createToolRegistry.
### Behavioral contract
`tools.use` explicitly selects all effective built-in/local/MCP IDs; an empty array selects no tools. Missing `tools.use`, old `profile.mcp`, unknown ID, duplicate ID/model name, or selected image tool with a nonvision model fails config/startup before inference. Unselected local code and MCP servers stay inert. ACP `session/new` may supply a selected MCP server absent from the global config; a duplicate server name across ACP/global sources fails rather than silently overriding either. Profile instructions resolve relative to the actual selected config path and obey documented override precedence; absent instructions keep today's default prompt.
### Documentation
Document exact ID syntax, examples for read-only and coding profiles, explicit empty selection, instruction-file precedence, and `config list` output without secrets. State that pre-refactor config must be rewritten and no migration is provided.
### Tests first
Compare two profiles using the same model but disjoint tool sets; prove only selected schemas reach mock provider in CLI and ACP, including a selected ACP-provided MCP server; execute a selected MCP tool end to end over stdio and Streamable HTTP with typed result, cancellation, and cleanup assertions; empty selection has no tools; unknown/duplicate/missing selections, duplicate ACP/global MCP server names, and missing instruction files fail before network; flags/env override instructions; old `profile.mcp` is rejected. Update every existing config fixture to the new required schema without dropping its runtime assertions.
### Anti-shortcut coverage
Create a selected local module whose top-level code writes a marker and an unselected MCP process with another marker; run the other profile and assert neither marker exists. Compare actual provider request tool arrays, not only parsed config.
### Implementation obligations
Resolve selection before connections/imports, assemble registry once per session, make the model-facing definition array follow the explicit `tools.use` order rather than the old registry sort, remove the old profile.mcp path and synchronous built-in factory calls in the same commit, update every caller/test and config fixture plus config init/list/help and exports, and avoid globally evaluating all local plugin code. ACP-provided session/new MCP server definitions are connection sources only; their tools become model-visible only if selected by profile IDs. Do not add a compatibility parser or old factory wrapper.
### Acceptance criteria
- [ ] AC-3.1: Explicit profiles expose exactly their selected tools in the declared order through both CLI and ACP — proven by mock-provider requests.
- [ ] AC-3.2: Unselected local/MCP implementations are not started; empty selection is valid — proven by sentinel tests.
- [ ] AC-3.3: Every profile requires one explicit tool list; old profile.mcp is rejected, no sync factory caller remains, and prompt precedence is correct — proven by config/CLI tests and source search.
- [ ] AC-3.4: Selected MCP calls still execute through both supported transports and preserve typed results, cancellation, and cleanup; ACP-selected MCP and peer reverse tools still work — proven by MCP/ACP integration tests.
### Focused verification
`npm run build && node --import tsx --test tests/config-mcp-policy.test.ts tests/session-cli.test.ts tests/session-acp.test.ts tests/mcp.test.ts tests/mcp-content.test.ts tests/acp.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: select plugin tools and instructions per profile`

## Phase 4: Add argument-aware tool policy
### Goal
Ask for a matching Bash command while allowing nonmatching Bash calls automatically, and make the same predicate usable by typed plugins.
### Current behavior and gap
`ToolPolicyRule` has only match/effect, and `ToolRegistry.effect` sees only canonical tool identity. Approval already receives full validated arguments.
### Evidence
`src/tools/registry.ts:22-27,208-279`, `src/config.ts:295-312`, `src/cli.ts:136-143`, `docs/tools.md:31-39`, `tests/registry-policy.test.ts`, `tests/acp-policy.test.ts`.
### Pattern
Keep ordered last-match-wins unconditional rules and the existing approval callback rather than adding a special Bash-only prompt path. Compile policy at config load, then evaluate conditional ask after argument validation and before `onStart`.
### Dependencies
Phases 1-3.
### Files and symbols
`src/tools/registry.ts` (ToolPolicyRule, effect, definitions, dispatch), `src/config.ts` (toolRulesSpec), `bin/raw.ts` (config list), `package.json`, `package-lock.json`, `docs/tools.md`, `docs/configuration.md`, `tests/registry-policy.test.ts`, `tests/config-mcp-policy.test.ts`, `tests/session-cli.test.ts`, `tests/acp-policy.test.ts`.
### Behavioral contract
`when.any` traverses the restricted path; `when.regex` performs an unanchored RE2JS match on any selected string without implicit case folding. Reject unsupported RE2 constructs/path syntax, malformed/oversized regex, or a conditional effect other than ask at config load. Bind each matching rule to each selected tool's schema before provider work and reject paths that cannot resolve to string fields; ACP peer tools are checked when registered. At dispatch, an absent optional path simply does not match. An unconditional deny hides a tool; conditional ask leaves an allowed tool visible but gates matching calls. For a Bash batch, any matching command makes the entire dispatch ask once. Nonmatching Bash remains allow. Explicit ask is not bypassed by `-y`; headless matching calls return `approval_required`.
### Documentation
Show a valid RE2 pattern for a direct `rm` command, e.g. `(^|[;&|()\n])\s*(sudo\s+)?(/usr/bin/|/bin/)?rm(\s|$)` (double the backslashes in JSON), plus examples for Bash batches and a typed tool. State that the pattern inspects command strings and is not shell-semantic enforcement.
### Tests first
Red tests for `printf ok` allowed without approval, `rm -rf tmp` ask, second command matching in a batch asks exactly once, denied approval prevents every command in that batch, no match keeps allow, unsupported lookahead/conditional deny rejected at config load, a nonexistent or nonstring schema path rejected before provider work, a hostile nested-quantifier pattern staying bounded, and unconditional deny/ask precedence. Exercise CLI and ACP approval paths.
### Anti-shortcut coverage
A mixed batch with safe first command and matching second command must perform no side effect before approval; a rule on a non-Bash nested argument proves policy is generic rather than a hardcoded `rm` detector.
### Implementation obligations
Separate visibility-time unconditional policy from argument-time conditional ask, validate path compatibility when binding selected/ACP tools and arguments before predicate evaluation, pin/use RE2JS and cap regex/path size, preserve one approval per call and status/error shape, and do not silently turn all Bash calls into ask.
### Acceptance criteria
- [ ] AC-4.1: Matching Bash batches ask once before any execution; nonmatching Bash runs immediately — proven by registry and process tests.
- [ ] AC-4.2: Conditional ask works for local/MCP/ACP tools, while unconditional allow/ask/deny retain their existing precedence — proven by registry/ACP tests.
- [ ] AC-4.3: Invalid regex/path syntax fails at config load and schema-incompatible paths fail before provider work; explicit ask still fails closed headlessly — proven by config/CLI tests.
### Focused verification
`npm run build && node --import tsx --test tests/registry-policy.test.ts tests/config-mcp-policy.test.ts tests/session-cli.test.ts tests/acp-policy.test.ts`
### Phase gates
`npm run check && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: gate tool calls with argument patterns`

## Phase 5: Preserve and revise durable tool generations
### Goal
Keep identical tool definitions stable across turns/resume and let a changed profile/plugin generation resume safely with a new cache generation.
### Current behavior and gap
Session initialization rejects a changed tool-schema digest; `setToolView` increments on no-op and does not rotate the cache key on a change. Saved selection can override a newly selected profile list.
### Evidence
`src/agent.ts:101-134,181-191,495-498`, `src/sessions/store.ts:297-356,384-396,625-642`, `src/acp/methods.ts:216-252,364-410`, `tests/session-agent.test.ts:19-58`, `tests/session-process.test.ts`.
### Pattern
Keep the existing durable owner/transaction boundary and exact transcript replay; add a compare-and-transition method instead of rebuilding the session or mutating model history.
### Dependencies
Phases 1-4.
### Files and symbols
`src/agent.ts` (constructor, setToolView), `src/sessions/store.ts` (initializeAgent, updateAgentToolView), `src/sessions/schema.ts`, `src/sessions/restore.ts`, `src/cli.ts`, `src/acp/methods.ts`, `docs/cli.md`, `docs/architecture.md`, `tests/session-agent.test.ts`, `tests/session-cli.test.ts`, `tests/session-acp.test.ts`, `tests/session-process.test.ts`.
### Behavioral contract
Canonicalize selected model-facing definitions and hash selected plugin IDs, versions, manifests, and entry bytes as a separate source identity. Same generation after process restart yields the same cache key, schema revision, ordered tool array, and committed model messages. A changed generation at an idle/owned boundary atomically updates saved selection/digests/revision and rotates key before inference; committed old calls/results remain linked and never rerun. Code-only entry changes trigger a revision/key change even if the model-facing schema is identical. A failed transition leaves old stored state intact. ACP peer aliases continue to drop/re-register as before; no old peer callback is revived. A changed system prompt/model/endpoint remains an error.
### Documentation
Explain exactly when a tool edit changes the model-facing prefix, when only handler version changes, and why provider cache hits remain best effort. Update resume compatibility text.
### Tests first
Use a persisted fixture across two processes: identical tools produce byte-equal ordered provider tool arrays and cache key; the second request contains the exact prior committed messages plus only the new user input. Changed description/schema/selection or entry code triggers one revision and different key while retaining transcript; no-op reconfiguration leaves revision/key unchanged; rejected/aborted transition cannot partially update DB; pending side effect is recovered as unknown, not dispatched again; ACP ephemeral callback behavior remains intact.
### Anti-shortcut coverage
Compare serialized provider tools, system prompt, saved message prefix, and cache key before/after resume, not only stored digest; account for the newly appended user turn. A changed-tool test must make a follow-up provider call and prove the new schema is used while old tool output remains in transcript; a crash fixture proves it cannot replay the unresolved old call.
### Implementation obligations
Use a transaction for generation update, make the current explicit profile selection authoritative over saved tool selection, preserve strict checks for non-tool runtime identity, rotate the session key only on a true change, and keep current recovery ordering. Bump the session schema if the clean model needs it; do not write a migration or compatibility reader for old dev sessions.
### Acceptance criteria
- [ ] AC-5.1: Unchanged plugin/profile resumes with identical ordered tools, system, committed-message prefix, and key — proven by cross-process request comparison.
- [ ] AC-5.2: Changed selected tool definition advances revision/rotates key exactly once and preserves history — proven by store and CLI/ACP tests.
- [ ] AC-5.3: Crash/failed-transition and ACP ephemeral-peer recovery retain existing no-replay guarantees — proven by process/ACP tests.
### Focused verification
`npm run build && node --import tsx --test tests/session-agent.test.ts tests/session-cli.test.ts tests/session-acp.test.ts tests/session-process.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: persist deterministic tool generations across resume`

## Phase 6: Ship editable examples and qualify the installed CLI
### Goal
Make the plugin workflow usable from an installed package and document how a user copies/edits a shipped tool or authors a new one.
### Current behavior and gap
`package.json` ships only `dist` and README; source handlers are not an installed, runnable example. Package tests currently prove core/MCP/ACP but not user plugin selection or conditional policy from an installed binary.
### Evidence
`package.json:8-16`, `tsup.config.ts`, `tests/package.test.ts:22-100`, `docs/tools.md`, `docs/configuration.md`, `.github/workflows/ci.yml`.
### Pattern
Extend the existing packed-consumer test and build pipeline. Generate non-minified, runnable `tool.json` + `index.mjs` fork templates from the bundled source, and include a small independent custom-tool example. Do not make package installation write into the user's config directory.
### Dependencies
Phases 1-5.
### Files and symbols
`tsup.config.ts`, `package.json`, new `examples/tools/*`, optional `scripts/build-tool-examples.mjs`, `tests/package.test.ts`, `docs/tools.md`, `docs/configuration.md`, `docs/mcp.md`, `docs/cli.md`, `README.md`.
### Behavioral contract
The npm tarball contains readable tool examples/fork templates. A user can copy one folder to `~/.config/raw/tools/`, edit its code, description, and schema, select it in a profile, and execute it in a packed consumer without checkout-relative imports. Editing a shipped tool does not alter package-owned defaults; the profile selects the local fork instead. Import/share commands and automatic installation remain out of scope.
### Documentation
Provide one complete profile with bundled, local and MCP IDs, `instructions_file`, and conditional Bash `rm` policy. Explain where to copy/edit a tool, required rebuild only for modifying Raw source, direct ESM execution for local `.mjs`, full OS permissions, and session/cache transition semantics.
### Tests first
Pack/install into a temporary consumer, copy/edit a bundled template into a temporary XDG tools directory, run it through the installed CLI, inspect the provider request for edited schema/description, assert unselected plugin code remains inert, and verify conditional Bash policy and resume. Inspect tarball contents and ensure no real user config/state touched.
### Anti-shortcut coverage
The packed-consumer test runs outside the checkout with checkout paths unavailable; copying the example must be enough to execute. A description/schema edit must be visible to the model, so documentation-only examples cannot pass.
### Implementation obligations
Build/copy the executable examples from bundled plugin sources, include assets in `npm pack`, keep the installed CLI's runtime file resolution independent of checkout, and update all user-facing docs/help together.
### Acceptance criteria
- [ ] AC-6.1: Packed consumer copies/edits and executes a bundled-tool fork without checkout imports — proven by package test.
- [ ] AC-6.2: Installed CLI/ACP select exact profile tools, enforce matching-only Bash ask, and resume unchanged/changed generations — proven by package and session integration tests.
- [ ] AC-6.3: Documentation and help match the implemented manifest/profile/policy schema — proven by inspection and fixture-based examples.
### Focused verification
`npm run test:package`
### Phase gates
`npm run check && npm run test:overhead && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`docs: ship forkable tool plugins and validate packaged workflow`

## Completion Criteria
- All six phases meet their checked acceptance criteria, pass their focused/full gates, receive APPROVE implementation reviews, and are committed in order. Final macOS/Linux Node 22.13.0/24 CI passes.
- The generated starter profile explicitly selects the same three shipped tools; every other profile exposes only its chosen bundled/local/MCP IDs and optional agent instructions. An unselected user module cannot execute.
- The agreed Bash rule asks for matching `rm` command strings and leaves nonmatching Bash calls automatic. Invalid policy fails early.
- MCP remains fully usable through the new profile selection contract, and existing provider/ACP/CLI/REPL/compaction behavior passes its regression suites; only explicitly listed config/API and old-dev-session compatibility is removed.
- Unchanged profile/plugin state preserves exact tool definitions and cache key through resume; a changed generation continues safely with a new revision/key and no replayed side effects.
- Plugin folders and complete examples work from the npm package without modifying the user's global config on install. Old dev config/session formats are not supported or migrated. Agent sharing and untrusted-plugin isolation remain separate future work.

## Progress Log
- 2026-09-25: Planning only. Baseline committed clean at `8c2e40d`; CTXE readiness was Ready/fresh, relevant runtime/config/session/package paths and tests inspected. User clarified that the project is unpublished development software, so the plan explicitly drops old config/API/session compatibility and migration. No application code changed for this plan.
- 2026-09-25: Intent and structure self-review complete; six phase blocks and 19 binary acceptance criteria checked, Plan Review set to APPROVE. Implementation awaits user approval of this plan.
- 2026-09-25: Clarified non-regression requirement for MCP transports/content and other runtime subsystems; added an explicit MCP/ACP acceptance criterion. Config syntax and pre-refactor dev sessions remain intentionally breaking.
