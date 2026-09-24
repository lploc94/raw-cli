# Built-in tools

The default registry exposes exactly three tools. The model receives each tool's purpose, important result and failure behavior, and parameter descriptions in its function definition. The system prompt covers only general task behavior; this document is for users and is not injected into model context. Tool inputs reject unknown fields:

| Tool | Required input | Optional input | Action |
|---|---|---|---|
| `read_file` | `files: array` (1–16 entries with `path: string`) | Per entry: `start_line`, `end_line`, `max_lines`, `max_bytes` | Read several UTF-8 files with an independent selection per file. |
| `write_file` | `operations: array` (1–16 entries with `path` and `mode`) | Mode-specific fields below | Apply ordered UTF-8 writes and guarded edits. |
| `bash` | `commands: array` (1–16 entries with `command`) | Per entry: `timeout_ms: positive integer` | Run commands sequentially using Bash. Default per-command deadline: 120000 ms. |

When the selected model declares `vision: true`, Raw exposes one additional built-in: `view_image` with `{ "path": string }`. It reads a local PNG or JPEG and returns a native image block to the selected model. Relative paths use the session cwd. Raw checks file structure and a separate 16 MiB decoded-file limit; the normal text result cap does not replace a valid image with a placeholder. Missing, invalid, or oversized images return a structured tool error without base64. `raw "Explain screenshot.png"` needs no image flag: the model can call `view_image` using the named path.

Relative paths resolve against the session's `cwd`; absolute paths are used as given. The working directory does not restrict filesystem access. The process uses the user's full OS permissions. File errors are returned as tool errors. `write_file` reports success only after the write finishes.

Text and JSON results retain at most `maxOutputBytes` of content (8192 by default). Images use their separate 16 MiB decoded limit and remain typed. A `read_file` batch shares that one byte cap across **all** files and JSON framing. An entry with only `path` requests the complete file. If it does not fit, it returns a `partial` prefix made of complete lines plus `next_line` for the next call. `start_line` is 1-based; `end_line` is inclusive and cannot be combined with `max_lines`. Either may end past EOF: the returned text contains only available lines and reports `eof: true`. A `start_line` beyond EOF returns empty text and `eof: true`. An optional positive `max_bytes` caps the serialized success entry, including JSON framing, without increasing the batch cap; a budget smaller than an outcome envelope returns a compact status instead of content. Ranged reads that exhaust their budget stop at a complete line and return `next_line`; if the first selected line is too large, they return `line_too_large` without splitting it. Responses are indexed JSON results, including per-file status, actual range, selected-byte SHA-256 when text is complete, and an error for any failed entry. Invalid batch arguments reject the whole call before reading. The old single `{ "path": ... }` shape is unsupported.

For example, `{"files":[{"path":"package.json"},{"path":"src/agent.ts","start_line":40,"max_lines":20},{"path":"src/config.ts","start_line":10,"end_line":30}]}` requests one full file and two independent slices. A count longer than the remaining file is a successful shorter read.

`write_file` accepts `{"operations":[...]}`. Each operation has a `path` and one mode:

- `overwrite`: `content` replaces the whole file, creating parent directories and the file if needed.
- `append`: `content` adds bytes at EOF, creating parent directories and the file if needed.
- `replace_text`: `old_text` (nonempty) and `new_text` replace exactly one literal occurrence. Zero or multiple matches fail without writing; an empty `new_text` deletes the match.
- `replace_lines`: `start_line`, inclusive `end_line`, `content`, and `expected_sha256` replace existing 1-based lines only when the SHA-256 of their original UTF-8 bytes matches a `read_file` result for that exact span. An empty `content` deletes the selected lines. Raw preserves bytes outside the selected range, including a file BOM and CRLF; when following lines exist, a nonempty replacement without a line ending receives the original boundary separator.

For example, `{"operations":[{"path":"notes.txt","mode":"append","content":"next\n"},{"path":"src/main.ts","mode":"replace_text","old_text":"oldName","new_text":"newName"}]}` applies two writes in order. Same-path operations also run in array order. Raw validates all entries before any approval or write. Runtime failures are reported per index and later entries continue; successful earlier writes are not rolled back. One approval, when policy requires it, covers the entire batch. Results share the single `maxOutputBytes` cap; if their minimum indexed status envelope cannot fit, Raw rejects the call before any write.

`bash` accepts `{"commands":[{"command":"printf first"},{"command":"exit 7"},{"command":"printf third","timeout_ms":5000}]}`. Commands run one at a time in array order. A nonzero exit is an ordinary indexed outcome and later commands still run. Each row includes separate `stdout` and `stderr`, exit code, signal, timeout and truncation status. A timeout or abort terminates the active process group, skips later commands, and reports their indices. Invalid input rejects the whole call before approval or spawning. The old single `{ "command": ... }` shape is unsupported; the error names the unexpected field and shows the required batch shape.

All Bash rows share the one serialized `maxOutputBytes` cap. Raw reserves enough room for every status before allocating command output, so a noisy early command cannot hide later outcomes. Bash drains both pipes after its allocated output share. UTF-8 characters are never split. An over-limit external JSON tool result is a labeled text preview, never malformed JSON presented as structured data. Tool-result events and logs show image metadata, not base64.

Dispatch validates the tool name, schema, visibility and session whitelist before execution. CLI and ACP sessions execute exposed tools automatically, including headless runs. `-y` / `--auto-approve` is retained as a compatibility alias. Library callers can explicitly set `autoApprove: false` and supply an approval callback; denial has no side effect.

## Profile rules

An optional profile `tools.rules` array applies to built-ins, MCP tools and ACP-injected tools. Each rule is `{ "match": "<glob>", "effect": "allow" | "ask" | "deny" }`. `*` matches any number of characters and `?` matches one character; the pattern covers the whole canonical tool identity. Built-ins are `read_file`, `write_file`, `bash`; MCP identities are `mcp:<server>/<original-tool-name>`; ACP-injected identities are `acp:<registered-name>`. Rules run in array order and the last match wins. No match means `allow`.

`deny` removes the schema from the model and rejects direct dispatch. `ask` remains visible and requests permission once for each call through the CLI TTY or ACP `session/request_permission`; headless execution without an approval channel returns `approval_required`. `-y` never overrides an explicit `ask`. `allow` executes automatically. Policies are tool-name filters, not filesystem or process isolation: allowing `bash` grants the agent the user's full shell permissions even if `write_file` is denied.

The `bash` tool requires Bash on `PATH`, or an explicit `RAW_BASH_PATH`. Each invocation supervises one process group. Abort or deadline sends TERM to that group, then KILL if needed. Long-lived, deliberately detached jobs can escape the group and are outside this guarantee; use an MCP server designed for managed persistent processes when needed.

The development-only `npm run test:overhead` reports the exact canonical input and `o200k_base` token count for the production default prompt and built-in definitions. It measures combined overhead without imposing an arbitrary combined-token ceiling; essential tool guidance remains in the definitions. External tools, custom prompts, and provider framing add separate overhead.
