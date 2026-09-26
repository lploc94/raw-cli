---
name: create-tool
description: "Use to create or customize a Raw tool plugin or executable variable provider, including input/output contracts, host vars consumption, registration and verification."
---
# Create a Raw tool plugin

Create callable tools or executable variable providers; reusable instructions belong in create_skill. Tools have manifests and ESM handlers; providers are scripts returning configured data.

## Choose the task and contract

For how-to, explain; for implementation, establish agent/inputs/output/side effects; for failure, start from the exact error.

Define inputs/results/limits/failures in English. Preflight does not make I/O transactional: document partial execution and cwd/path semantics. Reuse suitable existing tools.

## Layout and schema

- `agent/<id>`: `tools/<id>/` beside the selected config; portable with that directory.
- `local/<id>`: `$XDG_CONFIG_HOME/raw/tools/<id>/`, otherwise `~/.config/raw/tools/<id>/`.
- `builtin/<id>`: installed package-owned tools. Fork examples/tools into a user root; rename folder/manifest/name together.

`--config` changes the agent root, not the global root. Folder/manifest `id` matches `[a-z][a-z0-9_-]*`; model-visible `name` matches `[A-Za-z_][A-Za-z0-9_-]{0,63}` and must be unique among selected tools. `version` is a three-component numeric string.

`tool.json` has exactly seven fields: number `api_version:1`, `id`, `version`, `name`, nonempty `description`, object `input_schema`, and `entry:"./index.mjs"`. Schema defaults to draft 2020-12; draft-07 is allowed via `$schema`. Remote `$ref` and `$async` are unsupported. Use an object schema with explicit properties, required fields and `additionalProperties:false`. Selected manifests/schemas are validated before any selected handler import; unselected code is not imported. Symlinks cannot escape the selected root/folder.

`index.mjs` exports async `handler(args, context)` and may export synchronous `validateArgs(args)`, returning an error string or `undefined`. Semantic preflight runs before approval and execution. `context.cwd` resolves paths; `context.signal` communicates abort. Return `{content:[...], isError?:boolean, code?:string}`; content may be `{type:"text",text}`, `{type:"json",value}` or a supported typed image. A JSON value must be serializable. Keep imports free of side effects. The handler runs with Raw's OS permissions; cwd and approval rules are not filesystem isolation.

## Working example

For `local/append_notes`, create `tool.json` in the global `tools/append_notes/` folder:

<!-- example:manifest -->
```json
{
  "api_version": 1,
  "id": "append_notes",
  "version": "1.0.0",
  "name": "append_notes",
  "description": "Append 1-16 newline-terminated notes to paths in session cwd, in order. Validates every row before writing; reports the count. Files may be created.",
  "input_schema": {
    "type": "object",
    "properties": { "operations": { "type": "array", "minItems": 1, "maxItems": 16,
      "items": { "type": "object", "properties": { "path": { "type": "string", "minLength": 1 }, "text": { "type": "string", "minLength": 1 } },
        "required": ["path", "text"], "additionalProperties": false } } },
    "required": ["operations"],
    "additionalProperties": false
  },
  "entry": "./index.mjs"
}
```

Create its `index.mjs`. The semantic validator rejects an invalid later row before any earlier write. The handler checks abort between writes and returns a count:

<!-- example:handler -->
```js
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function validateArgs(args) {
  if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 16)
    return "operations must contain 1-16 rows";
  for (const [index, row] of args.operations.entries()) {
    if (!row || typeof row.path !== "string" || !row.path.trim()
      || typeof row.text !== "string" || !row.text.endsWith("\n"))
      return `operations[${index}] needs a path and newline-terminated text`;
  }
  return undefined;
}

export async function handler(args, context) {
  if (context.signal?.aborted) return { isError: true, code: "aborted", content: [{ type: "text", text: "aborted" }] };
  for (const row of args.operations) {
    if (context.signal?.aborted) return { isError: true, code: "aborted", content: [{ type: "text", text: "aborted after a partial batch" }] };
    const path = resolve(context.cwd, row.path);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, row.text, "utf8");
  }
  return { isError: false, content: [{ type: "json", value: { written: args.operations.length } }] };
}
```

Append the exact ID to `agents.<name>.tools.use`, preserving existing entries and order. This is an agent fragment, not a complete config:

<!-- example:registration -->
```json
{ "tools": { "use": ["builtin/read_file", "local/append_notes", "builtin/bash"] } }
```

Use `agent/append_notes` instead when the folder is config-adjacent. Preserve other config fields.

## Implement and verify

1. Inspect the target agent's selected names and policy. Create the manifest and handler in the chosen root. Validate the complete batch before side effects; handle aborts and genuine runtime failures without claiming rollback.
2. Back up existing config, add the exact selection, and keep config mode 0600. Run `raw config list` or `raw --config PATH config list` for static config validation; this alone does not import or execute the plugin.
3. With the installed library, use `loadConfig({configPath,requireModel:false})`, then `createRuntimeTools({runtime,cwd})`. Dispatch the model-visible name through `tools.registry.dispatch(name,args,{cwd,maxOutputBytes:8192})`; close `tools.mcp` in `finally`. This verifies registration/schema/preflight without inference.
4. For this example, first send a valid first row and a second row without a newline; confirm failure and no first file. Then send `{"operations":[{"path":"notes.txt","text":"first\n"}]}` and verify file contents and JSON `written:1`. Repeat to check append behavior, reject unknown properties, and test abort/partial failure when relevant. Host output caps still apply.
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

All selected local handlers receive context.vars: list(), read(name,{signal}), validateEnvRefs(refs), resolveEnv(refs,{signal}). For an API tool, resolve `{TOKEN:args.token_ref}` and pass env.TOKEN to its client; return the API result, not the credential. Pass context.signal. Host rejects unselected names and use-only reads. Bash supports commands[].env_refs. Values enter child env, never shell interpolation; plugins can still print them. MCP gets no implicit vars rewriting.
