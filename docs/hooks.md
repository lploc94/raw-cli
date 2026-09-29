# Agent hooks

Hooks run a selected command when Raw reaches a named session, turn, or tool event. An agent selects exact hook IDs in `agents.NAME.hooks.use`, in execution order. Use `agent/name` for a folder beside the selected config (`hooks/name/`) or `local/name` for a folder under `~/.config/raw/hooks/`. Installed package IDs use `pkg/ALIAS/hooks/EXPORT`. Raw loads no hooks when `hooks.use` is absent or empty.

Each folder has `hook.json` and any scripts it owns. A manifest declares `name`, a nonempty `events` array, `command`, optional `args`, and optional `timeout_ms` (default 5000, maximum 30000). Each event item is `{ "name": "PreToolUse", "match": "builtin/bash", "when": { "any": "commands[*].command", "regex": "(^|[;&|()\\n])\\s*rm(\\s|$)" } }`. Tool event `match` is a bounded glob against the canonical tool ID; `when` uses the same RE2 argument filter as `tools.rules`. Both are optional and invalid on non-tool events. Matching happens before process spawn. The command is an executable on PATH or a `./` path contained in the hook folder. `./` arguments resolve inside that folder; other arguments remain literal. No shell expands the command or arguments. The process runs from the session cwd with Raw's environment and OS permissions.

The initial events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and `SessionEnd`. `SessionStart` means a runtime attachment, including resume; `SessionEnd` means that attachment closed, not that stored history was deleted. A tool hook sees built-in, local, MCP, and ACP tool calls through one boundary. The tool payload carries `source`: `"user_action"` when a person ran a declared panel action from the dashboard, otherwise `"model"` (an absent value means `"model"`). `PostToolUse` and `PostToolUseFailure` fire only after a handler ran. Policy-denied, hidden, invalid, or approval-denied calls do not fire tool hooks.

`raw.hook/1` sends one UTF-8 JSON object on stdin. It contains `protocol_version: 1`, `event`, `cwd`, optional agent/session/turn IDs, and an event-specific payload. The command may write nothing to stdout for success, or exactly one JSON object. `UserPromptSubmit` and `PreToolUse` accept `{ "decision": "continue" }` or `{ "decision": "deny", "reason": "..." }`; exit 2 also denies and wins over conflicting JSON. Exit 0 with empty stdout continues. A response may include a short `message` for host display. Other events are notifications and cannot change an already completed result. Malformed output, nonzero exit other than 2, spawn failure, timeout, or output overflow blocks a gate and only warns on a notification. A continue response never overrides an existing `ask` or `deny` tool rule.

Every executed hook emits a bounded receipt with its ID, event, outcome, elapsed time, and optional message/error code in live output and visible history. Hook input and raw stdout are not logged by default. Hooks do not edit model messages or tool schemas. Selected hook files are snapshotted at runtime load; editing a source file cannot change an already attached runtime. New bytes take effect on the next attachment/turn, including resume, and meaningful changes may rotate the generated cache key once. A new user operation can run hooks again; recovery never replays a hook from an interrupted operation.

Commands have bounded stdin/stdout/stderr, timeouts and cancellation. A selected folder snapshot allows at most 256 regular files and 16 MiB total, and rejects links. Gates use the active turn's abort signal. Terminal notifications after cancellation use a separate bounded cleanup window before the durable operation receipt; `SessionEnd` has its own close window. Raw terminates the hook process tree when these windows expire. A script's own side effects cannot be rolled back. Scripts should make externally visible side effects idempotent if retrying a new user operation is possible.

The command/JSON/event pattern follows common CLI-agent hook designs, but `raw.hook/1` is Raw's own protocol. It is not an implementation of another product's hook API.

## Runnable examples

The installed `examples/hooks/guard/` contains a Node gate and failure notification. Copy it to `hooks/guard/` beside your selected config, then add `"hooks":{"use":["agent/guard"]}` to the intended agent. Its `PreToolUse` subscription matches `builtin/bash` and uses `commands[*].command` with RE2 to narrow to direct `rm` commands. The script writes `{"decision":"deny","reason":"Review removal commands first"}`. Its `PostToolUseFailure` subscription writes `{"message":"Bash command failed"}`. The regex is textual and does not parse shell syntax; keep or add tool policy for broader protection.

For a Python notification, create `hooks/notify/hook.json` with `{"name":"notify","events":[{"name":"Stop"}],"command":"python3","args":["./notify.py"],"timeout_ms":3000}` and `hooks/notify/notify.py`:

```python
import json
import sys

event = json.load(sys.stdin)
print(json.dumps({"message": f"Turn {event.get('turn_id', 'unknown')} finished"}))
```

Select `agent/notify` after any gates in `hooks.use`. The Python script only reports; it cannot deny Stop.

For a no-network smoke test, use a config with an available local model or the repository's fake provider fixture. Run `raw --config /path/to/raw.json --agent NAME "Run a harmless printf command"`, then resume the printed session ID with `raw --config /path/to/raw.json --resume ID "Continue"`. A nonmatching `printf` command should have no guard receipt; a matching removal call should show a `hook_denied` result and a `PreToolUse` receipt. Open `raw dashboard`, select the same agent, create a chat and inspect its live hook receipt and saved history. Library → Hooks lets you edit the manifest/script and attach the ID with a revision check; browsing a hook never runs it. `raw --config PATH config list` validates configuration only and does not call the script.
