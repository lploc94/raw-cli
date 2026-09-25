# Ship built-in Raw setup skills and a setup-capable starter agent

## Plan schema
loop-plan/v1

## Target
Replace the two temporary personal skills used for testing with five real, detailed Raw skills that ship in the npm package: configure Raw, create a skill, create a tool, create an agent profile, and add an MCP server. A fresh `raw config init` must create a useful starter agent that can discover and load these skills on demand. The current machine's `local` and `deepseek` profiles must select the shipped skills for testing without changing their models or credentials.

## Scope
- Add explicit `builtin/<id>` skill selection alongside existing `local/<id>` and `agent/<id>` sources. Package readable `skill.json` and `SKILL.md` assets for `configure_raw`, `create_skill`, `create_tool`, `create_agent`, and `add_mcp`; provide forkable copies in `examples/skills/` from the same source assets.
- Give each skill actionable instructions, field types, valid JSON/ESM examples, exact file locations, validation steps, and common failure cases. The config skill is the full Raw config reference and task-to-field guide. The other four are self-contained for their named workflows and point to `configure_raw` only when a broader config decision is needed.
- Make `raw config init` select the five skills and both skill tools in its default `local` profile, with a concise setup-routing `system_prompt`. Keep the default three file/Bash tools; `view_image` remains opt-in for a vision-capable model.
- Document installed paths, skill forking, the starter agent, profile composition, and the no-automatic-install-writes boundary. After package qualification, explicitly update this machine's two profiles to the five `builtin/` IDs, back up its current config, and archive the two temporary local skill folders. Preserve all model/MCP/credential settings and the existing DeepSeek prompt file.
- No registry, remote sharing service, dependency installer, new MCP transport, config migration, or automatic rewrite of an existing user config. Do not change the session DB schema. Existing live sessions follow the current skill-generation reload-notice behavior.

## Invariants
- A profile controls exactly which skills and tools are visible. An installed but unselected skill is not read; skill names/descriptions and Markdown remain absent from the first provider request and appear only in linked `list_skills`/`load_skill` results.
- `builtin/` skill assets resolve from the installed package, independent of checkout, cwd, `--config`, XDG home, and the sender's home. `local/` and `agent/` retain their current roots and strict manifest/path/UTF-8/size checks. Duplicate IDs or model-facing names fail before inference.
- Each bundled `SKILL.md` fits the default 8192-byte model-facing result cap and the selected catalog fits that cap. Detailed content is concise rather than truncated. The package contains no credentials or absolute machine paths.
- `raw config init` remains explicit, once-only, mode 0600, and does not overwrite an existing config. `npm install`/`npm pack` must not write the user's config or state. Personal config changes happen only in the implementation's explicit local qualification step, after backup.
- Tool folders do not self-register: profiles select exact `builtin/`, `local/`, `agent/`, or `mcp/server/tool` IDs. An MCP server definition alone is inert. Conditional `ask` evaluates validated string arguments, and `-y` does not bypass it. New skill text must teach these contracts accurately.
- Changing selected skill bytes or IDs on resume advances the context revision; skill-only changes keep the generated cache key and append a durable reload notice if previously visible data is stale. Effective system-prompt changes still require a new session.

## Baseline
- Clean repository at `83a62bf` (`feat: show current context usage in CLI footer`); Node build, tests, and package tests last passed 315/315 and 2/2. CTXE status is Ready/fresh for `/Users/lploc94/projects/raw-cli`.
- `bin/raw.ts:63-80` writes one `local` profile with three tools and no skills or profile prompt. `src/config.ts:327-345,465-518` accepts only `local/` and `agent/` skill IDs and requires both bundled skill tools for nonempty `skills.use`.
- `src/skills/loader.ts:63-99` loads selected local/agent folders and enforces manifest, path, UTF-8, duplicate-name, and byte limits. `src/tools/plugins/loader.ts:28-45` resolves package-owned bundled tools by walking to `package.json`; `src/tools/plugins/runtime.ts:23-67` loads skills before tools/MCP. `src/sessions/store.ts:323-387` already tracks selected skill snapshots and reload notices.
- `package.json` ships `dist`, `examples/tools`, `examples/agents`, and README. `tests/foundation-cli.test.ts:27-43`, `tests/skill-tools.test.ts`, `tests/package.test.ts`, and `tests/package-agent.test.ts` provide starter, skill-boundary, and packed-consumer patterns. Current docs are `docs/configuration.md`, `docs/skills.md`, `docs/tools.md`, and `docs/mcp.md`.
- On this machine, both `local` and `deepseek` select `local/repo_map` and `local/verify_change`; both already select the skill tools. `deepseek` uses `prompts/deepseek.md`. These two local folders are test examples, not package assets.

## Design and project patterns
- Extend the existing explicit ID grammar and selected-only loader instead of injecting a global skill catalog. Extract or reuse the package-root resolution used by bundled tools; place source assets under `src/skills/bundled/<id>/`, copy them to `dist/skills/builtin/<id>/` and `examples/skills/<id>/` during build, and include the examples in `package.json` files. One source manifest/body owns both installed copies.
- Keep `skill.json` unchanged: exact fields `api_version: 1`, `id`, semver `version`, `name`, and nonempty `description`; keep Markdown in `SKILL.md`. The built-in root is package-owned and read only when a `builtin/<id>` is selected. Reuse the current strict parser, containment, deduplication, and output-cap checks.
- Use the existing profile shape as the agent definition: model alias, `system_prompt` or config-relative `system_prompt_file`, ordered `tools.use`, `skills.use`, optional `tools.rules`, request/cache/compact settings, and top-level `mcp.servers`. The generated `local` profile remains the starter name and embeds a short editable `system_prompt`; it instructs the agent to list skills for Raw setup/customization requests, load only matching skills, and otherwise proceed normally. CLI/env prompt overrides retain precedence.
- The five skill names/IDs are `configure_raw`, `create_skill`, `create_tool`, `create_agent`, and `add_mcp` under `builtin/`. Their manifest descriptions must let the model pick the right one from `list_skills` without reading every body. Skill documents use the exact current Raw schema rather than Codex's `SKILL.md` conventions.
- `configure_raw` covers root `default_profile`/`models`/`profiles`/`mcp`/canonical-only `sessions`, model required and optional fields with JSON types and constraints, profile fields and precedence, provider/method request/cache differences, context/compact limits, prompt modes, ordered tool/skill selection, rules including conditional Bash `rm`, MCP selection, and a task-to-field decision table. It teaches validating a copy before replacing a live config and preserving credentials.
- `create_skill` covers `local/` and `agent/` folders, manifest/Markdown contract, name/ID/version rules, size and UTF-8 limits, `skills.use`, required bundled list/load tools, on-demand exposure, a complete minimal example, and verification through a real linked list/load result.
- `create_tool` covers local/agent paths and IDs, `tool.json` field types and object JSON Schema, standalone `.mjs` `handler` result/context contract, optional synchronous `validateArgs` and whole-batch preflight, selected `tools.use`, policy interaction, package examples as fork templates, direct ESM execution and full OS permissions, with a runnable example and malformed-later-row check.
- `create_agent` defines agent = profile and gives a complete portable directory with `raw.json`, `prompt.md`, `tools/`, `skills/`; covers model/credentials, prompt precedence, ordered bundled/local/agent/MCP IDs, `skills.use`, `tools.rules`, `default_profile`, copying to another path, and how changed prompts/tools/skills affect resume and cache. It does not invent an additional agent registry.
- `add_mcp` covers `stdio` and `streamable-http` server objects, optional args/env or headers, recipient credentials, discovery of exact original tool names, explicit `mcp/server/tool` selection, inactive servers, schema/policy/ACP configure behavior, and a runnable local fixture example. No `*` profile selection or separate MCP config file.

## Global Gates
Every phase runs its listed focused verification, then `npm run check`, `npm run test:package`, and `git diff --check`; run `npm run test:overhead` for the final starter prompt/tool set. The packed consumer must run outside the checkout with isolated XDG config/state. Review each phase and record an APPROVE verdict before committing. Final qualification should run the same gates under local Node 22.13.0 and Node 24 when available; the checkout currently has no Git remote, so do not claim GitHub macOS/Linux CI passed without a remote run.

## Plan Review
APPROVE — intent and structure self-review complete. The plan ships exactly five substantial Raw-format skills, keeps `local` as the existing starter profile name, separates package-owned built-ins from explicit user-config edits, preserves MCP/ACP/session contracts, and tests examples through the installed binary. No implementation code has changed.

## Phase 1: Add packaged built-in skill selection and the Raw config reference skill
### Goal
Establish the installed `builtin/` skill namespace and ship the complete `configure_raw` skill as its first real asset.
### Current behavior and gap
Skill selection rejects `builtin/`; only global/config-adjacent folders work. No packaged skill content exists, so a new installation cannot self-explain its configuration.
### Evidence
`src/config.ts:327-345`; `src/skills/loader.ts:1-102`; `src/tools/plugins/loader.ts:28-45`; `src/tools/plugins/runtime.ts:23-31`; `package.json` build/files; `docs/configuration.md`; `tests/skill-tools.test.ts`.
### Pattern
Mirror the package-owned tool root while reusing the current strict skill parser. Copy one source asset into installed and forkable destinations during build; do not fork parser or manifest semantics.
### Dependencies
None.
### Files and symbols
`src/config.ts` (`skillSpec`), `src/skills/loader.ts` (`loadSelectedSkills`), shared package-root helper if needed, `src/tools/plugins/loader.ts` (`bundledToolsRoot`), new `src/skills/bundled/configure_raw/{skill.json,SKILL.md}`, new build-copy script, `package.json`, `docs/skills.md`, `docs/configuration.md`, new `tests/bundled-skills.test.ts`, `tests/skill-tools.test.ts`.
### Behavioral contract
`builtin/configure_raw` loads exactly the packaged manifest/body when selected, including from an installed tarball. Unselected bundled assets are not read; a missing/invalid selected asset, symlink escape, duplicate selected name, oversized Markdown/catalog, or malformed UTF-8 fails before inference. Local and agent skill paths still work unchanged. The config reference teaches the real schema with field types, constraints, precedence, concrete edits by user intent, validation, and restart/resume implications.
### Documentation
Explain built-in skill IDs, installed/forkable locations, how to override by selecting a separately named local fork, and the 8192-byte cap. Remove statements that skills have only local/agent scopes.
### Tests first
RED: config rejects `builtin/configure_raw` and the installed package lacks its asset. GREEN: load the selected bundled skill via `loadSelectedSkills` and `createRuntimeTools`; dispatch `list_skills` and `load_skill` and compare the full Markdown; verify no first-request catalog/body; verify exact package path independence from cwd/XDG/config path, local/agent coexistence, and selected-only malformed/unselected cases. Validate the skill's concrete config examples through `loadConfig`; inspect its table against the root/model/profile validators and provider request/cache matrix.
### Anti-shortcut coverage
A test that merely sees `SKILL.md` in the repo is insufficient: the installed tarball must load it outside the checkout and return it through a linked tool result. A placeholder or short checklist fails the required schema/mutation-example review. Modify an installed-copy bundled folder in a temporary consumer to prove an invalid selected built-in fails while an invalid unselected built-in stays inert; do not mutate the real package. Invalid local/agent selections keep their existing behavior.
### Implementation obligations
Add the exact ID grammar and package-owned root, copy assets during build and pack, preserve strict loader bounds, author the detailed config skill under the default output cap, and update the docs. Do not add implicit skill selection or an install hook that writes user config.
### Acceptance criteria
- [ ] AC-1.1: `builtin/configure_raw` loads from the installed package through list/load while its body is absent from the initial provider request — proven by runtime and packed-consumer tests.
- [ ] AC-1.2: Built-in, local, and agent skill selections share strict manifest, containment, duplicate, and byte-cap behavior; unselected invalid assets stay unread — proven by loader tests.
- [ ] AC-1.3: `configure_raw` states all current root/model/profile/config contracts with field types, constraints, task-to-field edits, runnable examples, and validation/resume guidance, within the default result cap — proven by example fixtures and code-grounded content review.
### Focused verification
`npm run build && node --import tsx --test tests/bundled-skills.test.ts tests/skill-tools.test.ts tests/config.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: load packaged Raw skills and ship config reference`

## Phase 2: Author the four creation and integration skills
### Goal
Complete the five-skill setup kit with usable procedures for skill, tool, agent-profile, and MCP creation.
### Current behavior and gap
The repo has tool examples and a portable agent example, but no on-demand instructions that can guide an installed Raw agent through creating and registering these assets for the user's own config.
### Evidence
`docs/skills.md`, `docs/tools.md`, `docs/configuration.md`, `docs/mcp.md`; `examples/tools/*`; `examples/agents/project-helper/*`; `src/tools/plugins/contract.ts`; `src/tools/registry.ts`; `src/tools/mcp-client.ts`; `tests/package-agent.test.ts`.
### Pattern
Write self-contained Markdown procedures from the verified schemas and examples. Every procedure ends with an explicit validation path and tells the agent exactly which profile array or MCP server map to edit; packaging stays source-derived as in Phase 1.
### Dependencies
Phase 1.
### Files and symbols
New `src/skills/bundled/{create_skill,create_tool,create_agent,add_mcp}/{skill.json,SKILL.md}`, generated `dist/skills/builtin/*` and `examples/skills/*`, build-copy script, `docs/skills.md`, `docs/tools.md`, `docs/configuration.md`, `docs/mcp.md`, `tests/bundled-skills.test.ts`, `tests/package-agent.test.ts`.
### Behavioral contract
Each of the four skill descriptions clearly distinguishes its trigger. Each loaded body is complete, under the default cap, and gives concrete file contents and ordered steps that work with the installed CLI. It states exact registration: `skills.use` plus list/load tools for a skill; `tools.use` for a tool; one profile plus prompt/tools/skills/rules/MCP for an agent; and `mcp.servers` plus exact `mcp/server/tool` IDs for MCP. It teaches meaningful failure and verification cases, including no unselected import, semantic preflight before side effects, no implicit skill injection, and inactive MCP definitions.
### Documentation
Provide a concise index of the five built-ins and where to fork them. Reconcile the existing portable-agent example and tool examples with the skill instructions; avoid contradictory JSON or obsolete `profile.mcp` syntax.
### Tests first
RED: four IDs/assets are absent. GREEN: verify installed list contains five distinct metadata entries in order and each `load_skill` returns its exact Markdown; run the create-skill example under local and agent roots, execute the create-tool example with valid and invalid later batch rows, copy/run the agent-directory example under unrelated paths, and connect the MCP example to a local MCP fixture copied or generated inside the temporary consumer with exact selected tool names, without importing the checkout at runtime. The fixture must exercise the config changes the documents prescribe, not just compare Markdown substrings.
### Anti-shortcut coverage
File-existence and keyword tests alone do not qualify a skill. Require a complete runnable artifact and a negative case for each workflow: missing skill tools, unselected tool code, invalid later batch row, nonportable agent path, and configured-but-unselected MCP server. Do not silently broaden available tools or copy third-party packages into an agent directory.
### Implementation obligations
Author the four detailed skills and manifests, keep the five catalog/body payloads within the cap, generate/package forkable examples from the same sources, and align documentation. Avoid a new runtime tool for skill creation; existing read/write/Bash tools perform the steps.
### Acceptance criteria
- [ ] AC-2.1: All five descriptions allow the model to choose by task and all five complete bodies load only by explicit name after a linked list result — proven by runtime and packed tests.
- [ ] AC-2.2: The create-skill and create-tool procedures yield loadable/executable selected assets, including a rejected malformed later batch row before side effects — proven by fixture-driven tests.
- [ ] AC-2.3: The create-agent and add-MCP procedures yield a portable profile directory and an exact selected MCP tool, with inactive sources remaining inert — proven by installed-consumer tests.
- [ ] AC-2.4: Each skill is a detailed, code-accurate procedure with typed schemas, concrete edits, verification, and failure handling, not a short checklist — proven by code-grounded content review and runnable examples.
### Focused verification
`npm run build && node --import tsx --test tests/bundled-skills.test.ts tests/skill-tools.test.ts tests/package-agent.test.ts tests/mcp.test.ts`
### Phase gates
`npm run check && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`docs: ship complete Raw customization skill kit`

## Phase 3: Make the starter profile a setup agent and qualify the installed workflow
### Goal
Make the five shipped skills immediately usable after explicit `raw config init`, and replace the two personal test skills on this machine with the packaged kit.
### Current behavior and gap
`config init` creates a three-tool coding profile without skill tools, selected skills, or skill-routing prompt. The current machine selects two personal examples, so neither a new user nor this machine sees the five packaged setup skills by default.
### Evidence
`bin/raw.ts:63-80`; `src/llm/prompt.ts`; `tests/foundation-cli.test.ts:27-43`; `tests/package.test.ts`; `tests/package-agent.test.ts`; `docs/cli.md`; `README.md`; current sanitized personal profile selection noted in Baseline.
### Pattern
Extend the existing once-only starter JSON; keep its `local` name/model placeholder and add an inline editable `system_prompt`, the two skill tools, and five ordered built-in skill IDs. Existing configs remain untouched by `config init` and npm installation. Qualify personal state only after the product gates pass.
### Dependencies
Phases 1 and 2.
### Files and symbols
`bin/raw.ts` (config-init starter and help), optional shared starter-prompt constant, `tests/foundation-cli.test.ts`, `tests/package.test.ts`, `tests/package-agent.test.ts`, `README.md`, `docs/configuration.md`, `docs/skills.md`, `docs/cli.md`; after commit, the explicit local qualification edits `~/.config/raw/config.json` and archives `~/.config/raw/skills/{repo_map,verify_change}` outside the repo.
### Behavioral contract
A fresh config chooses `local`, retains its three core tools, adds `builtin/list_skills` and `builtin/load_skill`, selects the five built-in skills, and uses a concise prompt that retains the current general coding-assistant behavior, routes Raw setup/customization tasks through `list_skills` and then only relevant `load_skill` calls, and lets unrelated tasks proceed without loading skills. The first request contains the generic skill tool schemas and starter prompt but no skill catalog or Markdown. Exact list/load results reach subsequent requests in tail order. `config init` refuses to overwrite an existing config; package installation never writes one. The current machine's model, MCP, request, compact, and credential fields remain byte-semantically unchanged when replacing its two selected skills; its existing DeepSeek prompt file is preserved. Previously loaded old skills produce the established reload notice on compatible resume, not rewritten history.
### Documentation
Update README/help and config/skills/CLI docs with the new starter profile, five IDs, example setup tasks, how to fork built-ins to `local/` or `agent/`, prompt override and resume behavior, and the explicit package-vs-user-config boundary.
### Tests first
RED: `config init` still has only three tools and no skills. GREEN: in isolated XDG homes, run the installed binary's `config init`, assert mode 0600 and full starter selection/prompt, change only that temporary fixture's model ID/endpoint to a mock provider, load config, ask the mock provider to call list then one relevant load, prove no first-request skill metadata/body and linked later results, and verify all five bodies are readable after `npm pack`/install outside checkout. Check a second `config init` leaves the original bytes unchanged and npm installation creates no user config/state. Verify resume with unchanged skills and one edited local fork still honors current generation semantics. After automated gates, back up this machine's config, switch both profiles to the five `builtin/` IDs without changing other fields, archive the two old sample skill folders, and directly validate list/load on the installed `raw` binary without spending provider tokens.
### Anti-shortcut coverage
Do not pass by testing only source-side `loadSelectedSkills` or by hardcoding catalog text into the system prompt. The installed binary must produce a valid starter profile and reveal the five assets only through linked tool results. Keep user credentials and existing profile settings intact; no install-time write or automatic migration is acceptable.
### Implementation obligations
Add the starter selection/prompt, update help/docs, exercise packed installed behavior and the two Node runtimes, then perform the explicit backed-up personal replacement. Do not rename `local`, create a new agent registry, reset sessions, or modify existing configs during package installation.
### Acceptance criteria
- [ ] AC-3.1: Fresh `raw config init` produces the setup-capable `local` profile with five selected built-in skills and both skill tools, while refusing overwrite and preserving file mode — proven by CLI and installed-package tests.
- [ ] AC-3.2: Installed first request has no skill catalog/body; linked list/load results expose only the selected five and a chosen body, with no checkout/user-home dependency — proven by mock-provider packed-consumer test.
- [ ] AC-3.3: Existing config stays untouched on install/init refusal, and this machine's `local`/`deepseek` replace the two examples with five packaged IDs after a backup without losing model/MCP/credential/prompt settings — proven by byte-level backup comparison of unaffected fields and installed CLI validation.
- [ ] AC-3.4: README/help/docs match the new starter and five skill contracts; full gates pass on supported local Node runtimes — proven by inspection and commands below.
### Focused verification
`npm run build && node --import tsx --test tests/foundation-cli.test.ts tests/bundled-skills.test.ts tests/package.test.ts tests/package-agent.test.ts`
### Phase gates
`npm run check && npm run test:overhead && npm run test:package && git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: initialize Raw with packaged setup skills`

## Completion Criteria
- All three phases have checked acceptance criteria, passing focused/full gates, APPROVE reviews, and commits. The five shipped skill bodies are detailed, exact, selectable, and loadable from the installed package without exposing them in the initial prompt.
- New users receive a setup-capable default `local` profile after `raw config init`; existing configs and npm installation remain untouched. A profile remains the sole agent definition, with explicit prompt/tools/skills/MCP/rules selection.
- This machine's two active profiles select the five packaged skills, the two temporary examples are archived, and credentials/model/MCP/prompt settings remain intact. Existing saved sessions follow current skill-generation behavior; no DB migration occurs.
- The installed-package workflow can actually follow the skill examples to create a skill, tool, portable agent profile, and MCP selection outside the checkout. Raw's MCP/ACP/CLI/session regressions remain green.

## Progress Log
- 2026-09-25: Intent-fidelity and structural self-review APPROVE: three dependency-ordered phases, all required headings, 11 binary criteria, package/CLI/skill/MCP regression gates, default-cap constraint, installed-consumer proof, and explicit personal-state backup were checked. The implementation remains pending user approval of this plan.
- 2026-09-25: Planning started on clean `83a62bf`; CTXE Ready/fresh and fast-understand routed config-init, skill loader, package assets, profile/MCP contracts, and installed tests. No production code changed. The current machine's two personal examples and DeepSeek prompt were inspected by ID only; credential values were not read or printed.
