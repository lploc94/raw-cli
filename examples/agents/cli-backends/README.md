# Agents on Claude Code, Codex and Antigravity

Three agents that run an external coding CLI instead of Raw's own loop, with one
shared prompt. Install and log in to the CLIs you want (`claude`, `codex`,
`agy`), then run:

```sh
raw --config /path/to/cli-backends/raw.json --agent claude "Explain this project"
raw --config /path/to/cli-backends/raw.json --agent codex "Add a test for the parser"
raw --config /path/to/cli-backends/raw.json --agent agy "List the TODO comments"
```

There are no models or credentials here: each CLI uses its own login. On the
first run of `claude` or `codex` Raw installs the pinned ACP adapter from npm
once. `builtin/todo` and `builtin/ask_user` reach Claude Code and Codex through
Raw's MCP server; agy gets no Raw tools, so its list is empty. The model, effort
and mode values are examples: each CLI lists its own, and a value it does not
list gives a warning and its default. See [docs/backends.md](../../../docs/backends.md).
