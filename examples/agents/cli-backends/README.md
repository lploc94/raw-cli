# Agents on Claude Code, Codex and Antigravity

Three agents that run an external coding CLI instead of Raw's own loop, with one
shared prompt. Install and log in to the CLIs you want (`claude`, `codex`,
`agy`), then run:

```sh
raw --config /path/to/cli-backends/raw.json --agent claude "Explain this project"
raw --config /path/to/cli-backends/raw.json --agent codex "Add a test for the parser"
raw --config /path/to/cli-backends/raw.json --agent agy "List the TODO comments"
```

The models are CLI models (`claude-code-cli`, `codex-cli`, `antigravity-cli`) with no endpoint or credentials: each CLI uses its own login. Drop a `model_id` to run the CLI's default model. Check the file without starting anything with `raw --config /path/to/cli-backends/raw.json config check`. On the
first run of `claude` or `codex` Raw installs the pinned ACP adapter from npm
once. `builtin/todo` and `builtin/ask_user` reach Claude Code and Codex through
Raw's MCP server; agy gets no Raw tools, so its list is empty. The `model_id`,
`request.reasoning_effort` and `request.mode` values are examples: each CLI lists its own, and a value it does not
list gives a warning and its default. See [docs/backends.md](../../../docs/backends.md).
