# Build raw-cli: small-context coding harness with reliable multi-turn caching

## User correction after initial implementation (2026-09-24)

The CLI and ACP execute exposed tools automatically with the invoking account's full permissions. This supersedes the TTY and headless approval defaults in D-03 and related approval test expectations below. `-y` remains accepted for compatibility but is unnecessary. Library callers may explicitly opt into approval callbacks with `autoApprove: false`.

## Plan schema
loop-plan/v1

## Target
Deliver the `raw-cli` package, `raw` executable, and TypeScript library: a lightweight coding agent for local models with small context windows. Preserve useful context for the task, code, and tool results; provide explicit compaction, easy configuration of multiple LLM sources, and the greatest practical multi-turn prefix-cache reuse without increasing prompt size to chase cache hits.

This document is self-contained. The implementing agent must not need the original chat. The user explicitly authorized implementation of this named plan and required `gpt-6-astra` implementation review for every phase. Self-review APPROVE below does not complete an implementation phase.

## Scope
### Confirmed user decisions
- Node.js **22+**; TypeScript strict, ESNext, ESM; npm package `raw-cli`, command `raw`.
- Exactly three default model tools: `read_file`, `write_file`, `bash`.
- Full permissions of the invoking OS account, **no OS sandbox or filesystem jail**. Optional approval/whitelist controls are orchestration, not isolation.
- Official SDKs for OpenAI, Anthropic, and Google Gemini; OpenRouter, Ollama, and custom compatible endpoints supported through the OpenAI-compatible adapter.
- MCP supplies additional capabilities. Do not implement browser automation, interactive terminals, background-job management, IDE buffers, or extra primitives in the harness.
- **Agent Client Protocol** for IDE/parent-agent integration. The original `acp.handshake`/`acp.session.run` API is replaced by standard ACP methods, with explicit namespaced extensions where necessary.
- One-shot, terminal REPL, ACP stdio and local WebSocket; parent-client library/example can spawn raw as a child agent.
- Compaction is required; multiple LLM sources must be easy to configure; multi-turn cache reuse is required.

### Implementation defaults selected by this plan
These are concrete defaults, not claims the user specified every numeric value: manual `/compact` initially; last two completed turns retained; summary output budget 512 tokens; model-facing tool text cap 8 KiB; max 25 inference steps per run; shell/external operation timeout 120 seconds; explicit MCP tool selection. Profile examples and all defaults are documented and tested.

### Deliverables and exclusions
Deliver production modules, lockfile, README, config/protocol references, tests, reproducible build, installed-package smoke tests, and phase evidence. Build with tsup; run development through tsx. The runnable packaged entrypoint satisfies the original binary/entrypoint alternative. A Bun standalone binary is optional.

Do not add automatic instruction-file loading, hidden context discovery, automatic provider fallback, hidden retry/summary calls, full-screen TUI frameworks, automatic git operations, telemetry, persistent chat storage, remote multi-user serving, npm publication, or deployment. Automatic threshold compaction and paid explicit Google cache-resource provisioning are not required in v1. This does not exclude explicit `/compact` or provider-native cache metadata.

macOS/Linux are initial targets. Verify the actual host and Node 22/24; supply Linux/macOS CI configuration. Windows qualification and remote CI execution are not completion prerequisites and must never be reported as passed unless run. The user's Windows machine instructions apply to CTXE qualification; they do not automatically authorize unrelated raw-cli qualification there.

## Invariants
- **I-01 Small input:** default prompt <=50 reference tokens; default prompt plus three tool schemas <=500 reference tokens. No prompt padding to reach provider cache thresholds.
- **I-02 Three primitives:** absent explicit external registrations, every adapter advertises exactly the same three built-ins. REPL/config/ACP commands are not model tools.
- **I-03 No hidden instructions:** no AGENTS.md, MCP server instructions, dates, cwd banners, approval text, stats, formatting rules, or workflow guidance enter model messages automatically. The short compaction instruction exists only in an explicit compaction request.
- **I-04 Stable history:** freeze prior model-visible messages, IDs, argument strings, result previews, system prompt, and ordered tool schemas; append new content. Re-reading files or rendering UI must not rewrite history.
- **I-05 Correct tool linkage:** never send orphan results or unresolved tool declarations in a subsequent inference request, including after denial, errors, cancellation, or limits.
- **I-06 Host permissions:** all operations resolve session cwd without process-wide `chdir`; absolute paths remain allowed. No claim that a whitelist or cwd constrains Bash's OS access.
- **I-07 Central dispatch:** validate arguments and current exposure/whitelist, then approval, then execute. Omitting a schema from the request alone is not permission enforcement.
- **I-08 Bounded and cancellable:** deadlines, output caps, process cleanup, and abort apply through inference, approvals, MCP, reverse callbacks, and child-agent connections.
- **I-09 Session ownership:** one active run or compact operation per session; other sessions remain independent. A peer cannot operate another peer's sessions or registrations.
- **I-10 Protocol purity:** ACP stdout contains protocol frames only. Diagnostics use stderr. Credentials never appear in logs, handshakes, usage, errors, or config-list output.
- **I-11 Honest caching:** cache reuses prefix computation, not context capacity or tool side effects. Missing cache counters are unknown. Matching request hashes do not prove server cache hits.
- **I-12 Honest verification:** no skipped required tests, swallowed errors, hardcoded fixture answers, disabled type checks, empty smoke tests, or unexecuted checks reported as passing.

## Baseline
- Initially inspected 2026-09-24: `/Users/lploc94/projects/raw-cli` was empty and had no Git repository/history or ancestor AGENTS.md. User supplied global instructions in the chat.
- At this handoff revision, the only deliverables are this plan and `raw-cli-implementation-handoff.md`. There is still no source, package, installed dependencies, Git history, or application test result. Git status/log return `fatal: not a git repository`.
- Therefore no existing project implementation patterns or code symbols can be cited. Every path below is a **planned** file. Patterns are established in Phase 1, then cited from actual code during subsequent phase reviews.
- CTXE: installed CLI status for this exact absolute path returned `Absent`, zero files/chunks. No CTXE MCP tools were attached. `ctxe-index-project` was read; `ignore list` succeeded. `ignore check` failed because the proposed source paths did not exist. That workflow stopped immediately; preview, dry-run, indexing, and fast_understand were not run. No ignore/config mutations occurred.
- Implementer preflight: recheck actual Git/tree and applicable instructions. If CTXE is mandated by that environment, confirm status and run fast_understand before understanding existing code. For Absent state, use `ctxe-index-project` with **existing** representative paths, never nonexistent planned filenames. Honor its indexing authorization rule. Do not fabricate subjects or substitute a different workspace. Greenfield file creation from this exact plan is not evidence of an indexed codebase. Do not repeatedly explore an empty source tree.
- Previously observed registry candidates: `openai` 7.23.0 (Node >=22), `@anthropic-ai/sdk` 0.128.0, `@google/genai` 2.24.0 (Node >=20), `@modelcontextprotocol/sdk` 1.30.1, `@agentclientprotocol/sdk` 1.5.0, tsup 8.5.1, tsx 4.23.15. These are research observations, not installed or qualified dependencies. Phase 1 pins and smoke-checks selected versions; changed APIs must not silently change this contract.

## Design and project patterns
### D-00 Normative language and ownership
MUST and MUST NOT define completion requirements. MAY describes an optional path. Numerical defaults, shapes, errors, and tests below are normative unless explicitly labeled optional. Resolve implementation details locally; ask before changing a public contract or deleting a requirement. A failing test is not permission to weaken that requirement.

| Owner | Planned files | Responsibility |
|---|---|---|
| Configuration | `src/config.ts`, `src/llm/prompt.ts` | Validated immutable settings, named profiles, exact prompt |
| Providers | `src/llm/{types,client,openai,anthropic,google}.ts` | Official SDK requests, stream decoding, preserved provider state |
| Tools | `src/tools/{types,registry,primitives,process,results}.ts` | Schemas, validation, execution, bounded results, cleanup |
| Agent | `src/agent.ts` | Append-only conversation/tool loop and run events |
| Context | `src/compact.ts`, `src/llm/cache.ts` | Explicit atomic compaction, cache options/usage normalization |
| MCP | `src/tools/mcp-client.ts` | Connections, discovery, selected exposure, result conversion |
| ACP | `src/acp/{rpc,methods,transport,client}.ts` | SDK protocol, sessions, extensions, parent-client lifecycle |
| CLI | `bin/raw.ts`, `src/cli.ts`, `src/index.ts` | Thin executable, REPL, library exports |

Helper-file boundaries may be combined where clearer; responsibilities and tests may not be dropped. No framework, service container, plugin marketplace, database, or second orchestration engine is needed.

### D-01 Exact prompt and model-facing schema budget
Use this default text verbatim:

```text
You are a terminal coding assistant. Use read_file, write_file, and bash to complete tasks. Respond concisely.
```

Override precedence is `--system-prompt` literal string > `RAW_SYSTEM_PROMPT` > default; explicitly empty string is valid. Do not append rules to overrides.

Built-in schemas: `read_file` requires only `path: string`; `write_file` requires `path: string, content: string`; `bash` requires `command: string`, with optional positive integer `timeout_ms`. Object schemas reject unknown properties. Use short functional descriptions. No built-in tool-search, patch, web, compact, or sub-agent tool.

Budget oracle: a development-only `o200k_base` tokenizer counts (a) the exact default text <=50 and (b) canonical `JSON.stringify({system: defaultText, tools: normalizedBuiltInDefinitions})` <=500. Sort object keys recursively while preserving array order; publish the exact serialized input and counts in a fixture/report. The three actual exported production definitions must be measured, not smaller duplicate test schemas. External schemas, user overrides, provider framing and provider tokenizers are reported separately; do not claim a universal 500-token wire bound.

### D-02 Configuration and multiple sources
Runtime config path: `$XDG_CONFIG_HOME/raw/config.json`, otherwise `~/.config/raw/config.json`. `--config <path>` replaces that source; missing implicit config is allowed, missing explicit config is an error. Strict JSON, no implicit dotenv. No project runtime config merging in v1.

```json
{
  "default_profile": "local",
  "profiles": {
    "local": {
      "provider": "ollama",
      "model": "YOUR_INSTALLED_MODEL",
      "base_url": "http://127.0.0.1:11434/v1",
      "context_window": 8192,
      "max_output_tokens": 1024
    },
    "local-server": {
      "provider": "openai-compatible",
      "model": "YOUR_SERVED_MODEL",
      "base_url": "http://127.0.0.1:8080/v1",
      "cache": {"mode": "auto", "backend": "llama.cpp"}
    },
    "cloud": {
      "provider": "openai",
      "model": "YOUR_OPENAI_MODEL",
      "api_key_env": "OPENAI_API_KEY"
    },
    "claude": {
      "provider": "anthropic",
      "model": "YOUR_ANTHROPIC_MODEL",
      "api_key_env": "ANTHROPIC_API_KEY"
    },
    "gemini": {
      "provider": "google",
      "model": "YOUR_GEMINI_MODEL",
      "api_key_env": "GEMINI_API_KEY"
    }
  },
  "compact": {"keep_recent_turns": 2, "max_output_tokens": 512}
}
```

Provider enum: `openai`, `openai-compatible`, `openrouter`, `ollama`, `anthropic`, `google`. Multiple profiles may share provider, endpoint, or model. Do not infer provider from the model string.

Profile selection: `--profile` > `RAW_PROFILE` > `default_profile`; unknown name fails before network activity. Selected profile is the baseline; individual flags override environment, which overrides that baseline. Without a profile, direct `--provider/--model/--base-url` and `RAW_PROVIDER/RAW_MODEL/RAW_BASE_URL` work. With a profile, a conflicting provider/base-URL override fails rather than combining another endpoint with that profile's credentials; identical overrides and model-only overrides are allowed.

Credentials: `api_key_env` names an environment variable; no literal key field. Resolve only the selected profile when needed. Default variables: OpenAI `OPENAI_API_KEY`, Anthropic `ANTHROPIC_API_KEY`, Google `GEMINI_API_KEY` then `GOOGLE_API_KEY`, OpenRouter `OPENROUTER_API_KEY`. Ollama requires no real key. Generic compatible endpoints require `base_url`; an optional `api_key_env` supports authenticated endpoints. Redact URL userinfo/query values as well as headers/keys in diagnostics. Missing credentials in unused profiles must not break local execution. An alternate compact profile's credentials are required only when compact is invoked. Never fall back between sources automatically.

Defaults for provider endpoints come from the official SDK, except Ollama `http://127.0.0.1:11434/v1` and OpenRouter `https://openrouter.ai/api/v1`. Custom endpoints are explicit. Google v1 targets Gemini Developer API, not Vertex AI. Each selected model must support tool calling; unsupported capability errors are actionable, with no model substitution.

`max_output_tokens` is optional; map it using the actual endpoint's documented parameter. `context_window` is optional user-provided metadata for display/validation, not a claim of exact tokenization or automatic fit enforcement. If both are supplied, require positive integers and output budget < context window. Never guess exact remaining capacity from characters or bytes. These values do not cause hidden compaction.

`raw config init`: create a valid starter with an obvious local model placeholder; refuse to overwrite, do not contact a model. `raw config list`: show profile name/provider/model/sanitized endpoint without resolving keys. Help, version, init/list require no inference credentials. README must show adding a second source and running `raw --profile <name>`.

### D-03 Runtime limits, output, and approvals
| Setting | Interface | Default / contract |
|---|---|---|
| Run steps | `--max-steps`, `RAW_MAX_STEPS` | 25 LLM requests, positive integer |
| Tool output | `--max-output-bytes`, `RAW_MAX_OUTPUT_BYTES` | 8192 retained content bytes per result |
| Shell deadline | `bash.timeout_ms` | 120000 ms, positive integer override |
| Network/callback deadline | `--request-timeout-ms`, `RAW_REQUEST_TIMEOUT_MS` | 120000 ms per inference, MCP operation, or reverse tool request |
| Approval | `--auto-approve`, `-y` | Prompt when TTY; noninteractive tools require explicit auto-approve |
| Shell executable | `RAW_BASH_PATH` | Bash resolved from PATH; clear error if unavailable |

Flags override environment. Reject NaN, fractions, zero, negatives, overflow, and unknown flags before opening MCP or inference connections. Timeout includes waiting for stream completion; users may raise it for slow local models. Human approval is cancellable but has no arbitrary network timeout.

`read_file`: resolve session path; read UTF-8, bounded to the retained prefix plus enough bytes to identify truncation, without loading an arbitrarily large file. `write_file`: create parents and create/overwrite; empty content is valid; report success only after completion. `bash`: execute Bash, capture stdout/stderr separately, include exit code/signal/deadline status. No exit=0 fabrication on timeout or signal. Treat nonzero exits as tool results the model can inspect.

Output cap applies to retained model-facing content from files, shell, MCP and callback tools, not user prompts or `write_file` input. For Bash allocate one shared byte budget in observed stream-arrival order; keep separate stdout/stderr fields. Continue draining discarded bytes to avoid pipe deadlock and unbounded buffers. Never split a UTF-8 character; the retained count may be less than the cap. Attach short `truncated`, byte-count, and error/status metadata outside the content budget. Include total observed bytes only if actually known. Oversized structured JSON becomes a labeled text preview; never claim a broken JSON prefix is a valid object. Commit the preview once; later cap changes do not rewrite old history. Do not store discarded output secretly or append duplicate text/JSON representations.

Approvals apply to all exposed tools consistently: validate/exposure/whitelist first, ask once, then execute. Denial returns `approval_denied` without side effects. At a noninteractive CLI, first attempted tool without `-y` terminates with `approval_required`, exit 2, without waiting forever or running it. TTY one-shot and REPL use the same prompt; `-y` skips approval but not schema/exposure checks. Library/ACP callers inject approval handlers; ACP uses standard permission requests unless explicitly launched with `-y`.

### D-04 Process ownership and cancellation
Each Bash invocation owns its process group on POSIX. Abort/timeout sends TERM, waits at most 500 ms, then KILL to surviving owned group members; drain/reap and settle within an additional 2000 ms test budget. Killing only the shell parent is insufficient. Never kill unrelated user processes. Deliberately daemonized processes that escape the group are outside the guarantee and are documented; built-in Bash is not a persistent/background-job API. Document using MCP for managed interactive/long-lived jobs.

Propagate a linked AbortSignal to SDK calls, MCP requests, approval waits, reverse callbacks and child agent operations. Stop dispatching queued tools after abort. Remote cancellation is best-effort: ending a request does not prove a remote server reversed side effects. Late replies cannot restart a cancelled run or mutate its transcript. All finally paths remove listeners, timers and owned transport/process resources. Do not use `process.exit()` as a substitute for cleanup.

### D-05 Providers and normalized events
Use official SDK clients in production and in adapter integration tests. Select one documented stream API per family: OpenAI Chat Completions for OpenAI/compatible/OpenRouter/Ollama, Anthropic Messages, Google generateContentStream. Do not silently route Google's API through OpenAI compatibility or mix Google Interactions usage fields with generateContent usage. A future switch to another API requires recorded contract review, not opportunistic partial migration.

Normalize text deltas, completed assistant content/tool calls, usage, terminal outcome and errors. Retain provider-required opaque blocks (Anthropic thinking/signature blocks, Google thought signatures) without displaying private reasoning or dropping data required for the next request. No automatic reasoning policy is injected. Preserve original call IDs; if an API omits an ID, assign one stable internal ID once and map to that API's name-based results correctly.

Collect fragmented tool arguments to completion; never execute partial JSON. Multiple tool calls can arrive interleaved in a stream. Validate complete arguments before dispatch. Assistant calls execute sequentially in provider-declared order. Malformed/unknown/disallowed calls produce matching error results and no side effects; a malformed response that cannot form valid linkage is a terminal provider error. Disable SDK retries (or the SDK equivalent); do not silently retry inference after partial output or re-execute tools.

Exports have concrete behavior, not necessarily exact internal type names: `loadConfig`, `createProvider`, `createToolRegistry`, `createAgent`, `compactSession`, `connectMcpServers`, `createAcpServer`, `createAcpClient`. Provider selection is a small factory, not a second agent framework. Export declaration files and callable library entrypoints in the packed artifact.

### D-06 Conversation state and bounded agent loop
A **turn** starts with a user submission and includes all assistant/tool rounds until one terminal outcome. A **step** is exactly one inference request. `/compact` is a separate explicit request and is not charged to a previous task's step budget. `/clear` and `/stats` make zero inference requests.

```text
idle -> running -> idle
idle -> compacting -> idle
running/compacting -> cancelling -> idle
any state -> closing -> closed
```

Reject a second run/compact/config mutation while busy. Distinct sessions have distinct cwd, transcript, tool view, controller, and usage; do not use process-wide mutable state for them.

Loop: append user input -> request model -> fully assemble assistant turn -> if final answer, commit and stop -> if tool calls and another inference step is available, commit declarations, dispatch sequentially, append results -> next request. If the last permitted step requests tools, **do not execute those tools**; report `max_steps` and do not commit dangling declarations. Max=1 permits one answer request and zero tools. Never make a 26th request at default settings.

Streaming output may be shown before it is committed. Interrupted partial assistant text/call fragments are not committed as a complete turn. Already committed declarations with executed tools retain their real results; append matching `cancelled` error results for remaining declared calls before allowing a later inference request. Do not roll back a filesystem edit in history as though it never happened. On provider failure without committed calls, preserve the user request and earlier valid history; mark the host turn terminal without inventing an assistant success.

Run events: `text_delta`, `tool_call` (committed declaration before validation), `tool_start`, `tool_result`, `usage`, and exactly one `run_end` with `completed|max_steps|cancelled|error`. Terminal events include a code/message on error, no credentials. `tool_start` occurs only after authorization and immediately before execution. A denied call produces a result with no misleading execution-start event. Completed empty assistant text is a valid empty answer when the provider declared completion; truncated/incomplete provider completion is an error, not success.

### D-07 Explicit compaction
Public paths: REPL `/compact`, library `compactSession`, negotiated ACP `_raw/session/compact`. No compact primitive is advertised to the model. Manual only in v1; do not add a threshold loop to satisfy this requirement.

1. Lock an idle session and snapshot immutable transcript/config. A first user message is the original task. A previously generated summary is explicit conversation data.
2. Retain the most recent two terminal turns verbatim by default (`compact.keep_recent_turns`, nonnegative integer), preserving complete call/result groups and opaque blocks. Pin the original user request once: if already in retained turns do not duplicate it; otherwise keep it separately.
3. Summary input consists of previous summary plus eligible older turns; original task may be supplied as orientation. No eligible older content means `noop` and zero requests.
4. Issue exactly one request with tools disabled, a short compaction-only instruction, and `compact.max_output_tokens` default 512. Ask for objective, constraints, decisions, completed work, changed file paths, unresolved failures and next work. Do not invent facts, call tools, or treat task text as system instructions.
5. Active profile is default. `compact.profile` may select another **explicitly configured** profile; show the destination before the request. Never choose a cloud profile automatically. The profile's model/prompt/cache handling does not change the main session's provider/system text.
6. Build replacement as original request (if separately pinned), labeled summary as user/context data, and retained turns in order. Summary is not a new system/developer instruction. Ensure valid provider history.
7. Require nonempty summary, output within the configured budget when measurable, and strictly smaller UTF-8 serialized model-facing transcript than the original. Record byte counts honestly; this is not exact provider-token counting. A retained suffix can make compaction non-shrinking; return `not_smaller` without mutation.
8. Swap atomically only on success. Failure, timeout, abort, invalid result, context-length rejection or non-shrinking result keeps original transcript byte-for-byte. No hidden chunked retries, dropping oldest turns, or provider fallback.

Summary quality is lossy; fixture tests verify known facts and structure without claiming perfect memory preservation. Preserve the resulting summary unchanged until the next explicit compact. `/clear` while idle resets transcript and history segment, retaining runtime/tools and cumulative session usage. Return statuses: `compacted`, `noop`, `not_smaller`, `cancelled`; provider failures return errors and rollback.

### D-08 Multi-turn cache behavior and metrics
A profile may set `cache: {mode?: "auto"|"no-hints", key?: string, retention?: string, backend?: "generic"|"llama.cpp"}`. Default mode auto. `no-hints` suppresses harness-added cache metadata, not the server's implicit cache. Pin the main request representation and stable key across related turns; never regenerate a per-request key. User keys are explicit strings; derived IDs must be opaque and contain no paths, prompts or secrets.

| Adapter | Required behavior |
|---|---|
| OpenAI | Stable prefixes; send only caching fields supported by the pinned Chat Completions SDK/API and selected model. Do not copy Responses-only breakpoints into this endpoint. Optional key/retention must be validated; unsupported explicit values fail clearly. |
| Anthropic | In auto mode activate documented request-level `cache_control` for multi-turn history. Keep required thinking blocks intact. Retention, if set, must be an SDK-supported value. |
| Google | Use supported implicit caching via stable generateContent requests and its usage metadata. Do not provision paid explicit cache resources. |
| Generic compatible/OpenRouter/Ollama | No guessed proprietary caching parameters; stable messages and explicit profile/model selection. Unknown cache metrics stay unknown. |
| Explicit llama.cpp backend | Send documented `cache_prompt: true` in auto mode. No implicit single shared slot ID. Other backends never receive that field. |

Phase 1/3 records the actual pinned API option matrix in `docs/providers.md`; if the SDK cannot expose a required capability, record the limitation and resolve it before marking the adapter complete. Do not create a false generic "cache enabled" flag with no request effect.

Deterministic tools: build the selected schema view once; sort external tools by stable alias, preserve primitive order `read_file`, `write_file`, `bash`; canonicalize schema object keys without sorting semantic arrays. Discovery timing must not change the prefix. Explicit idle schema/whitelist changes create a new schema revision and host event. Do not keep unused schemas to preserve cache or add a fake tool to communicate revisions.

Compaction/clear changes conversation prefixes, so do not promise old history remains cached. Keep unchanged system/tools. Do not rotate the main routing key merely because compact ran; its optional separate request key can use a stable `compact` suffix where supported. A separate profile name/HTTP connection is not cache isolation on a local single-slot server. Remote routing, minimum length, expiry and eviction can prevent a hit despite correct requests.

Normalize optional `inputTokensTotal`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, retaining raw provider usage off-prompt. Anthropic total input adds input + cache creation + cache read without double-counting TTL subtotals. OpenAI total includes cached reads; Google total uses the selected API's documented inclusive input count. Zero is only zero when reported; absent is unknown. Per-request ratio = reads / total only when both are known and valid; cumulative ratio sums only requests with both counts and reports that coverage. Never divide by zero or imply unknown requests missed cache. Show time-to-first-text and elapsed time separately, not as cache evidence. `/stats` and library/ACP host events expose usage without adding model messages.

### D-09 MCP connections, selection, and content
Config files: `$XDG_CONFIG_HOME/raw/mcp.json` (fallback `~/.config/raw/mcp.json`) then `./raw-mcp.json` relative to launch cwd. Shape `{mcpServers:{serverName:serverConfig}}`; project entries replace whole user entries by key. `serverConfig` is either `{command,args?,env?,tools?}` or `{url,transport?,headers?,tools?}`. Do not treat remote config as executable source.

`transport` supports `sse` and `streamable-http`; URL without transport means SSE to preserve the original prompt. Stdio uses the official SDK transport. No speculative transport retries on auth failure. A server config requires exactly one transport form. Tool selection is original-name list, `"*"` for explicit all, or empty/omitted for none. Query all discovery pages host-side; unknown selected names fail with a useful error. No discovery metadata or unselected schemas enter model context.

Use deterministic provider-safe aliases <=64 characters with collision-resistant suffix and an exact reverse map; primitives cannot be overwritten. A collision still detected after aliasing is an error, not last-wins. Maintain discovered tools separately from exposed handlers. Selection/whitelist controls schema **and** direct dispatch. JSON Schema validation must respect real external schemas; reject unsupported constructs explicitly rather than stripping constraints silently. Use a schema validator appropriate to the negotiated MCP dialect; no eval of model-supplied code.

Connect/discover once per owned connection, call tools, propagate AbortSignal/deadline, close all opened clients on partial startup failure. Do not reconnect in a loop or silently reduce the tool set. Handle remote `isError`, structured content and text without inventing success. Select structured content as the canonical representation when it duplicates equivalent textual JSON; preserve distinct text when it carries additional information under the same content budget.

MCP **images** are a required extension result path so screenshot/browser tools can actually supply vision input without a new primitive. Preserve MIME and bytes in typed internal content; map to each provider's supported native image input following its protocol for tool results. Do not substitute base64 text or a filename for actual image input. If a provider requires a subsequent user image block, keep call/result linkage first and preserve ordering of that explicit image attachment. A text-only/unsupported model receives an explicit unsupported-content error; do not claim it saw the image. Image tests cover PNG/JPEG with the real outgoing SDK request. A separate transport limit of 16 MiB per decoded message/result bounds images/JSON; this is not a token guarantee. Reject oversize before provider submission. Audio, arbitrary binary/PDF attachments, and automatic resource fetching are outside v1; return explicit unsupported-content errors. Never fetch an MCP resource URL implicitly.

### D-10 Standard ACP and raw extensions
Use official ACP SDK with stable protocol v1; do not mix v2 draft lifecycle. Standard `initialize`, `session/new`, `session/prompt`, `session/update`, `session/cancel`, `session/request_permission` semantics must follow the SDK/schema. Negotiate supported protocol/capabilities according to v1; advertise no session persistence/loading or multimodal user prompts until implemented. ACP v1 baseline prompt blocks `text` and `resource_link` are accepted in any order, including resource-only prompts. Preserve each link’s required `uri`/`name` and supplied `title`, `description`, `mimeType`, `size`, and annotations as user-provided reference data when building the provider-visible user message; do not fetch/read URI content automatically or claim a reference was read. Keep links distinct from text blocks in the session transcript so multi-turn replay and compaction retain their order/metadata. A provider adapter may render a link as a concise labeled textual reference with its URI/metadata, without injecting it into the system prompt. Optional prompt images/audio/embedded resources require their advertised capabilities and remain explicitly rejected when unsupported.

Initialization returns standard agent identity/version/capabilities with raw extension advertisement in `_meta.raw`. A peer advertises supported raw extension booleans there too. Supported flags: `runtimeInfo`, `sessionConfigure`, `toolRegister`, `toolCall`, `sessionCompact`; toolCancel is optional. Unknown raw flags are ignored, known fields require booleans. Standard IDE interaction MUST work without any raw extension negotiation.

Standard `session/new` accepts absolute existing cwd and standard session-supplied MCP definitions. A normal client must not need a private extension to use its MCP servers: local config selections keyed by server name govern initial exposure, default none; document this requirement in the IDE setup example. If negotiated, `_raw/session/configure` can explicitly expose selected discovered aliases while idle. Session MCP connections and tool views never leak to another session. Global launch-config MCP connections may be shared only if lifecycle/refcount and per-session policy remain correct.

| Extension | Params | Result / behavior |
|---|---|---|
| `_raw/runtime/info` | `{sessionId?: string}` | Redacted profile/model, tool aliases/origins/exposure, supported extensions and limits; no credentials |
| `_raw/session/configure` | `{sessionId: string, tools: string[]}` | `{schemaRevision: number, tools: string[]}`; exact selected exposed set, empty means none; include primitive names explicitly when desired; reject unknown names and busy session |
| `_raw/tool/register` | `{sessionId: string, name: string, description: string, inputSchema: object}` | `{toolId: string, alias: string, schemaRevision: number}`; requires peer toolCall capability; idle only, session/connection scoped |
| `_raw/tool/call` (agent -> peer) | `{sessionId: string, toolId: string, invocationId: string, arguments: object}` | `{isError: boolean, content: ToolContent[]}`; supported content uses the same text/JSON/image rules as MCP |
| `_raw/tool/cancel` notification | `{sessionId: string, invocationId: string}` | Sent on abort only if negotiated; local abort still settles without its acknowledgment |
| `_raw/session/compact` | `{sessionId: string}` | `{status, beforeBytes?, afterBytes?, usage?}` using D-07; no arbitrary profile override from an untrusted request |

`ToolContent` is a discriminated union documented in JSON examples: `{type:"text",text:string}`, `{type:"json",value:JSON}`, `{type:"image",mimeType:"image/png"|"image/jpeg",data:string}` with base64 data. No JS source, executable path, or serialized function handler is accepted at tool registration. Host/library callbacks provide execution; registration of only schema without reverse call is incomplete.

Extension errors: standard JSON-RPC parse/invalid request/params/method errors where applicable; raw codes `-32001` unknown session, `-32002` busy, `-32003` capability missing, `-32004` unknown/denied tool, `-32005` request timeout, `-32006` cancelled, `-32007` upstream failure, `-32008` duplicate registration. Do not replace standard ACP error meanings with these codes. IDs and reverse IDs must not collide; notifications get no response. Peer disconnect aborts owned work, rejects callbacks, frees sessions/registrations, and reaps owned children. Unknown/late response IDs cannot mutate state.

Stdio: SDK newline-delimited JSON-RPC, robust to split/coalesced chunks, stdout pure. WebSocket: `raw --acp --ws --host 127.0.0.1 --port <n>`; one JSON-RPC object per text message, 16 MiB message cap, no binary frames. Permit loopback binding only, reject browser Origin by default. Explicit `--acp --stdio`; bare `--acp` defaults stdio; stdio and ws are mutually exclusive. No auth/public hosting server in v1.

The receive loop MUST service cancel, permission replies, and reverse tool replies while a prompt is pending. Do not await each full request serially in the frame reader. Standard v1 prompt returns after turn completion, not immediately on acceptance. Cancellation uses standard stop reason; max-steps maps to the valid v1 stop reason with an accompanying diagnostic, never an invented enum.

Parent client MUST spawn `raw --acp --stdio` or connect to ws, initialize, new-session, prompt, stream updates, answer permissions/tool callbacks, cancel, and close. It is a library/example, not a fourth built-in model tool. The installed-package test uses this real API to spawn the installed binary.

### D-11 CLI and user-visible outcomes
- `raw "task"`: one-shot; `raw` / `raw --interactive`: REPL using `> `, history retained in memory.
- Host slash commands `/compact`, `/clear`, `/stats`, `/exit`; execute only as whole REPL command lines, never as hidden model tools. ACP task text containing `/clear` is ordinary text unless a corresponding explicit API operation is called.
- Parse task with `--` support so a task beginning with `-` works. Incompatible task/interactive/daemon flags fail before side effects.
- First Ctrl-C aborts active run/compact and returns REPL to idle after cleanup; Ctrl-C while idle exits. EOF aborts active work and closes cleanly. Do not leave pending readline questions or processes alive.
- Output stream carries assistant text; tool status/approval/usage goes to stderr. Preserve streaming order without printing duplicate final text.
- Exit codes: 0 completed/help/config commands, 1 runtime/provider/infrastructure failure, 2 invalid args/config or missing noninteractive approval, 3 max steps, 130 user cancellation. A recoverable tool error alone is not a process failure.

### D-12 Sources and evidence boundaries
These primary references were checked during planning. Recheck the exact SDK API when pinning dependencies, without changing user-facing decisions silently:
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview), [initialization and baseline prompt capabilities](https://agentclientprotocol.com/protocol/v1/initialization#prompt-capabilities), [content blocks](https://agentclientprotocol.com/protocol/v1/content), [extensions](https://agentclientprotocol.com/protocol/extensibility), [protocol updates](https://agentclientprotocol.com/updates).
- [MCP SDK client](https://ts.sdk.modelcontextprotocol.io/client.html).
- [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Google caching](https://ai.google.dev/gemini-api/docs/caching), [Google tools](https://ai.google.dev/gemini-api/docs/function-calling).
- [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [OpenRouter tools](https://openrouter.ai/docs/guides/features/tool-calling), [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

SDK import success proves runtime compatibility, not protocol correctness. Mock HTTP with real SDKs proves adapter behavior, not a paid production backend hit. An independent official ACP client proves more than two custom endpoints agreeing with each other. State these distinctions in reports.

## Global Gates
### G-00 Execution sequence and evidence, mandatory per phase
1. Admit only this current plan after user implementation approval. If not Git yet, initialize it, inspect the tree and preserve unrelated changes. Record exact dependency versions and environment in Phase 1.
2. Mark exactly one phase `in_progress` in the progress table. Revalidate its inputs against actual prior-phase source; no work on later phases to disguise an incomplete dependency.
3. Update the owning docs first. Add behavioral tests before the matching production behavior. Run focused command and record meaningful RED (assertion failure, or initial missing module during bootstrap stated as such).
4. Implement all production obligations through the real integration path. Run focused GREEN, then cumulative gates for every completed/current phase. Repair root causes; do not edit a test to remove its contract.
5. Review against each D-contract, invariant and phase AC. Record findings and their resolutions; reviewer verdict must be APPROVE. A self-review is acceptable if no independent reviewer is available, but must be labeled honestly. Do not spawn agents unless session instructions authorize them.
6. Save `docs/evidence/phase-N.md` with tested code revision/file hashes, commands, exits, test counts, RED/GREEN outcomes, fixture paths, AC->test mapping, review findings/verdict and remaining external limitations. Never log credentials. Evidence must be reproducible, not screenshots of a success sentence.
7. Check all ACs only after evidence exists. Stage phase-owned files and plan bookkeeping; inspect staged diff, commit once with the planned message. Record commit in Progress Log, then proceed. No `--no-verify`, force, amend or empty commits.
8. If blocked, retain incomplete status and concrete evidence. Never mark complete because the agent ran out of time/context or substitutes a TODO. A later session resumes the first incomplete phase; it does not restart or reapprove already completed choices.

Do not rely on a hidden skill being installed for these obligations. If `loop-implement` is available, use it after approval; otherwise follow the complete sequence above.

### G-01 Test/build command contract
Create scripts in Phase 1:
- `npm run typecheck`: strict `tsc --noEmit`, no blanket `any`, `@ts-nocheck`, or excluded production modules to bypass errors.
- `npm test`: portable Node test runner through tsx using explicit discovered test-file paths; nonzero on test failure or zero discovered tests.
- `npm run test:phase -- <selector>`: selectors `foundation`, `tools`, `providers`, `agent`, `context`, `mcp`, `acp`, `cli`; maps to the files below. Unknown selector or missing mapped file fails, never silently skips.
- `npm run build`: tsup executable + ESM library + declarations, executable shebang.
- `npm run check`: typecheck -> build -> all currently implemented tests, fail fast. Build before subprocess/package tests so they cannot accidentally exercise stale dist files. The final gate must include every phase's expected test file; no excluding a troublesome suite.
- `npm run test:overhead`: from Phase 2 onward, uses exported prompt/schema definitions and D-01 oracle.
- `npm run test:package`: from Phase 8, build the current source, then pack/install temp consumer and run installed executable/imports from outside checkout with mock provider/MCP/ACP services. Package tests invoked inside `npm test` use the fresh build produced by `npm run check`; a direct focused package invocation must build first too.
- `scripts/verify-runtime.mjs`: Phase 8, assert current major version, invoke the same checks/package tests with **process.execPath** and child PATH correctly bound. Never accidentally test child processes on the host default Node.

Final exact commands, all must exit 0:
```sh
npm ci
npm run check
npm run test:overhead
npm run test:package
npm exec --yes --package=node@22 -- node scripts/verify-runtime.mjs
npm exec --yes --package=node@24 -- node scripts/verify-runtime.mjs
```

Bootstrap exception: first install creates the lockfile via `npm install`; subsequent reproducibility gate is `npm ci`. Do not run `npm ci` without a lockfile and call it a design failure. Package/runtime scripts cannot be claimed run before Phase 8 creates them. Test runner mappings may list future suites, but focused invocation for a missing suite must fail; final check verifies all expected suites exist.

### G-02 Required tests and forbidden shortcuts
Tests below use stable IDs in names/evidence. They exercise input variations and real boundaries; IDs alone are not evidence.
- Real filesystem/temp directories for primitives, with known sentinel contents and unreadable/missing cases.
- Real child/grandchild processes and delayed sentinel side effects for cancellation, no mocking `kill()` as the only proof.
- Real official SDK against local HTTP/SSE fixtures; no replacing the entire provider adapter with a canned `stream()` in adapter tests. Agent unit tests may inject a fake provider in addition.
- Real official-SDK MCP fixture servers over all three transports; no one fake function replacing all transports.
- Independent official ACP SDK client exercising the subprocess transport, in addition to raw client's own tests.
- No paid API, downloaded production model, or unavailable remote host is required for gates. Clearly label optional live evidence.
- Prohibit `.skip`, `.todo`, `|| true`, zero-test success, tautological assertions, fixture-name branches in production, hardcoded responses, empty methods, and replacing SDK integrations with mock-only placeholders for required behavior.
- Tests should fail if the named behavior is deliberately disabled: the phase Anti-shortcut coverage specifies the oracle. Do not mandate a separate mutation-testing framework.

### G-03 Final evidence and status
Create `docs/verification.md` mapping every AC and invariant to test IDs/reports, actual Node/OS versions, package/bundle sizes, runtime dependency count, and tested code/artifact hashes. All source/build inputs must match the tested revision; evidence-only/plan bookkeeping changes may be recorded separately to avoid self-referential hashes. Rerun affected gates after production changes; final cumulative gates remain mandatory.

No required test may be replaced by "reviewed manually" unless the AC explicitly names inspection. Do not claim Linux/macOS CI ran merely because YAML exists. Build only the requested local deliverables; no remote Git setup or publishing prerequisite.

### G-04 Coverage map required at final audit
| Contract | Owning phases | Required test evidence |
|---|---|---|
| D-01 Prompt/schema | 1, 2, 3 | T-01c, T-02e, outgoing requests T-03a |
| D-02 Profiles/config | 1, 8 | T-01a/b/d, T-08a |
| D-03 Limits/output/approval | 1, 2, 4, 6, 8 | T-02a/b/d, T-04d, T-06d, T-08b |
| D-04 Cancellation | 2, 3, 4, 6, 7, 8 | T-02c, T-03d, T-04c, T-06c, T-07d/e, T-08b |
| D-05 Providers/content | 3, 6 | T-03a..e, T-06d |
| D-06 Agent/state | 4 | T-04a..e |
| D-07 Compact | 5, 7, 8 | T-05a/b, T-07f, T-08c |
| D-08 Cache/stats | 5, 6, 8 | T-05c/d/e, T-06b, T-08c |
| D-09 MCP | 6, 7 | T-06a..d, T-07a |
| D-10 ACP | 7, 8 | T-07a..f, T-08d |
| D-11 CLI | 8 | T-08a..e |

Invariant evidence: I-01 -> T-01c/T-02e; I-02 -> T-02d/e/T-03a; I-03 -> T-03a/T-05c/T-08c; I-04 -> T-05c/d; I-05 -> T-03b/c/T-04c/d; I-06 -> T-02a/T-04e; I-07 -> T-02d/T-06b; I-08 -> cancellation row above; I-09 -> T-04e/T-07d; I-10 -> T-01b/T-07b/T-08d; I-11 -> T-05d/e and docs inspection; I-12 -> all evidence reports and final cumulative review.

The implementer fills actual test names/paths/results, not just this planned map. A test may cover several requirements, but cannot be omitted because another test has a similar name.

## Plan Review
Status: **APPROVE**. Planning self-review and `codex-plan-review` with `gpt-6-astra` agree after correction of ISSUE-1. The reviewer returned explicit `### VERDICT` / `Status: APPROVE` in rounds 2 and 3; the runner recorded those verdict-only rounds as `format: unknown` because its format detector requires an ISSUE block, so the approval is sourced from the preserved raw review text and explicit finalize override. This is a runner parsing limitation, not an unresolved plan issue. User implementation approval was granted in the subsequent `$loop-implement` request, with `gpt-6-astra` review required per phase.

Revision: handoff-v2, 2026-09-24. This revision supersedes the earlier six-phase drafts.

Resolved gaps: Codex plan review ISSUE-1 found mandatory ACP `resource_link` prompt support missing; added baseline block contract, no-fetch behavior, metadata-preserving mapping and independent-client/provider-wire tests. Also split oversized provider/agent/context work into separate commits; removed Phase 1's dependency on Phase 2 schemas; pinned manual compaction behavior; separated credential resolution from unused profiles; specified tool-result and cancellation linkage; supplied raw extension shapes and errors; required actual MCP image mapping; separated adapter-prefix tests from real cache claims; made SDK/transport/packaging tests non-substitutable; defined exact phase evidence and resume rules.

Intent review: confirmed local-context priority, three tools, full host permissions, official providers, MCP extensibility, ACP standard integration, multi-source config, compaction and caching are all covered. No production code, OS sandbox, hidden summarizer, extra default primitive, or publishing scope was introduced. Numeric defaults and manual-only compaction are explicit plan choices; a user can revise them before implementation.

Self-review checks: all D-01..D-11 contracts map to phases below; dependencies are ordered; every phase has complete required fields, bounded tests, production obligations and ACs; final commands have owning implementation phases; missing external qualification is labeled. This verdict does not approve nonexistent implementation or pre-check any acceptance box.

## Phase 1: Foundation, named profiles, and exact prompt
### Goal
Establish strict TypeScript packaging, real SDK dependency compatibility, easy multi-source config and the small default prompt.
### Current behavior and gap
No implementation exists. This phase creates the foundation, not fake implementations for later features.
### Evidence
Baseline empty repository and recorded dependency candidates; D-01/D-02/D-03 establish the source of truth. There is no prior code pattern to copy.
### Pattern
Small ESM modules with immutable validated config and explicit errors; Node built-ins for CLI config operations, test runner and readline where applicable.
### Dependencies
User approval of this current plan; applicable workspace instructions and Git/CTXE preflight. No other implementation phase.
### Files and symbols
`package.json`, `package-lock.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore`, `bin/raw.ts`, `src/config.ts`, `src/llm/{prompt,types}.ts`, `src/tools/types.ts`, `src/index.ts`, `scripts/{test,test-phase}.mjs`, `tests/{config,prompt,foundation-cli}.test.ts`, `README.md`, `docs/{configuration,providers,architecture}.md`.
### Behavioral contract
D-01 prompt and D-02 profiles/config commands work. D-03 options validate before side effects. Help/version/init/list are runnable without keys. Later modes are honestly unavailable until their phases, with no placeholder successful task output.
### Documentation
Write config schema/precedence/examples, limits table, full-host execution statement, provider API/version matrix, and prompt-budget definition before code. Include multiple same-provider endpoints and local operation with unused cloud profiles.
### Tests first
- **T-01a**: profile/default/flag/env precedence; unknown and duplicate/invalid data; same provider with two endpoints; direct config-free mode.
- **T-01b**: active/inactive/compact credentials; endpoint/profile conflict; secret-bearing endpoint/query redaction; no network on invalid config.
- **T-01c**: exact prompt, empty override, <=50 reference tokens; no injected suffix.
- **T-01d**: executable help/version and config init/list; no overwrite; valid starter JSON; no credentials or network required.
- **T-01e**: official SDK import and minimal client construction under Node 22; record exact package versions and supported request APIs.
### Anti-shortcut coverage
Changing an unused cloud key must not affect the local profile. Empty prompt must stay empty. A config-init collision must preserve byte-identical existing file. Run actual CLI subprocesses; calling a config helper alone does not satisfy command tests.
### Implementation obligations
1. Establish scripts, lockfile and public shared types; document any necessary validator/ws runtime dependency by purpose.
2. Implement config/prompt and foundation CLI paths, with no inference/mcp startup during help/config commands.
3. Select versions meeting Node 22 and the documented API contracts, not blindly latest. Record SDK feature evidence.
4. Initialize Git if absent, then maintain phase ownership. Re-enter CTXE preparation on actual files if required by the environment; do not treat a generated scaffold as retrieved source evidence.
### Acceptance criteria
- [x] **AC-1.1**: Strict typecheck, foundation tests and distributable build succeed — T-01a..e and phase gates.
- [x] **AC-1.2**: Profile config/credentials/commands meet D-02 and the exact prompt meets D-01 — T-01a..d.
- [x] **AC-1.3**: Chosen official SDKs are pinned/importable under Node 22 and their API choices recorded — T-01e plus `docs/providers.md` inspection.
### Focused verification
`npm run test:phase -- foundation` — selects all three foundation test files; nonzero RED before behavior, then nonzero test count and exit 0.
### Phase gates
`npm ci`
`npm run check`
Expected: all implemented tests and build pass, no skipped required cases. The combined three-tool overhead gate starts in Phase 2.
### Review
Implementation review is required; verdict must be APPROVE. Record D-01..03 findings and AC evidence in `docs/evidence/phase-1.md`.
### Commit
`feat: scaffold raw configuration profiles and package contracts`

## Phase 2: Three primitives, dispatch policy, and process cleanup
### Goal
Make the three tools work against real files/processes with bounded results and enforceable authorization.
### Current behavior and gap
Phase 1 supplies schemas/types/config conventions; actual tool handlers, registry dispatch and process lifecycle are missing.
### Evidence
Read the precise Phase 1 config/type symbols through required retrieval workflow; use D-01/D-03/D-04 and I-02/I-06..08 as contracts. Cite the actual paths/exports in phase evidence.
### Pattern
Registry entries hold schema, origin and handler; handler context supplies cwd, approval and signal. One result conversion/capping path, no global cwd mutation.
### Dependencies
Phase 1 complete and committed.
### Files and symbols
`src/tools/{primitives,registry,process,results}.ts`, `tests/{primitives,registry,overhead}.test.ts`, `tests/fixtures/process-tree.*`, `scripts/overhead.mjs`, `docs/tools.md`, `README.md`.
### Behavioral contract
All primitive input/output/error rules, shared 8 KiB cap, real Bash, approvals and group cancellation work. Default registry has exactly three tools. Export the actual schema definitions for D-01 measurement and later adapters.
### Documentation
Before handlers, specify tool schemas, absolute/relative paths, write-parent behavior, error/result format, cap metadata, Bash prerequisite, confirmation behavior and supervised-process boundary.
### Tests first
- **T-02a**: temp-file read/write/nested parent/empty content/unreadable/directory errors; absolute paths; two concurrent cwd values without cross-talk.
- **T-02b**: real Bash stdout/stderr, nonzero exit, signal/timeout; exact/over cap and multibyte boundary; pipes still drain after cap.
- **T-02c**: real child/grandchild delayed sentinel after abort; none survives owned-group cleanup, no unrelated sentinel process killed; abort before spawn.
- **T-02d**: unknown properties/types/tool, duplicate registration, denied approval, empty whitelist and direct dispatch of hidden tool; zero side effects.
- **T-02e**: <=500-token combined production prompt/schema oracle and exactly three default definitions.
### Anti-shortcut coverage
A fixture's child must try to create a file after cancellation: absence after its scheduled time plus process exit is the oracle. Returning `{cancelled:true}` or mocking kill is insufficient. Output test must exceed pipe capacity, so stopping reads fails. Measurements import production schemas.
### Implementation obligations
1. Implement schema validation/exposure before approval and side effects.
2. Implement file and process I/O with UTF-8 byte boundaries and a single shared output cap.
3. Own process groups/timers/listeners; preserve real exits, cancel remaining queued work, always settle.
4. Expose immutable tool definitions/result shapes; build overhead report from them.
### Acceptance criteria
- [x] **AC-2.1**: Exactly three primitives and host-side dispatch constraints hold — T-02d/e.
- [x] **AC-2.2**: Files/output semantics and bounded UTF-8 behavior hold — T-02a/b.
- [x] **AC-2.3**: Real descendant cancellation and unrelated-process preservation meet D-04 — T-02c.
- [x] **AC-2.4**: Default production prompt plus schemas meets the <=500 reference-token gate — T-02e.
### Focused verification
`npm run test:phase -- tools` — primitives, registry and overhead suites; all pass with real subprocess cleanup.
### Phase gates
`npm run check`
`npm run test:overhead`
Expected: no orphan handles/processes; actual reported prompt/schema counts meet D-01.
### Review
Implementation review is required; verdict must be APPROVE. Record cap boundaries, process evidence and policy bypass tests in `docs/evidence/phase-2.md`.
### Commit
`feat: implement primitive tools and owned process cleanup`

## Phase 3: Official streaming provider adapters
### Goal
Implement all provider paths using actual official SDK stream parsing and native tool message mapping.
### Current behavior and gap
Primitives work; no production provider bridge exists. This phase tests adapters independently before agent orchestration.
### Evidence
Phase 1 provider API matrix and actual shared types, Phase 2 schema/results; D-05 and D-12 official sources. Recheck API details against pinned dependencies rather than assuming identical wire formats.
### Pattern
One small normalized provider interface with three real SDK adapters; keep opaque provider blocks alongside normalized display/tool events.
### Dependencies
Phases 1–2 complete.
### Files and symbols
`src/llm/{client,openai,anthropic,google,types}.ts`, `tests/{providers,provider-content}.test.ts`, `tests/fixtures/{mock-provider,provider-streams}.*`, `docs/providers.md`.
### Behavioral contract
OpenAI, compatible HTTP, OpenRouter, Ollama, Anthropic and Google select the correct request API, endpoint, headers and model. Stream text and complete tool calls; preserve state required by follow-up requests. No SDK inference retries; signal/deadline reaches network work.
### Documentation
Record request APIs/options, credential/endpoint behavior, output-limit parameter mapping, reasoning-block handling and supported multimodal result mappings. Clearly label fixture versus live-service qualification.
### Tests first
- **T-03a**: real official SDK clients call local HTTP/SSE fixtures for all six provider configurations; assert endpoint/auth/model/system/tools payload and next tool-result request.
- **T-03b**: fragmented JSON, multiple interleaved tool call indices, empty deltas, tool IDs/names, Unicode and exact finish reasons.
- **T-03c**: Anthropic opaque thinking/signature blocks and Google thought signatures survive the next request unchanged; no private-reasoning output event.
- **T-03d**: 401/429/500, malformed frames, mid-stream EOF, explicit refusal, abort/deadline; fixture request counter proves no hidden retry.
- **T-03e**: native text/JSON/image result conversion emits proper SDK message content, with unsupported content errors; no base64 text stand-in.
### Anti-shortcut coverage
Fixture accepts the second request only with exact call linkage and required signature. Inspect real HTTP bodies, not only intermediate objects. Mutating provider selection must reach a different test endpoint; three aliases pointing to one fake adapter fail.
### Implementation obligations
1. Implement all three SDK adapters and profile routing; do not collapse Anthropic/Google into generic OpenAI compatibility.
2. Buffer incomplete tool JSON, preserve IDs and provider state, normalize finishes/errors/usage raw fields.
3. Implement actual abort/deadline and zero-retry behavior with proper stream disposal.
4. Implement native result/image translation needed by MCP later, without adding a primitive or silently fetching URLs.
### Acceptance criteria
- [x] **AC-3.1**: All six configured provider paths exercise correct official SDK requests — T-03a.
- [x] **AC-3.2**: Fragmented streams and opaque blocks produce valid subsequent turns — T-03b/c.
- [x] **AC-3.3**: Provider failures/cancellation do not retry or invent success — T-03d.
- [x] **AC-3.4**: Result content mapping supports text/JSON/PNG/JPEG and explicit unsupported cases — T-03e.
### Focused verification
`npm run test:phase -- providers` — provider and content suites using real SDKs/local wire fixtures.
### Phase gates
`npm run check`
`npm run test:overhead`
Expected: all adapter fixtures pass; no external credentials or paid API calls.
### Review
Implementation review is required; verdict must be APPROVE. Record wire assertions/API evidence in `docs/evidence/phase-3.md`.
### Commit
`feat: add official streaming provider adapters`

## Phase 4: Agent loop, transcript state, and cancellation recovery
### Goal
Run complete tasks and multi-turn conversations without broken tool linkage, extra steps or post-abort side effects.
### Current behavior and gap
Providers and tools work independently; there is no orchestration/state machine tying them together.
### Evidence
Read exact Phase 2 dispatch and Phase 3 stream interfaces; use D-04/D-05/D-06. No new provider/transport abstractions should be necessary.
### Pattern
Agent owns append-only transcript, per-run controller and event lifecycle; injected provider/registry/approval keep transport and CLI out of the core.
### Dependencies
Phases 1–3 complete.
### Files and symbols
`src/agent.ts`, `src/index.ts`, `tests/{agent,agent-lifecycle}.test.ts`, `docs/architecture.md`.
### Behavioral contract
Implement D-06 steps and state machine; execute sequential authorized tools only when a next inference step is available; preserve valid history after failure/abort. Expose real library API and events.
### Documentation
Draw a small state/sequence diagram; specify exact step counting, terminal reasons, partial stream versus committed history, busy errors, and recovery after partial side effects.
### Tests first
- **T-04a**: real provider fixture -> read/write/bash -> fixture answer; next user turn includes actual prior history without rerunning old tools.
- **T-04b**: max=1, max=25, final-step calls, multi-call order and results; request/side-effect counters enforce limits.
- **T-04c**: abort in inference, approval, first of multiple tools; preserve real completed results and cancellation results; next inference validates no orphan IDs.
- **T-04d**: malformed args/unknown tool/denial/nonzero shell result flow back correctly; stdout and event ordering; exactly one run_end.
- **T-04e**: same-session run rejected while busy, distinct cwd/history/usage between concurrent sessions; closing prevents new dispatch.
### Anti-shortcut coverage
A last-step tool asks to write a sentinel; sentinel must not exist and no extra model request occurs. After cancelling a multi-tool batch, independently validate the next wire transcript, not merely the local cancellation flag. Never infer success because the promise resolved.
### Implementation obligations
1. Implement complete loop and event sequencing through real provider/registry APIs.
2. Commit only valid completed assistant content and matching tool results; represent cancelled queued calls accurately.
3. Thread abort through every wait, settle once, restore session availability after cleanup, and reject invalid state transitions.
4. Preserve original tool side effects/results across recovery and future turns.
### Acceptance criteria
- [x] **AC-4.1**: Integrated task and subsequent conversation work with real tools and SDK fixture — T-04a.
- [x] **AC-4.2**: Step limits and sequential tool execution prevent unconsumable side effects — T-04b.
- [x] **AC-4.3**: Failure/denial/abort leave valid resumable history and one terminal event — T-04c/d.
- [x] **AC-4.4**: Busy-state and cross-session isolation contracts hold — T-04e.
### Focused verification
`npm run test:phase -- agent` — agent and lifecycle suites; all real tool/stream counts asserted.
### Phase gates
`npm run check`
`npm run test:overhead`
Expected: no test hangs, post-abort calls, or unresolved transcript linkage.
### Review
Implementation review is required; verdict must be APPROVE. Record state-transition and recovery evidence in `docs/evidence/phase-4.md`.
### Commit
`feat: implement bounded agent loop and resumable turn state`

## Phase 5: Explicit compact, stable cache prefixes, and usage
### Goal
Meet the user's small-context and multi-turn caching requirements with measurable, non-hidden behavior.
### Current behavior and gap
Agent retains valid history; compaction, native cache activation and normalized cache stats are not implemented yet.
### Evidence
Actual committed transcript/provider types from Phases 3–4; D-01/D-07/D-08 and checked provider cache sources. Preserve their messages rather than adding a second conversation store.
### Pattern
Compaction is an atomic separate operation; cache options and usage belong to provider adaptation, stable committed data belongs to the session.
### Dependencies
Phases 1–4 complete.
### Files and symbols
`src/compact.ts`, `src/llm/cache.ts`, provider/agent integration, `tests/{compact,cache,usage}.test.ts`, `docs/{context,providers}.md`.
### Behavioral contract
D-07 manual compact and rollback; D-08 stable prefix, actual supported metadata, no padding/prewarm/fallback, correct observed stats. Dedicated compact requests do not contaminate ordinary system prompts.
### Documentation
Write compaction input/retention/atomicity and lossy-memory rules, native cache matrix, exact per-provider usage formulas, missing-data semantics and context-versus-cache distinction before implementation.
### Tests first
- **T-05a**: known task/decisions/files/errors in a fixture summary; pinned initial request, two retained complete turns, multiple tools/signatures; next real adapter request remains valid.
- **T-05b**: no eligible history = zero calls; failure/abort/empty/non-shrinking/oversize/context error = original transcript byte-identical; selected compact source only.
- **T-05c**: >=3 actual SDK requests including tool round-trip + next user input; previously committed visible blocks/schema order identical, only new suffix appended; changing UI/output cap does not rewrite old content.
- **T-05d**: correct provider cache metadata/absence, stable key, no guessed fields on generic endpoint, exactly expected inference count, explicit compact invalidation and rollback preservation.
- **T-05e**: usage read/write/total fixtures, Anthropic disjoint and OpenAI/Google inclusive totals, explicit zeros versus absent, mixed-known cumulative coverage, divide-by-zero handling.
### Anti-shortcut coverage
Normal request captures must contain no summarizer instruction. A constant "cache hit" status fails fixtures with absent metrics. Preserve unchanged history when the summarizer returns a larger string. Golden prefix tests must include tool/result and opaque blocks, not two trivial identical user strings.
### Implementation obligations
1. Implement compact algorithm and all rollback/noop branches, no tool exposure or automatic triggers.
2. Freeze provider-visible transcript/schema representations and use actual SDK cache controls per supported backend.
3. Normalize usage without double-counting or inventing metrics; expose host stats/clear operations for CLI/ACP later.
4. Include no per-turn prompt scaffolding, speculative runtime tokenization, hidden warm-ups or cost-increasing padding.
### Acceptance criteria
- [x] **AC-5.1**: Compact shrinks eligible history while preserving specified retained context — T-05a.
- [x] **AC-5.2**: Every failed/cancelled/noop compact leaves history intact and makes only allowed requests — T-05b.
- [x] **AC-5.3**: Multi-turn visible prefixes remain stable and correct native caching options are sent — T-05c/d.
- [x] **AC-5.4**: Usage/cache stats reflect real reported categories and unknown coverage — T-05e.
### Focused verification
`npm run test:phase -- context` — compact, cache and usage suites.
### Phase gates
`npm run check`
`npm run test:overhead`
Expected: all fixtures pass; reports distinguish prefix stability from real backend cache hits.
### Review
Implementation review is required; verdict must be APPROVE. Record wire-prefix diffs, compact rollback and usage formulas in `docs/evidence/phase-5.md`.
### Commit
`feat: add explicit compaction and multi-turn cache reuse`

## Phase 6: MCP transports, selected tools, and image results
### Goal
Enable real external tools without flooding the model with discovery/schema data or losing multimodal results.
### Current behavior and gap
Core agent and content adapters exist; MCP connections, discovery policy and transport lifecycle are missing.
### Evidence
Phase 2 registry, Phase 3 content mapping, Phase 5 stable schema representation; D-09 and official MCP SDK API.
### Pattern
One disposable MCP connection owner; discovered catalog separate from exposed handlers; stable alias reverse map and shared result conversion.
### Dependencies
Phases 1–5 complete.
### Files and symbols
`src/tools/mcp-client.ts`, registry/config integration, `tests/{mcp,mcp-content}.test.ts`, `tests/fixtures/{mcp-stdio,mcp-http}.ts`, `docs/mcp.md`.
### Behavioral contract
Stdio, SSE, Streamable HTTP discovery/invocation through official SDK; pagination, explicit selection, deterministic ordering, exact routing, content/transport caps and abort/cleanup. Image results become actual model image input or explicit unsupported errors.
### Documentation
Provide full config examples for three transports and per-server tool selection, aliasing, transport defaults, unsupported media/resource behavior, timeout semantics and real image flow.
### Tests first
- **T-06a**: official fixture servers for all three transports; paginate tools, invoke selected page-two tool through agent -> provider follow-up.
- **T-06b**: 100 discovered/two selected; omitted/empty/"*"/unknown selection; shuffled discovery order; same tool names on two servers and name-length collisions.
- **T-06c**: startup partial failure, server stderr noise/crash, timeout/abort, late result and resource cleanup; no orphan stdio server.
- **T-06d**: error/structured/text/duplicate representations, output and 16 MiB caps; PNG/JPEG reaches native provider payload; unsupported media/URL resource has no implicit fetch.
### Anti-shortcut coverage
Two identical original tool names return different sentinel values; captured model result must come from the selected server. A discovered hidden tool invoked by name must be rejected. Image fixture asserts actual native image field/MIME/bytes, not string mentions of a screenshot.
### Implementation obligations
1. Connect/discover/paginate using SDK transports; fail clearly and dispose already-opened connections on partial failure.
2. Build explicit exposure and deterministic provider-safe aliases; central dispatch enforces them.
3. Integrate typed results and image mapping into the same agent loop; apply caps without duplicating content.
4. Abort requests promptly, account for best-effort remote side effects, and release owned transport resources.
### Acceptance criteria
- [x] **AC-6.1**: All three real fixture transports discover and execute through the agent — T-06a.
- [x] **AC-6.2**: Selection/routing/collision/order invariants hold without schema flooding — T-06b.
- [x] **AC-6.3**: Failures/abort clean up connections and child processes — T-06c.
- [x] **AC-6.4**: Text/JSON/image/error results follow caps and native provider mapping — T-06d.
### Focused verification
`npm run test:phase -- mcp` — MCP and content suites.
### Phase gates
`npm run check`
`npm run test:overhead`
Expected: three tested transports, valid content conversion and zero leaked fixture resources.
### Review
Implementation review is required; verdict must be APPROVE. Record transport-level/routing/image evidence in `docs/evidence/phase-6.md`.
### Commit
`feat: integrate selected MCP tools and multimodal results`

## Phase 7: Standard ACP sessions, extensions, and parent client
### Goal
Allow real IDE/parent-agent orchestration with standard protocol interoperability and executable reverse tool callbacks.
### Current behavior and gap
Library agent/compact/MCP are functional; there is no session protocol, wire transport or parent-client lifecycle.
### Evidence
Read prior exported APIs; D-10 and official ACP v1 SDK schema are authoritative. Raw custom methods cannot substitute for standard methods.
### Pattern
Official SDK connections plus a small session manager; frame reader stays responsive while long-running requests wait. Standard protocol path works independently of raw extensions.
### Dependencies
Phases 1–6 complete.
### Files and symbols
`src/acp/{rpc,methods,transport,client}.ts`, CLI daemon dispatch in `bin/raw.ts`, `src/index.ts`, `examples/parent-agent.ts`, `tests/{acp,acp-client,acp-transport}.test.ts`, `docs/acp.md`.
### Behavioral contract
D-10 standard initialize/new/prompt/update/cancel/permission, raw extension payloads, owned sessions, both transports and real parent spawn/cancel/close. Compact extension uses the same atomic operation. Standard client can send text and resource-link prompts, including resource-only input, and use configured session MCP selection without private extension.
### Documentation
Before handlers, publish supported protocol/capabilities, extension negotiation/JSON examples/errors/deadlines, prompt lifecycle, baseline text/resource-link mapping and no-fetch semantics, image/tool-content rules, ownership, stdio purity and IDE/parent setup instructions.
### Tests first
- **T-07a**: independent official-SDK client launches raw daemon and completes standard lifecycle without raw flags; standard permissions, configured session MCP, text-only, resource-link-only and mixed text/resource-link prompts work. Capture the real outgoing provider request and assert each URI/name and supplied metadata appears in the same order, with zero implicit file or network fetch.
- **T-07b**: malformed/split/coalesced stdio frames, notifications, unknown method/session, invalid params, version/capability behavior and pure stdout. Reject unsupported optional prompt blocks only when their capability is absent; never reject baseline `resource_link` solely because optional `embeddedContext` or `image` is not advertised.
- **T-07c**: real reverse `_raw/tool/call` receives arguments, returns sentinel/image/error, then model consumes it; missing capability, duplicate name, timeout, cancellation and late reply.
- **T-07d**: concurrent sessions/cwd/whitelists, busy mutation, cross-peer ownership, cancel while prompt/reverse permission is pending; disconnect cleanup during inference/bash/callback.
- **T-07e**: real ws framing, size/binary/Origin/bind rejection; client connect/cancel/close; raw parent library spawn stdio child and reap it.
- **T-07f**: compact extension status/rollback/usage and unsupported extension calls, with unchanged standard method behavior.
### Anti-shortcut coverage
Independent SDK client catches a custom server/client pair sharing the same protocol bug. Cancel must complete before a blocked prompt would finish, catching serial-frame deadlock. Registration-only code fails because a callback result must reach subsequent inference. Verify child PID exit, not only close-event emission.
### Implementation obligations
1. Wire standard SDK lifecycle and daemon CLI path; advertise only actual capabilities and map terminal reasons to valid v1 enums.
2. Implement extension negotiation/validation/reverse IDs, shared tool content semantics, deadlines and ownership checks.
3. Implement nonblocking dispatch, linked abort and transport disconnect cleanup, including MCP/session resources.
4. Deliver usable parent library/example for both transports with real spawn, permission handling and cancellation.
### Acceptance criteria
- [x] **AC-7.1**: Standard official client interoperates without raw extensions, including baseline text and resource-link prompts — T-07a/b.
- [x] **AC-7.2**: Dynamic registered tools actually execute through reverse RPC and return to model — T-07c.
- [x] **AC-7.3**: Session ownership/busy/cancel/disconnect contracts hold without deadlock/leaks — T-07d.
- [x] **AC-7.4**: WebSocket and real parent-client spawn/close work — T-07e.
- [x] **AC-7.5**: Compact extension shares the tested context operation and errors — T-07f.
### Focused verification
`npm run test:phase -- acp` — all three ACP suites; stdio and ws subprocess/transport fixtures.
### Phase gates
`npm run check`
`npm run test:overhead`
Expected: independent interoperability, active cancellation and cleanup all pass with protocol-only stdout.
### Review
Implementation review is required; verdict must be APPROVE. Record standard/extension wire evidence in `docs/evidence/phase-7.md`.
### Commit
`feat: add interoperable ACP sessions and parent client`

## Phase 8: Complete CLI, installed package, and final qualification
### Goal
Deliver a coherent executable and library whose documented flows work from an installed tarball on Node 22/24.
### Current behavior and gap
Core integrations and ACP mode work; terminal REPL, final flag wiring, installed-package proof, complete docs and runtime qualification remain.
### Evidence
All prior phase APIs/test evidence and D-11. The initial repository had no CI/release convention; this phase establishes only the necessary local package/CI setup.
### Pattern
Thin CLI uses shared config/agent/compact/stats/approval logic; integration tests launch real processes and install the real tarball outside the checkout.
### Dependencies
Phases 1–7 complete.
### Files and symbols
`src/cli.ts`, `bin/raw.ts`, `src/index.ts`, `package.json`, `tests/{cli,repl,package}.test.ts`, `scripts/{test-package,verify-runtime}.mjs`, `.github/workflows/ci.yml`, `README.md`, `docs/verification.md`.
### Behavioral contract
All D-11 modes, slash commands, flags, exit/signal/TTY rules and installed exports work. Completion means executable integration, not separate module demos.
### Documentation
Complete copyable setup for local/hosted profiles, three modes, MCP selection, ACP parent example, compact/cache stats, limits, full-host permissions, Bash prerequisites, test commands and actual qualification. Include final file layout and runtime dependency reasons.
### Tests first
- **T-08a**: subprocess one-shot/REPL/profile/mode/flag/exit behavior using mock HTTP inference and real temp-file edits; no duplicate streamed text.
- **T-08b**: real PTY approval/denial, non-TTY no-approval exit, `-y`, Ctrl-C/EOF during work and idle, cleanup. PTY harness is development-only.
- **T-08c**: multi-turn `/compact`, `/clear`, `/stats`, `/exit`; request counter and captures prove commands' distinct costs/history effects and no prompt pollution.
- **T-08d**: npm pack -> temp consumer install -> installed raw help/version/task/MCP/ACP parent-child; library import/types; no source checkout resolution.
- **T-08e**: full suite/overhead/build/package checks under exact Node 22 and 24 process executables; record tested OS and code/artifact hashes.
### Anti-shortcut coverage
Installed task must change a sentinel file and then answer using its real result. A tarball that only prints help fails. Assert installed parent launches installed child, not `tsx bin/raw.ts` from checkout. Runtime runner verifies child Node major, not just parent version. Stats/clear must cause zero extra requests.
### Implementation obligations
1. Wire every public mode/flag/command using shared production paths and graceful signal handling.
2. Produce executable bin and library declaration exports; package only needed artifacts with production dependencies resolvable after install.
3. Implement exact final runtime/package runners and CI matrix with all expected suites; no hidden network/API-key prerequisite.
4. Run complete gates, perform cumulative contract audit, fix concrete integration defects with regression tests, and produce final evidence matrix.
### Acceptance criteria
- [x] **AC-8.1**: CLI/REPL/modes/profile/exit and TTY/signal behavior meet D-11 — T-08a/b.
- [x] **AC-8.2**: Compact/reset/stats semantics remain correct through the public CLI — T-08c.
- [x] **AC-8.3**: Installed tarball executes a real task, MCP tool, ACP parent-child and usable library imports outside the checkout — T-08d.
- [x] **AC-8.4**: Required Node 22/24 final gates pass with actual tested artifacts and all test suites — T-08e.
- [x] **AC-8.5**: Every AC/invariant is mapped to evidence; no unqualified platform/cache hit claims or unfinished public stubs — `docs/verification.md` and cumulative diff audit.
### Focused verification
`npm run test:phase -- cli`
`npm run test:package`
Expected: public subprocess/PTY flows and installed consumer tests pass without production keys.
### Phase gates
`npm ci`
`npm run check`
`npm run test:overhead`
`npm run test:package`
`npm exec --yes --package=node@22 -- node scripts/verify-runtime.mjs`
`npm exec --yes --package=node@24 -- node scripts/verify-runtime.mjs`
Expected: all exit 0, nonzero test counts, every mapped suite present, no skipped required cases, no orphan fixture processes.
### Review
Implementation review is required; verdict must be APPROVE. Record final artifact/runtime evidence in `docs/evidence/phase-8.md` and cross-phase findings in `docs/verification.md`.
### Commit
`feat: complete raw CLI and installed-package qualification`

## Completion Criteria
- [x] User has authorized implementation of this current revision; all 8 phases have approved implementation review, AC evidence and cohesive commits.
- [x] All **33 ACs** below the phase headings are satisfied; no unresolved contract gap is hidden by a green subset of tests.
- [x] I-01..I-12 and D-01..D-11 each map to executable tests or explicitly named inspections in the final evidence matrix.
- [x] Exactly three default tools and measured prompt/schema budget; no hidden instruction/context/cost behavior.
- [x] All official SDK/provider paths, real primitives, three MCP transports, real image results, standard ACP, ws and parent client are integrated.
- [x] Explicit compact preserves valid retained turns and rolls back on failure; named profiles support multiple local/cloud sources without fallback.
- [x] Multi-turn prefix stability, actual native cache controls and honest usage stats are verified; no universal cache-hit or context-capacity claim.
- [x] Final G-01 commands pass on exact tested source/artifacts; test reports distinguish local fixtures, actual OS/Node checks, configured-but-unrun CI and optional live checks.
- [x] Installed package works outside the source tree, with public executable and library exports.
- [x] Docs, examples, evidence and progress reflect shipped behavior; worktree clean except specifically recorded unrelated changes.
- [x] No publication, deployment, remote Git creation, unrelated machine qualification or OS sandbox was added.

## Progress Log
### Resume table
All rows are currently pending. Exactly one may become in_progress. Replace dashes with real evidence; never prepopulate fabricated results.

| Phase | Selector | Status | Evidence | Review | Commit |
|---|---|---|---|---|---|
| 1 Foundation | foundation | complete | `docs/evidence/phase-1.md` | `gpt-6-astra` APPROVE (2 rounds) | `feat: scaffold raw configuration profiles and package contracts` |
| 2 Primitives | tools | complete | `docs/evidence/phase-2.md` | `gpt-6-astra` APPROVE (3 rounds) | `feat: implement primitive tools and owned process cleanup` |
| 3 Providers | providers | complete | `docs/evidence/phase-3.md` | `gpt-6-astra` APPROVE (3 rounds) | `feat: add official streaming provider adapters` |
| 4 Agent loop | agent | complete | `docs/evidence/phase-4.md` | `gpt-6-astra` APPROVE (2 rounds) | `feat: implement bounded agent loop and resumable turn state` |
| 5 Compact/cache | context | complete | `docs/evidence/phase-5.md` | `gpt-6-astra` APPROVE (reopened session, 2 rounds) | `feat: add explicit compaction and multi-turn cache reuse` |
| 6 MCP | mcp | complete | `docs/evidence/phase-6.md` | `gpt-6-astra` APPROVE (3 rounds) | `feat: integrate selected MCP tools and multimodal results` |
| 7 ACP/client | acp | complete | `docs/evidence/phase-7.md` | `gpt-6-astra` APPROVE (4 rounds) | `feat: add interoperable ACP sessions and parent client` |
| 8 CLI/package | cli | complete | `docs/evidence/phase-8.md`, `docs/verification.md` | `gpt-6-astra` APPROVE (3 rounds) | `feat: complete raw CLI and installed-package qualification` |

### Decision and planning history
- 2026-09-24: Initial empty workspace/Git/CTXE baseline checked. CTXE setup stopped on nonexistent representative paths; no index or production code created.
- 2026-09-24: User selected standard Agent Client Protocol, full host-account permissions/no isolation, Node 22+, and official provider SDKs including Google.
- 2026-09-24: User clarified local models/small context as primary goal; approved three primitives plus MCP extension direction; requested compact, easy multiple-source config, and maximum practical multi-turn cache reuse.
- 2026-09-24: User explicitly requested a complete `$loop-plan` handoff so another model cannot skip contracts/steps. Replaced accumulated six-phase draft with self-contained handoff-v2: 8 scoped phases, explicit D/I contracts, stable test/AC IDs, exact commands, evidence and resume obligations.
- 2026-09-24: Planning self-review APPROVE. Application implementation, dependency installation and application tests have not run. Implementation authorization remains pending; the user's future explicit implementation instruction is sufficient.

- 2026-09-24: `codex-plan-review` round 1 with `gpt-6-astra` returned REVISE on ISSUE-1 (ACP v1 mandatory `resource_link` prompts). Verified official ACP initialization/content docs and amended D-10, D-12, Phase 7 tests/docs/AC. Rounds 2 and 3 re-read the whole plan and returned explicit APPROVE with no open issues or new blockers. The runner parser cannot classify verdict-only replies, so raw verdict text is the review evidence; session `/Users/lploc94/projects/raw-cli/.codex-review/sessions/codex-plan-review-20260924-001` is retained by the runner.

- 2026-09-24: User invoked `$loop-implement` and required `gpt-6-astra` review of every phase. Phase 1 docs/test-first work completed; `npm ci`, `npm run check`, Node 22 check and focused tests passed (18/18). `codex-impl-review` found six real defects, all repaired with RED/GREEN regression evidence; round 2 returned APPROVE. See `docs/evidence/phase-1.md`. Phase 2 is next.
- 2026-09-24: Phase 2 docs/test-first work completed; focused 7/7, cumulative 25/25, overhead 25 prompt/175 combined. `gpt-6-astra` review found ten defects in two rounds, all fixed with RED/GREEN regressions; round 3 returned APPROVE. See `docs/evidence/phase-2.md`. Phase 3 is next.
- 2026-09-24: Phase 3 official SDK adapters completed; focused 17/17, cumulative 42/42, overhead 25/175. `gpt-6-astra` review found eleven defects in two rounds, all fixed with RED/GREEN regressions; round 3 returned APPROVE. See `docs/evidence/phase-3.md`. Phase 4 is next.
- 2026-09-24: Phase 4 agent loop completed; focused 13/13, cumulative 55/55, overhead 25/175. `gpt-6-astra` review found three event-boundary defects, all fixed with RED/GREEN regressions; round 2 returned APPROVE. See `docs/evidence/phase-4.md`. Phase 5 is next.
- 2026-09-24: Phase 5 context/caching completed; focused 17/17, cumulative 72/72, overhead 25/175. `gpt-6-astra` found six initial defects; the dated-snapshot fix required a reopened review after an automatic stalemate, and that review found one further SDK error-usage defect. All were fixed with RED/GREEN regressions. Reopened round 2 returned raw APPROVE. See `docs/evidence/phase-5.md`. Phase 6 is next.
- 2026-09-24: Phase 6 MCP completed; focused 18/18, cumulative 90/90, overhead 25/175. `gpt-6-astra` found seven concrete transport, schema, content and lifecycle defects in two rounds; all received RED/GREEN regressions, and round 3 returned raw APPROVE. See `docs/evidence/phase-6.md`. Phase 7 is next.
