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

Image results from MCP and delegated tools must reach a provider's native image input, or return an explicit unsupported-content error. Returning base64 as ordinary text is not a vision input. The Phase 3 and Phase 6 tests inspect real outgoing SDK requests to prove this.
