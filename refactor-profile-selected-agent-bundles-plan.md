# Refactor tools and skills into profile-selected agent bundles

## Plan schema
loop-plan/v1

## Target
Make Raw a small agent host whose shipped tools use the same plugin contract as user-authored tools. A profile selects exact tools and skills and supplies a system prompt inline, from a Markdown file, or by run-time override. Bundled `list_skills` reveals only selected skill names/descriptions on demand; bundled `load_skill` appends a requested skill's Markdown as a durable tool result at the end of conversation history. A user can copy one config directory containing its profile, prompt, tools, and skills to share a runnable agent without a registry/install service. Preserve stable model request prefixes when nothing changed, add argument-aware Bash approval, and keep MCP as an extension source.

## Scope
- Introduce one versioned on-disk tool manifest and handler contract. Shipped `read_file`, `write_file`, `bash`, and `view_image` become actual bundled plugin folders and pass through the same asynchronous loader as user tools. Preserve their current model names, schemas, descriptions, results, and limits when selected.
- Discover user manifests in `$XDG_CONFIG_HOME/raw/tools/<folder>/tool.json` or `~/.config/raw/tools/<folder>/tool.json`, plus `<config-dir>/tools/<folder>/tool.json` for a transferable agent directory; each selected folder contains an `index.mjs` handler. Global roots are independent of `--config` and cwd; agent roots resolve beside the selected config. Read manifests without executing code; import only selected handlers. Support one model-facing tool per folder in v1.
- Require exact initial profile selection `tools.use` over canonical IDs `builtin/<name>`, `local/<id>`, `agent/<id>`, and `mcp/<server>/<original-name>`. `raw config init` writes the current default trio explicitly; `view_image`, `list_skills`, and `load_skill` are explicitly selected when needed. Preserve explicit ACP `_raw/session/configure` as a negotiated, idle-only runtime override that can activate a cataloged MCP tool beyond the initial profile set; it cannot import an unselected local plugin. Remove `profile.mcp` and wildcard selection from the profile contract; keep `mcp.servers` as connection definitions. Do not parse, translate, or migrate old profile files.
- Add mutually exclusive profile `system_prompt` (literal text) and `system_prompt_file` (UTF-8 Markdown path; relative paths resolve beside the selected config, absolute paths are accepted). Precedence is `--system-prompt` > `RAW_SYSTEM_PROMPT` > profile inline/file > built-in prompt; an explicitly empty prompt is valid. Preserve the effective prompt in session identity. `--config <agent-dir>/raw.json --profile <name>` is the explicit local sharing path; the example agent bundle uses relative paths and requires no absolute personal path or credential.
- Add optional `skills.use` with explicit `agent/<id>` or `local/<id>` IDs. Agent skills live at `<config-dir>/skills/<folder>/`; global skills live at the Raw XDG/Home skills root. A selected skill has strict `skill.json` metadata (`api_version`, `id`, `name`, `description`, `entry: "./SKILL.md"`) and a Markdown body. Ship `builtin/list_skills` and `builtin/load_skill` as normal bundled tools; a profile with nonempty `skills.use` must select both in `tools.use`. Their generic model-facing definitions stay stable; the selected catalog and Markdown body are absent from initial context and appear only as capped, untruncated tool results when called. Unselected skill bodies are not read.
- Extend `tools.rules` with optional `when: { any: "<argument path>", regex: "<pattern>" }`. The v1 path grammar is dot-separated object fields with an optional `[*]` array step, e.g. `commands[*].command`. Conditional rules support `effect: "ask"` only in v1; unconditional allow/ask/deny retain ordered last-match-wins and unconditional deny still hides the tool. Conditional ask runs after argument validation and only tightens a statically allowed tool. No matching rule means allow.
- Support controlled selected tool/skill changes on a later process run/resume for sessions created under the new contract: unchanged effective tools/prompt/skill catalog and bytes retain the exact ordered provider request prefix and generated session key. Changed selected tool state creates a new generation and generated key before inference; an explicit OpenAI `profile.cache.key` keeps its existing wire precedence. A skill-only change advances the context generation but keeps the generated/effective key and prior prefix because neither the system nor tool definitions change; a durable tail notice marks any previously listed/loaded skill data stale. Committed transcript/history remains intact. An interactive session freezes selected skill bytes and local modules until it closes; no filesystem hot reload is required. Pre-refactor config and session data are disposable development state; no compatibility or migration work is required. Provider cache hits remain best effort.
- Exclude registry-based sharing, automatic install/export, remote plugin download, transitive dependency management, sandboxing, project-directory auto-loading, and hot reload during an active inference/tool call. A copied agent directory is runnable through `--config` with local model/env setup; no claim is made that arbitrary MCP servers or external tool dependencies travel with it. A selected local plugin executes with the user's OS permissions; document this plainly. The `when` regex is a configurable UX trigger, not a proof that all destructive shell actions were detected.

## Invariants
- Profiles under the new contract have one explicit tool list; there are no implicit built-ins. Breaking changes to config, public factory calls, and pre-refactor resume are accepted. The starter profile still selects the current three default tools, and each selected original shipped tool retains its old model-facing definition and result behavior; `load_skill` is an additional opt-in bundled tool.
- Only an explicitly selected local tool's code may be imported. An unselected plugin and an unselected global MCP server have no startup side effect; an ACP-supplied MCP server may connect for its negotiated catalog while its tools remain hidden until profile selection or explicit `_raw/session/configure`. Duplicate canonical IDs or two selected tools with the same model-facing name fail before the first provider request; no implicit shadowing of a shipped tool.
- Plugin manifest and policy validation happen before handler import/dispatch. Handler arguments are validated against the declared JSON Schema and any plugin-exported semantic validator before approval or `onStart`; the three existing batch-tool validators retain their errors and whole-batch rejection behavior, and `view_image` retains its existing validation behavior. Results keep current byte caps, typed image behavior, cancellation, approval, and error normalization. A conditional ask cannot hide a tool at schema-list time because arguments are not yet known.
- Profile selection, tool ordering, descriptions, schema key ordering, effective instructions, and provider adapter serialization are deterministic. No-op reconfiguration does not bump revision or rotate cache key. A changed tool generation never replays an unresolved call or executes an old call under a newly selected handler.
- Selected skill catalog entries and Markdown bodies enter only through linked `list_skills` and `load_skill` tool results at the conversation tail. No skill inventory/body is prepended to the system prompt or rewritten into prior messages. Failed, denied, cancelled, oversized, or unknown loads cannot expose partial content. A resumed session retains committed skill results in order; compaction records which skills need an explicit reload rather than silently dropping their effect.
- An agent/session is never silently given a tool omitted by its initial profile list. ACP `_raw/session/configure` can explicitly change its model-visible selection after negotiation at an idle boundary; peer callback tools remain separately negotiated, ephemeral, and governed by existing `acp:<name>` policy.
- Selected MCP tools still connect, discover, validate, dispatch, return supported typed content, time out/cancel, and close through the existing MCP client; selected stdio and Streamable HTTP transports remain supported. ACP standard sessions and negotiated reverse tools, all provider adapters, CLI/REPL output, compaction, and new-contract session/history behavior remain functional. Their configuration/tool-identity syntax may change only as explicitly stated in Scope.
- No plugin code, connection handles, secrets, or absolute user plugin/skill paths are serialized into model history. Runtime source/version identity may be stored as private session metadata; model-visible identity is the effective system prompt, actual ordered provider tool definitions, and committed messages.

## Baseline
- Application-code baseline is `8c2e40d`; the prior footer and reasoning-order work was committed as `d209b86` and `8c2e40d`. Immediately before these commits, `npm run check` passed 281 tests and `npm run test:package` passed; the commits did not change those bytes. The latest documentation-only commit before this amendment is `7e531f3`; no plugin-plan production work exists.
- `src/tools/registry.ts:1-281` hardcodes three built-ins plus conditional `view_image`, exposes synchronous `createToolRegistry`, sorts definitions independently of whitelist order, filters by tool-name policy, and dispatches with validation/approval/output cap. Its generic validator at `src/tools/registry.ts:191` only checks a narrow subset of JSON Schema; MCP/ACP compile schemas with Ajv.
- `src/tools/primitives.ts`, `src/tools/process.ts`, and `src/tools/image.ts` own current handler behavior. `src/tools/mcp-client.ts:226` connects selected MCP servers and registers aliases in the same registry. `src/acp/methods.ts:369` already accepts ephemeral peer-registered callback tools.
- `src/config.ts:438` accepts profile `mcp` and `tools.rules`, but no explicit built-in/local selection or profile instructions. `bin/raw.ts:51` creates a starter config; `bin/raw.ts:100` renders `config list`.
- `src/cli.ts:144` and `src/acp/methods.ts:190` independently assemble a built-in registry, MCP connections, and an agent. `src/agent.ts:101-134,181-191` freezes the schema view and restores selection/cache key; `src/sessions/store.ts:297-356,384-396` compares JSON-stringified tool schema digests on resume and currently rejects a changed schema. `setToolView` increments revision even for an identical view.
- `src/config.ts:438-470,540-583` currently accepts no profile system prompt or skill list; `--system-prompt` and `RAW_SYSTEM_PROMPT` already override the built-in prompt. `src/agent.ts:386-402,470-531` commits ordered assistant/tool messages and passes one system string plus the transcript to adapters. `src/compact.ts:71-139` can replace older turns, so loaded skill content needs an explicit post-compaction reload contract.
- `tsup.config.ts` bundles `dist/raw.js` and `dist/index.js`; `package.json` publishes only `dist` and README. `tests/registry.test.ts`, `tests/registry-policy.test.ts`, `tests/config-mcp-policy.test.ts`, `tests/mcp.test.ts`, `tests/session-agent.test.ts`, `tests/session-cli.test.ts`, `tests/session-acp.test.ts`, and `tests/package.test.ts` provide the established test seams. CI runs Node 22.13.0 and 24 on macOS/Linux. The original plan was committed at `c196706` and MCP regression clarification at `7e531f3`; no plugin/skill application code has been implemented.

## Design and project patterns
1. **One loader and one execution path.** Define a normalized ToolPlugin carrying canonical ID, version, ToolDefinition fields, and async handler. Build the four original shipped source folders, then both skill-tool folders, into non-minified `dist/tools/builtin/<name>/tool.json` + `index.mjs` assets. The same async loader reads manifests/imports selected entries from package-owned, global user-owned, and config-local roots before creating a ToolRegistry; MCP registrations join that same registry. Replace the synchronous bundled factory with this async assembly path across CLI, ACP, library API, and tests. `ToolRegistry` remains a plain registration/dispatch container.
2. **Manifest and identity.** A strict `tool.json` has `api_version: 1`, `id`, `version`, `name`, `description`, `input_schema`, and `entry: "./index.mjs"`. The entry exports an async handler and may export a synchronous `validateArgs(args): string | undefined` for semantic constraints the model-facing schema cannot express; the registry runs that validator before approval and execution. Preserve the existing read/write/Bash batch validators and error strings in their packaged entries; execute semantic validation before schema validation for those entries to maintain existing errors, then apply the compiled schema. Keep `view_image`'s existing generic validation behavior. A copied fork carries the validator in its `index.mjs`. The full ID is `builtin/<folder>` under the package root, `local/<folder>` under the global user root, or `agent/<folder>` under the selected config directory; reject namespace spoofing, unknown fields, path traversal, symlinked entry escape, duplicate IDs, duplicate selected model-facing names, invalid schemas, and nonfunction exports. Canonical policy IDs also include `mcp/<server>/<original-name>` and existing negotiated `acp:<name>`. There are no legacy rule-name aliases. Give handlers a narrow `{cwd, signal, maxOutputBytes, toolCallId, bashPath?, skills?}` context; only the two bundled skill handlers receive the frozen selected-skill lookup. Approval/whitelist callbacks remain host-owned. Selected plugin code still runs in-process with full user OS permissions; no claim of isolation.
3. **Profile as local agent bundle.** `tools.use` is required for every profile and determines the initial model-visible list, in declared order after resolving each ID. It is separate from `tools.rules`: selection controls visibility/startup, rules control call authorization. Old `profile.mcp` and profiles without `tools.use` are rejected. ACP can explicitly override its own visible list with `_raw/session/configure` from already loaded tools and discoverable MCP catalog entries; this is not an implicit profile tool and cannot import unselected local code. ACP-supplied servers can connect for catalog discovery without exposing their tools. `system_prompt` and `system_prompt_file` are mutually exclusive; relative file paths resolve beside the actual config, not cwd, while explicit absolute paths are accepted. Resolve the effective prompt once before agent construction, honoring existing CLI/env override precedence. A directory containing `raw.json`, optional `prompt.md`, `tools/`, and `skills/` is a copyable local agent; no installer, export command, or dependency bundler is planned.
4. **Skills as opt-in tool results.** Selected skill folders have strict `skill.json` metadata and UTF-8 `SKILL.md`; validate selected IDs, metadata, path containment, duplicate names, and body byte limits before provider work. Do not read unselected bodies. Freeze selected contents for a live session. The normal bundled `list_skills` tool returns only selected names/descriptions, and `load_skill` takes a `name` limited to selected names and returns the complete Markdown or a normal tool error. Both use the same policy/approval/result-cap path as other tools; their generic model-facing definitions contain no selected catalog data, so calls append catalog and content as ordered, durable tool results after linked assistant calls. On compaction, record loaded-skill IDs in the summary/reload notice; reloading is explicit. No automatic skill instructions enter the system prompt.
5. **Argument policy.** Use the pure-JS, linear-time RE2JS engine (pin `re2js@2.8.6`; [upstream syntax/API](https://github.com/le0pard/re2js)) rather than backtracking JS RegExp for model-controlled strings. Compile regexes and validate the restricted argument path at config load; evaluate the predicate against validated arguments before approval and `onStart`. `any` means at least one scalar string at that path matches. A Bash batch with one matching `rm` command asks once for the whole batch; nonmatching Bash commands run automatically. Keep unconditional deny filtering and ordered unconditional rules; conditional ask can only tighten an otherwise allowed call. Document that arbitrary Bash syntax can evade a string pattern.
6. **Tool and skill generations.** Canonicalize the effective system prompt and model-facing tool array before persistence and provider calls. Persist their digests and selected source digests derived from ordered tool IDs, versions, manifests, entry bytes, and selected skill IDs, metadata, and Markdown bytes in the new session schema; users must bump a plugin version when changing an external dependency not covered by those bytes. Compare on each new process run/resume and explicit idle tool-view change. When equal, preserve saved revision, generated session cache key, ordered definitions, and transcript exactly. Recover unresolved assistant tool calls before appending any generation/skill notice. When selected tools change, atomically update digests/revision and rotate the generated session key before inference. An explicitly configured `profile.cache.key` keeps its existing precedence as the effective OpenAI wire key; it can remain constant across changed tool schemas, whose changed request prefix prevents stale-prefix reuse. When only skills change, atomically update their digests/revision but retain the generated key and existing prefix; append a tail notice if old catalog/body results exist, before the next inference. Both transitions retain committed history and crash recovery. CLI resume uses its profile selection; ACP resume restores an explicit saved `_raw/session/configure` selection when its catalog source is still available, while dropping only ephemeral peer aliases as before. A changed effective system prompt/model/endpoint remains a resume error. Do not claim to force a provider cache miss when the provider ignores Raw's cache hint.

## Global Gates
- Each implementation phase starts with the named documentation and meaningful failing tests, then production code. Use temporary `XDG_CONFIG_HOME` and `XDG_STATE_HOME` in tests; never load the user's real tools directory or touch real sessions. Do not call live model/MCP services.
- Update existing fixtures to the new config contract without deleting their behavioral assertions. Keep MCP transport/content, ACP protocol/reverse-tool and `_raw/session/configure` discovery/activation, provider, session, and compaction suites in the full regression gate; a breaking config format is not permission to remove runtime coverage.
- Before each phase commit: focused tests, `npm run check`, `git diff --check`, an implementation review with an APPROVE verdict, and inspection that no unrelated files entered the phase. Run `npm run test:package` after phases affecting installed assets/startup and at final completion; run `npm run test:overhead` after bundled/model-visible definitions change.
- The final gates are `npm run check`, `npm run test:overhead`, `npm run test:package`, and the existing macOS/Linux Node 22.13.0/24 CI matrix. The test runner must build the plugin assets before source/packed tests; no test may depend on stale `dist`. Cache-hit counts themselves are not acceptance criteria; exact provider request prefixes, generated session keys, and effective wire hints under the documented override rule are.
- Do not download or install tool code. Package tests copy local fixture agent directories into temporary locations and never touch real global config/state. When a new-contract saved session has a changed profile tool/skill generation, transition it only at an idle, owned boundary; failures leave the saved generation and context intact. Do not add a parser or DB migration for pre-refactor development state.

## Plan Review
APPROVE — External `gpt-6-astra` plan review completed in three rounds on 2026-09-25. Round 1 identified five issues; the saved plan now preserves packaged semantic batch validators, recovers unfinished tool calls before skill notices, distinguishes generated session keys from explicit OpenAI cache-key overrides, preserves negotiated ACP MCP activation as an explicit runtime override, and uses `acp:<name>` consistently. Round 2 found no new blockers; round 3 produced the runner-parsed APPROVE verdict. Seven phases and 25 acceptance criteria remain intact. No application code has been changed.

## Phase 1: Establish the plugin contract and move shipped tools
### Goal
Create real package-owned plugin folders, the versioned contract, and the bundled-root portion of the one loader, ready for the runtime cutover in Phase 3.
### Current behavior and gap
Definitions and the read/write/Bash semantic batch validators are centralized in `src/tools/registry.ts`; handlers live separately. There is no common manifest/plugin normalization boundary. JSON Schema alone does not express every existing batch constraint.
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
Snapshot exact pre-refactor model-facing definitions and compare loaded bundled assets with the old registry; run existing read/write/Bash/image behavior tests through both paths; send malformed later read/write/Bash batch entries through packaged plugin dispatch and verify they reject before approval or any earlier side effect; assert installed package assets are present.
### Anti-shortcut coverage
A parity test compares complete descriptions and nested schema, not only tool names; another runs all four handlers through registry dispatch so a cosmetic folder move cannot pass.
### Implementation obligations
Extract definition metadata, handlers, and the three existing batch validators into each corresponding plugin entry; chain semantic checks before compiled schema checks and before approval/execution, retaining old error messages and whole-batch rejection. Retain existing result caps and typed content, introduce the bundled-root loader and centralized plugin normalization, emit manifest+ESM assets, and build before tests. Defer removal of the old factory/caller path to Phase 3, when the new loader can replace it everywhere in one commit.
### Acceptance criteria
- [x] AC-1.1: Selected bundled tool arrays, including the vision tool when selected, are byte-for-byte equivalent to the pre-refactor definitions — proven by definition snapshot tests.
- [x] AC-1.2: Read/write/Bash/image registry dispatch retains current results, semantic batch rejection before side effects, limits, and abort behavior — proven by existing and packaged-plugin parity tests.
- [x] AC-1.3: Shipped plugins are distinct readable packaged folders using one manifest/handler contract — proven by packed asset and source inspection tests.
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
Load package-owned, global user-authored, and config-local `tool.json` plus `index.mjs` through one asynchronous selected-only loader.
### Current behavior and gap
Phase 1 has bundled plugin assets, but no shared discovery/loading path or user/config-local tools directory. Direct library registration and ACP callbacks are the only existing non-MCP native paths.
### Evidence
`src/config.ts:138-160`, `src/tools/registry.ts:17-27,201-279`, `src/tools/mcp-client.ts:240-346`, `tests/config-mcp-policy.test.ts:10-36`, `tests/registry-policy.test.ts`.
### Pattern
Follow strict JSON key validation in config, Ajv schema compilation in MCP/ACP, selected-only MCP startup, and registry dispatch/output normalization. All three roots return the same normalized registration type.
### Dependencies
Phase 1.
### Files and symbols
New `src/tools/plugins/loader.ts`, `src/tools/plugins/contract.ts`, `src/tools/registry.ts`, `src/index.ts`, `docs/tools.md`, new `tests/tool-plugins.test.ts`, fixture folders under `tests/fixtures/tools/`.
### Behavioral contract
Resolve the package-owned bundled root, the global XDG/Home tools directory, and `<config-dir>/tools` beside the actual selected config file. Discover folder names without importing code; parse/validate manifests and import entry modules only for selected IDs. Validate the selected manifest, full supported JSON Schema, handler export, ID/name collisions, and entry containment. Dispatch through the existing registry with output cap, cancellation, and policy. A missing/invalid selected tool fails before provider work; an unrelated invalid or unselected folder does not block the session or execute code.
### Documentation
Specify all three roots, directory layout, manifest fields, handler signature/result types, Node ESM `.mjs` requirement, full OS permissions, and selected-only import.
### Tests first
Use temporary homes/config directories and sentinel side-effect modules: unselected never imports, selected does; bundled, global-local, and config-local manifests resolve through the same API; malformed/duplicate/traversal/symlink selected entries fail while malformed unselected entries remain inert; nested schema rejects invalid args; optional exported `validateArgs` rejects a semantically invalid later batch operation before any approval or earlier side effect; valid JSON/image/error results keep host limits; a thrown handler yields a normalized tool error.
### Anti-shortcut coverage
One fixture writes a sentinel at module top level and must remain untouched when unselected; a second fixture has a nested schema that the old shallow validator would accept incorrectly. Neither test may rely on a live provider.
### Implementation obligations
Parse manifests before import, compile schema once with the existing Ajv draft-07/2020-12 support while rejecting async/remote-reference schemas, bind an optional exported synchronous semantic validator and reject malformed exports, use file URLs for import, do not shell-evaluate entry paths, pass only the narrow plugin context to handlers, register only normalized selected tools, and keep module-load failures contextual without leaking secrets.
### Acceptance criteria
- [x] AC-2.1: The same loader registers selected bundled/global/config-local handlers and imports no unselected handler — proven by parity and sentinel tests.
- [x] AC-2.2: Invalid manifests/schema/entry escapes/collisions fail before a handler or provider runs — proven by negative fixtures.
- [x] AC-2.3: Selected local tools obey compiled-schema plus optional semantic validation before approval/side effects, abort, and result cap — proven by dispatch tests.
### Focused verification
`npm run build && node --import tsx --test tests/tool-plugins.test.ts tests/registry-policy.test.ts`
### Phase gates
`npm run check && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: load selected local tool plugins`

## Phase 3: Select tools and system prompts in profiles
### Goal
Give each profile an exact tool set and an optional inline or Markdown-file system prompt; cut CLI, ACP, and library assembly over to one asynchronous plugin/MCP path.
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
`tools.use` explicitly selects all initial built-in/global-local/config-local/MCP IDs; an empty array selects no tools initially. Missing `tools.use`, old `profile.mcp`, unknown ID, duplicate ID/model name, or selected image tool with a nonvision model fails config/startup before inference. Unselected local code and unselected global MCP servers stay inert. ACP `session/new` may supply a selected or discoverable MCP server absent from global config; an ACP-supplied discoverable server can connect with no model-visible tools, then `_raw/session/configure` may explicitly activate its cataloged tools at an idle boundary. A duplicate server name across ACP/global sources fails rather than silently overriding either. ACP configure may also deselect/reselect already loaded tools and preserve its explicit selection on resume when source definitions are available; it cannot import an unselected local plugin. `system_prompt` and `system_prompt_file` are mutually exclusive, relative paths resolve from the selected config (absolute paths work), CLI/env overrides win, and absent prompt fields keep today's default. A missing/unreadable/invalid UTF-8 selected file fails before provider work.
### Documentation
Document exact ID syntax, examples for read-only and coding profiles, explicit empty selection, inline/file/run-time prompt precedence, and `config list` output without leaking prompt text or secrets. State that pre-refactor config must be rewritten and no migration is provided.
### Tests first
Compare two profiles using the same model but disjoint tool sets; prove only initial selected schemas reach mock provider in CLI and ACP, including a selected ACP-provided MCP server; preserve the existing ACP fixture that discovers an MCP server with zero initially exposed tools then explicitly activates one via `_raw/session/configure`, and assert no model exposure before that request; execute selected MCP tools end to end over stdio and Streamable HTTP with typed result, cancellation, and cleanup assertions; empty initial selection has no tools; unknown/duplicate/missing selections, duplicate ACP/global MCP server names, and missing/unreadable/invalid UTF-8 prompt files fail before network; inline/relative-file/absolute-file/default prompt and CLI/env override precedence including explicitly empty text are proven by provider requests; both prompt fields together and old `profile.mcp` are rejected. Update every existing config fixture to the new required schema without dropping its runtime assertions.
### Anti-shortcut coverage
Create a selected local module whose top-level code writes a marker and an unselected MCP process with another marker; run the other profile and assert neither marker exists. Compare actual provider request tool arrays, not only parsed config.
### Implementation obligations
Resolve initial selection before connections/imports, assemble registry once per session, make the model-facing definition array follow the explicit `tools.use` order rather than the old registry sort, remove the old profile.mcp path and synchronous built-in factory calls in the same commit, update every caller/test and config fixture plus config init/list/help and exports, and avoid globally evaluating all local plugin code. ACP-provided session/new MCP definitions are connection/catalog sources; their tools become model-visible only by profile IDs or later explicit `_raw/session/configure`. Preserve capability and idle gating for that extension, bind conditional policy when a tool is activated, and never use it to import an unselected local plugin. Do not add a compatibility parser or old factory wrapper.
### Acceptance criteria
- [ ] AC-3.1: Profiles expose exactly their selected initial tools in declared order through CLI and ACP; negotiated ACP configure can explicitly activate a cataloged MCP tool later — proven by mock-provider and ACP integration requests.
- [ ] AC-3.2: Unselected local handlers and global MCP servers are not started; ACP-provided discoverable servers expose no tools before selection; empty initial selection is valid — proven by sentinel and ACP catalog tests.
- [ ] AC-3.3: Every profile requires one explicit tool list; old profile.mcp is rejected, no sync factory caller remains, and literal/file/run-time system prompt precedence is correct — proven by config/CLI/ACP tests and source search.
- [ ] AC-3.4: Selected MCP calls still execute through both supported transports and preserve typed results, cancellation, and cleanup; ACP-selected MCP and peer reverse tools still work — proven by MCP/ACP integration tests.
### Focused verification
`npm run build && node --import tsx --test tests/config-mcp-policy.test.ts tests/session-cli.test.ts tests/session-acp.test.ts tests/mcp.test.ts tests/mcp-content.test.ts tests/acp.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: select plugin tools and system prompts per profile`

## Phase 4: Add profile skills and bundled discovery/loading tools
### Goal
Give an explicitly selected profile two ordinary bundled tools to list its skills and append one selected skill's full Markdown only when called.
### Current behavior and gap
Raw has no skill contract, skill directory loader, or skill-list/load tool. The provider request carries one fixed system string and ordered tool-call transcript; the registry already commits linked tool results in sequence.
### Evidence
`src/config.ts:438-470,540-583`, `src/tools/registry.ts:17-27,201-279`, `src/agent.ts:386-402,470-531`, `src/compact.ts:71-139`, `src/sessions/store.ts:297-396`, `tests/session-agent.test.ts`, `tests/session-acp.test.ts`.
### Pattern
Use the same strict manifest/path validation and selected-only discovery as tool plugins, with `skill.json` metadata and UTF-8 `SKILL.md`. Register `list_skills` and `load_skill` through the bundled plugin loader and existing registry dispatch; the agent's existing linked tool-result commit is the context append mechanism.
### Dependencies
Phases 1-3.
### Files and symbols
`src/config.ts` (ProfileSpec, skills.use validation), new `src/skills/loader.ts`, new `src/tools/bundled/list_skills/`, new `src/tools/bundled/load_skill/`, `src/tools/plugins/contract.ts` (frozen selected-skill host capability), `src/tools/plugins/runtime.ts`, `src/tools/registry.ts`, `src/agent.ts`, `tsup.config.ts`, `bin/raw.ts` (config list), `docs/tools.md`, `docs/configuration.md`, new `docs/skills.md`, new `tests/skill-tools.test.ts`, `tests/session-agent.test.ts`, `tests/session-cli.test.ts`, `tests/session-acp.test.ts`, and fixture skill folders.
### Behavioral contract
`skills.use` defaults to `[]` and selects exact global `local/<id>` or config-local `agent/<id>` skill IDs in order; duplicates and unknown IDs fail before provider work. A nonempty selection requires both `builtin/list_skills` and `builtin/load_skill` in `tools.use`; neither tool is implicitly injected. Selected metadata and Markdown are validated and frozen once per live session, but only selected entries are read. `list_skills` returns only the selected names/descriptions; `load_skill` accepts a selected name and returns exactly its Markdown. Both outputs arrive as normal linked tool results after the triggering assistant call. No selected catalog/body enters the initial system prompt or tool definition. Unknown, denied, cancelled, invalid-UTF-8, oversized, or escaping loads reveal no partial body. The profile output cap must fit the complete encoded list result and each selected skill result or startup fails with a clear error; no silent truncation.
### Documentation
Document `skill.json` and `SKILL.md`, both roots, explicit profile selection of both tools, call flow, output cap, no implicit prompt injection, and copying a config-local skill directory with its agent.
### Tests first
With mock providers in CLI and ACP, assert an initial request has neither a selected name nor body; a `list_skills` call returns only two selected metadata entries; a later `load_skill` call appends the exact Markdown after its linked assistant call and survives persistence/resume; an unselected invalid skill is never read. Reject missing bundled tools, duplicate/unknown skill IDs/names, symlink/path escape, invalid UTF-8, oversize body, and partial result on cancellation/denial. Prove a profile with no skills and no skill tools remains valid.
### Anti-shortcut coverage
Inspect the actual first and next provider requests, including full message order, and place a unique sentinel only inside one selected `SKILL.md`. The sentinel must be absent until `load_skill` completes; a mock tool result injected directly into the test cannot satisfy this oracle.
### Implementation obligations
Add strict selected-only skill discovery, freeze selected bytes and names, provide the selected catalog only to the two bundled handlers, keep generic stable tool schemas/descriptions, and return normal registry results so validation, policy, abort, output cap, display, and durable linked messages remain one execution path. Do not append content by mutating the system prompt or previous messages. Update packed build assets for both tools.
### Acceptance criteria
- [ ] AC-4.1: Selected global/config-local skills validate deterministically while unselected bodies stay unread — proven by loader and negative-path fixtures.
- [ ] AC-4.2: `list_skills` reveals only selected names/descriptions in a linked tail result and never injects an initial catalog — proven by CLI/ACP provider-request comparisons.
- [ ] AC-4.3: `load_skill` appends exact selected Markdown only after a valid linked call, persists it for resume, and never leaks partial/denied content — proven by process and failure tests.
- [ ] AC-4.4: Profiles with skills require both explicitly selected bundled tools; empty skill selection remains valid — proven by config and registry tests.
### Focused verification
`npm run build && node --import tsx --test tests/skill-tools.test.ts tests/session-agent.test.ts tests/session-cli.test.ts tests/session-acp.test.ts`
### Phase gates
`npm run check && npm run test:package && npm run test:overhead && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: expose selected skills through bundled list and load tools`

## Phase 5: Add argument-aware tool policy
### Goal
Ask for a matching Bash command while allowing nonmatching Bash calls automatically, and make the same predicate usable by typed plugins.
### Current behavior and gap
`ToolPolicyRule` has only match/effect, and `ToolRegistry.effect` sees only canonical tool identity. Approval already receives full validated arguments.
### Evidence
`src/tools/registry.ts:22-27,208-279`, `src/config.ts:295-312`, `src/cli.ts:136-143`, `docs/tools.md:31-39`, `tests/registry-policy.test.ts`, `tests/acp-policy.test.ts`.
### Pattern
Keep ordered last-match-wins unconditional rules and the existing approval callback rather than adding a special Bash-only prompt path. Compile policy at config load, then evaluate conditional ask after argument validation and before `onStart`.
### Dependencies
Phases 1-4.
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
- [ ] AC-5.1: Matching Bash batches ask once before any execution; nonmatching Bash runs immediately — proven by registry and process tests.
- [ ] AC-5.2: Conditional ask works for local/MCP/ACP tools, including an MCP tool activated later by ACP configure; `acp:<name>` matches negotiated peer policy and unconditional allow/ask/deny retain precedence — proven by registry/ACP tests.
- [ ] AC-5.3: Invalid regex/path syntax fails at config load and schema-incompatible paths fail before provider work; explicit ask still fails closed headlessly — proven by config/CLI tests.
### Focused verification
`npm run build && node --import tsx --test tests/registry-policy.test.ts tests/config-mcp-policy.test.ts tests/session-cli.test.ts tests/acp-policy.test.ts`
### Phase gates
`npm run check && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: gate tool calls with argument patterns`

## Phase 6: Preserve and revise durable tool and skill generations
### Goal
Keep identical prompt, tool, and skill generations stable across turns/resume and let changed selected tool/skill state resume safely with a new cache generation.
### Current behavior and gap
Session initialization rejects a changed tool-schema digest; `setToolView` increments on no-op and does not rotate the cache key on a change. Saved selection can override a newly selected profile list. Phase 4 has selected skill content, but the store does not yet track its source digest or reload need across resume/compaction.
### Evidence
`src/agent.ts:101-134,181-191,386-402,495-498`, `src/sessions/store.ts:297-356,384-396,625-642`, `src/compact.ts:71-139`, `src/acp/methods.ts:216-252,364-410`, `tests/session-agent.test.ts:19-58`, `tests/session-process.test.ts`.
### Pattern
Keep the existing durable owner/transaction boundary and exact transcript replay; add a compare-and-transition method instead of rebuilding the session or mutating model history. Recover unresolved calls first, then append a small reload notice only when selected skill data already seen by the model changed or compaction removed loaded content.
### Dependencies
Phases 1-5.
### Files and symbols
`src/agent.ts` (constructor, setToolView, compaction), `src/sessions/store.ts` (initializeAgent, updateAgentToolView, selected skill identity), `src/sessions/schema.ts`, `src/sessions/restore.ts`, `src/compact.ts`, `src/skills/loader.ts`, `src/cli.ts`, `src/acp/methods.ts`, `docs/cli.md`, `docs/architecture.md`, `docs/skills.md`, `tests/skill-tools.test.ts`, `tests/session-agent.test.ts`, `tests/session-cli.test.ts`, `tests/session-acp.test.ts`, `tests/session-process.test.ts`, `tests/auto-compact.test.ts`.
### Behavioral contract
Canonicalize the effective system prompt and selected model-facing definitions; hash selected plugin IDs, versions, manifests, entry bytes, and selected skill IDs/metadata/Markdown bytes as separate source identities. Same generation after process restart yields the same generated session key, context revision, ordered tool array, system prompt, and committed model messages. At an idle/owned resume boundary, first append recovery results for unresolved calls in their original assistant-call order and validate the linked transcript. Only then commit a changed selected tool/skill generation and any skill notice; persist generation, visible-skill tracking, and idempotent notice marker together so another crash/restart cannot duplicate or hide it. A changed selected tool generation rotates the generated session key before inference; a skill-only change preserves it and the old provider prefix. If the model has seen an old `list_skills` or `load_skill` result affected by a skill change, append exactly one durable tail notice naming stale entries and requiring a new list/load call; no old result is rewritten. After compaction removes loaded skill text, append a durable tail reminder to reload those skill IDs; do not automatically prepend or duplicate full bodies. Code-only tool entry changes rotate the generated key even when schemas match; skill-only changes do not. Existing explicit `profile.cache.key` remains the effective OpenAI wire key when configured; its value need not rotate because the changed tool definition changes the request prefix. Committed calls/results remain linked and never rerun; a failed transition leaves old stored generation/notice state intact. Explicit ACP configure selections are restored from saved state when catalog sources remain available; ephemeral peer aliases continue to drop/re-register, and no old peer callback is revived. A changed effective system prompt/model/endpoint remains an error.
### Documentation
Explain exactly when prompt/tool/skill edits change the model-facing prefix or only source identity, when a skill must be explicitly reloaded after resume/compaction, and why provider cache hits remain best effort. Distinguish the generated session key from an explicit `profile.cache.key` that overrides the effective OpenAI wire hint; update resume and ACP configure compatibility text.
### Tests first
Use a persisted fixture across two processes: identical prompt/tools/skills produce byte-equal system, ordered provider tool arrays, prior committed message prefix, and generated session key; the second request adds only the new user input. Changed tool description/schema/selection or entry code or config-local tool bytes triggers one revision and different generated key while retaining transcript. Skill metadata/body/selection changes advance revision but keep the generated key when system/tool definitions are unchanged; if the model saw affected skill data, exactly one tail reload notice appears before inference. Exercise both OpenAI adapter wire requests with and without an explicit `profile.cache.key`: unchanged generations retain the same effective key; tool-changed generations rotate only generated keys, while explicit keys remain literal and request tool prefixes change; skill-only generations retain the key and prefix until appended notice/result. No-op reconfiguration leaves revision/key unchanged; changed prompt still fails resume; rejected/aborted transition cannot partially update DB. Combine a pending tool side effect with a skill edit and another crash during transition: recovery result must precede one notice, and no call may replay. Preserve ACP explicit configure selection after resume with available MCP catalog source, and keep ephemeral callback drop behavior. Exercise compaction after a loaded skill and prove the skill is either still present in retained history or named in a tail reload reminder.
### Anti-shortcut coverage
Compare serialized provider tools, system prompt, saved message prefix, generated key, and actual OpenAI wire cache hint before/after resume, not only stored digest; account for the newly appended user turn and any documented tail reload notice. A changed-tool test must make a follow-up provider call and prove the new schema is used while old tool output remains in transcript; a changed-skill test must show old Markdown retained as historical and the model told to reload the new version. A crash-plus-skill-edit fixture proves recovery results precede notices and unresolved calls cannot replay.
### Implementation obligations
Recover unresolved calls and validate their linkage before any new context notice; then use a transaction for generation, visible-skill tracking, and idempotent notice update. Make current explicit profile tool/skill selection authoritative for CLI and initial ACP state, while preserving an ACP session's saved explicit `_raw/session/configure` selection when its MCP catalog source is still available. Preserve strict checks for effective prompt and non-tool runtime identity, rotate only the generated session key when selected tools change, and preserve `profile.cache.key` precedence at the adapter boundary. Rename/replace the old tool-only `schema_revision` and public `toolSchemaRevision` with a context-generation revision in the new schema/API; it tracks tool and skill source state, and ACP configure responses use the new name. Persist selected skill IDs/digests and listed/loaded-result tracking as private metadata; never store absolute skill paths in model history. Add a durable, idempotent tail notice on changed/compacted visible skill data without orphan tool messages. Bump the session schema if the clean model needs it; do not write a migration or compatibility reader for old dev sessions.
### Acceptance criteria
- [ ] AC-6.1: Unchanged plugin/profile resumes with identical ordered tools, system, committed-message prefix, and key — proven by cross-process request comparison.
- [ ] AC-6.2: Changed selected tool definition advances revision/rotates the generated key exactly once and preserves history; an explicit OpenAI key stays literal while tool-prefix bytes change — proven by store, CLI/ACP, and both OpenAI adapter wire tests.
- [ ] AC-6.3: Crash-plus-skill-change recovery links pending calls before exactly one notice even across a second restart; failed transitions and ACP ephemeral-peer recovery retain no-replay guarantees — proven by process/ACP tests.
- [ ] AC-6.4: A skill-only change retains generated and effective cache keys plus prior request prefix while changed/compacted model-visible skill data produces exactly one durable tail reload notice; unchanged skills do not — proven by cross-process, compaction, and adapter wire tests.
### Focused verification
`npm run build && node --import tsx --test tests/skill-tools.test.ts tests/session-agent.test.ts tests/session-cli.test.ts tests/session-acp.test.ts tests/session-process.test.ts tests/auto-compact.test.ts tests/cache.test.ts tests/providers.test.ts tests/responses.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: persist deterministic tool and skill generations across resume`

## Phase 7: Ship editable examples and qualify transferable agent directories
### Goal
Make the plugin workflow usable from an installed package, and prove one copied directory containing config, system prompt, tools, and skills runs as a complete local agent.
### Current behavior and gap
`package.json` ships only `dist` and README; source handlers are not an installed, runnable example. Package tests currently prove core/MCP/ACP but not user plugin selection, skill discovery/loading, portable config-local paths, or conditional policy from an installed binary.
### Evidence
`package.json:8-16`, `tsup.config.ts`, `tests/package.test.ts:22-100`, `docs/tools.md`, `docs/configuration.md`, `.github/workflows/ci.yml`.
### Pattern
Extend the existing packed-consumer test and build pipeline. Generate non-minified, runnable `tool.json` + `index.mjs` fork templates from bundled source, and include one self-contained agent directory with `raw.json`, `prompt.md`, `tools/`, and `skills/`. Do not make package installation write into the user's config directory.
### Dependencies
Phases 1-6.
### Files and symbols
`tsup.config.ts`, `package.json`, new `examples/tools/*`, new `examples/agents/*`, optional `scripts/build-tool-examples.mjs`, `tests/package.test.ts`, `docs/tools.md`, `docs/configuration.md`, `docs/skills.md`, `docs/mcp.md`, `docs/cli.md`, `README.md`.
### Behavioral contract
The npm tarball contains readable tool examples/fork templates and a copyable agent directory. A user can copy/edit one tool under `~/.config/raw/tools/` or the agent's `tools/`, select it in a profile, and execute it without checkout-relative imports. A copied agent directory works under a different absolute path with `raw --config <copied>/raw.json --profile <name> "task"`: model/environment credentials remain supplied by the recipient, but its prompt, config-local tool, and skill work without references to the sender's home. Editing a shipped tool does not alter package-owned defaults; the profile selects the fork instead. Import/export commands and automatic installation remain out of scope.
### Documentation
Provide one complete profile with bundled, local, config-local and MCP IDs, `system_prompt`/`system_prompt_file`, `skills.use`, both skill tools, and conditional Bash `rm` policy. Explain copying the whole agent directory, where to edit a tool or skill, required rebuild only for modifying Raw source, direct ESM execution for local `.mjs`, full OS permissions, credential/env requirements, and session/cache transition semantics.
### Tests first
Pack/install into a temporary consumer, copy/edit a bundled template into temporary XDG tools, run it through the installed CLI, inspect the provider request for edited schema/description, assert unselected plugin code remains inert, and verify conditional Bash policy and resume. A copied write/Bash tool fork must retain its exported semantic validator: an invalid later batch operation is rejected before approval and before the first operation's side effect. Copy the example agent to two unrelated absolute paths with an isolated XDG home, run each from a different cwd using only its own `raw.json`, verify identical effective system prompt/tools, `list_skills` catalog, `load_skill` body, and a successful resume after copying before the session starts. Inspect tarball contents and ensure no real user config/state is touched.
### Anti-shortcut coverage
The packed-consumer test runs outside the checkout with checkout paths and sender home unavailable; copying the example must be enough to execute. A description/schema edit must be visible to the model, and a skill-body sentinel must appear only after `load_skill`, so documentation-only examples cannot pass.
### Implementation obligations
Build/copy the executable examples from bundled plugin sources, include agent assets in `npm pack`, keep installed CLI and config-relative runtime resolution independent of checkout, and update all user-facing docs/help together.
### Acceptance criteria
- [ ] AC-7.1: Packed consumer copies/edits and executes a bundled-tool fork without checkout imports while preserving semantic preflight validation of malformed later batch entries — proven by package test.
- [ ] AC-7.2: Installed CLI/ACP select exact profile tools, enforce matching-only Bash ask, and resume unchanged/changed generations — proven by package and session integration tests.
- [ ] AC-7.3: Documentation and help match the implemented manifest/profile/policy/skill schema — proven by inspection and fixture-based examples.
- [ ] AC-7.4: A copied agent directory works at two unrelated paths with its own prompt, tool, skill list/load, and no sender-home references — proven by packed-consumer tests.
### Focused verification
`npm run test:package`
### Phase gates
`npm run check && npm run test:overhead && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`docs: ship forkable tool plugins and validate packaged workflow`

## Completion Criteria
- All seven phases meet their checked acceptance criteria, pass their focused/full gates, receive APPROVE implementation reviews, and are committed in order. Final macOS/Linux Node 22.13.0/24 CI passes.
- The generated starter profile explicitly selects the same three default tools; every other profile initially exposes only its chosen bundled/global/config-local/MCP IDs and optional inline/file system prompt. An unselected user module cannot execute; negotiated ACP configure can later activate a cataloged MCP tool explicitly.
- A skill-bearing profile explicitly selects both bundled skill tools. The first provider request contains no skill catalog or Markdown; `list_skills` and `load_skill` reveal only selected entries through durable linked tail results. Resume and compaction preserve or explicitly request reload of loaded skills.
- The agreed Bash rule asks for matching `rm` command strings and leaves nonmatching Bash calls automatic. Invalid policy fails early.
- MCP remains fully usable through the new profile selection contract, and existing provider/ACP/CLI/REPL/compaction behavior passes its regression suites; only explicitly listed config/API and old-dev-session compatibility is removed.
- Unchanged prompt/profile/plugin/skill state preserves exact provider prefix and generated session key through resume; a changed selected tool rotates that generated key, while an explicit OpenAI key retains its wire precedence and a skill-only change preserves both keys while appending any needed reload notice. Neither transition replays side effects.
- Plugin folders and a complete copyable agent directory work from the npm package without modifying the user's global config on install. Old dev config/session formats are not supported or migrated. Registry-based sharing, dependency installation, and untrusted-plugin isolation remain separate future work.

## Progress Log
- 2026-09-25: Phase 2 complete; Phase 3 `in_progress`; phases 4-7 not started. Docs-first RED was missing `loadToolPlugins`; GREEN focused suite passed 8/8, `npm run check` passed 288/288, installed package test passed 1/1, and `git diff --check` passed. Self-review APPROVE: selected manifests/schema/collisions are checked before handler imports; global and config-local roots are separate; symlink escape, remote/async schema, optional semantic validation, nested arguments, approval ordering, abort, typed image, and result cap have regression coverage. The installed library resolves its package-owned bundled root. A parity repair put `view_image`'s old argument errors in its plugin entry.
- 2026-09-25: Implementation authorized at clean `3681c12`, CTXE Ready/fresh. Phase 1 complete, followed by Phase 2. Phase 1 docs-first RED was missing bundled loader; GREEN focused tests passed 12/12. `npm run check` passed 282/282, `npm run test:overhead` passed, `npm run test:package` passed 1/1 against an installed package, and `git diff --check` passed. Self-review APPROVE: manifests and standalone ESM handlers are packaged, pre-refactor definition hash is fixed, batch semantic validation precedes approval/side effects, and the old caller path remains live until Phase 3.
- 2026-09-25: Planning only. Baseline committed clean at `8c2e40d`; CTXE readiness was Ready/fresh, relevant runtime/config/session/package paths and tests inspected. User clarified that the project is unpublished development software, so the plan explicitly drops old config/API/session compatibility and migration. No application code changed for this plan.
- 2026-09-25: Earlier intent and structure self-review covered six phase blocks and 19 binary acceptance criteria; later user requirements superseded that review. Implementation still awaits approval of the amended plan.
- 2026-09-25: Clarified non-regression requirement for MCP transports/content and other runtime subsystems; added an explicit MCP/ACP acceptance criterion. Config syntax and pre-refactor dev sessions remain intentionally breaking.
- 2026-09-25: User added inline/file/run-time system prompts, on-demand selected skills, bundled `list_skills`/`load_skill`, and transferable local agent directories. Re-anchored config, agent, compaction, and session-store flows via CTXE; amended seven phases and 25 acceptance criteria without implementing application code.
- 2026-09-25: Intent-fidelity and structural self-review complete: seven numbered phases, all 16 required subheadings in order per phase, 25 sequential phase-owned acceptance criteria, existing MCP/ACP regression gates, and skill-only cache-prefix behavior checked. Plan Review set to APPROVE; implementation awaits approval of this amended plan.
- 2026-09-25: External `gpt-6-astra` codex-plan-review round 1 returned REVISE with five findings: semantic plugin validation, recovery-before-notice ordering, explicit cache-key precedence, ACP catalog activation, and ACP policy spelling. The amended plan preserves existing explicit cache override and negotiated ACP configure behavior while correcting its earlier overbroad promises; re-review pending.
- 2026-09-25: Round 2 confirmed all five findings resolved but used an unparseable short verdict. Round 3 rechecked the saved plan and returned runner-parsed APPROVE with no new blockers. Review session: `.codex-review/sessions/codex-plan-review-20260925-002`.
