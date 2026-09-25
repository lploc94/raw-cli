# Configuration reference

## File and selection

Raw reads one strict JSON file from $XDG_CONFIG_HOME/raw/config.json or ~/.config/raw/config.json. --config PATH replaces that file. An absent implicit file is allowed; an absent explicit file is an error. Duplicate and unknown fields fail validation.

The canonical global file alone may set `"sessions": {"retention_days": 7}`. The value must be a positive integer and defaults to 7. An alternate `--config` file may select a model/profile, but a `sessions` block there is rejected so it cannot change the shared session database's expiry policy. Retention is measured from the last committed conversation activity, with expiry at the exact cutoff; reading, listing, and heartbeats do not renew it. Expired sessions become unavailable immediately, then idle maintenance permanently deletes their history, active model context, and referenced payloads after any live writer releases its claim. CLI session commands perform a bounded cleanup pass after their work; a long-lived ACP server checks periodically while idle. Disk reclamation and WAL checkpointing happen only when useful and no writer is active. `raw sessions stats` reports actual database, WAL, and payload space, plus the largest sessions.

The session store lives at `$XDG_STATE_HOME/raw/sessions.sqlite`, or `~/.local/state/raw/sessions.sqlite` when that variable is unset. Its directory and database are private to the OS user. Back up the entire state directory, including the database and payload files, before the retention cutoff if saved history must survive local disk loss. There is no automatic export or pin exemption; cleanup is permanent. There is no migration for unreleased session formats.

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
      "tools": {"use": ["builtin/read_file", "builtin/write_file", "builtin/bash"]},
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

Required: provider, method, model_id. Optional: base_url, api_key or api_key_env (mutually exclusive), context_window_tokens, max_output_tokens and `vision` (boolean, default false). Both token limits are positive integers; max_output_tokens must be smaller than context_window_tokens when both are set. A profile request output cap also leaves at least max(64, 5% of context_window_tokens) as a static headroom reserve. These limits are metadata, not exact remaining-token counts. Automatic compaction is enabled only with `compact.trigger_tokens`. `vision:true` permits explicit selection of `builtin/view_image`; no tool is added implicitly.

api_key is a literal key. api_key_env is the name of an environment variable. Only the selected model resolves its credential. Known service defaults are OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, OPENROUTER_API_KEY and a local Ollama endpoint. A custom service requires an explicit base_url and key source if the endpoint requires authentication. Config list validates all entries without resolving inactive credentials or printing secrets.
Official SDK endpoint defaults apply only when provider and method are the matching service pair. Any other combination requires an explicit base_url so credentials never go to an adapter default for a different service.

## Profile fields

Profiles support model, request, max_steps, max_output_bytes, request_timeout_ms, cache, compact, tools, system_prompt and system_prompt_file. `tools.use` is required and lists exact tool IDs in model-visible order. IDs use `builtin/name`, `local/name`, `agent/name`, or `mcp/server/tool`. An empty array gives the profile no initial tools. `system_prompt` is literal text, including an explicit empty string; `system_prompt_file` names a UTF-8 Markdown file relative to the selected config file or by absolute path. The two prompt fields cannot be combined. Prompt precedence is `--system-prompt`, `RAW_SYSTEM_PROMPT`, the selected profile field, then Raw's default. Numeric CLI flags override RAW_* environment values, which override profile values, which override built-in defaults. Default max_steps is 25, max_output_bytes is 8192 and request_timeout_ms is 120000. The strictly typed request fields and provider/method matrix are in [providers.md](providers.md).

cache retains mode, key, retention and backend controls where the provider/method actually supports them. `compact.keep_recent_turns` and `compact.max_output_tokens` configure manual or automatic compact using the selected session model. Optional `compact.trigger_tokens` enables automatic compact at that estimated input-token threshold; it requires `context_window_tokens` and must leave the output reserve and safety margin. Without it, compact remains manual. `tools.use` selects tools from shipped, global, config-local, and top-level `mcp.servers` sources. `tools.rules` applies ordered allow/ask/deny matching, with unmatched calls allowed automatically. An inactive global MCP server is never started. Profiles written for the earlier `profile.mcp` format must be rewritten; there is no migration. See [context](context.md), [MCP](mcp.md) and [tools](tools.md).

For example, add `"trigger_tokens": 800000` to the DeepSeek profile's `compact` object above to enable automatic compaction for its declared 1048576-token context. Raw uses a conservative serialized-request estimate and checks the full request after compact; the exact context usage remains provider-specific.

raw config init writes this schema once with mode 0600. raw config list displays profile name, model alias, upstream model_id, provider, method, sanitized endpoint, vision, selected tool IDs, tool rules and compact trigger. It never displays api_key, resolved environment values, or prompt text.

## Runtime flags

Supported: --profile, --config, --system-prompt, --max-steps, --max-output-bytes, --request-timeout-ms, --interactive, --acp transport flags and -y/--auto-approve. RAW_SYSTEM_PROMPT can override the minimal default prompt. Unmatched tools run automatically; -y does not override an explicit profile ask rule when tool policy is added.

The method-specific request, cache and compact behavior is documented in docs/providers.md and docs/context.md.
