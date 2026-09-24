# raw-cli

`raw` is a small local coding agent for models with limited context. Its default system prompt is 25 reference tokens and the model initially sees only `read_file`, `write_file`, and `bash`. It does not load repository instruction files, silently compact history, or add extra model tools. MCP adds explicitly selected external tools; ACP lets an IDE or parent agent control sessions.

## Install and run

Requires Node.js 22 or newer and Bash for the `bash` tool. From this checkout:

```sh
npm ci
npm run build
node dist/raw.js config init
```

Edit the created `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`) and replace the local model placeholder. For an installed `raw` command, run `npm pack` and install the resulting tarball with npm. The package is local/private in this repository; it is not published.

```sh
raw --profile local "Explain the tests in this repository"
raw --profile local -y "Fix the failing tests"
raw --profile local                 # interactive: >
raw --profile local --interactive   # same REPL
```

By default, a TTY asks before each validated tool call. `-y`/`--auto-approve` skips those questions. A noninteractive task that needs a tool exits 2 unless `-y` is supplied. **Tools run with your OS account's full permissions.** `cwd` chooses the base for relative paths; it is not a sandbox.

## Multiple model sources

The config supports named profiles, explicit model selection and environment-held credentials. `raw config list` prints sanitized profile details. The example below keeps a local Ollama model as the default and adds two hosted sources:

```json
{
  "default_profile": "local",
  "profiles": {
    "local": {
      "provider": "ollama",
      "model": "YOUR_INSTALLED_MODEL",
      "base_url": "http://127.0.0.1:11434/v1"
    },
    "openai": {
      "provider": "openai",
      "model": "YOUR_OPENAI_MODEL",
      "api_key_env": "OPENAI_API_KEY"
    },
    "gemini": {
      "provider": "google",
      "model": "YOUR_GEMINI_MODEL",
      "api_key_env": "GEMINI_API_KEY"
    }
  },
  "compact": { "keep_recent_turns": 2, "max_output_tokens": 512 }
}
```

Use `raw --profile openai "task"` or `raw --profile gemini "task"` to choose another source. Inactive profiles do not require credentials. Other supported provider names are `openai-compatible`, `openrouter`, and `anthropic`; official OpenAI, Anthropic and Google SDKs drive their respective API paths. Model names are never used to guess a provider. See [configuration](docs/configuration.md) and [provider/cache behavior](docs/providers.md).

The system prompt can be replaced literally with `--system-prompt` or `RAW_SYSTEM_PROMPT`. `--max-steps` defaults to 25 inference requests, `--max-output-bytes` to 8192 retained bytes per tool result, and `--request-timeout-ms` to 120000 per provider/MCP request. A model must support tool calling. Use `raw --help` for all flags and exit codes.

## Conversation and compact

The REPL keeps turns in memory. Whole-line host commands are `/compact`, `/clear`, `/stats`, and `/exit`. `/compact` makes one explicit summary request when there are eligible old turns, preserving the original task and recent complete turns; it never runs automatically. `/clear` drops conversation history without erasing cumulative usage. `/stats` reports known token/cache fields and coverage without making a model request. Cache controls preserve stable multi-turn prefixes and use only supported provider hints; a cache hit is never guaranteed. See [context](docs/context.md) and [CLI behavior](docs/cli.md).

## External tools and IDE integration

MCP configuration lives in `~/.config/raw/mcp.json` (or `$XDG_CONFIG_HOME/raw/mcp.json`), overridden per server by `./raw-mcp.json`. A server is discovered at startup, but only names selected in `tools` enter the model schema:

```json
{
  "mcpServers": {
    "workspace": {
      "command": "YOUR_MCP_SERVER_COMMAND",
      "args": [],
      "tools": ["selected_tool_name"]
    }
  }
}
```

Stdio, SSE and Streamable HTTP transports are supported. Omit `tools` or set `[]` to expose none. See [MCP](docs/mcp.md).

`raw --acp --stdio` serves standard Agent Client Protocol v1 methods for IDEs. `raw --acp --ws --host 127.0.0.1 --port 8765` serves a local WebSocket endpoint. Parent agents can import `createAcpClient` and register temporary reverse tools; [ACP](docs/acp.md) documents capabilities, ownership and wire methods, and [the parent example](examples/parent-agent.ts) shows the library flow. ACP and MCP do not add hidden built-in model tools.

## Development and verification

```sh
npm ci
npm run check
npm run test:overhead
npm run test:package
npm exec --yes --package=node@22 -- node scripts/verify-runtime.mjs
npm exec --yes --package=node@24 -- node scripts/verify-runtime.mjs
```

`npm run check` typechecks, builds the ESM executable/library/declarations and runs all tests. Package tests install a tarball outside the checkout and exercise an installed task, MCP, ACP and TypeScript import. Provider and protocol tests use local fixtures rather than paid APIs or downloaded models. [Verification](docs/verification.md) records exact tested runtimes, hashes, limits and review evidence. CI is configured for macOS/Linux with Node 22/24; see `.github/workflows/ci.yml`.

The source layout is `bin/raw.ts` (entrypoint), `src/config.ts`, `src/cli.ts`, `src/agent.ts`, `src/compact.ts`, `src/llm/` (providers/cache), `src/tools/` (primitives/MCP), `src/acp/` (protocol/server/client), `src/index.ts` (library exports), `tests/` (fixture and public-path tests), and `docs/` (contracts/evidence). Runtime dependencies are the pinned official provider/ACP/MCP SDKs, JSON schema/config parsers, and the local WebSocket transport; TypeScript, tsx, tsup and tokenizer are development dependencies only.
