# Context, compaction and cache

Terminal display records keep bounded tool previews separately from model context. They retain source paths for code highlighting and row statuses for diagnosis; they do not save ANSI formatting or full tool output. The current physical session format is 5. If an old database cannot be read, Raw leaves it untouched and starts new sessions in an isolated format-6 store. It does not automatically migrate those old conversations. Changing terminal color, theme, or density does not advance the storage format or alter the model cache key.

The terminal context bar uses the same estimated current input size as automatic compaction, plus the selected model's configured context window. Its warning threshold follows the actual compact trigger or effective input budget (window minus output reserve and safety margin); it is presentation only. Provider token counts describe cumulative session usage and show completeness separately. Cache-read and cache-write totals each have their own coverage count, since missing data must not appear as zero. Read ratio coverage remains the separate number of requests with both input and read counts.

Ordinary requests reuse one short system prompt, a stable selected tool view, and committed conversation messages. A turn appends new messages without rewriting prior tool results or opaque provider blocks. This improves the chance that an endpoint can reuse a prefix; it does not prove a cache hit. Neither a working directory nor a shared API connection guarantees cache affinity. `models.<alias>.context_window_tokens` is user-supplied model metadata, not an exact remaining-token counter.

When a saved session resumes with changed effective model settings, system prompt, or selected tool behavior, Raw commits one new runtime generation on that session ID. The changed request may lose provider cache reuse; the next unchanged resume keeps the new generation's key and serialized prefix. Release labels, local install paths, UI and runtime variable readings are not part of the effective request fingerprint. Selected skill changes keep their instructions at the conversation tail and can append a single reminder when earlier visible skill information is stale.

Raw retains the original historical messages in storage. When a previous provider's opaque reasoning or historical tool declarations cannot be safely replayed in the current model/tool environment, the next request uses a labeled text projection of the affected old messages. Historical tools never run again. The original arguments, results and image data remain in canonical session storage; a historical image marker tells the new model when image bytes were not forwarded. Token estimates use the same projected messages sent to the provider.

Persistent sessions keep two separate records: ordered model messages for the next provider request and pageable display history for what the CLI or ACP peer actually saw. A completed user input, assistant declaration, and each tool result cross a durable boundary before the next provider request or tool dispatch. On recovery, a declared tool without a committed result receives an explicit `outcome_unknown` result; remaining calls receive `cancelled`. The tool is never rerun automatically because its side effect may already have happened. Recovery commits before any skill reload notice. After a successful compact, only the active model context is replaced; visible history remains. If a loaded skill result leaves that context, a durable tail reminder asks the agent to reload it. A successful compact also appends one durable tail reminder per open tool panel whose declaration has `context: "summary"` (a `[Raw panel state]` line, then `Current state of <title> (<owner>) at revision N:` followed by the panel's `context_summary`, or its text rendering), most recently updated first, at most 2 KiB per panel and 8 KiB together, cut with `…`; reminders of an earlier compaction are replaced, and nothing is added on a normal turn, so the prefix and cache key do not change ([panels design](panels-design.md) §10). A failed, cancelled, or nonshrinking compact leaves the previous model context intact. An unchanged tool/skill generation keeps Raw's generated session cache key; a selected tool edit rotates it, while a skill-only edit keeps it and may append a reload notice. An explicit OpenAI agent cache key retains wire precedence. Cache hits remain controlled by the provider. Compact changes the message prefix once.

Fields larger than 64 KiB are stored as checksum-verified files under the private state directory. A compact may reclaim a full old tool result that was needed only by the model; the CLI result preview, complete displayed Bash arguments, visible reasoning, and ACP updates remain in history. A full tool output that was never displayed cannot be recovered from history after compact.

## Compaction

Compaction is a host operation: REPL `/compact`, library `compactSession`, negotiated ACP extension, or automatic compaction. It never appears in the model's built-in tools. When the model declares `context_window_tokens`, automatic compaction is on by default at 80% of the input budget (context minus output reserve and safety margin); an explicit `compact.trigger_tokens` sets another threshold and `"trigger_tokens": false` keeps compaction manual. The setting is an estimated input-token threshold below the model context window after an output reserve and safety margin; it is not a provider-reported remaining-token count. Before every inference step, Raw estimates the complete next request from the system prompt, selected tool schemas, committed messages, opaque reasoning items and image bytes. Prior provider usage can calibrate the estimate but cannot replace inspection of new content. A turn auto-compacts at most once, emits progress and usage, then checks the next request again. If a size anchored to provider-reported usage still exceeds the context budget, Raw returns a clear error instead of submitting it; a byte estimate alone, which can overstate tokens severalfold, never stops the request, and the provider decides.

The operation keeps the newest steps verbatim and sends the older ones to the selected model as a structured checkpoint request ([compaction v2 design](compaction-v2-design.md) §6.3 and §7.2). The request has no tools and a short compact-only system instruction.

**After compaction** the model context is, in order ([design](compaction-v2-design.md) §6.2):

1. One user message that starts with `[Raw compaction checkpoint #N]`, where N counts the session's compactions. It has four sections:
   - `## User messages (verbatim, oldest first)`: the ledger described below;
   - `## Working state`: facts Raw observed itself, at most 4 KB;
   - `## Checkpoint`: the model-written checkpoint;
   - `## Resume`: a fixed instruction to continue from the checkpoint's "Current position" and "Next actions" without recapping or redoing finished work.
2. The verbatim tail: the newest steps, unchanged, including their tool call IDs and native reasoning (signatures, encrypted reasoning).
3. The skill reload notice and panel reminders, as before.

A new checkpoint message replaces the previous one; they are never stacked.

**User-message ledger.** Every typed user input and every answer to `ask_user` is kept word for word. Images appear as their `[Image: type, N bytes]` placeholder.
- Entries are rendered oldest first. They are chosen newest first up to 20,000 estimated tokens. The entry that overflows keeps its start and end around `[… cut; full text: history #N]` or `[… cut; full text: ask_user answer <call ID>]`, and older entries are left out.
- The current turn's request and the `ask_user` answers given during that turn are always kept, whole when the budget allows; an answer never displaces its request.
- Entries that leave the active context are stored with the session (see [sessions](sessions.md)), so they survive restarts and later compactions.

**Working state** lists, when known:
- the working directory and the number of compactions;
- files written or patched in the session, each with the last tool that touched it;
- files read earlier;
- saved full outputs still on disk;
- running background processes;
- the last `bash` command and its exit code.

The facts that outlive their steps (files and saved outputs) are stored with the ledger and merged at each compaction.

**Verbatim tail.** The tail is chosen by steps, newest first, up to `compact.keep_recent_tokens` estimated tokens (default: the smaller of 20,000 and a quarter of the input budget). A step is an assistant message with all of its tool results, so a call is never separated from its result. The last step is always kept; when it is larger than the tail budget, its tool results keep their start and end around a marker naming a saved copy. `ask_user` answers there are cut only when nothing else makes the context fit, and the ledger then keeps their full text for when they leave the tail. `compact.keep_recent_turns` (default 2) keeps more when those turns fit and something older is left to summarize. Without anything older than the tail beyond typed inputs, which the ledger already keeps, compaction returns `noop`.

**Size allocation.** The new context aims at half of the input budget, so the turn has room to continue:
- The fixed parts, the current request with its answers, the last step and the checkpoint are always kept whole while they fit the full input budget.
- Working state, the rest of the ledger and the rest of the tail fill only what is left under that half, in this order.
- When even the kept parts exceed the input budget:
  1. the checkpoint's output budget is lowered, down to 1,024 tokens;
  2. then the checkpoint is replaced by `[Checkpoint unavailable: no room left in the context for a new checkpoint; older steps were removed. Re-check the working tree before continuing.]`, without a summary request;
  3. then the last step's results, the turn's answers and finally the request are cut, each naming where its full text is.
- The checkpoint's size is estimated before it is written. If the written checkpoint would still push the new context over the input budget, it keeps its start and end around `[… cut; full text: the compaction record in the session history]`; the compaction record keeps it whole.

**Rejected reasoning.** If the first request after a compaction, in the same process or after a restart, fails with a provider validation error about thinking, reasoning, signatures or encrypted content, Raw retries it once with every earlier message projected to portable text, the same projection a model switch uses. The boundary is saved with the session, so later requests and a restart use it too.

**Request contents.**
- **Rendered transcript.** The turns are rendered as labeled lines (`USER:`, `ASSISTANT:`, `REASONING:`, `TOOL CALL name(args)`, `TOOL RESULT name:`), not JSON.
- **Reasoning.** Readable reasoning the provider returned is included:
  - Anthropic thinking text;
  - Responses reasoning summaries;
  - Gemini thought parts;
  - OpenRouter reasoning text;
  - DeepSeek `reasoning_content`.

  Signatures, encrypted reasoning, redacted thinking and unknown provider data are left out.
- **Images** are represented by path, MIME type and byte size, never base64.
- **Large results.** A tool result over 4 KB keeps its start and end around `…[N bytes omitted; full output: <path>]…`. The path is the result's saved full output, or a new saved copy, or `unavailable` when saving failed.
- **Checkpoint prompt.** The transcript is followed by the checkpoint prompt:
  - it opens with a no-tools guard;
  - it contains the carry-sheet rules and a 13-item checklist the model works through inside `<analysis>…</analysis>`;
  - it requires nine fixed sections, from `## Goal` to `## Next actions`;
  - its length rule allows min(4000, 60% of the output budget) words.
- **Previous summary.** A previous summary is passed as `<prior-checkpoint>` with merge rules: carry forward open items, the newer conversation wins on conflict.
- **`compact.instructions`.** When configured, it is appended last.

**Splitting.** When the selected model declares a context window, the input is split at step boundaries into chronological requests that each fit its context and output reserve. A step is an assistant message with all of its tool results, so a call is never separated from its result and one long turn can span several requests. Each request carries the checkpoint written so far as `<prior-checkpoint>`.
- A step too large for a request of its own is cut to fit.
- If it still does not fit, it becomes a one-line record of its tool calls and result sizes with saved paths.
- Before admitting any step, each request checks that the prompt, the running checkpoint, the output budget and a margin leave room for one record. If not, the output budget is lowered, down to 1,024 tokens. If even that does not fit, compaction fails before a provider call.

**Storage.** The `<analysis>` notes are discarded; only the sections after them are stored.

The checkpoint is labeled as the agent's own notes, not a system instruction. With its notes removed, it must be nonempty and complete, and the new context must be a strictly shorter UTF-8 serialized transcript. Provider-reported output tokens, when available, must fit `compact.max_output_tokens` (by default 16384, lowered to the model's `max_output_tokens` and to a quarter of `context_window_tokens` when those are declared, and raised to the request output cap when a manual Anthropic thinking budget would not fit below it). No eligible older turn returns `noop` without an inference request. A summary cut at the output limit is requested once more with twice the budget when the model cap and context allow it; if it is still cut, the partial summary is kept with a `[Summary cut off at the output token limit.]` line rather than failing. Provider error, cancellation, empty or over-budget summary, or a nonshrinking result leaves the previous transcript byte-for-byte intact. Summaries are lossy: decisions, changed files and unresolved failures should be recorded, but a model may still omit a fact; the ledger and the tail are not summarized. `/clear` removes conversation history and the ledger while idle and keeps configuration and cumulative usage.

## Cache controls

| Agent | Auto mode | `no-hints` mode | Explicit retention |
|---|---|---|---|
| OpenAI Chat Completions | Stable `prompt_cache_key` for related session requests; OpenAI also caches eligible prefixes implicitly | No harness cache fields | Validate SDK-supported `prompt_cache_retention` values for older models or `prompt_cache_options.ttl` where supported; unsupported values fail before inference |
| OpenAI Responses | Stable `prompt_cache_key`, stateless output-item replay including encrypted reasoning | No harness cache fields | Same verified OpenAI retention rules |
| Anthropic Messages | Request-level `cache_control: {type:"ephemeral"}`; optional TTL | No `cache_control` | `5m` or `1h` only |
| Google generateContentStream | Stable contents for supported implicit caching; no explicit cache resource | Same wire request; server behavior remains its own | Unsupported |
| Generic compatible, OpenRouter, Ollama | Stable messages only; no guessed proprietary field | Same wire request | Unsupported |
| Explicit compatible `llama.cpp` backend | `cache_prompt: true` | No harness cache field | Unsupported |

`cache.key` is a user-supplied OpenAI routing key. Without one, a session creates one opaque stable key for its related requests. Compact does not rotate the main key, but its separate request may use a stable `:compact` suffix. Cache availability depends on model support, prefix length, server routing, time and eviction. The harness does not add padding, warm-up requests, or hidden summarization to chase hits. OpenAI [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), Anthropic [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), Google [implicit caching](https://ai.google.dev/gemini-api/docs/generate-content/caching), and llama.cpp [server cache behavior](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) are the source references; the pinned SDK and local HTTP fixture determine what this build sends.

## Usage and unknowns

The one-shot CLI footer reports the current context size after the completed turn. When the provider reported token counts for the last response, that size is exactly its input plus output tokens; otherwise, and for anything added since, it is an estimate of the saved system prompt, selected tool definitions and active model messages, using the same calibrated estimator as automatic compaction (bytes divided by two, deliberately high). The reported size is kept with the session and is dropped after `/compact` or `/clear`, and when the system prompt, tool schemas or model change, until the next response. When `context_window_tokens` is configured, Raw divides that estimate by the configured window to show percent used; otherwise the percentage is unavailable. Automatic compaction judges the next request the same way: the reported size plus an estimate of only what was added after it (a large tool result is never undercounted), and the plain estimate when no reported size applies. The size is separate from cumulative provider-reported usage and may differ from the next request's actual token count.

`inputTokensTotal`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` are optional observed values. OpenAI Chat Completions `prompt_tokens` includes cached reads; `prompt_tokens_details.cached_tokens` and `cache_write_tokens` are breakdowns, not additions. Responses uses `input_tokens`, `output_tokens`, and `input_tokens_details.cached_tokens`. Anthropic total input is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; `cache_creation.ephemeral_*` subtotals are already included in creation and must not be added again. Google `promptTokenCount` includes cached content; `cachedContentTokenCount` is a breakdown, while generated output adds reported `candidatesTokenCount` and `thoughtsTokenCount` without adding either to prompt input. DeepSeek Chat also reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; hits are used when `prompt_tokens_details.cached_tokens` is absent. Missing fields stay unknown, including cache metrics from generic compatible endpoints. A reported zero is zero; an absent value is not zero.

Per-request cache-read ratio is `cacheReadTokens / inputTokensTotal` only when both are known and input is positive. A zero-input request has no ratio. Cumulative ratio sums reads and inputs only over requests with both fields known, and reports the count of such requests alongside all issued requests, including failures and requests without usage. A rejected summary still consumed inference and retains any reported usage while transcript rollback remains exact. No ratio or prefix comparison alone is proof that a backend served a cached prefix. Time to first visible text and elapsed time are separate host timing observations, not cache evidence.

## Runtime variables

Variable metadata and values arrive only through tool results at the conversation tail. They are not inserted into system/tool prefixes. Value or variable-definition changes do not rotate generated model cache keys. Old read results remain historical, including observed_at; read again when freshness matters. Resume creates an empty runtime-local variable cache. `/clear` resets conversation, but the existing runtime TTL cache remains. Tool/schema/source changes retain existing revision behavior.
