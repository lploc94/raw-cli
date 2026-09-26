# Create a Raw skill

Use when creating or improving reusable instructions that a Raw agent should discover and load. An ordinary Markdown document does not need skill registration; a new callable action belongs in `create_tool`.

For a how-to, explain the format, authoring approach and registration with examples. For a requested creation, use the workflow below. For a load failure, inspect the selected ID, manifest, body size and error before rewriting instructions.

## Establish the useful task

1. Identify the repeated task, expected deliverable, available inputs and tools. Use real examples or corrections from the conversation. Ask only for missing information that changes the result.
2. Choose one coherent responsibility. Describe its boundaries against neighboring skills; avoid both a vague catch-all and many tiny skills needed for a single task.
3. Write the description first: what the user wants, when to use this skill, and a meaningful nearby case that does not need it. The model sees this description in `list_skills` before seeing the body. Describe intent, not just filenames.
4. Write the body and description in English. Spend words on project-specific facts, decisions, working procedures and common errors. Avoid padding and generic explanations.

## Build the instructions

Use these parts where useful; combine short sections rather than filling a rigid form:

- **Purpose/routing:** intended outcome; explanation, action and diagnosis paths if relevant. Put conditions before action steps.
- **Inputs:** information to obtain, defaults, paths and actual tool/dependency availability. Reuse supplied answers and authorization.
- **Procedure:** a default sequence with decisions at the point they matter. Make fragile steps precise; allow judgment for flexible work.
- **Contract/example:** exact formats, supported fields and realistic example. Label complete files versus fragments and their insertion points.
- **Verification/recovery:** observable success, important boundary cases and what to do with a specific failure. Distinguish checks performed from assumptions.
- **Output:** what artifact or answer to deliver and what remaining uncertainty to report.

Keep instructions task-specific: a release-notes skill should not inherit Raw configuration-edit steps. Avoid assumed checkout paths or mandatory external documentation for core behavior.

## Raw package contract

Each skill folder contains strict `skill.json` and UTF-8 `SKILL.md`. Raw does not parse YAML frontmatter as metadata or automatically load supporting resources. The current `load_skill` returns the entire Markdown in one linked result; keep it within the target agent's `max_output_bytes` (8192 bytes by default). Catalog descriptions must collectively fit that cap too.

| Root | Location and use |
| --- | --- |
| `agent/<id>` | `skills/<id>/` beside the selected config; travels with a portable agent |
| `local/<id>` | `$XDG_CONFIG_HOME/raw/skills/<id>/`, otherwise `~/.config/raw/skills/<id>/`; shared local installation |
| `builtin/<id>` | Package-owned; fork a shipped example into a user root to customize |

`--config` changes the config-adjacent root, not the global root. Folder IDs match `[a-z][a-z0-9_-]*`. Manifest has exactly five fields: numeric `api_version: 1`, matching `id`, numeric-three-component `version` string, model-visible `name` matching `[A-Za-z_][A-Za-z0-9_-]{0,63}`, and nonempty `description`. Selected IDs and names must be unique. Duplicate/unknown JSON fields, invalid UTF-8, missing selected files, symlink escapes or oversized content fail before inference; unselected folders are inert.

## Worked example: release notes

For `/work/helper/raw.json`, create `skills/release_notes/skill.json` beside it:

<!-- example:manifest -->
```json
{
  "api_version": 1,
  "id": "release_notes",
  "version": "1.0.0",
  "name": "release_notes",
  "description": "Use when drafting a changelog or release summary from a Git comparison range. Group user-visible changes and cite commits; ordinary code review does not need this skill."
}
```

Create `skills/release_notes/SKILL.md`:

<!-- example:body -->
```markdown
# Draft release notes

Produce release notes from committed changes. A request to explain the process
needs guidance only; a request for a draft uses the workflow below.

## Inputs
Use the supplied version and Git comparison range. If absent, inspect existing
release tags and changelog conventions; ask only when the intended range remains
ambiguous. Do not invent a version or include uncommitted changes silently.

## Workflow
1. Read the existing changelog format and commits in the chosen range.
2. Inspect changed behavior where commit subjects are insufficient. Group items
   as Added, Changed, Fixed and Removed, or use the project's established format.
3. Include user-visible effects and breaking changes. Omit test-only/internal
   refactors unless they alter behavior. Cite a commit hash or PR for each item.
4. Draft the requested artifact; keep existing release entries intact. Publish
   only when the user has authorized publishing, not merely drafting.

## Check and deliver
Verify cited hashes belong to the comparison range and claims match their diffs.
Run existing Markdown checks when available. If the range is empty, report that
fact; if a change is ambiguous, identify it rather than inventing an effect.
Return the draft, comparison range and any unverifiable or omitted changes.
```

The following fragment belongs inside `agents.helper`. Append missing IDs to existing arrays without replacing their contents or order:

<!-- example:registration -->
```json
{
  "tools": { "use": ["builtin/read_file", "builtin/write_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"] },
  "skills": { "use": ["agent/release_notes"] }
}
```

Nonempty `skills.use` requires both skill tools. Do not change `default_agent` just to register a skill. If the agent does not exist, use `create_agent`; otherwise preserve its other fields. For global files, select `local/release_notes` instead.

## Create, verify and improve

1. Establish the actual config/agent and chosen root. Check existing selected names, create both files, and make the smallest registration edit with a backup of existing config. Keep config mode 0600.
2. Run `raw --config /work/helper/raw.json config list` (or `raw config list` for canonical config). This checks config, not skill files.
3. Verify loading without another model call when the `raw-cli` library is available: `loadConfig({configPath, requireModel:false})`, then `loadSelectedSkills({selectedIds: runtime.skillIds, configPath, maxOutputBytes: runtime.maxOutputBytes})`. Or use the configured agent's `list_skills` and `load_skill({name:"release_notes"})` in a suitable run. Confirm the selected name and exact body, not just a successful config parse.
4. Assess content using a normal task, a boundary case and a near miss. For the example: draft from a known range with verifiable citations; handle an empty range; do ordinary code review without treating it as release-note generation. Review outputs and tool traces for incorrect advice or missing steps. Extra model work is diagnostic.
5. Improve instructions around evidenced errors. Compare versions on the same inputs/model when useful; record which version produced the result. A mock list/load test proves wiring, not writing quality, and no model test guarantees every future action.

The first request contains no catalog/body; list/load appends them at the tail. Editing a selected skill on resume advances revision but keeps Raw's generated cache key; previously visible content may get a reload notice. The agent must list/load again. If a body is too large, remove redundancy before deliberately changing the agent's cap.

Report paths, registration, checks and prerequisites.

For dynamic data, teach list_vars/read_var and freshness checks; select names in agent.vars and the tools in tools.use. Never bake current time or credentials into a skill. Pass use-only references via consuming tools.
