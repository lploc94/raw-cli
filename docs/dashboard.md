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
