# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- New shipped example `examples/packages/coding-kit/`: a `goal` panel tool with
  acceptance criteria, steps and panel actions, a `goal` skill (which the
  dashboard offers as `/goal`), a `coding-workflow` skill and a `coder` agent.
  It is the reference for a package tool that declares a panel.

## [0.1.5] - 2026-10-13

- Raw runs natively on Windows 10/11 without WSL. The `bash` tool finds Git
  for Windows' Bash (`RAW_BASH_PATH` still wins) and never picks WSL's
  launcher; commands, hooks, variable providers and MCP servers start with
  Windows command lookup, and a job object stops a command's whole process
  tree. Managed background processes work on Windows.
- New opt-in `powershell` tool (`builtin/powershell`) with `bash`'s
  arguments and Bash-like exit codes; `process` starts take
  `"shell": "powershell"`. On Windows without Git Bash, `raw config init`
  selects it in place of `bash`.
- Terminal output uses ASCII decorations in consoles that cannot draw
  Unicode, closing the terminal or Ctrl+Break shuts Raw down like SIGTERM,
  and the dashboard explains a port Windows reserves.

## [0.1.4] - 2026-10-12

- Built-in tools take the single-call shapes models are trained on:
  `read_file` and `write_file` work on one file, `edit_file` replaces exact
  text, `bash` runs one command, `process` takes flat arguments, `ask_user`
  asks one question, and `apply_patch` is available as an opt-in tool. Common
  argument variants are normalized, and every tool has a readable display.
- Tool output has a 64 KiB budget that keeps the end of long output and saves
  the full copy to a file. LLM requests retry transient failures, a request
  timeout bounds stream silence, and answers cut at the output limit
  continue.
- Compaction runs automatically by default, keeps the user's messages and
  the last steps verbatim, clears old tool results to saved copies first,
  compacts repeatedly with a thrash guard and degrades instead of failing the
  turn. Provider-native compaction is available as an opt-in.
- MCP servers take a per-server `timeout_ms`, and progress notifications keep
  long calls alive. Approvals wait for people, hooks keep their timeout, and
  sessions last 30 days.
- The dashboard chat is redesigned: a single header row, message bubbles,
  readable tables and code blocks, a work summary line with tool cards, an
  approval card, and a composer card with a context ring. A side panel shows
  Overview, Todo, Files changed and Commands, with bundled Inter and
  JetBrains Mono fonts.
- Long chats stay fast: off-screen messages skip layout, earlier history
  loads as you scroll up, and a sent message shows at once.
- You can send while the agent works: the message is queued and delivered at
  the next step, or interrupts the current turn.
- Agents, Library and Settings navigation rows highlight on hover like the
  chat list. Library entries show icons and counts, and agents show a model
  subtitle and a default marker. Agents and Library rows open from anywhere
  on the row, and Library rows fit on one line.
- Fixes: `@` file search follows `.gitignore` across the whole workspace,
  images an API would reject become text notes, and a user message after tool
  results joins their turn for Anthropic and Google.

## [0.1.3] - 2026-10-10

- The dashboard has a new violet-black and white theme: near-black violet
  surfaces with a white primary button in dark mode, and a white canvas with
  a violet-black primary button in light mode. Primary, secondary and danger
  buttons each have their own colours, and the favicon matches the new
  palette.

## [0.1.2] - 2026-10-09

- A selected MCP server that cannot start, a selected tool the server no
  longer lists, or a selected tool with an unusable schema is skipped with a
  stderr warning instead of blocking the whole session.
- Skill bodies, the skill catalog and `list_vars`/`read_var` results are no
  longer limited by `max_output_bytes`: they arrive whole, bounded only by a
  1 MiB safety limit. A selected skill over 1 MiB is skipped with a warning
  instead of failing startup, and the dashboard no longer refuses to attach a
  skill larger than the agent's output cap.

## [0.1.1] - 2026-10-09

- The dashboard favicon is now the Raw "r." mark.
- `raw --version`, the ACP `agentInfo` and the MCP client identity read the
  version from `package.json` instead of a hardcoded string.
- Releases are published to npm from GitHub Actions with provenance.

## [0.1.0] - 2026-10-09

First public release.

- Terminal agent with one-shot tasks, a saved REPL and resumable sessions.
- Eleven editable built-in tools, skills, hooks and selected MCP tools per agent.
- Local browser dashboard for chat, approvals, context usage and setup.
- Agent Client Protocol over stdio and WebSocket for IDEs and parent agents.
- Portable `.rawpkg` packages for sharing agents, tools and skills.
- Runtime variables from config, environment, files or executable providers.

[Unreleased]: https://github.com/lploc94/raw-cli/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/lploc94/raw-cli/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lploc94/raw-cli/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lploc94/raw-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lploc94/raw-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lploc94/raw-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lploc94/raw-cli/releases/tag/v0.1.0
