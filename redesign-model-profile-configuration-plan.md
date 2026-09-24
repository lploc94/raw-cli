# Redesign raw-cli model and profile configuration

## Plan schema
loop-plan/v1

## Target
Implement the agreed unreleased config redesign end to end: model access paths under models; runnable presets under profiles; provider as upstream service and method as API adapter; direct or environment credentials; method-specific request controls; profile-selected MCP and tool policy; conditional native vision; explicit and automatic compaction with stable prompt caching. Ship accurate CLI, library, ACP and user documentation, then qualify the installed binary.

## Scope
- Replace the old flat profile schema outright. No legacy parsing, aliases, migration code, compatibility tests, or preservation of old CLI override behavior.
- One model alias resolves to one provider, method, upstream model_id, endpoint/auth source, context/output metadata, and optional vision boolean. One profile references exactly one model and owns runtime/request/cache/compact/MCP/tool policy.
- Supported methods: openai-chat-completions, openai-responses, anthropic-messages, google-generate-content. Use a real official-SDK Responses adapter, not a configuration-only method label.
- Built-ins are read_file, write_file, bash; view_image is added only when the selected model declares vision: true. Search and external vision-to-text are MCP tools selected by profile.
- CLI selects a profile via --profile or default_profile. Remove direct --provider, --model, --base-url and their RAW_* overrides so they cannot switch models underneath profile policy. Keep --config, --system-prompt, runtime limit flags and -y where useful; -y never overrides an explicit ask rule.
- Single canonical config at ~/.config/raw/config.json or --config PATH, including top-level mcp.servers. Replace separate mcp.json/raw-mcp.json loading; no compatibility layer. ACP client-provided session MCP servers remain protocol inputs and pass through the selected profile's tool policy.
- Finish with a narrow backup/rewrite of the user's local DeepSeek config and a packed global install only after all gates pass. Never print credentials.

## Invariants
- Default system prompt remains the current minimal text and <=50 tokens; base tool schema remains three tools. No image/search capabilities are injected into text-only profiles.
- Unmatched profile tool rules mean allow and execute without confirmation. Rules match canonical identities; deny hides and rejects, ask requests approval once per call. Headless without an approval channel fails closed. ACP uses session/request_permission. Bash access is full machine permission; tool-name rules are not OS isolation.
- Model and profile stay bound for one session, including ACP. Inactive model credentials are not resolved. API keys never appear in help, config list, errors, logs, ACP info, messages or tool schemas.
- MCP servers not selected by a profile are not started or exposed. Selected tool names/schema ordering is deterministic across turns; raw-to-model tool aliases are collision-safe.
- Native provider-hosted web search is out of scope. MCP search returns text results and source URLs. A text-only model may use external MCP vision-to-text; it must never receive a raw image disguised as text.
- Direct vision uses view_image {path:string} and a real image tool result, without any --image flag. For a method/model unable to accept tool-result images, reject vision config or return a clear upstream capability error, never a fake text success.
- Compaction is opt-in when profile.compact.trigger_tokens is set; manual /compact remains available. Preserve visible events, usage accounting and cache-prefix stability; token estimates are explicitly estimates.

## Baseline
- HEAD before redesign: 0ed50b0; previous baseline npm run check reported 133/133. Current working tree has only this plan and docs/config-design-discussion.md as untracked design artifacts. Re-run checks during implementation.
- CTXE status for /Users/lploc94/projects/raw-cli is Ready, with one changed doc pending incremental indexing. Exact inspected source confirms src/config.ts parses flat profiles and direct provider/model flags; src/llm/types.ts couples provider and model; src/llm/client.ts dispatches by provider.
- src/tools/registry.ts registers three built-ins, sorts definitions and currently uses one global autoApprove switch. src/tools/mcp-client.ts loads a separate mcpServers config, starts every configured server and can parse image content; src/cli.ts and src/acp/methods.ts create each session registry/MCP connection. src/llm/content.ts and adapters already encode some image tool results, but src/tools/results.ts capResult can omit an image above the text output cap.
- src/compact.ts sends JSON-serialized history to a summary model; it would include raw base64 images if view_image were added without special handling. src/llm/cache.ts owns cache options and usage normalization. bin/raw.ts owns config init/list/help and starts CLI/ACP.
- Existing test oracles: tests/config.test.ts, providers.test.ts, provider-content.test.ts, cache.test.ts, usage.test.ts, registry.test.ts, mcp.test.ts, mcp-content.test.ts, cli.test.ts, repl.test.ts, acp.test.ts, compact.test.ts, package.test.ts, overhead.test.ts.

## Design and project patterns
- Canonical root: default_profile, models, profiles, mcp. Validate JSON duplicate and unknown fields using the existing strict parser. Validate all entries structurally, but resolve credentials only for the chosen profile/model.
- Model keys are local aliases; model_id is the exact upstream request model field. Model owns provider, method, base_url, api_key xor api_key_env, context_window_tokens, max_output_tokens capability and vision (default false). Provider is a nonempty service/deployment identifier, not the method enum. Unknown services require explicit endpoint/auth choices and receive no guessed provider-only features.
- Profile owns model alias, typed method-specific request options, max_steps, request_timeout_ms, max_output_bytes, cache hints, compact settings, mcp selection and tools.rules. Validate requested output <= model capability and below context window with reserve. Do not permit request options to override model, messages, tools, endpoint or credentials.
- Request options are tagged by selected method/provider and adapter-validated: OpenAI service_tier/reasoning/output; Anthropic thinking/effort/output; Gemini thinking level or budget/output; DeepSeek Chat thinking.type/reasoning_effort/output. Unsupported fields fail before network. Preserve DeepSeek reasoning_content across tool turns, including turns with no tool call when tools remain present.
- Cache stays profile-scoped and method/provider-specific. Reuse current session-stable cache key, stable system prefix and deterministic tool ordering. Keep OpenAI/Anthropic/llama.cpp hints only for verified combinations; report usage/cache ratios without invented values.
- Profile MCP shape is a map of configured server name to exact tool names or *; root mcp.servers contains stdio or streamable-http transport. Canonical policy names: built-ins by plain name, MCP as mcp:<server>/<original-name>, ACP injected as a distinct acp:<name>. Rules apply in array order, last match wins; default is allow. Denied tools never enter the model schema and also fail dispatch. A selected but denied MCP tool should not add its schema to model context.
- vision:true registers view_image only for that session. Support PNG/JPEG for v1 with explicit size/type checks and a separate image byte cap; max_output_bytes is for text and must not silently omit a valid image. No CLI image flag. The model can call view_image after the user names a path or after discovering a path via existing tools. MCP vision-to-text remains independent.
- Automatic compact uses the selected session model for summarization in v1; no separate compact model/profile switch. Before every inference, budget the complete upcoming serialized request: system/tools, prior transcript, replayed opaque reasoning, newly retained assistant content, pending tool text/images, and an output reserve. Use normalized provider usage to calibrate estimates, plus conservative method-specific estimates for new text and image content; if image cost cannot be bounded, report an uncertain budget rather than claiming safety. Recompute after compact and reject a still-over-budget request before sending it. Trigger at most once per turn.
- Budget the summary request separately against that same model's context window, including its actual serialized instructions/history and output reserve. Build bounded chunks of older turns and chain summaries when one request cannot fit; if a single irreducible turn cannot fit, return a clear no-safe-summary error without mutating the transcript. Remove image base64 from summary input, replacing it with path/MIME/size metadata, and retain actual image content only inside recent turns that fit the post-compact budget. Noop/not_smaller/failure must not recurse or silently send an over-budget request.
- For live cache qualification, run a bounded read-only multi-turn DeepSeek session with an eligible repeated prefix and record prompt_cache_hit_tokens/prompt_cache_miss_tokens per turn. DeepSeek caching is best-effort; distinguish an observed hit from an inconclusive zero-hit run, investigate the serialized prefix on zero hits, and never claim an actual hit based solely on stable fixture bytes. [DeepSeek cache rules](https://api-docs.deepseek.com/guides/kv_cache/).
- Preserve official Agent Client Protocol initialize/session/new/session/prompt flow. Do not add custom acp.handshake/acp.session.run methods from the original obsolete prompt.

## Global Gates
- Docs-first tests: update config/provider/tool/MCP/vision/compact documentation and write focused failing behavior tests before production changes in each phase.
- Every phase: npm run typecheck, focused tests, npm run check, npm run test:overhead, git diff --check. The overhead gate must preserve the <=50-token default system prompt and base three-tool bound; evaluate vision-profile overhead separately.
- Every phase: run codex-impl-review with gpt-6-astra, resolve findings to an explicit APPROVE verdict, then create one cohesive commit. No production code is implemented during this plan-review turn.
- Final gates: npm run test:package, Node 22/24 runtime verification per docs/verification.md, npm pack, install from the exact tarball, compare installed-byte hash, and run a live read-only multi-turn DeepSeek tool session without -y; record actual cache counters. Tests use fixtures, not the user's key.
- No release/CI claim from local checks. Keep credentials out of command output and written test fixtures.

## Plan Review
APPROVE — self-review complete. GPT-6 Astra raised four valid issues in round 1; all were fixed and it explicitly returned APPROVE with no new blockers in rounds 2 and 3. The shared runner cannot parse its own required verdict-only zero-issue format, so those raw verdicts were inspected and the session was finalized with an explicit APPROVE override. No production implementation is authorized by this plan-review result alone; wait for the required loop-plan/v1 approval.

## Phase 1: Replace config schema and profile resolution
### Status
complete
### Goal
Parse and resolve core models plus profiles, then update every existing consumer mechanically so the full suite remains green.
### Current behavior and gap
src/config.ts accepts only flat profiles, a closed provider enum and api_key_env. Direct flags can replace the selected model. bin/raw.ts init/list emits old schema.
### Evidence
src/config.ts profileSpec/loadConfig/parseCliArgs; src/llm/types.ts ProviderProfile; bin/raw.ts config init/list; tests/config.test.ts and tests/foundation-cli.test.ts.
### Pattern
Reuse duplicate/unknown JSON detection, selected-only key resolution and immutable runtime config.
### Dependencies
None.
### Files and symbols
src/config.ts, src/llm/types.ts, src/llm/client.ts, src/llm/openai.ts, src/llm/anthropic.ts, src/llm/google.ts, src/llm/cache.ts, src/compact.ts, src/agent.ts, src/cli.ts, src/acp/methods.ts, bin/raw.ts, src/index.ts, all tests and fixtures that construct old ProviderProfile or flat config, docs/configuration.md.
### Behavioral contract
- Core new root and model/profile references validate before any provider/MCP connection. Missing model alias, duplicate/unknown fields, invalid implemented method, invalid endpoint, bad budget, both key sources and empty literal key fail clearly. Phase 1 accepts only the three existing executable methods and moves existing cache hints plus manual compact settings into profile scope so existing behavior tests stay meaningful. Phase 2 adds openai-responses and typed frontier request controls; Phase 3 adds MCP/tool-policy fields, Phase 4 adds vision, and Phase 5 adds automatic compact. Do not accept a field before its behavior works.
- Literal api_key and api_key_env are mutually exclusive; only selected model key resolves. Known provider defaults are explicit. Config list shows profile, local alias, upstream model ID, provider and method without secrets.
- --profile/default_profile select a complete run. Old flat profiles and removed direct flags/env overrides are rejected, not normalized.
### Documentation
Write the exact Phase 1 core schema, default values, precedence and credential handling before code; extend the reference in each later phase when that field becomes executable.
### Tests first
Red tests for two profiles sharing one model, two model aliases using different implemented methods, direct key versus env key, inactive missing env credential, wrong references, invalid budgets and removed old flags/schema. Replace all legacy-shaped test fixtures across provider, agent, CLI, ACP, MCP and package tests before the full gate.
### Anti-shortcut coverage
A model alias flash must send upstream model_id deepseek-flash; changing profile must change request policy without duplicating model config. A hidden direct override must not let a user bypass profile policy.
### Implementation obligations
Separate parsed model specs from selected run settings; mechanically update existing adapter dispatch, cache/usage, agent, CLI, ACP, exports and all affected fixtures to consume the new resolved shape. Preserve only already-implemented behavior; add no old-shape shim. Isolate subprocess tests from the developer's home config, which is still in the old shape until final qualification.
### Acceptance criteria
- [x] AC-1.1: Only the new schema resolves model/profile identity and exact upstream ID — proven by config and CLI tests.
- [x] AC-1.2: Direct/env key choices work without leaking selected or inactive secrets — proven by config/list/error tests.
- [x] AC-1.3: Removed direct overrides and invalid references fail before connection — proven by parser and config tests.
- [x] AC-1.4: All existing consumers and fixtures run on the new resolved type with the full suite green and no legacy adapter — proven by npm run check.
### Focused verification
node --import tsx --test tests/config.test.ts tests/foundation-cli.test.ts
### Phase gates
npm run typecheck && npm run check && npm run test:overhead && git diff --check
### Review
codex-impl-review with gpt-6-astra; verdict must be APPROVE.
### Commit
feat: split model access paths from runnable profiles

## Phase 2: Dispatch API methods and typed frontier controls
### Status
complete
### Goal
Add a working OpenAI Responses adapter and typed per-profile request/cache controls on top of Phase 1 method dispatch.
### Current behavior and gap
At baseline src/llm/client.ts dispatches on provider and src/llm/openai.ts only calls Chat Completions. Phase 1 moves the three existing adapters to method dispatch; Responses and frontier request fields remain absent until this phase.
### Evidence
src/llm/client.ts createProvider; src/llm/openai.ts; src/llm/anthropic.ts; src/llm/google.ts; src/llm/cache.ts; src/compact.ts; tests/providers.test.ts, cache.test.ts, usage.test.ts.
### Pattern
Reuse official SDKs, stream decoders, local HTTP/SSE fixtures and opaque assistant state replay.
### Dependencies
Phase 1 normalized model/profile runtime types and mechanically updated all existing consumers/tests.
### Files and symbols
src/llm/client.ts, src/llm/openai.ts, new src/llm/responses.ts, src/llm/anthropic.ts, src/llm/google.ts, src/llm/cache.ts, src/llm/types.ts, src/compact.ts, tests/providers.test.ts, tests/provider-content.test.ts, tests/cache.test.ts, tests/usage.test.ts, docs/providers.md, docs/context.md.
### Behavioral contract
- The fourth method uses the real official-SDK Responses endpoint. Responses handles streamed function calls/results, abort, usage, reasoning/state replay and cached prefixes; Chat Completions keeps DeepSeek thinking state when tools are present.
- Request fields use provider+method-specific typed validation. No unrestricted JSON passthrough and no OpenAI-only field on a generic compatible endpoint. Invalid option combinations fail before network.
- Cache hints and usage parsing follow actual API format and verified service features; unknown providers get no guessed hints.
### Documentation
Record method/provider matrix, concrete request fields, cache limits and support exclusions.
### Tests first
Fixture-wire tests for each method with a tool-turn continuation; Responses reasoning/function item replay; DeepSeek reasoning_content after both tool and ordinary assistant turns; invalid option rejections and cache/usage reports.
### Anti-shortcut coverage
A custom provider using Anthropic Messages must not hit Chat Completions; GPT-6 Astra tool use must hit Responses; accepting method string without wire implementation fails. Verify session cache key and tool schema order remain stable across turns.
### Implementation obligations
Audit every branch on profile.provider, moving method selection to method and retaining only verified service-specific conditions. Preserve streaming/cancellation and no automatic retries.
### Acceptance criteria
- [x] AC-2.1: Four methods complete a streamed tool call and continuation with correct request bodies — proven by local provider fixtures.
- [x] AC-2.2: Frontier options reject unsupported combinations and arrive at the intended wire field — proven by request fixture tests.
- [x] AC-2.3: Cache/usage metrics remain correct and session prefix stays stable — proven by cache/usage tests.
### Focused verification
node --import tsx --test tests/providers.test.ts tests/provider-content.test.ts tests/cache.test.ts tests/usage.test.ts
### Phase gates
npm run typecheck && npm run check && npm run test:overhead && git diff --check
### Review
codex-impl-review with gpt-6-astra; verdict must be APPROVE.
### Commit
feat: route configured methods through verified SDK adapters

## Phase 3: Select MCP tools and enforce profile tool policy
### Status
complete
### Goal
Start only profile-selected MCP servers and apply allow/ask/deny to all model-visible and dispatched tools.
### Current behavior and gap
src/tools/mcp-client.ts reads separate MCP config and connects all configured servers. src/tools/registry.ts gates approval with a global autoApprove boolean and has no deny rules.
### Evidence
src/tools/mcp-client.ts loadMcpConfig/connectMcpServers; src/tools/registry.ts definitions/dispatch; src/cli.ts runCli; src/acp/methods.ts sessionMcpServers/session/new; tests/mcp.test.ts, registry.test.ts, cli.test.ts, acp.test.ts.
### Pattern
Reuse MCP SDK connection/validation, registry aliasing, CLI TTY prompt and ACP session/request_permission.
### Dependencies
Phase 1 schema; Phase 2 provider requests.
### Files and symbols
src/tools/mcp-client.ts, src/tools/registry.ts, src/tools/primitives.ts, src/agent.ts, src/cli.ts, src/acp/methods.ts, bin/raw.ts, tests/mcp.test.ts, tests/registry.test.ts, tests/cli.test.ts, tests/acp.test.ts, docs/mcp.md, docs/tools.md, docs/acp.md.
### Behavioral contract
- Top-level mcp.servers definitions are inert until a profile selects them. Profile map selects exact names or *; unknown server/tool fails startup clearly. Stable canonical identity is used for rules, independent of generated LLM alias.
- Default execution is allow. Rules evaluate in order, last match wins. Deny hides from LLM and rejects direct dispatch, ask prompts once per call through TTY/ACP, and absent approval channel returns approval_required. -y cannot bypass explicit ask.
- ACP-injected ephemeral tools use their own canonical prefix and obey profile rules; ACP-supplied session MCP servers are explicit session selections and obey the same rules. No normal profile unexpectedly starts all configured servers.
### Documentation
Describe MCP transports, per-profile selection, policy grammar, no sandbox and ask behavior.
### Tests first
Red tests for zero selected servers, exactly one selected server, unknown selected tool, stable aliases/order, deny schema+dispatch, ordered wildcard rule, ask on CLI/ACP, headless fail closed, -y not bypassing ask.
### Anti-shortcut coverage
Call a denied tool directly through registry and ACP extension even after hiding it from schema; it must not execute. Assert server process never starts when it is only configured, not selected. Verify canonical policy still works if LLM alias changes.
### Implementation obligations
Compile policy once per session, apply at both view and dispatch, keep approval abortable, preserve MCP shutdown and permission event handling.
### Acceptance criteria
- [x] AC-3.1: Only selected MCP servers/tools are connected and exposed in stable order — proven by MCP fixtures.
- [x] AC-3.2: allow/ask/deny applies consistently to built-ins, MCP and ACP injections — proven by registry/CLI/ACP tests.
- [x] AC-3.3: Unmatched tools auto-run, explicit ask cannot be bypassed by -y, and no approval channel fails closed — proven by CLI/ACP tests.
### Focused verification
node --import tsx --test tests/mcp.test.ts tests/registry.test.ts tests/cli.test.ts tests/acp.test.ts
### Phase gates
npm run typecheck && npm run check && npm run test:overhead && git diff --check
### Review
codex-impl-review with gpt-6-astra; verdict must be APPROVE.
### Commit
feat: select MCP tools and enforce per-profile tool rules

## Phase 4: Add conditional native vision tool
### Status
complete
### Goal
Expose view_image only for models explicitly configured with vision:true, while preserving MCP vision-to-text for text-only models.
### Current behavior and gap
The registry has only three built-ins. Existing tool result types/adapters can encode some images, but no local image-reading tool exists and capResult may replace large images with a text omission marker.
### Evidence
src/tools/registry.ts builtIns; src/tools/primitives.ts readFileTool; src/tools/results.ts capResult; src/tools/types.ts ToolContentImage; src/llm/content.ts nativeToolContent; src/llm/openai.ts inputMessages; src/llm/anthropic.ts inputMessages; src/llm/google.ts inputContents; tests/provider-content.test.ts, primitives.test.ts, overhead.test.ts.
### Pattern
Reuse ToolContentImage and nativeToolContent instead of introducing a parallel attachment state machine.
### Dependencies
Phases 1-3 establish model/profile types, method adapters and policy; this phase adds and activates the vision field.
### Files and symbols
src/tools/registry.ts, src/tools/primitives.ts or new src/tools/image.ts, src/tools/results.ts, src/llm/content.ts, src/llm/openai.ts, src/llm/responses.ts, src/llm/anthropic.ts, src/llm/google.ts, src/agent.ts, tests/primitives.test.ts, tests/provider-content.test.ts, tests/agent.test.ts, tests/overhead.test.ts, docs/tools.md, docs/providers.md.
### Behavioral contract
- A non-vision model has exactly three default built-ins and no view_image schema. A vision model gets view_image {path:string}; relative paths resolve against session cwd, reading PNG/JPEG only, with a separate image byte limit.
- A successful view_image call makes the selected model receive real image content in a valid adapter-specific continuation, including an image larger than the normal 8192-byte text cap. For Chat Completions this may require a linked text tool result followed by an image user content block; a placeholder alone is not success. Unreadable/invalid/oversized file returns a structured error without leaking base64.
- Unsupported method+vision config fails before inference; an upstream model rejection is visible, never converted into a fake text image description. Profile tool policy can ask/deny view_image.
### Documentation
Show raw "Explain screenshot.png" with no image flag, model vision switch and MCP text fallback.
### Tests first
Red tests for conditional tool set, real PNG/JPEG magic checks, relative path, >8 KiB valid image not omitted, oversize/bad file errors, adapter image wire content, and non-vision MCP description.
### Anti-shortcut coverage
Inspect fixture request bytes/content type after a view_image call: a placeholder-only result or base64 passed as ordinary text fails. Accept an adapter-valid linked tool result plus real image block. Assert base profile overhead remains unchanged and text-only model never receives image content.
### Implementation obligations
Bound file read and encoded payload, bypass only text cap for image blocks, keep image data out of logs and public events, and validate every enabled method adapter.
### Acceptance criteria
- [x] AC-4.1: vision false -> 3 tools; vision true -> 4 tools; no --image flag — proven by config, registry and CLI tests.
- [x] AC-4.2: view_image delivers real image content in a valid continuation over each enabled API method and retains >8 KiB images — proven by provider wire tests.
- [x] AC-4.3: text-only model can use MCP vision-to-text without any image bytes upstream — proven by MCP/provider fixture test.
### Focused verification
node --import tsx --test tests/primitives.test.ts tests/provider-content.test.ts tests/agent.test.ts tests/overhead.test.ts
### Phase gates
npm run typecheck && npm run check && npm run test:overhead && git diff --check
### Review
codex-impl-review with gpt-6-astra; verdict must be APPROVE.
### Commit
feat: add opt-in vision tool without base prompt growth

## Phase 5: Automate compact without losing cache or image safety
### Goal
Trigger visible, budget-safe compaction from profile settings while preserving multi-turn cache reuse.
### Current behavior and gap
AgentSession.compact is explicit only. src/compact.ts compares JSON byte size and includes complete tool-result data; auto threshold and image-safe summary input do not exist.
### Evidence
src/agent.ts run/compact and cacheKey; src/compact.ts performCompaction; src/llm/cache.ts normalizeUsage; tests/compact.test.ts, tests/cache.test.ts, tests/repl.test.ts.
### Pattern
Reuse existing transactional compact operation, usage events, separate compact cache key and stable request order.
### Dependencies
Phases 1-4 complete profile settings, usage adapters, tool policy and vision results.
### Files and symbols
src/agent.ts, src/compact.ts, src/llm/cache.ts, src/config.ts, src/cli.ts, src/acp/methods.ts, tests/compact.test.ts, tests/cache.test.ts, tests/repl.test.ts, tests/acp.test.ts, docs/context.md, docs/configuration.md.
### Behavioral contract
- Absent trigger_tokens means manual compact only. When configured, validate trigger < model context budget after output reserve and safety margin.
- Before each inference, estimate the complete upcoming request, including system/tools, all replayed transcript and opaque reasoning, newly returned assistant/tool text, new image content and output reserve. Use prior provider usage only as calibration, not as a substitute for the new content estimate. Auto compact at threshold at most once per turn; then recompute and reject a still-over-budget request. Emit event and usage; failure/noop/not_smaller preserves transcript and returns a clear reason without recursion.
- Use the selected session model for summary requests in v1. Budget the actual serialized summary instructions/input plus output reserve against its own context window. Split older turns into bounded chronological chunks and chain summaries when needed; fail clearly if one irreducible chunk cannot fit. No image base64 enters summary prompts. Keep recent image-bearing turns only when they fit the recomputed main budget; older images become path/MIME/size references. Never claim estimates are exact.
### Documentation
Explain trigger units, fallback estimate limits, visible cost and cache behavior.
### Tests first
Red tests at threshold boundary, tool-output growth, replayed reasoning growth, image-bearing continuation, missing usage fallback, one-compact-per-turn, no-op/non-smaller safety, abort, summary JSON expansion/chunking, insufficient summary capacity, post-compact over-budget rejection, cache key stability, and zero base64 leakage into summary prompt.
### Anti-shortcut coverage
A naive check based only on last provider usage must fail when a large tool result, image or reasoning item is pending. A byte-only compact that serializes an image into the summary prompt, or sends an over-budget summary request, must fail.
### Implementation obligations
Keep compaction transactional, account usage once, and keep stable prefix/tool ordering after compact.
### Acceptance criteria
- [ ] AC-5.1: Opt-in threshold triggers once before a would-be over-budget request using full upcoming context, and absent threshold stays manual — proven by compact tests with image/reasoning additions.
- [ ] AC-5.2: Compaction is visible, abortable and does not leak image base64 or lose usage accounting — proven by event/usage tests.
- [ ] AC-5.3: Summary requests are budgeted/chunked before submission and the post-compact main request is rechecked — proven by oversized-history and insufficient-capacity tests.
- [ ] AC-5.4: Multi-turn cache hints/prefix remain stable until a deliberate compact boundary — proven by request fixture tests.
### Focused verification
node --import tsx --test tests/compact.test.ts tests/cache.test.ts tests/repl.test.ts tests/acp.test.ts
### Phase gates
npm run typecheck && npm run check && npm run test:overhead && git diff --check
### Review
codex-impl-review with gpt-6-astra; verdict must be APPROVE.
### Commit
feat: add profile-controlled automatic compaction

## Phase 6: Align public surfaces and qualify installed package
### Goal
Make documentation, CLI, ACP, package consumer and local installed configuration agree with the new contract.
### Current behavior and gap
Phase 1 must already update mechanical help/init/list, ACP runtime and fixture consumers so its full gate can pass. This phase audits the final behavior and documentation; the user's installed config still uses the old schema until final qualification.
### Evidence
bin/raw.ts; src/acp/methods.ts runtime info; src/index.ts exports; README.md; docs/cli.md, configuration.md, mcp.md, acp.md, providers.md, verification.md; tests/cli.test.ts, acp.test.ts, package.test.ts.
### Pattern
Reuse subprocess/PTY, official ACP SDK, packed-consumer and installed-byte verification tests.
### Dependencies
Phases 1-5 reviewed and committed.
### Files and symbols
bin/raw.ts, src/acp/methods.ts, src/index.ts, README.md, docs/architecture.md, docs/cli.md, docs/configuration.md, docs/mcp.md, docs/tools.md, docs/acp.md, docs/providers.md, docs/context.md, docs/verification.md, tests/cli.test.ts, tests/acp.test.ts, tests/package.test.ts.
### Behavioral contract
- Config init emits the new model/profile schema. Help/list and ACP runtime info reflect selected profile/model/method/vision/MCP/tool policy with secrets redacted. No old schema or obsolete flag is advertised. Phase 6 closes integration gaps left by earlier phases rather than deferring mandatory Phase 1 consumer changes.
- Packed consumer runs a tool turn with new config, including a profile-selected MCP tool and a vision-enabled fixture; no workspace-only import assumptions.
- The current ~/.config/raw/config.json has two old-shape profiles: local Ollama placeholder and DeepSeek with an env-backed key. After all gates, back up the entire file, rewrite both entries into the new models/profiles schema so strict whole-file validation succeeds, preserve the DeepSeek env source and unrelated user files, install the exact npm pack tarball globally, and compare hashes. Run a bounded read-only multi-turn DeepSeek session without -y; record prompt_cache_hit_tokens and prompt_cache_miss_tokens for each request and classify actual hit versus inconclusive zero-hit behavior.
### Documentation
Replace the discussion note with final docs/config-design.md, update all user references and evidence with exact tested commands/hashes; remove obsolete plan references.
### Tests first
Red CLI/ACP/package tests for init/list/help, profile binding, policy, MCP, vision and redaction. Use fixture credentials only.
### Anti-shortcut coverage
Test installed packed bytes, not just source imports. Ensure ACP cannot bypass profile policy through injected tools and config list cannot expose literal api_key. Assert the live multi-turn wire prefix stays eligible for reuse; if cache hit counters stay zero, investigate and report that actual reuse was not observed instead of declaring a hit.
### Implementation obligations
Keep protocol-standard ACP methods, update public types/examples, and preserve unrelated local files during the final one-time user setup. Test isolation from the old home config is a Phase 1 requirement, not deferred here.
### Acceptance criteria
- [ ] AC-6.1: All public surfaces and packed consumer use only new schema with no secret leakage — proven by CLI/ACP/package tests and doc inspection.
- [ ] AC-6.2: Global binary bytes match packed build and a live read-only multi-turn DeepSeek session works without -y; real cache-hit/miss counters are recorded and any zero-hit result is investigated and marked inconclusive — proven by installed hash, smoke output and usage report.
- [ ] AC-6.3: Each phase review is APPROVE; all global gates pass — proven by review records and command results.
### Focused verification
node --import tsx --test tests/cli.test.ts tests/acp.test.ts tests/package.test.ts
### Phase gates
npm run check && npm run test:overhead && npm run test:package && npm exec --yes --package=node@22 -- node scripts/verify-runtime.mjs && npm exec --yes --package=node@24 -- node scripts/verify-runtime.mjs && git diff --check
### Review
codex-impl-review with gpt-6-astra; verdict must be APPROVE.
### Commit
docs: complete config redesign and installed qualification

## Completion Criteria
- All six phase acceptance sets and global gates pass with explicit gpt-6-astra implementation review APPROVE and cohesive commits.
- The shipped config has separate models/profiles, exact upstream model_id, provider/method separation, direct/env keys, typed request controls, per-profile MCP and tool policy, conditional view_image, and opt-in auto compact.
- Base prompt and three-tool overhead remains bounded; no legacy schema/CLI compatibility code remains; MCP search and external vision-to-text work with text-only models.
- Installed packed bytes and a live read-only multi-turn DeepSeek tool session are verified without a permission prompt or credential disclosure; actual cache counters and any inconclusive result are reported accurately.

## Progress Log
- 2026-09-24: Replaced obsolete provider/method-only draft with a full break-only config redesign plan grounded in inspected code and current design decisions. Plan review pending; no production code changed.
- 2026-09-24: Round 1 gpt-6-astra review returned REVISE on full upcoming-context budget, summary request budget, phase-1 green-gate dependencies and live cache evidence. Accepted all four findings and revised the plan; reviewer re-verification pending.
- 2026-09-24: Rounds 2 and 3 raw output explicitly returned APPROVE and no remaining issues. Runner zero-issue parser defect required explicit verdict override at finalization; plan review complete. No production code changed.
- 2026-09-24: User invoked loop-implement and approved execution of the reviewed plan. Phase 1 in_progress; preflight found only the two untracked design documents and HEAD 0ed50b0.
- 2026-09-24: Phase 1 complete. Docs-first config reference and red tests preceded implementation. `npm run check` 135/135, `npm run typecheck`, focused tests, `npm run test:overhead` (25 prompt tokens, three built-ins), and `git diff --check` passed. GPT-6 Astra implementation review round 1 found three defects; all fixed and round 2 raw verdict APPROVE. Runner verdict-only parser required explicit APPROVE finalization; record `.codex-review/sessions/codex-impl-review-20260924-010`.
- 2026-09-24: Phase 2 complete. Official API docs informed four SDK methods and typed controls. Red fixture tests proved missing Responses, DeepSeek reasoning replay and request options before implementation. `npm run check` 146/146, typecheck, focused tests, overhead and diff check passed. GPT-6 Astra review found three cap/budget defects, all fixed; round 2 raw verdict APPROVE and explicit parser override recorded at `.codex-review/sessions/codex-impl-review-20260924-011`.
- 2026-09-24: Phase 3 complete. Docs-first reference and red tests preceded single-file MCP selection and canonical allow/ask/deny policy. `npm run check` 161/161, typecheck, focused tests, overhead and diff check passed. GPT-6 Astra review found two defects (newline glob bypass, empty stdio argument rejection), both fixed; round 2 raw verdict APPROVE and explicit parser override recorded at `.codex-review/sessions/codex-impl-review-20260924-012`.
- 2026-09-24: Phase 4 complete. Docs-first reference and red tests preceded conditional `view_image` with real native payloads across four adapters, separate image cap, public event redaction and text-only MCP fallback. `npm run check` 168/168, typecheck, overhead 25 prompt tokens/three base tools, and diff check passed. GPT-6 Astra review found three defects (truncated image validation, FIFO hang, uncapped text errors), all fixed with regressions; round 2 raw verdict APPROVE and explicit parser override recorded at `.codex-review/sessions/codex-impl-review-20260924-013`.
