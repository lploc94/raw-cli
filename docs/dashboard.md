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

## Customize your agents

Agents selects a model, a literal or file prompt, and ordered tools, skills and
vars. JSON views expose all existing request/cache/compact/policy fields and
package overrides. Skill selections require the list/load skill tools. Policy
samples evaluate the actual ordered rules without running the sample command.

Library shows component provenance, usages and static validation. Fork a builtin
or immutable package into a local component before editing it. Each source file
has its own Save and revision. Creating/forking leaves the component unselected;
attach it to an agent explicitly. Linked package files are their authored source.
A tool's manifest name controls its model-facing name; package selections also
support the existing `{ref, as, inputs}` binding. No new alias syntax is added.

Changes apply on the next turn, including in an existing session. Saving never
cancels an active run. Unsaved editor state has Save/Discard controls and a
navigation guard; a conflict keeps the draft and offers reload or explicit
reapplication after reviewing the latest revision. Ctrl/Cmd-S saves the active
editor. Advanced config is strict JSON, with no comments or trailing commas.

Settings separates **This browser**, **Raw config** and **This agent**. Search
matches labels and actual config keys. Missing config can initialize the same
starter as `raw config init`; invalid config opens the source repair editor.
Retention belongs to the canonical config, so alternate-config dashboards show
its location without writing that other file. Diagnostics copy uses an allowlist.
Model saves perform validation only; Start test chat uses the ordinary composer.
Vars Read and MCP Discover are explicit, cancellable actions. Merely opening
Library or saving a definition does not execute a provider or connect to MCP.

Agent and source editor examples (isolated fixture data):

![Agent editor in dark mode](dashboard/agent-dark-desktop.png)
![Agent editor in light mode](dashboard/agent-light-desktop.png)
![Read-only tool source with syntax highlighting](dashboard/tool-dark-desktop.png)

Reproduce these images after building with
`node --import tsx tests/dashboard-ui/capture-management.ts`.

## Share portable packages

Open **Library → Packages** to choose a `.rawpkg` file or inspect a local source
path. Review exports, recipient inputs, required Raw capabilities and external
executables before choosing an alias and Install. Inspect and install are passive;
neither selects an agent nor changes `default_agent`.

Use agent creates a local binding with your own model and typed inputs. Add
component selects a tool/skill on an existing direct agent or creates a named
vars/provider/MCP binding. Configure MCP tool selections through explicit discovery.
Package-agent overrides stay complete replacements in the Agent JSON editor.

Export agent produces a downloadable archive. By default, literal variable values
and external files become recipient decisions. The form exposes the SDK's explicit
include-literals option and a list of external files to include. Review the resulting
inputs/report before sharing. The archive works after the author's directory is
removed; recipients supply their own model connection.

Update first inspects a replacement snapshot, then applies it under an existing
alias. Failed validation keeps the current package. Resume the same session to use
the update on its next turn. Link opts into authored source changes, Fork copies
into an empty/new source directory, and Remove names any bindings that still use
the alias. Discard temporary imports/downloads when finished; stages expire after
30 minutes or when the dashboard stops.

![Package inspection before installation](dashboard/package-dark-desktop.png)

Reproduce the package view with
`node --import tsx tests/dashboard-ui/capture-management.ts --packages-only`.
