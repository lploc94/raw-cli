# Context, compaction and cache

Ordinary requests reuse one short system prompt, a stable selected tool view, and committed conversation messages. A turn appends new messages without rewriting prior tool results or opaque provider blocks. This improves the chance that an endpoint can reuse a prefix; it does not prove a cache hit. Neither a working directory nor a shared API connection guarantees cache affinity. `models.<alias>.context_window_tokens` is user-supplied model metadata, not an exact remaining-token counter.

## Explicit compaction

Compaction is a host operation: REPL `/compact`, library `compactSession`, or negotiated ACP extension. It never appears in the model's three built-in tools and never runs automatically. The operation locks an idle session, keeps the original user task once, keeps the most recent two complete turns by default, and sends only older eligible turns plus any previous summary to one summarizer request. The request has no tools and a short compaction-only system instruction. It uses the selected session model. No fallback or chunked retry is attempted.

The new summary is labeled as conversation data, not a system instruction. It must be nonempty, complete, and produce a strictly shorter UTF-8 serialized transcript. Provider-reported output tokens, when available, must fit `compact.max_output_tokens` (512 by default). No eligible older turn returns `noop` without an inference request. Provider error, cancellation, empty or over-budget summary, or a nonshrinking result leaves the previous transcript byte-for-byte intact. Summaries are lossy: decisions, changed files and unresolved failures should be recorded, but a model may still omit a fact. `/clear` removes conversation history while idle and keeps configuration and cumulative usage.

## Cache controls

| Profile | Auto mode | `no-hints` mode | Explicit retention |
|---|---|---|---|
| OpenAI Chat Completions | Stable `prompt_cache_key` for related session requests; OpenAI also caches eligible prefixes implicitly | No harness cache fields | Validate SDK-supported `prompt_cache_retention` values for older models or `prompt_cache_options.ttl` where supported; unsupported values fail before inference |
| OpenAI Responses | Stable `prompt_cache_key`, stateless output-item replay including encrypted reasoning | No harness cache fields | Same verified OpenAI retention rules |
| Anthropic Messages | Request-level `cache_control: {type:"ephemeral"}`; optional TTL | No `cache_control` | `5m` or `1h` only |
| Google generateContentStream | Stable contents for supported implicit caching; no explicit cache resource | Same wire request; server behavior remains its own | Unsupported |
| Generic compatible, OpenRouter, Ollama | Stable messages only; no guessed proprietary field | Same wire request | Unsupported |
| Explicit compatible `llama.cpp` backend | `cache_prompt: true` | No harness cache field | Unsupported |

`cache.key` is a user-supplied OpenAI routing key. Without one, a session creates one opaque stable key for its related requests. Compact does not rotate the main key, but its separate request may use a stable `:compact` suffix. Cache availability depends on model support, prefix length, server routing, time and eviction. The harness does not add padding, warm-up requests, or hidden summarization to chase hits. OpenAI [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), Anthropic [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), Google [implicit caching](https://ai.google.dev/gemini-api/docs/generate-content/caching), and llama.cpp [server cache behavior](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) are the source references; the pinned SDK and local HTTP fixture determine what this build sends.

## Usage and unknowns

`inputTokensTotal`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` are optional observed values. OpenAI Chat Completions `prompt_tokens` includes cached reads; `prompt_tokens_details.cached_tokens` and `cache_write_tokens` are breakdowns, not additions. Responses uses `input_tokens`, `output_tokens`, and `input_tokens_details.cached_tokens`. Anthropic total input is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; `cache_creation.ephemeral_*` subtotals are already included in creation and must not be added again. Google `promptTokenCount` includes cached content; `cachedContentTokenCount` is a breakdown, while generated output adds reported `candidatesTokenCount` and `thoughtsTokenCount` without adding either to prompt input. DeepSeek Chat also reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; hits are used when `prompt_tokens_details.cached_tokens` is absent. Missing fields stay unknown, including cache metrics from generic compatible endpoints. A reported zero is zero; an absent value is not zero.

Per-request cache-read ratio is `cacheReadTokens / inputTokensTotal` only when both are known and input is positive. A zero-input request has no ratio. Cumulative ratio sums reads and inputs only over requests with both fields known, and reports the count of such requests alongside all issued requests, including failures and requests without usage. A rejected summary still consumed inference and retains any reported usage while transcript rollback remains exact. No ratio or prefix comparison alone is proof that a backend served a cached prefix. Time to first visible text and elapsed time are separate host timing observations, not cache evidence.
