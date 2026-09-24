# raw-cli

`raw` is a small terminal coding agent for models with limited context. It uses a short default system prompt and exposes three tools by default: `read_file`, `write_file`, and `bash`.

This project is under implementation. Phase 1 provides the package, configuration, and command help. Task execution, MCP, ACP, compaction, and the REPL become available in the later phases of [the implementation plan](./build-raw-cli-plan.md). An unavailable mode exits with an error; it does not pretend to finish a task.

## Requirements

- Node.js 22 or newer.
- Bash for the `bash` tool when agent execution is available.

The three built-in tool schemas, result limits, approval flow and process cancellation behavior are documented in [the tools reference](./docs/tools.md).

`raw` runs with the full permissions of your OS account. A working directory selects where relative paths start; it is not a sandbox. Tool approval is configurable with `-y` / `--auto-approve`.

## Configuration

Create a starter file with `raw config init`, then edit the model placeholder. The file is `~/.config/raw/config.json` by default, or `$XDG_CONFIG_HOME/raw/config.json` when set. `raw config list` shows configured profiles without exposing API keys. `raw --profile local` and `raw --profile cloud` select a source explicitly.

```json
{
  "default_profile": "local",
  "profiles": {
    "local": {
      "provider": "ollama",
      "model": "YOUR_INSTALLED_MODEL",
      "base_url": "http://127.0.0.1:11434/v1"
    },
    "cloud": {
      "provider": "openai",
      "model": "YOUR_OPENAI_MODEL",
      "api_key_env": "OPENAI_API_KEY"
    }
  }
}
```

Profiles can contain different models or endpoints for the same provider. Credentials live in environment variables named by `api_key_env`; inactive profiles do not need valid credentials. The [configuration reference](./docs/configuration.md) lists precedence, supported providers, limits, and error handling.

## Prompt and context

The default system prompt is:

```text
You are a terminal coding assistant. Use read_file, write_file, and bash to complete tasks. Respond concisely.
```

It may be replaced literally with `--system-prompt` or `RAW_SYSTEM_PROMPT`. `raw` does not automatically load repository instruction files or append extra system instructions. A development check measures the default prompt with the `o200k_base` tokenizer; other providers can count tokens differently. Tool schemas and conversation history also use context. Explicit compact and cache-aware multi-turn behavior are specified in the implementation plan.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Release, MCP, ACP, and provider behavior must pass the phase gates in the plan before this package is considered complete.
