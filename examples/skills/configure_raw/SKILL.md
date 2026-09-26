# Configure Raw

Explain, change or diagnose existing Raw configuration. For a new skill, tool, agent or MCP connection, use its creation skill.

## Choose the task

- **Explain:** answer from this reference with a relevant example and its insertion location; inspecting or editing the installation is not required.
- **Change:** identify config/agent, preserve unrelated fields and ordering, apply the requested edit, then validate. Ask only for missing choices, not repeated authorization.
- **Diagnose:** start from the reported error; distinguish schema, missing assets, credentials and remote API failures.

## File, selection and common changes

Strict JSON: `$XDG_CONFIG_HOME/raw/config.json`, otherwise `~/.config/raw/config.json`; `--config PATH` selects one alternate file. Duplicate/unknown keys, comments and trailing commas fail. `raw config init` creates once. `raw config list` validates structure and lists agents; it does not load prompt files, plugins or connect MCP.

Root: `models` (alias map), `agents` (name map), optional `default_agent` (existing name), `mcp`, `sessions`. Agent precedence: `--agent NAME`, `RAW_AGENT`, `default_agent`. Prompt precedence: `--system-prompt`, `RAW_SYSTEM_PROMPT`, agent prompt, built-in prompt.

Add a model alias, then assign it to `agents.<name>.model`. `raw --agent NAME "query"` selects an agent, not a model alias. There is no direct `--model` or `raw model add`.

## Model: `models.<alias>`

Required nonempty strings: `provider` (service/deployment, not `openai-compatible`), `method`, `model_id` (exact upstream ID). Methods: `openai-chat-completions`, `openai-responses`, `anthropic-messages`, `google-generate-content`.

Optional fields:
- `base_url`: HTTP(S) URL. Official SDK defaults require matching OpenAI chat/responses, Anthropic messages or Google generate-content. Ollama chat defaults to `http://127.0.0.1:11434/v1`; OpenRouter chat to `https://openrouter.ai/api/v1`. Other pairs require an explicit URL.
- `api_key`: nonempty literal OR `api_key_env`: environment variable identifier (`[A-Za-z_][A-Za-z0-9_]*`), never both. Only the selected model resolves credentials: OpenAI `OPENAI_API_KEY`, Anthropic `ANTHROPIC_API_KEY`, Google `GEMINI_API_KEY` then `GOOGLE_API_KEY`, OpenRouter `OPENROUTER_API_KEY`. Other providers have no default key; omit both for unauthenticated endpoints. Prefer environment keys for sharing.
- `vision`: boolean, default false; permits selecting `builtin/view_image` but does not add it.
- `context_window_tokens`, `max_output_tokens`: positive integers. Output must be smaller than context when both exist. Use verified model limits or omit; do not invent upstream capabilities.

## Agent: `agents.<name>`

Required `model`: existing alias; `tools: { "use": [exact IDs] }`: ordered array, empty allowed. Tool IDs: `builtin/<id>`, `local/<id>`, `agent/<id>`, `mcp/<server>/<original-tool-name>`; no selection wildcards or duplicates. `local/` assets live under global Raw `tools/` or `skills/`; `agent/` assets live beside the selected config. `builtin/` comes from the package.

Optional fields:
- `skills: { "use": [exact IDs] }` (`skills.use`): unique `builtin/`, `local/`, `agent/` IDs; nonempty requires both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. Catalog/body arrive only through linked list/load results, not the initial prompt.
- `system_prompt`: literal string (including empty) OR `system_prompt_file`: nonempty UTF-8 path, relative to config or absolute; never both.
- Positive integers `max_steps` (25), `max_output_bytes` (8192), `request_timeout_ms` (120000). Numeric CLI flags override corresponding `RAW_*` variables, then agent values.
- `tools.rules`: ordered `{ "match": string, "effect": "allow" | "ask" | "deny" }` entries; last matching rule wins, unmatched calls run. Match canonical IDs or globs: `*` any text, `?` one character. Only `ask` permits `when: { "any": string, "regex": string }`: schema-bound string path plus RE2 search pattern. Bash uses `commands[*].command`. `-y` cannot bypass explicit ask; headless ask without an approval channel fails closed. Regex matching is not a shell parser or sandbox.

### Request, cache and compact

`request` is strict. Every pair permits positive `max_output_tokens`, bounded by model output capacity and context minus `max(64, ceil(context*0.05))` reserve. Additional fields only for these matching pairs:

| Pair | Additional fields and accepted values |
| --- | --- |
| OpenAI chat/responses | `service_tier`: auto/default/flex/fast/priority; `reasoning_effort`: none/minimal/low/medium/high/xhigh/max. Responses also `reasoning_mode`: standard/pro |
| DeepSeek chat | `thinking`: enabled/disabled; `reasoning_effort`: low/high/max, incompatible with explicitly disabled thinking |
| Anthropic messages | `thinking`: `{ "type": "adaptive" }`, `{ "type": "disabled" }`, or `{ "type": "enabled", "budget_tokens": N }` with integer N >=1024 and below output cap; `effort`: low/medium/high/xhigh/max; `service_tier`: auto/standard_only |
| Google generate-content | `thinking_level`: minimal/low/medium/high OR `thinking_budget`: nonnegative integer |

Other pairs accept only the common output cap. Upstream checks model support. These fields cannot override messages, tools, model or credentials.

`cache`: `mode` auto/no-hints; optional nonempty `key` (OpenAI only), nonempty `retention` (OpenAI/Anthropic only), `backend` generic/llama.cpp (llama.cpp requires chat-completions).

`compact`: nonnegative integer `keep_recent_turns` (2), positive integer `max_output_tokens` (512), optional positive integer `compact.trigger_tokens`. Automatic compact requires model context metadata and room for output plus safety margin; without trigger it is manual.

## MCP, sessions and verification

`mcp.servers.<name>`: stdio `{ "transport": "stdio", "command": nonempty string, "args": string[], "env": string map }` (args/env optional), or remote `{ "transport": "streamable-http", "url": HTTP(S) URL, "headers": string map }` (headers optional). Env/header strings are literal, not `${VAR}` interpolation. Defining a server does not activate it; select exact `mcp/name/tool` IDs. Use `add_mcp` for discovery and a connection check.

`sessions: { "retention_days": positive integer }` (default 7) is allowed only in canonical global config. Resume binds config path, agent name, model/provider/method/endpoint and effective prompt. Changing those may reject resume. Tool/schema/source changes advance revision and rotate the generated cache key; skill-only changes preserve it and may append a reload notice. Old schemas are not migrated.

Back up before edits, preserve unrelated/default fields, validate before replacement, and keep config mode 0600. Use `raw --config candidate.json config list` for a portable candidate without sessions. For a **canonical** candidate containing sessions, save this as `validate-config.sh` and run `bash validate-config.sh /path/to/candidate.json`:

<!-- example:validate-canonical -->
```sh
set -eu
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/raw"
cp "$1" "$stage/raw/config.json"
XDG_CONFIG_HOME="$stage" raw --config "$stage/raw/config.json" config list
```

This validates structure while preserving sessions and the source file; no prompt/tool copies are needed. For asset changes, load the prompt/plugin or invoke the intended MCP tool. Report changed settings, actual checks, missing dependencies and resume effects. Config parsing is not an upstream test.

## Complete example

Replace the model ID/context limit with actual capabilities; preserve unrelated existing fields.

<!-- example:config -->
```json
{
  "default_agent": "raw",
  "models": { "local": { "provider": "ollama", "method": "openai-chat-completions", "model_id": "YOUR_INSTALLED_MODEL", "context_window_tokens": 32768 } },
  "agents": { "raw": { "model": "local", "tools": { "use": ["builtin/read_file", "builtin/bash"], "rules": [{ "match": "builtin/bash", "effect": "ask", "when": { "any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*rm(\\s|$)" } }] }, "compact": { "trigger_tokens": 24000 } } }
}
```
