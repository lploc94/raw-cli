# Local dashboard

Run `raw dashboard` from the project you want to work on. Raw starts a foreground server at `http://127.0.0.1:8787` and opens your browser when launched interactively. It prints an authenticated launch link. Keep this process running while using the dashboard; Ctrl-C closes its operations, connections and session ownership.

```sh
raw dashboard
raw dashboard --port 0 --no-open
raw dashboard --config /path/to/raw.json --agent deepseek
```

`--port 0` chooses a free port. An occupied port is an error; Raw never terminates another listener or silently attaches to it. `--no-open`, SSH and noninteractive launches leave a usable printed link. Browser opening failure does not terminate a healthy server.

One dashboard manages one displayed config file. The invoking directory is its initial workspace. A workspace changes relative runtime paths, not OS filesystem permissions. Missing credentials or missing/invalid config do not prevent the setup/repair interface from loading. No model, tool or MCP connection starts just to display the application.

The launch token is in the URL fragment. The browser keeps it in tab session storage, removes the fragment from the address bar and authenticates API/stream requests through an Authorization header. A server restart creates a new token; reopen the new launch link. Do not publish a launch link to others. The server binds only IPv4 loopback and does not provide accounts, LAN sharing or a public listener.

Browser tabs observe server-owned operations. Closing or refreshing a tab does not cancel a run. Stop cancels an operation explicitly. CLI and browser use the same saved sessions; a session executing in another process remains readable, and becomes runnable in the dashboard after its writer releases it.

See [session operations](sessions.md), [management](management.md) and the [dashboard API](dashboard-api.md) for persistence, configuration authority and transport contracts.

## Chat workspace

Choose a workspace and agent, then create a chat. Enter sends; Shift-Enter adds a line. The Chat browser preference can require Ctrl/Cmd-Enter instead. Composition input is never sent before the IME confirms it. Drafts stay in memory when navigating between sessions. No inference starts until Send.

History is chronological and Load earlier prepends older records. Jump to latest resumes following output. Work groups disclose actual reasoning, tool arguments and saved result previews; they do not replay tools. An abbreviated display and a tool-truncated result are labeled separately. Stop remains available during preparation, tool execution, approval and compaction. Inline Allow once/Deny answers only that pending call. Activity remains available from every page.

Open the Context inspector for estimated current tokens/window/percentage, last-turn and session usage, cache measurement coverage, current summary and a copyable CLI resume command. Compact context summarizes model context while preserving visible history. Empty/no-smaller/cancelled/failed attempts retain their distinct outcomes. Closing a tab keeps the operation running; reconnect replaces transient state from the server and never sends your prompt again.

Use Ctrl/Cmd-K for navigation and session-title search; Ctrl/Cmd-comma opens Settings. Appearance and Chat preferences apply only to this browser. Theme, density, font sizes, panel widths and disclosure defaults never change Raw config or model context. Preferences have a versioned, validated local-storage record; credentials and transcripts are excluded.

## Frontend development

`npm run build` builds the CLI/server and then bundles the static React application under `dist/dashboard`. The installed command needs no Vite server or external assets. `npm run test:web` runs isolated mock-provider browser scenarios; install engines once with `npx playwright install chromium firefox webkit`. Browser tests use the built application and the real authenticated HTTP API.

## Layout examples

These screenshots use a disposable workspace and a mock provider. Reproduce them after building with `node --import tsx tests/dashboard-ui/capture.ts`.

![Dark chat workspace](dashboard/chat-dark-desktop.png)

| Layout | Light | Dark |
| --- | --- | --- |
| Desktop, 1440×900 | [View](dashboard/chat-light-desktop.png) | [View](dashboard/chat-dark-desktop.png) |
| Tablet, 800×900 | [View](dashboard/chat-light-tablet.png) | [View](dashboard/chat-dark-tablet.png) |
| Narrow, 320×900 | [View](dashboard/chat-light-narrow.png) | [View](dashboard/chat-dark-narrow.png) |

[Context inspector](dashboard/chat-dark-inspector.png) shows estimates, available usage, measurement coverage and the last attached capabilities. Older measurements may be unavailable or stale; viewing them does not start a model or tool.
