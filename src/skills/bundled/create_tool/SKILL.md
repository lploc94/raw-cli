---
name: create-tool
description: "Use to create or customize a Raw tool plugin or executable variable provider through files or dashboard. Covers contracts, registration and verification; use create-package to distribute components."
---
# Create a Raw tool plugin

Create callable tools or executable variable providers; reusable instructions belong in create_skill. Tools have manifests and ESM handlers; providers are scripts returning configured data.

Read `references/packages.md` for sharing and `references/dashboard.md` for browser authoring with `read_file`.

## Choose the task and contract

Establish agent/inputs/output/side effects; diagnose failures from the exact error.

Define inputs/results/limits/failures in English. Preflight does not make I/O transactional: document partial execution and cwd/path semantics. Reuse suitable existing tools.

## Layout and schema

- `agent/<id>`: `tools/<id>/` beside the selected config; portable with that directory.
- `local/<id>`: `$XDG_CONFIG_HOME/raw/tools/<id>/`, otherwise `~/.config/raw/tools/<id>/`.
- `builtin/<id>`: installed package-owned tools. Fork examples/tools into a user root; rename folder/manifest/name together.

`--config` changes the agent root, not the global root. Folder/manifest `id` matches `[a-z][a-z0-9_-]*`; model-visible `name` matches `[A-Za-z_][A-Za-z0-9_-]{0,63}` and must be unique among selected tools. `version` is a three-component numeric string.

`tool.json` requires `api_version:2`, `id`, `version`, `name`, nonempty `description`, object `input_schema`, and `entry:"./index.mjs"`. Optional `condition_sources`, `effects_schema` and `panels` declare inspection and UI capabilities. Schema defaults to draft 2020-12; `$schema` can select draft-07. Remote `$ref` and `$async` are unsupported. Use explicit properties, required fields and `additionalProperties:false`. Manifests/schemas are validated before handler imports; unselected code stays inert. Symlinks cannot escape their root/folder.

`index.mjs` exports async `handler(args, context)` and may export synchronous `validateArgs(args)`, returning an error string or `undefined`. Semantic preflight runs before approval and execution. `context.cwd` resolves paths; `context.signal` communicates abort. Return `{content:[...], isError?:boolean, code?:string}`; content may be `{type:"text",text}`, `{type:"json",value}` or a supported typed image. A JSON value must be serializable. Keep imports free of side effects. The handler runs with Raw's OS permissions; cwd and approval rules are not filesystem isolation.

## Working example

Prefer one action per call with a flat schema, and put a complete example call in the description: models repeat a simple call more reliably than they fill a batch array. For `local/append_notes`, create `tool.json` in the global `tools/append_notes/` folder:

<!-- example:manifest -->
```json
{
  "api_version": 2,
  "id": "append_notes",
  "version": "1.0.0",
  "name": "append_notes",
  "description": "Append one newline-terminated note to a file, creating the file and its parent directories if needed. Example: {\"path\":\"notes.txt\",\"text\":\"Ship the docs\\n\"}. Relative paths use the session cwd. The result names the file and the bytes appended. To add notes to several files, make several calls.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "minLength": 1, "description": "File path, absolute or relative to the session cwd." },
      "text": { "type": "string", "minLength": 1, "description": "The note, ending with a newline." }
    },
    "required": ["path", "text"],
    "additionalProperties": false
  },
  "entry": "./index.mjs"
}
```

Create its `index.mjs`. The semantic validator rejects a note without a final newline before anything is written, and its error shows a valid call. The handler checks abort before writing and returns one text line:

<!-- example:handler -->
```js
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function validateArgs(args) {
  if (typeof args.path !== "string" || !args.path.trim()) return "path must be a nonempty string";
  if (typeof args.text !== "string" || !args.text.endsWith("\n"))
    return 'text must end with a newline, for example {"path":"notes.txt","text":"Ship the docs\\n"}';
  return undefined;
}

export async function handler(args, context) {
  if (context.signal?.aborted) return { isError: true, code: "aborted", content: [{ type: "text", text: "aborted" }] };
  const path = resolve(context.cwd, args.path);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, args.text, "utf8");
  return { isError: false, content: [{ type: "text", text: `Appended ${Buffer.byteLength(args.text)} bytes to ${args.path}` }] };
}
```

Append the exact ID to `agents.<name>.tools.use`, preserving existing entries and order. This is an agent fragment, not a complete config:

<!-- example:registration -->
```json
{ "tools": { "use": ["builtin/read_file", "local/append_notes", "builtin/bash"] } }
```

Use `agent/append_notes` for a config-adjacent folder.

## Implement and verify

1. Inspect the target agent's selected names and policy. Create the manifest and handler in the chosen root. Validate the whole input before side effects; handle aborts and genuine runtime failures without claiming rollback.
2. Change a copy, never the active config: copy it to `config.candidate.json` beside it, edit the candidate, run `raw config check config.candidate.json`, then try it with `raw --try-config config.candidate.json --agent NAME "Reply with just: OK"`; only when both pass, back up the active file, copy the candidate over it and keep mode 0600 (`configure_raw` "Edit and verify" has the script; with `--config PATH`, use `--config CANDIDATE` for both). The candidate adds the exact selection. The check does not import or execute the plugin.
3. Before replacing, with the installed library, use `loadConfig({configPath:ACTIVE,configSource:CANDIDATE_TEXT,requireModel:false})`, then `createRuntimeTools({runtime,cwd})`. Dispatch the model-visible name through `tools.registry.dispatch(name,args,{cwd,maxOutputBytes:8192})`; close `tools.mcp` in `finally`. This verifies registration/schema/preflight without inference.
4. For this example, first send a note without a final newline; confirm the validation error and that no file was created. Then send `{"path":"notes.txt","text":"first\n"}` and verify the file contents and the result `Appended 6 bytes to notes.txt`. Repeat to check append behavior, reject unknown properties, and test abort when relevant. Host output caps still apply.
5. Add `tools.rules` only for requested policy. Match the canonical ID, e.g. `{"match":"local/append_notes","effect":"ask"}`. Last matching rule wins; unmatched calls run, and `-y` does not bypass explicit ask. Only ask accepts a `when` predicate on a schema-bound string path. Verify a requested rule with harmless inputs.

Check failed loads for ID/entry/exports/schema/containment. Report partial runtime effects. Selected source/schema edits rotate generated cache keys on resume; unselected edits do not. Report paths/registration/checks.

## Variable consumers and providers

For a configured data value, write an executable provider instead of a tool manifest. Save `host.mjs` beside the config:

<!-- example:var-provider -->
```js
import { hostname } from "node:os";
let input = "";
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
if (request.protocol_version !== 1) throw new Error("unsupported protocol");
process.stdout.write(JSON.stringify({value:hostname()}) + "\n");
```

Root `var_providers.host={command:"node",args:["host.mjs"]}` and `vars.host={description:"Host name",access:"read",type:"string",source:{kind:"provider",name:"host"}}`; append `host` to agent.vars. Select builtin/list_vars and builtin/read_var for discovery/reads. Test `raw --config PATH vars get host`. No model call is needed. Provider receives `{protocol_version:1,name,params}`; params come from config. Output exactly `{value,observed_at?}` JSON, exit 0; logs stderr. Raw bounds time/bytes. Paths/cwd default to config directory; configure_raw covers limits/cache/source schema.

Selected handlers receive context.vars: list(), read(name,{signal}), validateEnvRefs(refs), resolveEnv(refs,{signal}). Pass selected scalar values to a child through env, not shell interpolation; code can still print them. Respect context.signal. Unselected names and use-only reads fail. Bash and process start support env_refs; MCP has no implicit vars rewriting.
