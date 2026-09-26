# Runtime variables and executable providers

## Plan schema
loop-plan/v1

## Target
Add named, agent-scoped, read-only variables to Raw. An agent can discover metadata, read permitted values, or pass named references to Bash and trusted custom tools without Raw inserting those values into model-visible invocation arguments. Sources include literal JSON, environment variables, files, built-in system time, and user executable providers. Ship accurate English documentation, examples, and updates to the existing five setup skills.

The user approved the feature direction and executable JSON protocol, and explicitly requested documentation/skill updates. The user subsequently explicitly authorized implementation immediately after plan completion; this reviewed plan is approved for execution.

## Scope
- Root `vars` and `var_providers`; per-agent `vars` selection; strict configuration and typed public APIs.
- Lazy resolution, bounded executable JSON stdin/stdout protocol, cancellation, runtime-local TTL cache, and `system.time`.
- Packaged `builtin/list_vars` and `builtin/read_var`; host `context.vars` for selected built-in and user plugins.
- Per-command `commands[].env_refs` on the existing Bash batch interface; real subprocess environment injection.
- `raw vars list` / `raw vars get NAME`, setup defaults, CLI/REPL/ACP/library/resume coverage.
- Documentation, English skill descriptions and bodies, forkable examples, packed-consumer verification.
- Excludes mutable agent state, persistent variable caches, encrypted vaults/keychains, provider daemons, arbitrary model-selected provider parameters, template expansion, automatic MCP env/header interpolation, weather/location integrations, migration and compatibility shims. An executable fixture demonstrates the extension mechanism without an external service.
- Do not change personal config, remove saved sessions, globally install, push, or enable GitHub Actions during planning. Implementation commits follow the phase boundaries; personal setup/install is a separate explicit delivery step if requested.

## Invariants
1. Discovery and configuration validation never execute a provider, read a variable file, or resolve an environment value. Unselected variables/providers stay inert beyond structural validation.
2. The selected agent's explicit names bound all host variable operations. Missing selection means no variables. This is a Raw API boundary, not OS isolation: existing plugins/Bash have host permissions.
3. `read` permits reading and consuming a reference; `use` permits consuming a reference but rejects `read_var` and CLI get. `use` is not a guarantee against a command/plugin printing its inputs.
4. Provider names/commands/params come from config, never from model arguments. Execute with `spawn(command, args, {shell:false})`; do not expand templates or interpolate values into shell source.
5. Tool policy and approval remain before provider resolution/execution. No new unconditional Bash prompt. `commands[*].command` conditional rules retain their meaning.
6. Tool schemas/descriptions and the system prefix do not include variable names, metadata, values, clocks, or cache contents. Discovery/read results append as ordinary tool results.
7. Persist original reference-bearing tool arguments only. Resolved use values are transient execution data; ordinary outputs may still contain values intentionally emitted by a command. No blanket redaction subsystem is promised.
8. Resume preserves historical results and uses a fresh runtime resolver for subsequent calls. Value/TTL/config changes alone do not rotate Raw's generated prompt cache key. Selecting new tool schemas/source still follows the existing tool-revision mechanism.
9. No new session database fields or schema bump is required: variables are live external inputs, not saved conversation identity. No migration or deletion of test sessions is needed for this design.
10. Keep existing UI behavior, skill loading, MCP selections, ACP permissions, process cancellation and package portability working. Skill content/descriptions remain English and each loaded body stays within 8192 UTF-8 bytes.

## Baseline
- Repository `/Users/lploc94/projects/raw-cli`, branch `main`, HEAD `8000625`; clean and tracking `origin/main` before plan creation.
- `npm run typecheck` passed during planning. Earlier handoff reports 368 passing tests at HEAD; a full suite was not rerun during planning and must be run for implementation.
- Session schema is currently 5. `SessionStore.initializeAgent` owns prompt/model identity and tool/skill revisions.
- CTXE connector returned `Transport closed`. A temporary host-owned `ctxe mcp` stdio client successfully called `get_status`: Ready/current/fresh, 195 indexed files, zero changed/new/deleted files. No persistent MCP service was created.
- CTXE `fast_understand`, record 54, routed complementary config, tools, CLI, session, and docs/skills subjects. Some initial documentation excerpts were partial; relevant current files were read directly after routing. Additional bounded integration Ask is recorded in Progress Log after completion.
- Current tool plugins run in-process, not in workers. `loadToolPlugins` constructs a filtered `ToolContext`; there is no worker protocol to extend.
- Current Bash takes `{commands:[{command,timeout_ms?}]}`, not the earlier conversational top-level `{command:...}` sketch.
- Current `configure_raw/SKILL.md` is 8189 bytes; adding prose without restructuring would break the default cap.

## Design and project patterns

### Configuration contract
Root `vars` / `var_providers` default to empty objects. Reject unknown fields and duplicate JSON keys using the existing strict config approach. Variable/provider names match `[a-z][a-z0-9_.-]{0,63}`; reserve provider name `system.time`. Reject prototype-sensitive keys with own-property-safe maps consistently. Agent `vars` is an optional ordered array of unique exact existing variable names; no wildcard or implicit inheritance. Variables do not require the two discovery/read tools because a consumption-only agent may know reference names from its prompt.

A variable has required nonempty `description`, required `source`, required `access` (`read` or `use`), optional `type`, and optional nonnegative integer `cache_ttl_ms` (default 0, maximum 2147483647). Supported declared types: `string`, `number`, `boolean`, `object`, `array`, `null`, `json`. Numbers must be finite. `json` accepts any JSON value. Missing type is inferred from literal values, defaults to string for env/text-file, and json for JSON-file/provider; system.time defaults to string. Validate declared type on resolution, and validate literal compatibility at parse time. Omitted metadata does not require executing a provider to infer a type.

Source discriminated union (unknown fields rejected):
- `{kind:"literal", value:<JSON>}`; JSON objects/arrays supported; empty strings, false, 0 and null are values, not missing values.
- `{kind:"env", name:<environment identifier>}`; always produces a string; unset is an error, empty is valid. Reads the resolver's provided environment (default process.env); no eager value copy into runtime config.
- `{kind:"file", path:<nonempty string>, format:"text"|"json"}`; format defaults to text. Path resolves relative to selected config directory. Read strict UTF-8 lazily, preserve text whitespace/newlines, parse JSON only for json format, bound reads to 65536 bytes including oversize detection. Fail on missing/invalid/oversized input, never silently truncate a value.
- `{kind:"provider", name:<provider name>, params?:<JSON object>}`; params defaults to `{}`; no recursive variable references. Name must be `system.time` or a declared executable provider. Built-in system.time accepts only empty params and returns UTC ISO-8601 string.

Executable provider definition: required nonempty string `command`; optional string-array `args` (default []), `cwd` (default selected config directory), positive integer `timeout_ms` (default 5000, max 2147483647), positive integer `max_output_bytes` (default 65536, max 1048576). `max_output_bytes` bounds combined stdout/stderr bytes. Bare commands resolve through PATH; absolute commands stay absolute; commands containing a path separator resolve against config directory. `cwd` resolves against config directory; args remain literal, so relative script arguments resolve from the provider cwd. No shell, tilde or environment expansion. Provider subprocess inherits the resolver environment; no separate inline script or provider-env schema in v1. Provider request JSON is limited to 65536 UTF-8 bytes and validated before spawning.

Example fragment (not an entire config):
```json
{
  "var_providers": {
    "sensor": {"command":"node", "args":["providers/sensor.mjs"], "timeout_ms":5000}
  },
  "vars": {
    "project": {"description":"Project settings", "source":{"kind":"literal","value":{"name":"raw-cli"}}, "access":"read"},
    "github_token": {"description":"GitHub API credential", "source":{"kind":"env","name":"GITHUB_TOKEN"}, "access":"use"},
    "now": {"description":"Current UTC time", "source":{"kind":"provider","name":"system.time"}, "access":"read"},
    "temperature": {"description":"Configured sensor temperature in Celsius", "type":"number", "source":{"kind":"provider","name":"sensor","params":{"field":"temperature_c"}}, "access":"read", "cache_ttl_ms":60000}
  }
}
```
Register names in `agents.<name>.vars`; select `builtin/list_vars` / `builtin/read_var` explicitly in `tools.use` if discovery/reading is wanted.

### Resolver and executable protocol
New small `src/vars/` modules own contract/schema, resolver, and executable supervision. Reuse process lifecycle techniques from `src/tools/process.ts` without pretending provider stdout is a Bash ToolResult. Extract shared low-level supervision only if it removes real duplication without changing Bash's output semantics.

Public host interface `VariableContext`:
- `list(): readonly VariableMetadata[]` returns ordered `{name,description,type,access}` only, fresh copies.
- `read(name, {signal}?): Promise<ResolvedVariable>` enforces read access.
- `validateEnvRefs(refs): void` validates map shape, environment identifiers, selected names, and declared env-compatible types without I/O.
- `resolveEnv(refs, {signal}?): Promise<Record<string,string>>` permits read/use references, validates actual values, and returns only requested environment entries. Trusted plugin code receives these values; model history does not automatically receive them.
- ResolvedVariable is `{name,value,observed_at,cached}`; caller mutation must not mutate future reads/cache.

String/number/boolean values convert to subprocess env as unchanged string / JSON number / `true|false`. Reject null/object/array for env bindings; do not implicitly stringify structured data. For `type:json`, actual-type validation is necessarily deferred until resolution. Env names match `[A-Za-z_][A-Za-z0-9_]*`, reject NUL values; do not restrict names like PATH beyond existing host-permission model. Bindings override the inherited env for that child only.

One request per provider invocation, newline-terminated JSON on stdin followed by EOF:
```json
{"protocol_version":1,"name":"temperature","params":{"field":"temperature_c"}}
```
Exactly one JSON object on stdout (surrounding whitespace allowed), required `value`, optional `observed_at` UTC ISO-8601 string; reject unknown fields, malformed JSON, invalid UTF-8, extra stdout logs/JSON objects, invalid timestamp, and incompatible value types. Exit 0 is required. Absent observed_at uses host completion time; built-in system.time uses one clock sample for value and observed_at. stderr is bounded diagnostic output, not part of the value or model-facing protocol errors. Return stable error codes with provider/variable name and failure class, not raw stdout/stderr or parsed value dumps.

Enforce timeout from spawn through process close, abort-before-spawn, abort while writing stdin, spawn errors, early stdin closure/EPIPE, output overflow and descendant pipe retention. Terminate and reap on failure; retain the repository's POSIX process-group termination and Windows direct-child fallback, documenting the existing platform limit rather than inventing a sandbox. No automatic retry or stale-on-error fallback.

Cache is per resolver instance, bounded by the selected variable catalog, with monotonic expiry measured from successful completion (not provider observed_at). TTL applies uniformly to all sources. TTL 0 always resolves; only successful results enter the cache. No cross-session/process disk cache, proactive refresh, or in-flight request sharing in v1; concurrent misses may execute independently and retain their own cancellation ownership. Permission checks run even on cache hits. `/clear` clears conversation as today; a resolver's TTL cache survives until that runtime is recreated. A CLI get process always starts with an empty cache.

### Tool and surface integration
`createRuntimeTools` creates a resolver per runtime-tools instance and passes its service into `loadToolPlugins`. Extend the existing filtered plugin context with a documented `vars` capability for all selected local/built-in plugins. Standalone plugin imports without host services return a clear vars-unavailable error only when vars are needed. Direct SDK users can create/inject the resolver explicitly through exported types/functions; no module-global singleton or new required arguments for unrelated library use.

New standalone plugins use stable manifests: `list_vars({})` returns `{vars:[metadata...]}`; `read_var({name})` returns ResolvedVariable. Errors use existing ToolResult conventions. A list/read response that cannot fit maxOutputBytes returns a clear output-budget error, never a partially valid value. Validate a selected list_vars catalog can fit at startup without resolving values, consistent with list_skills.

Existing Bash contract becomes:
```json
{"commands":[{"command":"curl -H \"Authorization: Bearer $GH_TOKEN\" https://api.github.com/user","env_refs":{"GH_TOKEN":"github_token"}}]}
```
The JSON above must be parsed in documentation tests. `env_refs` is optional per command, never a top-level substitute for `commands`. Validate the complete batch's reference metadata before any provider/command side effects, after registry approval. Resolve each command's bindings immediately before that command starts. A resolution/type/NUL failure reports that row as error and skips remaining rows; previous completed rows remain completed. Keep existing nonzero-exit continuation and timeout/abort stopping behavior. Record a clear skip reason such as `prior_var_error` rather than mislabeling it `prior_timeout`. A denied/invalid call runs neither provider nor Bash. The command's timeout_ms remains its Bash execution deadline; variable providers use their own deadline and the same call abort signal.

No special MCP argument rewriting. Existing MCP inputs/results and selection remain unchanged; tools capable of env references are local handlers using context.vars. This boundary must be explicit in add_mcp and tools docs.

CLI `raw [--config PATH] [--agent NAME] vars list|get NAME` uses effective agent selection, validates the config, and does not require LLM credentials, load prompt files, import plugins, start MCP, open a session DB or make inference requests. Factor selection/config projection rather than routing through full runtime startup. Output one newline-terminated JSON result using the same catalog/value shape; errors to stderr, exit 2 for invalid invocation/config and 1 for resolution/access failure, 130 for cancellation. No get override to reveal use-only values. Reject incompatible task/session/ACP flags. `config list` shows selected variable names only.

`config init` adds root `vars.now`, agent raw selection `["now"]`, and both variable tools alongside existing setup tools; static prompt can mention list/read discovery but must not embed catalog/value data. Other agents require explicit edits; do not auto-append tools to user definitions.

Session behavior is deliberately simple: no vars snapshot/digest/visibility fields. Prior tool results retain their observed_at and remain historical even if config/provider code changes. A new runtime uses current definitions; an existing runtime holds validated definitions until restarted. External env/files/providers resolve according to TTL. Manifest descriptions teach the model to read again when fresh data matters, especially after resume. Tests must prove repeated resumes do not execute providers until used and variable changes alone preserve system/tools/cache key.

### Existing patterns and evidence
- `src/config.ts`: parseConfigDocument root allowlist, agentSpec, parseDocument, loadConfig and parseCliArgs own strict config/selection; split vars parsing into a focused module instead of further monolithic conditional growth.
- `src/tools/plugins/runtime.ts:createRuntimeTools`: one setup path for CLI and ACP; current selected skills are a useful lazy service pattern.
- `src/tools/plugins/loader.ts:loadToolPlugins`: schema/semantic validation, selected-only import, source digests, and construction of the filtered plugin context.
- `src/tools/registry.ts:ToolRegistry.dispatch`: schema/semantic checks, policy, approval, onStart, handler and output cap ordering.
- `src/tools/primitives.ts:ToolContext,bashTool` and `src/tools/process.ts:runBash`: sequential batch results, output accounting, spawn and cancellation.
- `src/tools/bundled/list_skills/index.ts`: standalone linked host-service tool pattern; new vars tools stay forkable in the same way.
- `src/cli.ts:runCli`, `src/acp/methods.ts` session creation and `src/index.ts`: integration/public API boundaries. `src/sessions/store.ts:initializeAgent` shows why variable data must not be mixed into tool identity.
- `tsup.tools.config.ts`, `scripts/copy-tool-manifests.mjs`, `scripts/build-tool-examples.mjs`: explicit bundled tool lists; all must include both new tools.
- `scripts/copy-bundled-skills.mjs`: generates installed/example copies from source. `package.json.files` currently ships only two docs and selected examples directories; new docs/provider examples require explicit package inclusion.
- `tests/config.test.ts`, `tests/agent-tools.test.ts`, `tests/registry.test.ts`, `tests/primitives.test.ts`, `tests/session-cli.test.ts`, `tests/session-acp.test.ts`, `tests/bundled-skills.test.ts`, `tests/package.test.ts`: behavioral test patterns. `scripts/test.mjs` discovers all `*.test.ts` automatically with isolated XDG homes.

## Global Gates
- Work docs-first/TDD for each phase, then focused verification; do not run live model/weather APIs or spend GitHub Actions minutes.
- `npm run typecheck` and `git diff --check` at each phase; build before tests importing bundled assets.
- Final `npm run check` must pass all existing and new tests, including packed-consumer tests. No arbitrary new fixed total count.
- Final package proof must execute installed artifacts from an unrelated directory with isolated XDG config/state and a fake executable provider; test shipped docs/example availability and source/example/installed skill equality.
- Tests must use their own temp config/state; never resolve real credentials, mutate personal config, or clear real sessions. Use dependency-injected time for TTL boundaries and actual child processes for supervision/env behavior.
- Five English setup bodies must load intact at default cap; docs code examples must parse and representative complete configs/scripts must execute through real parsers/handlers.
- Every phase requires implementation review with APPROVE; record findings/fixes in Progress Log. Do not spawn review subagents unless separately requested or required by applicable implementation skill instructions.

## Plan Review
APPROVE — self-review completed 2026-09-26. Checked scope fidelity, phase dependency order, current paths/symbols, strict JSON examples, process/permission/cache boundaries, utility startup isolation, package allowlists and skill byte caps. User explicitly authorized implementation immediately after plan completion ("plan xong implement luôn nha").

## Phase 1: Define variable configuration and public contracts
### Goal
Add strict declaration/selection contracts without resolving values during config loading.
### Current behavior and gap
Config rejects vars fields; RuntimeConfig and plugin contexts have no variable contract. CLI utility commands currently cannot project agent capabilities independently of full runtime resolution.
### Evidence
`src/config.ts:parseConfigDocument,agentSpec,parseDocument,loadConfig`; root and agent allowlists; `src/index.ts` public exports.
### Pattern
Reuse duplicate-key detection, discriminated field parsing, frozen selected config and explicit model/tool references. Introduce a focused vars schema module and shared selection projection.
### Dependencies
Approved plan only.
### Files and symbols
Modify `src/config.ts`, `src/index.ts`, `tests/config.test.ts`; add `src/vars/contract.ts`, `src/vars/config.ts`, `tests/vars-config.test.ts`; document `docs/vars.md`, `docs/configuration.md`, `docs/config-design.md`.
### Behavioral contract
Implement configuration/type/default/path/selection rules above. Validate all definitions structurally, but no external data access. Expose a vars-only selected configuration projection for CLI utilities. Preserve existing config behavior when fields are absent.
### Documentation
Write canonical field/type tables and complete examples before code; distinguish declared metadata from lazy runtime values and clearly mark forthcoming runtime portions until integrated.
### Tests first
Reject unknown fields, duplicate names/selections, bad names, undeclared provider/var refs, wrong source variants/types, invalid timer/byte bounds and reserved provider override. Accept all JSON value kinds and portable config paths. A sentinel executable, unreadable variable file and missing env variable must not be touched during load/static config listing.
### Anti-shortcut coverage
A selected provider with an unavailable executable still passes static validation; an unselected malformed declaration fails structural validation. A config utility succeeds without LLM credentials or an existing prompt file. These distinguish static validation from eager startup.
### Implementation obligations
Keep model/agent selection in one shared implementation. Deep-copy/freeze definitions, use safe own-property maps, export types and selection helpers without resolving source data.
### Acceptance criteria
- [x] AC-1: Valid declarations select exactly the requested ordered catalog and defaults — proven by vars-config tests.
- [x] AC-2: Invalid contract combinations fail with field-local errors, and static inspection performs zero external resolution — proven by schema negatives and sentinel tests.
### Focused verification
`node --import tsx --test tests/config.test.ts tests/vars-config.test.ts`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: define agent-scoped runtime variable contracts`

## Phase 2: Implement lazy resolution and supervised executable providers
### Goal
Resolve selected values on demand with typed results, access checks, bounded processes and deterministic TTL behavior.
### Current behavior and gap
Raw supervises Bash but has no executable JSON protocol or scoped variable cache.
### Evidence
`src/tools/process.ts:runBash` process lifecycle, `src/tools/results.ts` bounded errors; phase 1 contract.
### Pattern
A resolver factory with injected environment/clock and per-instance state; a focused provider runner with Raw's process cancellation techniques.
### Dependencies
Phase 1.
### Files and symbols
Add `src/vars/resolver.ts`, `src/vars/provider.ts`, `tests/vars-resolver.test.ts`, `tests/vars-provider.test.ts`, fixture provider under `tests/fixtures/`; update public exports and `docs/vars.md`. Modify shared process utilities only if actually extracted and regression-tested.
### Behavioral contract
Implement list/read/validateEnvRefs/resolveEnv, all sources, built-in time, JSON protocol, bounded file/provider/request input, cancellation and cache rules from Design. No global cache or background process.
### Documentation
Document executable authoring, request/response schema, timestamps, stderr, error classes, paths, inheritance and deadlines; include a working Node executable fixture/example.
### Tests first
Use an actual child fixture with modes for valid value, malformed/extra JSON, stdout logs, invalid UTF-8/type/date, nonzero exit, missing executable, early stdin close, excessive output, timeout and abort. Test file text/JSON/size boundaries; unset versus empty env; clone-on-read; exact monotonic TTL expiry; failures never cached; separate resolvers never share state; params remain config-defined.
### Anti-shortcut coverage
An actual environment payload containing shell metacharacters must survive as data. A child ignoring SIGTERM and a child retaining stdout through a descendant must terminate within the runner bound on supported platforms. Counting fixture proves list never spawns and TTL expiry executes anew; cached use-only values still reject read.
### Implementation obligations
Always finish process/stream cleanup and remove abort/timer listeners. Return stable errors without dumping provider bytes. Preserve successful JSON exactly; reject overflow instead of truncating into valid-looking data. Keep direct-child platform limitations explicit.
### Acceptance criteria
- [x] AC-3: Every source resolves its declared type and access rules without eager work — proven by resolver tests.
- [x] AC-4: Protocol and lifecycle failures return bounded errors and leave no owned active process on supported fixture paths — proven by real-process tests.
- [x] AC-5: TTL and cancellation semantics match the contract across independent resolvers — proven by injected-clock/counting fixtures.
### Focused verification
`node --import tsx --test tests/vars-resolver.test.ts tests/vars-provider.test.ts tests/primitives.test.ts`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: resolve variables through bounded executable providers`

## Phase 3: Expose variable tools and Bash environment references
### Goal
Make variables usable by model-facing and custom tools through the real plugin runtime and selective policy flow.
### Current behavior and gap
Plugin context currently forwards cwd/signal and selected skills only. Bash accepts command/timeout only; runBash inherits env with no per-command overrides.
### Evidence
`src/tools/plugins/loader.ts:loadToolPlugins`, `runtime.ts:createRuntimeTools`, `registry.ts:dispatch`, `primitives.ts:bashTool`, `process.ts:runBash`, shipped Bash schema and validator.
### Pattern
Linked host services following skill tools, standalone bundled handlers/manifests, existing sequential Bash outcome accounting, and registry approval before handlers.
### Dependencies
Phases 1–2.
### Files and symbols
Modify loader/runtime, ToolContext, Bash manifest/validator/handler and BashOptions; add bundled `list_vars/` and `read_var/`; update `tsup.tools.config.ts`, copy/build scripts, generated `examples/tools/`, public exports. Add `tests/vars-tools.test.ts`; extend `tests/agent-tools.test.ts`, `tests/primitives.test.ts`, `tests/registry.test.ts` where needed.
### Behavioral contract
Create one resolver per RuntimeTools, inject service into all selected local plugins, enforce host allowlist/access and stable tool schemas. Validate all Bash reference metadata before any batch I/O; resolve per row after approval and immediately before spawn; env never mutates process.env or original args. Preserve result accounting, cancellation and policy. Exceeding catalog/result budget is an explicit error.
### Documentation
Update `docs/tools.md` with actual batch JSON, host API, custom/forked tool example, consumption semantics, failure ordering and the limits of use-only access.
### Tests first
Real plugin dispatch for empty catalog, allowed metadata/read, denied read, unselected names, oversized values/catalog, unavailable context, and a copied custom plugin. A Bash subprocess verifies scalar values without printing credentials. Cover invalid later refs (no first command), failing later provider (earlier completed row preserved, remainder skipped), denied approval (zero provider/command), cancellation and matching/nonmatching rm policy.
### Anti-shortcut coverage
Mutating env_refs args or interpolating values into command text must fail sentinel history/argument and metacharacter tests. A local fork must receive context.vars identically to a bundled tool. Denied read/access with cached data must not leak. Existing MCP registration remains unaffected.
### Implementation obligations
Update every explicit bundle list and regenerate examples via build; do not patch generated bundles manually. Keep service methods signal-aware; ensure direct imported handlers fail clearly only if variables are requested. Update descriptions in English without embedding user catalog values.
### Acceptance criteria
- [x] AC-6: Both new tools load as selected standalone plugins and enforce catalog/read contracts — proven through registry and fork tests.
- [x] AC-7: Bash receives exact per-command env without argument mutation, early provider execution or cross-command env leakage — proven with actual subprocesses.
- [x] AC-8: Selective approval and complete-batch metadata validation prevent denied/invalid side effects — proven with sentinels and existing regression tests.
### Focused verification
`npm run build`
`node --import tsx --test tests/vars-tools.test.ts tests/agent-tools.test.ts tests/primitives.test.ts tests/registry.test.ts tests/mcp.test.ts`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: add variable tools and Bash environment bindings`

## Phase 4: Integrate CLI utilities, defaults and session continuity
### Goal
Deliver no-model CLI inspection and verify equivalent runtime behavior through CLI, REPL, ACP and SDK resume.
### Current behavior and gap
CLI only has config/session utilities; starter agent has five tools. Session persistence stores tool calls/results and generated cache identity, so transient vars must remain outside identity/argument mutation.
### Evidence
`bin/raw.ts:help,run`, `src/config.ts:parseCliArgs`, `src/cli.ts:runCli`, `src/acp/methods.ts` session initialization, `src/sessions/store.ts:initializeAgent`, `src/sessions/api.ts:resumeSession`.
### Pattern
Existing utility-command input/error handling, shared RuntimeTools integration, mock inference fixtures and isolated session tests. Keep store/schema untouched unless a demonstrated defect requires an explicitly reviewed plan amendment.
### Dependencies
Phases 1–3.
### Files and symbols
Modify CLI parser/bin/init/list display and any required runtime lifecycle wiring; add `tests/vars-cli.test.ts`, `tests/vars-session.test.ts`; extend CLI/ACP/repl/session tests and docs `cli.md`, `context.md`, `architecture.md`, `configuration.md`.
### Behavioral contract
Utilities use effective agent selection and vars projection without prompt/model/MCP/session startup. JSON output/error codes as designed. Starter selects now and both tools. Session history retains reference args and read results; current resolver handles new reads after resume. No variable-based cache-key or DB schema revision.
### Documentation
Explain utility output versus model tools, agent selection, TTL versus provider prompt caching, refresh-on-read/resume semantics, /clear behavior, current-definition snapshots per runtime, and no automatic MCP interpolation.
### Tests first
Execute dist CLI with isolated homes and nonexistent credentials/prompt/MCP executables: vars utilities still work. Verify bad command/flags, unknown/use-only refs, cancel exit, config list metadata only, no created session DB. Mock-model transcript uses list/read/Bash refs then resume with changed env/provider file and catalog; new reads reflect live values while historical rows and generated cache key remain stable. ACP exercises selection, permissions and cancellation using same host service. SDK uses exported resolver integration.
### Anti-shortcut coverage
Read actual persisted invocation rows and captured provider requests for a use-only sentinel never printed by the subprocess: it must be absent from arguments/history/request, but child verifies receipt. Compare exact system/tool prefix and generated cache key across vars-only changes and resumes. New tool/source changes must still rotate the existing key. Do not use string-only snapshots as a substitute for real execution.
### Implementation obligations
Factor utility selection cleanly; avoid spinning up full agent runtime for inspection. Keep CLI and ACP session resolver instances isolated. Do not introduce session migration or silently rewrite user config. Propagate cancel through utility provider calls.
### Acceptance criteria
- [ ] AC-9: CLI vars works with no model credentials, prompt assets, MCP startup or session DB — proven by installed/dist CLI fixtures.
- [ ] AC-10: Resume/ACP/SDK use fresh scoped resolver state and retain stable prompt prefix/history semantics — proven with mock provider and persistent sessions.
- [ ] AC-11: config init/list accurately expose variable capabilities without resolving/displaying values — proven through CLI tests.
### Focused verification
`npm run build`
`node --import tsx --test tests/vars-cli.test.ts tests/vars-session.test.ts tests/cli.test.ts tests/repl.test.ts tests/session-cli.test.ts tests/session-acp.test.ts tests/session-api.test.ts tests/acp.test.ts tests/cache.test.ts`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: expose vars CLI and preserve session continuity`

## Phase 5: Ship English setup guidance and qualify installed artifacts
### Goal
Let a user or model configure variables, write a provider, create a consuming tool/agent and share it using only the installed distribution.
### Current behavior and gap
Existing five skills omit vars; configure_raw nearly fills the cap. Package allowlist excludes general docs/provider examples, and build scripts generate examples from source.
### Evidence
`src/skills/bundled/{configure_raw,create_tool,create_agent,create_skill,add_mcp}/SKILL.md`, their skill.json descriptions; `docs/skill-authoring.md`; package.json.files; copy-bundled-skills; bundled-skills and packed-consumer tests.
### Pattern
Retain five distinct skills, English intent-based descriptions, executable marked examples, self-contained loaded bodies within 8192 bytes, and generated equal source/example/installed copies.
### Dependencies
Phases 1–4.
### Files and symbols
Update README and relevant docs above; source SKILL.md/skill.json and generated examples/skills; add `examples/providers/` with a no-dependency executable Node provider and instructions; extend `examples/agents/project-helper/` with config-relative vars/provider use where coherent. Update package.json.files, `tests/bundled-skills.test.ts`, `tests/package.test.ts`, `tests/package-agent.test.ts` and add `tests/vars-docs.test.ts` for executable examples.
### Behavioral contract
configure_raw teaches exact root/agent schemas, source types/defaults/access/TTL, correct editing and validation. create_tool teaches context.vars and a meaningful reference-consuming handler, and distinguishes a provider from an action tool. create_agent teaches selections and portable providers/files/env prerequisites. create_skill teaches lazy vars discovery/read rather than capturing dynamic values in a skill. add_mcp explicitly distinguishes vars from MCP env/header literals and does not claim unsupported interpolation. All descriptions remain distinct and English.
### Documentation
Complete docs/vars.md with copyable full config, provider authoring/debugging, CLI/tool usage, Bash batch example, freshness/error semantics, share layout and practical limits. Keep skill essentials self-contained; optional expanded installed docs are supplementary, not mandatory relative resources unavailable to load_skill. Restructure configure_raw compactly without deleting existing UI/provider/cache/skill/setup contracts. Ship docs/vars.md and provider examples explicitly in package files.
### Tests first
Parse/run marked configs and provider/tool examples. Assert all five bodies load completely at default cap, English metadata and example equality; ensure a loaded relevant skill includes enough steps/schema to add a provider without a source checkout. Packed consumer from a relocated directory executes CLI get, both variable tools, a copied provider and Bash binding using a fixture/mock model; no real external calls.
### Anti-shortcut coverage
A source-only doc/example or a handler importing the checkout must fail packed-consumer checks. A fragment that uses top-level Bash command, implicit vars tools, unsupported MCP interpolation, or an oversized configure_raw body must fail checks. Validate behavior of examples instead of merely asserting terminology appears.
### Implementation obligations
Regenerate copies through build; package every referenced mandatory artifact. Preserve existing five-skill roles and UI instructions, reuse established marked-example test approach. Review all modified docs against final runtime behavior and remove provisional wording from earlier phases.
### Acceptance criteria
- [ ] AC-12: Installed English skills give accurate usable vars/provider/tool/agent guidance within default caps — proven by loaded bodies and executable examples.
- [ ] AC-13: Relocated installed artifacts execute the complete vars workflow without checkout dependencies — proven by packed-consumer tests.
- [ ] AC-14: Entire repository regression suite passes and docs reflect final contract — proven by npm run check and final review.
### Focused verification
`npm run build`
`node --import tsx --test tests/bundled-skills.test.ts tests/vars-docs.test.ts`
### Phase gates
`npm run check`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`docs: ship variable provider guidance and installed workflow coverage`

## Completion Criteria
- [ ] All phase ACs and review gates are complete; no deferred core integration.
- [ ] A user can configure a literal/env/file/provider var, select it for an agent, discover/read it, or pass a reference to Bash/custom tool according to access.
- [ ] Actual provider subprocess, policy, env, TTL, error/cancellation and resume behavior are covered by meaningful tests.
- [ ] All five English setup skills and shipped docs/examples match implementation; full default-cap bodies and installed package are verified.
- [ ] No eager dynamic values in prompt/tool definitions, no automatic persistence of use-only binding values, and no changes to existing MCP contracts.
- [ ] Final report states commits, validation performed, any platform qualification limits and installation status accurately.

## Progress Log
- 2026-09-26: User agreed to vars and executable provider design and requested related documentation/skill updates. Started loop-plan only per global workflow.
- 2026-09-26: Clean baseline at 8000625; typecheck passed. Recovered CTXE access through temporary host-owned stdio process; Ready/fresh; fast routing record 54. Inspected exact routed source integration points and package/test/skill patterns.
- 2026-09-26: CTXE integration Ask record 55 returned partial evidence because its composer exceeded the server context budget; it is not treated as a synthesized conclusion. Exact routed source reads established the integration contracts used here. JSON examples and all five required phase blocks validated. Self-review APPROVE; user authorized immediate implementation after planning.
- 2026-09-26: Phase 1 in_progress; phases 2–5 pending.
- 2026-09-26: Phase 1 complete; review APPROVE. Red: missing loadVariableConfig export. Green: 10 config tests; typecheck and diff checks passed. Reviewed strict metadata-only projection, path resolution, immutable declarations, and no eager credentials/prompt/source access. Phase 2 in_progress.
- 2026-09-26: Phase 2 complete; review APPROVE. Red: missing resolver/provider modules. Green: 12 resolver/provider/Bash lifecycle tests, typecheck. Real subprocess fixtures covered timeout, abort, inherited pipes, invalid protocol and counting TTL. Corrected one trailing blank line in docs/vars.md reported by the Phase 1 staged diff check (the earlier log overstated that whitespace check); current diff check passes. Phase 3 in_progress.
- 2026-09-26: Phase 3 complete; review APPROVE. Red: unknown bundled vars tools and missing custom context service. Green: 33 focused tests including MCP/Bash/approval/fork regressions; typecheck/build/diff checks passed. Updated intentional Bash schema digest golden for env_refs. Denied conditional calls have zero provider marker writes, and invalid later refs prevent the first command. Phase 4 in_progress.
