# Create a Raw skill

Use when the user asks for reusable instructions that an agent can discover and load during a run. First inspect the target agent's config, available tools, and existing selected skill names. A skill is an instruction package, not executable code and not a new tool. Write instructions that are specific enough to accomplish the requested work: inputs, decision rules, paths, exact edits, verification, common failures, and a working example. Avoid a one-paragraph reminder. Keep the body under that agent's `max_output_bytes` (8192 by default), because `load_skill` returns it as one linked result without truncation.

## Choose a root and identity

`local/<id>` lives in `$XDG_CONFIG_HOME/raw/skills/<id>/`, or `~/.config/raw/skills/<id>/` when XDG_CONFIG_HOME is unset. It is available to any config using that global root, but still invisible until selected. `agent/<id>` lives in `skills/<id>/` beside the selected config file and travels with a shareable agent directory. `builtin/<id>` is installed package-owned content; users should fork a packaged example to `local/` or `agent/` before editing. `--config` changes the agent root but not the global root. IDs begin with lowercase a–z and continue with lowercase letters, digits, `_` or `-`; names must start with a letter or `_`, use at most 64 letters/digits/`_`/`-`, and be unique across the agent's selected skills. Pick a stable ID and a distinct model-visible name.

Each folder must contain a strict JSON `skill.json` and UTF-8 `SKILL.md`. Manifest fields are exactly `api_version: 1` (number), `id` (same as folder), `version` (`major.minor.patch` string), `name` (model-visible name), and `description` (nonempty selection hint). Unknown/duplicate fields, invalid UTF-8, symlink escapes, oversized manifest or Markdown, duplicate selected IDs/names, and a selected missing folder fail before inference. Unselected folders are inert. A useful description says *when* to load the skill, not simply that it exists.

## Complete minimal example

For a portable config at `/work/helper/raw.json`, create `/work/helper/skills/release_notes/skill.json`:

```json
{
  "api_version": 1,
  "id": "release_notes",
  "version": "1.0.0",
  "name": "release_notes",
  "description": "Prepare release notes from committed changes when the user requests a changelog or release summary."
}
```

Create `/work/helper/skills/release_notes/SKILL.md` with real instructions. For example:

```markdown
# Prepare release notes

When asked for release notes, ask for the target version and comparison range only if neither is available from the request or repository tags. Read the existing changelog format and commits in that range. Group user-visible changes as Added, Changed, Fixed, and Removed; skip test-only and refactor-only commits unless they alter behavior. For each item, cite a commit hash or PR identifier from the local history. Check renamed files and breaking config changes against README and migration notes. Draft the release notes in the repository's existing format, ask for approval only if publishing externally, and run the project's Markdown/link checks. Report omitted ambiguous commits and any unverifiable claim.
```

Register the exact ID in the chosen agent entry in `raw.json`; the JSON fragment below belongs inside `agents.helper` (other agent fields remain as they were):

```json
{
  "tools": { "use": ["builtin/read_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"] },
  "skills": { "use": ["agent/release_notes"] }
}
```

Keep any existing selected tools and skills that the user still needs. A nonempty `skills.use` requires **both** skill tools in `tools.use`. Use `local/release_notes` instead when the files are in the global root. Do not change `default_agent` merely to add a skill. For a new standalone config, also define `models`, the `agents.helper.model` alias, and optionally `default_agent`; use the `create_agent` skill if that setup is missing.

## Verify the real path

1. Back up the config and preserve mode 0600. Read the actual target agent and calculate the config-adjacent or global path before writing. Create both files as UTF-8, with the manifest ID matching the folder and a body beneath the output cap.
2. Make the smallest JSON edit to `agents.<name>.skills.use` and `tools.use`. Reject duplicates and check the selected name does not clash with another skill.
3. Run `raw --config /work/helper/raw.json config list` for portable config (or `raw config list` for global config). Then run a harmless task with that agent and have it call `list_skills`; verify the catalog contains `release_notes` only when selected. Have it call `load_skill` with `{ "name": "release_notes" }`; verify the exact Markdown arrives as a linked tool result. A local library test may call `loadSelectedSkills` with the same config path to avoid provider traffic.
4. Confirm the initial provider request has only generic `list_skills`/`load_skill` tool schemas, not the skill catalog/body. On resume, editing a selected skill advances the context revision without rotating Raw's generated cache key; if previously visible metadata/body is stale, Raw appends a reload notice at the tail. The agent should list/load again. An explicit provider cache key retains its own precedence.

If `config list` succeeds but the skill cannot load, check the selected ID, root relative to the config, UTF-8, symlink containment, output cap, and skill-tool selection. An unselected invalid folder is irrelevant. If a body is too large, tighten the instructions or raise that agent's `max_output_bytes` deliberately; never rely on silent truncation. Do not add secret values to skill Markdown or publish a copied agent directory containing credentials.
