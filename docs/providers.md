# API adapters and request controls

`models.<alias>.provider` names the upstream service or deployment. `models.<alias>.method` chooses the wire API; it never follows from the provider name. `model_id` is sent verbatim as the upstream model. The supported methods are `openai-chat-completions`, `openai-responses`, `anthropic-messages`, and `google-generate-content`. The selected agent is fixed for a session.

| Method | SDK call | Typical service | Output cap field |
|---|---|---|---|
| `openai-chat-completions` | `openai.chat.completions.create` | OpenAI, DeepSeek, OpenRouter, Ollama, compatible gateways | OpenAI `max_completion_tokens`; other services `max_tokens` |
| `openai-responses` | `openai.responses.create` | OpenAI | `max_output_tokens` |
| `anthropic-messages` | `anthropic.messages.create` | Anthropic or compatible gateway | `max_tokens` |
| `google-generate-content` | `google.models.generateContentStream` | Gemini or compatible gateway | `config.maxOutputTokens` |

A service and method without a known matching endpoint must set `base_url`. Credential defaults apply only to the selected model, and unknown services have no guessed authentication or cache hints. SDK retries are disabled; Raw retries transient failures (408/409/429/5xx/529, dropped connections) that happen before any stream event up to three times with exponential backoff, honoring `retry-after`. The request timeout restarts on every stream event, so it bounds silence rather than answer length. Abort covers the full stream.

## Agent request object

`agents.<name>.request` is strictly validated. It cannot override `model`, `messages`, `tools`, endpoint, or credentials. All methods accept `max_output_tokens` as a positive integer no larger than the model's configured output capability and smaller than its context window when those limits are supplied.

- OpenAI Chat Completions: `service_tier` (`auto`, `default`, `flex`, `fast`, `priority`) and `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). These fields are accepted only for `provider: "openai"`; custom compatible services do not receive them by assumption.
- OpenAI Responses: the same `service_tier` and `reasoning_effort`, plus `reasoning_mode` (`standard`, `pro`), only for `provider: "openai"`. The adapter uses `store:false`, replays full response output items including opaque reasoning and function calls, and appends linked `function_call_output` items. GPT-6 Astra tool use requires this method. [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode).
- DeepSeek Chat Completions: `thinking` (`enabled` or `disabled`) and `reasoning_effort` (`low`, `high`, `max`) are accepted only for `provider: "deepseek"`. The adapter sends `thinking.type` and preserves every assistant `reasoning_content` in later requests containing tools, including ordinary assistant turns. [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).
- Anthropic Messages: `thinking` is `{ "type": "adaptive" }`, `{ "type": "disabled" }`, or `{ "type": "enabled", "budget_tokens": N }`; `effort` is `low`, `medium`, `high`, `xhigh`, or `max`. `service_tier` is `auto` or `standard_only`. These are accepted only for `provider: "anthropic"`; the API validates snapshot-specific support. Manual `budget_tokens` must be at least 1024 and smaller than the effective output cap. An explicit `compact.max_output_tokens` must exceed that budget; the default is raised to the request output cap when needed, and a smaller per-call override fails before network. [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort), [thinking budget rules](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
- Gemini Generate Content: `thinking_level` or `thinking_budget`, never both. Level accepts `minimal`, `low`, `medium`, `high`; budget is a nonnegative integer. Both are accepted only for `provider: "google"`; the API validates model-family support. [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

No request field is silently translated between services. A provider's 400 for unsupported model-specific combinations is returned as an error. Output caps include reasoning/thinking tokens where the provider reports them.

## Output caps and cut-off answers

Without `request.max_output_tokens` or the model's `max_output_tokens`, OpenAI, Responses and Gemini requests send no cap and the service default applies. Anthropic requires one, so Raw sends 32000 (an eighth of `context_window_tokens` when that is smaller); if an older model answers that the value exceeds its maximum, the request is repeated once with the stated maximum. A configured cap is never lowered. Context budgeting reserves the same amount for output.

A response that stops at the output limit (`length`, `max_tokens`, `MAX_TOKENS`, or an incomplete Responses result with reason `max_output_tokens`) is not an error. Its text is kept and the agent sends a short notice asking the model to continue where it stopped, up to eight consecutive times. A tool call whose arguments were cut off returns an `invalid_arguments` result telling the model to retry with smaller arguments. Other finish reasons, such as content filters, still fail the turn.

## Cache and continuation

The system prompt, tool definitions and committed message history keep stable order across turns. OpenAI receives a stable session `prompt_cache_key`; Anthropic receives `cache_control` in auto mode; Google relies on implicit caching; other services get no guessed hint. A selected `llama.cpp` Chat backend can opt into `cache_prompt`. Cache availability and hits remain provider decisions. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

**Tool choice for compaction.** A request can carry `toolChoice` (`"auto"` or `"none"`). Each adapter sends it only when it is set and the request has tools: Chat Completions and Responses send `tool_choice`, Anthropic `tool_choice: {type}`, Gemini `toolConfig.functionCallingConfig.mode` (`AUTO` or `NONE`). Main requests never set it. A summary written from the cached main context (see [context](context.md)) sets `"none"` only where the provider documents that this keeps the prompt cache:

| Service and method | Sent by compaction | Source |
|---|---|---|
| OpenAI, Chat Completions and Responses | `tool_choice: "none"` | The [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) recommends: "Set tool_choice to "none" instead of removing the tool definitions." |
| Anthropic | nothing | The [prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) lists tool choice under what invalidates the cache: "Changes to `tool_choice` parameter only affect message blocks." |
| Google Gemini | nothing | The [context caching guide](https://ai.google.dev/gemini-api/docs/caching) does not say whether tool settings are part of the implicitly cached prefix. |
| Other services on a compatible method | nothing | No documented cache behavior. |

Without `"none"`, the summary request relies on its no-tools instruction, and a tool call in the answer sends compaction to its chunked path. Whether the prefix was reused shows in the compaction's usage events as cache-read tokens, when the provider reports them.

Function calls and tool results remain linked by call ID. Responses output items, Anthropic thinking/signature blocks, Gemini thought signatures, OpenRouter reasoning details and DeepSeek `reasoning_content` are kept as opaque continuation data and never mixed into assistant answer text. When a provider streams plaintext reasoning, the CLI displays those deltas on stderr. Opaque signatures and encrypted reasoning remain hidden. Tool images are passed as native image content where the method accepts them; base64 is never presented as an ordinary text description.

For `vision:true`, `view_image` produces a typed PNG/JPEG tool result. Chat Completions sends the linked text tool response followed by an image user block; Responses sends image content inside the linked `function_call_output`; Anthropic uses an image within the `tool_result`; Gemini uses `inlineData` in the function response. A provider may still reject a specific model's vision capability; that upstream error remains visible. Text-only agents can use MCP vision-to-text tools that perform OCR or visual analysis outside the selected model and return text.

## User images

A user message may contain PNG/JPEG `image` blocks next to text and resource links (`{type:"image", data, mimeType, name?}`, base64 data). All four adapters send them natively and in original block order: Chat Completions `image_url` data URLs, Responses `input_image`, Anthropic base64 `image` sources and Gemini `inlineData`. A message without images keeps its previous request shape.

Images are validated before the message enters the session: base64 syntax, PNG/JPEG structure matching the declared type, and at most 16 MiB of decoded image bytes per message. An invalid message returns `unsupported_content` without a provider request and without changing the saved context.

`vision:false` models never receive image bytes. When the request is built, every user image, including images earlier in the session, is replaced by a text placeholder that says the image was omitted because the current model cannot read images and that earlier assistant messages may describe it. The saved context keeps the original image, so a later vision-capable agent receives it natively. Context estimates count an image as a fixed conservative token cost instead of counting its base64 text, and compaction summaries see only an `[Image: type, bytes]` description.

Vision models also never receive an image their API would reject. Request-time limits count the base64 text the request carries, and the request bound covers the whole body (messages, system prompt and tool schemas): Anthropic Messages allows 5 MiB and 8000 px per image (2000 px once a request has more than 20 images), 100 images and 30 MiB per request; Google 18 MiB per request; the OpenAI methods 500 images and 45 MiB per request. Images are admitted newest first, so the latest screenshot wins. An image over a per-image size or pixel limit is replaced by a text note that gives its size and suggests viewing a smaller copy; an older image past the request allowance is replaced by a note to view it again if needed. User images and tool-result images are treated alike, the request is still sent, and the saved context keeps every original image.


Usage reports include observed input, output, cache read and cache write counters. Missing fields remain unknown. This is not a tokenizer-based estimate of the model's remaining context.
