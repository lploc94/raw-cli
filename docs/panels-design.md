# Tool panels design (`raw.panel/1`)

Design and contract for **tool panels**: live, structured state that a tool publishes and every Raw surface can show. The dashboard shows it in the right-hand side panel, the CLI prints it as text, and ACP clients receive it as a plan or an extension update. A tool author who follows this document gets a working panel on every surface without writing UI code.

This file is the source of truth for the protocol. User-facing behavior will be summarized in `tools.md`, `dashboard.md`, `dashboard-api.md`, `acp.md` and `cli.md` when it is implemented. The machine-readable schema will be `schemas/raw-panel.schema.json`, and it must agree with this file.

Status: design proposed 2026-09-29, not implemented. Update this file whenever a decision changes. A change to a wire shape is a protocol change (see §13).

## Contents

1. Goals and non-goals
2. Industry pattern
3. Vocabulary
4. Architecture
5. Declaration (`tool.json`)
6. Panel document
7. Block catalog
8. Publishing updates
9. Update operations and revisions
10. Model visibility and compaction
11. Actions
12. Persistence and lifecycle
13. Surfaces: dashboard, CLI, ACP, library
14. Limits
15. Errors
16. Security
17. Versioning and compatibility
18. Reference tool: `builtin/todo`
19. Example third-party tool: spec runner
20. Decisions
21. Alternatives rejected
22. Implementation outline and verification map

---

## 1. Goals and non-goals

### Goals

- A tool can show where the work stands: todo progress, spec items done, phases passed, files touched, recent events. It does this by publishing **typed data**. It never ships HTML or scripts.
- **One convention for every tool.** The same rules apply to built-in, local, agent, package, MCP and ACP-registered tools. Registration, rendering, persistence, limits and errors all work the same way.
- **The chat is history, the panel is current state.** The chat keeps a small receipt for each update, so you can see when something changed. The side panel always shows the latest state.
- **Degrade, never block.** An invalid update, an unknown block kind, an older client or a missing capability never fails the tool call or the turn. At worst the update is dropped with a visible notice, or shown as plain text.
- The state survives reload, resume, reconnect and compaction.
- The user can act on a panel (tick an item, continue, clear completed) through actions the tool declares. Actions run through the same policy, approval and hook boundaries as model tool calls.
- The model does not lose track of the state after compaction, when the tool opts in.

### Non-goals

- Arbitrary UI from tools: no HTML, iframes, JavaScript, CSS, remote images or remote fetches.
- Panels shared between sessions or kept at workspace scope. State that must outlive a session belongs in workspace files (a spec file, `TODO.md`), which a tool can read and publish again.
- A general dashboard plugin system (new pages, new routes).
- Editing panel content directly in the UI. The user changes state only through declared actions.
- Hook events for panel updates. `PostToolUse` already observes the tool that caused the update.

## 2. Industry pattern

Researched 2026-09-29.

- **Claude Code `TodoWrite`, Codex `update_plan`.** The model sends the whole list as tool arguments, and the host shows it as a checklist. Claude Code shows it again after compaction.
- **Cursor, Windsurf, Devin.** A plan or progress panel beside the chat. The chat keeps short receipts.
- **ChatGPT Canvas, Claude Artifacts.** A side panel holds the evolving object, the chat holds the conversation.
- **ACP `session/update` with `sessionUpdate: "plan"`.** A plan is a list of `{content, priority, status}` entries, and each update is a full replacement.
- **MCP `outputSchema` and `structuredContent`.** Typed tool output. MCP Apps (`ui://` resources) lets servers ship HTML UIs. Raw rejects that model (see §21).
- **VS Code contribution points (tree views, walkthroughs).** Contributions are declared in a manifest, the host owns rendering, and data arrives through a provider API.

Raw takes the common core: declare in the manifest, publish typed snapshots, let the host render a fixed widget catalog, keep receipts in the chat, and re-inject state into the model after compaction.

## 3. Vocabulary

| Term | Meaning |
| --- | --- |
| **Owner** | The canonical tool identity that declared or first published the panel, such as `builtin/todo`, `agent/spec`, `pkg/kit/tools/spec`, `mcp/<server>/<tool>` or `acp/<alias>`. |
| **Panel ID** | The local ID from the declaration, such as `todo`. The **full ID** is `<owner>#<panel id>`, such as `builtin/todo#todo`. |
| **Declaration** | Static metadata in `tool.json`: title, icon, open policy, context policy and actions. |
| **Document** | The current state of a panel: header fields plus ordered blocks. |
| **Block** | One widget in a document, such as `checklist`, `steps`, `table` or `markdown`. |
| **Update** | A `replace`, `patch` or `close` request from the owner. |
| **Revision** | A positive integer the host assigns to each accepted update, increasing per panel. |
| **Receipt** | A small, persisted summary of one committed update. It is shown in the chat and in the CLI. |
| **Action** | A user-invokable operation declared by the owner: `prompt` or `tool`. |

## 4. Architecture

```
tool handler ──(result block | context.panels.update)──┐
MCP result _meta["raw/panel"] ─────────────────────────┤
ACP _raw/tool/call response {type:"panel"} ────────────┤
                                                       ▼
                         PanelHost (per session, per runtime)
                           validate → apply → assign revision
                           │                 │
             live (coalesced)          commit with tool result
                           │                 │
            dashboard SSE "panel"     session_panels (latest document)
            ACP plan / _raw/panel     history "panel_receipt"
                           │                 │
                           ▼                 ▼
              side panel tab / CLI receipt / reminder after compact
```

- `PanelHost` is the single owner of panel state for an attached session runtime. All emission paths converge on it, so validation, limits and revisions are identical everywhere.
- Updates are **stripped from the model-visible tool result** before `capResult`. The model sees only what §10 allows.
- Live updates reach observers immediately. Durability happens at the tool-result commit boundary, in the same transaction as the tool result. This matches how text deltas relate to committed assistant messages.

## 5. Declaration (`tool.json`)

`tool.json` gains one optional field, `panels`. Manifests without it are unchanged. `api_version` stays `1`.

```jsonc
{
  "api_version": 1,
  "id": "todo",
  "version": "1.0.0",
  "name": "todo",
  "description": "…",
  "input_schema": { "type": "object" },
  "entry": "./index.mjs",
  "panels": [
    {
      "id": "todo",
      "title": "Todo",
      "icon": "list-checks",
      "open": "first_update",
      "context": "summary",
      "acp_plan": true,
      "actions": [
        {
          "id": "complete",
          "label": "Mark done",
          "scope": "item",
          "blocks": ["items"],
          "kind": "tool",
          "arguments": { "mode": "merge", "todos": [{ "id": "{{item.id}}", "status": "done" }] },
          "primary": true
        },
        {
          "id": "continue",
          "label": "Continue",
          "scope": "panel",
          "kind": "prompt",
          "text": "Continue with the next pending todo item."
        }
      ]
    }
  ]
}
```

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `id` | string | required | `^[a-z][a-z0-9_-]{0,31}$`. Unique within the tool. |
| `title` | string | required | 1–40 characters. The tab label and receipt title. The document may override the displayed title. |
| `icon` | string | `"panel"` | One of `list-checks`, `list-ordered`, `file-text`, `table`, `activity`, `gauge`, `folder-tree`, `flag`, `panel`. An unknown value falls back to `panel` with a load warning, not an error. |
| `open` | `"never"` \| `"first_update"` | `"never"` | A hint for the dashboard (§13.1). The user preference overrides it. |
| `context` | `"none"` \| `"summary"` | `"none"` | Whether the model is reminded of this panel after compaction (§10). |
| `acp_plan` | boolean | `false` | Mirror the first `checklist` block as the ACP standard `plan` (§13.3). At most one panel per agent may set it. A second one is ignored with a warning. |
| `actions` | array | `[]` | At most 8. See §11. |

Validation happens when the loader reads the manifest, **before** any handler is imported, like the rest of `parseToolManifest`. A tool may declare at most 4 panels. A tool with an invalid `panels` field fails to load with `invalid tool manifest: <id>`, exactly like any other manifest error.

**Tools without a manifest** (MCP and ACP-registered tools) declare panels implicitly:

- **MCP.** The first update for an unknown panel ID creates a declaration with defaults. `title` comes from the document, and `actions`, `context` and `acp_plan` are off. An MCP server entry in config may add `"panels": [...]` with the same shape to opt into more.
- **ACP client tools.** `_raw/tool/register` accepts an optional `panels` array with the same shape.

## 6. Panel document

```jsonc
{
  "title": "Todo",                 // optional; overrides the declared title (≤ 80 chars)
  "subtitle": "Refactor auth",     // optional (≤ 120 chars)
  "status": "active",              // "idle" | "active" | "done" | "failed"; default "active"
  "progress": { "done": 3, "total": 7 },   // optional; derived if absent (below)
  "summary": "3/7 · Fix the API",  // optional (≤ 120 chars); derived if absent
  "context_summary": "…",          // optional (≤ 2048 bytes UTF-8); used by §10
  "blocks": [ /* ≤ 20 blocks, §7 */ ]
}
```

- **Derived `progress`.** If the field is absent, the host counts leaf items across all `checklist` blocks: `done` = items with status `done` or `skipped`, `total` = all leaf items. If there is no checklist, it counts `steps` items. Otherwise there is no progress.
- **Derived `summary`.** If the field is absent, the host builds `"<done>/<total>"` followed by `" · <label of first in_progress item>"` when such an item exists. Otherwise it uses the first block title, or `title`.
- **Unknown top-level fields** are rejected with `panel_invalid`. Forward compatibility happens at block level (§17).
- **Strings** are plain text unless the field is `markdown`. Control characters other than `\n` and `\t` are rejected.

### Shared item status

Every widget that has a status uses the same enum. Surfaces map it the same way:

| Status | Dashboard glyph (plus text for screen readers) | CLI glyph | ACP plan status |
| --- | --- | --- | --- |
| `pending` | empty circle | `[ ]` | `pending` |
| `in_progress` | half circle, accent color | `[~]` | `in_progress` |
| `done` | check, success color | `[x]` | `completed` |
| `skipped` | slashed circle, muted | `[-]` | `completed` |
| `blocked` | pause, warning color | `[!]` | `pending` |
| `failed` | cross, error color | `[✗]` | `pending` |

Color never carries meaning alone: each glyph also has an accessible label.

### File references

Wherever a `ref` is allowed, its shape is `{ "path": string, "line"?: positive int }`. A relative path resolves against the session cwd. The dashboard shows the shortened path. Clicking it inserts `@path` into the composer (the existing file-reference feature). It never opens or fetches the file itself.

## 7. Block catalog

Every block has the common fields `{ "id": string, "kind": string, "title"?: string, "fallback"?: string }`.

- `id` matches `^[A-Za-z0-9_-]{1,32}$` and is unique within the document. Patches and actions target blocks by `id`.
- `fallback` (≤ 4 KiB) is plain text that an older host shows for a kind it does not know (§17). For known kinds it is ignored.

Item `id`s match `^[A-Za-z0-9_.-]{1,64}$` and are unique within their block, including nested items.

### 7.1 `checklist`

For todos, plans and spec acceptance criteria.

```jsonc
{ "id": "items", "kind": "checklist", "title": "Tasks",
  "items": [
    { "id": "t1", "label": "Write the failing test", "status": "done" },
    { "id": "t2", "label": "Fix the API", "status": "in_progress", "priority": "high",
      "note": "Waiting on schema change", "ref": { "path": "src/api.ts", "line": 42 },
      "children": [ { "id": "t2.1", "label": "Validate input", "status": "pending" } ] }
  ] }
```

- **Item fields.** `id` and `label` (≤ 200 characters) are required. Optional: `status` (default `pending`), `priority` (`high` | `medium` | `low`), `note` (≤ 500 characters), `ref`, and `children`.
- **Limits.** Nesting is at most 3 levels deep. A block holds at most 200 items including children.
- **Dashboard.** An indented tree with a status glyph per item. Items with children can be collapsed. The block header has a "Hide completed" toggle, and that choice is stored per browser. A declared `primary` item action turns the glyph into a checkbox button (§11).
- **Text rendering.** One line per item, `  `-indented per level: `[x] Write the failing test`.

### 7.2 `steps`

For ordered phases or a pipeline.

```jsonc
{ "id": "phases", "kind": "steps",
  "items": [ { "id": "p1", "label": "Plan", "status": "done", "detail": "approved",
               "started_at": 1759140000000, "ended_at": 1759140600000 } ] }
```

- **Items.** Flat list, at most 30. Fields are `detail` (≤ 200 characters), `started_at` and `ended_at` (epoch ms).
- **Dashboard.** A vertical stepper that shows how long each step took when it has both timestamps.
- **Text rendering.** `1. [x] Plan — approved (10m)`.

### 7.3 `progress`

```jsonc
{ "id": "bar", "kind": "progress", "label": "Indexing", "value": 42, "max": 100 }
```

- **Fields.** `value` and `max` are non-negative finite numbers with `value ≤ max` and `max > 0`. Alternatively, `"indeterminate": true` with no values.
- **Dashboard.** A `role="progressbar"` element that respects `prefers-reduced-motion`.
- **Text rendering.** `Indexing 42%`.

### 7.4 `key_value`

```jsonc
{ "id": "facts", "kind": "key_value",
  "entries": [ { "key": "Branch", "value": "feat/auth" },
               { "key": "Spec", "value": "auth.md", "ref": { "path": "specs/auth.md" } } ] }
```

- **Limits.** At most 50 entries. `key` ≤ 60 characters, `value` ≤ 500 characters.
- **Dashboard.** A description list (`<dl>`).

### 7.5 `table`

```jsonc
{ "id": "tests", "kind": "table",
  "columns": [ { "id": "name", "label": "Test" }, { "id": "time", "label": "Time", "align": "end" } ],
  "rows": [ { "id": "r1", "status": "failed", "cells": { "name": "login rejects empty", "time": "12 ms" } } ] }
```

- **Limits.** 1–8 columns and at most 200 rows. A cell is text of at most 300 characters. A missing cell renders empty.
- **Row fields.** Optional `status` (shows a glyph column) and `ref`.
- **Dashboard.** A table with horizontal scroll inside the panel. It never causes page overflow.
- **Text rendering.** Aligned columns. Rows past 50 are summarized as `… N more rows`.

### 7.6 `markdown`

```jsonc
{ "id": "why", "kind": "markdown", "text": "## Scope\nOnly the login flow." }
```

- **Size.** `text` ≤ 16 KiB.
- **Rendering.** The dashboard's existing sanitizing markdown renderer, the same one used for assistant messages. Raw HTML is shown as text.
- **Links.** Only `http:` and `https:` links are allowed. They open in a new tab with `rel="noopener noreferrer"`. Images are shown as their alt text and never fetched.

### 7.7 `timeline`

For events, logs and history of a run.

```jsonc
{ "id": "log", "kind": "timeline", "max": 100,
  "events": [ { "id": "e1", "at": 1759140000000, "level": "success", "label": "Tests passed", "detail": "42 passed" } ] }
```

- **Fields.** `level` is `info` | `success` | `warning` | `error`. `label` ≤ 200 characters, `detail` ≤ 1000 characters.
- **Cap.** `max` ranges 1–200 (default 100). The `append_events` patch drops the oldest events beyond `max`.
- **Dashboard.** Newest first, with relative time.

### 7.8 `files`

For artifacts and files touched.

```jsonc
{ "id": "touched", "kind": "files",
  "entries": [ { "path": "src/api.ts", "status": "modified", "line": 42, "label": "handler" } ] }
```

- **Fields.** `status` is `added` | `modified` | `deleted` | `referenced`. At most 200 entries.
- **Dashboard.** A list of shortened paths with a status letter (A, M, D, R). Clicking an entry inserts `@path` (§6).

Diffs are shown as a `markdown` block with a fenced `diff` code block. There is no separate diff widget in `raw.panel/1`.

## 8. Publishing updates

Every emission path produces the same **update object** (§9). An owner can only write panels whose full ID starts with its own identity. Any other write is rejected with `panel_not_owned`.

### 8.1 Result block (all local plugin tools)

A handler may return one or more panel blocks among its content:

```js
return {
  isError: false,
  content: [
    { type: "text", text: "Updated todo: 3/7 done." },
    { type: "panel", panel: "todo", op: "replace", document: { blocks: [/* … */] } }
  ]
};
```

- `ToolContent` gains a `ToolContentPanel` variant: `{ type: "panel", panel: string, op: "replace" | "patch" | "close", document?, patches?, base_revision? }`.
- The host removes every panel block from the result **before** hooks, capping, provider mapping and history projection. Panel bytes never count against `maxOutputBytes` and never reach the model.
- Blocks are applied in order, after the handler settles and before the result commits.

### 8.2 Streaming API (local plugin tools)

`ToolContext` gains an optional `panels`. It is present only when the host supports `raw.panel/1`, so tools feature-detect it:

```ts
interface PanelContext {
  /** Applies one update now; resolves with the new revision, or rejects with a PanelError. */
  update(panel: string, update: PanelUpdate): Promise<{ revision: number }>;
  /** The latest document of one of this tool's panels in this session, or undefined. */
  get(panel: string): { revision: number; document: PanelDocument } | undefined;
}
```

- **Live delivery.** `update` is applied and published to live observers immediately. Observers receive at most one frame per panel every 250 ms, and the latest state wins.
- **Commit.** The state at the moment the handler settles is committed with the tool result, whether the result is success, error or cancelled. A failed spec run therefore still shows which items passed.
- **Crash.** If Raw crashes before the commit, live-only revisions are lost and recovery shows the last committed revision. The revision counter never goes backwards on disk: the committed revision is the one from the last applied update.
- **After the handler settles,** `update` rejects with `panel_closed_context`, and `get` still works.
- **Reading state.** `get` lets a tool build a merge on top of the current state without the model resending everything (see §18).

### 8.3 MCP tools

An MCP `CallToolResult` may carry updates in `_meta["raw/panel"]`, either as one update object or as an array of update objects, with the same shape as §9. Raw ignores `_meta` keys it does not know. Other MCP clients ignore this one, so the server stays portable. `structuredContent` keeps its current meaning and is never read as a panel.

### 8.4 ACP-registered client tools

A `_raw/tool/call` response may include `{type:"panel", …}` items in `content`, but only when the client advertised `_meta.raw.panels: true` at initialization. Without that flag, panel items are rejected as unknown content, as they are today.

### 8.5 Host-originated updates

Only the owning tool writes a panel. The host itself changes only lifecycle flags (`stale`, §12). The model has no direct panel tool. It changes panels only by calling the owning tool.

## 9. Update operations and revisions

```jsonc
{ "panel": "todo", "op": "replace", "document": { … } }
{ "panel": "todo", "op": "patch", "base_revision": 4, "patches": [ … ] }
{ "panel": "todo", "op": "close" }
```

- **`replace`** sets the whole document. It is the first update of a panel, or any later full snapshot.
- **`patch`** applies an ordered list of patches atomically to the current document. A patch on a panel that does not exist yet fails with `panel_unknown`.
- **`close`** marks the panel closed (§12). The document is kept. A later `replace` reopens it.
- **`base_revision`** is optional. When it is present and differs from the current revision, the update fails with `panel_revision_conflict`. Without it, updates apply in arrival order (last writer wins). One session has one writer at a time, so this is only a guard for tools that run concurrently in one batch.

### Patch vocabulary

| Patch | Effect |
| --- | --- |
| `{ "op": "set", "field": "title"\|"subtitle"\|"status"\|"summary"\|"context_summary"\|"progress", "value": … }` | Sets a header field. `null` removes an optional field. |
| `{ "op": "set_block", "block": Block, "before"?: blockId }` | Replaces the block with the same `id`, or inserts it before `before` (default: at the end). |
| `{ "op": "remove_block", "id": blockId }` | Removes a block. An unknown ID is an error. |
| `{ "op": "upsert_items", "block": blockId, "items": [Item], "parent"?: itemId }` | Merges items by `id` into `checklist`, `steps`, `table` (rows), `key_value` (keyed by `key`) or `files` (keyed by `path`). Given fields replace, omitted fields keep their value. New items are appended, under `parent` for a checklist. |
| `{ "op": "remove_items", "block": blockId, "ids": [itemId] }` | Removes items. Removing a checklist item removes its children. |
| `{ "op": "append_events", "block": blockId, "events": [Event] }` | Appends events to a `timeline` and trims to `max`. |

After all patches apply, the resulting document is validated in full against §6, §7 and §14. Any failure rejects the **whole** update and the previous revision stays. This is the same all-or-nothing rule used for batch validation.

### Revisions

- The host assigns `revision = previous + 1` to each accepted update, starting at 1. A rejected update does not consume a revision.
- The dashboard and ACP use `revision` to discard out-of-order frames. `(full id, revision)` identifies a state uniquely within a session.

## 10. Model visibility and compaction

- **In the tool result.** The model sees only the text and JSON content the tool returned itself. If a tool returns **only** panel blocks, the host adds one text line so the model always gets confirmation: `panel <id> updated (revision N): <summary>`. For a rejected update, the host adds `panel <id> update rejected: <code> <message>`, so the model can correct itself (§15).
- **After compaction.** For every open panel whose declaration has `context: "summary"`, the host appends one durable tail reminder once the compaction succeeds. It uses the same mechanism as the skill-reload notice in `context.md`. The reminder text is:

  ```
  Current state of <title> (<owner>) at revision N:
  <context_summary, or the text rendering from §7 cut to 2048 bytes>
  ```

  The reminders together are capped at 8 KiB, and panels updated most recently come first. They are never added outside a successful compaction, so a normal turn's prefix and cache key do not change.
- **Actions.** When the user runs a `tool` action (§11), the model learns about it before its next request. The host appends a durable note: `The user ran "<label>" on <title>; <owner> returned: <text result, ≤ 1 KiB>`. It is appended with the next user message, so the provider message order stays valid.

## 11. Actions

Actions let the user change panel state or steer the agent, without free-form editing.

### Declaration fields

| Field | Rule |
| --- | --- |
| `id` | `^[a-z][a-z0-9_-]{0,31}$`, unique within the panel. |
| `label` | 1–32 characters. The button or menu text. |
| `scope` | `panel` (panel header menu), `block` (block header menu) or `item` (item hover menu). |
| `blocks` | Optional list of block IDs the action applies to. For `block` and `item` scope, the default is every block. |
| `kind` | `prompt` or `tool`. |
| `text` | For `prompt`. At most 2000 characters, templated. |
| `send` | For `prompt`. `false` (default) fills the composer. `true` sends it as a user message, and only when the session is idle. |
| `arguments` | For `tool`. A JSON object passed to the owning tool, templated. |
| `primary` | For an `item` action on a `checklist`. The item's status glyph becomes a button that runs this action. At most one per panel. |
| `confirm` | Optional string of at most 200 characters. The dashboard asks for confirmation with this text before running the action. |
| `when` | Optional `{ "status": [Status] }`. The action is offered only for items or blocks with those statuses. |

### Templates

`{{panel.id}}`, `{{block.id}}`, `{{item.id}}` and `{{item.label}}` are replaced **inside string values only**. There is no expression language, no escaping mode and no access to other fields. A template that cannot be resolved in the current scope makes the action unavailable.

### Execution

- **`prompt`.** Runs entirely in the browser. It fills or sends a user message, and no tool runs directly.
- **`tool`.** Creates a host operation of kind `panel_action` on the session, like compaction. It requires an idle session, and while busy the action is disabled with a tooltip. The operation then runs these steps in order:
  1. Resolve the template, then run `validateArgs` and the JSON Schema for the owning tool.
  2. Apply the agent's `tools.rules`. A `deny` rule hides the action. An `ask` rule shows the standard approval UI. `-y` or auto-approval never applies to a user action. The user's click is not treated as approval of an `ask` rule.
  3. Fire the `PreToolUse` and `PostToolUse` hooks with `source: "user_action"` in the payload.
  4. Call the handler with a context whose `toolCallId` is the operation ID.
  5. Apply the panel updates and commit a `panel_action` history record (§12) and the model note (§10).
- **Tool unavailable.** If the owner is no longer selected by the session's current agent, the panel is `stale` and every `tool` action is unavailable.
- **CLI and ACP.** CLI surfaces show no actions. ACP clients may call `_raw/panel/action` (§13.3).

## 12. Persistence and lifecycle

- **Latest state** lives in `session_panels`. The table is created with `CREATE TABLE IF NOT EXISTS`, following `session_runtime_metadata`, so no `user_version` bump is needed:

  ```sql
  CREATE TABLE IF NOT EXISTS session_panels (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    panel_id TEXT NOT NULL,            -- full id, owner#id
    owner TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    declaration_json TEXT NOT NULL,    -- snapshot of the declaration at the last update
    document_json TEXT NOT NULL,       -- ≤ 64 KiB, validated
    PRIMARY KEY (session_id, panel_id)
  );
  ```

- **History** gets a new visible kind, `panel_receipt`, with the payload `{ panel, owner, title, revision, summary, progress?, status, op, toolCallId, source: "tool" | "user_action" }`. It is about 1 KiB and is written in the same transaction as the tool result. Its position in history is right after that result. History never stores full documents: the chat is history, the panel is state (D1).
- **Compaction** never touches `session_panels` or receipts.
- **Retention and deletion** follow the session. Deleting a session cascades.
- **States.** `open`, then `closed` (by `close`), then `open` again (by `replace`). `stale` is derived, not stored: the owner is not in the current agent's selection, or its declaration no longer contains the panel ID. A stale panel stays readable and loses its actions.
- **Resume under a different agent or tool version.** The document is kept. The declaration used for display comes from the current manifest when the owner is still selected, and from the stored snapshot otherwise.
- **Limit reached.** When a session already has 16 panels, the first update to a new panel is rejected with `panel_limit`. The least recently updated closed panel is evicted first when one exists.

## 13. Surfaces

### 13.1 Dashboard

**Side panel structure**

- The right-hand inspector becomes the **side panel**, a tabbed container using the WAI-ARIA tabs pattern.
- **Tab order.** Tool panels come first, in the order they were created in this session. **Details**, the current inspector content, is always last. The order never reorders on update, so tabs do not jump.
- **Tab contents.** Each tab shows the declaration icon, the title, and one of two badges: an unseen dot when the revision is newer than the last one viewed in this browser, or `done/total` when progress exists.
- **Overflow.** Tabs beyond the width move into a `⋯` menu. Closed panels are listed there under "Closed".

**Header control**

- The Info button becomes a side-panel toggle, `aria-label="Side panel"` with a `PanelRight` icon.
- When a panel with progress exists, a compact chip beside it shows the most recently updated panel's `done/total`. Clicking the chip opens that tab.

**Opening**

- **Preference.** "Open the side panel for tool updates" is either **Follow the tool** (default) or **Never**.
- **Follow the tool.** A panel declared with `open: "first_update"` opens the side panel at that tab once per session per browser, on its first revision. Focus never moves. Later updates only set the unseen dot.
- **Narrow viewports.** The side panel is the existing modal drawer and never opens automatically.

**Chat receipts**

- A `panel_receipt` shows as a compact row under its tool result: icon, title, summary and a thin progress bar. Clicking it opens the tab. Receipts from `user_action` are labeled "You".

**Live and reload**

- The session stream gains event type `panel`: `{ panel, revision, closed, receipt?, document }`. It carries the full document (≤ 64 KiB) and is coalesced to 250 ms per panel.
- `snapshot` and `reset` frames include all panels, so reconnects are consistent. A frame with an older revision than the one shown is ignored.

**Accessibility**

- Tabs, trees and tables use native semantics. A polite live region announces `"<title>: <done> of <total> done"`, at most once every 5 s per panel. Everything is operable from the keyboard.
- The side panel passes the axe checks in light and dark themes, like the other dashboard surfaces.

**Stale and error states**

- A stale panel shows the banner "The tool that owns this panel is not selected by this agent." and disables its actions.
- A rejected update shows the notice "Update rejected: <code>" once in the tab, and the previous revision stays visible.

**HTTP API**

Full panel IDs are URL-encoded in paths.

| Route | Result |
| --- | --- |
| `GET /api/sessions/:id/panels` | `{ items: [{ panel, owner, title, icon, revision, updatedAt, closed, stale, declaration, document }] }` |
| `GET /api/sessions/:id/panels/:panel` | One item. `404 unknown_panel` if it does not exist. |
| `POST /api/sessions/:id/panels/:panel/actions` | Body `{ action, block?, item?, clientRequestId }`. Returns `202 { operationId }`, or an error: `404 unknown_panel`, `409 session_busy`, `409 stale_panel`, `422 invalid_action`, or `403 action_denied` when a policy rule is `deny`. |

These routes use the existing `DashboardError` shapes and the same origin and token checks as the other session routes.

### 13.2 CLI and REPL

- **Receipts.** After a committed update, the tool-result block gets one receipt line. It uses the glyphs from §6 and never depends on color: `  ▸ Todo r5 · 3/7 · Fix the API`. Streaming updates are not printed.
- **REPL.** `/panels` prints the text rendering of every open panel. `/panels <id>` prints one panel, and `/panels --all` includes closed ones.
- **`raw sessions panels ID [--json]`.** Prints the same output for a saved session without any model credential. It follows `raw sessions show`.
- **One-shot runs** print receipts to stderr only, so stdout remains only the answer.

### 13.3 ACP

- **Standard plan.** When a panel is declared with `acp_plan: true`, each committed update sends a standard `session/update` with `sessionUpdate: "plan"`. The entries come from the first `checklist` block, flattened depth-first: `content` is the label, `priority` defaults to `medium`, and `status` is mapped per §6.
- **Extension notification.** When the client advertised `_meta.raw.panels: true`, every committed update is also sent as the `_raw/panel/update` notification, with `{ sessionId, panel, owner, revision, closed, declaration, document }`.
- **Capability.** Raw advertises `panels: true` in its own `_meta.raw`.
- **`_raw/panel/action`.** The client sends `{ sessionId, panel, action, block?, item? }` and gets `{ operationId }`, with the same rules as §11. The extension error codes apply: `-32002` busy, `-32004` denied.
- **Replay.** `session/load` replays each receipt position with the plan update, or the extension notification, for the latest document at that time. The document is always the latest state, because history keeps only receipts. `session/resume` sends the current state once.

### 13.4 Library

- `getSessionPanels(sessionId)` returns the same items as the HTTP API.
- `RunEvent` gains `{ type: "panel_update"; panel; revision; document; closed; live: boolean }`.

## 14. Limits

| Limit | Value | On breach |
| --- | --- | --- |
| Panels declared per tool | 4 | manifest invalid |
| Actions per panel | 8 | manifest invalid |
| Open and closed panels per session | 16 | `panel_limit` (evicts the oldest closed panel first) |
| Document size, serialized UTF-8 | 64 KiB | `panel_too_large` |
| Blocks per document | 20 | `panel_invalid` |
| Items per `checklist` (including children), `table` rows, `files`, `timeline` | 200 | `panel_invalid` |
| `steps` items | 30 | `panel_invalid` |
| Checklist depth | 3 | `panel_invalid` |
| Updates accepted per panel per tool call | 200 | `panel_rate_limited` (later updates in that call are dropped, and the last accepted state stays) |
| Live frames per panel | 4 per second (250 ms coalescing) | coalesced, never rejected |
| Reminder after compaction, per panel and total | 2 KiB and 8 KiB | truncated with `…` |
| Receipt payload | 1 KiB | summary truncated |

## 15. Errors

An error never fails the tool call. The rules:

- **Result blocks and MCP.** The rejected update is dropped, and one line is added to the model-visible result (§10). The error is logged in the dashboard notice and the CLI receipt line as `▸ Todo update rejected: panel_invalid`.
- **Streaming `update()`.** The promise rejects with a `PanelError` that has `code` and `message`. The tool decides how to proceed. If it ignores the error, nothing else happens.
- **Actions.** HTTP and ACP errors follow §13.

| Code | Meaning |
| --- | --- |
| `panel_invalid` | The shape, a field, a limit on counts, or an ID fails validation. The message names the JSON pointer of the first error. |
| `panel_too_large` | The document exceeds 64 KiB after the update. |
| `panel_unknown` | `patch` or `close` targets a panel that does not exist. |
| `panel_not_owned` | The panel belongs to another owner. |
| `panel_undeclared` | A manifest tool writes a panel ID it did not declare. Implicit declaration applies only to MCP and ACP tools. |
| `panel_revision_conflict` | `base_revision` is stale. |
| `panel_limit` | The session has 16 panels and none is closed. |
| `panel_rate_limited` | More than 200 updates in one tool call. |
| `panel_closed_context` | `context.panels.update` was called after the handler settled. |

## 16. Security

- **Data only.** No markup is executed. Markdown uses the existing sanitizer. Links are limited to `http` and `https`, and nothing is fetched: no images, no link previews, and no resolution of file refs on the server.
- **File refs** are text until the user clicks them. A click only inserts `@path`, which then follows the existing file-reference rules and their size limits.
- **Ownership.** An owner can write only its own panels (`panel_not_owned`). The full ID includes the canonical identity, so aliases (`as`) cannot impersonate another tool.
- **Actions** are declared statically: the dashboard cannot invent arguments beyond the template slots. Every `tool` action passes schema validation, `tools.rules`, approval and hooks, with no auto-approval. A panel adds no capability the tool did not already have.
- **Sizes and rates** are bounded (§14) before any storage or broadcast.
- **Isolation.** Panel content is session data under the same private store and dashboard token as the rest of the session.

## 17. Versioning and compatibility

- **Protocol ID.** The protocol is `raw.panel/1`. A package whose tools declare panels lists `raw.panel/1` in its required capabilities, the same way `raw.hook/1` is listed. Installing it into an older Raw fails at install time with an explicit message.
- **Additive, compatible changes.** New block kinds, new optional block or item fields, new icons and new patch ops. A host that meets an **unknown block kind** renders its `fallback` text, or `Unsupported block "<kind>"` when there is none. The rest of the document stays valid. Unknown **fields** inside a known block are rejected, so typos surface.
- **Breaking changes** need `raw.panel/2`. Tools select the protocol by feature detection (`context.panels.protocol === 1`) and through package capabilities.
- **`tool.json`** keeps `api_version: 1`. An older Raw rejects a manifest that has `panels` with `invalid tool manifest`, which is the existing strict behavior. The package capability check makes this failure early and clear.
- **Clients.** An old dashboard bundle ignores `panel` stream events, because unknown event types are ignored. Standard ACP clients see only `plan`.

## 18. Reference tool: `builtin/todo`

The reference tool proves the contract end to end.

### Model-facing contract

| | |
| --- | --- |
| **ID and name** | `builtin/todo`, model-facing name `todo`. |
| **Selection** | Opt-in through `tools.use` like every tool (D11). |
| **Description** (summarized) | Tracks a multi-step task as a todo list the user can see. Use it for work with 3 or more distinct steps, or when the user gives several tasks. Create the list before starting. Keep exactly one item `in_progress` while working. Mark an item `done` immediately after finishing it, not in batches. Add discovered work as new items. Do not use it for a single trivial step. |

**Input schema**

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["todos"],
  "properties": {
    "mode": { "enum": ["replace", "merge"], "default": "replace",
      "description": "replace sets the whole list; merge updates or adds only the given items by id." },
    "title": { "type": "string", "maxLength": 80, "description": "Optional list title, e.g. the task name." },
    "todos": {
      "type": "array", "maxItems": 100,
      "items": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "pattern": "^[a-z0-9_-]{1,32}$",
            "description": "Stable item id. Omit when adding a new item in replace mode; required in merge mode." },
          "content": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Imperative task text." },
          "status": { "enum": ["pending", "in_progress", "done", "blocked", "skipped"] },
          "parent": { "type": "string", "description": "Id of a top-level item this is a subtask of." },
          "note": { "type": "string", "maxLength": 500 },
          "remove": { "const": true, "description": "Merge mode only: delete this item and its subtasks." }
        }
      }
    }
  }
}
```

**Semantic validation** (`validateArgs`, applied to the whole call before anything runs):

- **Replace mode.** `content` and `status` are required for every item. `remove` is not allowed.
- **Merge mode.** `id` is required for every item. An unknown `id` requires `content` (it adds an item).
- **Structure.** After applying, at most one item may be `in_progress`. `parent` must refer to a top-level item, so depth is at most 2. IDs must be unique. The list may hold at most 100 items.
- **Invalid calls** return an error result, and the panel is unchanged.

### Behavior

- **Replace.** A new ID (`t1`, `t2`, …) is assigned to each item without one. The IDs never reuse a number within the session, so the model can refer to them later.
- **Merge.** Reads the current state through `context.panels.get("todo")`, applies the items in order, and publishes the result.
- **Publishing.** The handler publishes the panel `todo` with `op: "replace"`:
  - one `checklist` block with id `items`;
  - `title` taken from the input or kept from before;
  - `status: "done"` when every item is `done` or `skipped`;
  - `context_summary` as the compact text list.
  If the host has no `context.panels` (an older host), the tool still works and simply returns text.
- **Model-visible result.** A text rendering of the whole list with its IDs, so the model always has current IDs:

  ```
  Todo (3/7 done):
  [x] t1 Write the failing test
  [~] t2 Fix the API
    [ ] t2.a Validate input
  [ ] t3 Update docs
  ```

  Children get IDs of the form `<parent>.<letter>` when the model omits them.
- **Scope.** The state is per session. There is no file I/O and no side effects outside the panel. The policy default is `allow`, and the tool is harmless to auto-approve.

### Panel declaration

- **Settings.** `open: "first_update"`, `context: "summary"`, `acp_plan: true`, icon `list-checks`.
- **Actions:**
  - `complete`: `item` scope, `primary`, `kind: tool`, arguments `{"mode":"merge","todos":[{"id":"{{item.id}}","status":"done"}]}`, offered `when: {status: ["pending","in_progress","blocked"]}`.
  - `reopen`: `item`, `tool`, sets `pending`, offered `when: {status: ["done","skipped"]}`.
  - `skip`: `item`, `tool`, sets `skipped`.
  - `continue`: `panel`, `prompt`, `send: false`, text "Continue with the next pending todo item."
  - `clear_done`: `panel`, `tool`. It needs a host-side list of IDs, which templates cannot express, so the tool accepts the special input `{"mode":"merge","todos":[],"clear":"done"}`. The schema therefore adds an optional `"clear": {"const":"done"}`, valid only in merge mode.

### What each surface shows

| Surface | Todo |
| --- | --- |
| Dashboard side panel | The "Todo" tab with `3/7`. A checklist tree where clicking a glyph marks the item done. The header menu has Continue and Clear completed. |
| Dashboard chat | Receipt `Todo · 3/7 · Fix the API` under each `todo` call. |
| Header chip | `3/7`, which opens the tab. |
| CLI | Receipt line after each call. `/panels todo` prints the list. |
| ACP | A standard `plan` update, which Zed and other ACP clients show natively. |
| Model after compaction | The reminder "Current state of Todo (builtin/todo) at revision N: …". |

## 19. Example third-party tool: spec runner

This example shows the contract carrying a richer workflow with no new host code. An `agent/spec` tool reads `specs/<name>.md`, runs its acceptance checks and reports.

- **Declaration.** One panel `spec`, icon `flag`, `open: "first_update"`, `context: "summary"`. Actions:
  - `rerun`: `panel`, `tool`, `{"spec":"{{panel.id}}","only":"failed"}`.
  - `rerun_item`: `item`, `tool`, `{"only":"{{item.id}}"}`.
  - `explain`: `item`, `prompt`, text "Explain why {{item.label}} fails and propose a fix."
- **Document.**
  - `steps` "Phases": Parse, Plan, Implement, Verify.
  - `checklist` "Acceptance criteria", one item per criterion, with `ref` to the spec line.
  - `table` "Checks": test name, result and time, with `status` per row.
  - `files` "Touched": the files changed.
  - `timeline` "Log": check events.
- **Streaming.** During a long verification the tool calls `context.panels.update("spec", {op:"patch", patches:[{op:"upsert_items", block:"criteria", items:[{id:"ac3", status:"done"}]}, {op:"append_events", block:"log", events:[…]}]})` as each check finishes. The user watches the criteria turn green live.

## 20. Decisions

### D1. The chat is history, the panel is state
Full documents live only in `session_panels`. History gets small receipts. This keeps history bounded however often a tool updates, and gives the panel one obvious source of truth.

### D2. Tools publish typed data, the host renders a fixed catalog
Eight widgets cover todo, plan, spec, test, file and log use cases (§7). A tool author writes no UI, and every surface renders the same data, including as text. New needs extend the catalog with an additive protocol change.

### D3. A dedicated panel store, not a replay of tool results
Visible history keeps only bounded previews, and compaction reclaims full model-only tool results (`context.md`). Replaying tool results would lose state after a compaction or a large result. The panel store is independent of both.

### D4. Two emission paths, one pipeline
Result blocks work for every tool, including remote MCP and ACP tools. `context.panels` adds live progress for long-running local tools. Both go through `PanelHost`, so validation, ownership, limits and revisions cannot diverge.

### D5. Panel data never reaches the model directly
Panel bytes are stripped before capping and provider mapping. The model sees the tool's own text, a one-line confirmation, and after compaction an opt-in, bounded reminder. The normal prompt prefix and cache key are unchanged.

### D6. Snapshots plus a small patch vocabulary, with host revisions
`replace` is simple and robust for models and small tools. Patches keep live streaming of large documents cheap. Host-assigned revisions give ordering and conflict detection without clocks.

### D7. Actions are declared and routed through the tool boundary
A `tool` action is a real tool call with `source: "user_action"`, under the same schema, rules, approval and hooks as a model call, with no auto-approval. A `prompt` action only drafts or sends a user message. Panels therefore add no new capability or trust path.

### D8. Ownership by canonical identity
`<owner>#<id>` prevents one tool from overwriting another tool's panel. Presentation aliases cannot impersonate an owner.

### D9. Open quietly by default
The tool can hint `first_update`, the user preference decides, focus never moves, and narrow viewports never open automatically. Later updates only set a dot. This avoids a panel stealing attention on every step.

### D10. Degrade, never block
Invalid updates are dropped with a visible notice, and the tool call still succeeds. Unknown blocks fall back to text. Older hosts, clients and dashboards keep working. A tool without `context.panels` still returns text.

### D11. `builtin/todo` is opt-in
Like every tool, it loads only when `tools.use` selects it. Adding it to the starter agent would change the starter's tool schemas and cache key. That is a separate product decision.

### D12. Map to ACP's standard plan
Standard ACP clients get todo progress natively through `plan`. Richer panels need the negotiated `_raw/panel/*` extension, following the existing `_raw/*` pattern.

## 21. Alternatives rejected

- **Tool-supplied HTML or iframes (the MCP Apps style).** Arbitrary code in the dashboard origin conflicts with the CSP nonce model and cannot be rendered in the CLI or in standard ACP.
- **Showing progress only inline in the chat.** Progress scrolls away in long chats, and there is no single "where are we" view.
- **Only a side panel, with no chat receipts.** The timeline would lose when and why state changed.
- **Workspace-scoped panels.** They need cross-session ownership and conflict rules. Files in the workspace already serve that role.
- **JSON Patch (RFC 6902) as the patch language.** It is too general for models and tool authors. Operations addressed by item ID are safer and easier to validate.
- **A model-facing "panel" tool.** Any model could then write any panel without the owning tool's validation. Panels belong to tools.
- **Storing every revision in history.** History grows without bound for chatty tools, and the full snapshots add nothing beyond receipts.
- **Images in panels.** Payload lifecycle and size questions have no use case in `raw.panel/1`. `view_image` and the tool result already carry images.

## 22. Implementation outline and verification map

The outline is for a later `loop-plan`. Each phase is one commit, and every phase keeps all existing gates green.

1. **Core.** Types, `schemas/raw-panel.schema.json`, validator, patch engine, `PanelHost`, `session_panels`, `panel_receipt`, result-block stripping and model confirmation lines, and `context.panels`.
2. **Declarations.** The `panels` manifest field, package capability `raw.panel/1`, MCP `_meta["raw/panel"]`, ACP registration `panels`, and the stale derivation.
3. **`builtin/todo`.** Manifest, handler and validator, `examples/tools/todo`, and `tools.md`.
4. **Dashboard read path.** Side-panel tabs, all eight widgets, receipts, the header chip, the SSE `panel` event and snapshot, the open preference, the unseen dot, and axe checks.
5. **Actions.** The `panel_action` operation, the HTTP route, approval and hooks with `source`, the model note, and the dashboard action UI.
6. **CLI and ACP.** Receipt lines, `/panels`, `raw sessions panels`, ACP `plan`, `_raw/panel/update` and `_raw/panel/action`, and replay.
7. **Compaction reminder.** Plus final docs: `dashboard.md`, `dashboard-api.md`, `acp.md`, `cli.md` and `context.md`.

| Decision | Planned evidence |
| --- | --- |
| D1, D3 | Store tests: the document survives compaction and restart, history has receipts only, and delete cascades. |
| D2 | Validator tests per block kind, with the limits of §14 and the text rendering of each kind. Playwright renders each widget in 3 browsers with axe. |
| D4 | The same update via a result block, `context.panels`, MCP `_meta` and an ACP tool yields identical stored documents and revisions. |
| D5 | Provider request snapshots contain no panel bytes, and the cache key is unchanged by panel-only updates. |
| D6 | Patch engine tests: atomic rejection, `base_revision` conflict, `upsert_items` merge semantics, and timeline trimming. |
| D7 | Action tests: `deny` hides the action, `ask` prompts even with `-y`, hooks see `source: "user_action"`, and the model note appears before the next request. |
| D8 | `panel_not_owned` for cross-owner writes, including through an `as` alias. |
| D9 | Playwright: `first_update` opens once without moving focus, "Never" is respected, and narrow viewports stay closed. |
| D10 | An invalid update leaves the tool result successful with a rejection line, an unknown kind renders its fallback, and `todo` works without `context.panels`. |
| D11 | The starter config is unchanged. `builtin/todo` loads only when selected. |
| D12 | An ACP test client receives `plan` with mapped statuses, and receives `_raw/panel/update` only after negotiation. |
