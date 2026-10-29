# External backends

An agent with a `backend` block runs an external coding CLI (Claude Code, Codex or Antigravity `agy`) instead of Raw's own agent loop. Raw starts the CLI through its public interfaces only, streams its work into the terminal and the dashboard, and offers Raw's own tools to it through an MCP server Raw owns.

The config fields are in [configuration](configuration.md#external-backends).

## How a backend runs

Raw keeps the session: history, the dashboard, cancel and resume work as with Raw's own loop. The CLI keeps its conversation, its context and its tools; Raw records what it shows (answers, tool calls, notices) and continues the CLI's conversation when the session is resumed. A change of system prompt, executable or backend model starts a new CLI conversation, with the notice "This <CLI> conversation starts here; it does not see earlier turns".

Raw talks to Claude Code and Codex through their ACP adapters (`@agentclientprotocol/claude-agent-acp` 0.98.0, `@agentclientprotocol/codex-acp` 2.3.0). Raw does not ship them: on the first use of a backend Raw installs the pinned adapter from npm into `$XDG_DATA_HOME/raw/adapters` (`~/.local/share/raw/adapters`), once per version, and says so in the turn. Optional dependencies are skipped, so the adapters' own copies of the CLIs are not downloaded; Raw points each adapter at the CLI you installed. Installing needs npm (it comes with Node.js) and the network once; when it fails the turn ends `backend_unavailable` with npm's message, and the next turn tries again.

Cancelling a turn asks the CLI to stop, waits up to 5 s, then stops the adapter and everything it started. The next turn starts it again and continues the conversation.

What Raw does not do for a backend: compaction (`/compact`), Raw's step limit, hooks and native tool rules. The CLI keeps its own context and tools.

## Raw tools in a backend

The CLI keeps its own file, edit and shell tools; Raw's built-ins that do the same job (`read_file`, `write_file`, `edit_file`, `apply_patch`, `bash`, `powershell`, `view_image`) are skipped, each with a warning at startup such as `claude agent "review" skips builtin/bash: Claude Code uses its own shell tool`. The other tools the agent selects are offered to the CLI as one MCP server named `raw`: `builtin/todo`, `builtin/ask_user`, `builtin/list_vars`, `builtin/read_var`, `builtin/list_skills`, `builtin/load_skill`, `builtin/process`, `local/*`, `agent/*`, package tools and `mcp/<server>/<tool>`. Claude Code calls them `mcp__raw__<tool>` (for example `mcp__raw__todo`).

A call runs in Raw, as it does in Raw's own loop: `tools.rules` apply (`deny` hides the tool from the CLI, `ask` uses Raw's approval prompt or card), panels such as the todo list update the side panel, `ask_user` shows its form and the call waits for the answer, panel actions run in Raw and the CLI hears of them with the next prompt, and results are capped by `max_output_bytes`. The chat shows the call once, as Raw's tool, not also as the CLI's MCP call. Raw does not ask again for the CLI's own permission prompt for a `raw` tool. Cancelling the turn cancels the call; a call the CLI makes when no turn is running is refused.

The server listens on `127.0.0.1` only, with a random token per session runtime, and refuses browser origins. The CLI starts `raw __bridge-proxy` as a stdio MCP server; the address and token reach it in its environment, never on a command line, in history or in logs. When the server cannot start, the turn says "Raw tools are unavailable in this session: <reason>" and runs without them.

## Claude Code

Requirements: Claude Code installed (`claude` on `PATH`, or `backend.executable`) and logged in.

```json
{ "agents": { "claude": { "backend": { "kind": "claude", "model": "sonnet", "effort": "high" },
  "system_prompt": "You are a careful reviewer.", "tools": { "use": [] } } } }
```

- System prompt: the agent's prompt replaces Claude Code's (`system_prompt_mode: "append"` adds it to Claude Code's instead). Without a `system_prompt` Claude Code runs its own prompt. Claude Code still reads your `CLAUDE.md` files and settings, as it does when you run it yourself.
- `model`, `effort` and `mode` take the values Claude Code lists (models such as `default`, `opus`, `sonnet`, `haiku`; effort levels that depend on the model; permission modes). A value it does not list is reported and Claude Code keeps its own.
- Permission requests appear as Raw's approval prompt in the terminal and the approval card in the dashboard. With no approval channel they are allowed when `auto_approve` is on (Raw's default) and refused with a notice otherwise.
- Errors: `backend_unavailable` "Install Claude Code and log in (`claude`), or set backend.executable" when `claude` is not found; `backend_auth` "run `claude` once and log in" when Claude Code reports no login; `backend_error` with Claude Code's message otherwise.
- The model Claude Code reports for each prompt is kept with the usage record and shown as the session's model.
