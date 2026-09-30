# Tools and plugins

## Bundled plugin contract

The installed package also includes `examples/tools/<name>/` copies of all eight
bundled plugins. Copy a folder to `$XDG_CONFIG_HOME/raw/tools/<new-id>/`, edit
its `tool.json` (`id` must match the new folder), then select `local/<new-id>`
in `tools.use`. These generated `.mjs` files run directly; rebuild Raw only
when changing its TypeScript source. A fork runs with the user's full OS
permissions, so inspect its handler and keep semantic `validateArgs` checks
when changing a batch tool.

`examples/agents/project-helper/` is a complete copyable directory with
`raw.json`, `prompt.md`, `tools/`, and `skills/`. Copy it anywhere, set the
recipient's model ID, endpoint, and credentials, and run
`raw --config /path/to/project-helper/raw.json --agent project "task"`.
Its `agent/` IDs resolve beside that copied config file.

The eight shipped tools live in package-owned folders under
`dist/tools/builtin/<name>/`. Each folder contains an editable `tool.json` and a
standalone `index.mjs`. The manifest declares `api_version: 2`, `id`, `version`,
`name`, `description`, `input_schema`, and `entry: "./index.mjs"`. The entry
exports an async `handler(args, context)` and may export a synchronous
`validateArgs(args)` that returns an error string or `undefined`. The host
validates the full batch before approval or execution. The read, write, and
Bash entries retain their semantic batch validators, including mode-specific
write fields and ordered line ranges, even where JSON Schema alone is too
broad. Results, abort behavior, and byte caps remain host-controlled.

Agents load these tools only when their IDs appear in `tools.use`.

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

The starter `raw` agent selects `builtin/read_file`, `builtin/write_file`, `builtin/bash`, `builtin/list_skills`, and `builtin/load_skill`. Other agents choose their own ordered `tools.use` list, including an empty list. The model receives each tool's purpose, important result and failure behavior, and parameter descriptions in its function definition. The starter system prompt covers general tasks and on-demand Raw setup skill routing; this document is for users and is not injected into model context. Tool inputs reject unknown fields:

The other two shipped plugins, `builtin/list_skills` and `builtin/load_skill`, expose only agent-selected skills on demand. See [skills](skills.md) for frontmatter, selection, and linked-result behavior.

| Tool | Required input | Optional input | Action |
|---|---|---|---|
| `read_file` | `files: array` (1–16 entries with `path: string`) | Per entry: `start_line`, `end_line`, `max_lines`, `max_bytes` | Read several UTF-8 files with an independent selection per file. |
| `write_file` | `operations: array` (1–16 entries with `path` and `mode`) | Mode-specific fields below | Apply ordered UTF-8 writes and guarded edits. |
| `bash` | `commands: array` (1–16 entries with `command`) | Per entry: `timeout_ms: positive integer` | Run commands sequentially using Bash. Default per-command deadline: 120000 ms. |

When the selected model declares `vision: true`, an agent may select `builtin/view_image` with `{ "path": string }`. It reads a local PNG or JPEG and returns a native image block to the selected model. Relative paths use the session cwd. Raw checks file structure and a separate 16 MiB decoded-file limit; the normal text result cap does not replace a valid image with a placeholder. Missing, invalid, or oversized images return a structured tool error without base64. `raw "Explain screenshot.png"` needs no image flag: the model can call `view_image` using the named path.

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

## Panels

A tool may publish a live side panel (`raw.panel/2`, see [panels-design.md](panels-design.md)). Panel state never reaches the
model except for one short confirmation line (and, for `context: "summary"` panels, a bounded reminder after a successful compaction), never counts against `maxOutputBytes`, and is stored with the tool result.

Declare the panels a tool owns in its registration (`panels` in `tool.json`, the MCP server config or `_raw/tool/register`), then either:

- return a `{ "type": "panel", "panel": "<id>", "op": "replace" | "patch" | "close", ... }` block next to the ordinary text
  content; the runtime removes it before hooks, caps, providers and history see the result; or
- call `context.panels.update(panel, body)` while the handler runs; it resolves with the assigned `revision`, is shown live
  (coalesced to one frame per 250 ms) and commits together with the tool result, also when the result is an error.
  `context.panels.get(panel)` returns the last revision and document.

Limits: 16 panels per session (a closed panel is evicted to make room), 200 updates per panel per call, 64 KiB per document.
Errors are `PanelError` codes (`panel_invalid`, `panel_too_large`, `panel_undeclared`, `panel_not_owned`, `panel_unknown`,
`panel_revision_conflict`, `panel_rate_limited`, `panel_limit`, `panel_closed_context`). A rejected result-block update never fails the tool: the model sees
`panel <id> update rejected: <code> <message>` and history records an error receipt. Panels are owned by the tool's canonical
identity, so an `as` alias cannot write another tool's panel. `context.panels` is absent for tools without declared panels.

A `tool.json` may declare up to four panels with the optional `panels` array (`id`, `title`, and optionally `icon`, `open`, `context`, `acp_plan`, `actions`; see the design document). Unknown keys, duplicate ids or an invalid declaration make the manifest invalid; an unknown `icon` falls back to `panel` with a load warning. The declarations are read from `tool.json` alone: they are known without importing `index.mjs`, so the dashboard can list a tool's panels before the tool has ever run.

A panel may declare `actions` (menu items on the panel, a block or an item). `prompt` actions draft a message; `tool` actions run the declaring tool again through the normal tool path, so `allow`, `ask`, `deny` and hooks apply exactly as for a model call (a click is never approval for an `ask` rule), and the tool sees `context.panels` as usual. The model learns about a user-run action from a note in front of the next message; the hook payload carries `tool.source: "user_action"`.

### `builtin/todo`

`builtin/todo` is the reference panel tool ([panels-design.md §18](panels-design.md)). Select it like any tool (`"tools": {"use": ["builtin/todo"]}`); the starter config does not. The model sends `todos` with `mode` `replace` (default: the whole list, ids optional) or `merge` (items by `id`, `remove: true` deletes an item with its subtasks, `clear: "done"` removes finished items). Generated ids are the smallest unused `t<n>`. Rules: at most 100 items, one `in_progress`, subtasks only one level deep, and a `done` or `skipped` item cannot have an unfinished subtask. A rule violation returns `invalid_todo` naming the item and changes nothing. The result is a text list with ids (`[x] t1 …`); the user sees the same list live in the Todo panel. The state lives in the panel, so it survives restarts and compaction. The tool does no file I/O.

## Agent rules

An optional agent `tools.rules` array applies to built-ins, MCP tools and ACP-injected tools. Each rule is `{ "match": "<glob>", "effect": "allow" | "ask" | "deny" }`. `*` matches any number of characters and `?` matches one character; the pattern covers the whole canonical tool identity. Built-in identities are `builtin/read_file`, `builtin/write_file`, `builtin/bash`, and `builtin/view_image`; local plugin identities are `local/<id>` or `agent/<id>`; MCP identities are `mcp/<server>/<original-tool-name>`; ACP-injected identities are `acp:<registered-name>`. Rules run in array order and the last match wins. No match means `allow`.

`deny` removes the schema from the model and rejects direct dispatch. `ask` remains visible and requests permission once for each call through the CLI TTY or ACP `session/request_permission`; headless execution without an approval channel returns `approval_required`. `-y` never overrides an explicit `ask`. `allow` executes automatically. Policies are tool-name filters, not filesystem or process isolation: allowing `bash` grants the agent the user's full shell permissions even if `write_file` is denied.

An `ask` rule may add `"when": {"source": "arguments", "any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*(sudo\\s+)?(/usr/bin/|/bin/)?rm(\\s|$)"}`. Raw checks each selected command string with an unanchored RE2JS match after validating the entire call. If any command matches, it asks once before running any command in the batch; other Bash calls run automatically. `when.any` follows dotted object fields and `[*]` array traversal to a string field, so the same form works for typed local, MCP, or ACP tools. Optional absent fields do not match. Conditional rules may only have effect `ask`. Rule order still matters: the last applicable allow/ask/deny wins, while an unconditional deny keeps the tool hidden until a later unconditional rule allows it. The regex sees command text, not shell semantics; use a broader pattern if your workflow needs broader review.

The `bash` tool requires Bash on `PATH`, or an explicit `RAW_BASH_PATH`. Each invocation supervises one process group. Abort or deadline sends TERM to that group, then KILL if needed. Long-lived, deliberately detached jobs can escape the group and are outside this guarantee; use an MCP server designed for managed persistent processes when needed.

The development-only `npm run test:overhead` reports the exact canonical input and `o200k_base` token count for the production default prompt and built-in definitions. It measures combined overhead without imposing an arbitrary combined-token ceiling; essential tool guidance remains in the definitions. External tools, custom prompts, and provider framing add separate overhead.

## Variables in local tool handlers

Select `builtin/list_vars` and `builtin/read_var` for discovery and reads, and
select exact variable names in `agents.<name>.vars`. The host passes an
agent-scoped `context.vars` service to every selected local plugin, including
forked bundled tools. `list()` is metadata only; `read(name,{signal})` resolves a
readable value; `validateEnvRefs(refs)` checks names/types without I/O;
`resolveEnv(refs,{signal})` returns scalar environment bindings for trusted tool
code. Standalone handlers must report an unavailable service if refs require it.

Bash accepts `env_refs` inside each `commands[]` row. The registry checks policy
and approval before any resolution. The handler validates all reference metadata
before starting the batch, then resolves each row immediately before its process.
A resolution failure stops remaining rows; prior rows are not rolled back.
Bindings override only that child's environment. Raw keeps references in original
arguments and never substitutes resolved values into shell command text.

```json
{"commands":[{"command":"test -n \"$GH_TOKEN\"","env_refs":{"GH_TOKEN":"github_token"}}]}
```

`access: "use"` prevents Raw's read tool returning a value, but trusted commands
and plugins can still print it. This is not OS isolation. MCP does not acquire
`env_refs` or variable interpolation automatically. See [variables](vars.md).

Managed dashboard edits use [revision-checked configuration and owned component services](management.md). Viewing a catalog never imports tool code or starts providers/MCP; changes take effect on the next turn.

The current development tool inspection contract uses explicit predicate sources and separate intended effects; see [tool-effects.md](tool-effects.md). Old tool/hook formats are not adapted.
