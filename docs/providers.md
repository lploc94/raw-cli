# Provider adapter contract

Runtime SDKs are pinned in `package-lock.json` during Phase 1 and imported under Node 22 before provider behavior is declared complete. Phase 3 uses their real clients against local HTTP/SSE fixtures and records the tested SDK API/options here.

Phase 1 dependency candidates verified by installed imports under Node 22.23.3: `openai` 7.23.0, `@anthropic-ai/sdk` 0.128.0, `@google/genai` 2.24.0, `@modelcontextprotocol/sdk` 1.30.1, and `@agentclientprotocol/sdk` 1.5.0. These imports establish availability only; Phase 3 and Phase 7 still require real protocol fixtures.

| Profile provider | SDK family | Planned stream API | Credential source | Endpoint |
|---|---|---|---|---|
| `openai` | Official `openai` | Chat Completions | `OPENAI_API_KEY` | SDK default |
| `openai-compatible` | Official `openai` | Chat Completions | Optional named env | Required `base_url` |
| `openrouter` | Official `openai` | Chat Completions | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `ollama` | Official `openai` | Chat Completions | No real key | `http://127.0.0.1:11434/v1` |
| `anthropic` | Official `@anthropic-ai/sdk` | Messages | `ANTHROPIC_API_KEY` | SDK default |
| `google` | Official `@google/genai` | generateContentStream | `GEMINI_API_KEY`, then `GOOGLE_API_KEY` | Gemini Developer API |

The chosen model must support tool calls. No model is selected or replaced automatically. Adapter errors include unsupported tool capability, refusal, invalid stream, and network failure without treating partial output as completion. Automatic SDK retries are disabled for inference requests.

Cache details must be recorded against actual pinned SDK request types during Phase 3/5. OpenAI Chat Completions must not receive Responses-only options. Anthropic requires its documented `cache_control` to activate caching. Google uses supported implicit caching. Generic compatible endpoints do not receive guessed provider-specific fields. A user-selected `llama.cpp` backend may use its documented `cache_prompt` option. Actual cache hit metrics are reported only when the provider returns them.

The Phase 5 [context and cache reference](./context.md) lists the exact request fields, supported retention values, stable-key rules and usage formulas. Production request tests inspect each SDK's outgoing body, including absence of unsupported fields.

Image results from MCP and delegated tools must reach a provider's native image input, or return an explicit unsupported-content error. Returning base64 as ordinary text is not a vision input. The Phase 3 and Phase 6 tests inspect real outgoing SDK requests to prove this.

## Phase 3 wire contract

The pinned SDK paths are `openai.chat.completions.create({stream:true})`, `anthropic.messages.create({stream:true})`, and `google.models.generateContentStream()`. The OpenAI SDK handles OpenAI, compatible HTTP, OpenRouter and Ollama profiles with distinct endpoint/auth configuration. Anthropic uses top-level `system` and `messages`; Google uses `config.systemInstruction` and `contents`. `max_output_tokens` maps to Chat Completions `max_completion_tokens` for OpenAI, `max_tokens` for compatible/OpenRouter/Ollama, Messages `max_tokens`, and Gemini `config.maxOutputTokens`. Only OpenAI receives `stream_options.include_usage`; generic endpoints are not assumed to support it. Adapters disable SDK retries and apply one linked abort/deadline to the full stream.

Stream adapters emit visible text deltas, then one assembled assistant response with tool IDs/names/arguments and provider finish reason. Malformed arguments with usable call linkage carry `argumentError` for a matching nonexecuting tool result in the agent loop; duplicate or unusable call IDs, a truncated stream, refusal, unsupported finish, and malformed event lifecycle remain terminal errors. Opaque Anthropic thinking/signature blocks, Google thought signatures and OpenRouter reasoning details remain in the assistant turn for subsequent requests but are never shown as visible text. Usage fields remain raw provider data until the stats layer normalizes them in Phase 5.

Tool text and structured JSON map to native tool results. PNG/JPEG data maps to Anthropic `image` blocks and Gemini `inlineData`; Chat Completions emits all pending `tool` responses before a separate `user` image attachment with a data URL. Gemini groups parallel function responses into one user content. Unsupported MIME or malformed base64 returns an explicit error before inference. No URL or resource is fetched automatically. Local HTTP/SSE fixtures exercise SDK request bodies and follow-up calls; live hosted-model qualification requires credentials and is not claimed here.
