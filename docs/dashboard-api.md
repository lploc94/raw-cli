# Dashboard HTTP contract

The dashboard serves a bundled application and a small local API. Every `/api` route requires `Authorization: Bearer TOKEN`. Host must match the actual `127.0.0.1:PORT` listener; a browser Origin must exactly match its HTTP origin. Missing or foreign authorization/origin is rejected. Query-string tokens are never accepted. Responses do not permit cross-origin reading or embedding.

Ordinary JSON requests are at most 1 MiB and use `Content-Type: application/json`. Errors have `{ "error": { "code": "...", "message": "...", "details": ... } }`. Statuses distinguish malformed input (400), missing authentication (401), forbidden origin/host (403), missing resources (404), state/revision conflicts (409), oversized bodies (413), invalid candidates (422), unavailable capabilities (503) and internal failures (500).

`GET /api/bootstrap` returns `apiVersion`, `version`, `instanceId`, `cwd`, `configPath`, optional `preferredAgent`, safe config metadata (`exists`, `revision`, `canonical`, `valid`, optional `diagnostic`, agent/model alias lists and `defaultAgent`) and store readiness/diagnostic. It does not return credentials, raw config, conversation text or lease tokens and does not instantiate a runtime.

Only defined browser routes return the application entrypoint on refresh. Unknown API paths, missing static assets and unknown page routes return their actual errors. Static files are contained in the installed `dist/dashboard` directory; config/source files are never served through static routes.

The entrypoint receives a fresh style nonce matching its response CSP. This permits styles created by the bundled dialog/editor libraries while inline scripts and unrelated inline styles remain blocked. The nonce is independent of the access token; all scripts and network connections remain restricted to this origin.

Further session, stream and management schemas are specified alongside their adapters in the shared TypeScript contract. API versioning is separate from session persistence compatibility.

## Sessions and operations

- `GET /api/workspaces` returns `{items, home, current}`. Each item is `{cwd, updatedAt, sessions, running, exists}`: a recently used stored directory (newest first, at most 100) or the invoking directory (`current`, always present; `updatedAt: 0` when it has no chats). `sessions` counts the retention-visible chats in that directory, `running` counts its operations that have not finished, and `exists` is false when the path is gone or is not a directory. `home` is the user's home directory. Repeat `include=<path>` (up to 50 values of at most 4096 characters; `~` is expanded) to add directories that are not among the recent ones, for example pinned folders: they carry the same fields (real counts and time when they have stored chats, zeros when not) and never create a workspace record. A malformed `include` returns 400 `invalid_input`.
- `POST /api/workspaces/validate` accepts `{cwd}` and validates an existing directory, returning its canonical path.
- `GET /api/workspaces/browse?path=&hidden=&q=` lists the sub-directories of a directory so the browser can offer an "Open folder" picker. It is a **read-only directory listing**: only directory names are returned, never file names, sizes, times or contents, and nothing is created or changed. `path` is absolute or starts with `~` (default: the home directory). The response is `{path, parent, home, entries, truncated}`: `path` is the canonical directory, `parent` is its parent or `null` at the filesystem root, and `entries` are `{name, path, symlink?}` sorted case-insensitively. A symlink that resolves to a directory is listed with `symlink: true`; other symlinks are omitted. Dot-directories are omitted unless `hidden=1`; `q` keeps names containing it (case-insensitive, at most 200 characters). At most 500 entries are returned and `truncated` is true when more matched. A relative, missing or non-directory `path` returns 400 `invalid_workspace`; a directory the dashboard cannot read returns 422 `unreadable_directory`; a malformed `hidden` or `q` returns 400 `invalid_input`. Choosing a workspace changes relative runtime paths, not OS filesystem permissions.
- `GET /api/sessions?cwd=&title=&before=&limit=` uses opaque keyset cursors (default 20, maximum 100). Search is title-based. `POST /api/sessions` accepts `{cwd, agent?}` and creates an empty saved session without inference.
- `GET /api/sessions/:id` returns the session, latest chronological history page, history watermark, current/last metrics, context summary, recent operation receipts and ownership (`idle`, `here`, `elsewhere`). `GET /api/sessions/:id/history?before=&limit=` loads older history. `PATCH` the session with `{title}` renames it; `DELETE` refuses an active writer.
- `POST /api/sessions/:id/operations` accepts `{clientRequestId, kind:"turn"|"compact", agent, input?}`. The displayed server config is authoritative. It returns the durable receipt with 202; a matching duplicate returns the original receipt. A reused ID with different intent is 409. Manual compact has no user input.
- `GET /api/sessions/:id/operations?clientRequestId=` finds a receipt after a lost submit response; omitting the ID returns recent receipts. `GET /api/operations/:id` reads one receipt. `POST /api/operations/:id/cancel` cancels only work owned here. No GET, refresh or reconnect submits work.
- `GET /api/sessions/:id/metrics` returns `{metrics, metricsStale}`. Missing measurements are null/absent, never zero by invention. `metrics.context.estimatedTokens` is the provider's own count of the last response (`context.source` is `provider`) or, when none applies, a byte estimate (`estimate`; absent in measurements saved by older releases). A measurement carries its time and history watermark; later external history makes it stale. `metrics.capabilities`, when available, lists the tools, skills and variable names selected by that runtime, without values or credentials. The session snapshot separately includes `{context:{summary?,messageCount}}`.

### Attachments, file references and composer metadata

- `POST /api/sessions/:id/attachments` stages one upload. The body is the raw file with `Content-Type` set to its type (`image/png` or `image/jpeg` today) and an optional URL-encoded `X-Raw-Filename`. The server picks the registered attachment kind from the content type, validates the bytes (an image must be a structurally valid PNG/JPEG of the declared type) and returns 201 `{id, kind, name, mimeType, byteSize}`. Errors: 415 `unsupported_media_type`, 400 `invalid_attachment`, 413 `attachment_too_large` (over the kind's limit, 8 MiB for images) and 413 `attachments_too_large` (this chat already stages 8 items or 16 MiB, or the server stages 128 MiB). A rejected upload never affects items already staged or the text draft. Staged items live in memory for 30 minutes and are dropped when the dashboard stops.
- `DELETE /api/sessions/:id/attachments/:attachmentId` returns `{removed}`.
- `POST /api/sessions/:id/operations` also accepts `attachments` (up to 8 staged ids) and `files` (up to 20 workspace-relative paths) on a turn. `input` stays required text. The server builds the model input as the text, then one `resource_link` per file, then the attachment blocks (images). Unknown, expired or other-session ids return 422 `unknown_attachment`; a path outside the workspace, a missing path, a directory or a symlink that leaves the workspace returns 422 `invalid_file`. Both are refused before the operation is accepted and consume nothing. Staged items are consumed only when a new operation is accepted; a duplicate `clientRequestId` returns the original receipt and leaves staged items untouched. Attachments are not accepted on `compact`. Image bytes are never stored on the operation receipt (the receipt keeps the text).
- `GET /api/agents/:name/composer` also returns `controls`: the request settings a turn may override for that agent's provider, `[{id, label, kind, options:[{value, label, hint?}], current?}]`. `id` is `effort` (label `Effort` for Anthropic, `Reasoning` for OpenAI and DeepSeek, `Thinking` for Google; levels in ascending order) or `serviceTier` (OpenAI `auto, default, flex, fast, priority`; Anthropic `auto, standard_only`; hints describe cost and speed). `current` is the value configured on the agent. Providers without such settings return `[]`. Options are the provider-level enums, not filtered per model.
- A turn may carry `request: {effort?, serviceTier?}`. It applies to that operation's provider request only, is merged over the agent's configured `request` (DeepSeek `effort` also enables `thinking`; Google `effort` replaces `thinking_budget`), and is never written to config or to the operation receipt. A replayed `clientRequestId` returns the original receipt before `request` is validated. For a new request id, an unknown key, a value outside the agent's options, or any `request` on a provider without controls returns 422 `invalid_request_option`; `request` on `compact` returns 400 `invalid_input`. If the provider rejects the chosen value, only that operation ends in `error` with the provider's message.
- History user items carry `text` (the text blocks only) and, when the message had non-text blocks, `attachments: [{index, kind, name, mimeType, byteSize}]` in stored block order (`kind` is `image`, or `file` for a `resource_link`). Metadata never contains bytes; snapshots and SSE events never embed base64.
- `GET /api/sessions/:id/history/:sequence/attachments/:index` returns the stored bytes of one attachment of a user history item, any age (it reads that single item by sequence, not a history page). The block is dispatched through the server attachment-kind registry (`fromBlock`), and the response carries the stored `Content-Type`, `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=3600` and `Content-Disposition: inline`. 404 for a non-user item, an out-of-range index, or a block no registered kind can serve (for example a `resource_link`). The route needs the Bearer header like every API route, so the web client fetches it with `fetch` and renders a `data:` URL; no CSP change is needed.
- A model without `vision` never causes an error: its request carries a text placeholder in place of each image, and the saved session keeps the original image (see `providers.md`).
- `GET /api/sessions/:id/files?q=&limit=` searches the session workspace for files to reference (default 20, maximum 50). Results are fuzzy-ranked `{items:[{path,name}]}`; `.git`, `node_modules`, dot entries and symlinks are skipped and the walk is bounded.
- `GET /api/agents/:name/composer` returns `{vision, skills:[{name,description}], attachmentKinds:[{id, accept, maxBytes, enabled, warning?}]}`. `skills` are the agent's selected skills (available before any turn), `vision` is the agent's model setting, and `warning` explains the placeholder fallback when an attachment kind needs vision the model lacks. It needs no credentials; an unknown agent returns 404.

## Streams and approvals

`GET /api/sessions/:id/events` is authenticated fetch-SSE. Event IDs combine server instance and session sequence. Supply the last ID through `Last-Event-ID` to replay retained events. Initial connections get a snapshot. Expired/foreign cursors get a reset snapshot; clients merge durable history by sequence/segment ID and replace transient state. The snapshot watermark and subsequent publication share one host ordering boundary.

Every envelope contains `instanceId`, `sessionId`, `sequence`, `type`, `data` and an `operationId` when applicable. Types cover snapshots, committed history, text/reasoning segments, tool state, operation state, compaction, metrics, approvals and host errors. History records are authoritative once committed. Tool call IDs are scoped to the turn/operation; segment IDs survive their live-to-history transition. A terminal operation event follows durable terminal persistence and runtime cleanup.

Chat view receipts carry `view: ToolViewIdentity`. Fetch one committed snapshot with `GET /api/sessions/:id/views/:instanceId`; an unknown or another session's instance returns 404. The response adds `presentation: { declaration, stale }` for current action availability: current declarations supply actions, deny hides tool actions, and deselection disables them. This projection never changes the persisted snapshot. Panel stream frames for chat include the same `view` identity and declaration. They render provisionally at that call, without changing sidebar state or preferences; committed history replaces them, and terminal/reset events clear abandoned provisional views. Historical snapshots never resolve through the latest sidebar state. Both destinations use the shared tool-view renderer. Document bounds remain 64 KiB per view; history paging does not eagerly hydrate all snapshots.

`POST /api/sessions/:id/views/:instanceId/actions` accepts the same action body as sidebar actions. The host binds templates to that historical document, checks the current tool declaration, and runs the action through the existing policy/hook/approval operation path. Any resulting chat update creates a new instance; the original snapshot is immutable. Request deduplication includes the view instance identity. Prompt actions use the snapshot locally in the browser.

Replay retains at most 4096 events and 4 MiB per observed session. Large live text uses private temporary files (64 MiB per operation) and 8 KiB previews; `GET /api/sessions/:id/output?operationId=&segmentId=&offset=` reads UTF-8 pages (maximum 64 KiB) while that segment is live. Byte offsets must lie on character boundaries. Live output is presentation state, never a replacement model transcript. Slow readers resnapshot instead of blocking inference. A preview limit/error is explicit; completed saved history remains authoritative. Temporary output is removed when history commits or at operation/server cleanup; abandoned owned directories are reclaimed after their process is gone.

Pending approval includes a random approval ID, operation ID, tool call ID, exact arguments and deadline. `POST /api/permissions/:approvalId` accepts `{operationId, callId, allow}`. The first valid answer wins; duplicates/stale answers return 409. Expiry/cancellation resolves the request without consent. Matching registry `ask` rules create approvals; safe permitted Bash calls produce none.

Stop requests cancellation; the receipt becomes terminal after owned startup/runtime cleanup finishes. Concurrent MCP initialization failure and host cancellation share one transport-close promise, and a stdio child must report close before that cleanup settles.

`GET /api/activity` returns bounded metadata for this server's active/recent operations and pending approval identities. It excludes transcript and argument bodies. Polling never starts a runtime, renews retention or extends approval deadlines. Work owned by another CLI/ACP process has committed-history refresh only, without fabricated live deltas or control rights.

### Tool panels

Tools may publish side panels ([panels-design.md](panels-design.md)). Snapshot and reset frames (and `GET /api/sessions/:id`) carry `agent` (the session's saved agent, or `null`) and `panels`, the committed stack for that agent; they are authoritative and replace all panel state on the client, even when a revision is lower than one shown before.

- `GET /api/sessions/:id/panels[?agent=NAME]` returns `{ agent, items }`. Each item is `{ panel, owner, title, icon, revision, updatedAt, closed, stale, declaration, document }`, where `panel` is the full id `<owner>#<panel id>` (URL-encode it in paths). Order: declared panels (tool.json panels in `tools.use` order, then config MCP panels), then implicit panels by creation time, then stale panels that still hold data. A declared panel without data has `revision: 0`, `updatedAt: null` and `document: null`. `stale` is computed against `agent`; an unknown agent returns `422 unknown_agent`.
- `GET /api/sessions/:id/panels/:panel` returns one item, or `404 unknown_panel`.
- `POST /api/sessions/:id/panels/:panel/actions` with `{ action, agent, block?, item?, clientRequestId }` runs a declared **tool** action ([panels-design.md](panels-design.md) §11) as a `panel_action` operation and returns `202 { operationId }`; `prompt` actions run in the browser and are refused here. The call goes through the normal tool dispatch, so `allow`/`ask`/`deny` rules, approvals and hooks apply; a click is never approval for an `ask` rule. A replay of the same `clientRequestId` returns the same operation. Errors: `404 unknown_panel`; `409 session_busy` (another operation runs), `409 stale_panel` (the saved agent no longer selects the owning tool), `409 agent_mismatch` (`agent` is not the session's saved agent); `403 action_denied` (a `deny` rule); `422 invalid_action` (unknown action, or scope, `blocks`, `when` or item does not match the current document). The action never calls the model; its outcome is stored as a note that is prepended once to the next user message. `POST /api/sessions/:id/operations` rejects kind `panel_action`.
- Stream event `panel`: `{ panel, owner, revision, closed, live, document }` with the whole document (at most 64 KiB). At most one frame per panel every 250 ms; a newer state replaces one that is still waiting, so the last state is always delivered. `live: true` frames are provisional until a `live: false` frame for a committed revision arrives. A frame whose revision is not greater than the one shown is ignored between snapshots.
- Declarations are read from manifests and config only: no tool is imported and no MCP server is started. If the agent's declarations cannot be read, every stored panel is still listed and none is marked stale. Panels never change config bytes or OS permissions.

## Management

All paths below are relative to `/api`. Writes use the displayed config authority.
`revision` is the content hash returned by the corresponding read. A stale write
returns `409 conflict` with `error.details.revision`; it never overwrites the file.
Validation failures return `422 invalid_input` and leave disk unchanged.

| Method / path | Request and result |
| --- | --- |
| GET `/config` | Path, canonical flag, revision, existence/validity, default agent, resource names and safe model metadata; no literal credentials or variable readings |
| POST `/config/initialize` | Shared CLI starter; fails if the file already exists |
| GET `/config/document` | Explicit advanced editor: full `{source, revision, path, canonical, exists, diagnostic?}` held only in editor memory |
| PUT `/config/document` | `{revision, source}`; strict JSON, validated at the actual config path |
| POST `/config/validate` | `{source}`; static validation only |
| PATCH `/config` | `{revision, patch}`; top-level replacement, `null` removes a field; absent fields preserved |
| GET `/agents/:name`, `/models/:name` | Explicit resource editor `{value, revision}`; model keys omitted, with credential presence/reference metadata |
| POST `/agents`, `/models` | `{revision, action, name, value?, newName?, credential?}`; create/patch/duplicate/rename/delete/default (default only for agents) |
| GET `/components/:kind` | Passive catalog (`tools` or `skills`), provenance, usages and per-row validation |
| GET `/components/:kind/:id` | Component detail; ID URL-encoded as one segment |
| POST `/components/:kind` | `{id, files}` to create, or `{id, cloneFrom}` to fork; no implicit selection |
| GET/PUT `/components/:kind/:id/file?path=...` | Read `{source,revision}` or save `{source,revision}`; contained owned text file only |
| POST `/components/:kind/:id/selection` | `{agent,revision,selected}`; attach/detach, skill prerequisites checked |
| DELETE `/components/:kind/:id` | Refuses used/read-only assets; does not remove sessions |
| POST `/policy/test` | `{identity,rules,args}`; returns effective `effect` using runtime policy, without dispatching a command |
| POST `/checks` | `{kind:"var"|"mcp",agent,name,revision}`; returns `202` receipt with ID; explicit execution only |
| GET `/checks/:id` | State (`running/completed/error/cancelled`), result/error; no rerun on GET |
| POST `/checks/:id/cancel` | Cancels owned check; terminal state follows provider/MCP cleanup |
| GET `/diagnostics` | Allowlisted version/platform/config/store counts, no transcript, credentials, env/header values, command arguments or check readings |

Model credential changes use `{mode:"keep"}`, `{mode:"clear"}`, or
`{mode:"set",value:"..."}` / `{mode:"set",env:"ENV_NAME"}`. A missing credential
operation means keep; masked placeholders are never written. Full section edits
for vars/providers/MCP and advanced settings use the explicit document editor.
Checks have a fixed 30-second deadline, at most eight concurrent jobs and bounded
in-memory receipts; disconnect does not restart a check. MCP checks discover and
validate advertised schemas, never invoke a tool, and close the connection before
completion. Variable checks obey the selected agent's access contract and use a
fresh resolver (returned `cached` is honest; runtime TTL caching is independent).

## Portable packages

Package routes share the config authority and existing package lock/digest store.
They never import tool code, run install hooks, resolve vars or connect to MCP.
Installation and activation are separate actions.

| Method / path | Contract |
| --- | --- |
| GET `/packages` | Installed aliases, provenance/digest, reports and per-alias diagnostics |
| GET `/packages/:alias` | Report, manifest input schema and current config usages |
| POST `/packages/inspect` | `{path}`; snapshot a local source directory or `.rawpkg` into private staging, validate and return a stage receipt |
| POST `/packages/upload` | `application/octet-stream` archive bytes, streamed with the existing 128 MiB archive limit; validate before creating a receipt |
| GET `/packages/stages` | Current process temporary receipts for review/discard |
| DELETE `/packages/stages/:id` | Discard temporary artifact |
| GET `/packages/stages/:id/download` | Authenticated `.rawpkg` download |
| POST `/packages/install` | `{stageId,alias,action:"install"|"update"|"link"}`; link requires the explicitly inspected local directory |
| POST `/packages/:alias/agent` | `{revision,name,exportName,model,inputs}`; validate bindings and create a recipient agent without changing the default |
| POST `/packages/:alias/component` | `{revision,kind,exportName,agent?,name?,inputs?,as?}`; tools/skills append a selection to a direct agent; vars/providers/MCP create an explicit root binding (vars may also select on an agent) |
| POST `/packages/export` | `{revision,agent,name,version,includeLiterals?,includeFiles?}`; export with SDK decisions, pack and return a downloadable stage/report |
| POST `/packages/:alias/fork` | `{out}`; copy the installed package into an empty/new authored directory |
| DELETE `/packages/:alias` | Refuse current dependents; remove the alias only, keeping stored artifacts |

Staged receipts contain `{id,report,inputs,sha256,bytes,canLink,expiresAt}`. Imports
install the inspected snapshot, even if the author changes the source afterward.
Link explicitly opts into later authored changes. At most four stages are retained
for 30 minutes in a server-owned private temporary directory; a full staging area
asks the user to discard an artifact. Shutdown waits for owned file work and
cleans temporary artifacts. Malformed/interrupted/oversized uploads never publish
an alias. A downloaded archive is independent of the staging lifetime.

Package inputs use the existing manifest schema (`type`, enum/default/description
and `x-raw-kind`); no browser-specific binding format is introduced. Agent bindings
use recipient-owned model aliases. Package-agent selection overrides remain
complete replacements and are edited explicitly in Agents rather than silently
merged. A failed update keeps the last valid alias and config. Prior digest
artifacts remain in the package store for an explicit CLI/SDK rollback.
