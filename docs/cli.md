# CLI and REPL contract

`raw config init` creates agent `raw` with the local model alias, the three core file/Bash tools, both skill tools, and six built-in setup skills, including `builtin/create_package` for sharing. Its editable system prompt asks the agent to list selected skills for Raw setup tasks and load only relevant instructions. `raw "query"` uses `default_agent` from the config; `raw --agent raw "query"` selects `raw` explicitly. Existing configs may set another default and are never overwritten by init.

`raw "task"` runs one saved turn and exits. `raw` and `raw --interactive` open a saved REPL with `❯ ` on a Unicode terminal and `> ` in ASCII/plain mode. `--` ends flag parsing so tasks may begin with `-`. Each attachment loads the current selected agent, tools, skills, MCP servers, limits and prompt; the session keeps its ID and committed history. Sessions live in the private global state directory and expire after seven days without committed conversation activity by default; `sessions.retention_days` in the canonical global config changes this duration.

To run a copied agent directory, use `raw --config
/path/to/project-helper/raw.json --agent project "task"`. The packaged
`examples/agents/project-helper/` contains its own prompt, tool, and skill.
Set the recipient's model ID, endpoint, and credentials. The
`agent/` paths remain relative to that config file even when the command runs
from another workspace.

`raw --continue [task]` resumes the latest unexpired session for the current workspace. `raw --resume ID [task]` resumes one ID in its saved cwd and prints that cwd. With a task, stdout contains only the new answer. One-shot stderr finishes with turn status/time/tool count, estimated current context and percentage when the selected model declares `context_window_tokens`, provider-reported cumulative session usage where complete, and a copyable `raw --resume ID "query"` command when the saved session remains usable. The command also appears after ordinary failed or cancelled turns. A persistence failure does not claim continuation. The context estimate includes the system prompt, selected tools, and active messages; it is not cumulative usage or an exact remaining-token count. Missing windows, token coverage and cache counters remain unknown rather than zero. `/stats` and verbose mode show per-field report coverage, including separate cache-read/write coverage. See [terminal output](terminal-output.md) and [context](context.md).

Without a task, the latest 20 saved display items are shown before the REPL. A resume uses the saved config path and agent as defaults, accepts explicit `--config` or `--agent` overrides, and saves the resulting selection for the next resume. An explicit replacement config can recover a session whose old config file was removed. A missing cwd or currently selected config remains an error. Changed runtime or selected tools advance the context revision and rotate Raw's generated cache key while preserving committed history; the next unchanged resume retains that key. Changed selected skills advance the revision without rotating that key; when earlier list/load results became stale, Raw appends one reload notice at the tail. An explicit OpenAI `agent.cache.key` retains precedence over Raw's generated key. Terminal UI settings may change between runs without changing model/cache identity. Provider cache reuse remains best effort.

`raw sessions [--all] [--before CURSOR]` lists a bounded page for the current workspace or all workspaces and prints the next cursor. `raw sessions show ID [--before CURSOR]` renders the newest 20 visible items or an older page using current UI settings. It needs no model credential or tool startup. `raw sessions delete ID` permanently removes one inactive session; `raw sessions stats` reports database, WAL and payload storage for the active store. Listing and viewing do not renew expiry. If an old incompatible session database is present, new sessions use a separate active store; an ID that exists only in the preserved old store is unavailable until that old format is handled separately. History keeps complete displayed Bash arguments and CLI result previews, while older full model-only tool outputs can be reclaimed after compact.

Library callers can import `listSessions`, `getSessionHistory({ sessionId, before, limit })`, `resumeSession`, and `deleteSession` from `raw-cli`. Pagination returns the same opaque cursors as the CLI. `resumeSession` takes the current provider, tool registry and optional config path, reconciles changed runtime state, and returns an agent plus a `close()` method that releases its session claim and store; callers must close it when finished.

Redirected one-shot stdout contains the original assistant text once, in arrival order. A shared interactive terminal renders it as Markdown with code highlighting. Provider-supplied plaintext reasoning follows the configured `ui.reasoning` mode: summary shows a host label, full shows the text, and hidden suppresses it. Providers that return no plaintext reasoning produce no thinking activity. Tool activity and automatic compact progress go to stderr. If assistant text has no trailing newline before tool or progress output, the CLI adds one first. A running tool prints its readable arguments before execution; a call rejected before execution prints a warning with its complete arguments so the error is diagnosable. `bash` preserves full ordered command arguments (shown as readable commands on an interactive terminal), while `write_file` shows operation paths, modes and payload byte counts without displaying `content`, `old_text`, or `new_text`; for an invalid top-level write shape, only argument names appear. Other long argument lists are shortened for display only. On a shared interactive terminal, distinct type icons, status icons, syntax colors and an optional transient activity line make actions easy to scan. Redirected output and `TERM=dumb` use append-only plain text; `NO_COLOR` disables colors in auto mode while still allowing the selected Unicode or ASCII icon set on a shared terminal. A completed turn ends with a newline if streamed text did not already end with one. The four REPL commands must occupy a whole line: `/compact` requests an explicit summary using the selected model (possibly in several bounded chunks); `/clear` closes the old session and starts a new saved ID while leaving old history available; `/stats` shows a readable cumulative request/token/cache coverage table without model traffic; `/exit` closes the session. An unknown slash line is ordinary task text. `compact.trigger_tokens` enables automatic compact before an over-threshold inference; without it, compact remains manual.

On a shared interactive terminal, Raw renders a small agent/model/cwd header, Markdown answer with syntax-colored code, and tool activity using semantic type and status icons. Compact hides successful preview bodies, normal shows at most four source lines and verbose shows the full retained preview; errors retain the full bounded preview. The `--reasoning` setting controls provider-supplied plaintext reasoning independently of assistant text. `summary` shows only a host thinking label. On redirects and separate terminal descriptors, Raw uses append-only output. Tool-policy prompts show complete arguments and suspend transient activity before accepting a fresh answer.

Every tool result has a status line and a stderr preview. Indexed built-in batches retain a bounded summary of every row's status separately from the preview body. The body keeps at most nine source lines and 2,000 Unicode characters, preserving head and tail with an omission marker. Read-file preview records preserve path and source-text type so the renderer can highlight code after a restart. The display cap never changes the result sent to the model; `--max-output-bytes` controls the separate model-facing cap. Tool identity comes from the registry, so a custom or MCP tool with a built-in-sounding name still uses the generic formatter.

All tools execute automatically with the host account's permissions, including on TTY and non-TTY input. `-y`/`--auto-approve` is a compatibility alias. Ctrl-C aborts active work; in a REPL it returns to `> `, and a second Ctrl-C while idle exits. EOF aborts active work and exits after cleanup. One-shot cancellation exits 130.

Exit codes are 0 for completed turns and informational commands, 1 for runtime/provider errors, 2 for argument/config errors, 3 for max steps, and 130 for user cancellation. Recoverable tool errors that the model handles do not set process exit status. Startup and shutdown close owned MCP clients and running shell processes.

## Runtime variables

`raw [--config PATH] [--agent NAME] vars list` returns one JSON catalog; `vars get NAME` returns `{name,value,observed_at,cached}`. These utilities use effective agent selection without credentials, prompt files, plugins, MCP or session storage. Only config/agent flags apply. Use-only get is rejected. Errors use stderr: invalid config/arguments exit 2, resolution/access failures exit 1, cancellation exits 130. Each utility invocation starts an empty value cache. `config init` selects both variable tools and a readable `now` clock for the raw agent.

## Portable packages

`raw package list|inspect|validate|pack|export|install|update|remove|link|fork` and `raw agent add` run before session/model startup. They report JSON to stdout and take `--config PATH` to select a per-config installation lock. Typical flow: `raw package export --agent NAME --name @owner/name --version 1.0.0 --out DIR`, `raw package pack DIR --out FILE.rawpkg`, `raw package install FILE.rawpkg --as ALIAS`, then `raw agent add NAME --from pkg/ALIAS/agents/EXPORT --model MODEL_ALIAS`. `--inputs FILE` reads recipient input values from a JSON object. `package update ALIAS --from PATH` checks current bindings before switching the alias; `package fork ALIAS --out DIR` produces editable source, while `package link DIR --as ALIAS` snapshots edited source on the next run. No package command opens the session store or uses model credentials. See [packages](packages.md).

## Local browser dashboard

`raw dashboard [--port PORT] [--no-open] [--config PATH] [--agent NAME]` starts a
foreground server bound to `127.0.0.1`. Default port is 8787; port 0 selects a free
port. The printed authenticated launch URL remains usable if browser opening is
unavailable. Ctrl-C/SIGTERM cancels owned work and closes children/connections.

The browser creates and resumes the same stored session IDs as CLI/ACP. Refresh or
closing a tab leaves a server-owned run active; Stop cancels it explicitly. A
session busy in another process remains readable until that writer releases it.
The Context inspector copies `raw --resume ID "query"` for terminal continuation.
Config/source changes apply on the next turn and unchanged follow-ups stabilize;
no session reset or migration is required for ordinary customization.

One server manages the displayed config authority. `--agent` preselects the new-chat
agent; workspace selection changes cwd, not configuration scope or OS permissions.
The installed app includes its static and lazy editor assets. See
[Dashboard](dashboard.md) and [HTTP contract](dashboard-api.md).
