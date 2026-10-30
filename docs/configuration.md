# Configuration reference

# Agent configuration contract

Raw names each runnable configuration an **agent**. `models.<alias>` defines an upstream model connection; `agents.<name>` selects that model and defines its prompt, tools, skills, policy, and limits. `default_agent` selects the agent when `--agent NAME` and `RAW_AGENT` are absent. A fresh `raw config init` creates agent `raw`; an existing config may set a different default. The old `profiles`, `default_profile`, `--profile`, and `RAW_PROFILE` names are unsupported in this breaking release.

## File and selection

Raw reads one strict JSON file from $XDG_CONFIG_HOME/raw/config.json or ~/.config/raw/config.json (on Windows, `%USERPROFILE%\.config\raw\config.json`). --config PATH replaces that file. An absent implicit file is allowed; an absent explicit file is an error. Duplicate and unknown fields fail validation. A leading UTF-8 byte order mark, which some Windows editors add, is accepted here and in the other JSON files Raw reads.

The optional root `ui` object configures terminal presentation independently of agents and models. It is allowed in canonical and alternate config files. `density` accepts `compact`, `normal`, or `verbose`; `reasoning` accepts `hidden`, `summary`, or `full`; `color` accepts `auto`, `always`, or `never`; `icons` accepts `auto`, `unicode`, or `ascii`; `theme` accepts `terminal`, `dark`, or `light`. An optional `palette` maps documented semantic roles to basic ANSI color names. Flags `--display`, `--reasoning`, `--color`, `--icons`, and `--theme` override these fields. See [terminal output](terminal-output.md) for appearance, stream behavior and the complete palette contract.

The canonical global file alone may set `"sessions": {"retention_days": 30}`. The value must be a positive integer and defaults to 30. An alternate `--config` file may select a model/agent, but a `sessions` block there is rejected so it cannot change the shared session database's expiry policy. Retention is measured from the last committed conversation activity, with expiry at the exact cutoff; reading, listing, and heartbeats do not renew it. Expired sessions become unavailable immediately, then idle maintenance permanently deletes their history, active model context, and referenced payloads after any live writer releases its claim. CLI session commands perform a bounded cleanup pass after their work; a long-lived ACP server checks periodically while idle. Disk reclamation and WAL checkpointing happen only when useful and no writer is active. `raw sessions stats` reports actual database, WAL, and payload space, plus the largest sessions.

The session store normally lives at `$XDG_STATE_HOME/raw/sessions.sqlite`, or `~/.local/state/raw/sessions.sqlite` (on Windows, `%USERPROFILE%\.local\state\raw\sessions.sqlite`) when that variable is unset. If the normal path contains an unsupported older format, Raw preserves that database and uses `raw/stores/storage-v6/sessions.sqlite` below the same state root. The active store's payload files live beside its database. Its directories and database are private to the OS user. Back up the entire state directory, including both databases and their payload files, before the retention cutoff if saved history must survive local disk loss. There is no automatic export or pin exemption; cleanup is permanent for the active store. There is no migration for unreleased session formats.

The current unreleased session schema is version 6. Terminal themes and UI settings are not stored as model identity; a user can change them between runs without rewriting a session. Raw does not migrate old test sessions automatically.

The unreleased schema is breaking. It has no old flat-agent parser or migration aliases. The root has models, agents and optional default_agent. A model key is a local alias; model_id is the exact value sent upstream. An agent names one model alias and supplies run settings.

~~~json
{
  "default_agent": "deepseek",
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
  "agents": {
    "deepseek": {
      "model": "flash",
      "tools": {"use": ["builtin/read_file", "builtin/write_file", "builtin/edit_file", "builtin/bash"]},
      "max_steps": 25,
      "max_output_bytes": 65536,
      "request_timeout_ms": 600000,
      "compact": {"keep_recent_turns": 2, "max_output_tokens": 16384}
    }
  }
}
~~~

provider identifies the upstream service or named deployment. method selects one of openai-chat-completions, openai-responses, anthropic-messages and google-generate-content. No method is inferred from a model name or provider string.

Select with --agent, then RAW_AGENT, then default_agent. There is no direct --provider, --model or --base-url override. An agent selection binds the model, endpoint and credentials for the session.
The removed RAW_PROVIDER, RAW_MODEL and RAW_BASE_URL environment variables cause an error if present, including when empty.

## Model fields

Required: provider, method, model_id. Optional: base_url, api_key or api_key_env (mutually exclusive), context_window_tokens, max_output_tokens and `vision` (boolean, default false). Both token limits are positive integers; max_output_tokens must be smaller than context_window_tokens when both are set. An agent request output cap also leaves at least max(64, 5% of context_window_tokens) as a static headroom reserve. These limits are metadata, not exact remaining-token counts. A declared `context_window_tokens` enables automatic compaction by default (see `compact` below). `vision:true` permits explicit selection of `builtin/view_image`; no tool is added implicitly.

api_key is a literal key. api_key_env is the name of an environment variable. Only the selected model resolves its credential. Known service defaults are OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, OPENROUTER_API_KEY and a local Ollama endpoint. A custom service requires an explicit base_url and key source if the endpoint requires authentication. Config list validates all entries without resolving inactive credentials or printing secrets.
Official SDK endpoint defaults apply only when provider and method are the matching service pair. Any other combination requires an explicit base_url so credentials never go to an adapter default for a different service.

A CLI model runs a coding CLI instead of an API ([external backends](#external-backends)): `method` is `claude-code-cli`, `codex-cli` or `antigravity-cli`. Optional: `model_id` (the CLI's own model name; omitted or empty runs the CLI's default), `provider` (a label only) and `executable` (the CLI binary when it is not `claude`, `codex` or `agy` on `PATH`). `context_window_tokens` is optional too: the window Claude Code and Codex compact against (see [context and compaction](#cli-context-and-compaction)). The CLI keeps its own login and endpoint, so `base_url`, `api_key`, `api_key_env`, `max_output_tokens` and `vision` are unknown fields on a CLI model.

## Agent fields

Agents support model (an API or CLI model alias, see [external backends](#external-backends)), request, max_steps, max_output_bytes, request_timeout_ms, cache, compact, tools, skills, hooks, system_prompt, system_prompt_file and, on a CLI model only, system_prompt_mode. `tools.use` is required and lists exact tool IDs in model-visible order. IDs use `builtin/name`, `local/name`, `agent/name`, or `mcp/server/tool`. An empty array gives the agent no initial tools. Optional `skills.use` selects `builtin/<id>`, `local/<id>` or `agent/<id>` skills; a nonempty list requires both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. See [skills](skills.md). Optional `hooks.use` is an ordered array of `agent/<id>`, `local/<id>`, or installed `pkg/<alias>/hooks/<export>` IDs. A hook folder contains `hook.json` and a command script; for example `"hooks":{"use":["agent/check_commands"]}` selects `hooks/check_commands/` beside the config. See [hooks](hooks.md) for fields, events, matchers, response protocol and errors. `system_prompt` is literal text, including an explicit empty string; `system_prompt_file` names a UTF-8 Markdown file relative to the selected config file or by absolute path. The two prompt fields cannot be combined. Prompt precedence is `--system-prompt`, `RAW_SYSTEM_PROMPT`, the selected agent field, then Raw's default; an agent on a CLI model without a prompt runs its CLI's own prompt instead of Raw's default. No backend CLI can take an explicit empty prompt: it keeps its own and the session shows a warning. Numeric CLI flags override RAW_* environment values, which override agent values, which override built-in defaults. Default max_steps is 10000, max_output_bytes is 65536 and request_timeout_ms is 600000. `request_timeout_ms` bounds how long a model stream may stay silent, including before its first event, not how long a streaming answer may take; transient failures (429, 5xx, overload, dropped connections) before the stream starts are retried up to three times with exponential backoff, honoring `retry-after`. The strictly typed request fields and provider/method matrix are in [providers.md](providers.md).

cache retains mode, key, retention and backend controls where the provider/method actually supports them. `compact.keep_recent_turns`, `compact.keep_recent_tokens` and `compact.max_output_tokens` configure manual or automatic compact using the selected session model. `compact.keep_recent_tokens` is a positive integer: the estimated tokens of newest steps kept verbatim after a compaction, by default the smaller of 20000 and a quarter of the input budget. `compact.keep_recent_turns` keeps at least that many recent turns when they fit. When the model declares `context_window_tokens`, automatic compaction is on by default at 80% of the input budget (context minus output reserve and safety margin); an explicit `compact.trigger_tokens` sets another threshold and `"trigger_tokens": false` keeps compaction manual. An explicit threshold requires `context_window_tokens` and must leave the output reserve and safety margin. `compact.clear_tokens` is the estimated-token threshold at which old tool results larger than 2 KB are replaced by stubs naming a saved copy, before any compaction; it defaults to 60% of the input budget when the model declares `context_window_tokens`, an explicit positive integer requires `context_window_tokens`, and `false` turns clearing off. `compact.instructions` is optional extra text, at most 16384 characters, appended to the checkpoint prompt of every compaction for this agent, for example `"Keep every audit item ID with its status."`. `compact.strategy` is `"checkpoint"` (the default) or `"native"`, which first tries the provider's own compaction on Anthropic Messages and OpenAI Responses and falls back to a checkpoint with a warning ([context](context.md#compaction)). `tools.use` selects tools from shipped, global, config-local, and top-level `mcp.servers` sources. `tools.rules` applies ordered allow/ask/deny matching, with unmatched calls allowed automatically. An inactive global MCP server is never started. Agents written for the earlier `agent.mcp` format must be rewritten; there is no migration. See [context](context.md), [MCP](mcp.md) and [tools](tools.md).

An `ask` rule can add `when.any` and `when.regex` to inspect selected string, number or boolean arguments after validation. For Bash, use `command`; the RE2JS pattern is unanchored and a matching command asks before it runs. Invalid paths or patterns fail early. See [tools](tools.md) for a direct `rm` example and the limits of text matching.

The packaged `examples/agents/project-helper/` is a complete config-relative
agent: copy the whole folder, edit its `raw.json` model ID and endpoint for the
recipient, and run `raw --config /path/to/project-helper/raw.json --agent
project "task"` from any workspace. `prompt.md`, `tools/project_note/`, and
`skills/project/` resolve beside `raw.json`, independent of the checkout or
sender's home directory. Credentials come from the recipient's environment or
model config. This example selects bundled, config-local, and skill tools and
gates only Bash command strings matching its `rm` policy. An agent that also
needs a global fork or MCP tool can add `local/my_tool` or
`mcp/search/web_search` to the same `tools.use` list after installing that
folder or configuring that server.

For an agent using every source type, this is a complete agent example after
you provide the named local fork and MCP server. It uses a file prompt; replace
`system_prompt_file` with `system_prompt` for literal inline text. The Bash
rule asks for matching `rm` command strings; other Bash calls run directly.

```json
{
  "default_agent": "project",
  "models": {
    "local": {
      "provider": "ollama",
      "method": "openai-chat-completions",
      "model_id": "YOUR_INSTALLED_MODEL",
      "base_url": "http://127.0.0.1:11434/v1"
    }
  },
  "mcp": {
    "servers": {
      "search": { "transport": "stdio", "command": "YOUR_SEARCH_SERVER", "args": [] }
    }
  },
  "agents": {
    "project": {
      "model": "local",
      "system_prompt_file": "prompt.md",
      "tools": {
        "use": ["builtin/read_file", "builtin/bash", "local/my_tool", "agent/project_note", "mcp/search/web_search", "builtin/list_skills", "builtin/load_skill"],
        "rules": [{
          "match": "builtin/bash", "effect": "ask",
          "when": { "source": "arguments", "any": "command", "regex": "(^|[;&|()\\n])\\s*(sudo\\s+)?(/usr/bin/|/bin/)?rm(\\s|$)" }
        }]
      },
      "skills": { "use": ["agent/project"] }
    }
  }
}
```

For example, the DeepSeek agent above compacts automatically because its model declares a 1048576-token context; add `"trigger_tokens": 800000` to its `compact` object to choose the threshold, or `false` to keep it manual. Raw uses a conservative serialized-request estimate and checks the full request after compact; the exact context usage remains provider-specific.

raw config init writes this schema once with mode 0600 (on Windows the file takes its folder's access rules). raw config list displays agent name, model alias, upstream model_id, provider, method, sanitized endpoint, vision, selected tool IDs, tool rules and compact trigger; for a CLI model it shows the method, `CLI` and the `model_id` or `CLI default` in place of model, provider and endpoint. It never displays api_key, resolved environment values, or prompt text.

## Check a config

`raw config check` loads every agent of the active config as a run would, without running anything: no model request, MCP server, CLI start, package write or session. It prints one line per agent in config order, its warnings under it, and a total:

```text
ok      raw     flash (openai-chat-completions)
ok      codex   terra (codex-cli)
        warning: codex agent "codex" skips request.max_output_tokens: it configures Raw's own agent loop
error   claude  agent claude references unknown model: opsu
3 agents, 1 errors, 1 warnings
```

An error is whatever makes loading that agent fail, the same rule every run applies; each agent is checked alone, so one broken agent does not hide the others. A warning is something a run degrades on: a setting a CLI skips, a CLI that is not installed, an API key that is not set. A problem outside the agents (invalid JSON, a bad `models` entry, `agents` that is not an object, an unknown `default_agent`) prints a single `error   config  <message>` line. The exit code is 1 when anything errors, 0 otherwise, warnings included.

`raw config check FILE` (or `-` for stdin) checks a candidate in the active config's place: relative paths such as `system_prompt_file` resolve from the active config's directory, `sessions` is allowed when the active config is the canonical one, and installed packages resolve from the active config's package index. The active file is not read for content and not changed. A linked package is packed into a private temporary directory for the check and removed afterwards; the package store is not written.

`--try-config FILE` runs any task, `--interactive`, `config list`, `config check` or `vars` with FILE's text in the active config's place, the same way. The session a task creates is an ordinary session; the candidate is not saved anywhere. It cannot be combined with `--config`, `config init`, `--acp` or `raw dashboard`, which would write the candidate's place or keep it in use.

A safe edit of the active config: copy it to `config.candidate.json` beside it, edit only the candidate, then run this script with the agent to try. Each step runs only when the previous one passed; a failure leaves the active config untouched and the candidate in place.

```sh
set -eu
active="${XDG_CONFIG_HOME:-$HOME/.config}/raw/config.json"
candidate="$(dirname "$active")/config.candidate.json"
# Steps 1-2 happened before: cp "$active" "$candidate", then the edit, in the candidate only.
raw config check "$candidate" || exit 1
raw --try-config "$candidate" --agent "$1" "Reply with just: OK" || exit 1
cp -p "$active" "$active.bak"
cp "$candidate" "$active"
chmod 600 "$active"
```

For a config chosen with `--config PATH`, put the candidate beside it and copy `PATH.packages.lock.json` (the installed-package index, when it exists) to `CANDIDATE.packages.lock.json`, then check and try with `--config CANDIDATE`; remove that copy afterwards.

## External backends

An agent can run an external coding CLI instead of Raw's own loop: Claude Code (`claude`), Codex (`codex`) or Antigravity (`agy`). Declare the CLI as a model with a CLI method and point the agent's `model` at it, as for any model.

```json
{
  "models": {
    "haiku": { "method": "claude-code-cli", "model_id": "haiku" },
    "luna": { "method": "codex-cli", "model_id": "gpt-6-luna" },
    "flash": { "method": "antigravity-cli", "model_id": "gemini-3.8-flash" }
  },
  "agents": {
    "claude-helper": {
      "model": "haiku",
      "system_prompt": "You are a careful reviewer.",
      "tools": { "use": ["builtin/todo", "builtin/ask_user"] }
    },
    "codex-helper": { "model": "luna", "request": { "reasoning_effort": "high", "mode": "workspace-write" }, "tools": { "use": [] } },
    "agy-helper": { "model": "flash", "tools": { "use": [] } }
  }
}
```

The model's `model_id`, and the agent's `request.reasoning_effort` and `request.mode` (the CLI's permission mode), are passed to the CLI as strings; the CLI's own list of values decides, and a value it does not list gives a warning and the CLI's default. An empty `model_id` runs the CLI's default model. The agent's `system_prompt_mode` is `"replace"` (default: the agent's prompt replaces the CLI's) or `"append"`; it is a config error on an agent with an API model.

Selected tools the CLI already provides (`builtin/read_file`, `write_file`, `edit_file`, `apply_patch`, `bash`, `powershell`, `view_image`), `hooks.use`, `request` keys other than `reasoning_effort` and `mode`, `compact` keys other than `trigger_tokens`, and the loop-only settings `cache` and `max_steps` are skipped with a warning; the agent still runs. `raw config check` lists those warnings without starting the CLI. A package agent binding names a CLI model in `model` like any other. See [backends](backends.md).

### CLI context and compaction

The CLI compacts its own conversation; Raw's `/compact` does not apply. Two settings are passed to it:

| Setting | Claude Code | Codex | agy |
| --- | --- | --- | --- |
| model `context_window_tokens` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; wins over `autoCompactWindow` in `~/.claude/settings.json` | `model_context_window` in the thread config | skipped with a warning |
| agent `compact.trigger_tokens` | skipped with a warning: Claude Code compacts 33000 tokens below its window | `model_auto_compact_token_limit` in the thread config; must be below the model's window, and Codex caps it at 90% of the window (a higher one warns) | skipped with a warning |

Without them each CLI keeps its own settings. The chat shows the configured window (not for agy), and the trigger: with a Codex trigger and window, Codex's limit as Codex computes it (the trigger capped at 90% of the window); with a Codex trigger alone the trigger as an estimate (`≈`), since Codex caps it by its own window; with a Codex window alone none, since a limit your own `CODEX_CONFIG` sets may apply; or for Claude Code an estimate of 33000 below the window, shown as `≈327k` and "Auto compact at (estimated)". Claude Code reports the model's largest window (1M for Opus) whatever it compacts against, so Raw shows its own value when one is set. `"trigger_tokens": false` has no CLI equivalent and is skipped.

```json
{
  "models": {
    "claude-code": { "method": "claude-code-cli", "context_window_tokens": 360000 },
    "terra": { "method": "codex-cli", "model_id": "gpt-6.1-terra", "context_window_tokens": 200000 }
  },
  "agents": {
    "claude": { "model": "claude-code", "tools": { "use": [] } },
    "codex": { "model": "terra", "compact": { "trigger_tokens": 150000 }, "tools": { "use": [] } }
  }
}
```

## Runtime flags

Supported: --agent, --config, --try-config ([check a config](#check-a-config)), --system-prompt, --max-steps, --max-output-bytes, --request-timeout-ms, --interactive, --acp transport flags and -y/--auto-approve. RAW_SYSTEM_PROMPT can override the minimal default prompt. Unmatched tools run automatically; -y does not override an explicit agent ask rule when tool policy is added.

The method-specific request, cache and compact behavior is documented in docs/providers.md and docs/context.md.

## Runtime variables

Optional root `vars` and `var_providers` declare lazy values and executable sources. `agents.<name>.vars` selects exact names; omitted means none. Static validation performs no resolution. See [variables](vars.md) for the complete schema, access and provider protocol.

## Installed package bindings

`agents.<name>` may be an instance binding such as `{"from":"pkg/kit/agents/writer","model":"local","inputs":{"region":"Hanoi"},"overrides":{"max_steps":30}}`. `model` always names a recipient model, an API or a CLI model. `inputs` supply typed package definition values; `overrides` may replace `system_prompt`, `system_prompt_file`, `system_prompt_mode`, `request`, `cache`, `compact`, `tools`, `skills`, `vars`, `max_steps`, `max_output_bytes`, or `request_timeout_ms`. Each list/block replaces the whole inherited list/block. Package source cannot set a publisher model alias. `raw agent add NAME --from REF --model ALIAS [--inputs FILE]` writes this binding atomically; existing names require an explicit edit.

A direct agent can select an installed tool or skill by `pkg/ALIAS/tools/EXPORT` or `pkg/ALIAS/skills/EXPORT`. An object selection `{"ref":"pkg/kit/tools/search","as":"web_search","inputs":{}}` sets its model-visible alias; `as` also works for skills. Package tool rules match the canonical `@owner/name#tools/export` identity. Multiple installed packages can expose the same original tool name when selections give distinct `as` aliases. Selected assets alone are loaded. Package release labels, install paths and unused exports do not affect the model prefix.

Root `vars.NAME`, `var_providers.NAME` and `mcp.servers.NAME` may be `{"from":"pkg/ALIAS/KIND/EXPORT","inputs":{...}}`. These names remain local aliases. Package agent definitions can use `#kind/export` for their own components and `dep:alias#kind/export` for an exact bundled dependency. A package update changes the next runtime attach, including `--resume`; unchanged later turns keep the new baseline. [Packages](packages.md) has the manifest, input and lifecycle contract.

Managed dashboard edits use [revision-checked configuration and owned component services](management.md). Viewing a catalog never imports tool code or starts providers/MCP; changes take effect on the next turn.

The current development tool inspection contract uses explicit predicate sources and separate intended effects; see [tool-effects.md](tool-effects.md). Old tool/hook formats are not adapted.

`builtin/ask_user` is an opt-in tool ID in `tools.use`; it is not added to the starter agent. Questions use the host's generic interaction adapter and the configured `max_output_bytes` budget. Input collection is independent of tool `ask` permission rules.

`builtin/process` is opt-in and separate from `builtin/bash`. Hosts inject a session-scoped process context backed by their supervisor; starter selections are unchanged. Managed background starts work on macOS, Linux and Windows, with an explicit unavailable result on hosts without a supervisor.

Sessions with live managed processes remain addressable and retained while their owning host is alive, even after the conversation retention cutoff. This does not renew conversation activity. Once those jobs settle, normal expiry applies.
