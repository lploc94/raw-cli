# Configuration reference

# Agent configuration contract

Raw names each runnable configuration an **agent**. `models.<alias>` defines an upstream model connection; `agents.<name>` selects that model and defines its prompt, tools, skills, policy, and limits. `default_agent` selects the agent when `--agent NAME` and `RAW_AGENT` are absent. A fresh `raw config init` creates agent `raw`; an existing config may set a different default. The old `profiles`, `default_profile`, `--profile`, and `RAW_PROFILE` names are unsupported in this breaking release.

## File and selection

Raw reads one strict JSON file from $XDG_CONFIG_HOME/raw/config.json or ~/.config/raw/config.json. --config PATH replaces that file. An absent implicit file is allowed; an absent explicit file is an error. Duplicate and unknown fields fail validation.

The canonical global file alone may set `"sessions": {"retention_days": 7}`. The value must be a positive integer and defaults to 7. An alternate `--config` file may select a model/agent, but a `sessions` block there is rejected so it cannot change the shared session database's expiry policy. Retention is measured from the last committed conversation activity, with expiry at the exact cutoff; reading, listing, and heartbeats do not renew it. Expired sessions become unavailable immediately, then idle maintenance permanently deletes their history, active model context, and referenced payloads after any live writer releases its claim. CLI session commands perform a bounded cleanup pass after their work; a long-lived ACP server checks periodically while idle. Disk reclamation and WAL checkpointing happen only when useful and no writer is active. `raw sessions stats` reports actual database, WAL, and payload space, plus the largest sessions.

The session store lives at `$XDG_STATE_HOME/raw/sessions.sqlite`, or `~/.local/state/raw/sessions.sqlite` when that variable is unset. Its directory and database are private to the OS user. Back up the entire state directory, including the database and payload files, before the retention cutoff if saved history must survive local disk loss. There is no automatic export or pin exemption; cleanup is permanent. There is no migration for unreleased session formats.

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

Select with --agent, then RAW_AGENT, then default_agent. There is no direct --provider, --model or --base-url override. An agent selection binds the model, endpoint and credentials for the session.
The removed RAW_PROVIDER, RAW_MODEL and RAW_BASE_URL environment variables cause an error if present, including when empty.

## Model fields

Required: provider, method, model_id. Optional: base_url, api_key or api_key_env (mutually exclusive), context_window_tokens, max_output_tokens and `vision` (boolean, default false). Both token limits are positive integers; max_output_tokens must be smaller than context_window_tokens when both are set. An agent request output cap also leaves at least max(64, 5% of context_window_tokens) as a static headroom reserve. These limits are metadata, not exact remaining-token counts. Automatic compaction is enabled only with `compact.trigger_tokens`. `vision:true` permits explicit selection of `builtin/view_image`; no tool is added implicitly.

api_key is a literal key. api_key_env is the name of an environment variable. Only the selected model resolves its credential. Known service defaults are OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, OPENROUTER_API_KEY and a local Ollama endpoint. A custom service requires an explicit base_url and key source if the endpoint requires authentication. Config list validates all entries without resolving inactive credentials or printing secrets.
Official SDK endpoint defaults apply only when provider and method are the matching service pair. Any other combination requires an explicit base_url so credentials never go to an adapter default for a different service.

## Agent fields

Agents support model, request, max_steps, max_output_bytes, request_timeout_ms, cache, compact, tools, skills, system_prompt and system_prompt_file. `tools.use` is required and lists exact tool IDs in model-visible order. IDs use `builtin/name`, `local/name`, `agent/name`, or `mcp/server/tool`. An empty array gives the agent no initial tools. Optional `skills.use` selects `local/<id>` or `agent/<id>` skills; a nonempty list requires both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. See [skills](skills.md). `system_prompt` is literal text, including an explicit empty string; `system_prompt_file` names a UTF-8 Markdown file relative to the selected config file or by absolute path. The two prompt fields cannot be combined. Prompt precedence is `--system-prompt`, `RAW_SYSTEM_PROMPT`, the selected agent field, then Raw's default. Numeric CLI flags override RAW_* environment values, which override agent values, which override built-in defaults. Default max_steps is 25, max_output_bytes is 8192 and request_timeout_ms is 120000. The strictly typed request fields and provider/method matrix are in [providers.md](providers.md).

cache retains mode, key, retention and backend controls where the provider/method actually supports them. `compact.keep_recent_turns` and `compact.max_output_tokens` configure manual or automatic compact using the selected session model. Optional `compact.trigger_tokens` enables automatic compact at that estimated input-token threshold; it requires `context_window_tokens` and must leave the output reserve and safety margin. Without it, compact remains manual. `tools.use` selects tools from shipped, global, config-local, and top-level `mcp.servers` sources. `tools.rules` applies ordered allow/ask/deny matching, with unmatched calls allowed automatically. An inactive global MCP server is never started. Agents written for the earlier `agent.mcp` format must be rewritten; there is no migration. See [context](context.md), [MCP](mcp.md) and [tools](tools.md).

An `ask` rule can add `when.any` and `when.regex` to inspect selected string arguments after validation. For Bash batches, use `commands[*].command`; the RE2JS pattern is unanchored and any matching command asks once before the batch starts. Invalid paths or patterns fail early. See [tools](tools.md) for a direct `rm` example and the limits of text matching.

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
          "when": { "any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*(sudo\\s+)?(/usr/bin/|/bin/)?rm(\\s|$)" }
        }]
      },
      "skills": { "use": ["agent/project"] }
    }
  }
}
```

For example, add `"trigger_tokens": 800000` to the DeepSeek agent's `compact` object above to enable automatic compaction for its declared 1048576-token context. Raw uses a conservative serialized-request estimate and checks the full request after compact; the exact context usage remains provider-specific.

raw config init writes this schema once with mode 0600. raw config list displays agent name, model alias, upstream model_id, provider, method, sanitized endpoint, vision, selected tool IDs, tool rules and compact trigger. It never displays api_key, resolved environment values, or prompt text.

## Runtime flags

Supported: --agent, --config, --system-prompt, --max-steps, --max-output-bytes, --request-timeout-ms, --interactive, --acp transport flags and -y/--auto-approve. RAW_SYSTEM_PROMPT can override the minimal default prompt. Unmatched tools run automatically; -y does not override an explicit agent ask rule when tool policy is added.

The method-specific request, cache and compact behavior is documented in docs/providers.md and docs/context.md.
