# Skills

An agent may select skills with `"skills": {"use": ["builtin/configure_raw", "local/review", "agent/project"]}`. The list defaults to empty. `builtin/<id>` resolves from the installed Raw package, independently of the checkout and config path. `local/<id>` resolves under `$XDG_CONFIG_HOME/raw/skills/` or `~/.config/raw/skills/`; `agent/<id>` resolves under `skills/` beside the selected config file. Raw reads only selected folders. Each folder contains a UTF-8 `SKILL.md` with Agent Skills YAML frontmatter:

```markdown
---
name: review
description: Review a code change for correctness. Use when asked for a review.
---
# Review
Inspect the changed behavior and report actionable findings.
```

The frontmatter name matches the skill folder (portable folders use lowercase kebab-case). Selected names and IDs must be unique. Symlinks cannot escape the selected root or skill folder. Invalid or oversized selected content fails before an inference request; unrelated folders remain unread. Raw ships six built-in setup skills, including `builtin/configure_raw`; their stable selection IDs retain underscores, while catalog names use kebab-case. `examples/skills/<id>/` holds forkable copies. Copy one to `local/my-config-guide/`, change its frontmatter name to `my-config-guide`, then select `local/my-config-guide`.

An agent with a nonempty `skills.use` must explicitly include both `builtin/list_skills` and `builtin/load_skill` in `tools.use`. The generic tool definitions contain no agent-specific skill names or Markdown. The first model request sees no catalog. Calling `list_skills` returns only selected names and descriptions in a linked tool result. Calling `load_skill` with one selected name returns the Markdown body after frontmatter at the conversation tail. Body and catalog must fit `max_output_bytes` without truncation. Denied, cancelled, unknown, invalid, or oversized loads do not reveal partial Markdown.

Copying a config file with its adjacent `skills/` directory preserves config-local skill references. The recipient can provide their own model credentials. Skills are instructions read by the agent when it chooses to call the tools; Raw does not add them to the system prompt.
The packaged `examples/agents/project-helper/` demonstrates a portable
`agent/project` skill. Edit its `skills/project/SKILL.md` in the copied folder;
the next run loads those bytes. Changing a selected skill in a resumed session
may cause Raw to append a reload notice as described below.

The built-in setup kit contains six selectable skills: `configure_raw` for config fields and safe edits, `create_skill` for a new selected skill, `create_tool` for a standalone plugin, `create_agent` for a named agent, `add_mcp` for registering one exact MCP tool, and `create_package` for exporting or assembling a shareable package. All use the `builtin/` prefix. Their package-owned copies live under `dist/skills/builtin/`; `examples/skills/` contains forkable copies. Select only the guidance an agent should offer, then call `list_skills` and load the relevant body on demand.

`create_package` covers manifest fields, owned assets, typed recipient inputs, validation/packing, isolated installation checks and update/link/fork workflows. New `raw config init` configurations select it automatically. To enable it in an existing agent, append `builtin/create_package` to that agent's `skills.use`; its catalog/load name is `create-package`.

Setup skill bodies and descriptions are written in English. Their instructions distinguish explanation, requested changes and diagnosis: a generic how-to should be answered from the loaded guidance, without reading personal configuration or creating test artifacts. For an actual edit, inspect the relevant fields, preserve unrelated settings, and validate the relevant result. These instructions guide model decisions; they do not enforce a fixed tool sequence or number of actions.

Raw snapshots selected skill metadata and Markdown for a live session. On resume, a changed selected skill updates the context revision but keeps Raw's generated cache key because the earlier provider prefix remains historical. If the model previously saw affected `list_skills` metadata or `load_skill` Markdown, one durable tail notice names stale skills and asks it to list or load again; the old linked result is not rewritten. If compaction removes a loaded skill result, a tail reminder asks for another `load_skill` call. Reload remains an agent action, not automatic prompt injection. An explicit OpenAI `agent.cache.key` overrides the generated wire hint.

For structure, examples and review criteria, see the [skill authoring cheatsheet](skill-authoring.md). The guide and all six English setup skills ship with Raw. Contract tests execute their examples; model traces are diagnostic and do not enforce a fixed amount of work.
