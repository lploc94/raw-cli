# Add an industry-standard workspace switcher and folder browser to the Raw dashboard

## Plan schema
loop-plan/v1

## Target

Choosing a workspace in the dashboard works like the recent-projects pickers of VS Code, Zed and the Codex/Claude desktop apps instead of typing a path into a modal:

- the sidebar workspace button opens a **workspace switcher** (popover): the **current** workspace (checked) first, then **Pinned**, then **Recent**, each row showing the folder name, a shortened path (`~/projects/raw-cli`), relative last-used time, chat count and a running-chat badge; a filter box narrows the list by name or path with arrow-key/Enter navigation;
- each row can be pinned/unpinned, have its path copied, or be removed from Recent (which only hides the entry; it never deletes chats or files);
- a workspace whose directory no longer exists is shown as **Missing** and cannot be selected, but it never breaks the list and can always be removed;
- the last item, **Open folder…**, opens a folder browser: a read-only, directories-only listing served by a new endpoint, with a typed-path field, an Up button, a hidden-folders toggle, inline errors, and an **Open this folder** action that validates through the existing `POST /api/workspaces/validate`;
- pins, removed entries and the folders you opened are remembered in the browser (`localStorage`), never in config or the database; a folder opened with **Open folder…** or chosen from the switcher joins Recent immediately, even before it has any chat.

## Scope

Included:

1. `GET /api/workspaces` enriched per item with `sessions` (chat count), `running` (non-terminal operations), `exists`, plus `home` and an `include` query parameter so pinned paths that are not in Recent still get metadata.
2. New read-only `GET /api/workspaces/browse` that lists sub-directories of a directory.
3. Web: pure workspace-list state module (pins, hidden, locally opened folders, ordering, filtering, path shortening, relative time), `WorkspaceSwitcher`, `FolderBrowser`, replacing the "Choose workspace" text-input modal in `web/src/App.tsx`.
4. Docs (`docs/dashboard.md`, `docs/dashboard-api.md`, new `docs/dashboard-workspace-design.md`, `docs/evidence/local-dashboard.md`), node and Playwright tests, screenshots.

Excluded:

- Persisting the currently selected workspace across a page reload (today it resets to the invoking directory; unchanged).
- Multi-folder projects, a project entity, renaming/relocating workspaces, cloning repositories, opening files, "open in a new window".
- Any server-side storage of pins/hidden entries, config writes, or schema/migration changes.
- Moving or deleting a session between workspaces. Existing sessions keep their saved workspace.
- Writing, creating, renaming or deleting directories through the browser; listing files or reading file contents.
- A sidebar badge for running chats in workspaces other than the current one when the switcher is closed (counts are shown inside the open switcher).
- Changing the CLI or ACP workspace handling.

## Invariants

1. **Read-only, directories-only browsing.** `browse` never returns file names, file contents, sizes or modification data and never creates, changes or deletes anything. It only reveals directory names the dashboard's own user account can already read.
2. A workspace changes relative runtime paths, not OS filesystem permissions (existing `docs/dashboard.md` statement stays true and is repeated next to browse).
3. Config bytes are never modified; pins/hidden state live only in `localStorage` (`raw.dashboard.workspaces.v1`). No SQLite change.
4. Existing sessions keep their saved workspace; switching workspace only changes where **new** chats are created and which chats the sidebar lists (current behavior).
5. **Degrade, never block.** A Missing or unreadable directory, an unavailable/corrupt `localStorage`, a failed `/api/workspaces` fetch or a failed browse never dead-ends the UI: the current workspace stays usable, the error is shown inline, and typing a path plus **Open this folder** always remains available.
6. Same authentication as every other `/api/*` route (Bearer token, loopback only); no new listener or credential.
7. Choosing a workspace keeps existing behavior: `setWorkspace`, `navigate("/chat")`, clear the page error; choosing the current workspace only closes the switcher.
8. Keyboard and screen-reader access: full operation without a pointer, focus returns to the workspace button on close, axe reports no violations, works in the narrow-viewport drawer.

## Baseline

Verified before planning (do not redo):

- `GET /api/workspaces` returns `{items:[{cwd,updatedAt}]}` from `store.recentWorkspaces()` (`src/sessions/store.ts:312`, retention-filtered, max 100, newest first) with the invoking directory unshifted at `updatedAt: 0` (`src/dashboard/sessions.ts:109`). **The web UI never calls it.** `POST /api/workspaces/validate` returns `{cwd}` (canonical realpath) or 400 `invalid_workspace` (`workspacePath`, `src/dashboard/sessions.ts:28`).
- The store-unavailable guard returns 503 `store_unavailable` for every `/api/workspaces*` route when there is no store (`src/dashboard/sessions.ts:46`).
- The UI today: `web/src/App.tsx` has a `workspace` state (initialized from `bootstrap.cwd`), a sidebar `.workspace-button` (`App.tsx:188`) and a `Modal` "Choose workspace" with one `Workspace directory` input and a `Use workspace` button (`App.tsx:587`). `tests/dashboard-ui/shell.spec.ts:21-27` drives that modal.
- The sidebar element is rendered both in the desktop `aside` and in the mobile drawer `Modal` (`App.tsx:399`, `:580`).
- `App` polls `GET /api/activity` every 2 s and tracks an activity revision (`previousActivity`); activity operations carry `sessionId`, not `cwd`.
- `SessionOperations.activeIds()` (`src/sessions/operations.ts:65`) and `store.getSession()`/`getOperation()` are enough to compute running chats per workspace on the server.
- `searchWorkspaceFiles` (`src/dashboard/files.ts`) is the repository pattern for a bounded, non-following directory walk with `DashboardError` codes; `workspaceFileLink` is the pattern for 422 `invalid_file`.
- UI primitives: Radix `radix-ui` (Popover used in `web/src/composer/RequestControls.tsx`, Dialog in `web/src/ui.tsx` `Modal`), `lucide-react`, `CopyButton` in `ui.tsx`. Browser storage pattern: `web/src/preferences.ts` (versioned key, per-field validation, try/catch) and `web/src/composer/request-choice.ts` (pure module tested from node in `tests/web-request-choice.test.ts`).
- Tests: `scripts/test.mjs` required list; `dashboardFixture` (`tests/fixtures/dashboard.ts`) exposes `root`, `server` (with `token`, `context`), `api()`; Playwright fixtures in `tests/dashboard-ui/fixtures.ts`; screenshots by `tests/dashboard-ui/capture.ts`; asset-string check in `tests/dashboard-assets.test.ts`.
- The 3 PTY REPL failures in `tests/cli.test.ts` fail identically on the pre-change baseline and are unrelated.

## Design and project patterns

- **Industry pattern (researched 2026-09-29)**: VS Code "Open Recent" and Welcome, Zed Open Recent, Visual Studio pin/remove, Codex/Claude desktop project pickers converge on: Recent ordered by last use; name plus shortened path; a filter; "Open folder…" as a final action; pin and remove-from-list per entry; keyboard-first. VS Code's known weakness (no in-list removal) is avoided by per-row actions.
- **Server list** (`GET /api/workspaces[?include=<path>&include=…]`): items `{cwd, updatedAt, sessions, running, exists}` plus top-level `home` and `current` (the invoking directory). `sessions` counts retention-visible sessions per workspace via the same `JOIN`/cutoff as `recentWorkspaces`; `running` counts operations in `operations.activeIds()` whose session is in that workspace; `exists` is a per-item `stat().isDirectory()` (async, non-throwing). `include` paths (max 50, each ≤ 4096 chars, deduplicated, `~` expanded) are appended when absent from Recent and carry the **same** metadata as a Recent item: `sessions`, `updatedAt` and `running` come from the store (looked up by canonical path, same retention cutoff, not subject to the 100-item Recent limit) and are zero only when the path has no retained chats or does not exist. The invoking directory is always present as today. Invalid `include` → 400 `invalid_input`.
- **Browse** (`GET /api/workspaces/browse?path=&hidden=&q=`): `path` absolute or `~`-prefixed (default: home); relative or missing/non-directory path → 400 `invalid_workspace` "Choose an existing directory"; unreadable directory (`EACCES`/`EPERM`) → 422 `unreadable_directory`. Response `{path, parent, home, entries:[{name, path, symlink?}], truncated}`: `path` is the canonical realpath; `parent` is `dirname(path)` or `null` at the filesystem root; `entries` are sub-directories only (a symlink that resolves to a directory is listed with `symlink: true`; symlinks to files and broken links are dropped), dot-directories omitted unless `hidden=1`, optional case-insensitive substring `q`, sorted case-insensitively, capped at 500 with `truncated: true`. Entry `path` is `join(path, name)`; selecting it is always re-validated by `POST /api/workspaces/validate`, which returns the canonical path. Pattern: bounded readdir in `src/dashboard/files.ts`; error style in `src/dashboard/errors.ts`. Implementation lives in a new `src/dashboard/workspaces.ts` so `sessions.ts` only routes.
- **Home directory**: `context.env.HOME ?? context.env.USERPROFILE ?? os.homedir()` (tests inject `env`).
- **Client state** (`web/src/workspace/workspace-state.ts`, pure, no React): `{version:1, pinned:string[], hidden:string[], opened:{path:string, at:number}[]}` at `raw.dashboard.workspaces.v1`; validated on load (malformed members ignored, deduplicated, pinned ≤ 50, hidden ≤ 200, opened ≤ 50, oldest evicted); functions `loadState`, `saveState`, `togglePin`, `hide`, `unhide`, `recordOpened(state, path, now)`, `arrange(items, state, current)` → `{current, pinned, recent}`, `filterRows`, `shortenPath(path, home)`, `relativeTime(ms, now)`. Recent = server items plus `opened` paths (their metadata fetched through `include`), each ranked by `max(server updatedAt, opened.at)` so a just-opened folder without chats leads Recent. Order: current first (always shown even if hidden), then pinned in pin order, then the rest by that rank desc; hidden entries are excluded unless current or pinned. Successfully opening a workspace (from a switcher row or Open folder…) removes it from `hidden` and records it in `opened`; **Remove from recent** adds it to `hidden` and drops it from `opened`.
- **Switcher UI** (`web/src/workspace/WorkspaceSwitcher.tsx`): Radix `Popover` anchored to the existing `.workspace-button`; content: filter input, group headings (Current, Pinned, Recent) as list headings, rows as `<li>` each with a primary `<button>` (folder icon, name, path, meta `3 chats · 2 h ago`, `Running` badge, `Missing` badge, check for current) and action buttons (pin toggle; a Radix `DropdownMenu` "More actions" with Copy path and Remove from recent). Keyboard: ArrowDown/ArrowUp from the filter input roving-focus the primary buttons (ArrowUp from the first returns to the input), Enter/click selects, Enter in the filter selects the first matching selectable row, Escape closes and returns focus to the button; action buttons are ordinary tab stops (avoids `aria-activedescendant` widgets with nested buttons). Data is fetched on open and refetched when the App activity revision changes while open. Last item: `Open folder…`. Empty filter result: "No matching workspaces" with the Open folder action.
- **Missing rows**: `exists === false` → `aria-disabled` primary button with description "Folder not found", not selectable; Remove from Recent (and Unpin) stay enabled. Selecting nothing never blocks other rows.
- **Folder browser** (`web/src/workspace/FolderBrowser.tsx`) inside `Modal` "Open folder": path field (label `Workspace directory`; Enter/Go navigates via `browse`), Up button, `Show hidden folders` checkbox, a filter for the current listing (`q`), list of sub-folders (click enters), states loading/empty ("No subfolders")/truncated ("Showing the first 500 — type a path or filter")/error (inline `role=alert`, Up and the path field still work), and an **Open this folder** button that calls `POST /api/workspaces/validate` for the shown path, then applies the standard workspace switch. Starts at the current workspace's directory (falls back to home when unavailable).
- **Docs pattern**: `docs/dashboard-api.md` (routes, fields, errors), `docs/dashboard.md` (behavior), a new design record `docs/dashboard-workspace-design.md` (decisions, alternatives rejected, verification map) like `docs/dashboard-composer-design.md`, evidence row in `docs/evidence/local-dashboard.md`, screenshots via `tests/dashboard-ui/capture.ts`.

## Global Gates

- `npm run typecheck`
- `npm test` (builds, then runs every required node test file; only the 3 known baseline PTY failures in `tests/cli.test.ts` are acceptable)
- `npm run test:web` (all Playwright projects) for any phase touching `web/`
- `npm run test:package` after Phase 3
- No behavior change to `POST /api/workspaces/validate`, session creation, or session listing.
- `git status` clean except intended files at each phase commit.

## Plan Review

APPROVE — intent-fidelity and self-review completed on 2026-09-29; Codex (gpt-6-astra) plan review APPROVE in 3 rounds (5 findings fixed: typed-path Open independent of browse, real metadata for `include`d paths, re-validation of a stale row on select, user-approved browser-local `opened` history so no-chat folders join Recent, include batching to stay within the 50-path cap). Every agreed decision maps to a phase; exclusions (reload persistence, multi-folder projects, directory writes, cross-workspace sidebar badge) are explicit; paths and symbols verified against the current tree.

## Phase 1: Server: enriched workspace list and read-only folder browse

### Goal
`GET /api/workspaces` returns the metadata a switcher needs, and a new `GET /api/workspaces/browse` lists sub-directories safely, both with documented contracts and tests.

### Current behavior and gap
The list returns only `{cwd, updatedAt}` and is unused by the UI. There is no way for the browser to discover directories; the only input is a typed path validated with `POST /api/workspaces/validate`.

### Evidence
`src/dashboard/sessions.ts:109-113` (both routes), `src/sessions/store.ts:312` (`recentWorkspaces`), `src/sessions/operations.ts:65` (`activeIds`), `src/dashboard/files.ts` (bounded walk, `DashboardError`), `src/dashboard/errors.ts` (`DashboardError`, `textField`), `docs/dashboard-api.md:17`.

### Pattern
`searchWorkspaceFiles` for bounded non-throwing directory reads; `workspacePath` for canonical validation and the `invalid_workspace` error; route-splitting kept in `sessions.ts` with logic in a sibling module like `files.ts`/`attachments.ts`.

### Dependencies
None.

### Files and symbols
- `src/dashboard/workspaces.ts` (new): `listWorkspaces`, `browseDirectory`, `expandHome`, constants for caps.
- `src/sessions/store.ts`: `recentWorkspaces()` returns `sessions` count too (same `JOIN`/cutoff), and a new `workspaceActivity(canonicalPaths)` returns `{cwd, updatedAt, sessions}` for given paths with the same cutoff and no Recent limit (used for `include`); `running` is computed by mapping active operation → session (`getOperation`/`getSession`).
- `src/dashboard/sessions.ts`: route `GET /api/workspaces` (extended), `GET /api/workspaces/browse`.
- `docs/dashboard-api.md`.
- `tests/dashboard-workspaces.test.ts` (new), `scripts/test.mjs` (add `dashboard-workspaces` to the required list).

### Behavioral contract
1. `GET /api/workspaces` → `{items:[{cwd, updatedAt, sessions, running, exists}], home, current}`. Existing consumers of `cwd`/`updatedAt` are unaffected. `current` equals the invoking directory and is always present in `items` (as today, `updatedAt: 0` when it has no chats). `sessions` is the number of retention-visible sessions in that workspace; `running` the number of active operations whose session is in it; `exists` false when the path is gone or not a directory.
2. `?include=<path>` (repeatable, ≤ 50, each string ≤ 4096, `~` expanded, deduplicated) appends paths missing from the list with the same metadata as a Recent item: real `sessions`, `updatedAt` (retention-filtered) and `running` when the workspace has stored chats — including a workspace displaced beyond the 100-item Recent limit — and zeros only when it has none; `exists` is always real. A non-string/overlong/over-count value → 400 `invalid_input`. A path that already appears in the list is not duplicated (compared by canonical path when it resolves). `include` never creates a workspace record.
3. `GET /api/workspaces/browse?path=&hidden=&q=` as specified in Design: canonical `path`, `parent` (`null` at root), `home`, `entries` (directories only, dot-dirs only with `hidden=1`, `q` case-insensitive substring, case-insensitive sort, symlink-to-directory flagged and listed, other symlinks dropped), `truncated` when more than 500 match. Missing `path` → home. Relative path, nonexistent path, or a file → 400 `invalid_workspace`; permission denied → 422 `unreadable_directory`; `hidden` must be `0|1|true|false` else 400 `invalid_input`; `q` ≤ 200 chars.
4. No file name, size, mtime or content ever appears in a browse response, even when the directory contains only files.
5. No request mutates the filesystem, config, or store.
6. Both routes require the Bearer token; with no session store both return 503 `store_unavailable` (existing guard, unchanged).

### Documentation
Update `docs/dashboard-api.md` first: extend the `GET /api/workspaces` bullet (fields, `include`), add a `GET /api/workspaces/browse` bullet (parameters, response, errors, "read-only directory listing; a workspace changes relative paths, not OS permissions").

### Tests first
`tests/dashboard-workspaces.test.ts` using `dashboardFixture` (real server, temp dirs; `env.HOME` pointed at a temp home):
- list: counts per workspace across two workspaces with 2 and 1 sessions; `current` present; `exists:false` after `rmSync` of a stored workspace; retention-expired sessions not counted; `running` becomes 1 while a turn is held open (mock provider gate) and returns to 0 afterwards; `include` appends a pinned path with `exists`, dedupes, and rejects 51 paths/non-string/oversized; an `include`d workspace displaced beyond the 100-item Recent limit (seed 101 newer workspaces) still reports its real `sessions`, `updatedAt` and `running` (including an active turn), and a path with no chats reports zeros.
- browse: fixture tree with dirs, files, dot-dir, symlink→dir, symlink→file, broken symlink; default path = injected home; `hidden` toggle; `q` filter; sort order (`b`, `A`, `c` → `A`, `b`, `c`); `parent` chain up to `null` at `/`; `~` and `~/x` expansion; `truncated` with 501 dirs and exactly 500 entries; only-files directory → empty `entries` and no file name anywhere in the raw response text; relative/nonexistent/file → 400 `invalid_workspace`; `chmod 000` directory → 422 `unreadable_directory` (skipped when running as root or on win32); bad `hidden` → 400.
- no auth → 401; config file bytes identical before/after all requests; directory listing of the fixture tree identical before/after.

### Anti-shortcut coverage
Counts and `running` are asserted with distinct values per workspace and change after actions, so constants fail. The "only files" and symlink-to-file cases reject a naive `readdir` that returns everything; the 501-directory case rejects an unbounded listing; the raw-text assertion rejects leaking file names in any field; the config/tree byte comparison rejects hidden side effects; `exists` after `rmSync` rejects hardcoded `true`.

### Implementation obligations
Compute `sessions` in the same SQL as `recentWorkspaces`; compute `running` from `operations.activeIds()` mapped through `store.getOperation`/`getSession` (skip vanished sessions); stat items concurrently with a bound; canonicalize with `realpath`; never follow symlinks beyond a single `stat` to classify an entry; map `EACCES`/`EPERM` to 422 and everything else to `invalid_workspace`; keep the store-unavailable guard behavior.

### Acceptance criteria
- [x] AC-1: `/api/workspaces` items carry correct `sessions`, `running`, `exists`, and the response has `home` and `current` — proven by `tests/dashboard-workspaces.test.ts`.
- [x] AC-2: `include` appends and dedupes pinned paths and rejects invalid values with 400 `invalid_input` — proven by the same file.
- [x] AC-3: `browse` returns only directories with the specified filtering, ordering, `parent`, cap and `truncated` semantics — proven by the same file.
- [x] AC-4: `browse` errors are 400 `invalid_workspace` or 422 `unreadable_directory` as specified and leak no file names — proven by the same file.
- [x] AC-5: No request changes config bytes or the directory tree; routes need the token — proven by the same file.
- [x] AC-6: `docs/dashboard-api.md` documents both routes accurately — proven by inspection of the diff.

### Focused verification
`node --import tsx --test tests/dashboard-workspaces.test.ts tests/dashboard-sessions.test.ts`

### Phase gates
`npm run typecheck && npm test` (only the 3 baseline PTY failures acceptable)

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: list workspace metadata and browse directories in the dashboard API`

## Phase 2: Web: workspace switcher with Current, Pinned and Recent

### Goal
Replace the sidebar button's text-input modal entry with the switcher popover; keep the typed-path modal reachable through "Open folder…" until Phase 3 upgrades it.

### Current behavior and gap
The button opens a modal with one free-text input; recent workspaces, counts, running state, pin/remove and filtering do not exist in the UI.

### Evidence
`web/src/App.tsx:54-57, 188-205, 587-618`, `web/src/ui.tsx` (`Modal`, `CopyButton`), `web/src/composer/RequestControls.tsx` (Radix Popover pattern), `web/src/preferences.ts` (storage pattern), `tests/dashboard-ui/shell.spec.ts:21-27`.

### Pattern
Pure module + React component split as in `web/src/composer/request-choice.ts` / `RequestControls.tsx`; versioned defensive `localStorage` as in `preferences.ts`; Popover focus-return as in `RequestControls`.

### Dependencies
Phase 1 (list fields, `include`, `home`).

### Files and symbols
- `web/src/workspace/workspace-state.ts` (new): `loadState`, `saveState`, `togglePin`, `hide`, `unhide`, `arrange`, `filterRows`, `shortenPath`, `relativeTime`.
- `web/src/workspace/WorkspaceSwitcher.tsx` (new).
- `web/src/App.tsx`: sidebar button becomes the popover trigger; `chooseWorkspace(cwd)` extracted from the existing submit handler and shared with the modal; activity revision exposed to the switcher; the existing modal stays, opened by "Open folder…".
- `web/src/styles.css`: `.workspace-popover`, `.workspace-row`, badges, narrow rules.
- `docs/dashboard.md`, `docs/dashboard-workspace-design.md` (new), `tests/web-workspace-state.test.ts` (new), `tests/dashboard-ui/workspace.spec.ts` (new), `tests/dashboard-ui/shell.spec.ts` (open the modal through the switcher), `scripts/test.mjs` (add `web-workspace-state`).

### Behavioral contract
1. Clicking the workspace button opens the popover; the button still shows the current folder name with the full path in `title`; the popover fetches `GET /api/workspaces?include=<pinned and opened paths…>` on open (the deduplicated union, up to 100 paths, is sent in batches of at most 50 `include` values per request and the responses are merged by canonical path, keeping the request URL short and under the server cap; the first batch also carries the list itself, later batches only add items) and again when the activity revision changes while open.
2. Groups and order: **Current** (checked, always shown), **Pinned**, **Recent**; hidden entries excluded unless current or pinned; each row shows name, `~`-shortened path, `N chats`, relative time (`just now`, `5 min ago`, `2 h ago`, `3 d ago`, then a date) and a `Running` badge when `running > 0`.
3. The filter matches name or path case-insensitively (substring, then in-order characters); non-matching rows and empty groups disappear; no match shows "No matching workspaces".
4. Selecting a non-current row first re-validates it with `POST /api/workspaces/validate` (the list's `exists` can be stale); on success it applies the standard switch with the returned canonical path (`setWorkspace`, `navigate("/chat")`, clear page error), un-hides that path, records it as opened and closes; on failure the switcher stays open, the row is marked Missing with "Folder not found", and nothing is switched. Selecting Current only closes. Rows already known Missing are `aria-disabled` with "Folder not found", never selectable, still removable/unpinnable.
5. Pin/unpin moves the row between groups immediately and persists; **Remove from recent** hides the row and persists, and never touches sessions or files; **Copy path** copies the full canonical path (failure shows the existing "Copy unavailable" text).
6. `Open folder…` closes the popover and opens the existing typed-path modal (Phase 3 upgrades it).
7. Failure of any `/api/workspaces` batch shows an inline error in the popover and still lists Current plus pinned/remembered names without metadata and keeps `Open folder…` usable. Corrupt or unavailable `localStorage` behaves as an empty state (no pins, hidden or opened entries) without errors and without losing the in-memory session choices.
8. Keyboard per Design; focus returns to the workspace button on close; works identically in the mobile drawer.

### Documentation
Create `docs/dashboard-workspace-design.md` (goals, non-goals, industry research summary, decisions D1–D6: source of truth, client-only pins, missing-row policy, keyboard model, why not a native OS dialog, alternatives rejected) and update `docs/dashboard.md` "Chat workspace" first (switcher behavior, pins/removal are remembered by this browser only, Missing rows).

### Tests first
- `tests/web-workspace-state.test.ts` (node): load/save round trip; corrupt JSON, wrong version, non-array/non-string members, duplicates, oversize lists; `togglePin` cap 50; `hide` cap 200 eviction; `recordOpened` cap 50, refresh of an existing path, ranking of an opened no-chat folder above older chat workspaces; `arrange` order with varying `updatedAt`, hidden exclusion, current-always-shown, pinned-not-in-recent; `filterRows`; the batching helper (50 pinned + 50 distinct opened paths → two requests of ≤ 50, overlap deduplicated, merge keeps the richest metadata); `shortenPath` for home, nested, outside-home, home itself, trailing slash; `relativeTime` boundaries with injected `now`.
- `tests/dashboard-ui/workspace.spec.ts` (Playwright, 3 browsers): seed sessions in two extra temp workspaces through `POST /api/sessions` with the fixture token; open the switcher and assert group order, counts, shortened path; filter; keyboard navigation (ArrowDown/Up, Enter, Escape, focus return); switch workspace and assert the session list changed and the New chat button creates a chat in the new workspace; pin then reload and assert it stays pinned; choose a workspace that has no chats, switch away, and assert it is still listed in Recent (with `0 chats`) after a reload; remove from recent then reload and assert hidden while the sessions still exist; a workspace deleted on disk shows Missing and cannot be selected but can be removed; a workspace deleted **after** the list loaded (row still looks selectable) fails validation on click, keeps the switcher open, becomes Missing and does not change the workspace; a held-open turn shows the Running badge; corrupted `localStorage` value does not break the app; mobile viewport drawer works; axe scan of the open popover.
- Update `shell.spec.ts` to reach the typed-path modal via the switcher's Open folder…

### Anti-shortcut coverage
Distinct chat counts/times per workspace and a reload in the pin/remove specs reject in-memory-only or hardcoded rows; the deleted-directory case rejects always-selectable rows; the "sessions still exist after removal" assertion rejects a removal that deletes data; the corrupt-storage case rejects unguarded `JSON.parse`; ordering tests with shuffled `updatedAt` reject fixed ordering; a second identical `basename` in different parents (`a/app`, `b/app`) must remain distinguishable by shortened path.

### Implementation obligations
Keep all provider/server knowledge out of the state module; guard every storage access with try/catch; debounce nothing that affects correctness; ensure the Popover works inside the mobile drawer Dialog (portal/focus-trap) and that only one switcher instance is mounted at a time per surface; label every control (`aria-label` on icon buttons, group headings as headings, badges not the only carrier of state); keep the existing modal code path intact for Phase 3; no new dependencies (Radix `radix-ui` already provides DropdownMenu).

### Acceptance criteria
- [x] AC-1: Switcher shows Current, Pinned and Recent groups in the specified order with name, shortened path, count, relative time — proven by `workspace.spec.ts`.
- [x] AC-2: Filtering and keyboard navigation work and focus returns to the button — proven by `workspace.spec.ts`.
- [x] AC-3: Selecting a row switches workspace with existing behavior; Current only closes — proven by `workspace.spec.ts`.
- [x] AC-4: Pin, Remove and locally opened (no-chat) folders persist across reload, removal never deletes chats, Copy path works — proven by `workspace.spec.ts`.
- [x] AC-5: Missing directories show `Missing`, are not selectable, and are removable; `Running` badge appears for an active turn — proven by `workspace.spec.ts`.
- [x] AC-6: Failed list fetch and corrupt storage degrade gracefully while Open folder… stays usable — proven by `workspace.spec.ts` and `tests/web-workspace-state.test.ts`.
- [x] AC-7: State module semantics (validation, caps, ordering, shortening, relative time) hold — proven by `tests/web-workspace-state.test.ts`.
- [x] AC-8: No axe violations and the narrow drawer works in all three browsers — proven by `workspace.spec.ts` axe/mobile specs.
- [x] AC-9: `docs/dashboard.md` and the new design doc describe the behavior — proven by inspection of the diff.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/workspace.spec.ts tests/dashboard-ui/shell.spec.ts && node --import tsx --test tests/web-workspace-state.test.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:web`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: add a workspace switcher with pinned and recent workspaces to the dashboard`

## Phase 3: Web: folder browser for "Open folder…", docs and screenshots

### Goal
Replace the typed-path modal with a folder browser backed by `browse`, while keeping the typed path and inline validation, and finish documentation and evidence.

### Current behavior and gap
"Open folder…" (after Phase 2) still opens the bare text input; users must know and type an absolute path.

### Evidence
`web/src/App.tsx` modal body (`Field label="Workspace directory"`, `Use workspace`), Phase 1 `browse`, `tests/dashboard-ui/capture.ts`, `tests/dashboard-assets.test.ts`, `docs/evidence/local-dashboard.md`.

### Pattern
`Modal` (`web/src/ui.tsx`); the `@` file picker for list/loading/error states (`web/src/composer/files.ts`); screenshot registration in `capture.ts` as done for `chat-dark-controls.png`.

### Dependencies
Phases 1 and 2.

### Files and symbols
- `web/src/workspace/FolderBrowser.tsx` (new), `web/src/App.tsx` (modal body replaced), `web/src/styles.css`.
- `docs/dashboard.md`, `docs/dashboard-api.md` (only if wording needs alignment), `docs/dashboard-workspace-design.md`, `docs/evidence/local-dashboard.md`, `docs/dashboard/workspace-dark-switcher.png`, `docs/dashboard/workspace-dark-browser.png`.
- `tests/dashboard-ui/workspace.spec.ts`, `tests/dashboard-ui/shell.spec.ts`, `tests/dashboard-ui/capture.ts`, `tests/dashboard-assets.test.ts`.

### Behavioral contract
1. "Open folder…" opens a modal "Open folder" starting at the current workspace directory (home when that cannot be read). It shows the path field (`Workspace directory`), an Up button (disabled at the root), a `Show hidden folders` checkbox, a filter for the shown listing, and the list of sub-folders; clicking a folder navigates into it; Enter in the path field navigates to the typed path.
2. States: loading, "No subfolders", truncated note, and inline `role=alert` errors from `invalid_workspace`/`unreadable_directory`; after an error the previous listing, Up and the path field remain usable.
3. **Open this folder** validates the text currently in the path field (after a successful navigation this equals the shown path) with `POST /api/workspaces/validate`, independently of whether `browse` succeeded or is available, and applies the standard switch with the returned canonical path (`setWorkspace`, un-hide, `navigate("/chat")`, close); a failure shows the inline error and keeps the dialog open. Typing a valid path and pressing Open therefore works even when `browse` fails.
4. Symlinked folders show a link marker; hidden folders appear only when the toggle is on; the toggle resets each time the dialog opens.
5. Fully keyboard operable; focus lands in the path field on open and returns to the workspace button on close; works in the mobile drawer and at 400 % zoom.
6. The browser never displays files and never offers create/rename/delete.

### Documentation
Update `docs/dashboard.md` (Open folder behavior, read-only note, hidden toggle), `docs/dashboard-workspace-design.md` (browse decision D7: server-side listing vs typed path only vs native picker, threat model: same token, directory names only), and `docs/evidence/local-dashboard.md` (new evidence rows). Add the two screenshots and reference them from `docs/dashboard.md`.

### Tests first
Extend `workspace.spec.ts` (3 browsers): open the browser at the current workspace; navigate into a sub-folder, Up, root disables Up; typed path Enter navigates; hidden toggle reveals a dot-folder and resets on reopen; a folder containing only files shows "No subfolders" and no file name in the DOM; a nonexistent typed path and an unreadable folder show inline errors and leave the dialog usable; Open this folder switches the workspace and the new path appears in Recent afterwards even though no chat was created (after a reload too), then disappears after Remove from recent; a directory removed between listing and Open shows the validate error inline; with every `browse` request failing (Playwright route abort or 500), typing a valid absolute path and clicking Open this folder still switches the workspace; axe on the dialog; narrow drawer. Update `shell.spec.ts` to the new labels. `tests/dashboard-assets.test.ts` gains the strings "Open folder", "Show hidden folders", "Open this folder". `capture.ts` writes the two screenshots.

### Anti-shortcut coverage
The files-only directory and DOM text assertion reject rendering files; nested navigation with Up and a typed path reject a static list; the hidden toggle reset rejects leaked state; the "removed between listing and Open" case rejects skipping validate; error-then-continue assertions reject dialogs that dead-end.

### Implementation obligations
Use `browse` for all directory data (no client-side path arithmetic beyond display); race-guard responses so a slower earlier request cannot overwrite a newer listing (abort or sequence token); keep validation authoritative on the server; preserve the Phase 2 switcher contract; regenerate screenshots after `npm run build`.

### Acceptance criteria
- [x] AC-1: Open folder starts at the current workspace and navigates folders, Up, typed path and hidden toggle as specified — proven by `workspace.spec.ts`.
- [x] AC-2: Only directories are displayed; empty, truncated and error states are shown inline without dead-ending — proven by `workspace.spec.ts`.
- [x] AC-3: Open this folder validates server-side and switches workspace with standard behavior; failures stay in the dialog — proven by `workspace.spec.ts`.
- [x] AC-4: Keyboard, focus return, axe and narrow drawer pass in all three browsers — proven by `workspace.spec.ts`.
- [x] AC-5: A stale slow listing never overwrites a newer one — proven by a Playwright spec that delays the first `browse` response.
- [x] AC-6: Docs, design record, evidence rows and both screenshots exist and match behavior — proven by inspection and `tests/dashboard-assets.test.ts`.
- [x] AC-7: Global gates pass on final `HEAD` — proven by the gate commands.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/workspace.spec.ts tests/dashboard-ui/shell.spec.ts && node --import tsx --test tests/dashboard-assets.test.ts`

### Phase gates
`npm run typecheck && npm test && npm run test:web && npm run test:package`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: browse folders when opening a dashboard workspace`

## Completion Criteria

- [x] All three phases committed, each with implementation review APPROVE.
- [x] Every Global Gate passes on final `HEAD` (only the 3 baseline PTY failures in `tests/cli.test.ts` remain).
- [x] Switcher, browse, pins/removal, Missing and Running behavior verified in chromium, firefox and webkit including axe and narrow viewport.
- [x] `browse` proven read-only and directories-only; config bytes and directory trees unchanged by every request.
- [x] `docs/dashboard.md`, `docs/dashboard-api.md`, `docs/dashboard-workspace-design.md`, `docs/evidence/local-dashboard.md` and screenshots updated; worktree clean.

## Progress Log

| Phase | Status | Commit | Notes |
| --- | --- | --- | --- |
| 1 Server: workspace list + browse | complete | da0bb75 | Codex gpt-6-astra APPROVE in 2 rounds (3 findings fixed: EACCES on path → 422, truncation semantics, stat concurrency); npm test 589/592 (3 baseline PTY) |
| 2 Web: switcher | complete | 05291b4 | Codex gpt-6-astra APPROVE in 6 rounds (9 findings fixed: stale selection race, stale rows after failed refresh, Remove on pinned rows, storage validation and request-safe include paths, batching by URL budget, arrow stops reach Open folder, clipboard guard); npm test 602/605 (3 baseline PTY); test:web 269 passed with occasional unrelated webkit/firefox timing flakes that pass on rerun |
| 3 Web: folder browser, docs, screenshots | complete | f96df35 | Codex gpt-6-astra APPROVE in 7 rounds (8 findings fixed: typed-path races with initial load/fallback/refresh/failed Go, pending Open after close, refresh target during navigation and before the first listing, capture temp folder cleanup); npm test 603/606 (3 baseline PTY); test:web 315 passed; test:package 4/4 |
| Integration audit | complete | 5870af0 | Canonical-path fix for symlinked-cwd chats (duplicate row and running count); Codex APPROVE in 2 rounds; final gates: npm test 604/607 (3 baseline PTY), test:web green (one firefox contrast flake passed on rerun), test:package 4/4 |
