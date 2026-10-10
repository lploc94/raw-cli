---
name: configure-raw
description: "Use to explain, edit or diagnose Raw configuration through files, CLI or dashboard, including package bindings, models, agents, prompts, UI, vars, limits and policy. Use creation skills for new assets or MCP connections."
---
# Configure Raw

Edit or diagnose settings; preserve unrelated fields. Creation skills cover new assets.

## File and selection

File: `$XDG_CONFIG_HOME/raw/config.json` or `~/.config/raw/config.json`; --config selects another. Strict JSON: no unknown/duplicate fields, comments or trailing commas. `raw config init` creates once.

Root: `models`, `agents`; optional `default_agent`, `mcp`, `sessions`, `ui`, `vars`, `var_providers`. Agent precedence: `--agent NAME`, `RAW_AGENT`, `default_agent`. Prompt precedence: `--system-prompt`, `RAW_SYSTEM_PROMPT`, agent prompt, built-in prompt. No --model; agents reference model aliases.

Read `references/packages.md` for bindings and `references/dashboard.md` for web editing.

## Model: `models.<alias>`

Required strings: `provider` (service name), `method`, exact upstream `model_id`. Methods: `openai-chat-completions`, `openai-responses`, `anthropic-messages`, `google-generate-content`.

- `base_url`: HTTP(S); required except matching official OpenAI/Anthropic/Google, Ollama chat (`http://127.0.0.1:11434/v1`), OpenRouter chat (`https://openrouter.ai/api/v1`).
- `api_key`: nonempty literal OR `api_key_env`: environment identifier, never both. Default env keys: OpenAI `OPENAI_API_KEY`, Anthropic `ANTHROPIC_API_KEY`, Google `GEMINI_API_KEY` then `GOOGLE_API_KEY`, OpenRouter `OPENROUTER_API_KEY`. Selected model alone resolves credentials; other providers have no default.
- `vision`: boolean, default false; required for builtin/view_image.
- `context_window_tokens`, `max_output_tokens`: positive integers; output below context. Verify limits.

## Agent: `agents.<name>`

Required `model`: existing alias; `tools.use`: ordered unique exact IDs (empty allowed): `builtin/<id>`, `local/<id>`, `agent/<id>`, `mcp/<server>/<original-name>`. No wildcards. builtin=package, local=global Raw folders, agent=config-adjacent folders.

Optional:
- `system_prompt`: string, empty allowed, OR `system_prompt_file`: nonempty UTF-8 path relative to config or absolute. Never both.
- `skills.use`: unique builtin/local/agent IDs. Nonempty requires both `builtin/list_skills` and `builtin/load_skill`.
- `hooks.use`: ordered unique exact string IDs: `local/<name>`, `agent/<name>` or `pkg/<alias>/hooks/<export>`; empty/omitted means none. The folder has `hook.json` and owned scripts. Read `references/hooks.md` for every field and value type; `create_hook` covers authoring and tests.
- `vars`: ordered unique existing root variable names; omitted means none. Add `builtin/list_vars`/`builtin/read_var` to tools.use for discovery/reading.
- Positive integers `max_steps` (10000), `max_output_bytes` (65536), `request_timeout_ms` (600000, the longest a model stream may stay silent). Precedence: flags, RAW_* env, agent.
- `tools.rules`: ordered `{match:string,effect:"allow"|"ask"|"deny"}`. Match canonical IDs/globs (`*`, `?`); last matching rule wins; unmatched runs automatically. Only ask permits `when:{any:string,regex:string}`, a schema-bound string path and RE2 search. Bash uses `commands[*].command`. `-y` cannot bypass ask; no approval channel fails closed. Not a shell parser/sandbox.

`request.max_output_tokens`: positive, within model/context reserve. Other fields only for matching pairs:

Hook manifest and response fields are specified in `references/hooks.md`. Gate failures block; notification failures warn. Hook approval never overrides a tool rule.

| Pair | Fields/values |
|---|---|
| OpenAI chat/responses | `service_tier`: auto/default/flex/fast/priority; `reasoning_effort`: none/minimal/low/medium/high/xhigh/max; Responses `reasoning_mode`: standard/pro |
| DeepSeek chat | `thinking`: enabled/disabled; `reasoning_effort`: low/high/max, incompatible with thinking disabled |
| Anthropic messages | `thinking`: `{type:"adaptive"}`, `{type:"disabled"}` or `{type:"enabled",budget_tokens:N}` (integer >=1024, below output cap); `effort`: low/medium/high/xhigh/max; `service_tier`: auto/standard_only |
| Google generate-content | `thinking_level`: minimal/low/medium/high OR nonnegative integer `thinking_budget` |

Verify upstream support. `cache`: `mode` auto/no-hints, optional nonempty `key` (OpenAI), `retention` (OpenAI/Anthropic), `backend` generic/llama.cpp (latter requires chat). `compact`: nonnegative `keep_recent_turns` (2, a lower bound when it fits), positive `keep_recent_tokens` (verbatim tail size, min(20000, a quarter of the input budget)), positive `max_output_tokens` (16384, lowered to the model output cap and a quarter of the context), `compact.trigger_tokens`: positive threshold with context metadata/output reserve, `false` for manual only; default is 80% of the input budget when the model declares `context_window_tokens`. `compact.clear_tokens`: positive threshold for clearing old tool results to saved copies before compacting, `false` to turn it off; requires `context_window_tokens`, default 60% of the input budget. `compact.instructions`: optional string (at most 16384 characters) appended to every checkpoint prompt, e.g. what the checkpoint must always keep.

## Variables and providers

`vars.<name>` requires nonempty `description`, `access:"read"|"use"`, and `source`. Read allows read/consume; use only consume. Optional `type`: string/number/boolean/object/array/null/json. Optional `cache_ttl_ms`: integer 0..2147483647 (default 0). Names: `[a-z][a-z0-9_.-]{0,63}`; constructor/prototype reserved.

Source shapes:
- `{kind:"literal",value:JSON}`: type inferred, including false/0/empty/null.
- `{kind:"env",name:"ENV_NAME"}`: string; unset errors, empty works.
- `{kind:"file",path:"data.json",format:"json"}`: config-relative/absolute. text(default) preserves whitespace; json parses. UTF-8, <=65536 bytes.
- `{kind:"provider",name:"provider_name",params:{}}`: params: config-defined object. No recursive refs. Built-in system.time requires empty params, returns UTC ISO time.

Type defaults: env/text/time string, literal inferred, others json. Env consumption accepts string/finite number/boolean, rejecting NUL.

`var_providers.<name>` requires string `command`; optional `args`: string array ([]), `cwd`: config-relative/absolute path (config directory), `timeout_ms`: integer 1..2147483647 (5000), `max_output_bytes`: integer 1..1048576 (65536, combined stdout/stderr). system.time is reserved. Bare commands use PATH; command paths resolve from config. Args stay literal and run from provider cwd. No shell/template expansion; process inherits environment.

Providers receive `{protocol_version:1,name,params}` on stdin, return `{value,observed_at?}` JSON on stdout, exit 0. Errors fail without stale fallback.

`raw [--config PATH] [--agent NAME] vars list|get NAME` needs no model/MCP/session. List is metadata; get requires read access. Bash `commands[].env_refs` passes named vars as environment values.

Values cache per runtime; resume starts empty. Vars changes preserve the prefix/key.

## UI, MCP and sessions

Root `ui`: `density` compact/normal/verbose; `reasoning` hidden/summary/full; `color` auto/always/never; `icons` auto/unicode/ascii; `theme` terminal/dark/light. Matching flags override config. Show thinking with `"ui":{"reasoning":"full"}`.

`mcp.servers.<name>`: stdio `{transport:"stdio",command:string,args?:string[],env?:string-map,timeout_ms?}` or remote `{transport:"streamable-http",url:HTTP(S),headers?:string-map,timeout_ms?}`. `timeout_ms` (1..2147483647, default the agent request_timeout_ms) bounds connect, discovery and each call; progress notifications restart it. Env/headers stay literal. Activate by exact tools.use IDs.

Canonical-only `sessions.retention_days`: positive integer, default 30. Resume uses current config/agent on the same ID. Meaningful changes rotate once; unchanged resumes stabilize. Old stores cannot block new work.

## Edit and verify

Back up, keep mode 0600, validate before replacing. Portable candidate: `raw --config candidate.json config list`. Canonical candidate with sessions:

<!-- example:validate-canonical -->
```sh
set -eu
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/raw"
cp "$1" "$stage/raw/config.json"
XDG_CONFIG_HOME="$stage" raw --config "$stage/raw/config.json" config list
```

Test changes.

## Complete example

Replace model ID.

<!-- example:config -->
```json
{"default_agent":"raw","models":{"local":{"provider":"ollama","method":"openai-chat-completions","model_id":"YOUR_INSTALLED_MODEL","context_window_tokens":32768}},"vars":{"now":{"description":"Current UTC time","access":"read","source":{"kind":"provider","name":"system.time"}}},"agents":{"raw":{"model":"local","vars":["now"],"tools":{"use":["builtin/read_file","builtin/bash","builtin/list_vars","builtin/read_var"]},"hooks":{"use":["agent/guard"]},"compact":{"trigger_tokens":24000}}}}
```
