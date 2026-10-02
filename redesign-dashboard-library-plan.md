# Redesign the dashboard Library tab to the Agents-tab standard

## Plan schema
loop-plan/v1

## Target

Bring Library (`/library/tools|skills|hooks|vars|mcp|packages`) up to the standard set by the redesigned Agents tab (`redesign-dashboard-agents-tab-plan.md`, commits `f0bf672..928e5a8`).

That standard means:
- resource header;
- `.data-table` rows with badges;
- detail header with breadcrumb, badges, a primary action and a ⋯ menu;
- section tabs;
- sticky save bar;
- cards;
- one error surface per dialog;
- `Empty` states;
- axe-clean light/dark and narrow layouts.

User decisions (2026-10-03, AskUserQuestion):
1. Component detail (tool/skill/hook) uses a **header plus tabs**. The tabs are Overview (About, Used by with per-agent Attach/Detach, hook events) and Source (file picker, editor, save bar).
2. **Extend the API** so Vars and MCP rows show safe summaries. The Vars/MCP page gets tabs (Overview · Definitions · Check). This removes the "Edit definitions" toggle.
3. **Packages**: an "Import package" button opens a dialog with path or upload. The package table is the page's main content and temporary artifacts get their own card. Package detail has a header with badges, primary "Use agent" and a ⋯ menu (Add component, Update, Fork, Remove).
4. **One plan with several phases** covering Components, Vars/MCP and Packages.

## Scope

- `ConfigView` additions, all safe and free of values or secrets:
  - `varSummaries`
  - `providerSummaries`
  - `mcpSummaries`
- Shared `ActionMenu` (generalized from `AgentActionsMenu`). Library nav gets `aria-current`. An unknown `/library/<x>` renders a not-found `Empty` instead of Packages.
- Components list and detail: Tools, Skills, Hooks.
- Vars and MCP page.
- Packages list, detail and dialogs.
- Playwright updates and new specs, axe, narrow layout, screenshots, `docs/dashboard.md`, `docs/dashboard-api.md`, evidence.

Explicit exclusions:
- Settings page redesign.
- New component, package or check capabilities.
- Changing the backend validation, attach, check or package semantics.
- Executing tools, hooks or MCP when only viewing.
- URL-addressable tabs.
- Drag-and-drop.
- Bulk actions.
- Exposing var values, env names, provider commands, MCP URLs, commands or headers.

## Invariants

1. Every existing backend route and request/response shape stays compatible. New `ConfigView` fields are additive.
2. Viewing never executes a component, provider or MCP server. Read and Discover stay explicit, cancellable actions.
3. Summaries never contain literal var values, env var names, file paths, provider commands/args, MCP URLs/headers/commands/env, or credentials.
4. The router dirty guard still protects drafts. Tab switches never trigger it and never lose draft state.
5. These accessible names stay, or tests are migrated in the same phase:
   - Buttons: "Create hook", "Create tool", "Create from example", "Fork to local", "Create fork", "Attach", "Save", "Read", "Discover", "Add selected tools to agent", "Inspect path", "Install", "Use agent", "Create agent binding", "Export agent", "Build archive", "Download archive", "Remove package", "Remove alias", "Update package", "Update shared".
   - Labels: "Component folder", "Attach to agent", "Source file", "Variable name", "MCP server name", "Local package path", "Install alias", "Upload package archive".
   - Textboxes: "Source <file>", "Definitions JSON".
   - h1 = component id or package alias on detail pages.
   - h1 "Tools" on `/library`.
   - Statuses: "Attached", "Saved", "Selected for raw", "Installed …", "Agent … created".
   - Modal-scoped alerts (`dialog >> alert`).
6. Degrade, never block. A failed catalog, summary or check degrades to a banner or `Empty` with retry, never a blank page.
7. Docs-first and tests-first per phase. One cohesive commit per phase. APPROVE review (`codex-impl-review`, gpt-6-astra) before advancing.

## Baseline

- HEAD `928e5a8` (2026-10-03). `git status` is clean.
- Installed globally from a tarball for the user's manual test of Agents. The user reported Agents is fine.
- Already available from the Agents work (reuse, do not rebuild):
  - tokens (`--on-accent`, `--space-*`);
  - `.badge(.accent|.success|.warning|.error)`, `.card`, `.card-header`, `.card-footer`;
  - `.page-breadcrumb`, `.data-table`/`.data-row`, `.sticky-savebar`, `.segmented`, `.tabs.page-tabs`;
  - `.resource-header`, `.detail-header`/`.detail-title`/`.detail-panel`;
  - `DraftActions variant="bar"`;
  - `AgentActionsMenu`/`AgentActionDialog`;
  - `ConfigView.agentSummaries`.
- Known environmental failures: 3 PTY REPL tests in `tests/cli.test.ts`. They fail identically on `ee3a7dc` and are recorded in `docs/evidence/local-dashboard.md`.
- Planning ran no tests and changed no production code.

## Design and project patterns

| Need | Pattern to reuse |
| --- | --- |
| Summaries in `/config` | `agentSummaries()` in `src/dashboard/management.ts` (null-prototype map, `record()`) |
| Var definition fields | `src/vars/config.ts:26-70`: vars `{description, source.kind: literal\|env\|file\|provider, access: read\|use, type, cache_ttl_ms}`; providers `{command, args, cwd, timeout_ms, max_output_bytes}` |
| MCP server fields | `src/config.ts:300-320`: `transport: stdio\|streamable-http` |
| Component list data | `GET /components/{kind}` returns full `ComponentInfo` (`src/management/components.ts:18-32`): source, readOnly, validation, diagnostic, usedBy, usageAvailable, files, manifest |
| Attach/detach | `POST /components/{kind}/{id}/selection {agent, revision, selected}` returns ConfigView |
| Package data | `GET /packages` returns `PackageView[]` (`src/dashboard/packages.ts:26-77`); stages include `expiresAt` |
| Header, menu, dialog, list, tabs, save bar | `web/src/pages/agents/{AgentsList,AgentDetail,AgentActions}.tsx` |
| Empty/loading | `Empty` (`web/src/ui.tsx`), `SkeletonRegion`, `usePageGate` (`web/src/states.tsx`) |

Key decisions:
- **`ActionMenu`** (`web/src/ui/ActionMenu.tsx`) takes `{label, items: {id, label, icon, danger?, hidden?}[], disabledReason?, onSelect}`. `AgentActionsMenu` becomes a thin wrapper, keeping its accessible name "Actions for <name>".
- **Usage counts**:
  - Var `usedBy` = agents whose `vars` array contains the name.
  - MCP `usedBy` = agents with a `tools.use` ref whose string or `.ref` starts with `mcp/<server>/`.
  - Provider `usedBy` = vars whose `source.kind === "provider"` with `source.name === id`.
  - Computed from raw config like `agentSummaries`. Package-bound agents (`from`) count only top-level fields.
- **Component detail tabs** are local state. The default is Overview, or Source when the URL carries `?file=` (not used today; no such param is added). The Source tab owns the file picker and the editor. A Markdown file gets a `.segmented` Source|Preview toggle instead of `<details>`.
- **Attach UI** moves to a "Used by" card. It lists every agent with state Attached/Not attached and a per-row Attach/Detach button. The "Attach to agent" select + Attach button stays in that card's footer for tests and keyboard parity.
- **Packages**:
  - Import becomes a dialog opened by `.primary` "Import package".
  - The list header also has "Export agent" (secondary).
  - The detail h1 stays the alias.
  - An unknown alias shows `Empty` "Package not found" with a link back.
- **Errors**: each dialog owns its error state, following the `AgentActionDialog` pattern. Page-level errors appear once.

File layout (new):

```
web/src/ui/ActionMenu.tsx
web/src/pages/library/ComponentsList.tsx
web/src/pages/library/ComponentDetail.tsx
web/src/pages/library/UsedByCard.tsx
web/src/pages/library/DefinitionsPage.tsx    (replaces pages/Definitions.tsx body)
web/src/pages/library/PackagesList.tsx
web/src/pages/library/PackageDetail.tsx
web/src/pages/library/PackageDialogs.tsx
```

`web/src/pages/Components.tsx`, `Definitions.tsx` and `Packages.tsx` become routing shims that keep their exported page names.

## Global Gates

- `npm run typecheck`: exit 0.
- `npm run check`: the only failures allowed are the 3 baseline PTY REPL tests in `tests/cli.test.ts`, all other tests pass.
- `npx playwright test --project=chromium`: all pass. The final phase runs the 3-browser `npm run test:web`.
- `git diff --check`: no output.

## Plan Review

APPROVE: codex-plan-review (gpt-6-astra), 2 rounds, 2026-10-03. Round 1 found 3 issues: package-bound agents, alias detach, and the narrow-screen matrix. All were fixed in the plan with no API change.

## Phase 1: Safe var, provider and MCP summaries

### Goal
`ConfigView` carries `varSummaries`, `providerSummaries` and `mcpSummaries`.

### Current behavior and gap
`ConfigView` exposes only `vars`, `providers` and `mcp` name arrays (`src/dashboard/management.ts:13-18`). The Vars/MCP rows show a hardcoded "Not checked".

### Evidence
- `view()` and `agentSummaries()` in `management.ts`.
- Var schema in `src/vars/config.ts:26-70`.
- MCP schema in `src/config.ts:300-320`.

### Pattern
`agentSummaries()`.

### Dependencies
None.

### Files and symbols
- `src/dashboard/management.ts` (`VarSummary`, `ProviderSummary`, `McpSummary`, `view`)
- `tests/dashboard-management.test.ts`
- `docs/dashboard-api.md`

### Behavioral contract
- `varSummaries[name] = { description?: string; access?: "read"|"use"; source?: "literal"|"env"|"file"|"provider"; type?: string; provider?: string; usedBy: string[] }`.
  - `provider` is present only for provider sources and holds the provider id.
  - String fields appear only when they are strings in config.
- `providerSummaries[id] = { usedBy: string[] }` lists var names.
- `mcpSummaries[name] = { transport?: "stdio"|"streamable-http"; usedBy: string[] }` lists agent names.
- All three are null-prototype-safe. Each is `{}` for an invalid config.
- No literal value, env name, path, command, args, URL, headers or env appear in any of them.
- `usedBy` follows config order.

### Documentation
`docs/dashboard-api.md` `/config` row: describe the three fields and state the exclusions.

### Tests first
`tests/dashboard-management.test.ts`, a new test:
- Fixture config with:
  - vars: a literal with value `"SECRET_LITERAL"`, an env var with name `SECRET_ENV_NAME`, a file var, and a provider var.
  - var_providers: `cmd` with command `/opt/secret-bin`.
  - mcp servers: a stdio server with `command: "secret-cmd"` and a streamable-http server with `url: "https://secret.example/mcp"`.
  - Agents: `raw` with `vars: [literal]` and `tools.use: ["mcp/http/x"]`, and an `__proto__` agent.
- Assert the exact summaries.
- Assert `JSON.stringify(view)` contains none of the secret strings.
- A broken config returns `{}` for all three.
Use `dashboardFixture` options, or write the config file directly as the existing tests do.

### Anti-shortcut coverage
- The secret-string absence check rejects spreading definitions.
- Exact `usedBy` arrays reject name-only implementations.
- The `__proto__` agent rejects plain-object accumulators.

### Implementation obligations
Projection only, with no UI change.

### Acceptance criteria
- [x] AC-1: All three summaries are exact for every source/transport kind. Proven by the new test.
- [x] AC-2: No secret or locator strings leak. Proven by the same test.
- [x] AC-3: Invalid config yields `{}`. Proven by the same test.
- [x] AC-4: The API docs are updated. Proven by inspection.

### Focused verification
`npm run build && node --import tsx --test tests/dashboard-management.test.ts`

### Phase gates
`npm run typecheck && npm run test:phase -- dashboard && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): expose safe var, provider and MCP summaries`

## Phase 2: Shared ActionMenu, Library nav state and route fallback

### Goal
- A reusable ⋯ menu.
- The Library sidebar marks the current section.
- An unknown Library route is reported instead of rendering Packages.

### Current behavior and gap
- `AgentActionsMenu` is agent-specific (`web/src/pages/agents/AgentActions.tsx`).
- Library nav links lack `aria-current` (`App.tsx:385-393`).
- `/library/typo` renders Packages (`App.tsx:615-634`).

### Evidence
As cited above.

### Pattern
`AgentActionsMenu`; Settings/Agents `aria-current`.

### Dependencies
None.

### Files and symbols
- `web/src/ui/ActionMenu.tsx`
- `web/src/pages/agents/AgentActions.tsx`
- `web/src/App.tsx`
- `tests/dashboard-ui/library.spec.ts` (new)

### Behavioral contract
- `ActionMenu` renders a trigger `icon-button` with the given `aria-label`, disabled when `disabledReason` is set. Items appear in order; a separator goes before the first danger item; hidden items are omitted.
- `AgentActionsMenu` keeps the same DOM names and behavior. All existing `agents.spec.ts` tests pass unchanged.
- Library nav sets `aria-current="page"` on the section link, which stays current on detail routes such as `/library/tools/<id>`. `/library` marks Tools.
- `/library/<unknown>` renders `Empty` "Library section not found" with a link to `/library/tools`.

### Documentation
None (internal). Covered in Phase 7.

### Tests first
`library.spec.ts`:
- Nav current state on `/library`, `/library/hooks` and `/library/tools/builtin%2Fread_file`.
- `/library/typo` shows the not-found heading and no "Import package"/"Packages" heading.

### Anti-shortcut coverage
The detail-route assertion rejects exact-path matching.

### Implementation obligations
Component plus routing; no page redesign.

### Acceptance criteria
- [x] AC-1: `ActionMenu` is used by `AgentActionsMenu`, and `agents.spec.ts` stays green. Proven by the phase gate.
- [x] AC-2: The Library nav current state is correct on list and detail routes. Proven by `library.spec.ts`.
- [x] AC-3: Unknown section shows not-found. Proven by `library.spec.ts`.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/library.spec.ts tests/dashboard-ui/agents.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`refactor(dashboard): shared action menu and library navigation state`

## Phase 3: Components list (Tools, Skills, Hooks)

### Goal
A standard catalog page for each component kind.

### Current behavior and gap
`Components.tsx:46-181` has:
- a scope eyebrow;
- a plain Create button;
- `role=table` div rows with string-built validation;
- "No results" conflated with empty;
- a create modal sharing page error state.

### Evidence
As cited above.

### Pattern
`AgentsList.tsx`, `.data-table`, `Empty`.

### Dependencies
Phase 2.

### Files and symbols
- `web/src/pages/library/ComponentsList.tsx`
- `web/src/pages/Components.tsx` (shim)
- `web/src/styles.css`
- `tests/dashboard-ui/library.spec.ts`
- `tests/dashboard-ui/management.spec.ts` (only if selectors change)

### Behavioral contract
- `.resource-header`:
  - h1 "Tools"/"Skills"/"Hooks", from a static map.
  - A one-line description.
  - `.primary` "Create tool|skill|hook".
- Search field "Search {kind}" filters by id, name and description.
- `ul.data-table[aria-label="{Kind} catalog"]` rows contain:
  - id `Link` with the description below, clamped to 2 lines by CSS rather than sliced;
  - source badge (Builtin/Local/Package/Linked/Agent);
  - "Read-only" badge;
  - "Invalid" `.badge.error` with the diagnostic as `title`;
  - "Used by N", or "Not selected" / "Usage unavailable".
- Empty states:
  - No items: `Empty` with the Create action.
  - Filter has no results: inline "No {kind} match “q”." plus "Clear search".
- The create dialog owns its error state and keeps labels "Component folder", "Example" and buttons "Create hook"/"Create from example". Hook template code is unchanged.

### Documentation
Phase 7.

### Tests first
`library.spec.ts`:
- Tools rows show the Builtin and Read-only badges and the "Used by" count for `builtin/read_file` in a fixture whose agent selects it.
- Search narrows the list, a no-match search shows "Clear search", and clearing restores it.
- Hooks with zero items show `Empty` with "Create hook".
- A failed create (route 409) shows exactly one DOM `[role=alert]`, inside the dialog.
Existing `management.spec.ts` create-hook/tool flows stay green.

### Anti-shortcut coverage
- Separate empty and no-results assertions.
- DOM alert count.
- The usage count comes from the fixture config.

### Implementation obligations
List and create dialog only; detail in Phase 4.

### Acceptance criteria
- [x] AC-1: Rows show badges and usage from `ComponentInfo`. Proven by `library.spec.ts`.
- [x] AC-2: The empty state and the no-results state are distinct. Proven by `library.spec.ts`.
- [x] AC-3: Single error surface on create. Proven by `library.spec.ts`.
- [x] AC-4: The existing create flows pass. Proven by `management.spec.ts`.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/library.spec.ts tests/dashboard-ui/management.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): standard catalog list for tools, skills and hooks`

## Phase 4: Component detail — header, Overview/Source tabs, Used by

### Goal
Component detail matches the Agents detail pattern.

### Current behavior and gap
`Components.tsx:185-486` has:
- the same header as the list, with Create visible;
- a string-built provenance line;
- an unstyled hook `dl.details-grid`;
- three flat action rows;
- an Attach select with no per-agent state;
- an inline `DraftActions`;
- a `<details>` Markdown preview;
- duplicated errors.

### Evidence
As cited above.

### Pattern
`AgentDetail.tsx`, `ActionMenu`, `DraftActions variant="bar"`, `.segmented`.

### Dependencies
Phase 3.

### Files and symbols
- `web/src/pages/library/ComponentDetail.tsx`
- `web/src/pages/library/UsedByCard.tsx`
- `web/src/pages/Components.tsx`
- `web/src/styles.css`
- tests

### Behavioral contract
- **Header**:
  - Breadcrumb `Library / {Kind} / id`.
  - h1 = id.
  - Badges: source, Read-only, Invalid.
  - Primary action: "Fork to local" when read-only; none otherwise.
  - ⋯ `ActionMenu` "Actions for {id}": Fork to local (when editable too), Add text file (editable only), Delete component (danger, hidden when read-only or linked).
  - Actions are disabled while the draft is dirty, with reason "Save or discard changes first".
- **Tabs** "Component sections": Overview, Source. Local state, `forceMount` + `hidden`.
- **Overview**:
  - Card "About": description, validation ("Valid structure · not run" or the diagnostic as `.error-banner`), files count.
  - Hooks only: card "Events": a table of event name and match, with command, args and timeout in a definition grid styled via `.details-grid` CSS.
  - `UsedByCard` lists every config agent:
    - name;
    - `.badge.success` "Attached" when in `usedBy`, otherwise "Not attached";
    - per-row "Attach"/"Detach" button with accessible names "Attach to {agent}"/"Detach from {agent}".
  - **Package-bound agents** (`agentSummaries[name].from`): the selection API rejects them (`src/management/components.ts:250`). Their row therefore shows a "Package binding" badge, has no Attach/Detach button, and links "Edit in agent" to `/agents/{name}` (whose JSON tab owns the complete override). They are also excluded from the footer "Attach to agent" select.
  - **Detach through an alias**: `usedBy` also counts references that resolve to the same physical folder (for example `agent/shared` for `local/shared`, `components.ts:140-143`), but Detach removes only exact-id refs (`:255-257`). No API change is made. After a Detach, the card re-reads the component. If the agent is still in `usedBy`, the card shows a warning: "{agent} still uses this component through another reference. Remove it in the agent's Capabilities tab.", with a link to `/agents/{agent}`. It does not show "Detached".
  - The card footer keeps the "Attach to agent" select + "Attach" button.
  - Status "Attached"/"Detached" is shown in the card.
  - `usageAvailable=false` shows a notice and no per-row state.
- **Source**:
  - "Source file" select, disabled while dirty, with a hint.
  - Read-only notice with a "Fork to local" button.
  - `SourceEditor` "Source {file}".
  - `.md` files: `.segmented` "Source | Preview" radiogroup instead of `<details>`.
  - `DraftActions variant="bar"`.
- **Dialogs**: Fork, Delete and Add file each own their error state. Delete confirm is `.danger` "Delete component".
- **Loading and errors**: skeleton "Loading details" stays. A failed detail load shows one error with no save bar.

### Documentation
Phase 7.

### Tests first
`library.spec.ts`:
- Header for `builtin/read_file`: breadcrumb back to Tools, Builtin and Read-only badges, "Fork to local" primary.
- The menu has no Delete for a builtin.
- UsedBy:
  - Detach `raw` from `builtin/read_file`; the config file loses it and the badge flips.
  - Attach back.
- A package-bound agent row (fixture agent with `from`) has the "Package binding" badge, no "Attach to {agent}"/"Detach from {agent}" button, and does not appear in the "Attach to agent" select.
- Alias scenario (mirrors `tests/management-components.test.ts:91-101`):
  - Fixture: an agent selects `agent/shared`; open `local/shared`.
  - Detach from that agent shows the "still uses this component through another reference" warning.
  - The row stays "Attached" and the config is unchanged.
- Hook detail renders the Events table, with no raw JSON braces in the events cell.
- Source tab:
  - Editing a local tool file shows the save bar.
  - Switching tabs keeps the draft with no guard dialog.
  - Save persists.
- A skill `.md` file: Preview radio renders Markdown, and no `details` element exists in either panel.
- Delete is `.danger` and returns to the list.
Migrate `management.spec.ts`:
- hooks/skills flows that use "Attach to agent" keep working through the footer select;
- Source file and textbox interactions click the "Source" tab first.

### Anti-shortcut coverage
- Config-file assertions for attach/detach.
- No-details assertion.
- Tab round-trip with draft retention.
- Builtin menu without Delete.

### Implementation obligations
Detail plus dialogs; list untouched except shared CSS.

### Acceptance criteria
- [ ] AC-1: Header, badges and menu follow the contract. Proven by `library.spec.ts`.
- [ ] AC-2: Per-agent Attach/Detach persists and reflects state. Package-bound agents get no controls. An alias-attached agent gets the warning instead of a false "Detached". Proven by `library.spec.ts`.
- [ ] AC-3: The Source tab has the save bar, keeps the draft across tabs, and has the Markdown preview toggle. Proven by `library.spec.ts`.
- [ ] AC-4: Hook events are readable with no raw JSON. Proven by `library.spec.ts`.
- [ ] AC-5: The existing management flows pass after migration. Proven by `management.spec.ts`.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/library.spec.ts tests/dashboard-ui/management.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): component detail header, overview and source tabs`

## Phase 5: Vars and MCP — Overview, Definitions, Check tabs

### Goal
The Vars/MCP page uses tabs, rich rows from the Phase 1 summaries, and a clear check workflow.

### Current behavior and gap
`Definitions.tsx` has:
- name-only rows with a hardcoded "Not checked";
- an irreversible "Edit definitions" toggle;
- a `<details>` schema example;
- two `role=status` regions;
- "Select for check" that does not move focus;
- providers never shown.

### Evidence
`Definitions.tsx:39-311`.

### Pattern
`AgentDetail` tabs, `.data-table`, `.card`, `DraftActions variant="bar"`.

### Dependencies
Phases 1 and 2.

### Files and symbols
- `web/src/pages/library/DefinitionsPage.tsx`
- `web/src/pages/Definitions.tsx` (shim)
- `web/src/styles.css`
- tests

### Behavioral contract
- **Header**: h1 "Vars & providers" / "MCP servers", plus a description.
- **Tabs** "Definition sections": Overview, Definitions, Check.
- **Overview**:
  - Vars: `ul.data-table[aria-label="Variables"]` rows with name, description, source badge, access badge ("read"/"use only"), type, "Used by N" (agent names as `title`), and row action "Check" (vars with access `use` still allow Check, as today).
  - Providers card: rows of id and "Used by N vars".
  - MCP: `ul.data-table[aria-label="MCP servers"]` rows with name, transport badge, "Used by N", and "Discover".
  - Empty: `Empty` with an "Edit definitions" action that switches to the Definitions tab.
- **Definitions**:
  - `SourceEditor` "Definitions JSON" and `DraftActions variant="bar"`.
  - A schema example card, visible, no `<details>`.
- **Check**:
  - Card "Read a variable"/"Discover tools" with "Check agent", "Variable name"/"MCP server name", "Read"/"Discover" and "Cancel check".
  - Result card with one `role=status` line ("Check {state}" plus a time badge) and a single error banner.
  - Var value in `pre.source-preview`.
  - MCP tool checkboxes, then "Add selected tools to agent".
- **Row actions**: "Check"/"Discover" on a row switches to the Check tab, prefills the name, and focuses the Read/Discover button. It never starts the check by itself (invariant 2).
- **Migration**: the "Edit definitions" button name is kept as the Definitions tab trigger action inside the Overview empty state and page header ("Edit definitions" button switches tab), so `management.spec.ts` keeps working.

### Documentation
Phase 7.

### Tests first
`library.spec.ts`:
- Vars rows show source and access badges and Used by from the Phase 1 summaries.
- A row "Check" switches to Check with the name prefilled, focuses Read, and sends no `/checks` request (asserted via `page.on("request")`).
- MCP rows show the transport badge.
- Exactly one `role=status` on the Check tab after a Read.
- No `details` element on the page.
- Definitions edit → the save bar appears → Save persists.
Existing `management.spec.ts` vars/MCP flows stay green, with a minimal tab-click migration.

### Anti-shortcut coverage
- The no-request assertion protects invariant 2.
- The status count.
- Summary-derived badges cannot be hardcoded with varied fixtures.

### Implementation obligations
Page restructure only. Check polling and APIs are unchanged.

### Acceptance criteria
- [ ] AC-1: Rows render the summaries for vars, providers and MCP. Proven by `library.spec.ts`.
- [ ] AC-2: Row Check/Discover prefills and focuses without running. Proven by `library.spec.ts`.
- [ ] AC-3: One status and one error surface on the Check tab. Proven by `library.spec.ts`.
- [ ] AC-4: The Definitions save bar works, with no disclosures. Proven by `library.spec.ts`.
- [ ] AC-5: The existing flows pass. Proven by `management.spec.ts`.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/library.spec.ts tests/dashboard-ui/management.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): tabbed vars and MCP pages with summaries`

## Phase 6: Packages — list, import dialog, detail, dialogs

### Goal
Packages follows the standard list/detail pattern.

### Current behavior and gap
`Packages.tsx` has:
- the import form inline above the list;
- string-built rows;
- five flat detail buttons;
- Remove not marked destructive;
- a blank page for an unknown alias;
- `<details>` for files and schema;
- a shared error across modals;
- a floating "Chat with" button.

### Evidence
`Packages.tsx:109-836`.

### Pattern
`AgentsList`, `AgentDetail`, `ActionMenu`, `.card`.

### Dependencies
Phase 2.

### Files and symbols
- `web/src/pages/library/{PackagesList,PackageDetail,PackageDialogs}.tsx`
- `web/src/pages/Packages.tsx` (shim)
- `web/src/styles.css`
- `tests/dashboard-ui/packages.spec.ts`
- `tests/dashboard-ui/library.spec.ts`

### Behavioral contract
- **List**:
  - `.resource-header` with h1 "Packages", `.primary` "Import package" and secondary "Export agent".
  - Search "Search packages".
  - `ul.data-table[aria-label="Installed packages"]` rows contain:
    - alias `Link`;
    - package name;
    - version badge;
    - "Linked"/"Artifact" badge;
    - "Needs attention" `.badge.warning`;
    - "Used by N".
  - Empty: `Empty` with "Import package". No-results: an inline message with "Clear search".
  - "Temporary artifacts" card, shown only when stages exist. Rows show name, version, expiry time ("Expires 12:30") and "Review"/"Discard artifact".
- **Import dialog** "Import package" contains "Local package path" + "Inspect path", or "Upload package archive". It opens the existing Review dialog flow.
- **Detail**:
  - Breadcrumb `Library / Packages / alias`; h1 alias.
  - Badges: version, Linked/Artifact, Needs attention.
  - Primary "Use agent".
  - ⋯ `ActionMenu` "Actions for {alias}": Add component, Update package, Fork package, Remove package (danger).
  - Cards:
    - "Overview": name, version, digest or path in `code`, Used by.
    - "Exports": the existing `PackageReportView` content restyled; "Packaged files" is a visible list, capped with "Show all N".
    - "Requirements": capabilities and external executables.
  - The update flow opens the Import dialog in replacement mode ("Replacement for {alias}", "Cancel update").
  - An unknown alias shows `Empty` "Package not found" with a link to Packages.
- **Dialogs** (Review, Export, Use agent/Add component, Fork, Remove):
  - Each owns its error state.
  - The Review dialog's "Recipient input schema" is a visible `pre` card section, no `<details>`.
  - The Remove confirm is `.danger` "Remove alias".
  - The "Chat with {agent}" button appears in the success status of Use agent / Install instead of floating.
  - All existing accessible names are kept.

### Documentation
Phase 7.

### Tests first
`library.spec.ts`:
- Package rows show badges.
- An unknown alias shows not-found.
- The temporary artifact row shows its expiry.
- No `details` element on the detail page or the Review dialog.
- A Remove failure shows exactly one DOM alert, inside the dialog.
Migrate `packages.spec.ts`:
- "Local package path" is reached via the "Import package" dialog;
- "Update package" / "Remove package" are reached via the ⋯ menu "Actions for shared";
- keep "Chat with writer".

### Anti-shortcut coverage
- DOM alert count.
- Not-found check.
- Expiry text derived from `expiresAt`, not a constant.

### Implementation obligations
UI restructure only; package APIs are unchanged.

### Acceptance criteria
- [ ] AC-1: The list, rows, empty/no-results and artifacts card follow the contract. Proven by `library.spec.ts`.
- [ ] AC-2: The Import dialog and replacement mode work. Proven by `packages.spec.ts`.
- [ ] AC-3: Detail header, menu and cards follow the contract, and an unknown alias shows not-found. Proven by `library.spec.ts`.
- [ ] AC-4: Dialog-scoped errors, a danger Remove, and no disclosures. Proven by `library.spec.ts` and `packages.spec.ts`.
- [ ] AC-5: `packages.spec.ts` passes after migration. Proven by the phase gate.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/library.spec.ts tests/dashboard-ui/packages.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): packages list, import dialog and detail layout`

## Phase 7: Responsive, axe, screenshots, docs and qualification

### Goal
Library is verified on every browser and narrow screens, with docs and screenshots updated.

### Current behavior and gap
No axe or narrow coverage for Library. Docs describe the old layout.

### Evidence
- `tests/dashboard-ui/accessibility.spec.ts`.
- `capture-management.ts:57-71`.
- `docs/dashboard.md:119-182`.

### Pattern
Agents Phase 6.

### Dependencies
Phases 1–6.

### Files and symbols
- `web/src/styles.css`
- `tests/dashboard-ui/accessibility.spec.ts`
- `tests/dashboard-ui/library.spec.ts`
- `tests/dashboard-ui/capture-management.ts`
- `docs/dashboard.md`
- `docs/dashboard-api.md` (fix the "`tools` or `skills`" wording to include hooks)
- `docs/dashboard/*.png`
- `docs/evidence/local-dashboard.md`

### Behavioral contract
- ≤899px: rows stack name over badges with actions on the right; usage hidden; tabs scroll.
- 390px: no horizontal overflow, and primary and ⋯ actions stay in the viewport, on each surface in this matrix:
  - Tools, Skills and Hooks lists.
  - Populated tool detail: Overview, and Source with a dirty save bar visible.
  - Populated skill detail: Source tab with Preview selected.
  - Populated hook detail: Overview with the Events table.
  - Vars: Overview, Definitions and Check tabs.
  - MCP: Overview, Definitions and Check tabs.
  - Packages list and package detail.
- Axe (WCAG 2.2 AA, waiting for animations as in the Agents test) passes in light and dark on each Library list, a component detail (both tabs), Vars (all tabs), MCP, and Packages list and detail.
- Screenshots:
  - `library-tools-{light,dark}-desktop.png`
  - `tool-dark-desktop.png` (component detail)
  - `vars-dark-desktop.png`
  - `packages-dark-desktop.png`
  - `package-dark-desktop.png` (review dialog, kept)

### Documentation
- Rewrite the Library and "Share portable packages" paragraphs in `docs/dashboard.md`.
- Fix the hooks wording in `docs/dashboard-api.md`.
- Add an evidence section with gates and review verdicts.

### Tests first
- `library.spec.ts` narrow describe (390×844). It iterates the full matrix above, one overflow and in-viewport assertion per surface, after switching to the named tab or state.
- `accessibility.spec.ts` Library axe test.

### Anti-shortcut coverage
- Overflow measurement plus in-viewport action checks.
- Axe runs on every tab, not only the first.

### Implementation obligations
CSS breakpoints, capture script, docs, evidence.

### Acceptance criteria
- [ ] AC-1: No overflow at 390px and actions visible on all Library pages. Proven by `library.spec.ts`.
- [ ] AC-2: Axe passes light/dark on all Library pages and tabs, on 3 browsers. Proven by `accessibility.spec.ts`.
- [ ] AC-3: Screenshots regenerated and docs updated. Proven by inspection.
- [ ] AC-4: `npm run test:web` passes 3 browsers; `npm run check` passes except the baseline PTY tests; recorded in evidence. Proven by the evidence doc.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/library.spec.ts tests/dashboard-ui/accessibility.spec.ts --project=chromium && node --import tsx tests/dashboard-ui/capture-management.ts`

### Phase gates
`npm run check; npm run test:web && git diff --check`
`npm run check` is expected to report only the 3 baseline PTY failures.

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`docs(dashboard): qualify redesigned library with screenshots and evidence`

## Completion Criteria

- Every phase AC is checked, and each phase is committed with an APPROVE review.
- Final gates:
  - `npm run typecheck` passes.
  - `npm run test:web` passes on 3 browsers.
  - `npm run check` passes except the 3 baseline PTY REPL tests.
  - `git diff --check` is clean.
- Library pages visually match the Agents standard in light and dark, verified by regenerated screenshots.
- No backend semantic changes beyond the additive summaries. No viewing-time execution.

## Progress Log

- 2026-10-03: Plan drafted. User decisions are recorded in Target.
- 2026-10-03: Plan review APPROVE (2 rounds). All phases are pending.
- 2026-10-03: Phase 1 complete. Codex impl review APPROVE (1 round). Gates: typecheck pass, test:phase dashboard 62/62 pass, diff --check clean.
- 2026-10-03: Phase 2 complete. Codex impl review APPROVE (2 rounds: direct-load not-found fixed by serving the entry for any `/library/<segment>`). Also fixed the server page allowlist, which omitted `hooks`, so reloading `/library/hooks` returned a 404. Gates: typecheck pass, chromium 194+ passed, diff --check clean.
- 2026-10-03: Phase 3 complete. Codex impl review APPROVE (2 rounds: a cached-list refresh error is now surfaced once, with a test). Gates: typecheck pass, chromium all passed, diff --check clean.
