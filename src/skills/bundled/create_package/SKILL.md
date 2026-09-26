---
name: create-package
description: "Use when packaging or sharing Raw agents, tools, skills, vars or MCP as a .rawpkg, or preparing an updated release. Covers CLI and dashboard exports, recipient inputs and installation checks."
---
# Create a shareable Raw package

Produce editable package source, a validated `.rawpkg` archive and instructions the recipient can follow. Use for packaging existing components or assembling a package. Creating a new tool, skill, agent or MCP connection belongs to its creation skill when selected; use that guidance only for components the request actually needs.

For a how-to, explain the relevant commands and contract. For a requested artifact, carry out the workflow below. For a failed package, start from its validation or activation error and preserve unrelated configuration.

For browser import/export and typed binding forms, read `references/dashboard.md` with `read_file`.

## Choose the source and contents

Establish the source agent or component paths, output directory, scoped package name (`@owner/name`) and SemVer release (`1.0.0`). Keep the requested scope: a tool-only or skill-only package needs no agent export. An export name, installed alias and recipient agent name are separate identifiers.

- Existing agent: `raw package export --agent NAME --name @owner/name --version 1.0.0 --out DIR --config AUTHOR_CONFIG`. Use a new or empty destination. This copies selected owned assets and produces a report; inspect required inputs, external executables and unresolved assets before packing.
- Selected components or a new composition: author `raw-package.json` and its declared files. Start from the installed `examples/packages/tool-only/`, `skill-only/` or `mixed-kit/` when helpful. The examples and `docs/packages.md` belong to the installed `raw-cli` package; do not assume a source checkout or resolve them from the project cwd.

Before writing a manifest or inputs, read `references/manifest.md` with `read_file`. Before installation, activation, updates or development linking, read `references/packages.md`. Resolve these references beside this loaded skill; `load_skill` does not automatically include their contents.

Package prompts, helpers, skill resources and provider/MCP scripts that the package owns. Keep recipient model aliases, machine paths, environment names and service settings in recipient bindings or typed inputs. Current var readings and session history are not package definitions. Builtin selections continue to use the recipient's Raw installation.

Export makes literal var sources and external paths/settings into recipient inputs by default. The CLI has no `--include-literals` or `--include-files` flags. For deliberately shared constants or owned files, edit the generated source/manifest or use the SDK's explicit `includeLiterals` and `includeFiles` options. Review wildcard rules after export; exact local tool identities are rewritten automatically.

## Minimal package with a recipient input

This complete example exports a small agent and a reusable var. Create these three files under a new source directory. It uses no custom executable or model credential.

`raw-package.json`:

<!-- example:manifest -->
```json
{
  "schema_version": 1,
  "name": "@example/project-kit",
  "version": "1.0.0",
  "description": "An assistant that reads the recipient's project label",
  "files": ["agents/helper.json", "vars/project_label.json"],
  "exports": {
    "agents": {"helper": "agents/helper.json"},
    "vars": {"project_label": "vars/project_label.json"}
  },
  "inputs": {
    "type": "object",
    "properties": {"project_label": {"type": "string", "description": "Recipient project label"}},
    "required": ["project_label"]
  },
  "requires": ["raw.agent/1"]
}
```

`agents/helper.json` (the recipient supplies `model`):

<!-- example:agent -->
```json
{
  "system_prompt": "Help with the user's project. Read project_label when the project name is relevant. Treat previous variable readings as historical.",
  "tools": {"use": ["builtin/list_vars", "builtin/read_var"]},
  "vars": ["#vars/project_label"]
}
```

`vars/project_label.json`:

<!-- example:var -->
```json
{
  "description": "The recipient's project label",
  "access": "read",
  "type": "string",
  "source": {"kind": "literal", "value": {"$input": "project_label"}}
}
```

The recipient input file for this example is `{"project_label":"My project"}`. This is a supplied definition value; changing it does not evaluate a provider or template the prompt.

## Validate, pack and hand off

1. Run `raw package validate DIR` and `raw package inspect DIR`. Resolve missing/undeclared files and invalid references at their source. Validation does not import tools, execute providers, connect MCP or call a model.
2. Run `raw package pack DIR --out FILE.rawpkg`, then inspect that archive. Report its name, version, exported components, required inputs and executable prerequisites. There are no install hooks or automatic npm/pip/system dependency installers.
3. For an artifact request, check the recipient path using an isolated config and data directory as described in `references/packages.md`. Install the archive, bind the requested export and exercise the relevant harmless operation. A missing external service or model need not block packing; report which live behavior remains unverified. A prose explanation needs no test installation.
4. Deliver the archive path and exact install/binding commands. Include an input example, a recipient model placeholder and any external prerequisites. The recipient supplies an existing local model alias. Installing alone does not select components or change `default_agent`.

Send or publish the artifact only when requested. Raw v1 accepts local folders and `.rawpkg` files; a user can download one from GitHub Releases, but Raw has no hosted marketplace or automatic Git download command.

For a new release, update the source version and repack, then use `raw package update ALIAS --from NEW.rawpkg --config CONFIG`. Existing sessions can resume with the current runtime. Meaningful prompt/tool changes may rotate Raw's generated cache key once; skill changes can add a tail reload notice. An unchanged next resume is stable; a version label alone is not a reason to reset sessions.
