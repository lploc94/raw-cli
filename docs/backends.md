# External backends

An agent with a `backend` block runs an external coding CLI (Claude Code, Codex or Antigravity `agy`) instead of Raw's own agent loop. Raw starts the CLI through its public interfaces only, streams its work into the terminal and the dashboard, and offers Raw's own tools to it through an MCP server Raw owns.

The config fields are in [configuration](configuration.md#external-backends).

## How a backend runs

Raw keeps the session: history, the dashboard, cancel and resume work as with Raw's own loop. The CLI keeps its conversation, its context and its tools; Raw records what it shows (answers, tool calls, notices) and continues the CLI's conversation when the session is resumed. A change of system prompt, executable or backend model starts a new CLI conversation, with the notice "This <CLI> conversation starts here; it does not see earlier turns".

Raw talks to Claude Code and Codex through their ACP adapters (`@agentclientprotocol/claude-agent-acp` 0.98.0, `@agentclientprotocol/codex-acp` 2.3.0). Raw does not ship them: on the first use of a backend Raw installs the pinned adapter from npm into `$XDG_DATA_HOME/raw/adapters` (`~/.local/share/raw/adapters`), once per version, and says so in the turn. Optional dependencies are skipped, so the adapters' own copies of the CLIs are not downloaded; Raw points each adapter at the CLI you installed. Installing needs npm (it comes with Node.js) and the network once; when it fails the turn ends `backend_unavailable` with npm's message, and the next turn tries again.

Cancelling a turn asks the CLI to stop, waits up to 5 s, then stops the adapter and everything it started. The next turn starts it again and continues the conversation.

What Raw does not do for a backend: compaction (`/compact`), Raw's step limit, hooks and native tool rules. The CLI keeps its own context and tools.

## What each backend supports

| Capability | Claude Code | Codex | agy | Proof |
| --- | --- | --- | --- | --- |
| System prompt replaces the CLI's | yes | yes | yes | `backend-claude`, `backend-codex`, `backend-agy`: "the system prompt replaces…", "the prompt replaces Codex's…", "the prompt goes to agy byte for byte…"; live: "the agent's prompt replaces the CLI's" |
| System prompt appended (`system_prompt_mode: "append"`) | yes | yes | no, replaces with a warning | same tests; `backend-agy`: "an agent without a prompt runs agy's own; an empty one and append mode are reported" |
| `model` | yes | yes | yes | `backend-acp`: "configured options are applied in order…"; `backend-agy`: "the agent's model, effort and mode reach agy as flags…"; live: "the chosen model runs" |
| `effort` | yes, per model | yes | yes, per model family | `backend-acp`: "an effort override on a model whose selector…"; `backend-agy`: "an effort agy refuses is dropped and the model kept…" |
| `mode` | yes | yes | yes (`--mode`) | `backend-acp`: "configured options are applied in order…"; `backend-agy`: "the agent's model, effort and mode reach agy as flags…" |
| Per-turn model, effort and mode from the dashboard | yes | yes | yes | `dashboard-sessions`: "a backend turn takes request.backend for itself only…"; `dashboard-ui/backends.spec.ts`; `backend-agy`: "the agent's model, effort and mode reach agy as flags…" |
| Resume (`--continue`, reopening a chat) | yes (`session/load`) | yes (`session/load`) | yes (`--conversation`) | `backend-acp`: "a reopened session continues the CLI conversation…"; `backend-agy`: "each later turn continues the conversation…"; live: "--continue resumes" |
| Cancel | yes | yes | yes (stops agy) | `backend-acp`: "cancel stops the adapter and its descendants…", "cancelling one session leaves another session's adapter running…"; `backend-agy`: "cancel stops agy and what it started…"; live: "end to end in the dashboard" |
| Permission requests through Raw's approval | yes | yes | no, its mode decides | `backend-acp`: "permission requests go to Raw's approval channel…"; `dashboard-ui/backends.spec.ts` |
| Raw tools (bridge) | yes | yes | no, with a warning | `backend-bridge`: "the CLI sees the bridged selection minus deny…"; `backend-config`: "agy gets no Raw tools…"; live: "bridge todo" |
| Panels (todo and tool panels) | yes | yes | no | `backend-bridge`: "a bridged todo call produces the same panel event as Raw's loop…"; live: "bridge todo" |
| `ask_user` | yes | yes | no | `backend-bridge`: "in the dashboard, a bridged todo fills the session's todo panel and ask_user waits…" |
| Hooks | no | no | no | `backend-config`: "loop-only settings and hooks on a backend agent load and are reported, not rejected" |
| Compaction | no | no | no | `backend-acp`: "compaction is reported as unsupported for a backend…" |
| `tools.rules` on the CLI's own tools | no | no | no | `backend-config`: "rules that only match skipped tools warn that they cannot be enforced" |

Each CLI sends its own system prompt, tool list and context, which Raw cannot shrink. Even with a replaced prompt, a short question cost about 14k input tokens with Claude Code, 18k with Codex and 7k with agy on 2026-10-28. The numbers vary with the CLI's version, its settings and the files it reads (`CLAUDE.md`, `AGENTS.md`).

## Raw tools in a backend

The CLI keeps its own file, edit and shell tools; Raw's built-ins that do the same job (`read_file`, `write_file`, `edit_file`, `apply_patch`, `bash`, `powershell`, `view_image`) are skipped, each with a warning at startup such as `claude agent "review" skips builtin/bash: Claude Code uses its own shell tool`. The other tools the agent selects are offered to the CLI as one MCP server named `raw`: `builtin/todo`, `builtin/ask_user`, `builtin/list_vars`, `builtin/read_var`, `builtin/list_skills`, `builtin/load_skill`, `builtin/process`, `local/*`, `agent/*`, package tools and `mcp/<server>/<tool>`. Claude Code calls them `mcp__raw__<tool>` (for example `mcp__raw__todo`). `agy` gets none of them (see [Antigravity](#antigravity-agy)).

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

## Codex

Requirements: Codex installed (`codex` on `PATH`, or `backend.executable`) and logged in (`codex login`).

```json
{ "agents": { "codex": { "backend": { "kind": "codex", "model": "gpt-6.1-terra", "effort": "high" },
  "system_prompt": "You are a careful reviewer.", "tools": { "use": [] } } } }
```

- System prompt: the agent's prompt replaces Codex's. Raw writes it to a file of its own (under `$XDG_STATE_HOME/raw/backends/codex/`, removed when the session closes) and gives Codex `model_instructions_file` with `include_environment_context` and `include_permissions_instructions` off, through codex-acp's `CODEX_CONFIG`. `system_prompt_mode: "append"` keeps Codex's prompt and adds the agent's as `developer_instructions`. Without a `system_prompt` Codex runs its own prompt. An explicit empty `system_prompt` cannot replace it (Codex will not start a thread on empty instructions), so Codex keeps its own and the session shows a warning. A `CODEX_CONFIG` you set yourself keeps its other settings.
- Codex still reads `~/.codex/config.toml`, its `AGENTS.md` files and its own skills, as it does when you run it yourself; turn them off there if the agent should not see them.
- `model`, `effort` and `mode` take the values Codex lists: models such as `gpt-6.1-terra` or `gpt-6-luna`, effort levels (`low` to `ultra`), and the modes `read-only`, `workspace-write`, `agent` and `agent-full-access`. A value it does not list is reported and Codex keeps its own.
- Permission requests, errors and the reported model work as for Claude Code; the errors read "Install Codex and log in (`codex`), or set backend.executable" and "run `codex login`".

## Antigravity (`agy`)

Requirements: Antigravity's CLI installed (`agy` on `PATH`, or `backend.executable`) and logged in. Tested with `agy` 1.4.10.

```json
{ "agents": { "gemini": { "backend": { "kind": "agy", "model": "gemini-3.8-flash", "effort": "high" },
  "system_prompt": "You are a careful reviewer.", "tools": { "use": [] } } } }
```

- Raw runs `agy` once per turn in its print mode with stream-json on stdin and stdout, and continues the conversation with `--conversation`. When `agy` no longer has the conversation it starts a new one, and the session shows the fresh-conversation notice.
- System prompt: the agent's prompt replaces agy's through an agent file Raw writes into a plugin of agy's named `raw`, `~/.gemini/config/plugins/raw/agents/raw-<digest>.md`, and passes with `--agent raw-<digest> --disable-slash-commands`. The name is a digest of the file, so an unchanged agent reuses its file; Raw never deletes these files (each distinct prompt and tool list leaves one of a few KB, which you can remove when no Raw runs). `system_prompt_mode: "append"` is not possible with `agy`: the prompt replaces agy's and the session shows a warning. Without a `system_prompt`, and with an empty one (which shows a warning), agy runs its own agent.
- Tools: an agent file must list its tools, or agy's agent loses its write and shell tools. Raw lists the 25 tools `agy` 1.4.10 can run for a top-level agent (`run_command`, `view_file`, `write_to_file`, `replace_file_content`, `grep_search`, `search_web` and the others; not `finish`, which makes the agent print a subagent's structured output); `backend.tools` replaces that list. `agy` refuses a run whose agent names a tool it does not know, so Raw then drops those names, says which, and runs the turn again.
- `model` and `effort` take the models `agy models` lists, grouped as Antigravity groups them: a family such as `gemini-3.8-flash` takes the efforts its variants name (`low`, `medium`, `high`), a variant such as `gemini-3.8-flash-high` names its own effort, and a model without variants has none. A value agy does not list is reported and agy uses its default.
- `mode` is agy's `--mode` (`accept-edits`, `auto`, `plan`); `"skip-permissions"` passes `--dangerously-skip-permissions` instead. agy has no approval channel Raw can answer, so its tools run as its mode allows. A warning agy prints, such as an unknown mode, is shown in the turn.
- Raw tools are unavailable with `agy`: agy takes an MCP server only from a config file, which would put the bridge's token on disk. Each selected tool that another backend reaches through the bridge is skipped with the warning `agy agent "<name>" skips <tool>: Raw tools are unavailable with agy`.
- Cancelling a turn stops `agy` and everything it started at once (agy has no cancel message); the next turn continues the conversation.
- Errors: `backend_unavailable` "Install Antigravity (`agy`) and log in, or set backend.executable" when `agy` is not found; `backend_error` with agy's message when its result is an error; `backend_exited` with what it printed when it exits without a result. agy does not report the model a turn used, so the session shows the configured one.
