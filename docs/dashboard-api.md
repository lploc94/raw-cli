# Dashboard HTTP contract

The dashboard serves a bundled application and a small local API. Every `/api` route requires `Authorization: Bearer TOKEN`. Host must match the actual `127.0.0.1:PORT` listener; a browser Origin must exactly match its HTTP origin. Missing or foreign authorization/origin is rejected. Query-string tokens are never accepted. Responses do not permit cross-origin reading or embedding.

Ordinary JSON requests are at most 1 MiB and use `Content-Type: application/json`. Errors have `{ "error": { "code": "...", "message": "...", "details": ... } }`. Statuses distinguish malformed input (400), missing authentication (401), forbidden origin/host (403), missing resources (404), state/revision conflicts (409), oversized bodies (413), invalid candidates (422), unavailable capabilities (503) and internal failures (500).

`GET /api/bootstrap` returns `apiVersion`, `version`, `instanceId`, `cwd`, `configPath`, optional `preferredAgent`, safe config metadata (`exists`, `revision`, `canonical`, `valid`, optional `diagnostic`, agent/model alias lists and `defaultAgent`) and store readiness/diagnostic. It does not return credentials, raw config, conversation text or lease tokens and does not instantiate a runtime.

Only defined browser routes return the application entrypoint on refresh. Unknown API paths, missing static assets and unknown page routes return their actual errors. Static files are contained in the installed `dist/dashboard` directory; config/source files are never served through static routes.

The entrypoint receives a fresh style nonce matching its response CSP. This permits styles created by the bundled dialog/editor libraries while inline scripts and unrelated inline styles remain blocked. The nonce is independent of the access token; all scripts and network connections remain restricted to this origin.

Further session, stream and management schemas are specified alongside their adapters in the shared TypeScript contract. API versioning is separate from session persistence compatibility.

## Sessions and operations

- `GET /api/workspaces` lists recent stored directories and the invoking directory. `POST /api/workspaces/validate` accepts `{cwd}` and validates an existing directory.
- `GET /api/sessions?cwd=&title=&before=&limit=` uses opaque keyset cursors (default 20, maximum 100). Search is title-based. `POST /api/sessions` accepts `{cwd, agent?}` and creates an empty saved session without inference.
- `GET /api/sessions/:id` returns the session, latest chronological history page, history watermark, current/last metrics, context summary, recent operation receipts and ownership (`idle`, `here`, `elsewhere`). `GET /api/sessions/:id/history?before=&limit=` loads older history. `PATCH` the session with `{title}` renames it; `DELETE` refuses an active writer.
- `POST /api/sessions/:id/operations` accepts `{clientRequestId, kind:"turn"|"compact", agent, input?}`. The displayed server config is authoritative. It returns the durable receipt with 202; a matching duplicate returns the original receipt. A reused ID with different intent is 409. Manual compact has no user input.
- `GET /api/sessions/:id/operations?clientRequestId=` finds a receipt after a lost submit response; omitting the ID returns recent receipts. `GET /api/operations/:id` reads one receipt. `POST /api/operations/:id/cancel` cancels only work owned here. No GET, refresh or reconnect submits work.
- `GET /api/sessions/:id/metrics` returns `{metrics, metricsStale}`. Missing measurements are null/absent, never zero by invention. A measurement carries its time and history watermark; later external history makes it stale. `metrics.capabilities`, when available, lists the tools, skills and variable names selected by that runtime, without values or credentials. The session snapshot separately includes `{context:{summary?,messageCount}}`.

## Streams and approvals

`GET /api/sessions/:id/events` is authenticated fetch-SSE. Event IDs combine server instance and session sequence. Supply the last ID through `Last-Event-ID` to replay retained events. Initial connections get a snapshot. Expired/foreign cursors get a reset snapshot; clients merge durable history by sequence/segment ID and replace transient state. The snapshot watermark and subsequent publication share one host ordering boundary.

Every envelope contains `instanceId`, `sessionId`, `sequence`, `type`, `data` and an `operationId` when applicable. Types cover snapshots, committed history, text/reasoning segments, tool state, operation state, compaction, metrics, approvals and host errors. History records are authoritative once committed. Tool call IDs are scoped to the turn/operation; segment IDs survive their live-to-history transition. A terminal operation event follows durable terminal persistence and runtime cleanup.

Replay retains at most 4096 events and 4 MiB per observed session. Large live text uses private temporary files (64 MiB per operation) and 8 KiB previews; `GET /api/sessions/:id/output?operationId=&segmentId=&offset=` reads UTF-8 pages (maximum 64 KiB) while that segment is live. Byte offsets must lie on character boundaries. Live output is presentation state, never a replacement model transcript. Slow readers resnapshot instead of blocking inference. A preview limit/error is explicit; completed saved history remains authoritative. Temporary output is removed when history commits or at operation/server cleanup; abandoned owned directories are reclaimed after their process is gone.

Pending approval includes a random approval ID, operation ID, tool call ID, exact arguments and deadline. `POST /api/permissions/:approvalId` accepts `{operationId, callId, allow}`. The first valid answer wins; duplicates/stale answers return 409. Expiry/cancellation resolves the request without consent. Matching registry `ask` rules create approvals; safe permitted Bash calls produce none.

Stop requests cancellation; the receipt becomes terminal after owned startup/runtime cleanup finishes. Concurrent MCP initialization failure and host cancellation share one transport-close promise, and a stdio child must report close before that cleanup settles.

`GET /api/activity` returns bounded metadata for this server's active/recent operations and pending approval identities. It excludes transcript and argument bodies. Polling never starts a runtime, renews retention or extends approval deadlines. Work owned by another CLI/ACP process has committed-history refresh only, without fabricated live deltas or control rights.
