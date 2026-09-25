# Tools and plugins

## Bundled plugin contract

The installed package also includes `examples/tools/<name>/` copies of all six
bundled plugins. Copy a folder to `$XDG_CONFIG_HOME/raw/tools/<new-id>/`, edit
its `tool.json` (`id` must match the new folder), then select `local/<new-id>`
in `tools.use`. These generated `.mjs` files run directly; rebuild Raw only
when changing its TypeScript source. A fork runs with the user's full OS
permissions, so inspect its handler and keep semantic `validateArgs` checks
when changing a batch tool.

`examples/agents/project-helper/` is a complete copyable directory with
`raw.json`, `prompt.md`, `tools/`, and `skills/`. Copy it anywhere, set the
recipient's model ID, endpoint, and credentials, and run
`raw --config /path/to/project-helper/raw.json --profile project "task"`.
Its `agent/` IDs resolve beside that copied config file.

The six shipped tools live in package-owned folders under
`dist/tools/builtin/<name>/`. Each folder contains an editable `tool.json` and a
standalone `index.mjs`. The manifest declares `api_version: 1`, `id`, `version`,
`name`, `description`, `input_schema`, and `entry: "./index.mjs"`. The entry
exports an async `handler(args, context)` and may export a synchronous
`validateArgs(args)` that returns an error string or `undefined`. The host
validates the full batch before approval or execution. The read, write, and
Bash entries retain their semantic batch validators, including mode-specific
write fields and ordered line ranges, even where JSON Schema alone is too
broad. Results, abort behavior, and byte caps remain host-controlled.

Profiles load these tools only when their IDs appear in `tools.use`.

## Selected plugin folders

The loader accepts exact IDs from three roots: `builtin/<folder>` in the
installed package, `local/<folder>` in `$XDG_CONFIG_HOME/raw/tools/` (or
`~/.config/raw/tools/`), and `agent/<folder>` in `tools/` beside the selected
config file. `--config` does not change the global root. Each selected folder
must have one `tool.json` and one `index.mjs`; one folder registers one
model-facing tool. Names and IDs must be unique among selected tools. The
loader reads and validates all selected manifests before importing any handler.
Unselected folders are not read or executed.

Folder IDs use lowercase letters, digits, `_` and `-`, starting with a letter;
`version` is `major.minor.patch`. Model-facing names start with a letter or `_`
and contain at most 64 letters, digits, `_` or `-`. Manifests reject unknown
fields. The schema must describe an object and may use JSON Schema draft-07 or
2020-12 with local references; remote references and async schemas are not
supported. A symlinked folder, manifest, or entry that escapes its root fails
before code is imported.

The entry exports `handler(args, context)` and may export synchronous
`validateArgs(args)`, which returns an error string or `undefined`. Raw runs
semantic validation and the declared JSON Schema before permission or any
side effect. The context gives the session cwd, abort signal, result byte cap,
tool-call ID, and available host options; callbacks for approval stay in Raw.
The result uses Raw's text, JSON, and image blocks and is capped by the host.
Local modules run with the invoking OS account's full permissions. No plugin
sandbox is implied.

The starter profile selects exactly three tools: `builtin/read_file`, `builtin/write_file`, and `builtin/bash`. Other profiles choose their own ordered `tools.use` list, including an empty list. The model receives each tool's purpose, important result and failure behavior, and parameter descriptions in its function definition. The system prompt covers only general task behavior; this document is for users and is not injected into model context. Tool inputs reject unknown fields:

The other two shipped plugins, `builtin/list_skills` and `builtin/load_skill`, expose only profile-selected skills on demand. See [skills](skills.md) for the manifest, selection, and linked-result behavior.

| Tool | Required input | Optional input | Action |
|---|---|---|---|
| `read_file` | `files: array` (1–16 entries with `path: string`) | Per entry: `start_line`, `end_line`, `max_lines`, `max_bytes` | Read several UTF-8 files with an independent selection per file. |
| `write_file` | `operations: array` (1–16 entries with `path` and `mode`) | Mode-specific fields below | Apply ordered UTF-8 writes and guarded edits. |
| `bash` | `commands: array` (1–16 entries with `command`) | Per entry: `timeout_ms: positive integer` | Run commands sequentially using Bash. Default per-command deadline: 120000 ms. |

When the selected model declares `vision: true`, a profile may select `builtin/view_image` with `{ "path": string }`. It reads a local PNG or JPEG and returns a native image block to the selected model. Relative paths use the session cwd. Raw checks file structure and a separate 16 MiB decoded-file limit; the normal text result cap does not replace a valid image with a placeholder. Missing, invalid, or oversized images return a structured tool error without base64. `raw "Explain screenshot.png"` needs no image flag: the model can call `view_image` using the named path.

Relative paths resolve against the session's `cwd`; absolute paths are used as given. The working directory does not restrict filesystem access. The process uses the user's full OS permissions. File errors are returned as tool errors. `write_file` reports success only after the write finishes.

Text and JSON results retain at most `maxOutputBytes` of content (8192 by default). Images use their separate 16 MiB decoded limit and remain typed. A `read_file` batch shares that one byte cap across **all** files and JSON framing. An entry with only `path` requests the complete file. If it does not fit, it returns a `partial` prefix made of complete lines plus `next_line` for the next call. `start_line` is 1-based; `end_line` is inclusive and cannot be combined with `max_lines`. Either may end past EOF: the returned text contains only available lines and reports `eof: true`. A `start_line` beyond EOF returns empty text and `eof: true`. An optional positive `max_bytes` caps the serialized success entry, including JSON framing, without increasing the batch cap; a budget smaller than an outcome envelope returns a compact status instead of content. Ranged reads that exhaust their budget stop at a complete line and return `next_line`; if the first selected line is too large, they return `line_too_large` without splitting it. Responses are indexed JSON results, including per-file status, actual range, selected-byte SHA-256 when text is complete, and an error for any failed entry. Invalid batch arguments reject the whole call before reading. The old single `{ "path": ... }` shape is unsupported.

For example, `{"files":[{"path":"package.json"},{"path":"src/agent.ts","start_line":40,"max_lines":20},{"path":"src/config.ts","start_line":10,"end_line":30}]}` requests one full file and two independent slices. A count longer than the remaining file is a successful shorter read.

`write_file` accepts `{"operations":[...]}`. Each operation has a `path` and one mode:

- `overwrite`: `content` replaces the whole file, creating parent directories and the file if needed.
- `append`: `content` adds bytes at EOF, creating parent directories and the file if needed.
- `replace_text`: `old_text` (nonempty) and `new_text` replace exactly one literal occurrence. Zero or multiple matches fail without writing; an empty `new_text` deletes the match.
- `replace_lines`: `start_line`, inclusive `end_line`, `content`, and `expected_sha256` replace existing 1-based lines only when the SHA-256 of their original UTF-8 bytes matches a `read_file` result for that exact span. An empty `content` deletes the selected lines. Raw preserves bytes outside the selected range, including a file BOM and CRLF; when following lines exist, a nonempty replacement without a line ending receives the original boundary separator.

For example, `{"operations":[{"path":"notes.txt","mode":"append","content":"next\n"},{"path":"src/main.ts","mode":"replace_text","old_text":"oldName","new_text":"newName"}]}` applies two writes in order. Same-path operations also run in array order. Raw validates all entries before any approval or write. Runtime failures are reported per index and later entries continue; successful earlier writes are not rolled back. One approval, when policy requires it, covers the entire batch. Results share the single `maxOutputBytes` cap; if their minimum indexed status envelope cannot fit, Raw rejects the call before any write.

`bash` accepts `{"commands":[{"command":"printf first"},{"command":"exit 7"},{"command":"printf third","timeout_ms":5000}]}`. Every `commands` entry is an object with a `command` field; an array of strings is invalid. Commands run one at a time in array order. A nonzero exit is an ordinary indexed outcome and later commands still run. Each row includes separate `stdout` and `stderr`, exit code, signal, timeout and truncation status. A timeout or abort terminates the active process group, skips later commands, and reports their indices. Invalid input rejects the whole call before approval or spawning. The old single `{ "command": ... }` shape is unsupported; the error names the unexpected field and shows the required batch shape.

All Bash rows share the one serialized `maxOutputBytes` cap. Raw reserves enough room for every status before allocating command output, so a noisy early command cannot hide later outcomes. Bash drains both pipes after its allocated output share. UTF-8 characters are never split. An over-limit external JSON tool result is a labeled text preview, never malformed JSON presented as structured data. Tool-result events and logs show image metadata, not base64.

Dispatch validates the tool name, schema, visibility and session whitelist before execution. CLI and ACP sessions execute exposed tools automatically, including headless runs. `-y` / `--auto-approve` is retained as a compatibility alias. Library callers can explicitly set `autoApprove: false` and supply an approval callback; denial has no side effect.

## Profile rules

An optional profile `tools.rules` array applies to built-ins, MCP tools and ACP-injected tools. Each rule is `{ "match": "<glob>", "effect": "allow" | "ask" | "deny" }`. `*` matches any number of characters and `?` matches one character; the pattern covers the whole canonical tool identity. Built-in identities are `builtin/read_file`, `builtin/write_file`, `builtin/bash`, and `builtin/view_image`; local plugin identities are `local/<id>` or `agent/<id>`; MCP identities are `mcp/<server>/<original-tool-name>`; ACP-injected identities are `acp:<registered-name>`. Rules run in array order and the last match wins. No match means `allow`.

`deny` removes the schema from the model and rejects direct dispatch. `ask` remains visible and requests permission once for each call through the CLI TTY or ACP `session/request_permission`; headless execution without an approval channel returns `approval_required`. `-y` never overrides an explicit `ask`. `allow` executes automatically. Policies are tool-name filters, not filesystem or process isolation: allowing `bash` grants the agent the user's full shell permissions even if `write_file` is denied.

An `ask` rule may add `"when": {"any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*(sudo\\s+)?(/usr/bin/|/bin/)?rm(\\s|$)"}`. Raw checks each selected command string with an unanchored RE2JS match after validating the entire call. If any command matches, it asks once before running any command in the batch; other Bash calls run automatically. `when.any` follows dotted object fields and `[*]` array traversal to a string field, so the same form works for typed local, MCP, or ACP tools. Optional absent fields do not match. Conditional rules may only have effect `ask`. Rule order still matters: the last applicable allow/ask/deny wins, while an unconditional deny keeps the tool hidden until a later unconditional rule allows it. The regex sees command text, not shell semantics; use a broader pattern if your workflow needs broader review.

The `bash` tool requires Bash on `PATH`, or an explicit `RAW_BASH_PATH`. Each invocation supervises one process group. Abort or deadline sends TERM to that group, then KILL if needed. Long-lived, deliberately detached jobs can escape the group and are outside this guarantee; use an MCP server designed for managed persistent processes when needed.

The development-only `npm run test:overhead` reports the exact canonical input and `o200k_base` token count for the production default prompt and built-in definitions. It measures combined overhead without imposing an arbitrary combined-token ceiling; essential tool guidance remains in the definitions. External tools, custom prompts, and provider framing add separate overhead.
