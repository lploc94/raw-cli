# Tools and plugins

## Bundled plugin contract

The installed package also includes `examples/tools/<name>/` copies of all fourteen
bundled plugins. Copy a folder to `$XDG_CONFIG_HOME/raw/tools/<new-id>/`, edit
its `tool.json` (`id` must match the new folder), then select `local/<new-id>`
in `tools.use`. These generated `.mjs` files run directly; rebuild Raw only
when changing its TypeScript source. A fork runs with the user's full OS
permissions, so inspect its handler and keep semantic `validateArgs` checks
when changing a tool.

`examples/agents/project-helper/` is a complete copyable directory with
`raw.json`, `prompt.md`, `tools/`, and `skills/`. Copy it anywhere, set the
recipient's model ID, endpoint, and credentials, and run
`raw --config /path/to/project-helper/raw.json --agent project "task"`.
Its `agent/` IDs resolve beside that copied config file.

The fourteen shipped tools live in package-owned folders under
`dist/tools/builtin/<name>/`. Each folder contains an editable `tool.json` and a
standalone `index.mjs`. The manifest declares `api_version: 2`, `id`, `version`,
`name`, `description`, `input_schema`, and `entry: "./index.mjs"`. The entry
exports an async `handler(args, context)` and may export a synchronous
`validateArgs(args)` that returns an error string or `undefined`. The host
validates the full call before approval or execution. The file and Bash
entries retain their semantic validators, such as positive line windows,
`old_string` differing from `new_string` and patch syntax, even where JSON
Schema alone is too broad. Results, abort behavior, and byte caps remain host-controlled.

Agents load these tools only when their IDs appear in `tools.use`.

### Argument normalization

A bundled entry may also export `normalizeArguments(args)`, `example` and
`renamedArguments`. Raw uses them only for its own `builtin/<name>` tools: a
local copy, a package tool or an MCP tool receives exactly what the model sent,
even when its module exports the same names.

- `normalizeArguments` runs before validation. It maps the names other
  harnesses use (for example `file_path`) to the canonical ones and returns
  `{ args, notes }`, or `{ rejected: "<message>" }` for a shape that is not an
  alias. It is pure and idempotent.
- Policy rules, effects, hooks, approval, the handler and the display all see
  the normalized arguments. History and model context keep the call as the
  model sent it, so replay stays byte-identical; the normalized arguments are
  stored next to the result.
- Unknown top-level arguments of a normalized tool whose schema sets
  `additionalProperties: false` are dropped, and the result ends with
  `[ignored unknown argument: <name>]`; together these notes take at most 256 bytes, ending with `[N notes in all; rest omitted]` when there are more. Other notes are host data only.
- A call missing a required argument is rejected with the validation error
  followed by `; example: <example>`.
- `renamedArguments` maps old argument names to the ones that replaced them.
  A rule or hook condition on an old path fails to load with
  `rule path <path> does not exist in <tool>; the argument is now <name>`.

### Host data

A result may carry `host`: structured facts for Raw (a summary, status,
duration, exit code, saved-output path, read path and line range, changed
files, diff, process ID, notes). Raw stores it with the result in history and model context, gives it to
hooks as `tool.result.host`, and never sends it to a model provider or counts it
against `max_output_bytes`. When Raw cuts an oversized result, it saves the
complete output to a temporary file and records the path in
`host.fullOutputPath`. An oversized JSON result stays valid JSON: long arrays
and objects keep their first entries followed by `"… N more items"` (or a
`"…"` key counting the omitted keys), and long strings keep their start and
end.

### Display hints

A `tool.json` may declare how surfaces show the tool. Every field is optional:

```json
"display": {
  "title": "Fetch page",
  "kind": "search",
  "icon": "search",
  "summary": "{url}",
  "result": "markdown"
}
```

- `title`: text of at most 80 characters, a template like `summary`. Default: the tool name in sentence case (`fetch_page` → `Fetch page`).
- `kind`: `read`, `edit`, `execute`, `search`, `fetch`, `think` or `other` (the default). It picks the CLI icon and the ACP kind.
- `icon`: an icon name of lowercase letters, digits and `-` (at most 40). The CLI uses it when it has that symbol (`read`, `write`, `bash`, `skill`, `mcp`, `generic`), the dashboard when it has that icon (the CLI names plus `terminal`, `file`, `edit`, `search`, `globe`, `web`, `brain`, `todo`, `question`, `image`, `variable`, `plug`, `puzzle`, `tool`); otherwise MCP tools get the MCP icon and the kind decides.
- `summary`: a template of at most 200 characters over the normalized arguments. `{name}` is the argument's value, `{name|text}` falls back to `text`, and a `[…]` part is shown only when every placeholder inside it has a value. A list of plain values is joined with ` · `, an object is compact JSON, and newlines become ` ⏎ `. When a required placeholder has no value, the default summary is used.
- `result`: `text`, `markdown`, `code`, `json`, `terminal` or `diff`. Without it, a result made only of JSON blocks is `json`, MCP text that starts with Markdown structure is `markdown`, and everything else is `text`. A `code` result with `host.path` is shown as path-tagged code without the line-number gutter.

The default summary is the first present value among `command`, `path`, `url`, `query`, `pattern`, `name`, `id` and `title` (otherwise the first string argument), followed by up to two short `key=value` pairs for the other scalar arguments: `{"query":"x","limit":5}` shows `x · limit=5`. An argument whose name contains `token`, `secret`, `password` or `key` shows `•••`, in templates too. A summary is one line, cut to 120 characters with `…`. An unknown field or an invalid value makes the manifest invalid.

The bundled tools declare these hints:

| Tool | Title | Kind | Summary | Result |
| --- | --- | --- | --- | --- |
| `bash` | `{description\|Run command}` | execute | `$ {command}` | terminal |
| `read_file` | Read | read | `{path}[:{offset}][ +{limit}]` | code |
| `write_file` | Write | edit | `{path}` | text |
| `edit_file` | Edit | edit | `{path}` | diff |
| `apply_patch` | Patch | edit | `{patch_paths}` (the changed paths) | diff |
| `process` | Process | execute | `{action}[ {id}][ {command}]` | text |
| `todo` | Todo | think | `[{title}]` | |
| `ask_user` | Ask user | other | `{question\|Several questions}` | |
| `list_skills`, `load_skill` | List skills, Load skill | read (icon `skill`) | (none), `{name}` | |
| `list_vars`, `read_var` | List variables, Read variable | read | (none), `{name}` | |
| `view_image` | View image | read | `{path}` | |

Summaries of `write_file`, `edit_file` and `apply_patch` are built from their content-free display arguments (path and byte counts, or the patch's paths), never from file contents. MCP tools get their hints from annotations and config ([MCP](mcp.md#display-hints)). The hints are projected into each call's display record when it runs, so history and replay keep them after the tool is unselected. An approval request carries the call's `title` and `summary`, computed from the normalized arguments, and every approval surface uses them as its headline.

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
tool-call ID, the persisted session ID as `context.sessionId` (absent when the runtime has no
session store, so a tool must cope with `undefined`), and available host options; callbacks for
approval stay in Raw.
The result uses Raw's text, JSON, and image blocks and is capped by the host.
Local modules run with the invoking OS account's full permissions. No plugin
sandbox is implied.

The starter `raw` agent selects `builtin/read_file`, `builtin/write_file`, `builtin/edit_file`, `builtin/bash`, `builtin/list_skills`, `builtin/load_skill`, `builtin/list_vars`, and `builtin/read_var`; on Windows without Git Bash, `raw config init` selects `builtin/powershell` in place of `builtin/bash`. `builtin/apply_patch` ships too but is opt-in: add it to `tools.use` for models trained on the patch dialect. Other agents choose their own ordered `tools.use` list, including an empty list. The model receives each tool's purpose, an example call, important result and failure behavior, and parameter descriptions in its function definition. The starter system prompt covers general tasks and on-demand Raw setup skill routing; this document is for users and is not injected into model context. Tool inputs reject unknown fields:

The other two shipped plugins, `builtin/list_skills` and `builtin/load_skill`, expose only agent-selected skills on demand. See [skills](skills.md) for frontmatter, selection, and linked-result behavior.

| Tool | Required input | Optional input | Action |
|---|---|---|---|
| `read_file` | `path: string` | `offset` (1-based first line, default 1), `limit` (lines, default 2000) | Read one window of one text file. |
| `write_file` | `path: string`, `content: string` | — | Create a file or replace its whole content. |
| `edit_file` | `path`, `old_string` (nonempty), `new_string` | `replace_all` (default false) | Replace exact text in an existing file. |
| `apply_patch` (opt-in) | `patch: string` | — | Add, update, move or delete several files with one patch. |
| `bash` | `command: string` | `timeout` (ms, default 120000, at most 600000), `description`, `workdir`, `run_in_background`, `env_refs` | Run one command using Bash. |

When the selected model declares `vision: true`, an agent may select `builtin/view_image` with `{ "path": string }` (`file_path` is read as `path`). It reads a local PNG or JPEG and returns a native image block to the selected model. Relative paths use the session cwd. Raw checks file structure and a separate 16 MiB decoded-file limit; the normal text result cap does not replace a valid image with a placeholder. Missing, invalid, or oversized images return a structured tool error without base64. `raw "Explain screenshot.png"` needs no image flag: the model can call `view_image` using the named path.

Relative paths resolve against the session's `cwd`; absolute paths are used as given. On Windows the file tools, `view_image` and the bash `workdir` also read Git Bash drive paths: `/c/Users/me/a.txt` is `C:\Users\me\a.txt` (a first segment of more than one letter, such as `/cx/`, is not a drive). The process tool's `cwd` stays relative to the session, so a background `workdir` on another drive is refused with that error instead of running elsewhere. Paths shown to the model and in the Files changed panel use `/` on every platform. The working directory does not restrict filesystem access. The process uses the user's full OS permissions. File errors are returned as tool errors. The editing tools report success only after the write finishes. Every file tool reads `file_path`, `filePath` and `absolute_path` as `path`; each rename is kept as a host note.

Text and JSON results retain at most `maxOutputBytes` of content (65536 by default). An MCP, plugin or ACP-injected result that does not fit ends with an `[Output truncated: showing X of Y bytes. Full output saved to <path>; …]` note so the model knows content is missing and where to read all of it. A saved copy holds at most 64 MiB (the note then says it is only the first part), and one process keeps at most 1 GiB of saved copies, deleting the oldest first; directories of earlier processes are removed after 7 days. Images use their separate 16 MiB decoded limit and remain typed.

### Reading

`read_file` reads one file per call: `{"path":"src/app.ts","offset":120,"limit":80}`. To read several files, make several calls. The result is text: each line after its number and a gutter, then one footer line:

```text
 120│export function main() {
 121│  run();
[lines 120–121 of 431; next: offset 122]
```

The footer is `[lines a–b of N; end of file]` when the window reaches the end, `[offset X is past the end: <path> has N lines]` for an offset beyond it, and `[empty file]` for an empty file. The lines share the `maxOutputBytes` budget; when it ends the window early the footer names the next offset. A first line longer than the whole budget is shown cut, with `[line N of T cut at the output budget (B bytes); next: offset N+1]`. A file whose first 8 KiB contain a NUL byte is reported as `[binary file: N bytes; not shown]`. Normalization reads the names other harnesses use: `start_line` as `offset`, `end_line` as the matching `limit`, `max_lines` and `lines` as `limit`, and `view_range: [first, last]` as `offset` and `limit` (a `last` or `end_line` of `-1` reads to the end of the file, within the output budget); line numbers sent as digit strings are read as integers. The batch shape `{"files":[…]}` is rejected with an example of one call. Host data on the result carries the shown path and the `range {start, end, total}`.

### Writing and editing

`write_file` creates a file or replaces its whole content, creating parent directories: `{"path":"notes/todo.md","content":"# Todo\n"}`. `file_text`, `text` and `contents` are read as `content`. The result is `Wrote 1,240 bytes to notes/todo.md (created)` or `(overwritten)`. The old `{"operations":[…]}` and `{"patch":"…"}` shapes are rejected with an example and a pointer to `edit_file` and `apply_patch`.

`edit_file` replaces exact text in an existing file: `{"path":"src/app.ts","old_string":"const a = 1;","new_string":"const a = 2;"}`. `old_string` must match exactly, including indentation, and occur once; add surrounding lines to make it unique, or set `replace_all` to change every occurrence. An empty `new_string` deletes the match; `old_string` cannot equal `new_string`. When a file uses CRLF endings, an `old_string` written with LF still matches and the replacement keeps the file's endings. Zero matches fail with `edit_not_found` and up to three of the file's most similar lines (`Nearest lines:`); several matches without `replace_all` fail with `edit_not_unique`, the count and up to three lines where a match starts (`Matching lines:`); overlapping matches count, so `aa` in `aaa` is two. Neither writes. The result is `Edited src/app.ts: 1 replacement (+1 −1 lines)`. Normalization reads `old_str`, `oldString` and `old_text` as `old_string`, `new_str`, `newString` and `new_text` as `new_string`, and `replaceAll` and `allow_multiple` as `replace_all`. Edits of a missing file point to `write_file`; binary files are refused.

Host data on editing results (never sent to the model) lists each changed file as `{path, action, added, removed}` with `action` `create`, `overwrite`, `edit`, `delete` or `rename` (plus `destination`); `edit_file` and `apply_patch` also carry a unified `diff` of at most 64 KiB, or `diffOmitted: true` when it is larger. Line counts come from the complete content; they are absent for binary content and when a side could not be read in full (a `write_file` overwrite of a file over 8 MiB keeps only a prefix of the old content).

### Multi-file patches

`apply_patch` takes `{"patch":"…"}` (`input` is read as `patch`). The patch string uses this one text dialect (not arbitrary Git patches):

```text
*** Begin Patch
*** Add File: notes.txt
+First line
*** Update File: src/main.ts
*** Move to: src/entry.ts
@@
 unchanged context
-old line
+new line
*** End of File
*** No newline at end of file
*** Delete File: obsolete.txt
*** End Patch
```

Add lines begin with `+`. Update hunks start with bare `@@`; each following line begins with a space for unchanged context, `-` for removed text, or `+` for inserted text. Matching is literal, including whitespace, and must be unique in the remaining ordered source. Overlapping, out-of-order, and ambiguous matches fail. An update hunk with no context or removed lines is accepted only for an empty source; use a context line to anchor insertions in a nonempty file. `*** End of File` anchors that hunk to EOF. The terminal `*** No newline at end of file` marker, following an add body or final update hunk, removes the resulting final separator. Without it, added files end in LF and updated files retain their original final-newline state. Empty additions create empty files. Original BOM and unchanged line separators are retained; inserted lines use an adjacent source separator, then the file's first separator, then LF. Numeric Git hunk headers, binary patches, other marker spellings and invalid UTF-8 source files are rejected.

Limits are 1 MiB of patch UTF-8 text, 64 distinct affected paths (both rename paths count), and 16 MiB of source UTF-8 bytes per file. To bound staging memory, the combined retained source and result bytes across a patch must fit 64 MiB; each source and result is limited to 200,000 lines. Context matching may examine at most 8,000,000 source lines cumulatively across all hunks and files; split a patch containing many separate hunks if it exceeds this work budget. These are independent limits: a patch cannot necessarily combine 64 files of the maximum individual size. Exceeding a limit fails before any mutation. Paths resolve lexically against session cwd. Repeated or contradictory normalized targets are rejected. Add destinations must not exist; update/delete sources must be regular files; moves must not overwrite a destination. Patches reject symlink targets and symlinked ancestors, including destination parents. These restrictions do not apply to `write_file` and `edit_file`.

All file contents and output envelopes are staged before the first mutation. Invalid syntax, missing files, conflicting context or known destination conflicts leave every target unchanged. Sources are rechecked before application; source edits detected at that point also leave targets unchanged. During application, each remaining source/destination is rechecked. Updates use same-directory staged replacement and retain file permissions. Changes apply in patch order. An I/O failure or newly detected external edit stops remaining changes; successful earlier changes remain. A failed move can report an already-created destination if deleting its source fails. No rollback overwrites external writers. This is not a cross-file transaction or a guarantee against races after the final check.

The result is one line per changed file with its line counts: `A notes.txt (+1 −0)`, `M src/app.ts (+1 −1)`, `D obsolete.txt (+0 −3)`, `R src/main.ts → src/entry.ts (+1 −1)`, then `failed <path>: <code>` or `skipped <path>: <code>` for files a failure stopped, or `No changes.`.

### Effects and the Files changed panel

The three editing tools expose immutable intended effects before conditional policy, hooks and approval, so one rule covers them all: `{"source":"effects","any":"files[*].path","regex":"/protected/"}` asks before any of them touches a matching path. `write_file` exposes `write`, `edit_file` exposes `edit`, and `apply_patch` exposes `write` for adds and updates, `delete` for deletes, and both `rename_source` and `rename_destination` for moves. Effect paths are absolute lexical paths, not realpath or a filesystem security boundary. Original arguments retain their exact spelling and shape. Failed preflight is not a completed write.

Successful writes, edits and patches of the bundled tools appear in one shared **Files changed** sidebar panel (`host/files_changed#files_changed`), whichever tool made them. Paths are relative to the session cwd (a path outside it shows as `~/…` or absolute). Each path shows its action, the lines added and removed across the session's writes to it, and the latest diff (at most 8 KiB), or why there is none (binary, too large, unreadable). The header reads `3 files · +40 −12`; a footer row counts history entries dropped to keep the panel within its limits, only when there are some. It is not Git status and does not observe Bash or external edits. Sessions recorded before this panel existed keep their old `builtin/write_file#files_changed` panel as stale history; it is not migrated. A local or package copy of one of these tools keeps its own identity and panels.

`bash` runs one command per call: `{"command":"npm test","timeout":300000,"description":"Run the test suite"}`. For several commands make several calls, or join them with `&&`. `timeout` is in milliseconds, defaults to 120000 and is clamped to 600000 with the note `[timeout clamped to 600000 ms]`. `workdir` runs the command in that directory, resolved against the session cwd. `description` (at most 200 characters) is the call's title in the terminal and dashboard. Normalization reads the names other harnesses use: `cmd` and `script` as `command`, a `["bash","-lc","…"]` array as its command string, `timeout_ms` as `timeout`, `timeout_s` and `timeout_seconds` as seconds, `cwd`, `dir_path` and `directory` as `workdir`, and `is_background` and `background` as `run_in_background`. The batch shape `{"commands":[…]}` is rejected with an example of one call.

The result is text: stdout and stderr in the order the command produced them, then one status line such as `[exit 0 · 1.2s]`. A nonzero exit is reported in that line, not as a tool error. A timeout ends the process group and reports `[timed out after 120s; process group stopped]`; an abort reports `[aborted after 3.1s; process group stopped]` (on Windows both say `process tree stopped`); a signal reports `[killed by SIGTERM · 0.4s]`. Output larger than the result budget keeps its start (a fifth) and its end, where errors and summaries usually are, around a `…[N bytes omitted; full output: <path>]…` marker; the named file holds the complete output (up to 64 MiB) that the model can read with `read_file` or search with `grep`. Saved outputs live in a private per-process temporary directory and are removed after seven days. UTF-8 characters are never split. Host data on the result (never sent to the model) carries the exit code, signal, duration, description and the saved-output path.

`run_in_background: true` starts the command as a managed job through `builtin/process` instead of waiting: the call passes the `builtin/bash` rules and hooks with the flag in its arguments, then the `builtin/process` rules, hooks, approval and limits for the `start` it makes. The result is `Started background job <id> (<command>).` with the `process` calls that read its output and stop it; a refusal inside the `process` gates is returned as that error and nothing runs in the foreground. A background job has no default timeout; a given `timeout` is clamped to 600000 like a foreground one. When `builtin/process` is not selected, not exposed or hidden by an unconditional `deny`, or when a copy of the bash example runs as a local tool (delegation is for the bundled tool only), the command runs in the foreground with the note `[ignored run_in_background: background jobs need the process tool; ran in the foreground]`.

An over-limit external JSON tool result is a labeled text preview, never malformed JSON presented as structured data. Tool-result events and logs show image metadata, not base64.

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

`builtin/todo` is the reference panel tool ([panels-design.md §18](panels-design.md)). Select it like any tool (`"tools": {"use": ["builtin/todo"]}`); the starter config does not. The model sends `todos` with `mode` `replace` (default: the whole list, ids optional) or `merge` (items by `id`, `remove: true` deletes an item with its subtasks, `clear: "done"` removes finished items). Generated ids are the smallest unused `t<n>`. Statuses other harnesses use are read as Raw's: `completed` as `done`, `cancelled` as `skipped`, `in-progress` as `in_progress`; item text may come as `description`, `title` or `step`, numeric ids are read as text, and item fields Raw does not use, such as TodoWrite's `activeForm`, are dropped with a note. Rules: at most 100 items, one `in_progress`, subtasks only one level deep, and a `done` or `skipped` item cannot have an unfinished subtask. A rule violation returns `invalid_todo` naming the item and changes nothing. The result is a text list with ids (`[x] t1 …`); the user sees the same list live in the Todo panel. The state lives in the panel, so it survives restarts and compaction. The tool does no file I/O.

## Tools in an external backend

An agent with a `backend` runs Claude Code, Codex or agy with their own file and shell tools. Raw's other selected tools reach Claude Code and Codex through Raw's MCP server `raw`, with rules, approvals, panels and questions as here; agy gets none of them, each skipped with a warning. See [Raw tools in a backend](backends.md#raw-tools-in-a-backend).

## Agent rules

An optional agent `tools.rules` array applies to built-ins, MCP tools and ACP-injected tools. Each rule is `{ "match": "<glob>", "effect": "allow" | "ask" | "deny" }`. `*` matches any number of characters and `?` matches one character; the pattern covers the whole canonical tool identity. Built-in identities are `builtin/read_file`, `builtin/write_file`, `builtin/edit_file`, `builtin/apply_patch`, `builtin/bash`, `builtin/powershell`, `builtin/process`, and `builtin/view_image`; local plugin identities are `local/<id>` or `agent/<id>`; MCP identities are `mcp/<server>/<original-tool-name>`; ACP-injected identities are `acp:<registered-name>`. Rules run in array order and the last match wins. No match means `allow`.

`deny` removes the schema from the model and rejects direct dispatch. `ask` remains visible and requests permission once for each call through the CLI TTY or ACP `session/request_permission`; headless execution without an approval channel returns `approval_required`. `-y` never overrides an explicit `ask`. `allow` executes automatically. Policies are tool-name filters, not filesystem or process isolation: allowing `bash` grants the agent the user's full shell permissions even if the editing tools are denied.

An `ask` rule may add `"when": {"source": "arguments", "any": "command", "regex": "(^|[;&|()\\n])\\s*(sudo\\s+)?(/usr/bin/|/bin/)?rm(\\s|$)"}`. Raw matches the normalized command with an unanchored RE2JS search after validating the call, and asks before running it; other Bash calls run automatically. `when.any` follows dotted object fields and `[*]` array traversal to a string, number or boolean field, so the same form works for typed local, MCP, or ACP tools. A number or boolean is matched as its text: `{"source": "arguments", "any": "run_in_background", "regex": "^true$"}` asks before every background Bash job. A path that a tool renamed fails with the new argument name, for example `commands[*].command` on `builtin/bash` names `command`, and `files[*].path` on `builtin/read_file` names `path`. Optional absent fields do not match. Conditional rules may only have effect `ask`. Rule order still matters: the last applicable allow/ask/deny wins, while an unconditional deny keeps the tool hidden until a later unconditional rule allows it. The regex sees command text, not shell semantics; use a broader pattern if your workflow needs broader review.

On macOS and Linux the `bash` tool requires Bash on `PATH`, or an explicit `RAW_BASH_PATH`. Each invocation supervises one process group. Abort or deadline sends TERM to that group, then KILL if needed. Long-lived, deliberately detached jobs can escape the group and are outside this guarantee; start servers and watchers with `run_in_background` or `builtin/process` (see [processes](processes.md)).

On Windows the `bash` tool runs Git Bash. `RAW_BASH_PATH` always wins; otherwise Raw takes the first of `%ProgramFiles%\Git\bin\bash.exe`, `%ProgramW6432%\Git\bin\bash.exe`, `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, the `bin\bash.exe` of the Git whose `git.exe` is on `PATH`, and a `bash.exe` on `PATH`. It never picks WSL implicitly: `PATH` entries under the Windows folder, `WindowsApps` folders and relative entries are skipped, and so is any candidate inside the session's workspace. When none is found the call fails with `bash_unavailable`, naming Git for Windows, `RAW_BASH_PATH` and `builtin/powershell`. The command runs inside a job that owns its whole process tree: abort or deadline stops the tree at once and reports `process tree stopped`, and processes the command leaves running are killed when it exits. The job does not allow breaking away, so Git Bash's own programs and everything they start stay in it. Without the .NET Framework compiler that builds the job launcher, Raw stops trees with `taskkill /T` instead, which can miss processes whose parent has already exited (see [architecture](architecture.md#windows-process-trees)).

`powershell` (`builtin/powershell`) runs one PowerShell command per call and takes `bash`'s arguments, aliases, `run_in_background` and `env_refs`; its result has the same output and status line. A command array is read with PowerShell's quoting, and `["pwsh","-Command","…"]` as its command string. Select it in place of or beside `builtin/bash`; rules and hooks match it by its own identity, and the Commands panel, compaction notes and full-argument display treat it like `bash`. It runs `RAW_POWERSHELL_PATH` when set. Otherwise on Windows it runs the first of `pwsh.exe` on `PATH` (absolute entries outside the workspace), `%ProgramFiles%\PowerShell\7\pwsh.exe` and the system's Windows PowerShell 5.1, and elsewhere `pwsh` on `PATH`; with none the call fails with `powershell_unavailable`. PowerShell 7 is recommended: Windows PowerShell 5.1 has no `&&` or `||`, so the description tells the model to join commands with `;` and `if ($?) { … }`. The command runs with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, so `npm.ps1` and other scripts run under the default policy, and writes UTF-8 without progress records. The command is parsed on its own, so it may start with `using`, and error line numbers are its own. The exit status follows Bash's: `exit 3` gives 3; when the last program that ran is native (named, by path, alias, variable or string, also inside a function or script such as `npm.ps1`), a failing command, or a last statement that is a command, gives that program's code; any other failing last statement or a `throw` gives 1 (in a script with `begin`, `process` or `end` blocks, the last statement of the block that runs last). As in PowerShell, a function whose own last cmdlet fails, or a command invoked from an expression such as `& (Get-Command node)`, gives 1 or 0 by `$?`. On Windows it runs inside the same process-tree job as `bash`; background calls start a `process` job with `shell: "powershell"`.

The development-only `npm run test:overhead` reports the exact canonical input and `o200k_base` token count for the production default prompt and built-in definitions, and each definition's own count, including `powershell`'s. It measures combined overhead without imposing an arbitrary combined-token ceiling; essential tool guidance remains in the definitions. External tools, custom prompts, and provider framing add separate overhead.

## Variables in local tool handlers

Select `builtin/list_vars` and `builtin/read_var` for discovery and reads, and
select exact variable names in `agents.<name>.vars`. The host passes an
agent-scoped `context.vars` service to every selected local plugin, including
forked bundled tools. `list()` is metadata only; `read(name,{signal})` resolves a
readable value; `validateEnvRefs(refs)` checks names/types without I/O;
`resolveEnv(refs,{signal})` returns scalar environment bindings for trusted tool
code. Standalone handlers must report an unavailable service if refs require it.

Bash accepts `env_refs` beside `command`. The registry checks policy and approval
before any resolution. The handler validates the reference metadata, then resolves
the values immediately before starting the process; a resolution failure returns
an error and runs nothing. Bindings override only that child's environment. Raw keeps references in original
arguments and never substitutes resolved values into shell command text.

```json
{"command":"test -n \"$GH_TOKEN\"","env_refs":{"GH_TOKEN":"github_token"}}
```

`access: "use"` prevents Raw's read tool returning a value, but trusted commands
and plugins can still print it. This is not OS isolation. MCP does not acquire
`env_refs` or variable interpolation automatically. See [variables](vars.md).

Managed dashboard edits use [revision-checked configuration and owned component services](management.md). Viewing a catalog never imports tool code or starts providers/MCP; changes take effect on the next turn.

The current development tool inspection contract uses explicit predicate sources and separate intended effects; see [tool-effects.md](tool-effects.md). Old tool/hook formats are not adapted.

## Structured questions

Select `builtin/ask_user` explicitly to ask the user a question. It uses the generic interaction service and a chat view; copying the standalone example and changing its declaration to sidebar uses the same service and renderer. One call asks one question in plain words: `{"question":"Which database should the service use?","options":["Postgres","SQLite"]}`. `options` is optional and takes strings or `{label, description}` objects (at most 32); without options the answer is free text. `multi_select` lets the user pick several options, and `allow_other` (default true) adds an optional text field so the user can answer in their own words or skip; with `allow_other: false` a choice is required. `header` is a short label shown above the question. Up to 3 related questions go in one form as `questions: [{question, header, options, multiSelect}]`, the shape Claude Code, Qwen and Codex send. `multiSelect` and `allowOther` are read as `multi_select` and `allow_other`. Question and option fields Ask does not use are dropped with a note. The removed `{questions:[{id, label, kind, free_text}]}` schema is rejected with an example. The host builds the form fields itself (`answer`, or `q1`…`q3`, with option ids `o1`, `o2`, …).

The result is text: `User answered: Postgres` (choices joined with `, `, then any text of the user's own), or `User skipped the question` when nothing was chosen or typed. Several questions answer as `User answered:` followed by one `- <question>: <answer>` line each, `(skipped)` for an empty one. The result spells out each chosen label, so Ask limits how many choices a multiple choice accepts and how long the text fields are to keep that text within the output budget; the host also validates the answers before accepting them, and the user's text reaches the model unchanged. A description is shown after its option label as far as 200 characters allow; the label itself is never cut. A cancelled question returns `User skipped the question`, and expired and interrupted ones say so, each as a failed tool result with code `interaction_cancelled`, `interaction_expired` or `interaction_interrupted`. An unavailable adapter or unrepresentable minimum answer fails promptly with `interaction_unavailable` or `interaction_budget_too_small`.

Dashboard users answer the shared Form. TTY sessions collect the same validated fields through the existing input queue; non-TTY sessions do not wait for input. Library callers supply `interactionAdapter(request, signal)`, returning the common scoped submission (`requestId`, `expectedRevision`, `idempotencyKey`, `response`, and `answers` for submit). This callback is separate from `approve`. Hosts may instead inject an `InteractionService`; supplying both service and adapter is an error. For persisted agents the injected service must use the same session database; an in-memory or wrong-store service is rejected before session ownership is claimed. Separate connections to the same database are supported. Non-persisted agents may use an in-memory service. ACP uses the negotiated interaction extension documented in [ACP](acp.md).

## Background processes

Select `builtin/process` for `start`, `list`, `status`, `output` and `stop`. It uses a host-owned supervisor, so acknowledged starts survive turns. This is separate shell authority from `builtin/bash`; normal policy, approval and hooks apply to dispatch. A library host supplies `AgentOptions.processes`, backed by `ProcessSupervisor`, and closes that supervisor before its store. `deleteSession({ sessionId, processes })` awaits owner-host cleanup; deletion without a supervisor rejects live foreign ownership. See [managed processes](processes.md) for limits, cursor semantics, deletion fencing and shutdown/recovery guarantees.
