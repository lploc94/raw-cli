---
name: create-hook
description: "Use when creating, editing, testing, selecting or sharing a Raw agent hook for session, turn or tool events. Covers raw.hook/1, gating, notifications, dashboard editing and packages."
---
# Create a Raw hook

A hook is a folder containing `hook.json` and an executable script. It belongs to one selected agent, not to every Raw session. Hooks run with the user's OS permissions. Create one only when the user wants an event-triggered action; tool policy rules remain the right place for simple allow/ask/deny matching.

Read `references/packages.md` for sharing and `references/dashboard.md` for browser editing, using `read_file` when relevant. The installed `docs/hooks.md` is the full protocol reference. Do not claim that `raw.hook/1` implements another product's hook protocol.

## Choose placement and event

Use `~/.config/raw/hooks/NAME/` with ID `local/NAME`, or `hooks/NAME/` beside the selected config with ID `agent/NAME`. The folder name and manifest `name` must match, using lowercase letters, digits, `_` or `-`, starting with a letter. The agent selects an ordered unique list: `"hooks":{"use":["agent/guard"]}`. No hook runs when the list is absent or empty. A package hook uses `pkg/ALIAS/hooks/EXPORT`.

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionEnd`. Use `UserPromptSubmit` or `PreToolUse` to deny an action. Other events are notifications; they cannot change a completed result. `SessionStart` also fires on resume; `SessionEnd` means the current attachment closed. Post-tool events require an actual handler invocation; policy/approval denials do not fire them.

## Manifest and script

`hook.json` requires `name` (string), `events` (nonempty array), and `command` (nonempty PATH command or a contained `./` executable). Optional `args` is a string array; `./` args resolve inside the hook folder. Optional `timeout_ms` is an integer 1..30000, default 5000. Each event entry requires `name`; tool events may add `match` (canonical tool-ID glob with `*` and `?`) and `when:{"any":"schema.path[*].field","regex":"RE2 pattern"}`. Both filters must match before Raw spawns the script. `when` must identify a string field in the selected tool's input schema; `commands[*].command` is valid for `builtin/bash`. `match`/`when` on non-tool events are invalid. Unknown fields are invalid. No shell expansion occurs in command or args.

<!-- example:manifest -->
```json
{"name":"guard","events":[{"name":"PreToolUse","match":"builtin/bash","when":{"any":"commands[*].command","regex":"(^|[;&|()\\n])\\s*rm(\\s|$)"}},{"name":"PostToolUseFailure","match":"builtin/bash"}],"command":"node","args":["./index.mjs"],"timeout_ms":5000}
```

Raw sends one UTF-8 JSON object on stdin with `protocol_version:1`, `event`, `cwd`, optional agent/session/turn IDs and event payload. A tool event has `tool.identity`, `tool.name`, `tool.arguments`, and a post-event may have `tool.result`. Respond with empty stdout or one JSON object. Exit 0 plus `{"decision":"continue"}` continues; `{"decision":"deny","reason":"..."}` or exit 2 denies a gate. A short `message` appears in host output. Malformed output, timeout, nonzero exit, spawn failure or overflow blocks a gate and warns on a notification. A continue decision cannot override `tools.rules` ask/deny. Raw records a bounded receipt; it does not log raw stdin/stdout by default. Selected folders are snapshotted (at most 256 regular files and 16 MiB total; links are rejected).

<!-- example:script -->
```js
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.event === "PreToolUse") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: "Review removal commands first" }));
  } else {
    process.stdout.write(JSON.stringify({ message: "Bash command failed" }));
  }
});
```

For notification-only behavior, select `PostToolUse`, `Stop` or `SessionEnd` and return an optional `message`. Keep side effects idempotent because a later user operation may invoke the hook again. Do not print incidental text to stdout; write diagnostics to stderr within the output limit.

## Attach and verify

1. Create the folder and files. Add the exact ID to `agents.NAME.hooks.use` while preserving other config and selection order. Keep the config file mode 0600. `raw --config PATH config list` checks config structure; it does not run a hook.
2. In dashboard, use Library → Hooks to create, edit and validate the folder, then attach it to an agent. Save with the current revision. Inspect the event, matcher, command, args and timeout before activating. Browsing and installing are passive.
3. Test a harmless matching and nonmatching call using the selected agent; inspect hook receipts in CLI or dashboard history. Check a gate denial, a notification, and a resume if the hook handles `SessionStart`. A changed hook selection takes effect on the next attach/turn; meaningful changes may rotate cache keys once.
4. For distribution, export the agent or declare a `hooks` export in `raw-package.json`; pack/install/bind in an isolated recipient config, remove author paths, then test the selected hook. Report executable prerequisites such as `node` or `python3`.

Never assume a hook is sandboxed or that exit-0 approval bypasses policy. Preserve unrelated agents and selected components.
