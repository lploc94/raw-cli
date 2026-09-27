# Agent hook configuration

`agents.NAME.hooks` is optional and accepts only `use`: an ordered array of unique exact string IDs. `local/<name>` loads `~/.config/raw/hooks/<name>/`; `agent/<name>` loads `hooks/<name>/` beside the selected config; `pkg/<alias>/hooks/<export>` loads an installed package hook. Missing or empty `use` means no hook. A selected folder requires `hook.json` and all referenced assets. `builtin/` is not a hook namespace. Selection is per agent; it takes effect on the next runtime attachment/turn and meaningful changes may rotate the generated cache key once.

`hook.json` requires `name`: a string equal to its lowercase folder name and matching `[a-z][a-z0-9_-]*`; `events`: 1..32 objects with a required event `name`; `command`: a nonempty PATH command or a contained `./` executable. Optional `args` is an array of up to 64 literal strings, default `[]`; `./` arguments resolve inside the folder. Optional `timeout_ms` is an integer 1..30000, default 5000. Unknown fields are invalid. Command and args run without shell expansion from the session cwd, inheriting Raw's environment and OS permissions.

Event `name` is `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` or `SessionEnd`. Tool events alone may add `match`: a bounded canonical tool ID glob using `*` or `?`, and `when:{"any":"schema-bound string path","regex":"RE2 pattern"}`. Both filters must match before spawn. For Bash, `commands[*].command` is the schema path. Example:

```json
{"name":"guard","events":[{"name":"PreToolUse","match":"builtin/bash","when":{"any":"commands[*].command","regex":"(^|[;&|()\\n])\\s*rm(\\s|$)"}}],"command":"node","args":["./index.mjs"],"timeout_ms":5000}
```

`raw.hook/1` sends JSON on stdin with `protocol_version:1`, event, cwd and event payload. The command returns empty stdout or one JSON object. `UserPromptSubmit` and `PreToolUse` are gates: exit 0 plus `{"decision":"continue"}` continues; `{"decision":"deny","reason":"..."}` or exit 2 denies. Other events are notifications; they may return a short `message` but cannot change a completed result. Malformed output, nonzero exit, timeout, spawn error or overflow blocks gates and warns on notifications. A continue result cannot override an existing ask/deny tool rule. `docs/hooks.md` and `create_hook` explain testing, dashboard editing and package sharing.
