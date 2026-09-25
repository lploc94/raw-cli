# Rename Raw profiles to agents and ship built-in setup skills

## Plan schema
loop-plan/v1

## Target
Make **agent** the single Raw concept for a named configuration that chooses a model, system prompt, tools, skills, MCP tools, rules, and run settings. A model is an upstream connection/capability; a session is one saved conversation with an agent. In the same change, replace the two temporary personal skills with five complete package-owned skills (`configure_raw`, `create_skill`, `create_tool`, `create_agent`, `add_mcp`) and make the freshly initialized default agent `raw` able to use them for setup.

## Scope
- Rename Raw-owned config/CLI/environment/library/session/ACP-extension contracts: root `profiles` → `agents`, `default_profile` → `default_agent`, `--profile` → `--agent`, `RAW_PROFILE` → `RAW_AGENT`, session `profileName`/`profile_name` → `agentName`/`agent_name`, and `_raw/runtime/info.profile` → `agent`. Rename internal agent-spec symbols and the misleading resolved-provider type/property, while keeping models and standard ACP protocol terms distinct.
- This is a breaking pre-publication refactor: reject old config keys/flags/environment names and old session DB schema, with no alias, reader, or migration. User explicitly authorized clearing all saved test sessions. Rewrite this machine's existing config once, preserving model/MCP/credential/prompt values; clear only Raw's disposable session state after checking for active owners.
- Add explicit package-owned `builtin/<id>` skill selection alongside `local/<id>` and `agent/<id>`. Ship readable manifests and substantial Markdown for five skills, generated installed/forkable assets, and a setup-capable starter agent from `raw config init`.
- Update current README/help/docs/examples/tests for the agent vocabulary. Preserve historical plan files and `docs/evidence/*` as records of earlier work; they may retain historical `profile` wording. No registry, remote sharing, dependency installer, new MCP transport, automatic user-config rewrite at npm install, or backward compatibility.

## Invariants
- `models.<alias>` describes upstream provider/method/model ID/endpoint/credentials/capabilities. `agents.<name>` chooses one model and owns the prompt, ordered `tools.use`, `skills.use`, policy, request/cache/compact limits. `--agent <name>` selects an agent explicitly; without it, `default_agent` selects the agent. Fresh init sets `default_agent` to `raw`, while an existing config may choose another default. A session binds its agent name, config path, model identity, prompt and context generation.
- Raw's new public contract uses **agent** consistently. Standard ACP names such as `agentInfo`, `session/new`, `session/resume`, and `session/prompt` retain their protocol spelling. The Raw-specific `_raw/runtime/info` payload may change because it is owned by Raw.
- Only explicitly selected tools/skills enter an agent. An installed but unselected skill is not read; catalog and Markdown are absent from the initial provider request and appear only in linked `list_skills`/`load_skill` results. MCP server definitions remain inert until an exact `mcp/server/tool` ID is selected or ACP explicitly configures a cataloged tool.
- `builtin/` skill paths resolve from the installed package independently of checkout, cwd, alternate config, XDG home, and sender home. Local/agent path, UTF-8, strict manifest, duplicate-name, containment and byte-limit guarantees remain. Each shipped body and catalog fits the default 8192-byte result cap without truncation.
- `config init` remains explicit, once-only and mode 0600; `npm install`/`npm pack` do not write the user's config or state. Its starter agent retains the three core read/write/Bash tools, adds the two skill tools and five selected skills, and does not select `view_image` for a text model.
- Unchanged agent configuration/resume retains the ordered provider prefix and generated cache key. Selected tool changes rotate the generated key; selected skill-only changes keep it and add a durable reload notice when necessary. Changed prompt/model/endpoint remains a resume error. Renaming the DB column requires a clean new schema, not a migration.

## Baseline
- Clean repository at `8a36fa1` (`plan: ship built-in Raw setup skills`); CTXE Ready/fresh. The prior plan contains the five-skill design but not the new agent rename. Previous local gates passed 315/315 tests and 2/2 packed-consumer tests.
- `src/config.ts:17-65,183,235,465-625,677-735` owns `RawFlags.profile`, `ProfileSpec`, `ProviderProfile`, `profiles/default_profile`, `RAW_PROFILE`, runtime `.profile`, and `--profile`. `bin/raw.ts:25-110,141-175` owns help, config init/list, session display/resume. `src/llm/types.ts:5-36,89` exposes `ProfileRequestOptions`, `ProviderProfile`, `ProviderAdapter.profile`; `src/llm/*` uses those provider settings.
- `src/sessions/schema.ts:40` persists `profile_name` in schema 3. `src/sessions/store.ts:25-75,176,323-387,747-751` and CLI/ACP resume bind `profileName`. `src/acp/methods.ts:198-235,355-365` uses it and returns a Raw-specific `profile` field; standard ACP method names are separate.
- `src/skills/loader.ts:63-99` loads only selected local/agent folders; `src/config.ts:327-345` rejects `builtin/` skill IDs and requires both skill tools for nonempty `skills.use`. `src/tools/plugins/loader.ts:28-45` resolves package-owned tools. `package.json` ships `dist`, tool/agent examples and README. `tests/skill-tools.test.ts`, `tests/foundation-cli.test.ts`, `tests/package.test.ts`, and `tests/package-agent.test.ts` provide the existing boundary patterns.
- On this machine, both `local` and `deepseek` currently select `local/repo_map` and `local/verify_change`; DeepSeek uses `prompts/deepseek.md`. All saved sessions are disposable test data. The config contains model/MCP/credential settings that must remain intact when manually rewritten.

## Design and project patterns
- The canonical public mapping is `profiles`/`default_profile`/`--profile`/`RAW_PROFILE`/`profileName`/`profile_name` → `agents`/`default_agent`/`--agent`/`RAW_AGENT`/`agentName`/`agent_name`. `raw config list`, `raw sessions`, help, examples and current docs use the new terms. Old forms fail clearly; they are not silently interpreted.
- Use `AgentSpec`/`agentSpec` for parsed agent settings. Rename the provider-only `ProviderProfile` to `ResolvedModelConfig`, `ProfileRequestOptions` to `ModelRequestOptions`, and `ProviderAdapter.profile` to `modelConfig` rather than pretending provider access settings are a complete agent. `RuntimeConfig` exposes `agentName` and `modelConfig` plus its existing effective prompt/tool/skill/limit fields; `resolveCompactProfile` becomes `resolveCompactModelConfig`. Rename Raw-owned exported types and callers together, with no compatibility exports. `AgentSession` and `createAgent` already name runtime sessions correctly and remain.
- The new session schema is version 4 with `agent_name` and no `profile_name`; update store identity, list/resume APIs, display history and ACP session checks. Tests construct fresh v4 DBs, reject v3, and prove no replay or cache/skill-generation regression. After the rename passes gates, manually rewrite this machine's config to the new root keys and clear its Raw session DB/payload test state; no runtime migration code.
- Mirror the installed bundled-tool root for skills. Extract/reuse package-root resolution; source assets live in `src/skills/bundled/<id>/`, with one build-copy step producing `dist/skills/builtin/<id>/` and `examples/skills/<id>/`. Keep `skill.json` fields (`api_version`, `id`, `version`, `name`, `description`) and `SKILL.md` contract unchanged. All roots share selected-only strict validation.
- The five IDs/names are `builtin/configure_raw`, `builtin/create_skill`, `builtin/create_tool`, `builtin/create_agent`, `builtin/add_mcp`. Their descriptions distinguish when each applies. `configure_raw` explains exact JSON field types, constraints, provider/method request/cache options, paths/precedence, and a task-to-field map. The four creation skills are self-contained procedures with working examples and registration/verification steps. No new runtime tool is needed; existing read/write/Bash handlers create files.
- `config init` names the starter agent `raw` and writes `default_agent: "raw"`/`agents.raw`, an inline editable system prompt, five selected built-in skill IDs, and read/write/Bash/list/load tools. It keeps the upstream model alias `local` distinct from the agent name. The prompt retains general coding-assistant behavior and routes Raw setup/customization requests through a list call and only relevant loads; unrelated tasks proceed normally. Existing config files are never rewritten by `config init` or installation.

## Global Gates
Every phase runs focused verification plus `npm run check && npm run test:package && git diff --check`; the final starter phase also runs `npm run test:overhead`. Packed-consumer tests use isolated XDG config/state and execute outside the checkout. Record an APPROVE implementation review before each commit. Final local qualification should repeat full gates with Node 22.13.0 and Node 24 where available. This checkout has no Git remote, so do not claim GitHub macOS/Linux CI passed without an actual run.

## Plan Review
APPROVE — intent and structure self-review complete. The rename is full across Raw-owned config/CLI/runtime/provider/session/ACP-extension contracts, while standard ACP spelling and distinct model/agent/session semantics remain. Four phases, 15 binary criteria, exact gates, clean-v4/no-migration behavior, installed skill proofs and the user-authorized test-session clear are all covered. No application code has changed.

## Phase 1: Rename the agent contract across config, runtime, sessions and ACP
### Status
complete
### Goal
Make agent the only current Raw-owned name for a named runnable configuration, end to end, before publishing new skill instructions.
### Current behavior and gap
Public config and flags say profile even though the selected object already defines an agent. Internal provider settings are also called profile, and session/ACP resume persists or returns that name. A partial rename would leave two incompatible contracts.
### Evidence
`src/config.ts:17-65,183,235,465-625,677-735`; `src/llm/types.ts:5-36,89`; `src/llm/{client,cache,openai,responses,anthropic,google}.ts`; `bin/raw.ts:25-110,141-175`; `src/sessions/{schema,store,api}.ts`; `src/acp/methods.ts:198-235,355-365`; `tests/fixtures/config.ts`; `docs/{configuration,cli,acp,providers}.md`.
### Pattern
One coherent breaking rename of Raw-owned contracts, retaining separate model/agent/session semantics and standard ACP spelling. Adapt fixtures and all current integration tests in the same phase; historical plans/evidence stay historical.
### Dependencies
None.
### Files and symbols
`src/config.ts` (`RawFlags`, `AgentSpec`, `loadConfig`, `parseCliArgs`, `RuntimeConfig`), `src/llm/types.ts` (`ResolvedModelConfig`, `ModelRequestOptions`, `ProviderAdapter`), `src/llm/*`, `src/agent.ts`, `src/cli.ts`, `bin/raw.ts`, `src/sessions/{schema,store,api}.ts`, `src/acp/{methods,client}.ts`, `src/index.ts`, current `docs/*`, `README.md`, `examples/agents/*/raw.json`, `tests/**/*.ts`, `scripts/test.mjs` if a test file is renamed.
### Behavioral contract
The new parser accepts `agents`, `default_agent`, `--agent`, and `RAW_AGENT` only. It rejects old config keys/flag/env spelling, resolves the same model and agent-owned settings, and keeps prompt/flag/environment precedence except for the renamed selector. `raw --agent raw "query"` selects `agents.raw`, `raw --agent deepseek "query"` selects `agents.deepseek`, and `raw "query"` selects the configured `default_agent`. CLI and ACP create/list/resume sessions by `agentName` and current agent identity; Raw `_raw/runtime/info` reports `agent`, while standard ACP requests/notifications remain unchanged. Fresh session storage is schema 4; v3 is rejected without migration. Provider adapters retain the same request bytes, cache controls, tool behavior and usage accounting after the type/property rename.
### Documentation
Update the current config/CLI/provider/MCP/skill/tool/ACP/context/architecture docs, README, help and copyable agent example to agent terminology and new JSON/flag/env forms. Mark old `--profile`/`profiles` as unsupported; do not rewrite archived plans or evidence.
### Tests first
RED: current parser rejects `agents`/`--agent` and session schema lacks `agent_name`. GREEN: test all new selection precedence, including explicit `raw`/`deepseek` names and `default_agent` fallback, and rejection of old names; compare provider wire requests and ordered tool schema before/after fixture rename; assert `raw config init/list`, `raw sessions`, CLI resume, library API and Raw ACP extension show `agent`, while ACP standard protocol still works. Test new v4 store creation, v3 refusal, pending-call recovery, no-op and changed tool/skill generation, and prompt mismatch. Use isolated XDG state. After gates, back up and manually rewrite this machine's config: rename `profiles.local` to `agents.raw` and `profiles.deepseek` to `agents.deepseek`, retain `models.local` and the existing effective default `deepseek`, then clear only Raw's disposable session DB/sidecars/payloads after confirming no live owner; check a fresh v4 DB and `raw config list`.
### Anti-shortcut coverage
A search-and-replace that leaves `ProviderAdapter.profile`, `RuntimeConfig.profile`, `profileName`, or `_raw/runtime/info.profile` fails API tests. A parser alias or DB migration fails negative tests. A successful CLI smoke test alone cannot replace provider/ACP/resume regressions. Do not delete unrelated state outside Raw's session scope.
### Implementation obligations
Rename the owned API/type/config/session/extension surfaces, bump schema cleanly, update fixtures/current docs, and remove old public spellings with explicit errors. Adapt the machine's config manually only after code gates; no install-time migration or compatibility layer.
### Acceptance criteria
- [x] AC-1.1: New `agents`/`default_agent`/`--agent`/`RAW_AGENT` contract works with the same effective model/prompt/tools/settings; all old spelling is rejected — proven by config/CLI tests.
- [x] AC-1.2: Public Raw library, session history, CLI and Raw ACP extension use `agentName`/`agent` while standard ACP remains wire-compatible — proven by type, CLI, API and ACP tests.
- [x] AC-1.3: Fresh v4 sessions resume with unchanged/changed tool and skill generations and no call replay; v3 has no reader/migration — proven by session/ACP/process tests.
- [x] AC-1.4: This machine's config is backed up and rewritten with `agents.raw`/`agents.deepseek`, preserving `models.local`, the current default selection `deepseek`, and model/MCP/credential/prompt values; disposable session state is cleared to fresh v4 — proven by sanitized structural comparison and local CLI check.
### Focused verification
`npm run build && node --import tsx --test tests/config.test.ts tests/config-v2.test.ts tests/config-mcp-policy.test.ts tests/foundation-cli.test.ts tests/session-agent.test.ts tests/session-acp.test.ts tests/acp.test.ts tests/package.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
APPROVE — self-reviewed owned API, ACP and persistence diff against the rename mapping and exclusions; old spellings remain only in explicit rejection tests, the rejected environment variable, and historical records. Focused suite 80/80, full check 318/318, package 2/2, and sanitized personal-config/state checks passed.
### Commit
`refactor: rename Raw profiles to agents`

## Phase 2: Add packaged built-in skills and the full config skill
### Goal
Establish the installed `builtin/` skill namespace and ship a complete, usable `configure_raw` reference using the new agent vocabulary.
### Current behavior and gap
Skill selection only accepts local/agent folders. A new installation cannot select a package-owned skill, and no skill teaches the strict current config schema.
### Evidence
`src/config.ts` (`skillSpec` after Phase 1); `src/skills/loader.ts:1-102`; `src/tools/plugins/loader.ts:28-45`; `src/tools/plugins/runtime.ts:23-31`; `package.json`; `docs/configuration.md`; `tests/skill-tools.test.ts`.
### Pattern
Reuse the bundled-tool package root and the existing strict skill parser; copy one source asset into installed and forkable destinations during build. Never inject an implicit catalog.
### Dependencies
Phase 1.
### Files and symbols
`src/config.ts` (`skillSpec`), `src/skills/loader.ts` (`loadSelectedSkills`), shared package-root helper if needed, `src/tools/plugins/loader.ts`, new `src/skills/bundled/configure_raw/{skill.json,SKILL.md}`, build-copy script, `package.json`, `docs/skills.md`, `docs/configuration.md`, new `tests/bundled-skills.test.ts`, `tests/skill-tools.test.ts`.
### Behavioral contract
`builtin/configure_raw` loads from the installed package only when selected. It shares strict manifest/containment/duplicate/UTF-8/output-cap checks with other skill roots. Its body explains root/model/agent fields with JSON types and constraints, provider/method request/cache variants, prompt and selector precedence, context/compact limits, ordered tool/skill/MCP IDs, rules including conditional Bash `rm`, sessions, exact task-to-field edits, safe validation of a copy and resume effects. It fits the default 8192-byte result cap and returns without truncation.
### Documentation
Explain installed/forkable built-in skill paths and selecting a separately named local or agent fork. Remove the claim that skill IDs have only local/agent scopes.
### Tests first
RED: `builtin/configure_raw` is invalid and absent from packed assets. GREEN: load it from a packed consumer in another cwd/XDG home, dispatch linked list/load results, and prove no first-request catalog/body; validate its concrete config examples with `loadConfig` and check schema coverage against the validator. In a temporary installed copy, test invalid selected bundled asset, invalid unselected asset, symlink escape, duplicate name and output caps; keep existing local/agent tests green.
### Anti-shortcut coverage
Source file existence or keyword assertions are insufficient: the installed asset must load outside the checkout and return exact Markdown through `load_skill`. A short checklist without typed fields, examples and mutation guide fails content review. No parser fork or install-time user-config writes.
### Implementation obligations
Add `builtin/` ID/root support, source-derived build/package copies in `dist/skills/builtin` and `examples/skills`, the detailed config skill, and aligned docs. Preserve explicit selection and existing loader limits.
### Acceptance criteria
- [ ] AC-2.1: Installed `builtin/configure_raw` loads only after selection through linked list/load results, independent of checkout/cwd/XDG/config location — proven by packed-consumer test.
- [ ] AC-2.2: Built-in/local/agent selection shares strict manifest, containment, duplicate and byte-cap behavior; unselected invalid assets remain inert — proven by loader tests.
- [ ] AC-2.3: The config skill has the actual typed schema, constraints, task-to-field guide, runnable examples and validation/resume instructions within the default cap — proven by fixture execution and code-grounded review.
### Focused verification
`npm run build && node --import tsx --test tests/bundled-skills.test.ts tests/skill-tools.test.ts tests/config.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: load packaged Raw skills and ship config reference`

## Phase 3: Author the four creation and integration skills
### Goal
Complete the five-skill kit with real procedures for creating skills, tools, agent profiles and MCP selections.
### Current behavior and gap
The package has tool and portable-agent examples, but no on-demand instructions that let an installed Raw agent create and register these assets for a user's agent configuration.
### Evidence
`docs/{skills,tools,configuration,mcp}.md`; `examples/tools/*`; `examples/agents/project-helper/*`; `src/tools/plugins/contract.ts`; `src/tools/registry.ts`; `src/tools/mcp-client.ts`; `tests/package-agent.test.ts`.
### Pattern
Write self-contained Markdown procedures from the current validators and executable examples. Each procedure names the exact file and `agents.<name>`/`mcp.servers` field to edit, ends in validation, and stays under the default result cap.
### Dependencies
Phases 1-2.
### Files and symbols
New `src/skills/bundled/{create_skill,create_tool,create_agent,add_mcp}/{skill.json,SKILL.md}`, generated `dist/skills/builtin/*` and `examples/skills/*`, build-copy script, `docs/{skills,tools,configuration,mcp}.md`, `tests/bundled-skills.test.ts`, `tests/package-agent.test.ts`.
### Behavioral contract
`create_skill` covers local/agent folders, manifest/body types and paths, size/name/version rules, `agents.<name>.skills.use`, required skill tools, on-demand exposure and a list/load verification. `create_tool` covers manifest/object JSON Schema, standalone ESM handler/result/context, synchronous semantic validator and whole-batch preflight, `agents.<name>.tools.use`, rule interaction, full OS permissions and a runnable fork. `create_agent` defines agent = one named entry under `agents`, with a portable `raw.json`/prompt/tools/skills directory, model/credentials, exact ordered bundled/local/agent/MCP IDs, rules, `default_agent`, copying and resume/cache behavior. `add_mcp` covers stdio/streamable-http server object types, credential placement, exact tool discovery/selection, inert servers, policy and ACP configure, with a local fixture example. No obsolete `profiles`, `--profile`, `profile.mcp` or wildcard MCP selection appears as current syntax.
### Documentation
Index all five skills and how to fork them; reconcile the existing tool/agent examples and current docs with their procedures.
### Tests first
RED: four IDs/assets absent. GREEN: installed catalog lists five distinct descriptions in order; exact Markdown loads only after a linked call. Execute documented create-skill example under both roots, create-tool example with a valid call and malformed later batch row rejected before side effects, portable agent directory under unrelated paths, and MCP example against a fixture copied/generated inside a temporary consumer with exact selected tool names. Include negative checks for missing skill tools, unselected code, nonportable paths and inactive MCP definitions.
### Anti-shortcut coverage
File-existence/keyword tests alone fail. Each document must produce a runnable artifact with an observable registration and a meaningful negative case. The examples must work from the installed package without checkout imports or sender-home references.
### Implementation obligations
Author four substantial, typed, stepwise skill bodies/manifests, keep full results under the cap, generate/package forkable copies, align current docs/examples and avoid adding a new creation tool or registry.
### Acceptance criteria
- [ ] AC-3.1: Five manifest descriptions distinguish tasks, and five complete bodies are available only via explicit linked list/load calls — proven by runtime and packed tests.
- [ ] AC-3.2: Create-skill and create-tool instructions yield selected loadable/executable assets, with malformed later batch input preflighted before side effects — proven by fixture-driven tests.
- [ ] AC-3.3: Create-agent and add-MCP instructions yield a portable agent config and an exact selected MCP tool, with inactive sources inert — proven by installed-consumer tests.
- [ ] AC-3.4: Each body is a detailed, agent-vocabulary, code-accurate procedure with typed schemas, concrete edits, verification and failure handling — proven by code-grounded content review and runnable examples.
### Focused verification
`npm run build && node --import tsx --test tests/bundled-skills.test.ts tests/skill-tools.test.ts tests/package-agent.test.ts tests/mcp.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`docs: ship complete Raw agent customization skills`

## Phase 4: Initialize and qualify the setup-capable default agent
### Goal
Give a new installation a setup-capable `raw` agent after `raw config init`, then select the five packaged skills on this machine in place of its two temporary examples.
### Current behavior and gap
The renamed `config init` still creates a three-tool agent without skill tools, selected skills or skill-routing prompt. This machine still selects its two local test skills.
### Evidence
`bin/raw.ts:63-80`; `src/llm/prompt.ts`; `tests/foundation-cli.test.ts:27-43`; `tests/package.test.ts`; `tests/package-agent.test.ts`; `docs/cli.md`; `README.md`; sanitized personal selection in Baseline.
### Pattern
Extend the once-only starter agent JSON. Name it `raw`, retain the `local` upstream model alias and its placeholder model ID, and add an inline editable prompt, the skill tools, and five ordered built-in skill IDs. Existing configs remain untouched by `config init` and npm install. Explicitly qualify personal state only after product gates pass.
### Dependencies
Phases 1-3.
### Files and symbols
`bin/raw.ts` (starter/help), optional shared starter-prompt constant, `tests/foundation-cli.test.ts`, `tests/package.test.ts`, `tests/package-agent.test.ts`, `README.md`, `docs/{configuration,skills,cli}.md`; after code gates, `~/.config/raw/config.json` and archived `~/.config/raw/skills/{repo_map,verify_change}` outside the repo.
### Behavioral contract
Fresh config has `default_agent: "raw"` and `agents.raw` selecting `models.local`, with read/write/Bash/list/load tools, five `builtin/` skill IDs, and a concise prompt that retains general coding behavior, lists selected skills for Raw setup/customization tasks, loads only relevant instructions, and lets unrelated tasks proceed. `raw "query"` therefore selects `raw` on fresh init; in this machine's existing config it continues to select the configured `deepseek` default. First request has generic skill tool schemas but no catalog/body; linked results reveal selected data later. `config init` refuses overwrite and npm installation never writes config/state. On this machine, preserve both agents' model/MCP/request/compact/credential fields and existing DeepSeek prompt file while switching skill selection; the two example folders are archived rather than deleted. No old session data is restored after the authorized Phase 1 clear.
### Documentation
Update README/help/current docs with `raw --agent`, the starter agent, five skill IDs, installed/forkable paths, prompt overrides, setup task examples and session behavior.
### Tests first
RED: starter lacks skill tools/selection/prompt. GREEN: installed binary `config init` in isolated XDG home creates mode-0600 agent config; change only temporary model ID/endpoint to a mock provider, prove first request hides catalog/body and later linked list/load results expose a selected skill. Verify second init leaves config bytes unchanged, install creates no user config/state, unchanged/changed skill generations resume correctly, and packed package has all five full bodies. After automated gates, back up this machine's config, replace two selected local IDs with five builtin IDs, archive old folders, and directly validate list/load using the installed `raw` binary without provider traffic.
### Anti-shortcut coverage
Hardcoding skill names in the system prompt or only testing the source loader fails. The installed binary must create valid agent config and reveal package skills only through linked tool results. Do not overwrite live config, print credentials, or revive old session schema.
### Implementation obligations
Add starter selection/prompt, update help/docs, qualify packed CLI plus local Node 22/24 runtimes, then perform backed-up personal skill replacement. Keep `raw` as the starter agent name and `local` as its model alias; no new agent registry, migration, or install hook.
### Acceptance criteria
- [ ] AC-4.1: Fresh `raw config init` produces a setup-capable `raw` agent with `default_agent: "raw"`, five selected built-in skills and both skill tools, refuses overwrite and preserves mode 0600 — proven by CLI/packed tests.
- [ ] AC-4.2: Installed initial provider request has no skill catalog/body; linked list/load exposes only the selected five and exact chosen body outside the checkout — proven by mock-provider packed test.
- [ ] AC-4.3: Install/init refusal leaves user config untouched; this machine's two agents select the five package skills after backup without changing other fields, and old examples are archived — proven by sanitized structural comparison and installed CLI validation.
- [ ] AC-4.4: Current docs/help/examples contain the new agent contract and full skill kit; full gates pass under supported local Node runtimes — proven by inspection and commands below.
### Focused verification
`npm run build && node --import tsx --test tests/foundation-cli.test.ts tests/bundled-skills.test.ts tests/package.test.ts tests/package-agent.test.ts`
### Phase gates
`npm run check && npm run test:overhead && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: initialize Raw with packaged setup agent skills`

## Completion Criteria
- All four phases have checked acceptance criteria, focused/full gates, APPROVE reviews and commits. The five shipped bodies are detailed, accurate, under the default result cap, loadable from the installed package and absent from the first provider request.
- New users get a setup-capable default `raw` agent after `raw config init`; an omitted `--agent` uses the configured `default_agent`, including an alternate choice in an existing config. Existing configs and npm installation remain untouched by init/install. Model, agent and session have distinct names and responsibilities across config, CLI, public types, Raw ACP extension and fresh v4 storage, with no compatibility parser or migration.
- This machine's config uses `agents`/`default_agent`, selects the five package skills for its two agents, retains model/MCP/credential/prompt settings, archives the two temporary local examples and has fresh v4 session state. The stored test conversations were cleared as the user authorized.
- Installed examples actually create a skill, tool, portable agent and exact MCP selection outside the checkout; provider/MCP/ACP/session regressions remain green. Historical plans/evidence remain historical.

## Progress Log
- 2026-09-25: Phase 1 complete. Added red agent-contract/schema tests, renamed config/CLI/provider/session/ACP surfaces, rejected v3, and updated current docs. Focused 80/80, full check 318/318, package 2/2 passed; implementation self-review APPROVE. Backed up personal config, renamed its local agent to raw while retaining DeepSeek as default, verified preserved model/MCP/prompt/credential settings, cleared two v3 test sessions and the older v2 test archive after zero active-owner/process checks, and created an empty v4 store.
- 2026-09-25: Plan self-review APPROVE: checked rename mapping, current source paths and tests, model/provider distinction, standard ACP boundary, schema-v4 reset without migration, 4 ordered phases/15 criteria, package-independent skill examples, and personal config preservation. Clarified fresh-init `raw` default, configurable selection without `--agent`, and this machine's preserved `deepseek` default. Implementation awaits approval of the amended plan.
- 2026-09-25: User added a breaking `profile` → `agent` concept rename and explicitly authorized clearing saved test sessions; no migration/backward compatibility. CTXE Ready/fresh routed config/CLI/runtime/provider/session/ACP surfaces. The former three-phase plan at `8a36fa1` was amended into four phases with the rename first. No application code or personal config/state changed in this planning turn.
