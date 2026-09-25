# Create a Raw tool plugin

Use when the user needs a new callable action, not merely reusable instructions. Inspect the intended agent's `tools.use`, existing model-visible names and policy, and the nearest shipped `examples/tools/` plugin. A plugin is one folder with `tool.json` and standalone ESM `index.mjs`; Raw loads only selected IDs at startup. A local plugin runs as the Raw process with full OS permissions, so review its side effects and bound its inputs. Keep tool descriptions accurate about required arguments, output, errors, and side effects. Do not put secrets in descriptions or results.

## Roots and manifest contract

Use `local/<id>` under `$XDG_CONFIG_HOME/raw/tools/<id>/` (fallback `~/.config/raw/tools/<id>/`) for a global fork, or `agent/<id>` under `tools/<id>/` beside the selected config file for a portable agent. `builtin/<id>` belongs to the installed package: copy an example to a user root before editing. `--config` does not relocate the local root. Folder ID begins with lowercase a–z and then lowercase letters, digits, `_` or `-`; manifest `id` equals the folder. Model-visible `name` starts with a letter or `_`, is at most 64 supported characters, and must not duplicate a selected tool name. `version` uses `major.minor.patch`.

`tool.json` has exactly seven fields: numeric `api_version: 1`, `id`, `version`, `name`, nonempty `description`, `input_schema`, and `entry: "./index.mjs"`. `input_schema` is an object JSON Schema; draft 2020-12 is the default, draft-07 is allowed by its `$schema` URI. Remote `$ref` and `$async` are unsupported. Declare `type: "object"`, `properties`, `required`, and `additionalProperties: false` so the model and host agree. Raw validates every selected manifest/schema before importing any selected handler; unselected plugin code is never imported. Symlinks must stay inside their selected root and folder.

## Working batch example

For `local/append_notes`, create `~/.config/raw/tools/append_notes/tool.json` (or use the XDG root):

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

Create `index.mjs` in that folder. `validateArgs` is synchronous and returns an error string or `undefined`; it checks constraints that JSON Schema does not express. Raw calls it before approval or the handler, so a malformed **later** row cannot allow earlier side effects. The handler still guards aborts and returns a Raw `ToolResult` with text, JSON or image content. This example uses JSON content and appends only after whole-batch preflight:

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

Registration is an exact ID in `agents.<name>.tools.use`, preserving its existing order and selected entries:

```json
{ "tools": { "use": ["builtin/read_file", "local/append_notes", "builtin/bash"] } }
```

Add a `tools.rules` entry only if the user wants `ask` or `deny` for this tool; e.g. `{ "match": "local/append_notes", "effect": "ask" }`. Rules use the canonical ID, with the **last matching rule** winning. Unmatched tools run automatically, and `-y` cannot bypass an explicit ask. A `when` predicate is permitted only for `ask` and must resolve to a string path in the declared schema. The tool has the user's full filesystem permissions regardless of `cwd`; a rule is an approval policy, not a sandbox.

## Verification and failure handling

Back up and edit the config at mode 0600. Run `raw config list` or `raw --config /path/to/raw.json config list`; then run a harmless call using the target agent. Call `append_notes` with `{ "operations": [{ "path": "notes.txt", "text": "first\n" }] }` and confirm the file and JSON result. Before this, call it with a valid first row and a second row whose `text` lacks `\n`; verify the whole call fails before `notes.txt` is created. Test a second run for appending, an unknown input field, a denied/ask rule if configured, and an abort or partial runtime failure. Host result caps still apply; a very large result may be truncated or rejected even if the handler returned it. Do not claim a batch is atomic after execution starts: an I/O error can leave earlier writes, while schema and semantic validation run before any write.

If startup fails, check exact ID/folder/manifest values, `entry` path, exports, schema draft, unique name, containment, and import side effects. If a selected tool's schema, description or source changes between runs, Raw advances context revision and rotates its generated cache key on resume; committed history is retained. Unselected code edits do not change the active agent.
