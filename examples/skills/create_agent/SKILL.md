# Create a Raw agent

Use when the user wants a new named assistant with a particular role or a shareable setup. In Raw, an **agent** is one entry under `agents`; it chooses one upstream model alias and owns its prompt, request/cache/compact settings, ordered tool and skill selections, and policy. A **model** under `models` defines upstream access; a **session** is a saved conversation bound to an agent. There is no agent registry, inheritance, automatic plugin discovery, or profile compatibility layer. Inspect existing names and the requested role before editing so a new agent does not accidentally replace a current one.

## Choose global or portable layout

For a personal agent, add `agents.<new-name>` to `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`) and reference existing `models.<alias>` when appropriate. For sharing, create a directory with `raw.json`, optional `prompt.md`, `tools/` and `skills/`. `agent/<id>` references resolve beside **that config file**, so the directory can be copied intact to another machine. `local/<id>` references resolve under the recipient's global Raw config root and are not portable by copying the agent directory. `builtin/<id>` resolves from the installed Raw package. Exact `mcp/server/tool` IDs additionally require a matching `mcp.servers` definition and the recipient's server installation/credentials. Only selected assets load; no wildcard MCP selection.

The installed `examples/agents/project-helper/` is a runnable template with `raw.json`, `prompt.md`, one agent tool, one agent skill, and a conditional Bash `rm` ask rule. Copy the entire directory, edit its model ID/endpoint and name, and check every `agent/` reference before sharing. For a new agent with no custom assets, start from this smaller complete `raw.json` in a new directory:

```json
{
  "default_agent": "writer",
  "models": {
    "local": { "provider": "ollama", "method": "openai-chat-completions", "model_id": "YOUR_INSTALLED_MODEL", "base_url": "http://127.0.0.1:11434/v1", "context_window_tokens": 32768 }
  },
  "agents": {
    "writer": {
      "model": "local",
      "system_prompt_file": "prompt.md",
      "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"],
        "rules": [{ "match": "builtin/bash", "effect": "ask", "when": { "any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*rm(\\s|$)" } }] },
      "skills": { "use": ["builtin/configure_raw"] },
      "max_steps": 25,
      "compact": { "keep_recent_turns": 2, "max_output_tokens": 512, "trigger_tokens": 24000 }
    }
  }
}
```

Create `prompt.md` beside `raw.json`, UTF-8: `You are a writing assistant. Read the source material, draft accurately, and cite the files used.` The prompt file path is relative to `raw.json`, not the run cwd; an absolute path works but reduces portability. Use `system_prompt` for literal inline text instead, never both. `--system-prompt` and `RAW_SYSTEM_PROMPT` override the agent prompt at run time. Keep setup-skill routing in the prompt only if this agent is meant to configure Raw; for a specialized agent, say which selected skills it should list/load and when. Do not paste skill bodies into the prompt: list/load results arrive later and preserve the initial provider prefix.

## Model, tools, skills and MCP choices

The agent's `model` must name an existing alias. The model object needs nonempty `provider`, method (`openai-chat-completions`, `openai-responses`, `anthropic-messages`, or `google-generate-content`) and exact `model_id`. Provide HTTP(S) `base_url` for custom/gateway pairs, or use official matching defaults. Prefer `api_key_env` over literal `api_key`; never share actual credentials. `vision:true` is needed before selecting `builtin/view_image`. Optional `context_window_tokens` and `max_output_tokens` are positive integers used for budgeting and automatic compact constraints.

`tools.use` is required, ordered, and may be empty. Select exact `builtin/`, `local/`, `agent/`, or `mcp/server/tool` IDs. The `examples/tools/` package folders can be forked into `tools/` for agent-local modifications; their manifests and ESM handlers must be copied and renamed consistently. `skills.use` is optional and lists exact selected `builtin/`, `local/`, or `agent/` IDs; a nonempty list requires `builtin/list_skills` and `builtin/load_skill` in `tools.use`. A selected skill is disclosed to the model only through linked list/load calls. A selected but absent tool or skill prevents startup; unselected folders stay inert.

For MCP, define `mcp.servers.<name>` as stdio or streamable-http and select its *original tool name* with `mcp/<name>/<tool>` in `tools.use`; test the server on the recipient machine. See the `add_mcp` skill for a complete fixture. Tool policy belongs to this agent under `tools.rules`. Rules match canonical IDs, use `allow`, `ask`, or `deny`, and the **last matching rule** wins. A conditional `ask` may inspect a schema-bound string argument path such as `commands[*].command`; other Bash calls continue without a prompt. An `ask` in headless mode without an approval channel fails closed. Plugins and Bash still have the Raw process's full OS permissions.

Other optional agent values: `request` for provider-specific output/reasoning settings, `cache` for supported hints, `compact` for manual/automatic compaction, `max_steps`, `max_output_bytes`, and `request_timeout_ms`. Validate provider-specific request fields against `configure_raw`; do not pass a field merely because a different provider supports it. Automatic compaction needs model `context_window_tokens` and agent `compact.trigger_tokens` with output reserve. Setting `default_agent` changes which agent `raw "query"` uses; `raw --agent writer "query"` selects explicitly regardless of that default. An existing config may intentionally retain a different default.

## Register, share and verify

1. Choose a new unique agent name, model alias, and location. Create/copy the entire portable directory or back up the personal JSON at mode 0600. Preserve every existing agent and the effective default unless the user requested a change.
2. Add the model only if needed. Write one complete `agents.<name>` object, prompt file or inline prompt, and only the exact selected IDs for assets that exist. For a portable directory, keep prompts, `agent/` tools and `agent/` skills beside `raw.json`; document any required global `local/` asset or external MCP server before sharing.
3. Validate with `raw --config /absolute/path/raw.json config list` or `raw config list`. Use `raw --config /absolute/path/raw.json --agent writer "inspect these files"` with a working endpoint. Check `list_skills`/`load_skill` only if selected, and verify policies with a harmless command and a matching `rm` text in a disposable test directory.
4. Copy the directory to a second unrelated path and repeat validation to prove relative paths are portable. Do not ship literal credentials, private history, session DBs, or machine-specific absolute paths. A copied config may use the same agent name without sharing session identity.

Resume is deliberately strict: saved config path, agent name, model identity/endpoint and effective system prompt must still match. Changing these can reject `--resume`; changing selected tool/schema/source advances context revision and rotates the generated cache key; skill-only changes keep that key and may append a reload notice. Preserve the old config if an old conversation still matters. Raw does not migrate old session schemas or translate `profiles`/`--profile`.
