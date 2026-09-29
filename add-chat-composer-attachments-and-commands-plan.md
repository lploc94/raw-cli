# Add a full chat composer with attachments, image upload and slash commands to the Raw dashboard

## Plan schema
loop-plan/v1

## Target

The dashboard chat input behaves like a current coding-assistant composer:

- an auto-growing textarea with a bottom toolbar (`+` on the left, Send/Stop on the right);
- a `+` popover menu to attach images/files and to reference workspace files;
- attachments shown as removable chips (uploading / error states), also via drag-drop and image paste;
- `@` popover to reference workspace files, `/` popover for commands, both keyboard-navigable (ARIA combobox/listbox);
- images actually reach vision-capable models, persist in the session, replay after reload/resume, and render in the timeline.

## Scope

Included:

1. Core: a user `image` block in `UserInput`, supported by all four provider adapters, persistence, replay, compaction, terminal/ACP projection.
2. Dashboard API: image upload staging, structured turn input (text + attachment ids + workspace file references), workspace file search, per-agent composer metadata (`vision`, selected skills), image bytes for history items.
3. Web: composer layout, generic suggestion popover, `+` menu, chips, drag-drop, paste, `@` mentions, `/` commands (built-in dashboard commands + skills of the selected agent), image rendering in the timeline.
4. English copy, documentation, Playwright + node tests, screenshots, installed-artifact qualification.

Excluded:

- Non-image binary uploads (PDF, audio, arbitrary files) in this iteration. "Attach file" means a workspace file reference (`resource_link`). The design must make adding such kinds cheap (see the extensible attachment kinds pattern) but ships only the `image` kind.
- Image formats other than PNG/JPEG in this iteration (matches `nativeToolContent`); adding one is a registry entry, not a pipeline change.
- Accepting image blocks over ACP `session/prompt` (ACP `promptBlocks` in `src/acp/methods.ts` keeps rejecting them; only the ACP *history replay* path must not crash on stored images).
- Message editing/regeneration, background queues, multi-user features, drag-reorder of chips.
- Server-side skill invocation. A `/skill` command only inserts a text instruction; the agent still uses `list_skills`/`load_skill`.
- Changing storage format or bumping the schema version.

## Invariants

1. `AgentSession` owns context. The browser never builds model context; the server converts validated upload ids/paths into `UserBlock`s and passes them to `agent.run`.
2. No storage format bump. Image data lives inside the existing user message JSON; strings >64 KiB already go to payload blobs via `SessionStore.stageStored` (`src/sessions/store.ts`).
3. Operation rows keep `input` as text ≤1 MiB. Image bytes are never written to `session_operations`; a crash yields `interrupted`, never automatic replay (existing behavior).
4. Duplicate submits with the same `clientRequestId` return the existing receipt and never re-consume or re-stage attachments.
5. **Graceful degradation, never a dead end.** A missing capability may reduce functionality but must never block the user from continuing. A non-vision model never receives image bytes: at request-projection time every image block in the effective context (new input and replayed history) is replaced by a text placeholder that tells the model what happened, while the stored context keeps the original image (switching back to a vision agent restores it). The turn always proceeds. Text-only turns are byte-for-byte unchanged (provider request bodies of existing tests must not change).
6. Untrusted content stays inert: no image URL from history is loaded remotely; images render only from same-origin session endpoints; SVG and other types are refused.
7. Workspace file search and references never escape the session `cwd` (no `..`, no symlink escape, no absolute paths from the client).
8. IME composition, `preferences.sendMode`, per-session drafts (`drafts` map in `web/src/chat.tsx`) and the durable pending-receipt flow keep working.

## Baseline

Verified before planning (do not redo):

- `POST /api/sessions/:id/operations` accepts `input` as a string only (`textField(..., 1024 * 1024)` in `src/dashboard/sessions.ts`); `MAX_JSON_BYTES` = 1 MiB (`src/dashboard/contract.ts`).
- `OperationIntent.input?: string` (`src/sessions/operation-types.ts`); `SessionOperations.execute` calls `runtime.agent.run(operation.input!, event)` (`src/sessions/operations.ts`).
- `UserBlock` = `text | resource_link`; `renderUserInput` renders resource links as JSON text (`src/llm/types.ts`). All four adapters call `renderUserInput` for user messages: `src/llm/openai.ts:21`, `anthropic.ts:11`, `google.ts:16`, `responses.ts:12`.
- Tool-result images already have per-provider wire shapes (openai `image_url` data URL, anthropic `image` base64 source, google `inlineData`, responses `input_image`); validation lives in `nativeToolContent` (`src/llm/content.ts`), PNG/JPEG structural validators in `src/tools/image.ts`, cap `MAX_IMAGE_BYTES` = 16 MiB (`src/tools/types.ts`).
- Vision gating exists for tool images: `modelConfig.vision !== true` → `vision_disabled` (`src/agent.ts` ~713). `ResolvedModelConfig.vision` comes from `models.<alias>.vision` (`src/config.ts`).
- History views: `projectHistoryItem` (`src/sessions/view.ts`) exposes `text` only for `kind: "user"`; `src/sessions/display.ts` maps user payload to ACP `user_message_chunk` blocks (`block as ContentBlock`, ACP image = `{type:"image", data, mimeType}`); `src/terminal/history.ts` uses `renderUserInput`.
- `validate saved state` (`src/sessions/restore.ts`) only requires user content to be string or array.
- `src/llm/replay.ts` replaces historical tool images with text placeholders; user messages are never rewritten.
- Web: composer is a plain 3-row textarea + Send/Stop in `web/src/chat.tsx` (lines ~380–455), CSS in `web/src/styles.css` (`.composer*`, ~795–860 and responsive overrides ~1362–1516). Existing `Modal`, `Field`, `ErrorMessage` in `web/src/ui.tsx`; Radix (`radix-ui`) and `lucide-react` are already dependencies.
- Skills selection per agent: `agents.<name>.skills` in config (`src/config.ts` `skillSpec`), catalog via `ComponentManager.list("skills")` (`src/management/components.ts`). `metrics.capabilities.skills` is only available while a runtime is attached, so it cannot feed the composer before the first send.
- Tests: node tests `tests/dashboard-*.test.ts`, `tests/provider-content.test.ts`, `tests/vision.test.ts` (mock provider `tests/fixtures/mock-provider.ts`, `tests/fixtures/dashboard.ts`), Playwright `tests/dashboard-ui/*.spec.ts` (chromium/firefox/webkit). `scripts/test.mjs` has a required-test-file list; new node test files must be added there.
- The earlier plan `add-local-dashboard-and-web-chat-plan.md` excluded browser uploads and a nonfunctional attach button. This plan supersedes that exclusion by explicit user request; do not edit the old plan.

## Design and project patterns

- **Image block shape** follows the ACP/MCP content shape already used by `display.ts`: `{ type: "image"; data: string /* base64 */; mimeType: "image/png" | "image/jpeg" }` added to `UserBlock`. Pattern: `UserBlock` union in `src/llm/types.ts`; wire mapping mirrors tool-image mapping in each adapter; validation reuses `src/tools/image.ts` validators and the base64 checks in `src/llm/content.ts` (extract a shared helper rather than duplicating).
- **Vision degradation for user images**: a pure projection step in `AgentSession` request building (sibling of `projectReplayMessages` in `src/llm/replay.ts`, e.g. `projectVisionMessages(messages, vision)`), applied before token estimation and adapter mapping. When `modelConfig.vision !== true` each user `image` block becomes a text part with the placeholder `[Image omitted: <mime>, <n> bytes<, "name">. The current model cannot read images, so this image was replaced by this text placeholder. Its content may be described in earlier assistant messages of this conversation; ask the user to describe it or to switch to a vision-capable agent if you need to see it.]`. Stored `model_context` is never rewritten. The dashboard never blocks on vision: attach stays enabled and shows a warning, and the timeline keeps showing the original image.
- **Upload staging**: `POST /api/sessions/:id/attachments` with raw body (`Content-Type: image/png|image/jpeg`, header `X-Raw-Filename` optional), read with `readBody(request, maximum)` from `src/dashboard/errors.ts` (pattern: existing 413 handling). Stored in a per-server in-memory (or temp-dir) staging map with TTL and per-session count/byte caps, keyed by random id, cleaned on `context.onClose` (pattern: `output`/`approvals` objects in `createSessionRoutes`). Returns `{id, mimeType, byteSize, name}`. Bytes are validated with the shared image validator.
- **Turn input**: `input` remains a string (back-compat, existing tests untouched). Optional new body fields `attachments: string[]` (staging ids) and `files: string[]` (workspace-relative paths). Server builds `UserBlock[]` = text block + `resource_link` blocks (`file://` URI, `name`, `mimeType?`, `size`) + image blocks, and passes them via an optional non-persisted `blocks` param on `SessionOperations.submit` (rows still store text only). Staged ids are consumed only when a new operation is accepted.
- **Composer metadata**: `GET /api/agents/:name/composer` (dashboard sessions/management routes) → `{ vision: boolean, skills: {name, description}[] }` computed from config + component catalog without model credentials (pattern: bootstrap/management read paths that already tolerate missing credentials).
- **Workspace file search**: `GET /api/sessions/:id/files?q=&limit=` → relative paths under the session cwd, fuzzy-ranked, ignoring `.git`/`node_modules`/dotfiles by default, capped (pattern: path safety in `workspacePath` + `realpathSync` containment; reuse an existing ignore/list helper if the read/bash tools have one, otherwise a small bounded walker).
- **History images**: `HistoryView` gains `attachments?: {index, kind: string, name, mimeType, byteSize}[]` for user items (`kind` is an open registry id, e.g. `image` or `file`); `GET /api/sessions/:id/history/:sequence/attachments/:index` dispatches through the server `AttachmentKind` registry (`kind.fromBlock(block) → {mimeType, bytes}`) and streams validated bytes with `Content-Type` from the stored mime, `X-Content-Type-Options: nosniff` and the existing dashboard CSP constraints (check `src/dashboard/static.ts`/server headers for `img-src`; extend only to `'self'`).
- **Web architecture**: one generic `SuggestionPopover` (combobox/listbox, `aria-activedescendant`, focus stays in textarea) in a new `web/src/composer/` module with providers for `/` (commands) and `@` (files); a `useAttachments` hook (upload state machine); `Composer` component extracted from `chat.tsx`. Pattern: Radix `Popover`/`DropdownMenu` from `radix-ui` for the `+` menu; CSS variables/classes in `web/src/styles.css`.
- **Built-in commands**: `/compact` (calls existing `send("compact")`), `/rename` (opens existing rename modal), `/new` (creates a chat via the existing New-chat flow in `web/src/App.tsx`), `/details` (toggles inspector). Skill entries insert `Use the skill "<name>" for this task. ` and keep focus. Unknown `/x` typed text is sent as plain text (no silent swallow).
- **Extensible attachment kinds (add a format without touching the pipeline)**. Three small registries, each with `image` as its first entry:
  1. *Model layer*: a shared `nativeUserContent(blocks)` in `src/llm/content.ts` (sibling of `nativeToolContent`) that validates and normalizes user blocks once into an ordered list of content parts (`text`, `image`, …, original block order preserved); adapters only map the normalized parts to their wire shape. A future kind (e.g. PDF) adds one `UserBlock` variant, one validator entry, and one wire mapping per adapter that supports it; unsupported adapters raise `unsupported_content`.
  2. *Server*: `AttachmentKind` registry in `src/dashboard/attachments.ts`: `{ id, mimeTypes, maxBytes, requiresVision?, validate(bytes), toBlock(staged), fromBlock(block) }` (`fromBlock` is used by the history content route). The upload route picks the kind from `Content-Type`; limits, error codes and staging are generic. The registry, not route code, lists what is accepted.
  3. *Web*: `web/src/composer/attachment-kinds.ts`: `{ id, accept, icon, preview(chip), timelineRenderer }`. `accept`, size limits and enabled/disabled reasons come from `GET /api/agents/:name/composer` (`attachmentKinds`), so the UI never hardcodes "PNG/JPEG"/"8 MiB".
  Result: adding a format = one server kind + one model-layer mapping + one client renderer entry; no changes to upload/staging/consume/history/chip/drag-drop/paste code.
- **Design reference**: `docs/dashboard-composer-design.md` is the durable record of these decisions. Any phase that deviates from it must update that file in the same commit.
- **Rejected alternatives**: base64 images inside the JSON turn body (1 MiB cap and receipt bloat); persisting image bytes in `session_operations`; new storage table; a client-side-only "attach" that inlines file contents into text.

## Global Gates

- `npm run typecheck`
- `npm test` (builds, then runs every required node test file)
- `npm run test:web` (all Playwright projects) for any phase touching `web/`
- `npm run test:package` after Phase 6
- No change to existing provider request-body assertions for text-only turns.
- `git status` clean except intended files at each phase commit.

## Plan Review

APPROVE — intent-fidelity and self-review completed: every user-approved decision (real image upload with all four adapters, `@` files, `/` built-ins + agent skills, generic popover, auto-grow layout) maps to a phase; the old plan's exclusion is explicitly superseded; no speculative abstractions beyond the shared popover the user asked for; paths/symbols above were verified in the repository on 2026-09-29.

## Phase 1: User image blocks in the model layer

### Goal
`UserInput` can carry validated PNG/JPEG images that all four providers send natively and every projection handles.

### Current behavior and gap
`UserBlock` has no image; adapters flatten user input to text. Nothing validates user-supplied images or gates them on `vision`.

### Evidence
`src/llm/types.ts` (`UserBlock`, `renderUserInput`), `src/llm/{openai,anthropic,google,responses}.ts` user branches, `src/llm/content.ts`, `src/tools/image.ts`, `src/agent.ts` (~713 vision gate), `src/sessions/view.ts`, `src/sessions/display.ts`, `src/terminal/history.ts`, `src/compact.ts` (`summaryInput`), `src/acp/methods.ts`.

### Pattern
Tool-image wire mapping per adapter; `nativeToolContent` validation; `vision` flag semantics (tool images keep their existing `vision_disabled` result; user images degrade instead).

### Dependencies
None.

### Files and symbols
`src/llm/types.ts`, `src/llm/content.ts` (shared `validateImageBlock`), the four adapters, `src/agent.ts` (`run`/`execute` gate), `src/sessions/view.ts`, `src/sessions/display.ts`, `src/terminal/history.ts`, `src/compact.ts`, the context/token estimator module used by `estimateRequestTokens` (`src/llm/context.ts` or wherever `rg estimateRequestTokens` points), `src/index.ts` (type export unchanged names), `tests/provider-content.test.ts`, `tests/vision.test.ts`, `tests/session-view.test.ts`, `tests/compact.test.ts`.

### Behavioral contract
- `UserBlock` adds `{type:"image", data, mimeType:"image/png"|"image/jpeg"}`.
- `renderUserInput` renders an image as `[Image: <mime>, <n> bytes]` (never base64) for titles, terminal, compaction summaries and text views.
- OpenAI chat: user content becomes an array of `text` and `image_url` data-URL parts only when images exist; otherwise the string is unchanged. Responses: `input_text`/`input_image`. Anthropic: `text`/`image` base64 source. Google: `text`/`inlineData` parts.
- Invalid base64, wrong magic/structure, non-PNG/JPEG, or >16 MiB aggregate decoded image bytes per turn → rejected with `unsupported_content` before any HTTP request. The same aggregate/structure validation runs in `agent.run` *before* the user message is committed to context, so an invalid image turn never enters (and can never poison the replay of) a session.
- `nativeUserContent` returns an **ordered** list of content parts (`text` / `image` / …) in original block order; adapters map parts in order and keep their existing text-only wire shape when no image part exists.
- **Vision degradation, not refusal.** When `modelConfig.vision !== true`, the request projection replaces every user image block in the effective context (new input and replayed history, including after an agent switch mid-session) with the text placeholder `[Image omitted: <mime>, <n> bytes<, "name">. The current model cannot read images, so this image was replaced by this text placeholder. Its content may be described in earlier assistant messages of this conversation; ask the user to describe it or to switch to a vision-capable agent if you need to see it.]` before token estimation and adapter mapping. The turn proceeds normally; no error, no context mutation (stored images are untouched and are sent natively again on a later vision agent). Compaction summaries and the estimator see only the placeholder for non-vision models.
- The context-size estimate (`estimateRequestTokens` in the context/prompt layer used by automatic compaction and `context_budget_exceeded`) is image-aware: image parts contribute a fixed conservative per-image token constant (documented next to the constant) and base64 is never counted as text. Metrics/context percentage use the same estimate.
- ACP `user_message_chunk` for a stored image emits an ACP `image` block; terminal history prints the placeholder; `HistoryView.text` uses the placeholder.
- Compaction and replay keep image blocks in user messages intact; `summaryInput` uses the placeholder text.

### Documentation
Update `docs/providers.md` (user images per adapter, placeholder degradation for non-vision models) and `docs/sessions.md` (stored user blocks).

### Tests first
1. Per-adapter request-body tests with a mock provider: text+image user turn produces the exact native shape; text-only turn body identical to the pre-change fixture.
2. Validation failures (bad base64, GIF magic, truncated PNG, oversize) raise before any request (mock provider records zero requests).
3. `vision: false` model: the run succeeds; the provider request contains the placeholder text for each image and no image part; stored `context` still holds the original image block.
4. `renderUserInput`, `projectHistoryItem`, terminal history and `display.ts` handle image blocks and never emit base64 into text.
5. Compaction of a session containing a user image does not include base64 in the summary request.
6. Resume: a persisted user image survives `restore` validation and is resent on the next request.
7. Aggregate limit: 3 individually valid images totalling >16 MiB are rejected by `agent.run` before commit (context unchanged, zero requests), and a later text turn on the same session still works.
8. Non-vision replay: session with an image turn (vision agent) followed by a text turn on a non-vision agent succeeds with placeholders (no image parts on the wire); a following turn on a vision agent sends the original image natively again.
9. Budgeting: a turn with a ~5 MiB image and automatic compaction enabled reaches the provider (no spurious `context_budget_exceeded`/compaction); `estimatedContextTokens()` differs from the base64-as-text estimate by orders of magnitude.
10. Ordering: text/image/text/image blocks are mapped in the same order on all four adapters.

### Anti-shortcut coverage
Assert base64 payload equality on the wire (not just presence); assert zero provider requests for rejected cases; a fixture with two images and interleaved text checks block ordering; a text-only regression asserts the OpenAI `content` is still a string.

### Implementation obligations
Locate and update the token estimator (`estimateRequestTokens`, used by `AgentSession.estimatedContextTokens` and automatic compaction) for image parts; run the aggregate/structure validation in `agent.run` before committing the user message; introduce `nativeUserContent` as the single normalization point for user blocks (adapters must not inspect raw `UserBlock`s themselves); extract the shared validator (no copy of PNG/JPEG logic); add a test-only fake block kind through the registry to prove a new kind needs no adapter-flow changes beyond its wire mapping; keep adapters' text-only paths untouched; handle blob-staged large strings transparently (no adapter code should know about blobs).

### Acceptance criteria
- [x] AC-1: All four adapters emit native image parts for user images — proven by provider-content tests.
- [x] AC-2: Text-only requests are unchanged — proven by existing provider tests passing unmodified.
- [x] AC-3: Invalid/oversize images are rejected before any request; non-vision models degrade images to placeholders instead of failing — proven by tests 2–3.
- [x] AC-4: Base64 never appears in rendered text, titles, terminal output or compaction summaries — proven by view/terminal/compact tests.
- [x] AC-5: Resumed sessions replay stored user images — proven by session-replay/agent test.
- [x] AC-6: Aggregate >16 MiB and invalid images are rejected before commit/request; non-vision replay of earlier images degrades to placeholders and never blocks, and the original image returns on a vision agent — proven by tests 7–8.
- [x] AC-7: Images are budgeted by the image-aware estimator, not as base64 text — proven by test 9.
- [x] AC-8: Mixed block order is preserved on all adapters — proven by test 10.

### Focused verification
`node --import tsx --test tests/provider-content.test.ts tests/vision.test.ts tests/session-view.test.ts tests/compact.test.ts tests/session-replay.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: support image blocks in user model input`

## Phase 2: Dashboard attachments, structured turns and composer metadata

### Goal
The API can stage an image, accept a turn with attachments and workspace file references, and describe an agent's composer capabilities.

### Current behavior and gap
Only string `input`; no upload, no file search, no vision/skills info before the first send.

### Evidence
`src/dashboard/sessions.ts` (operations POST, `workspacePath`, `requireSession`), `src/dashboard/errors.ts` (`readBody`, `textField`), `src/dashboard/contract.ts`, `src/sessions/operations.ts` (`submit`, `acceptOperation` validation at ~270), `src/management/components.ts`, `src/config.ts`.

### Pattern
Route regexes and `reply`/`DashboardError` style in `createSessionRoutes`; cleanup via `context.onClose`.

### Dependencies
Phase 1.

### Files and symbols
`src/dashboard/sessions.ts`, new `src/dashboard/attachments.ts`, new `src/dashboard/files.ts`, `src/dashboard/management.ts` or `sessions.ts` (composer route), `src/sessions/operations.ts` (`submit` optional `blocks`), `src/dashboard/contract.ts` (route allowlist / `DASHBOARD_API_VERSION` if additive-versioned), tests `tests/dashboard-sessions.test.ts`, new `tests/dashboard-attachments.test.ts` (add to `scripts/test.mjs` required list).

### Behavioral contract
- `POST /api/sessions/:id/attachments`: raw PNG/JPEG body ≤ 8 MiB; validates structure; 415 for other types, 413 too large. Vision is never checked here. Enforces max 8 staged per session and ≤ 16 MiB aggregate decoded staged bytes: an upload that would exceed either is rejected with 413 `attachments_too_large` (a chip-level error; existing chips and the text draft are unaffected and the user can still send). TTL 30 min, all dropped on server close. Response `{id, name, mimeType, byteSize}`.
- `DELETE /api/sessions/:id/attachments/:attId` removes a staged item.
- Turn POST: `input` string is still required and non-empty (server rule unchanged); the client supplies default text for image-only turns. Optional `attachments: string[]` (≤8 ids) and `files: string[]` (≤20 relative paths). Unknown/expired/other-session ids → 422 `unknown_attachment`; file paths outside cwd, missing, or directories → 422 `invalid_file`. There is no vision error: a non-vision agent (or a session whose history already has images) is accepted and the model layer degrades images to placeholders. The aggregate limit is already guaranteed by staging, and the model layer re-validates it before commit as defense in depth. Blocks order: text, resource_links, images.
- Attachments are consumed exactly once when an operation is newly accepted; a replayed `clientRequestId` returns the existing operation and leaves staged items untouched.
- `GET /api/sessions/:id/files?q=&limit=` returns `{items:[{path,name}]}` (limit ≤50, default 20), fuzzy-ranked, excludes `.git`, `node_modules`, and paths escaping cwd via symlink.
- `GET /api/agents/:name/composer` → `{vision, skills:[{name,description}]}`; unknown agent 404; works without credentials.

### Documentation
`docs/dashboard-api.md` (all new routes, bodies, error codes), `docs/dashboard.md` (composer behavior overview stub finalized in Phase 6).

### Tests first
Route tests with `dashboardFixture`: an upload that would push staged images over 16 MiB → 413 `attachments_too_large` while earlier chips and a text-only send still work; turn with an image on a non-vision agent completes and the mock provider receives the placeholder text and no image; agent switched to a non-vision agent after an image turn → text turn completes with placeholders; upload success/validation matrix; oversize 413; wrong type 415; per-session cap; turn with attachment on a vision agent produces a provider request whose user message has the native image part (mock provider body inspection); duplicate `clientRequestId` doesn't consume/duplicate; path traversal (`../x`, absolute, symlink escape) rejected; file search ranking/limit/ignore; composer metadata for vision true/false and skills selection; text-only turn regression.

### Anti-shortcut coverage
Assert the mock provider receives the exact uploaded bytes; assert staging map is empty after consumption and after close; assert traversal fixtures with a real symlink.

### Implementation obligations
Implement the `AttachmentKind` registry with `image` as the only entry; upload/staging/consume code must be kind-agnostic (a test registers a temporary fake kind and uploads/consumes it without route changes); composer metadata returns `attachmentKinds: [{id, accept, maxBytes, enabled, reason?}]`; no image bytes in `session_operations` rows (assert by reading the row); `submit` keeps validation of `input` text; bounded memory (byte cap across sessions); clean error mapping via `DashboardError`.

### Acceptance criteria
- [x] AC-1: An uploaded image reaches the provider intact through a dashboard turn — proven by dashboard-attachments test.
- [x] AC-2: Duplicate submissions never re-consume or duplicate attachments — proven by test.
- [x] AC-3: File references and search cannot escape cwd — proven by traversal/symlink tests.
- [x] AC-4: Non-vision agents never cause a vision error: the turn completes with placeholders and no image on the wire — proven by test.
- [x] AC-5: Composer metadata reports `vision` and the agent's selected skills without credentials — proven by test.
- [x] AC-6: Operation rows contain no image bytes — proven by store inspection test.

### Focused verification
`node --import tsx --test tests/dashboard-attachments.test.ts tests/dashboard-sessions.test.ts tests/session-operations.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: accept image attachments and file references in dashboard turns`

## Phase 3: History exposure for attachments

### Goal
The browser can list and safely fetch images/file references of past user messages.

### Current behavior and gap
`HistoryView` for user items has text only; no image endpoint; no way to render attachments after reload.

### Evidence
`src/sessions/view.ts` (`HistoryView`, `projectHistoryItem`), `src/dashboard/sessions.ts` (history route, `snapshot`), `src/dashboard/streams.ts` (history events carry `HistoryView`), `src/dashboard/static.ts` (security headers).

### Pattern
`projectHistoryItem` projection; history route regex in `createSessionRoutes`.

### Dependencies
Phase 1, Phase 2.

### Files and symbols
`src/sessions/view.ts`, `src/sessions/store.ts` (new bounded read of one history item by session + sequence that decodes payload blobs, e.g. `getSessionHistoryItem`), `src/dashboard/sessions.ts`, `src/dashboard/attachments.ts` (registry `fromBlock`), `src/dashboard/static.ts`/server header setup, `web/src/session.ts` types only, tests `tests/session-view.test.ts`, `tests/dashboard-sessions.test.ts`, `tests/dashboard-streams.test.ts`.

### Behavioral contract
- User `HistoryView` carries `attachments` metadata (no base64) for image and resource_link blocks, in order; `text` only contains text blocks' text.
- `GET /api/sessions/:id/history/:sequence/attachments/:index` returns bytes with the stored mime, `Cache-Control: private, max-age=3600`, `X-Content-Type-Options: nosniff`; 404 for non-user items, out-of-range index, blocks whose kind has no registered `fromBlock`, or a mime outside the kind's `mimeTypes` (only PNG/JPEG are registered in this iteration). The route addresses any history item by sequence, including items older than the first loaded history page.
- CSP allows `img-src 'self'` (and nothing remote); verify the existing header before changing.
- SSE `history` events and snapshots contain metadata only (payload size unchanged for text-only items).

### Documentation
`docs/dashboard-api.md` history/attachment sections.

### Tests first
Projection with mixed blocks; endpoint success/404 matrix; stream payload contains no base64 (assert by size and substring); CSP header asserted.

### Anti-shortcut coverage
Fetch bytes equal the originally uploaded bytes (hash compare) after a server restart on the same store, including an image older than the first history page (create >50 later history items); a fake kind registered in the test is served through the same route; large image (>64 KiB, blob-staged) still fetched correctly.

### Implementation obligations
Add the single-item store read (decoding blob refs) rather than paging; never serve unvalidated types; the content route contains no image-specific logic (registry dispatch only).

### Acceptance criteria
- [x] AC-1: History views expose attachment metadata without base64 — proven by view/stream tests.
- [x] AC-2: Image bytes round-trip, including blob-staged sizes and after restart — proven by hash test.
- [x] AC-3: Endpoint refuses non-image/invalid targets and sets nosniff — proven by test.

### Focused verification
`node --import tsx --test tests/session-view.test.ts tests/dashboard-sessions.test.ts tests/dashboard-streams.test.ts`

### Phase gates
`npm run typecheck && npm test`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: expose user attachments in dashboard history`

## Phase 4: Composer layout and generic suggestion popover with slash commands

### Goal
New composer layout with a working `/` command popover (built-ins + selected agent's skills) and the reusable popover for `@`.

### Current behavior and gap
Plain textarea, footer hint text, no menus.

### Evidence
`web/src/chat.tsx` composer block and `send`, `web/src/styles.css` `.composer*` and responsive rules, `web/src/App.tsx` (New chat flow, rename modal patterns), `tests/dashboard-ui/chat.spec.ts` (IME/send-mode test at `test("IME Enter does not send…")`), `tests/dashboard-ui/accessibility.spec.ts`.

### Pattern
Existing component split (`ui.tsx`), Radix usage, CSS variable theming, Playwright `openChat` helper.

### Dependencies
Phase 2 (`/api/agents/:name/composer`).

### Files and symbols
New `web/src/composer/Composer.tsx`, `web/src/composer/SuggestionPopover.tsx`, `web/src/composer/commands.ts`, `web/src/composer/useAutoGrow.ts`; edits to `web/src/chat.tsx` (extract composer, keep `send`, receipt logic), `web/src/api.ts` if helpers needed, `web/src/styles.css`, tests `tests/dashboard-ui/composer.spec.ts` (new), updates to `chat.spec.ts`/`accessibility.spec.ts`.

### Behavioral contract
- Layout: textarea auto-grows from 1–2 rows to ~8 rows then scrolls; toolbar row below with `+` (placeholder trigger enabled in Phase 5) at left and Send/Stop at right; hint text is a tooltip/`aria-describedby`, footer context/compact row stays.
- Send disabled when empty, busy, no agent, or unconfirmed receipt (unchanged); Stop replaces Send while an owned operation runs (unchanged).
- `/` at the start of input (or after only whitespace) opens the popover above the composer; fuzzy filter as user types; `↑/↓` navigate, `Enter`/`Tab` accept, `Esc` closes, focus stays in textarea; `role="combobox"`/`listbox`/`option`, `aria-expanded`, `aria-activedescendant`, live region announces result count; empty state "No matching commands".
- Built-ins (each wraps behavior that already exists in the UI today — none is a placeholder): `/compact` executes compact when enabled (disabled entry with reason when busy/no agent); `/rename` opens rename modal; `/new` starts a new chat via the existing flow; `/details` toggles inspector. Skill entries (from composer metadata of the selected agent, refetched on agent change) insert `Use the skill "<name>" for this task. `.
- Enter while the popover is open selects, not sends; IME composing never selects/sends; `sendMode` modifier mode unchanged when popover closed.
- Draft persistence per session preserved; accepting a command updates the draft.
- Popover placement flips/scrolls within viewport at narrow widths (bottom-sheet-like full width at ≤ 640 px per existing breakpoints).

### Documentation
`docs/dashboard.md` composer section (layout, shortcuts, commands); refresh affected screenshots in Phase 6.

### Tests first
Playwright: auto-grow bounds; `/` opens, filters, keyboard select for a built-in and a skill; Enter does not send while open; Esc closes; `/compact` posts a compact operation; IME Enter neither selects nor sends; sendMode preference regression; axe accessibility spec for the open popover; narrow-viewport layout; drafts persist across session switch.

### Anti-shortcut coverage
Assert the model request text for a skill insertion equals the inserted sentence (no hidden command text); assert focus remains in the textarea (`toBeFocused`) throughout; assert `aria-activedescendant` changes with arrows; test a typed `/unknown` sends verbatim.

### Implementation obligations
Extract without duplicating the receipt/duplicate-submit logic; popover is generic over `{id,label,description,disabled?,onSelect}` items with a trigger-character provider so Phase 5 adds `@` without editing the component.

### Acceptance criteria
- [x] AC-1: Auto-grow textarea and toolbar layout render correctly at desktop/tablet/narrow — proven by Playwright + screenshots.
- [x] AC-2: `/` popover filters, navigates and selects by keyboard with correct ARIA — proven by composer and accessibility specs.
- [x] AC-3: Built-in commands and agent skills work as specified — proven by specs.
- [x] AC-4: IME, sendMode, drafts and duplicate-submit behavior unchanged — proven by existing plus new specs.

### Focused verification
`npx playwright test tests/dashboard-ui/composer.spec.ts tests/dashboard-ui/chat.spec.ts tests/dashboard-ui/accessibility.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm test && npm run test:web`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: rebuild dashboard composer with slash command suggestions`

## Phase 5: Attach menu, chips, image upload, `@` mentions and timeline images

### Goal
Users can attach images (menu, drag-drop, paste) and workspace files (`+` menu, `@`), see chips, send them, and see images in the conversation.

### Current behavior and gap
No attach UI; timeline renders text only.

### Evidence
Phase 2/3 APIs; `web/src/timeline.tsx` user message rendering; `web/src/chat.tsx` send body; `web/src/ui.tsx`.

### Pattern
Radix menu for `+`; Phase 4 popover for `@`; existing error/`ErrorMessage` patterns.

### Dependencies
Phases 2, 3, 4.

### Files and symbols
New `web/src/composer/useAttachments.ts`, `AttachmentChips.tsx`, `AttachMenu.tsx`; edits to `Composer.tsx`, `web/src/chat.tsx` (send body `attachments`, `files`; clear on success like draft), `web/src/timeline.tsx` (user attachments), `web/src/styles.css`, tests `tests/dashboard-ui/attachments.spec.ts` (new).

### Behavioral contract
- `+` opens a menu: "Upload image…" (hidden file input, `accept` from composer metadata; always enabled — when the agent has no vision the chips show a warning "This agent can't see images; it will receive a text placeholder"), "Reference workspace file…" (opens the `@` popover at caret), and "Commands" (inserts `/`). When the current agent has no vision and the chat history already contains images, the composer shows a quiet note: "Images in this chat are sent to this agent as text placeholders."
- Drag-drop over the composer area shows a "Drop to attach" overlay; paste of clipboard images attaches them; non-PNG/JPEG or >8 MiB rejected client-side with a chip-level error; max 8 images and ≤16 MiB aggregate (limits read from composer metadata; the server's `attachments_too_large` is shown as a chip-level error without clearing other chips or the draft).
- Each chip shows thumbnail/name/size, states `uploading` (progress/aria-busy) → `ready` or `error` (retry/remove); remove calls DELETE for ready items; file references show name/path chip with ✕.
- Send is disabled while any chip is uploading; image-only send uses a default text (`Please look at the attached image.`/plural) and never an empty string; chips clear only after the operation is accepted; on failure or unconfirmed receipt they stay.
- `@` at a word start opens file suggestions from `/files`, debounced (150 ms) with abort of stale requests; accepting removes the typed `@query` token and adds a file chip (the chip is the single source of truth; no duplicate text token).
- Timeline user bubbles render image thumbnails (click opens full-size in a Radix dialog) and file chips from `HistoryView.attachments`; images load only from the same-origin endpoint with alt text; failed loads show a placeholder.
- Switching sessions keeps per-session chips only for ready uploads while the page lives; reload drops staged uploads (server TTL handles cleanup).

### Documentation
`docs/dashboard.md` attachments/mentions section; `docs/dashboard-api.md` cross-links.

### Tests first
Playwright with mock provider and `vision: true` agent fixture: upload via file chooser, paste, drag-drop each produce chips and a provider request containing the image; non-vision agent: upload still works, chips show the warning, the send succeeds and the provider request contains the placeholder text and no image; switching from a vision to a non-vision agent mid-chat shows the note and text turns still send; invalid type/oversize errors; remove chip deletes staged item (server check); send blocked while uploading; `@` search selects a file and provider request contains the `resource_link` text; timeline shows the image after send and after page reload; duplicate-submit/receipt flow keeps chips on failure.

### Anti-shortcut coverage
Compare provider-received bytes to fixture bytes; reload test proves persisted history endpoint (not local blob URL); network-mock a failing upload to verify error state and that Send stays disabled until removed/retried; keyboard-only path (Tab to `+`, Enter, arrows) covered.

### Implementation obligations
Chips, upload, drag-drop, paste and timeline rendering dispatch through the client attachment-kind registry (`accept`/limits from composer metadata, never hardcoded); a unit/Playwright test registers a fake kind to prove no composer code changes are needed; revoke `URL.createObjectURL` previews; abort in-flight uploads/searches on unmount/session change; no `dangerouslySetInnerHTML`; respect `prefers-reduced-motion`.

### Acceptance criteria
- [x] AC-1: Images attach via menu, drag-drop and paste and reach a vision model — proven by attachments spec.
- [x] AC-2: Non-vision agents can still attach and send; the UI warns that a placeholder will be sent, and the turn is never blocked — proven by spec.
- [x] AC-3: Chip lifecycle (uploading/error/remove/retry) behaves per contract — proven by spec.
- [x] AC-4: `@` file references work and stay inside the workspace — proven by spec plus Phase 2 tests.
- [x] AC-5: Timeline shows sent images and file chips, including after reload — proven by spec.
- [x] AC-6: Keyboard and screen-reader access to menu, chips and popovers — proven by accessibility spec.

### Focused verification
`npx playwright test tests/dashboard-ui/attachments.spec.ts tests/dashboard-ui/composer.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm test && npm run test:web`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: attach images and workspace files from the dashboard composer`

## Phase 6: Documentation, evidence and installed-artifact qualification

### Goal
Shipped docs/screenshots/skill references match behavior, and the packaged artifact works end to end.

### Current behavior and gap
Docs describe the old composer; screenshots (`docs/dashboard/chat-*.png`) and `docs/evidence/local-dashboard.md` are stale; bundled skill dashboard references may mention chat input.

### Evidence
`docs/dashboard.md`, `docs/dashboard-api.md`, `docs/dashboard/*.png`, `tests/dashboard-ui/capture.ts`, `tests/dashboard-installed.test.ts`, `src/skills/bundled/*/references/dashboard.md` and `examples/skills/*/references/dashboard.md` (mirrored copies produced by `scripts/copy-bundled-skills.mjs`/`build-tool-examples.mjs`).

### Pattern
Previous phase-6 docs/evidence commits (`git log` for `docs: ship hook setup guidance and installed qualification`).

### Dependencies
Phases 1–5.

### Files and symbols
`docs/dashboard-composer-design.md` (created with this plan; reconcile every decision D1–D11, limits and the verification map with what was actually implemented, and record deviations), `docs/dashboard.md`, `docs/dashboard-api.md`, `docs/providers.md`, `docs/sessions.md`, `docs/evidence/local-dashboard.md` (append a dated section), refreshed screenshots via `tests/dashboard-ui/capture.ts`, any bundled skill reference that describes chat input (only if it states outdated facts), `tests/dashboard-installed.test.ts`, `tests/dashboard-assets.test.ts`.

### Behavioral contract
Docs state: image types/limits, vision degradation (placeholder) behavior, endpoints/errors, `/` commands, `@` references, keyboard shortcuts, exclusions (no ACP image prompts, no non-image uploads). Installed package (`npm pack` artifact per `test:package`) serves the new UI, accepts an image turn against the mock provider, and includes updated docs and images (`package.json` `files` already lists `docs/dashboard*`).

### Documentation
This phase is documentation.

### Tests first
Extend `dashboard-installed.test.ts` to upload an image and complete a turn from the installed artifact; extend `dashboard-assets.test.ts` to assert the built bundle contains the composer and that CSP still holds; docs check test/grep for the new route names if a docs-consistency test exists (`tests/vars-docs.test.ts` style), otherwise inspection.

### Anti-shortcut coverage
Installed test runs from the packed tarball, not the working tree; screenshots regenerated (file mtimes/content differ) rather than reused.

### Implementation obligations
Do not hand-edit generated mirrors; regenerate via the existing build scripts. Do not push, publish or install globally.

### Acceptance criteria
- [x] AC-1: Docs match implemented routes, limits and shortcuts — proven by inspection against Phase 2–5 tests.
- [x] AC-2: Refreshed screenshots show the new composer at desktop/tablet/narrow in light and dark — proven by capture run.
- [x] AC-3: Installed artifact completes an image turn — proven by `test:package`.

### Focused verification
`npm run build && node --import tsx --test tests/dashboard-installed.test.ts tests/dashboard-assets.test.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:web && npm run test:package`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`docs: document dashboard composer attachments and commands`

## Completion Criteria

- All phase acceptance criteria checked; each phase committed separately with reviewer verdict APPROVE.
- Global Gates pass on the final commit, including all three Playwright projects and `test:package`.
- A vision agent receives a pasted image end to end in the dashboard, it persists, renders after reload and resumes from the CLI; a non-vision agent receives a text placeholder instead of the image and the turn is never blocked.
- `/` and `@` popovers are fully keyboard- and screen-reader-operable; IME, send mode, drafts and duplicate-submit protection unchanged.
- No storage format change; text-only provider requests unchanged.

## Progress Log

- 2026-09-29: Plan drafted, Codex-reviewed (APPROVE) and revised so non-vision models degrade to placeholders instead of failing.
- 2026-09-29 Phase 1 (commit 3aa9c68, Codex gpt-6-astra review APPROVE in 2 rounds): implemented user `image` blocks, `nativeUserContent` (ordered parts, validation, 16 MiB aggregate), four adapter mappings, request-time vision placeholders (`projectVisionMessages`), image-aware estimator, summary/render placeholders, pre-commit validation in `agent.run`. Tests in `tests/user-images.test.ts` (7). `npm run typecheck` clean; `npm test` 553/556 — the 3 failures (REPL PTY `T-08`, `T-08b` x2 in `tests/cli.test.ts`) fail identically on baseline HEAD `c406e68` (environmental PTY), not caused by this change.
- 2026-09-29 Phase 2: `AttachmentKinds`/`AttachmentStaging` registry and staging (`src/dashboard/attachments.ts`), workspace search and file links (`src/dashboard/files.ts`), routes for upload/delete, structured turns (`attachments`, `files`), file search and `GET /api/agents/:name/composer` (effective config + per-skill loading), `SessionOperations.submit(intent, blocks?)`. `tests/dashboard-attachments.test.ts` (10 tests). `npm run typecheck` clean; `npm test` 561/564 before the final review fixes and the same 3 baseline PTY failures. Codex gpt-6-astra review: APPROVE in 3 rounds (8 findings fixed; residual file-name-only directory swap window accepted, Node has no handle-tied readdir).
- 2026-09-29 Phase 3: `HistoryView.attachments` (metadata only), user `text` = text blocks, `SessionStore.getSessionHistoryItem`, and `GET /api/sessions/:id/history/:sequence/attachments/:index` (registry dispatch via `fromBlock`, nosniff, Bearer-only so the web client fetches with the header and renders `data:` URLs, no CSP change). Tests added to `tests/dashboard-attachments.test.ts` (13 total: projection, hash round-trip of a blob-staged image beyond the first page, 404 matrix, fake kind, restart, SSE without base64, CSP). `npm run typecheck` clean; `npm test` 565/568 with the same 3 baseline PTY failures. Codex gpt-6-astra review: APPROVE in 3 rounds (2 fixed, 1 disputed with D8 wording clarified).
- 2026-09-29 Phase 4: `web/src/composer/` (Composer, generic SuggestionPopover/provider model, slash commands, auto-grow), chat.tsx integration (`/compact`, `/rename`, `/new` via the existing create flow, `/details`, skills from `/api/agents/:name/composer`). Deviation recorded in design D9: the textarea keeps its textbox role (role=combobox fails axe `aria-allowed-role`); the listbox uses aria-controls/aria-autocomplete/aria-haspopup/aria-activedescendant. `+` is rendered disabled until Phase 5. `tests/dashboard-ui/composer.spec.ts` (12). `npm test` 566/569 (3 baseline PTY failures); `npm run test:web` 153 pass across chromium/firefox/webkit. Codex gpt-6-astra review: APPROVE after 5 findings fixed (`/new` action, stale suggestions, width refit, viewport-capped popover, single async call) plus a self-found caret-restore race.
- 2026-09-29 Phase 5: `+` menu (upload, `@` reference, commands), chips with uploading/ready/error/retry/remove, drag-drop and paste (text pasted with files stays), `@` file provider (150 ms debounce, aborted when superseded), send body `attachments`/`files` with attachment-only default text, timeline thumbnails with enlarge dialog and file chips loaded through the Bearer-authenticated history endpoint as `data:` URLs, client kind registry (`attachment-kinds.ts` + `builtin-kinds.tsx`, proven by `tests/web-attachment-kinds.test.ts`). Deviations recorded as D12: chip errors never disable Send (degrade, never block) and only an in-flight upload does; server owns count/aggregate limits (shown as a chip error). `tests/dashboard-ui/attachments.spec.ts` (13 per browser). `npm test` 567/570 (3 baseline PTY); `npm run test:web` 192 pass on chromium/firefox/webkit. Codex gpt-6-astra review: APPROVE after 5 findings (2 fixed, 2 withdrawn after rebuttal, plus a paste text-loss fix).
- 2026-09-29 Phase 6: docs (`dashboard.md`, design reconciliation D5/D9/D12 and verification map, evidence section in `docs/evidence/local-dashboard.md`), regenerated screenshots via `tests/dashboard-ui/capture.ts` (image message in every layout, new `chat-dark-commands.png`, no overflow), bundle/CSP assertions in `tests/dashboard-assets.test.ts`, and an image turn from the packed tarball in `tests/dashboard-installed.test.ts` (non-vision placeholder path). `npm run typecheck` clean; `npm test` 567/570 (3 baseline PTY); `npm run test:web` 192 pass; `npm run test:package` 4/4. Codex gpt-6-astra review: APPROVE in 1 round.
- 2026-09-29 Finalization: Global Gates re-run on the final tree (`npm run typecheck` clean; `npm test` 567/570 with only the 3 baseline PTY REPL failures that also fail on the pre-change HEAD; `npm run test:web` 192 pass across chromium/firefox/webkit; `npm run test:package` 4/4). Cumulative audit of interfaces (`UserBlock` -> `nativeUserContent` -> adapters; `AttachmentKinds` -> `HistoryAttachment` -> history route -> client kind registry; `SessionOperations.submit(intent, blocks)` keeps bytes off receipts) found no cross-phase defect. Completion Criteria all met; residual risks: qualification limited to this host and local mock providers, one accepted file-name-only directory swap window in `searchWorkspaceFiles`, non-vision note only considers loaded history pages.
