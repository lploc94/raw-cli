# Manifest, component files and inputs

Use this reference when authoring or repairing package source. The installed `docs/packages.md` and `schemas/raw-package.schema.json` describe the full contract. A `.rawpkg` is a ZIP of `raw-package.json`, its declared files and an integrity inventory produced by `raw package pack`.

## Manifest fields

| Field | Type and meaning |
| --- | --- |
| `schema_version` | Integer `1`; package format, independent of Raw release and session storage |
| `name` | Scoped string `@owner/name` |
| `version` | SemVer string, e.g. `1.0.0`; identifies a release, not runtime compatibility by itself |
| `description` | Nonempty string describing the package |
| `files` | Array of explicit package-relative file/directory paths; include all owned resources |
| `exports` | Object with one or more categories below; each maps an export name to a declared path |
| `inputs` | Optional bounded object schema described below |
| `requires` | Optional array of required host capability IDs; declare capabilities the selected components need |
| `dependencies` | Optional map from alias to an exact bundled dependency archive |
| `metadata` | Optional descriptive object; not runtime settings; `external_executables` can list prerequisites |

Names/paths are case-sensitive in the contract. Use lowercase portable names and relative `/` paths. `files` lists paths, not glob patterns. An included directory covers its descendants. Links, traversal, absolute paths, duplicate/case-conflicting archive paths and undeclared assets are rejected. Keep every relative JavaScript helper import, skill reference, prompt and script inside the declared file closure.

| Export category | Target and content |
| --- | --- |
| `agents` | JSON file with Raw agent settings, without a publisher `model` alias; use either `system_prompt` or owned `system_prompt_file` |
| `tools` | Directory with `tool.json`, `index.mjs` and owned helpers/resources; same current tool API |
| `skills` | Directory with `SKILL.md`, YAML `name`/`description` and optional resources; name matches its portable folder |
| `hooks` | Directory with `hook.json` and owned command/argument assets; declare `raw.hook/2` in `requires` |
| `vars` | JSON file containing one Raw var definition (`description`, `access`, `source`, optional type/settings) |
| `var_providers` | JSON file containing one executable provider definition; include its script as an owned file |
| `mcp` | JSON file containing one Raw MCP server definition; include owned stdio scripts |

The installed examples demonstrate `raw.agent/1`, `raw.tool-api/2`, `raw.skill/1`, `raw.hook/2`, `raw.var-provider/1` and `raw.mcp/1`. A builtin selection relies on the recipient Raw installation; it does not copy builtin implementation bytes into the package.

## References and policy

- Inside a package: `#tools/search`, `#skills/review`, `#hooks/guard`, `#vars/region`; use the category expected by the containing field.
- Exact dependency: `dep:geo#tools/lookup`. `dependencies.geo` is `{name,version,digest,archive}`; `archive` is a declared path to a bundled `.rawpkg`, and `digest` is its SHA-256. No range solver or automatic downloads. Use the digest from packing the dependency.
- Recipient config: `pkg/kit/tools/search`, with `kit` the installed alias. A tool/skill selection may be `{"ref":"pkg/kit/tools/search","as":"web_search","inputs":{}}`.
- Canonical tool policy: `@owner/name#tools/search`; package MCP policy: `@owner/name#mcp/server/original_tool`. Install aliases, release versions and visible `as` names do not change policy identity.

Agent `tools.use`, `skills.use` and `hooks.use` stay ordered explicit selections. Selected skills need both `builtin/list_skills` and `builtin/load_skill`. Hook selections are exact strings, without `as` or `inputs`; package hook manifests and contained script assets validate passively. Preserve selective Bash rules, such as asking for matching `rm` commands; do not replace them with an ask rule for every Bash call. For a wildcard policy, inspect what it will match after packaging before claiming equivalent behavior.

## Typed recipient inputs

`inputs` accepts `type:"object"`, `properties` and optional `required` (an array of declared names). Each property has one JSON `type`: `string`, `number`, `integer`, `boolean`, `object`, `array` or `null`. Optional property fields are `description`, `enum`, `default` and `x-raw-kind`. Nested property schemas, range constraints and conditional schemas are not supported.

`x-raw-kind` is optional:

| Kind | Required type and interpretation |
| --- | --- |
| `file`, `directory` | String path; relative paths resolve from the recipient config directory |
| `env-name` | String environment variable name; not its current value |
| `var-source` | Object containing a Raw source definition, not a resolved var reading |

Use a whole value `{"$input":"input_name"}` at approved definition sites: supported agent settings, var `source` (including source params) and `cache_ttl_ms`, provider `command`/`args`/`cwd`/`timeout_ms`/`max_output_bytes`, and MCP `command`/`args`/`env`/`url`/`headers`. Validate the exact site. Inputs do not interpolate substrings, prompt Markdown, JavaScript or shell scripts; `${NAME}` is not package substitution. An environment-name input is read only where the receiving runtime field actually consumes an environment name. MCP `env`/header values themselves remain literal values.

For example, a var can use `"source":{"kind":"env","name":{"$input":"label_env"}}` with an input declared as a string and `x-raw-kind:"env-name"`. A recipient supplies `{"label_env":"MY_PROJECT_LABEL"}`; the var resolver reads that environment value when requested. A file-backed source can use `path:{"$input":"data_file"}` with a `file` input.

Required inputs are checked for the selected export closure when it is activated. Installing the package does not require supplying every input for unrelated exports. Values outside a component's used input set are not applied to that component; a misspelled required name still leaves that input missing. Package-agent bindings pass their relevant input values into selected owned definitions; dependency inputs are explicit in the caller's reference object.

## Export decisions and recovery

`raw package export` starts from one configured agent. It excludes its model alias and exports selected prompt/tool/skill assets and var/provider/MCP definitions. Literal var sources and external machine settings become typed inputs unless explicitly included through SDK options or authored into package source. Inspect the report instead of assuming every file was copied. A missing selected asset must be fixed before export can produce a distributable source tree; the CLI has no draft or include-flags mode.

Validation failures name the reference, input or asset to repair. Include an owned helper in `files`, fix its relative import or point an export to the actual directory. Keep a recipient path as an input when the file is not part of the intended package. Do not work around errors by distributing the author's config/state directory or weakening the runtime validators.

Archives allow at most 4096 entries, 16 MiB per file, 128 MiB expanded total and 16 path segments. Use the pack command to generate normalized bytes and the inventory; renaming an arbitrary ZIP is not enough.
