# API adapters and request controls

`models.<alias>.provider` names the upstream service or deployment. `models.<alias>.method` chooses the wire API; it never follows from the provider name. `model_id` is sent verbatim as the upstream model. The supported methods are `openai-chat-completions`, `openai-responses`, `anthropic-messages`, and `google-generate-content`. The selected profile is fixed for a session.

| Method | SDK call | Typical service | Output cap field |
|---|---|---|---|
| `openai-chat-completions` | `openai.chat.completions.create` | OpenAI, DeepSeek, OpenRouter, Ollama, compatible gateways | OpenAI `max_completion_tokens`; other services `max_tokens` |
| `openai-responses` | `openai.responses.create` | OpenAI | `max_output_tokens` |
| `anthropic-messages` | `anthropic.messages.create` | Anthropic or compatible gateway | `max_tokens` |
| `google-generate-content` | `google.models.generateContentStream` | Gemini or compatible gateway | `config.maxOutputTokens` |

A service and method without a known matching endpoint must set `base_url`. Credential defaults apply only to the selected model, and unknown services have no guessed authentication or cache hints. SDK retries are disabled. Abort and timeout cover the full stream.

## Profile request object

`profiles.<name>.request` is strictly validated. It cannot override `model`, `messages`, `tools`, endpoint, or credentials. All methods accept `max_output_tokens` as a positive integer no larger than the model's configured output capability and smaller than its context window when those limits are supplied.

- OpenAI Chat Completions: `service_tier` (`auto`, `default`, `flex`, `fast`, `priority`) and `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). These fields are accepted only for `provider: "openai"`; custom compatible services do not receive them by assumption.
- OpenAI Responses: the same `service_tier` and `reasoning_effort`, plus `reasoning_mode` (`standard`, `pro`), only for `provider: "openai"`. The adapter uses `store:false`, replays full response output items including opaque reasoning and function calls, and appends linked `function_call_output` items. GPT-6 Astra tool use requires this method. [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode).
- DeepSeek Chat Completions: `thinking` (`enabled` or `disabled`) and `reasoning_effort` (`low`, `high`, `max`) are accepted only for `provider: "deepseek"`. The adapter sends `thinking.type` and preserves every assistant `reasoning_content` in later requests containing tools, including ordinary assistant turns. [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/).
- Anthropic Messages: `thinking` is `{ "type": "adaptive" }`, `{ "type": "disabled" }`, or `{ "type": "enabled", "budget_tokens": N }`; `effort` is `low`, `medium`, `high`, `xhigh`, or `max`. `service_tier` is `auto` or `standard_only`. These are accepted only for `provider: "anthropic"`; the API validates snapshot-specific support. Manual `budget_tokens` must be at least 1024 and smaller than the effective output cap. Set `compact.max_output_tokens` above that budget if manual thinking is enabled; a smaller per-call override fails before network. [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort), [thinking budget rules](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
- Gemini Generate Content: `thinking_level` or `thinking_budget`, never both. Level accepts `minimal`, `low`, `medium`, `high`; budget is a nonnegative integer. Both are accepted only for `provider: "google"`; the API validates model-family support. [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

No request field is silently translated between services. A provider's 400 for unsupported model-specific combinations is returned as an error. Output caps include reasoning/thinking tokens where the provider reports them.

## Cache and continuation

The system prompt, tool definitions and committed message history keep stable order across turns. OpenAI receives a stable session `prompt_cache_key`; Anthropic receives `cache_control` in auto mode; Google relies on implicit caching; other services get no guessed hint. A selected `llama.cpp` Chat backend can opt into `cache_prompt`. Cache availability and hits remain provider decisions. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Function calls and tool results remain linked by call ID. Responses output items, Anthropic thinking/signature blocks, Gemini thought signatures, OpenRouter reasoning details and DeepSeek `reasoning_content` are kept as opaque continuation data and never displayed as assistant text. Tool images are passed as native image content where the method accepts them; base64 is never presented as an ordinary text description.

Usage reports include observed input, output, cache read and cache write counters. Missing fields remain unknown. This is not a tokenizer-based estimate of the model's remaining context.
