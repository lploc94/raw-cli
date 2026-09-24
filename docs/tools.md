# Built-in tools

The default registry exposes exactly three tools. Their JSON object inputs reject unknown fields:

| Tool | Required input | Optional input | Action |
|---|---|---|---|
| `read_file` | `path: string` | — | Read UTF-8 text from a file. |
| `write_file` | `path: string`, `content: string` | — | Create parent directories and create or overwrite a UTF-8 file. Empty content is valid. |
| `bash` | `command: string` | `timeout_ms: positive integer` | Run a command using Bash. Default deadline: 120000 ms. |

Relative paths resolve against the session's `cwd`; absolute paths are used as given. The working directory does not restrict filesystem access. The process uses the user's full OS permissions. File errors are returned as tool errors. `write_file` reports success only after the write finishes.

Each result retains at most `maxOutputBytes` of content (8192 by default). `read_file` reads a bounded prefix. Bash shares this budget across stdout and stderr in observed arrival order and drains both pipes after the cap. UTF-8 characters are never split. Results carry `truncated`, `retainedBytes`, and, where known, `observedBytes` metadata. Bash also reports its actual exit code, signal, or deadline; a nonzero exit is returned for agent inspection. An over-limit JSON result is a labeled text preview, never malformed JSON presented as structured data.

Dispatch validates the tool name, schema, visibility and session whitelist before execution. CLI and ACP sessions execute exposed tools automatically, including headless runs. `-y` / `--auto-approve` is retained as a compatibility alias. Library callers can explicitly set `autoApprove: false` and supply an approval callback; denial has no side effect.

## Profile rules

An optional profile `tools.rules` array applies to built-ins, MCP tools and ACP-injected tools. Each rule is `{ "match": "<glob>", "effect": "allow" | "ask" | "deny" }`. `*` matches any number of characters and `?` matches one character; the pattern covers the whole canonical tool identity. Built-ins are `read_file`, `write_file`, `bash`; MCP identities are `mcp:<server>/<original-tool-name>`; ACP-injected identities are `acp:<registered-name>`. Rules run in array order and the last match wins. No match means `allow`.

`deny` removes the schema from the model and rejects direct dispatch. `ask` remains visible and requests permission once for each call through the CLI TTY or ACP `session/request_permission`; headless execution without an approval channel returns `approval_required`. `-y` never overrides an explicit `ask`. `allow` executes automatically. Policies are tool-name filters, not filesystem or process isolation: allowing `bash` grants the agent the user's full shell permissions even if `write_file` is denied.

The `bash` tool requires Bash on `PATH`, or an explicit `RAW_BASH_PATH`. Each invocation supervises one process group. Abort or deadline sends TERM to that group, then KILL if needed. Long-lived, deliberately detached jobs can escape the group and are outside this guarantee; use an MCP server designed for managed persistent processes when needed.

The development-only `npm run test:overhead` reports the exact canonical input and `o200k_base` token count for the production default prompt and built-in definitions. External tools, custom prompts, and provider framing add separate overhead.
