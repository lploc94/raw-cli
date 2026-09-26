# Portable package contract (v1)

A Raw package is a directory with `raw-package.json`. A distributable `.rawpkg` is a ZIP of that directory and its declared files. The manifest is data: inspecting or validating it must not import a tool, execute a variable provider, connect to MCP, open a session database, or obtain model credentials. The package format version is `schema_version: 1`; it is independent of the Raw release, session storage format, tool API, and package release version.

```json
{
  "schema_version": 1,
  "name": "@example/research-kit",
  "version": "1.0.0",
  "description": "A reusable research agent and its components",
  "files": ["agents/researcher.json", "prompts/researcher.md", "skills/review", "tools/search", "vars/location.json", "var_providers/weather.json", "mcp/search.json"],
  "exports": {
    "agents": {"researcher": "agents/researcher.json"},
    "skills": {"review": "skills/review"},
    "tools": {"search": "tools/search"},
    "vars": {"location": "vars/location.json"},
    "var_providers": {"weather": "var_providers/weather.json"},
    "mcp": {"search": "mcp/search.json"}
  },
  "inputs": {"type": "object", "properties": {"region": {"type": "string", "default": "Hanoi"}}, "required": []},
  "requires": ["raw.tool-api/1"],
  "dependencies": {}
}
```

`name` is a scoped package name (`@owner/name`), and `version` is a valid SemVer release label. Every export name is unique within its category and points to a package-owned file or directory covered by `files`. Agent definitions are JSON objects using Raw agent fields without a publisher model alias; the recipient binds a model. Prompt files and all helper/resource files belong to the declared file closure. Each var/provider/MCP export file contains one definition. Unknown optional `metadata` fields have no runtime meaning. A selected component fails only when a declared required host capability is unavailable; a release label by itself is never a compatibility gate.

Inside package definitions, `#tools/search` refers to the current package; `dep:geo#vars/location` refers to an exact dependency under alias `geo`. A local config selects an installed export using `pkg/research-kit/tools/search`. Tool/skill selection can use `{"ref":"pkg/research-kit/tools/search","as":"web_search"}` to disambiguate model-visible names. An alias affects presentation; policy still checks the resolved canonical identity. Bare `builtin/`, `local/`, `agent/` and `mcp/` IDs retain their existing meanings. Package aliases, absolute install paths and package versions are never model-visible names or behavioral fingerprints.

`dependencies` maps an alias to `{name,version,digest,archive}` with an exact package archive included in `files`; v1 does not fetch dependencies or solve version ranges. Dependency aliases are scoped to their owning package. Repeated names at different versions may coexist. Cycles, missing archives, digest mismatches and escaping paths are errors before installation. `requires` is a list of exact host capability IDs; application release metadata is advisory.

`inputs` is a bounded object schema with `properties`, optional `required`, per-property `type`, `enum`, `default`, and optional `x-raw-kind` (`file`, `directory`, `env-name`, `var-source`). Cross-property conditionals are unsupported. A package can be installed without inputs; inputs used by a selected export must validate at activation. A dependency reference supplies its own explicit `inputs` map in the caller's scope. Paths supplied as inputs resolve relative to the recipient config directory. Input values never come implicitly from another package or a resolved runtime variable.

Only a whole value at an approved definition site may be `{"$input":"name"}`: agent settings, var source/params, provider command arguments/cwd, and MCP endpoint/headers/env/arguments. Raw does not template substrings, Markdown, JavaScript or shell code. `env-name` names a recipient environment variable; it is read only by the runtime site that consumes it. `var-source` is a structured Raw source definition, not the value it may later return.

An ordinary config may bind an installed agent:

```json
{"agents":{"researcher":{"from":"pkg/research-kit/agents/researcher","model":"deepseek","inputs":{"region":"Hanoi"},"overrides":{"max_steps":30}}}}
```

Overrides are explicit replacements. Scalar fields replace their package values; `tools`, `skills`, `vars`, `request`, `compact` and rules replace the whole corresponding block or list. Missing blocks inherit. A direct agent may select package tools and skills without adopting a package agent. Root vars, providers and MCP entries may bind exported definitions. Installing a package does not alter `default_agent` or expose anything to an agent until that agent selects it.

A skill is a directory containing `SKILL.md` with Agent Skills YAML frontmatter (`name`, `description`) and optional `scripts/`, `references/` and `assets/`. Frontmatter is the sole authoritative catalog metadata; `skill.json` is not part of this contract. `builtin/<id>` preserves Raw's existing setup-skill IDs even when a portable skill directory/name uses kebab-case. Raw's `list_skills` and `load_skill` remain explicit, tail-only model tools. File layout portability does not imply that host-specific instructions are executable on every machine.

The future package commands use these same definitions for inspect, validate, export, pack, install and agent binding. This document defines the contract independently of a hosted marketplace; v1 transport is a local folder or a downloaded `.rawpkg` file.

## Source, artifact and recipient

An authored folder is editable source. `package export --agent NAME --out DIR` creates such a folder from the selected agent and reports included components, recipient inputs, external executable requirements and unresolved assets. It does not read runtime var values, import tool handlers, execute providers, connect to MCP, call a model or open session state. A prompt file, selected tool helper closure and selected skill directory are copied as owned assets. Config-relative external paths, environment names and remote service settings become typed recipient inputs unless the author explicitly includes a file as a package asset. An unresolved asset prevents a distributable validation; a draft report identifies it.

The library export options `includeLiterals: true` and `includeFiles: ["relative/or/absolute/path"]` are explicit author choices. Without them, literal variable sources and file/provider/MCP paths become required recipient inputs. With them, selected authored values or file bytes are included in the package and listed in `files`. A report contains the source agent name, package name/version, exported names by category, covered files, required input names, host capabilities and external executables. The export rewrites exact local tool policy identities to the package component identity; wildcard policies require a separate review when adapting them for recipients.

`package validate PATH` checks a source folder or `.rawpkg` without running its code. `package inspect PATH` returns a data-only component/input/prerequisite report. `package pack DIR --out FILE.rawpkg` validates, then writes files in sorted order with normalized timestamps and a SHA-256 inventory. Packing identical bytes and executable modes yields identical archive bytes regardless of source mtimes or caller cwd. The archive contains `raw-package.json`, every declared file and its integrity inventory; arbitrary undeclared files do not appear.

V1 archives have explicit bounds: at most 4096 entries, 16 MiB per file, 128 MiB total expanded bytes and 16 path segments. ZIP traversal, absolute/backslash paths, links, duplicate or case-conflicting paths, corrupt data, missing inventory and digest mismatches fail before extraction or installation. These are packaging limits, not limits on a skill's runtime behavior. A recipient installs the artifact and binds required inputs/model independently; neither the author's session store nor their absolute config path is part of the artifact. GitHub Releases may host `.rawpkg` downloads, but Raw v1 does not fetch them automatically.

## Local installation and development

The per-config installation authority is `<config-path>.packages.lock.json`. It records install aliases, exact artifact digests, source origin, package name/version and exact dependency digests. Immutable extracted artifacts live under `$XDG_DATA_HOME/raw/packages/sha256/<digest>/` (or `~/.local/share/raw/packages/sha256/`). A writer stages and validates artifacts first, then atomically replaces the lock. Old artifacts may remain for rollback or a running agent; an interrupted writer cannot expose a partially extracted artifact through a committed alias. Package operations never open the session database or change `default_agent`.

`package install PATH --as ALIAS` accepts a source directory or `.rawpkg`. Reinstalling the same digest under the same alias is idempotent; a different digest needs `package update ALIAS --from PATH`. Exact nested dependency archives are published under their own digests and can coexist at different versions. `package remove ALIAS` refuses while an agent binding refers to it and names those dependents. Removing an alias does not recursively delete a user's config, a running runtime or referenced artifacts. To roll back, update from the prior artifact file or repackage the prior source.

`package link DIR --as ALIAS` registers editable source. Each new runtime snapshots its declared file closure into immutable bytes; editing the linked folder affects the next attach, never a tool helper imported later by an already-created runtime. `package fork ALIAS --out DIR` copies an editable source tree from a validated installed artifact; subsequent edits/repack do not mutate that artifact. Installing a package does not install npm, Python or system dependencies, run install hooks, launch providers or connect to MCP. External executable requirements remain explicit. Users may download a `.rawpkg` from GitHub Releases and pass its local path to install; Raw v1 has no automatic Git transport.

## Commands and activation

Package commands run without a model credential or session database. `raw package validate PATH` and `raw package inspect PATH` read source data only. `raw package pack DIR --out FILE.rawpkg` creates an archive; `raw package export --agent NAME --name @owner/name --version 1.0.0 --out DIR` exports the selected agent. A recipient uses `raw package install PATH --as ALIAS`, `raw package list`, `raw package update ALIAS --from PATH`, `raw package link DIR --as ALIAS`, `raw package fork ALIAS --out DIR`, and `raw package remove ALIAS`. `--config PATH` selects the installation authority for these commands.

`raw agent add NAME --from pkg/ALIAS/agents/EXPORT --model MODEL_ALIAS [--inputs FILE]` writes one local agent binding to the selected config. The model alias and input values stay in the recipient's config; the package remains data and assets. A direct agent may select installed components with `pkg/ALIAS/tools/EXPORT` and `pkg/ALIAS/skills/EXPORT`, optionally as `{"ref":"...","as":"visible_name","inputs":{}}`. Root `vars`, `var_providers` and `mcp.servers` entries can bind one exported definition with `{"from":"pkg/ALIAS/KIND/EXPORT","inputs":{}}`.

The effective agent is resolved on each new runtime attach, including resume. A package update or linked source edit changes the next runtime snapshot, while a running agent keeps its existing snapshot. A release-label-only change does not rotate a generated cache key; an effective prompt, schema or helper change does, once. An unchanged subsequent resume is stable. Missing currently selected exports or required inputs fail with a component-specific error; unrelated installed packages and unselected exports stay inert.

## Author and recipient cheatsheet

The shipped `builtin/create_package` skill guides package creation and sharing. Its catalog name is `create-package`; new `raw config init` agents select it alongside the other setup skills. Existing agents can append its selection ID to `skills.use` and use `list_skills`/`load_skill` to read the workflow and manifest/recipient references.

The shipped `examples/packages/mixed-kit/` is an editable source package with a prompt, helper-backed tool, resource-bearing skill, lazy variable/provider, MCP definition and conditional Bash policy. Its manifest declares every owned file. `examples/packages/tool-only/` and `examples/packages/skill-only/` show exports that an existing direct agent can select without adopting a package agent.

1. Author a folder with `raw-package.json` and all declared files; run `raw package validate DIR` and inspect the reported exports, inputs and executable prerequisites. Or start from a configured agent with `raw package export --agent NAME --name @owner/name --version 1.0.0 --out DIR`.
2. Run `raw package pack DIR --out FILE.rawpkg` and publish or send that file through an ordinary file channel. Raw v1 does not fetch it from GitHub automatically.
3. On the recipient, run `raw package install FILE.rawpkg --as kit --config CONFIG`. Add an agent with `raw agent add NAME --from pkg/kit/agents/EXPORT --model LOCAL_MODEL --inputs INPUTS.json --config CONFIG`, or add selected `pkg/kit/tools/EXPORT`/`pkg/kit/skills/EXPORT` IDs to an existing agent.
4. Run the agent normally. Edit a local binding or use `raw package update kit --from NEW.rawpkg --config CONFIG` to change the next attach. Resume the same conversation ID; only meaningful runtime changes rotate Raw's generated key, and the next unchanged turn is stable. For rollback, update from the previous archive. For development, `package fork kit --out DIR` then `package link DIR --as dev` under a new alias; edits appear in the next snapshot.

`<config-path>.packages.lock.json` records the alias and exact artifact/dependency digests, while the ordinary config owns the agent instance, model alias, input values, selected components and rules. Back up the local binding before editing it. Do not copy an author's session database or absolute config paths into the package. The artifact itself carries no current var readings or model credentials. A missing required component/input is a concrete activation error; a mere release-version difference is not.

A future catalog or marketplace can index package name, version, digest, description and download location. The `.rawpkg` archive remains the portable artifact; the local lock and recipient config remain the installation and instance authorities. Adding a transport must verify the downloaded archive's digest and use the same data-only validation and atomic install path. V1 has no hosted catalog, account, signature trust framework, automatic Git transport or version-range solver.

## Browser workflows

`raw dashboard` exposes the same package services in **Library → Packages**.
Inspect a local source path or upload an archive, review its report and typed input
schema, then install under an explicit alias. Installation does not change the
default agent. Use agent binds a recipient model/inputs; Add component makes an
explicit selection or root binding. Agent selection overrides remain replacements.

Export agent uses `exportAgentPackage` and `packPackage`. Its include-literals
checkbox maps to `includeLiterals`; one explicitly chosen external file per line
maps to `includeFiles`. Leaving these off preserves recipient input decisions.
Downloads and subsequent installation use the normal `.rawpkg` format. Browser
update/link/fork/remove retain the CLI lifecycle and session-continuity semantics.
See [the dashboard guide](dashboard.md#share-portable-packages) for the workflow.
