# Skills

A profile may select skills with `"skills": {"use": ["local/review", "agent/project"]}`. The list defaults to empty. `local/<id>` resolves under `$XDG_CONFIG_HOME/raw/skills/` or `~/.config/raw/skills/`; `agent/<id>` resolves under `skills/` beside the selected config file. Raw reads only selected folders. Each folder contains a strict `skill.json` manifest and UTF-8 `SKILL.md`:

```json
{"api_version":1,"id":"review","version":"1.0.0","name":"review","description":"Review a change"}
```

The folder ID and manifest ID must match. Selected names and IDs must be unique. Symlinks cannot escape the selected root or skill folder. Invalid or oversized selected content fails before an inference request; unrelated folders remain unread.

A profile with a nonempty `skills.use` must explicitly include both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. The generic tool definitions contain no profile-specific skill names or Markdown. The first model request sees no catalog. Calling `list_skills` returns only the selected names and descriptions in a linked tool result. Calling `load_skill` with one selected name returns the exact `SKILL.md` text in a linked tool result at the end of the conversation. Both results must fit the profile's `max_output_bytes` without truncation. Denied, cancelled, unknown, invalid, or oversized loads do not reveal partial Markdown.

Copying a config file with its adjacent `skills/` directory preserves config-local skill references. The recipient can provide their own model credentials. Skills are instructions read by the agent when it chooses to call the tools; Raw does not add them to the system prompt.

Raw snapshots selected skill metadata and Markdown for a live session. On resume, a changed selected skill updates the context revision but keeps Raw's generated cache key because the earlier provider prefix remains historical. If the model previously saw affected `list_skills` metadata or `load_skill` Markdown, one durable tail notice names stale skills and asks it to list or load again; the old linked result is not rewritten. If compaction removes a loaded skill result, a tail reminder asks for another `load_skill` call. Reload remains an agent action, not automatic prompt injection. An explicit OpenAI `profile.cache.key` overrides the generated wire hint.
