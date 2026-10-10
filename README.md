# raw-cli

[![npm](https://img.shields.io/npm/v/@tlelabs/raw)](https://www.npmjs.com/package/@tlelabs/raw) [![CI](https://github.com/lploc94/raw-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/lploc94/raw-cli/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

`raw` is a local coding agent for models with limited context. Each agent selects ordered tools, skills and hooks, and can supply a system prompt. Raw ships eleven tools as editable plugins: `read_file`, `write_file`, `bash`, `view_image`, `list_skills`, `load_skill`, `list_vars`, `read_var`, `todo`, `ask_user`, and `process`. Todo, Ask, and Process are selected explicitly; they are not added to the starter tool selection. Tools, skills and hooks can also live in the user's config directory or beside a selected agent config. Selected MCP tools remain available. Standard Agent Client Protocol (ACP) lets an IDE or parent agent run sessions.

## Install and run

Requires Node.js 22.13+ and Bash for the `bash` tool. Documentation: [raw.tlelabs.com](https://raw.tlelabs.com).

```sh
npm install -g @tlelabs/raw
raw config init
```

Run it once without installing with `npx @tlelabs/raw --help`. To install the latest commit from GitHub instead, use `npm install -g github:lploc94/raw-cli`; installing from a Git ref runs the `prepare` build, so it downloads build tooling and takes longer. Each [GitHub release](https://github.com/lploc94/raw-cli/releases) also attaches the packed tarball. To work from a checkout, run `npm ci` (which also builds) and `npm install -g .`.

`config init` creates `~/.config/raw/config.json` (or `$XDG_CONFIG_HOME/raw/config.json`) once with setup-capable agent `raw`; edit the local model ID or add your hosted model. `raw "query"` uses the configured `default_agent`, which may name a different agent in an existing config. `--config PATH` selects another strict JSON config file.

```sh
raw --agent raw "Explain the tests in this repository"
raw --agent deepseek "Fix the failing tests"
raw                         # saved REPL with ❯ prompt on an interactive terminal
raw --continue "Follow up on that change"
raw sessions
raw sessions show SESSION_ID
raw --acp --stdio           # IDE/parent agent transport
raw dashboard              # local browser chat and setup
raw dashboard --port 0 --no-open
```

`raw dashboard` serves the bundled browser app locally. Create or continue sessions,
inspect reasoning/tool activity and context usage, handle matching approvals, and
manage agents, models, skills, tools, vars, MCP and packages. Setup and history work
without a model connection. Browser preferences stay separate from Raw config;
saved config/source changes apply to the next turn of the same session. See the
[dashboard guide](docs/dashboard.md) for layout, setup and sharing workflows.

Tool calls run automatically in terminal, headless, dashboard and ACP modes, using your OS account's full permissions. `cwd` resolves relative paths; it is not a sandbox. An agent can set `tools.rules` to `ask` or `deny` specific tools or patterns. Unmatched tools run without a permission prompt; `-y` cannot bypass an explicit `ask` rule.

## Models and agents

`models` holds exact upstream model IDs, API methods, endpoint/auth settings, context metadata and vision capability. An entry in `agents` selects one model and configures a run. Multiple agents may share a model.

```json
{
  "default_agent": "raw",
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
    "raw": { "model": "local", "system_prompt": "You are a coding assistant. For Raw setup tasks, list selected skills and load only relevant instructions.", "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"] }, "skills": { "use": ["builtin/configure_raw", "builtin/create_skill", "builtin/create_tool", "builtin/create_hook", "builtin/create_agent", "builtin/add_mcp", "builtin/create_package"] } },
    "deepseek": {
      "model": "flash",
      "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash"] },
      "request": { "thinking": "enabled", "reasoning_effort": "high", "max_output_tokens": 4096 },
      "compact": { "trigger_tokens": 800000, "keep_recent_turns": 2, "max_output_tokens": 16384 }
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

Agents and components can also travel as local `.rawpkg` archives. Export a configured agent with `raw package export --agent NAME --name @owner/name --version 1.0.0 --out DIR`, pack it with `raw package pack DIR --out FILE.rawpkg`, install it on another machine with `raw package install FILE.rawpkg --as kit`, then bind the recipient model using `raw agent add NAME --from pkg/kit/agents/EXPORT --model MODEL_ALIAS`. Direct agents can select installed tools and skills without adopting an entire package. Updates preserve the local binding and resume the same session; only effective runtime changes rotate Raw's generated cache key. See [packages](docs/packages.md) for inputs, exact dependencies, development links and rollback.

The installed [package examples](examples/packages/) include a complete mixed agent and standalone tool/skill packages. They are editable source, not preinstalled agents; inspect and pack the one you need, then bind it to a recipient config.

Raw ships seven English setup skills for configuring Raw, creating skills, creating tools, creating hooks, composing agents, adding MCP servers, and packaging components for sharing. `builtin/create_hook` covers events, filters, scripts, selection and verification; [agent hooks](docs/hooks.md) document the protocol. `builtin/create_package` guides export or manifest authoring, recipient inputs, validation, packing, installation checks and updates. The packaged [skill authoring cheatsheet](docs/skill-authoring.md) explains how to write descriptions, procedures, examples and verification criteria. Skill instructions guide the model; they do not enforce a fixed sequence or amount of work.

The three built-ins each accept an ordered batch of up to 16 entries: `read_file({"files":[...]})`, `write_file({"operations":[...]})`, and `bash({"commands":[...]})`. Reads can select full files or 1-based line ranges. A large full read returns complete leading lines with `next_line` for paging. Writes support overwrite, append, unique text replacement, and SHA-256 guarded line replacement. Bash continues after a nonzero exit and stops on timeout or abort. All batch rows share the configured model-facing `maxOutputBytes` limit; terminal previews separately show at most 2,000 characters and 10 lines. See [tool contracts](docs/tools.md).

## Shared tool UI and editing

Tool views use one block renderer in chat and the sidebar. `builtin/ask_user` gathers durable structured answers; `builtin/process` runs bounded background jobs across turns. The dashboard Commands section combines foreground Bash and background jobs, with paged output and policy-controlled Stop actions that remain available during a model turn.

`write_file` accepts either its existing `operations` array or a strict multi-file `patch`. Patch preflight stages all files before mutation; later I/O failures report partial completion and stop subsequent changes. Files changed records successful tool writes, including completed rows in an interrupted call. It does not track Git state or shell edits. See [tools](docs/tools.md), [processes](docs/processes.md), and the [verification evidence](docs/evidence/tool-ui-and-builtins.md).

Mermaid fences and tool diagram blocks share a lazy renderer in chat and the sidebar, with source/copy controls and readable failure fallback. See [diagrams](docs/diagrams.md) and the [local diagram example](examples/tools/diagram/).

## Conversation, compact and cache

The REPL saves turns across process restarts. Use `raw --continue` for the latest session in this workspace, `raw --resume ID` for a specific saved cwd, and `raw sessions show ID --before CURSOR` to page older visible history. Host commands are `/compact`, `/clear`, `/stats`, and `/exit`; `/clear` starts a new saved session. When the model declares `context_window_tokens`, automatic compaction defaults to 80% of the input budget (context minus output reserve and margin); `compact.trigger_tokens` sets another threshold and `false` keeps compaction manual. With a threshold, Raw estimates the complete next request, emits visible compact progress, and sends bounded summary requests to the selected model when the threshold is reached. It excludes image base64 from summary prompts and retains a stable main cache key until a deliberate compact boundary. Cache reuse depends on the upstream service; a cache hit is only claimed when its usage counters report one. See [CLI sessions](docs/cli.md) and [context and cache](docs/context.md).

`--system-prompt` or `RAW_SYSTEM_PROMPT` overrides an agent's `system_prompt` or `system_prompt_file`, then Raw's default. `--max-steps` defaults to 10000 inference requests, `--max-output-bytes` to 65536 text bytes per tool result, and `--request-timeout-ms` to 600000 ms of model-stream silence. Use `raw --help` for flags and exit codes.

## Terminal appearance

Raw highlights Markdown code fences and source previews in an interactive terminal, shows tool progress, and ends a one-shot run with context, reported usage, and a copyable resume command. Set root `ui` in `config.json` or override it per run with `--display compact|normal|verbose`, `--reasoning hidden|summary|full`, `--color auto|always|never`, `--icons auto|unicode|ascii`, and `--theme terminal|dark|light`. For example, `raw --theme dark --display verbose "Inspect this module"` shows a longer bounded tool preview. Redirected answer text keeps its original bytes and terminal status stays on stderr. [Terminal output](docs/terminal-output.md) describes palette roles, coverage rules, fallbacks, and a no-network preview gallery.

## ACP and development

`raw --acp --stdio` serves standard Agent Client Protocol v1. `raw --acp --ws --host 127.0.0.1 --port 8765` serves a local WebSocket endpoint. Parent agents can import `createAcpClient` and register temporary reverse tools; [ACP](docs/acp.md) and [the parent example](examples/parent-agent.ts) document the flow.

```sh
npx playwright install chromium firefox webkit
npm run check
npm run test:overhead
npm run test:package
npm run test:web
npm exec --yes --package=node@22 -- node scripts/verify-runtime.mjs
npm exec --yes --package=node@24 -- node scripts/verify-runtime.mjs
```

Tests use local provider/MCP/ACP fixtures. [Verification](docs/verification.md) records gates and limits. Source modules live in `bin/`, `src/config.ts`, `src/agent.ts`, `src/compact.ts`, `src/llm/`, `src/tools/`, and `src/acp/`.

## Runtime variables

Agents can select named read-only values from config, environment, files or executable providers. Use `raw vars list` and `raw vars get now` without invoking a model. The starter raw agent includes current UTC time. Models can use list_vars/read_var or pass commands[].env_refs to Bash; use-only values need not be returned to the model. See [the variable contract](docs/vars.md) and the forkable [host-info provider](examples/providers/host-info/README.md).

## License

[MIT](LICENSE)
