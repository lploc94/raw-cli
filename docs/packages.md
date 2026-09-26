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
