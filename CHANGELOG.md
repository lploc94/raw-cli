# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.6] - 2026-10-28

- `raw dashboard --remote` opens the dashboard on a phone: it starts a Cloudflare quick tunnel (`cloudflared` on `PATH`, no account or domain) and prints the public link and a QR code. Opt-in; if `cloudflared` is missing or fails, Raw warns and keeps the local dashboard. The dashboard accepts one registered `*.trycloudflare.com` address as Host/Origin, throttles wrong tokens (10 per 60 s per client, then 429), reports `remote` in `/api/bootstrap`, answers `/events` on `POST` as well as `GET` (a quick tunnel buffers `GET` streams; the bundled client uses `POST` when remote) and stops the tunnel before the server. `cloudflared` runs with an allowlisted environment (no API keys; list in docs/dashboard.md). Cloudflare terminates TLS and can see the traffic; the address changes every run. See [docs/dashboard.md](docs/dashboard.md#open-it-on-your-phone---remote).
- `raw dashboard` now defaults to port 21517 instead of 8787, which other development tools commonly use. When `--port` is not given and the default is busy, Raw uses a free port and prints `port 21517 is in use; using N` instead of failing; an explicit busy `--port` is still an error. Scripts that assume `127.0.0.1:8787` must read the printed link or pass `--port 8787`.
- Tool handlers (including package tools) receive `context.sessionId`, the persisted session the call runs in; it is absent when the runtime has no session store. A tool that ignores it behaves as before, so a package can keep per-session state.
- New shipped example `examples/packages/goal-kit/`: a portable goal package
  with a `goal` tool and panel, a `Stop` hook using `raw.stop-continue/1` to
  keep a run going while the goal is active, a `SessionStart` hook that pauses
  an interrupted goal, a `UserPromptSubmit` hook that pauses on a new message,
  a `goal` skill and a `coder` agent. Goal state, criteria, budget and commands
  stay in the package; Raw has no goal code.
- A `UserPromptSubmit` or `PreToolUse` hook that denied with an empty `reason`
  (`{"decision":"deny","reason":""}`) was treated as allowing the call. It now
  blocks, with the default reason `hook ID denied`.
- A `Stop` hook can now keep a run going: when the run ended with a final
  answer it may print `{"decision":"deny","reason":"..."}`, and Raw adds the
  reason as a `[Raw hook continuation]` message and asks the model again. It is
  the one generic piece a package needs to build goal-style "work until done"
  behaviour itself; Raw has no goal feature. A hook that fails never traps the
  run, `maxSteps` still bounds it, and `Stop` requests now carry `stop`
  (`hook_active`, `continuations`, `usage`). Packages can require the
  `raw.stop-continue/1` capability. See [hooks](docs/hooks.md) and the
  `examples/hooks/keep-going/` example.
- The dashboard has a **Files** tab beside Chat, Agents and Library: a read-only
  tree of the selected workspace (the same git-aware view the agent's `@`
  references use) in the second column, with a filter and per-folder counts,
  and a viewer that fills the main area for code (with line numbers), Markdown
  (Source and Preview, with Mermaid diagrams) and raster images. HTML and SVG
  files are shown as text, never rendered. It never writes, a path that leaves
  the workspace stays unreachable, and the open file lives in the address so a
  reload keeps the place. On narrow windows the tree is in the menu drawer.
- Files reads and browser caches now follow the selected workspace. Reload
  immediately refreshes both the listing and open text or image, Retry
  rereads failed files, and direct reads refuse `.git` / `node_modules`
  paths and symlink targets. Phone-width navigation keeps visible labels,
  and management page identity no longer includes URL query parameters.
- Files deep links remain readable when the tree has no listed files.
  Raw image reads accept only declared raster extensions and enforce the
  16 MiB limit during the read, including when another process grows the file.
- The dashboard's side panel has a second host-owned tab, **Approvals**: while
  a tool call waits for permission it lists the call's intended files with the
  lines each one would write (`apply_patch` shows every file of the patch,
  `edit_file` the replaced text, `write_file` the content it will write and
  says its previous content is not read), and answers it with Deny or Allow
  once. The chat's approval card gains one **Review** control that opens the
  tab; a pending call never opens the panel or takes a tab you chose, and the
  preview is built from the request rather than by reading files before the
  gate.
- Approvals review keeps the context-use badge visible in narrow side panels,
  matches editing tools by exact name, and preserves diff content that looks
  like a file header. The README overview image uses the existing neutral
  capture rather than a contributor's local filesystem path.

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
