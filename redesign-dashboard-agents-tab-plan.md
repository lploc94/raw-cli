# Redesign the dashboard Agents tab to industry-standard layout and style

## Plan schema
loop-plan/v1

## Target

Bring the dashboard Agents tab (`/agents`, `/agents/:name`) up to the same standard as the recently normalized chat surface (slim header, ⋯ menu via radix DropdownMenu, skeleton/empty states, lucide icons). Industry references: Claude Console / OpenAI agent builder (header + section tabs + sticky save bar), Linear/Vercel resource lists.

User decisions (2026-10-02, AskUserQuestion):
1. Detail layout: **header + tabs** (Overview · Capabilities · Policy · JSON) with a sticky Save/Discard bar.
2. **Extend the API**: `/config` returns per-agent summaries so the list can show model and counts.
3. Scope: **Agents tab + fix shared tokens** (`.primary`/`.danger` hardcoded colors, duplicate `.actions`, sidebar active state). Other management pages benefit passively but are not redesigned.

## Scope

- `ConfigView.agentSummaries` (additive) computed server-side from config data.
- Shared CSS tokens/primitives: `--on-accent`, `--accent-hover`, `--on-error`, `--error-hover`, a minimal `--space-*` scale, `.badge`, `.card`, `.card-header`, `.page-breadcrumb`, `.data-table`, `.sticky-savebar`, `.segmented`; `.primary`/`.danger` move to tokens; deduplicate `.actions`.
- Agents sidebar nav: `aria-current="page"` + empty state.
- Agents list page rewrite (rows with model/counts/badges, New chat + ⋯ menu, `Empty` state).
- Agents detail rewrite: breadcrumb header, ⋯ action menu, radix Tabs, sticky save bar, skeleton loading, single-surface errors, typed action modal.
- Restyled content: Instructions card with Text|File segmented control, Capabilities cards with compact reorder rows, Policy grid rows with Move down and effect badge, JSON tab.
- Split `web/src/pages/Agents.tsx` (649 lines) into `web/src/pages/agents/*`.
- Playwright updates/additions, screenshots, `docs/dashboard.md`, `docs/dashboard-api.md`, evidence.

Explicit exclusions: redesigning Settings/Library/Packages/Definitions pages; URL-addressable tabs; drag-and-drop reordering; new agent fields or schema changes; reading prompt files for list previews; agent run history/usage stats; dark/light palette retuning beyond the new tokens; a Vite dev server.

## Invariants

1. Agent config semantics are unchanged: same `POST /agents` actions, same JSON produced by the form (including auto-adding `builtin/list_skills`/`builtin/load_skill` when skills are selected, `Agents.tsx:198-214`), same revision/conflict handling via `useDraft`/`DraftActions`.
2. `ConfigView.agents: string[]` and all existing fields keep their shape; `agentSummaries` is additive and never leaks secrets or prompt text.
3. Router dirty guard (`web/src/router.tsx:28,56,68`) still protects unsaved drafts; switching tabs never triggers it and never loses draft state.
4. Settings/Definitions/Packages editors render `DraftActions` exactly as before (default inline variant).
5. Existing accessible names used by tests and users remain: "Create agent", "Agent name", "Create", "System prompt", "Selected tools|skills|hooks|vars", "Move X up/down", "Remove X", "Save", "Discard", "New chat", "Loading agents", "Keep editing"/"Discard and leave".
6. Degrade, never block: missing catalog or malformed JSON degrades to a banner / JSON tab, never a blank page.
7. Docs-first and tests-first per phase, one cohesive commit per phase, APPROVE implementation review before advancing.

## Baseline

- Workspace `/Users/lploc94/projects/raw-cli`, HEAD `ee3a7dc` (2026-10-02), `git status` clean.
- Chat normalization commits already landed (`6c57c82` slim header + More menu, `482ec36` agent menu, `d55ea96`, `9d39086`, `bf0ea1c` SWR + skeletons, `c9e958c`). Not repeated.
- No `AGENTS.md`; global `~/.claude/CLAUDE.md` only covers MCP usage. Memory: reviews via `codex-impl-review`; "degrade, never block".
- No tests/build were run during planning; this plan changes no production code.
- Current screenshot: `docs/dashboard/agent-light-desktop.png` (two loose button rows, 4-line prompt, one long column).

## Design and project patterns

| Need | Existing pattern to reuse |
| --- | --- |
| Header + ⋯ menu | `web/src/chat.tsx:362-440` `.page-header`, `DropdownMenu` with `.workspace-menu`, `.workspace-menu-item`, `.workspace-menu-separator`, `.danger-item` (`styles.css:715-760`, `:2413-2437`) |
| Tabs | radix `Tabs` + `.tabs` (`web/src/timeline.tsx:147-160`, `styles.css:1116-1133`) |
| Badges | `.agent-chip` (`styles.css:741`) → generalized `.badge` |
| Empty/loading | `Empty` (`web/src/ui.tsx:122`), `SkeletonRegion`/`PageSkeleton`/`usePageGate` (`web/src/states.tsx:35,85,167`) |
| Modals/fields | `Modal`, `Field`, `ErrorMessage` (`web/src/ui.tsx`) |
| Draft editing | `useDraft`, `DraftActions`, `SourceEditor` (`web/src/editors/shared.tsx:187`) |
| Sidebar active | Settings nav `aria-current` (`web/src/App.tsx:367`) + `.context-nav a[aria-current="page"]` (`styles.css:586`) |
| Config projection | `view()` in `src/dashboard/management.ts:38` using `record()` (`src/management/agents.ts:10`) |
| Icons | `lucide-react` (`Plus`, `MoreHorizontal`, `ArrowUp`, `ArrowDown`, `X`, `Star`, `Copy`, `Pencil`, `Trash2`, `MessageSquarePlus`) |

Key design decisions:
- Tab state is local React state (not URL) because any `navigate()` while dirty opens the leave guard. Default tab: `JSON` when `value.from` or `parseError`, else `Overview`. `Tabs.Content` uses `forceMount` + `hidden` when inactive so CodeMirror and inputs keep state.
- `DraftActions` gets `variant?: "inline" | "bar"`; `bar` renders `.sticky-savebar` only when `dirty || busy || conflict || status || error`. Default `inline` keeps other pages unchanged.
- Action menu + modal extracted to `AgentActions` used by both list rows and detail header; it owns its own `error` state (fixes double error display at `Agents.tsx:54/103` and `:236/376`).
- Client name validation mirrors backend `validName` (`src/management/agents.ts:13`: nonempty after trim) plus "different from current name" for rename and "not already in `config.agents`".
- Dark mode: `--accent` is light (`#b0a6ff`) so `.primary` text uses `--on-accent` (dark) — oracle checks computed contrast, not just class names.

File layout after Phase 3/4:
```
web/src/pages/Agents.tsx            AgentsPage router shim (list vs detail)
web/src/pages/agents/AgentsList.tsx
web/src/pages/agents/AgentDetail.tsx
web/src/pages/agents/AgentActions.tsx
web/src/pages/agents/Selection.tsx
web/src/pages/agents/PolicyEditor.tsx
```

## Global Gates

- `npm run typecheck` — exit 0.
- `npm run check` — typecheck + build + full Node suite, exit 0.
- `npx playwright test --project=chromium` — all pass (full 3-browser `npm run test:web` in the final phase).
- `git diff --check` — no output.

## Plan Review

APPROVE — `codex-plan-review` (gpt-6-astra), 2 rounds, 2026-10-02. Round 1 REVISE with 4 issues, all accepted and fixed: unreachable malformed fixtures replaced by invalid-config/package-install/typed-JSON tests; `.actions` consolidation keeps existing computed spacing; Variables test migration added; Duplicate/Set default/lifecycle-failure tests added. Round 2 APPROVE. Self-review: intent fidelity checked against the three user decisions; no scope expansion.

## Phase 1: Agent summaries in ConfigView

### Goal
`GET /config` (and every `ConfigView` response) includes `agentSummaries` for each agent.

### Current behavior and gap
`ConfigView.agents` is `string[]` only (`src/dashboard/management.ts:13-17,38-42`); the list cannot show model or counts.

### Evidence
`view()` builds the projection from `config.data`; `record()` safely coerces non-objects; web consumes the type via `import type { ConfigView }` (`web/src/data/queries.ts:4`).

### Pattern
Same inline projection style as `models`/`vars` keys in `view()`.

### Dependencies
None.

### Files and symbols
`src/dashboard/management.ts` (`ConfigView`, new `AgentSummary`, `view`), `tests/dashboard-management.test.ts`, `docs/dashboard-api.md`.

### Behavioral contract
`agentSummaries: Record<string, AgentSummary>` where `AgentSummary = { model?: string; from?: string; tools: number; skills: number; hooks: number; rules: number }`.
- `model`/`from` present only when the agent's value is a string.
- Counts are `Array.isArray(x.use) ? x.use.length : 0` for top-level tools/skills/hooks; `rules` from `tools.rules`. Package-bound agents (selections live under `overrides` and inherit the package) report top-level counts (usually 0); the UI shows the `from` reference instead of counts for them (Phase 3).
- Object built with `Object.create(null)`-safe assignment so names like `__proto__` work (existing test creates `__proto__`).
- No `system_prompt`, vars values, or credentials included.
- Invalid config (`config.data` undefined, `valid: false`) → `{}`.

### Documentation
Add `agentSummaries` to the `/config` response description in `docs/dashboard-api.md`.

### Tests first
Extend `tests/dashboard-management.test.ts`:
- Fixture agent `raw`: summary `model === "fixture"`, numeric counts matching config.
- Create `__proto__` agent → `agentSummaries["__proto__"]` present with own-property check, `tools === 0`.
- Write broken config bytes (existing pattern in the first test, `writeFileSync(f.configPath, "{broken")`) → `/config` has `valid: false` and `agentSummaries` deep-equals `{}`.
- `JSON.stringify(view)` does not contain the prompt text.
Extend `tests/dashboard-packages.test.ts` (reuse the install + `POST /packages/kit/agent` setup at `:161-170`): package-bound agent `writer` → `agentSummaries.writer.from` starts with `pkg/kit/`, `model === "fixture"`.

### Anti-shortcut coverage
`__proto__` own-property assertion rejects a plain `{}` accumulator; prompt-absence assertion rejects spreading the whole agent object.

### Implementation obligations
Type + projection only; no UI change.

### Acceptance criteria
- [x] AC-1: `/config` returns correct `agentSummaries` for normal, `__proto__` and package-bound agents, and `{}` for an invalid config — proven by `tests/dashboard-management.test.ts` and `tests/dashboard-packages.test.ts`.
- [x] AC-2: No prompt text or credentials in `agentSummaries` — proven by the same test.
- [x] AC-3: `docs/dashboard-api.md` documents the field — inspection.

### Focused verification
`npm run build && node --import tsx --test tests/dashboard-management.test.ts tests/dashboard-packages.test.ts`

### Phase gates
`npm run typecheck && npm run test:phase -- dashboard && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): expose agent summaries in config view`

## Phase 2: Shared tokens, primitives and sidebar active state

### Goal
Token-driven buttons that are correct in dark mode, reusable primitives for the Agents redesign, and a highlighted current agent in the sidebar.

### Current behavior and gap
`.primary`/`.danger` hardcode `#5144d8`/`#b12d42`/`white` (`styles.css:209-226`); `.actions` defined twice (`:245`, `:1759`); Agents sidebar links lack `aria-current` (`App.tsx:386-394`) and show nothing when empty.

### Evidence
Settings nav already sets `aria-current` and `.context-nav a[aria-current="page"]` is styled (`styles.css:586`).

### Pattern
Token block at `styles.css:11-45`; `.agent-chip` pill style; `.workspace-menu` component classes.

### Dependencies
None (independent of Phase 1).

### Files and symbols
`web/src/styles.css`, `web/src/App.tsx` (Agents `nav.context-nav`), new `tests/dashboard-ui/agents.spec.ts`.

### Behavioral contract
- New tokens in light and dark blocks: `--on-accent`, `--accent-hover`, `--on-error`, `--error-hover`, `--space-1..6` (4/8/12/16/24/32px).
- `.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent) }`, hover `--accent-hover`; `.danger` likewise with error tokens.
- One `.actions` rule that keeps the effective computed styles of today (`:245` + `:1759` merged: flex, center, wrap, gap 8px, `margin: 12px 0`; existing contextual overrides such as `.approval .actions`, `.dialog .actions`, `.page-header .actions` at `:1590`, `.selection-list li .actions` stay), so Settings (`Settings.tsx:721`), `DraftActions` conflict row (`editors/shared.tsx:216`) and every other consumer render unchanged. Places that need no margin (e.g. `.page-header .actions`, the new Agents header/rows) override locally.
- New primitives (unused by other pages yet): `.badge` (+ `.badge.accent`, `.badge.success`, `.badge.warning`, `.badge.error`), `.card`, `.card-header`, `.page-breadcrumb`, `.data-table`/`.data-row`, `.sticky-savebar`, `.segmented`. `.tabs` unchanged except a `.tabs.page-tabs` variant (larger, 14px, 40px min-height).
- Agents sidebar: `aria-current="page"` on the link whose decoded segment equals the current agent; when `agents` is empty show a muted "No agents yet" line.

### Documentation
None user-facing (internal CSS); noted in Phase 6 evidence.

### Tests first
`tests/dashboard-ui/agents.spec.ts`:
- Navigate to `/agents/raw`; sidebar link `raw` within `navigation[name=Agents]` has `aria-current="page"`.
- Dark theme (`document.documentElement.dataset.theme = "dark"`): "Create agent" (now `.primary` after Phase 3 — for this phase test the modal's "Create" button) computed `color` ≠ `rgb(255, 255, 255)` and background equals computed `--accent`.
- Light theme: same button background equals computed `--accent`.

### Anti-shortcut coverage
Comparing computed background to the resolved `--accent` in both themes rejects keeping hex values; dark text color assertion rejects white-on-light-violet.

### Implementation obligations
CSS + one App.tsx attribute/empty line. No Agents.tsx restructuring.

### Acceptance criteria
- [ ] AC-1: `.primary`/`.danger` contain no hex colors — `grep -nE '^\.(primary|danger)' -A4 web/src/styles.css` shows only `var(--…)`.
- [ ] AC-2: Exactly one top-level `.actions` declaration block, and computed `margin`/`gap`/`flex-wrap` of `.actions` in the chat header, a Settings model page and the `DraftActions` conflict row are unchanged — the implementer measures these at baseline (before editing CSS) and hard-codes the measured values as assertions in `agents.spec.ts`, which must pass after the change — inspection + `agents.spec.ts`.
- [ ] AC-3: Current agent highlighted via `aria-current` — `agents.spec.ts`.
- [ ] AC-4: Primary button colors resolve from tokens in light and dark — `agents.spec.ts`.
- [ ] AC-5: Existing management/settings/packages specs still pass — phase gate.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/agents.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`style(dashboard): token-driven buttons, shared primitives and active agent nav`

## Phase 3: Agents list page and shared action menu

### Goal
`/agents` becomes a standard resource list with summaries, badges, New chat and a ⋯ action menu.

### Current behavior and gap
`Agents.tsx:40-96`: "Raw config" eyebrow, plain `resource-row` with name + empty "Default" span + New chat; unstyled empty `<p>`; no rename/duplicate/delete from the list; duplicated error display between page and modal.

### Evidence
`config.agentSummaries` from Phase 1; menu pattern `chat.tsx:382-440`.

### Pattern
`.page-header`-like heading, `.data-table`, `DropdownMenu` + `.workspace-menu`, `Empty`.

### Dependencies
Phase 1 (summaries), Phase 2 (primitives).

### Files and symbols
New `web/src/pages/agents/AgentsList.tsx`, `web/src/pages/agents/AgentActions.tsx` (`AgentActionsMenu`, `AgentActionDialog`); `web/src/pages/Agents.tsx` becomes the routing shim keeping `AgentsPage` export and `usePageGate` ("Loading agents"); `web/src/styles.css`.

### Behavioral contract
- Header: h1 "Agents", muted description, `.primary` button "Create agent" with `Plus` icon. No "Raw config" eyebrow.
- Each row (`.data-row`, `role` via list semantics `ul/li`): name as `Link` to `/agents/:name`; badges "Default" (only if default) and "Package" (if `from`); model in `code`; "N tools · M skills" (package-bound rows show the `from` reference in `code` instead of counts); "New chat" button; ⋯ `button[aria-label="Actions for <name>"]`.
- Menu items: "Set as default" (hidden when already default), "Duplicate", "Rename", separator, "Delete" (`danger-item`).
- `AgentActionDialog`: titles from a static map ("Set default agent", "Duplicate agent", "Rename agent", "Delete agent"); rename prefills current name, duplicate prefills `${name}_copy`; confirm disabled when name is blank, unchanged (rename), or already exists; confirm label equals action ("Set as default", "Duplicate", "Rename", "Delete agent"), `.danger` for delete; errors shown only inside the dialog; on success `changed()` then navigate (delete from detail → `/agents`, rename/duplicate → new name).
- Empty: no models → `Empty` "No agents yet" with link to `/settings/models`; models but no agents → `Empty` with "Create agent" action.
- Create modal errors only inside the modal (separate state from page).

### Documentation
Deferred to Phase 6 (single doc rewrite with screenshots).

### Tests first
`tests/dashboard-ui/agents.spec.ts` additions:
- List row for `raw` shows "fixture", "Default" badge and the tool count from fixture config; an `extraAgents.second` row shows no Default badge.
- ⋯ → Rename to `renamed` → URL `/agents/renamed`, list then shows `renamed`.
- ⋯ → Delete on `second` → confirm button has class `danger`; row disappears.
- Rename dialog: confirm disabled for blank and for unchanged name.
- ⋯ → Duplicate `raw` as `raw_copy` → URL `/agents/raw_copy`; config file contains both `raw` and `raw_copy`; list shows both rows.
- ⋯ → Set as default on `second` → config file `default_agent === "second"`; "Default" badge moves from `raw` row to `second` row; the menu for `second` no longer offers "Set as default".
- Create with a server error (route `**/api/agents` POST → 409) shows exactly one `role=alert` on the page, inside the dialog.
- Lifecycle failure: route `**/api/agents` POST → 409 for a Rename from the list ⋯ → exactly one `role=alert`, located inside the rename dialog; dialog stays open.
Update `management.spec.ts` / `loading.spec.ts` only where selectors changed (keep "Create agent", "Agent name", "Create").

### Anti-shortcut coverage
Counting alerts rejects keeping the shared error state; Default-badge absence on `second` rejects always-rendered badges; disabled-confirm checks reject UI-only label changes.

### Implementation obligations
List + menu + dialog in production code; detail page may temporarily import `AgentActionDialog` but its layout redesign is Phase 4.

### Acceptance criteria
- [ ] AC-1: Rows show model, counts and conditional badges — `agents.spec.ts`.
- [ ] AC-2: Rename, Duplicate, Delete and Set default are each reachable from list ⋯ and each persists the expected config change — four `agents.spec.ts` tests.
- [ ] AC-3: Single error surface (inside the dialog) for both create and lifecycle-action failures — two `agents.spec.ts` tests.
- [ ] AC-4: Empty states use `Empty` — inspection + test with a config that has no agents if fixture supports it, else inspection.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/agents.spec.ts tests/dashboard-ui/management.spec.ts tests/dashboard-ui/loading.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): agents list with summaries and action menu`

## Phase 4: Agent detail shell — header, tabs, save bar, loading

### Goal
`/agents/:name` uses a chat-style header with breadcrumb and ⋯ menu, section tabs, a sticky save bar and a skeleton while loading. Existing form content moves into tabs unchanged.

### Current behavior and gap
`Agents.tsx:233-401`: "THIS AGENT" eyebrow, out-of-context "Create agent", Save bar on top, 5 lifecycle buttons, one long column, nothing rendered before `draft.base`.

### Evidence
`DraftActions` (`editors/shared.tsx:187-250`), router guard, radix Tabs in `timeline.tsx`.

### Pattern
`.page-header` (`styles.css:715-740`), `.page-breadcrumb`, `.tabs.page-tabs`, `.sticky-savebar`.

### Dependencies
Phase 3 (`AgentActions`).

### Files and symbols
New `web/src/pages/agents/AgentDetail.tsx` (`AgentDetail`), `web/src/editors/shared.tsx` (`DraftActions` `variant`), `web/src/pages/Agents.tsx`, `web/src/styles.css`.

### Behavioral contract
- Breadcrumb `nav[aria-label="Breadcrumb"]`: link "Agents" → `/agents`, then current name.
- h1 = agent name; badges: model, "Default", "Package".
- Right side: "New chat" button and ⋯ menu (`AgentActionsMenu`). Both disabled while `draft.dirty || !draft.base` with `title="Save or discard changes first"`.
- No "Create agent" button on detail.
- `Tabs.Root` `aria-label="Agent sections"` with triggers Overview, Capabilities, Policy, JSON; inactive panels `forceMount` + `hidden`.
- Default tab JSON when `value.from` or `parseError`; Overview otherwise. When `from` set, Capabilities and Policy triggers are hidden (form not applicable) and Overview shows the package notice linking to JSON tab.
- `DraftActions variant="bar"` renders `.sticky-savebar` (position sticky, bottom 0, within `main`) only when dirty/busy/conflict/status/error; contains state dot + text, Discard, Save; conflict buttons and review modal unchanged.
- Before `draft.base`: `SkeletonRegion` with label "Loading agent".
- Catalog error banner shown at top of Capabilities tab.

### Documentation
Deferred to Phase 6.

### Tests first
`agents.spec.ts`:
- Breadcrumb link "Agents" returns to `/agents`.
- No "Create agent" button on `/agents/raw`.
- Save bar absent initially; typing in System prompt shows it with "Unsaved changes"; Discard hides it.
- Edit System prompt (Overview) → switch to Capabilities → back → value retained; no "Keep editing" dialog appears during tab switches.
- Package-bound agent opens on JSON tab and hides Capabilities/Policy triggers: create it the same way `tests/dashboard-ui/packages.spec.ts` installs a package and binds an agent export (`agents/writer.json`, `:16-25,143`).
- Parse error: on `/agents/raw` JSON tab, type malformed text into the "Agent JSON" editor → parse error banner visible; switch to Overview → package/parse notice shown instead of the form; restoring valid JSON brings the form back. (External file edits cannot produce a parse error because the endpoint returns parsed objects re-serialized with `pretty()`.)
- Delayed `GET /api/agents/raw` (route delay) shows "Loading agent" skeleton.
Update existing specs: click tab "Capabilities" before asserting `getByLabel("Selected hooks|skills")` (`management.spec.ts:21,58`) and before selecting "Add vars" (`management.spec.ts:147-154`); grep `tests/dashboard-ui` for `Selected `, `Add tools|skills|hooks|vars`, `Rule `, `Test rules`, `Agent JSON` and migrate every hit (including `settings.spec.ts`, `packages.spec.ts`) to open the owning tab first; "New chat" now in header; `capture-management.ts` waits for "System prompt" (Overview default — unchanged).

### Anti-shortcut coverage
Tab round-trip with draft retention rejects unmounting tab content; "no guard dialog" rejects URL-based tabs; save-bar visibility toggling rejects an always-on bar; other pages' DraftActions untouched (inline variant) verified by unchanged settings specs.

### Implementation obligations
Shell + relocation only; content components keep current markup until Phase 5.

### Acceptance criteria
- [ ] AC-1: Header shows breadcrumb, name, badges, New chat, ⋯; no Create agent — `agents.spec.ts`.
- [ ] AC-2: Tabs switch without guard and preserve draft — `agents.spec.ts`.
- [ ] AC-3: Save bar only when needed; Settings editors unchanged — `agents.spec.ts` + `settings.spec.ts`.
- [ ] AC-4: Loading skeleton before agent JSON arrives — `agents.spec.ts`.
- [ ] AC-5: Package-bound agents open on JSON tab; typed malformed JSON shows the parse error and hides the form until fixed — `agents.spec.ts`.
- [ ] AC-6: Every existing spec that touches agent detail controls opens the owning tab first and passes (incl. `management.spec.ts:147-154` vars) — phase gate.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/agents.spec.ts tests/dashboard-ui/management.spec.ts tests/dashboard-ui/settings.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): agent detail header, section tabs and sticky save bar`

## Phase 5: Tab content — cards, selections and policy

### Goal
Each tab's content follows card-based, compact, aligned layout.

### Current behavior and gap
Prompt source is a select + 4-row textarea; selections use large text buttons and misaligned Add row, no empty placeholder; policy rows are a stack of fields with "Move up" only; empty `p[role=status]` always rendered; JSON hidden in `<details>`.

### Evidence
`Agents.tsx:275-368, 403-649`.

### Pattern
`.card`/`.card-header`, `.segmented`, `.icon-button`, `.badge.*`, `SourceEditor`.

### Dependencies
Phase 4.

### Files and symbols
New `web/src/pages/agents/Selection.tsx` (`Selection`), `web/src/pages/agents/PolicyEditor.tsx` (`PolicyEditor`); `AgentDetail.tsx`; `web/src/styles.css`.

### Behavioral contract
- Overview: card "Model" (select, label "Model"); card "Instructions" with `.segmented` radiogroup `aria-label="Prompt source"` options "Text"/"File" (switching clears text as today), textarea labelled "System prompt"/"System prompt file", `rows={12}`, vertical resize, existing hints.
- Capabilities: cards Tools, Skills, Hooks, Variables; header shows count badge; list `ol[aria-label="Selected <label>"]` rows: index, `code` ref (+ ` as alias`), `icon-button`s ArrowUp/ArrowDown/X keeping aria-labels "Move X up", "Move X down", "Remove X"; empty placeholder "No <label> selected"; Add row `align-items: end` with select labelled "Add <label>" and button "Add"; MCP hint in Tools card footer. Selecting skills still auto-adds the two skill tools.
- Policy: card "Rules" — each rule a grid row (Match, Effect, When.any + Regex only for ask, actions Move up / Move down / Remove rule), keeping field labels `Rule N match|effect|when.any|regex`; "Add rule". Card "Test a sample": identity, args JSON, "Test rules"; result rendered as `p[role=status]` containing `.badge` colored by effect (allow→success, ask→warning, deny→error), only when a result exists.
- JSON: description + `SourceEditor` label "Agent JSON", parse error banner; no `<details>`.

### Documentation
Deferred to Phase 6.

### Tests first
`agents.spec.ts`:
- Segmented "File" switches label to "System prompt file" and saved JSON uses `system_prompt_file`.
- Hooks empty → "No hooks selected" visible; add one → placeholder gone, list contains it.
- Reorder tools with Move down then save → config file order changed (read `raw.configPath`).
- Selecting a skill auto-adds `builtin/list_skills` and `builtin/load_skill` (regression of invariant 1).
- Policy: add two rules, Move down first → order swapped in saved config; Test rules shows status with "ask"/"deny" text and matching badge class; no `role=status` element in Policy before testing.
- Existing approval/tool-ui specs that edit rules via JSON remain green.

### Anti-shortcut coverage
Asserting on the saved config file (not only DOM) rejects cosmetic-only reorder; skill auto-add assertion protects the hidden coupling; status-absence assertion rejects always-rendered empty status.

### Implementation obligations
Components and CSS; no change to JSON semantics.

### Acceptance criteria
- [ ] AC-1: Prompt source segmented control works and persists correct key — `agents.spec.ts`.
- [ ] AC-2: Selection empty placeholder, reorder and remove persist correctly — `agents.spec.ts` + `management.spec.ts`.
- [ ] AC-3: Policy Move down exists and persists; result badge reflects effect — `agents.spec.ts`.
- [ ] AC-4: JSON tab shows editor without `<details>` — `agents.spec.ts`.
- [ ] AC-5: Axe passes on `/agents` and `/agents/raw` (all tabs) — `accessibility.spec.ts` extended.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/agents.spec.ts tests/dashboard-ui/management.spec.ts tests/dashboard-ui/accessibility.spec.ts --project=chromium`

### Phase gates
`npm run typecheck && npm run build && npx playwright test --project=chromium && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat(dashboard): card layout for agent instructions, capabilities and policy`

## Phase 6: Responsive polish, screenshots, docs and qualification

### Goal
Responsive behavior verified, screenshots and docs updated, full qualification recorded.

### Current behavior and gap
Docs (`docs/dashboard.md:90-128`) and screenshots describe the old layout; no list-page screenshot.

### Evidence
`tests/dashboard-ui/capture-management.ts:30-39`, breakpoints `styles.css` 1199/899/599.

### Pattern
Evidence format of `docs/evidence/local-dashboard.md` and `docs/evidence/tool-ui-and-builtins.md`.

### Dependencies
Phases 1–5.

### Files and symbols
`web/src/styles.css` (breakpoint rules), `tests/dashboard-ui/capture-management.ts`, `tests/dashboard-ui/agents.spec.ts`, `docs/dashboard.md`, `docs/dashboard/agent-*.png`, new `docs/dashboard/agents-list-{light,dark}-desktop.png`, `docs/evidence/local-dashboard.md`.

### Behavioral contract
- ≤899px: header actions wrap below title; tabs scroll horizontally (`overflow-x: auto`); list rows hide the counts column.
- ≤599px: no horizontal page overflow on list or detail.
- `capture-management.ts` also captures list page in both themes.

### Documentation
Rewrite "Customize your agents" in `docs/dashboard.md` (list, header/menu, tabs, save bar) with new screenshots; evidence section dated 2026-10-xx with gate results and review verdicts.

### Tests first
`agents.spec.ts`: at 390×844 viewport, `document.documentElement.scrollWidth <= innerWidth` on `/agents` and `/agents/raw`; tabs list is scrollable not wrapped.

### Anti-shortcut coverage
Overflow measurement rejects hiding elements with `display:none` blanket rules only where they are needed for function (New chat and ⋯ must remain visible — asserted).

### Implementation obligations
CSS breakpoints, capture script, docs, evidence.

### Acceptance criteria
- [ ] AC-1: No horizontal overflow at 390px; New chat and ⋯ visible — `agents.spec.ts`.
- [ ] AC-2: Screenshots regenerated for list and detail, light/dark — inspection of `docs/dashboard/`.
- [ ] AC-3: `docs/dashboard.md` matches new UI — inspection.
- [ ] AC-4: Full 3-browser `npm run test:web` and `npm run check` pass, recorded in evidence — evidence doc.

### Focused verification
`npm run build && npx playwright test tests/dashboard-ui/agents.spec.ts --project=chromium && node --import tsx tests/dashboard-ui/capture-management.ts`

### Phase gates
`npm run check && npm run test:web && git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`docs(dashboard): qualify redesigned agents tab with screenshots and evidence`

## Completion Criteria

- All phase ACs checked; each phase committed with APPROVE review.
- `npm run check`, `npm run test:web` (chromium, firefox, webkit) and `git diff --check` pass on the final commit.
- Agents list and detail visually match the chosen layout (header + tabs + sticky save bar) in light and dark, verified by regenerated screenshots.
- No change to agent JSON semantics or other management pages' behavior.

## Progress Log

- 2026-10-02: Plan drafted from code discovery; user decisions recorded in Target.
- 2026-10-02: Codex plan review APPROVE after 2 rounds. Ready for `/loop-implement`.
- 2026-10-02: Phase 1 complete — typecheck OK, `test:phase dashboard` 60/60, codex-impl-review APPROVE (1 round).
