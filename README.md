# raw-cli

`raw` is a local coding agent for models with limited context. Each agent selects an ordered set of tools and can supply a system prompt and skills. Raw ships six tools as editable plugins: `read_file`, `write_file`, `bash`, `view_image`, `list_skills`, and `load_skill`. Tools and skills can also live in the user's config directory or beside a selected agent config. Selected MCP tools remain available. Standard Agent Client Protocol (ACP) lets an IDE or parent agent run sessions.

## Install and run

Requires Node.js 22.13+ and Bash for the `bash` tool. From this checkout:

```sh
npm ci
npm run build
npm pack
npm install -g ./raw-cli-0.1.0.tgz
raw config init
```

The package is not published. `config init` creates `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`) once; edit the local model ID or add your hosted model. `--config PATH` selects another strict JSON config file.

```sh
raw --agent local "Explain the tests in this repository"
raw --agent deepseek "Fix the failing tests"
raw                         # saved REPL with > prompt
raw --continue "Follow up on that change"
raw sessions
raw sessions show SESSION_ID
raw --acp --stdio           # IDE/parent agent transport
```

Tool calls run automatically in terminal, headless and ACP modes, using your OS account's full permissions. `cwd` resolves relative paths; it is not a sandbox. An agent can set `tools.rules` to `ask` or `deny` specific tools or patterns. Unmatched tools run without a permission prompt; `-y` cannot bypass an explicit `ask` rule.

## Models and agents

`models` holds exact upstream model IDs, API methods, endpoint/auth settings, context metadata and vision capability. A `agents` entry selects one model and configures a run. Multiple agents may share a model.

```json
{
  "default_agent": "local",
  "models": {
    "local": {
      "provider": "ollama",
      "method": "openai-chat-completions",
      "model_id": "YOUR_INSTALLED_MODEL",
      "base_url": "http://127.0.0.1:11434/v1"
    },
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
    "local": { "model": "local", "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash"] } },
    "deepseek": {
      "model": "flash",
      "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash"] },
      "request": { "thinking": "enabled", "reasoning_effort": "high", "max_output_tokens": 4096 },
      "compact": { "trigger_tokens": 800000, "keep_recent_turns": 2, "max_output_tokens": 512 }
    }
  }
}
```

`provider` names the service; `method` selects its wire API (`openai-chat-completions`, `openai-responses`, `anthropic-messages`, or `google-generate-content`). `model_id` is sent upstream unchanged. Use `api_key_env` to read a selected credential from the environment or `api_key` for a literal value. `raw config list` reports model/access settings without printing credentials. No old flat-agent schema is accepted. See [configuration](docs/configuration.md), [config design](docs/config-design.md), and [providers](docs/providers.md).

## Tools, images and MCP

For a vision-capable model, set `models.<alias>.vision` to `true` and add `builtin/view_image` to `tools.use`, then ask `raw "Explain screenshot.png"`; the model can call `view_image` with the path. There is no image flag. A text-only model can instead call an external MCP vision-to-text server that returns a description. Search likewise comes from a selected MCP tool returning text.

MCP lives in the same config file. Only servers selected by the active agent are started, and only selected tools enter its model schema:

```json
{
  "mcp": {
    "servers": {
      "search": { "transport": "stdio", "command": "YOUR_SEARCH_SERVER", "args": [] }
    }
  },
  "agents": {
    "research": { "model": "flash", "tools": { "use": ["builtin/read_file", "mcp/search/web_search"] } }
  }
}
```

Merge these fields into a complete config with `models` and `default_agent`. Local stdio and remote Streamable HTTP MCP transports are supported; see [MCP](docs/mcp.md). Agent `tools.rules` matches bundled, local, MCP (`mcp/server/tool`), and ACP (`acp:name`) identities with ordered `allow`, `ask`, and `deny` effects. A conditional `ask` can inspect `commands[*].command`, so only matching Bash `rm` calls prompt; see [tools](docs/tools.md).

The npm package includes forkable [tool examples](examples/tools/) and a complete [project helper agent](examples/agents/project-helper/) with `raw.json`, `prompt.md`, `tools/`, and `skills/`. Copy the agent directory anywhere, edit its model ID, endpoint, and credentials for the recipient, and run `raw --config /path/to/project-helper/raw.json --agent project "task"`. Its `agent/` references resolve beside the copied config. To fork a shipped tool globally, copy `examples/tools/bash/` to `~/.config/raw/tools/my_bash/`, change the manifest `id` and `name`, and select `local/my_bash` in an agent. See [configuration](docs/configuration.md), [tools](docs/tools.md), and [skills](docs/skills.md).

The three built-ins each accept an ordered batch of up to 16 entries: `read_file({"files":[...]})`, `write_file({"operations":[...]})`, and `bash({"commands":[...]})`. Reads can select full files or 1-based line ranges. A large full read returns complete leading lines with `next_line` for paging. Writes support overwrite, append, unique text replacement, and SHA-256 guarded line replacement. Bash continues after a nonzero exit and stops on timeout or abort. All batch rows share the configured model-facing `maxOutputBytes` limit; terminal previews separately show at most 2,000 characters and 10 lines. See [tool contracts](docs/tools.md).

## Conversation, compact and cache

The REPL saves turns across process restarts. Use `raw --continue` for the latest session in this workspace, `raw --resume ID` for a specific saved cwd, and `raw sessions show ID --before CURSOR` to page older visible history. Host commands are `/compact`, `/clear`, `/stats`, and `/exit`; `/clear` starts a new saved session. Without `compact.trigger_tokens`, compaction is manual. With it, Raw estimates the complete next request, emits visible compact progress, and sends bounded summary requests to the selected model when the threshold is reached. It excludes image base64 from summary prompts and retains a stable main cache key until a deliberate compact boundary. Cache reuse depends on the upstream service; a cache hit is only claimed when its usage counters report one. See [CLI sessions](docs/cli.md) and [context and cache](docs/context.md).

`--system-prompt` or `RAW_SYSTEM_PROMPT` overrides an agent's `system_prompt` or `system_prompt_file`, then Raw's default. `--max-steps` defaults to 25 inference requests, `--max-output-bytes` to 8192 text bytes per tool result, and `--request-timeout-ms` to 120000. Use `raw --help` for flags and exit codes.

## ACP and development

`raw --acp --stdio` serves standard Agent Client Protocol v1. `raw --acp --ws --host 127.0.0.1 --port 8765` serves a local WebSocket endpoint. Parent agents can import `createAcpClient` and register temporary reverse tools; [ACP](docs/acp.md) and [the parent example](examples/parent-agent.ts) document the flow.

```sh
npm run check
npm run test:overhead
npm run test:package
npm exec --yes --package=node@22 -- node scripts/verify-runtime.mjs
npm exec --yes --package=node@24 -- node scripts/verify-runtime.mjs
```

Tests use local provider/MCP/ACP fixtures. [Verification](docs/verification.md) records gates and limits. Source modules live in `bin/`, `src/config.ts`, `src/agent.ts`, `src/compact.ts`, `src/llm/`, `src/tools/`, and `src/acp/`.
