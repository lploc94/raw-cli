# Configuration reference

## File and selection

Raw reads one strict JSON file from $XDG_CONFIG_HOME/raw/config.json or ~/.config/raw/config.json. --config PATH replaces that file. An absent implicit file is allowed; an absent explicit file is an error. Duplicate and unknown fields fail validation.

The unreleased schema is breaking. It has no old flat-profile parser or migration aliases. The root has models, profiles and optional default_profile. A model key is a local alias; model_id is the exact value sent upstream. A profile names one model alias and supplies run settings.

~~~json
{
  "default_profile": "deepseek",
  "models": {
    "flash": {
      "provider": "deepseek",
      "method": "openai-chat-completions",
      "model_id": "deepseek-flash",
      "base_url": "https://api.deepseek.com",
      "api_key_env": "DEEPSEEK_API_KEY",
      "context_window_tokens": 1048576
    }
  },
  "profiles": {
    "deepseek": {
      "model": "flash",
      "max_steps": 25,
      "max_output_bytes": 8192,
      "request_timeout_ms": 120000,
      "compact": {"keep_recent_turns": 2, "max_output_tokens": 512}
    }
  }
}
~~~

provider identifies the upstream service or named deployment. method selects one of openai-chat-completions, openai-responses, anthropic-messages and google-generate-content. No method is inferred from a model name or provider string.

Select with --profile, then RAW_PROFILE, then default_profile. There is no direct --provider, --model or --base-url override. A profile selection binds the model, endpoint and credentials for the session.
The removed RAW_PROVIDER, RAW_MODEL and RAW_BASE_URL environment variables cause an error if present, including when empty.

## Model fields

Required: provider, method, model_id. Optional: base_url, api_key or api_key_env (mutually exclusive), context_window_tokens, max_output_tokens and `vision` (boolean, default false). Both token limits are positive integers; max_output_tokens must be smaller than context_window_tokens when both are set. A profile request output cap also leaves at least max(64, 5% of context_window_tokens) as a static headroom reserve. These limits are metadata, not exact remaining-token counts. Automatic compaction is enabled only with `compact.trigger_tokens`. `vision:true` adds `view_image` to the selected session; text-only models still get the three base tools.

api_key is a literal key. api_key_env is the name of an environment variable. Only the selected model resolves its credential. Known service defaults are OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, OPENROUTER_API_KEY and a local Ollama endpoint. A custom service requires an explicit base_url and key source if the endpoint requires authentication. Config list validates all entries without resolving inactive credentials or printing secrets.
Official SDK endpoint defaults apply only when provider and method are the matching service pair. Any other combination requires an explicit base_url so credentials never go to an adapter default for a different service.

## Profile fields

Profiles support model, request, max_steps, max_output_bytes, request_timeout_ms, cache, compact, mcp and tools. Numeric CLI flags override RAW_* environment values, which override profile values, which override built-in defaults. Default max_steps is 25, max_output_bytes is 8192 and request_timeout_ms is 120000. The strictly typed request fields and provider/method matrix are in [providers.md](providers.md).

cache retains mode, key, retention and backend controls where the provider/method actually supports them. `compact.keep_recent_turns` and `compact.max_output_tokens` configure manual or automatic compact using the selected session model. Optional `compact.trigger_tokens` enables automatic compact at that estimated input-token threshold; it requires `context_window_tokens` and must leave the output reserve and safety margin. Without it, compact remains manual. `mcp` selects tools from top-level `mcp.servers`; `tools.rules` applies ordered allow/ask/deny matching, with unmatched calls allowed automatically. See [context](context.md), [MCP](mcp.md) and [tools](tools.md).

For example, add `"trigger_tokens": 800000` to the DeepSeek profile's `compact` object above to enable automatic compaction for its declared 1048576-token context. Raw uses a conservative serialized-request estimate and checks the full request after compact; the exact context usage remains provider-specific.

raw config init writes this schema once with mode 0600. raw config list displays profile name, model alias, upstream model_id, provider, method and sanitized endpoint. It never displays api_key or the resolved environment value.

## Runtime flags

Supported: --profile, --config, --system-prompt, --max-steps, --max-output-bytes, --request-timeout-ms, --interactive, --acp transport flags and -y/--auto-approve. RAW_SYSTEM_PROMPT can override the minimal default prompt. Unmatched tools run automatically; -y does not override an explicit profile ask rule when tool policy is added.

The method-specific request, cache and compact behavior is documented in docs/providers.md and docs/context.md.
