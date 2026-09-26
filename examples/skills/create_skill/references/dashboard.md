# Author a skill in the dashboard

Open **Library → Skills** in `raw dashboard`. Search and inspect provenance, used-by agents, validation and files. Create skill starts from a shipped example in a new `local/<folder>`; Fork to local copies an existing builtin or immutable package export. The copy stays unselected.

Edit `SKILL.md` with English frontmatter/description and focused instructions, following the main authoring guide. The name must match the folder after underscores become hyphens. Markdown preview is presentation only. Add text file creates a contained resource such as `references/checklist.md`; each file has its own revision and Save. Save or discard before switching files.

Attach the saved skill to the requested direct agent. The service checks its body against that agent's `max_output_bytes` and adds builtin list/load tools. For a package agent, edit its complete `skills`/`tools` override explicitly in Agent JSON. A stale revision retains your draft for review and reapplication. Builtin and immutable files require a fork; a linked package edits its authored source.

For live verification requested by the user, run the ordinary list/load tools with that agent and inspect the complete result. Catalog validation alone does not prove model skill selection. Saving takes effect on the next turn of the same session, and actual skill instructions append only when loaded. Package the owned skill folder and reference files with **Library → Packages** for sharing.
