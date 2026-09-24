# raw-cli

`raw` is a local coding agent for models with limited context. Its default system prompt is 25 reference tokens. A text-only model sees three built-in tools: `read_file`, `write_file`, and `bash`. A model configured with `vision: true` also sees `view_image`. Selected MCP servers can add external tools. Standard Agent Client Protocol (ACP) lets an IDE or parent agent run sessions.

## Install and run

Requires Node.js 22+ and Bash for the `bash` tool. From this checkout:

```sh
npm ci
npm run build
npm pack
npm install -g ./raw-cli-0.1.0.tgz
raw config init
```

The package is not published. `config init` creates `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`) once; edit the local model ID or add your hosted model. `--config PATH` selects another strict JSON config file.

```sh
raw --profile local "Explain the tests in this repository"
raw --profile deepseek "Fix the failing tests"
raw                         # in-memory REPL with > prompt
raw --acp --stdio           # IDE/parent agent transport
```

Tool calls run automatically in terminal, headless and ACP modes, using your OS account's full permissions. `cwd` resolves relative paths; it is not a sandbox. A profile can set `tools.rules` to `ask` or `deny` specific tools or patterns. Unmatched tools run without a permission prompt; `-y` cannot bypass an explicit `ask` rule.

## Models and profiles

`models` holds exact upstream model IDs, API methods, endpoint/auth settings, context metadata and vision capability. A `profiles` entry selects one model and configures a run. Multiple profiles may share a model.

```json
{
  "default_profile": "local",
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
  "profiles": {
    "local": { "model": "local" },
    "deepseek": {
      "model": "flash",
      "request": { "thinking": "enabled", "reasoning_effort": "high", "max_output_tokens": 4096 },
      "compact": { "trigger_tokens": 800000, "keep_recent_turns": 2, "max_output_tokens": 512 }
    }
  }
}
```

`provider` names the service; `method` selects its wire API (`openai-chat-completions`, `openai-responses`, `anthropic-messages`, or `google-generate-content`). `model_id` is sent upstream unchanged. Use `api_key_env` to read a selected credential from the environment or `api_key` for a literal value. `raw config list` reports model/access settings without printing credentials. No old flat-profile schema is accepted. See [configuration](docs/configuration.md), [config design](docs/config-design.md), and [providers](docs/providers.md).

## Tools, images and MCP

For a vision-capable model, set `models.<alias>.vision` to `true`, then ask `raw "Explain screenshot.png"`; the model can call `view_image` with the path. There is no image flag. A text-only model can instead call an external MCP vision-to-text server that returns a description. Search likewise comes from a selected MCP tool returning text.

MCP lives in the same config file. Only servers selected by the active profile are started, and only selected tools enter its model schema:

```json
{
  "mcp": {
    "servers": {
      "search": { "transport": "stdio", "command": "YOUR_SEARCH_SERVER", "args": [] }
    }
  },
  "profiles": {
    "research": { "model": "flash", "mcp": { "search": ["web_search"] } }
  }
}
```

Merge these fields into a complete config with `models` and `default_profile`. Local stdio and remote Streamable HTTP MCP transports are supported; see [MCP](docs/mcp.md). Profile `tools.rules` matches built-ins, MCP identities (`mcp:server/tool`) and ACP-injected identities (`acp:name`) with ordered `allow`, `ask`, and `deny` effects; see [tools](docs/tools.md).

## Conversation, compact and cache

The REPL keeps turns in memory. Host commands are `/compact`, `/clear`, `/stats`, and `/exit`. Without `compact.trigger_tokens`, compaction is manual. With it, Raw estimates the complete next request, emits visible compact progress, and sends bounded summary requests to the selected model when the threshold is reached. It excludes image base64 from summary prompts and retains a stable main cache key until a deliberate compact boundary. Cache reuse depends on the upstream service; a cache hit is only claimed when its usage counters report one. See [context and cache](docs/context.md).

`--system-prompt` or `RAW_SYSTEM_PROMPT` replaces the minimal prompt literally. `--max-steps` defaults to 25 inference requests, `--max-output-bytes` to 8192 text bytes per tool result, and `--request-timeout-ms` to 120000. Use `raw --help` for flags and exit codes.

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
