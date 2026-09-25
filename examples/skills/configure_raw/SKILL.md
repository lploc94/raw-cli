# Configure Raw

Use for Raw config changes. Read the file, preserve unrelated settings, make a private backup and a minimal edit. Use `default_agent` to identify the target when the request omits an agent. Never display a literal key, resolved environment secret or credential-bearing URL. Keep file mode 0600.

## Locations and selection

Config is strict JSON at `$XDG_CONFIG_HOME/raw/config.json` or `~/.config/raw/config.json`; `--config PATH` chooses one alternate file. Only the canonical file may set `sessions`. `raw config init` writes once; `raw config list` validates and redacts credentials. Duplicate/unknown keys, comments and trailing commas fail.

Root keys: `models` (alias → object), `agents` (name → object), `default_agent` (existing agent name), `mcp` (object), `sessions` (object). An agent picks one model; agents may share a model. Selector precedence: `--agent NAME`, `RAW_AGENT`, `default_agent`; no selection fails a task. `profiles`, `default_profile`, `--profile`, `RAW_PROFILE`, `RAW_PROVIDER`, `RAW_MODEL`, `RAW_BASE_URL` are rejected.

## Model object: `models.<alias>`

Required nonempty strings: `provider` (service/deployment name), `method` (`openai-chat-completions`, `openai-responses`, `anthropic-messages`, or `google-generate-content`), and `model_id` (exact upstream value). Optional `base_url` is an HTTP(S) URL. `api_key` is a nonempty literal string; `api_key_env` is an environment-variable identifier (`[A-Za-z_][A-Za-z0-9_]*`); choose at most one. The selected model resolves its credential at run time. Default official endpoints exist for matching OpenAI, Anthropic and Google provider/method pairs, plus local Ollama; custom/mismatched pairs need `base_url`. `vision` is a boolean, default false. `context_window_tokens` and `max_output_tokens` are positive integers; when both exist, the latter must be smaller. `vision:true` permits selecting `builtin/view_image` but does not add it automatically.

## Agent object: `agents.<name>`

Required: `model` (defined alias) and `tools: { "use": [exact IDs] }`; `[]` is valid, order is provider-visible. IDs: `builtin/<id>`, `local/<id>`, `agent/<id>`, `mcp/<server>/<tool>`. Local tools live under global Raw `tools/`; agent tools live beside the config in `tools/`. Optional ordered `tools.rules` entries are `{ "match": string, "effect": "allow" | "ask" | "deny" }`; last matching rule wins, unmatched calls run. `match` identifies a tool or supported policy pattern (see `docs/tools.md`). Only `ask` accepts `when: { "any": string, "regex": string }`: `any` is a schema-bound string path, e.g. `commands[*].command`; `regex` is an RE2 search pattern. For Bash, `(^|[;&|()\\n])\\s*rm(\\s|$)` asks once when any batch command matches `rm`; other batches proceed. Tools use Raw's OS account.

Optional `skills: { "use": ["builtin/configure_raw", "local/my_skill", "agent/project"] }` selects unique exact IDs. A nonempty list requires both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. `builtin/` comes from the package, `local/` from global `skills/`, `agent/` from config-adjacent `skills/`. No catalog/body is in the initial request; linked list/load results reveal only selected content.

Prompt: `system_prompt` (literal string, even `""`) OR `system_prompt_file` (nonempty UTF-8 path, relative to config or absolute). Precedence: `--system-prompt`, `RAW_SYSTEM_PROMPT`, agent prompt, built-in prompt. Optional positive integers: `max_steps` (25), `max_output_bytes` (8192), `request_timeout_ms` (120000); respective CLI flags override `RAW_*` environment values, then agent values. `-y` cannot bypass an explicit `ask` rule.

`request` is an optional strict object. All provider/method pairs allow positive `max_output_tokens`, bounded by model output capability and context reserve. OpenAI chat/responses allow `service_tier` (`auto|default|flex|fast|priority`) and `reasoning_effort` (`none|minimal|low|medium|high|xhigh|max`); Responses additionally allows `reasoning_mode` (`standard|pro`). DeepSeek chat allows `thinking` (`enabled|disabled`) and `reasoning_effort` (`low|high|max`, only with thinking enabled). Anthropic messages allows `thinking` (`{ "type": "adaptive" | "disabled" }` or `{ "type": "enabled", "budget_tokens": positive integer >= 1024 }`), `effort` (`low|medium|high|xhigh|max`), and `service_tier` (`auto|standard_only`); an enabled thinking budget must be below the requested output cap. Google generate-content allows `thinking_level` (`minimal|low|medium|high`) OR nonnegative integer `thinking_budget`. Other provider/method pairs accept only `max_output_tokens`. No request field may override tools, messages, model, endpoint or credentials.

`cache`: `mode` (`auto|no-hints`), `key` (nonempty, OpenAI only), `retention` (nonempty, OpenAI/Anthropic only), `backend` (`generic|llama.cpp`; latter needs OpenAI chat method). `compact`: nonnegative `keep_recent_turns` (2), positive `max_output_tokens` (512), optional positive `compact.trigger_tokens` for auto compact. Trigger requires model `context_window_tokens` and room for output plus safety margin; otherwise compact remains manual.

## MCP and sessions

`mcp.servers` (`mcp: { "servers": { "name": server } }`) defines inert servers until an exact `mcp/name/tool` is selected in agent `tools.use` or ACP configures a cataloged tool. Stdio: `{ "transport": "stdio", "command": nonempty string, "args": string[], "env": string map }` (`args`/`env` optional). Remote: `{ "transport": "streamable-http", "url": HTTP(S) URL, "headers": string map }` (`headers` optional). Prefer environment credentials. The `add_mcp` skill covers discovery and selection.

Canonical-only `sessions: { "retention_days": positive integer }` defaults to 7; state is under `$XDG_STATE_HOME/raw/` or `~/.local/state/raw/`. Resume binds saved config path, agent name, model/provider/method/endpoint and effective prompt; changing one can reject resume. Tool/schema/source changes advance context revision and rotate Raw's generated cache key. Skill-only changes keep it and append a reload notice when needed. History is not rewritten. Old session schemas are rejected, not migrated.

## Working example and safe edit procedure

```json
{
  "default_agent": "raw",
  "models": { "local": { "provider": "ollama", "method": "openai-chat-completions", "model_id": "YOUR_INSTALLED_MODEL", "base_url": "http://127.0.0.1:11434/v1", "context_window_tokens": 32768 } },
  "agents": { "raw": { "model": "local", "system_prompt": "You are a coding assistant.", "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"], "rules": [{ "match": "builtin/bash", "effect": "ask", "when": { "any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*rm(\\s|$)" } }] }, "skills": { "use": ["builtin/configure_raw"] }, "compact": { "keep_recent_turns": 2, "max_output_tokens": 512, "trigger_tokens": 24000 } } }
}
```

Task → field: default agent → `default_agent`; one run → `--agent`; upstream model/endpoint → `models.<alias>.model_id`/`base_url`; agent model → `agents.<name>.model`; instructions → one prompt field; image → model `vision:true` plus `builtin/view_image`; tool/skill → `tools.use`/`skills.use`; ask for `rm` → conditional Bash rule; output/time → agent limits/`request`; auto compact → context window plus trigger; expiry → canonical `sessions.retention_days`.

Back up the config privately. Validate a temporary copy with `raw --config /path/to/copy config list`; copy relative prompt/`agent/` folders beside it or validate in the original directory. Atomically replace the original at mode 0600, run `raw config list`, and try a harmless task with the intended `--agent` if provider access exists. Fix the specific validation error rather than disabling checks. Report whether old sessions can resume.