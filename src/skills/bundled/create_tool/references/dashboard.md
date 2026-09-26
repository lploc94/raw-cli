# Author tools and providers in the dashboard

**Library → Tools → Create tool** starts from a shipped example in a new local folder. **Fork to local** copies a builtin or immutable package tool. Inspect `tool.json`, `index.mjs` and helpers; Add text file supports contained source/resources. The main skill defines the manifest, schema and handler contracts.

Each file saves independently with a revision check. Manifest/schema validation and owned-path checks are passive; JavaScript behavior still needs a requested harmless runtime test. Save or discard before switching source files. Attach the finished tool explicitly. `tool.json.name` is its visible local tool name; a package selection can use `{ref, as, inputs}`. Canonical identity remains available for policy.

Use **Agents** for ordered selections and conditional rules. Test rules evaluates sample arguments without dispatching Bash. Only a matching ask rule requests approval. Existing runs keep their imported source snapshot; the next turn of an existing session loads changed helpers and subsequent unchanged turns stabilize.

For executable variable providers, **Library → Vars → Edit definitions** edits `var_providers` and `vars` as strict JSON. Create the actual script through the normal file tools, then reference its command/args and select the variable on the agent. Read explicitly executes a readable var's provider and reports freshness or failure. Access `use` values remain env references for consumers; MCP has no implicit vars substitution. A saved definition is not execution evidence.

Share owned sources through **Library → Packages**, with recipient inputs for machine-specific values and explicit prerequisites.
