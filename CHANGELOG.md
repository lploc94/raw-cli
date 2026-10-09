# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/lploc94/raw-cli/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/lploc94/raw-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/lploc94/raw-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lploc94/raw-cli/releases/tag/v0.1.0
