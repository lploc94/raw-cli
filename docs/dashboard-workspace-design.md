# Dashboard workspace switcher design

Design reference for choosing a workspace in the dashboard. It records decisions and their reasons so later changes can be checked against them. User-facing behavior lives in `dashboard.md`, routes in `dashboard-api.md`. The implementation plan is `add-dashboard-workspace-switcher-plan.md`.

Status: design accepted 2026-09-29; implemented across the three phases of the plan. Update this file when a decision changes.

## Goals

- Choosing a workspace feels like the recent-projects pickers of VS Code, Zed and the Codex and Claude desktop apps: a Recent list, the current workspace, pins, a filter and an "Open folder…" action, instead of typing a path.
- The picker never dead-ends: a missing folder, a failed request or unavailable browser storage degrades the list, not the app.

## Non-goals

- Remembering the selected workspace across a reload (it still starts at the directory `raw dashboard` was launched in).
- Multi-folder projects, renaming or relocating workspaces, cloning repositories, opening files.
- Storing anything on the server or in config. Creating, renaming or deleting directories.

## Industry pattern

Researched 2026-09-29: VS Code (Welcome and Open Recent, with pin and remove gaps reported in its issue tracker), Zed (Open Recent, `Cmd+O`), Visual Studio (pin and remove), Codex and Claude Code desktop (project pickers). They converge on a Recent list ordered by last use, a name plus shortened path, a filter, "Open folder…" as a final action and per-entry pin and remove, all operable from the keyboard.

## Decisions

### D1. The server is the source of truth for facts, the browser for preferences
`GET /api/workspaces` reports what exists: chats, running operations, whether the folder exists. Pins, removed entries and folders opened in this browser are preferences and live in `localStorage` (`raw.dashboard.workspaces.v1`), like the other dashboard preferences. The config bytes and the session store are never changed by choosing a workspace.

### D2. Removing from Recent only hides
"Remove from recent" adds the path to a hidden list. It never deletes chats, files or store records, and opening the workspace again shows it again.

### D3. Missing folders degrade, not block
A folder that no longer exists is shown as `Missing`, cannot be chosen (its chat list could not be loaded anyway) and can always be removed. The existence flag can be stale, so choosing any row re-validates it with `POST /api/workspaces/validate` and only then switches.

### D4. Keyboard model
The filter and the rows are ordinary controls, not an `aria-activedescendant` widget: each row is a list item with a primary button and its own action buttons. ArrowDown and ArrowUp move focus between primary buttons; Enter chooses; Escape closes and returns focus to the workspace button. Action buttons are normal tab stops.

### D5. Recent includes folders opened here
Recent is the server's recently used workspaces plus the folders opened from this browser, ranked by the latest of the two times, so a folder opened moments ago appears first even before it has a chat. Metadata for paths the server did not list (pinned or opened) is requested with `include`, in batches of at most 50 paths.

## Alternatives rejected

- **A native OS folder dialog.** A browser page cannot obtain a real filesystem path from it.
- **Server-side storage for pins.** It would add a schema and an API for a purely personal preference.
- **A single combobox with `aria-activedescendant` and nested buttons.** Nested interactive controls inside options are not accessible.

## Verification map

| Decision | Evidence |
| --- | --- |
| D1 | `tests/web-workspace-state.test.ts`, `tests/dashboard-workspaces.test.ts` (config bytes unchanged) |
| D2 | `tests/dashboard-ui/workspace.spec.ts` (chats still exist after removal) |
| D3 | `tests/dashboard-ui/workspace.spec.ts` (deleted on disk, deleted after the list loaded) |
| D4 | `tests/dashboard-ui/workspace.spec.ts` (keyboard, focus return, axe) |
| D5 | `tests/web-workspace-state.test.ts`, `tests/dashboard-ui/workspace.spec.ts` |
