# Compose an agent in the dashboard

Use **Agents → Create agent** in `raw dashboard` for the intended config authority. Choose a unique name and an existing model connection from **Settings → Models & connections**. The new agent does not automatically become the default.

1. Select a literal system prompt or Markdown file path. A relative prompt file resolves beside the selected config and is read when the next turn attaches.
2. Add only relevant tools, skills and vars, keeping their requested order. Selecting skills adds the builtin list/load tools. Library shows provenance and current usage; adding or forking an asset is separate from selecting it.
3. Discover MCP in **Library → MCP**, then add exact original tool names. Define ordered allow/ask/deny rules on the agent. Conditional Bash ask rules leave other permitted Bash calls automatic. Test rules checks sample matching without dispatch; schema binding is verified when a runtime starts.
4. Use **Agent JSON** for request/cache/compact/limits and package `{ref, as, inputs}` selections. A package agent retains `{from, model, inputs, overrides}`; selection overrides replace the entire block. Preserve omitted fields and recipient model ownership.
5. Save, then New chat for a requested live check. Explain a missing prerequisite instead of claiming a save proved execution. Set as default is a separate explicit action.

A saved edit affects the next turn and preserves existing conversation IDs. Running work keeps its snapshot. Skill loading still occurs through `list_skills` and `load_skill`; inspecting the catalog does not inject skill bodies. Use **Library → Packages → Export agent** when sharing the completed composition.
