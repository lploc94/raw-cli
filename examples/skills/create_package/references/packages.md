# Recipient installation, verification and updates

Use this reference after creating source or when preparing handoff instructions. `package` and `agent add` commands take `--config PATH` after the command noun. Use the same config path throughout: installations are recorded in `<config-path>.packages.lock.json`.

## Install and bind a complete agent

For the example in `SKILL.md`, write `inputs.json` containing `{"project_label":"My project"}`. Replace `CONFIG` with the recipient config path and `LOCAL_MODEL` with an alias already present in its `models` object:

```sh
raw package inspect ./project-kit-1.0.0.rawpkg
raw package install ./project-kit-1.0.0.rawpkg --as project-kit --config CONFIG
raw agent add project-helper --from pkg/project-kit/agents/helper --model LOCAL_MODEL --inputs ./inputs.json --config CONFIG
raw --config CONFIG --agent project-helper "What project am I working on?"
```

Omit `--inputs` when the selected export needs none. `agent add` creates a new name and refuses to overwrite an existing agent; it validates the selected binding and writes it into the ordinary config. It does not change `default_agent`. The installed package remains unchanged. A binding looks like:

```json
{
  "from": "pkg/project-kit/agents/helper",
  "model": "local",
  "inputs": {"project_label": "My project"},
  "overrides": {"max_steps": 30}
}
```

Place it at `agents.project-helper`. Overrides replace the specified field/block: `tools`, `skills`, `hooks`, `vars`, `request`, `compact` and rule lists do not implicitly merge with package values. Preserve unrelated agents and the existing default.

## Select individual components

A direct agent can add `pkg/kit/tools/EXPORT` to `tools.use`, `pkg/kit/skills/EXPORT` to `skills.use`, or `pkg/kit/hooks/EXPORT` to `hooks.use`. A skill selection also needs both skill tools. Hook selections are exact strings; they do not accept visible aliases or inputs. For a tool visible-name collision, use `{"ref":"pkg/kit/tools/EXPORT","as":"distinct_name","inputs":{}}`; choose the corresponding skill name format when selecting a skill.

Root entries bind one definition:

```json
{
  "vars": {
    "project": {"from": "pkg/project-kit/vars/project_label", "inputs": {"project_label": "My project"}}
  }
}
```

Merge this fragment into the recipient config, then select `"vars":["project"]` on the intended direct agent. `var_providers.NAME` and `mcp.servers.NAME` use the same `from`/`inputs` binding shape with their export category. Select exact `mcp/LOCAL_SERVER/ORIGINAL_TOOL` IDs to expose a bound MCP server's tools. A provider binding alone does not define or select a var that calls it. Installing an alias alone exposes no components.

## Verify at the right level

For a package artifact request, use a temporary recipient directory with its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and config. These keep the lock, artifact store and any smoke-session state out of the author's environment. Pass `--config` explicitly to installation and binding commands. Do not edit the author's default agent just to test distribution.

Copy the archive into that directory and test without relying on source paths. Use real recipient input values for available fixtures; a model alias may be a local fixture for data-only activation. Packing, inspection, installation and `agent add` neither call the model nor execute plugin/provider/MCP code.

Check only the relevant capabilities:

- **Artifact and binding:** inspect the archive, install it, add the selected agent or component binding and run `raw --config CONFIG config list`. This proves structural acceptance, not live tool behavior.
- **Prompt/tools/skills:** when the SDK is importable, use `loadConfig({configPath,flags:{agent:"project-helper"},requireModel:false})` and `createRuntimeTools({runtime,cwd})`. Dispatch a harmless selected tool; for a skill, call `list_skills` then `load_skill` with the returned name. Close `tools.mcp` afterward. This stage can execute selected code/connect MCP.
- **Vars/provider:** `raw --config CONFIG --agent AGENT vars list`, then `vars get NAME` for a readable var. A provider-backed read executes that provider; inspect its prerequisites first.
- **MCP:** discovery and a harmless selected call verify the available server. A parsed config or successful install alone does not prove a connection works.
- **Model task:** run one appropriate harmless request only when available model access and the user's requested verification justify it. Do not recursively start another model merely to answer a how-to question.

Fix concrete packaging failures and rerun the failed stage. If an external executable, remote service or model is unavailable, report the missing prerequisite and checks completed. Do not claim end-to-end execution from archive validation alone. Report the archive path, package name/version/digest, exported names, input example, exact recipient commands and remaining prerequisites.

## Releases, local editing and removal

```sh
raw package list --config CONFIG
raw package update project-kit --from ./project-kit-1.1.0.rawpkg --config CONFIG
raw package fork project-kit --out ./project-kit-edit --config CONFIG
raw package link ./project-kit-edit --as project-dev --config CONFIG
```

Reinstalling identical bytes under the same alias is idempotent. Replacing a different digest uses `update`, which checks affected bindings before changing the alias. Keep the previous archive to roll back with the same update command. A new required input can require editing the affected binding before updating; a release label alone is not a compatibility gate.

`fork` creates editable source. `link` registers source under a development alias; point the intended agent/component binding to that alias to use it. A linked source edit affects the next run/resume attachment, while an already running runtime retains its snapshot. Repack source for distribution instead of editing the extracted installed store.

Existing conversations retain their session IDs after package changes. Meaningful prompt/schema/helper changes rotate generated cache keys once; selected skill changes may append a tail reload notice. Subsequent unchanged resumes stabilize. Never require clearing or migrating sessions merely to install or update a package.

`raw package remove ALIAS --config CONFIG` refuses if selected config bindings still depend on the alias and names them. Remove or replace those bindings deliberately before removing an unused alias. This command does not recursively erase the user's config or conversation history.
