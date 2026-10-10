# Dashboard composer design

Design reference for the dashboard chat composer: attachments, images, `@` file references and `/` commands. It records decisions and their reasons so later changes can be checked against them. User-facing behavior lives in `dashboard.md`, routes in `dashboard-api.md`. The implementation plan is `add-chat-composer-attachments-and-commands-plan.md`.

Status: design accepted 2026-09-29 and implemented across the six phases of the plan (reconciled 2026-09-29; deviations are called out in D9 and D12). Update this file when a decision changes.

## Goals

- A composer that matches current coding-assistant conventions: auto-growing textarea, bottom toolbar (`+` left, Send/Stop right), attachment chips, `@` and `/` popovers.
- Images reach vision models, persist in the session, replay on resume and render in the timeline.
- New attachment kinds (other image formats, PDF, audio) are added by registering a kind, not by changing the pipeline.

## Non-goals (this iteration)

- Uploading non-image files. "Attach file" is a workspace file reference (`resource_link`).
- Image formats other than PNG/JPEG.
- Image blocks over ACP `session/prompt` (ACP replay of stored images must still work).
- Server-side skill invocation. `/skill` only inserts an instruction; the agent uses `list_skills`/`load_skill`.

## Data flow

```
browser                         dashboard server                       agent / model
-------                         ----------------                       -------------
pick / drop / paste image
  POST /sessions/:id/attachments  -> AttachmentKind.validate
                                  -> staging (id, TTL, caps)
  <- {id, mimeType, byteSize}
type text, `@` file chips
  POST /sessions/:id/operations
  {input, attachments[], files[]} -> resolve ids + paths
                                  -> UserBlock[] (text, resource_link, image)
                                  -> SessionOperations.submit(intent, blocks)
                                                                       -> agent.run(blocks)
                                                                       -> nativeUserContent
                                                                       -> adapter wire shape
history view / timeline
  GET .../history/:seq/attachments/:i <- bytes via kind registry
```

## Decisions

### D1. Image block shape
`UserBlock` gains `{type:"image", data /* base64 */, mimeType}`, the same shape ACP and MCP already use, so `src/sessions/display.ts` can forward it as an ACP block without conversion.

### D2. Upload is separate from the turn request
`MAX_JSON_BYTES` is 1 MiB, and a base64 image in the turn body would exceed it and bloat operation receipts. Images are uploaded first and referenced by id. Staged items are consumed only when a new operation is accepted, so a duplicate `clientRequestId` never consumes or duplicates them.

### D3. No storage format change
Image bytes live inside the persisted user message. Strings over 64 KiB are already moved to payload blobs by `SessionStore.stageStored`. `session_operations` keeps `input` as text only and never stores image bytes. A crash produces an `interrupted` operation, and nothing is replayed automatically (existing behavior).

### D4. Graceful degradation instead of a vision gate
A missing capability may reduce functionality but must never dead-end the user. When the model is non-vision (`models.<alias>.vision !== true`), a projection step applied at request-build time (before token estimation and adapter mapping) replaces every user image block in the effective context, new input and replayed history alike, with a text placeholder:

> [Image omitted: image/png, 48213 bytes, "screen.png". The current model cannot read images, so this image was replaced by this text placeholder. Its content may be described in earlier assistant messages of this conversation; ask the user to describe it or to switch to a vision-capable agent if you need to see it.]

The stored context is never rewritten, so switching back to a vision agent sends the original image natively again. The dashboard keeps attach enabled, warns on chips and shows a quiet composer note when history contains images the current agent cannot see. Size and type limits stay real rejections, but only of the offending attachment (chip-level error), never of the whole turn. Note: tool-result images keep their existing `vision_disabled` behavior.

### D5. Extensible attachment kinds
Three registries, each seeded with `image`:

| Layer | Location | Entry shape |
| --- | --- | --- |
| Model | `nativeUserContent` in `src/llm/content.ts` | validator + ordered content parts; adapters map parts, in order, to wire shape |
| Server | `AttachmentKind` in `src/dashboard/attachments.ts` | `{id, mimeTypes, maxBytes, validate, toBlock, fromBlock}` |
| Web | `web/src/composer/attachment-kinds.ts` (registry) and `builtin-kinds.tsx` (seeds) | `{id, label, icon, thumbnail?, timeline}`; `accept` and limits come from server metadata, never from the client |

`accept`, limits and enabled/disabled reasons reach the UI through `GET /api/agents/:name/composer` (`attachmentKinds`). Adding a kind therefore means one server entry, one model mapping (per adapter that supports it; others raise `unsupported_content`) and one client renderer. Tests register a fake kind to keep this true.

### D6. Adapters never inspect raw user blocks, and budgets are image-aware
All user-block validation and normalization happen in `nativeUserContent`, mirroring `nativeToolContent`. Normalization returns ordered parts so interleaved text/image order is preserved. The context estimator counts an image as a fixed conservative token constant, never as base64 text, so automatic compaction and `context_budget_exceeded` behave sensibly. Text-only turns keep the exact previous request bodies (OpenAI `content` stays a string).

### D7. Workspace file references are confined to the session cwd
`@` search and `files[]` resolve relative paths against the session cwd with `realpath` containment. `..`, absolute paths and symlink escapes are rejected. Search ignores `.git` and `node_modules`, and inside a git repository also whatever its ignore rules exclude.

### D8. History exposes metadata, not bytes
`HistoryView.attachments` carries `{index, kind, name, mimeType, byteSize}`; `kind` is the block's kind id (`image` today, `file` for a workspace `resource_link`, which has no bytes to serve), derived from the stored block in the session layer so history stays independent of the dashboard registry; the client keys its renderer registry on it. Bytes are served by `GET /api/sessions/:id/history/:sequence/attachments/:index`, dispatched through the server kind registry (`fromBlock`) and backed by a single-item store read by sequence (so old history pages stay reachable) with the stored mime, `nosniff` and same-origin `img-src`. Snapshots and SSE events never embed base64.

### D9. One generic suggestion popover
A single listbox component (focus stays in the textarea, wired with `aria-controls`, `aria-autocomplete="list"`, `aria-haspopup` and `aria-activedescendant`; a textarea cannot take `role=combobox` without an axe `aria-allowed-role` violation) with trigger-character providers. `/` (commands) and `@` (files) are providers, so a future trigger adds a provider only.

### D10. Slash commands wrap existing behavior
Built-ins map to actions that already exist in the UI: `/compact` (compact operation), `/rename` (rename modal), `/new` (New chat flow), `/details` (inspector toggle). Skill entries come from the selected agent's config and component catalog (available before the first send, unlike `metrics.capabilities`, which needs an attached runtime) and insert `Use the skill "<name>" for this task. `. Unknown `/x` is sent as plain text.

### D11. Preserved behavior
IME composition never selects or sends, `preferences.sendMode` is honored, per-session drafts persist, and the durable pending-receipt / duplicate-submit flow is unchanged. An open popover consumes Enter for selection instead of sending.

### D12. Web client details
Image bytes need the Bearer header, so the client fetches history images with `fetch` and renders `data:` URLs (`img-src 'self' data:` stays; no `blob:`). Chip thumbnails are read from the local file as `data:` too. A chip error (unsupported type, too large, server limit, expired) is local to that chip and never disables Send; only an in-flight upload does, and failed chips are simply not sent. Ready chips survive a session switch while the page lives.

### D13. Per-turn reasoning and service tier
The server describes the settings a turn may override in `GET /api/agents/:name/composer` as `controls`, built from the same value lists `requestSpec` validates (`src/request-controls.ts`), so the UI hardcodes no provider table and a provider without such settings shows no pill. A turn carries `request:{effort?, serviceTier?}`; it is validated with those lists (422 `invalid_request_option`), held in memory on the operation like turn blocks, merged into the model config by `attachSessionRuntime` for that operation only, and never written to config, `session_operations` or receipts. A duplicate `clientRequestId` returns the original receipt before the override is validated (same rule as attachments). `compact` refuses `request` (400 `invalid_input`).

| Provider | Control (label) | Maps to |
| --- | --- | --- |
| OpenAI | Reasoning, Service tier | `reasoning_effort` (`none`…`max`), `service_tier` (`auto`, `default`, `flex`, `fast`, `priority`) |
| Anthropic | Effort, Service tier | `effort` (`low`…`max`), `service_tier` (`auto`, `standard_only`) |
| DeepSeek | Reasoning | `reasoning_effort` (`low`, `high`, `max`) and forces `thinking` enabled |
| Google | Thinking | `thinkingLevel` (`minimal`…`high`) and drops any configured `thinkingBudget` |
| Other | none | none |

Excluded: `reasoning_mode`, token budgets, `/reasoning` and `/tier` commands, per-model filtering. The client remembers the choice per session in `sessionStorage` and defaults to "Agent default". Support is never guessed: the chosen value is sent, a provider rejection fails only that turn (the timeline shows `error · <provider message>`), and Agent default is always selectable. While metadata loads or fails the saved choice is kept but neither shown nor sent; it is pruned only after the selected agent's controls have loaded and no longer offer it.

## Limits

| Item | Value |
| --- | --- |
| Image types | PNG, JPEG (structure validated) |
| Image size | 8 MiB each (upload); 16 MiB aggregate decoded per turn, enforced at staging (chip-level rejection) and re-validated in `agent.run` before commit |
| Images per message | 8 |
| File references per message | 20 |
| Staging TTL | 30 minutes, dropped on server close |
| File search limit | default 20, maximum 50 |

## Alternatives rejected

- Base64 images inside the turn JSON: exceeds the body cap and bloats receipts.
- Persisting image bytes in `session_operations` or a new table: unnecessary storage change.
- Client-side "attach" that inlines file contents into text: loses images, wastes context, and cannot degrade gracefully for non-vision models.
- Hardcoding accepted types and limits in the UI: forces a UI change for every new kind.

## Extending

To add an attachment kind, for example PDF:

1. Add a `UserBlock` variant and a validator entry behind `nativeUserContent`.
2. Add the wire mapping in each adapter that supports it.
3. Register an `AttachmentKind` on the server.
4. Register the client kind (accept, icon, preview, timeline renderer).
5. Extend the docs tables above and in `dashboard-api.md`.

If a step beyond these is needed, the design has regressed; fix the registry rather than special-casing the kind.

## Verification map

| Decision | Proven by |
| --- | --- |
| D1, D4, D6 | `tests/provider-content.test.ts`, `tests/vision.test.ts` |
| D2, D3, D5 (server), D7 | `tests/dashboard-attachments.test.ts`, `tests/dashboard-sessions.test.ts` |
| D8 | `tests/session-view.test.ts`, `tests/dashboard-streams.test.ts` |
| D5 (web) | `tests/web-attachment-kinds.test.ts` (fake kind through the registry), `tests/dashboard-ui/attachments.spec.ts` |
| D9, D10, D11 | `tests/dashboard-ui/composer.spec.ts`, `chat.spec.ts`, `accessibility.spec.ts` |
| D12, image flow end to end | `tests/dashboard-ui/attachments.spec.ts`, `tests/dashboard-installed.test.ts` (installed artifact), `tests/dashboard-assets.test.ts` (bundle and CSP) |
| D13 (server) | `tests/request-controls.test.ts`, `tests/dashboard-request-controls.test.ts` |
| D13 (web) | `tests/web-request-choice.test.ts`, `tests/dashboard-ui/request-controls.spec.ts` |
