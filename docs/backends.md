# External backends

An agent with a `backend` block runs an external coding CLI (Claude Code, Codex or Antigravity `agy`) instead of Raw's own agent loop. Raw starts the CLI through its public interfaces only, streams its work into the terminal and the dashboard, and offers Raw's own tools to it through an MCP server Raw owns.

The config fields are in [configuration](configuration.md#external-backends).
