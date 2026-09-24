# Configuration reference

## Runtime file and profiles

Runtime settings come from `$XDG_CONFIG_HOME/raw/config.json` or `~/.config/raw/config.json`. `--config <path>` chooses exactly one replacement file. Missing implicit config is allowed; a missing explicit file is an error. The format is strict JSON. No `.env` file or project runtime file is loaded implicitly.

The root object contains optional `default_profile`, required `profiles` when a profile is used, and optional `compact`. Each named profile has `provider` and `model`; it may also set `base_url`, `api_key_env`, `context_window`, `max_output_tokens`, and `cache`. The same provider may appear in many profiles. Provider names: `openai`, `openai-compatible`, `openrouter`, `ollama`, `anthropic`, `google`.

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
    "another-local-source": {
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

Select a profile with `--profile`, then `RAW_PROFILE`, then `default_profile`. A missing or unknown selection fails before a model connection. Without a profile, `--provider`/`--model` or `RAW_PROVIDER`/`RAW_MODEL` can be used. For individual settings, flags override environment, which overrides the selected profile. A model-only override is allowed. A conflicting provider or endpoint override with a selected profile is rejected so credentials cannot silently move to another destination.

`api_key_env` is the *name* of an environment variable, never a literal key. Only the active inference or explicitly selected compact profile resolves its key. Defaults when the field is omitted: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` with `GOOGLE_API_KEY` fallback, and `OPENROUTER_API_KEY`. Ollama needs no real key. Generic compatible endpoints may specify an optional `api_key_env`. List and error output redact credentials and URL userinfo/query values.

`context_window` is optional positive metadata for display and basic validation. It cannot count exact provider tokens. `max_output_tokens`, if given, is positive and smaller than `context_window` when both appear. Neither field silently compacts history.

`raw config init` creates a local starter only when the file is absent. `raw config list` prints names, providers, models, and sanitized endpoints, without requesting credentials or contacting a model. The loader and list command apply the same schema checks, including every profile and compact setting. Listing a malformed profile returns an error rather than displaying it as usable. URL redaction covers HTTP(S) schemes regardless of case. Loaded runtime settings and profiles are immutable after validation. A provider's default endpoint is the profile's effective endpoint when comparing an explicit override or resolving a compact profile.

## CLI and environment settings

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Profile | `--profile` | `RAW_PROFILE` | Config `default_profile` |
| Provider | `--provider` | `RAW_PROVIDER` | Selected profile |
| Model | `--model` | `RAW_MODEL` | Selected profile |
| Endpoint | `--base-url` | `RAW_BASE_URL` | Selected profile/provider default |
| System prompt | `--system-prompt` | `RAW_SYSTEM_PROMPT` | Exact built-in text |
| Inference requests per run | `--max-steps` | `RAW_MAX_STEPS` | 25 |
| Model-facing result bytes | `--max-output-bytes` | `RAW_MAX_OUTPUT_BYTES` | 8192 |
| Inference/MCP/callback deadline in ms | `--request-timeout-ms` | `RAW_REQUEST_TIMEOUT_MS` | 120000 |
| Bash executable | — | `RAW_BASH_PATH` | Bash from PATH |

Positive limits reject zero, negative, fractional, nonnumeric, and overflowing values. Empty `RAW_SYSTEM_PROMPT` or `--system-prompt ''` is an explicit empty prompt. Help/version/config init/list do not require a model credential.

## Compaction and cache fields

`compact.profile` optionally selects a configured source only for an explicit compact request; no local conversation is sent to a cloud profile automatically. `compact.keep_recent_turns` defaults to 2 and is a nonnegative integer. `compact.max_output_tokens` defaults to 512. Compaction is manual and lossy; failure leaves existing history intact.

`cache.mode` is `auto` or `no-hints`. `no-hints` suppresses hints added by raw, while a provider may still cache implicitly. Optional `cache.key`, `cache.retention`, and `cache.backend` (`generic` or `llama.cpp`) are accepted only where documented for the selected provider/API. Unsupported combinations fail validation. Cache hits do not enlarge a model's context window; `/stats` will show reported usage when available.

MCP server configuration uses a separate `mcp.json` and optional project `raw-mcp.json`; see the later MCP phase. No MCP server instructions become system prompt text.
