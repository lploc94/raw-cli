# Shared tool UI and extended builtins — verification evidence

This records the cloud continuation of `refactor-tool-ui-and-extend-builtins-plan.md` from `6034478657b1640aaa12f74c2ca58bc044332314`. Work was stopped and committed at the user’s explicit request after phase 8. Phase 9 and final integrated qualification are incomplete.

## Environment and approved exception

Linux, Node 24.19.0, npm 11.9.0. Commands use:

```sh
umask 0022
export TERM=xterm-256color
export npm_config_cache=/tmp/raw-cli-npm-cache
export RAW_TEST_CHROMIUM_EXECUTABLE=/usr/bin/chromium
```

The stock environment has `TERM=dumb`, umask `0077`, and an unwritable default npm cache. An initial baseline run passed 822/839; the 17 failures were traced to terminal rendering expectations, mode-sensitive package snapshots, and npm cache writes. Using the environment above resolved those causes without changing assertions. An independent package subset passed 20/20; the five original PTY failures passed with the terminal setting restored.

The Playwright browser download host returned HTTP 403 `Domain forbidden`, including an approved retry. The user explicitly authorized skipping checks that cannot run and continuing phases 6–9. Firefox and WebKit are unavailable here; they are **skipped, not passed**. Chromium checks use the installed executable via an explicit test override; they do not establish qualification against Playwright's pinned browser revision. No network restriction was bypassed and no application CSP was weakened.

Existing macOS/Linux CI qualification and Windows unsupported-platform fixtures remain separate from this Linux execution. No native macOS or Windows run is claimed by this record.

## Phase 6 — Commands

Local commit `800b1c7`. Independent implementation review: round 1 REVISE, round 2 APPROVE after corrections to approval authority races, deleted-session foreground cache, stable row identity/focus, stdout/stderr labels, and interrupted Stop retry handling.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Focused API, supervisor/lifecycle, primitives, web state, surface and plugin tests | 76/76 passed |
| `npm run test:phase -- dashboard` | 59/59 passed, including installed dashboard with explicit system Chromium override |
| `npm run test:web -- --project=chromium tests/dashboard-ui/processes.spec.ts tests/dashboard-ui/panels.spec.ts` | 25/25 passed |
| Rebuilt plugin and dashboard-process tests | 17/17 passed |
| `git diff --check` | Passed |

The controls use independent durable audit identities and normal Process policy, hooks and approval. They do not append model messages or acquire the active model turn's writer lease. Foreground observations cannot alter Bash execution results. CLI and ACP retain readable Process JSON and foreground Bash text rather than claiming browser sidebar presentation.

## Phase 7 — Patches and Files changed

Independent implementation review APPROVE after resource bounds were added. Typecheck/build passed; focused Node 60/60, exact tools gate 9/9, installed-package gate 4/4, system Chromium Files changed 3/3, diff check passed. Installed and copied standalone handlers exercise patch parsing, effects and Files changed outside the checkout.

Preflight validates every source and staged result before mutation. Application is ordered and is not a cross-file transaction. A later external edit or I/O failure retains reported earlier successes and stops later changes; failed rename source deletion reports its already-created destination. Limits are documented in tools.md, including staging memory and matching work. Diff observation is bounded and best effort and cannot make an otherwise valid write fail. Cancelled builtin writes preserve their completed file history only; arbitrary cancelled plugin views still roll back.

An initial oneOf schema needed branch-local properties for Ajv strictRequired; that was corrected before passing package checks. The old definition hash fixture was updated for the intentional patch input contract.

## Phase 8 — Mermaid

Mermaid 12.0.0 and DOMPurify 3.4.16 are pinned, locally bundled and lazy-loaded. Shared rendering covers completed assistant Markdown fences and chat/sidebar blocks. Source preflight rejects configuration, resource and action syntax before temporary DOM work; production SVG sanitization removes active content and nonlocal references. Application CSP is unchanged. A standalone local diagram example ships with the package.

Source/CLI/ACP tests passed 17/17. Initial browser checks exposed an ambiguous status locator and a real Markdown component identity issue that reset the source toggle on parent updates. The locator was made specific and the renderer components were stabilized. After correction, final build and typecheck passed; final Mermaid unit tests passed 6/6 and system Chromium Mermaid/accessibility passed 9/9. Independent implementation re-review explicitly APPROVE. The 17/17 combined source/surface run preceded the final UI-only identity fix. Build emits a large-chunk warning; this is not a failure.

## Phase 9 — Integrated qualification

Stopped before execution by user instruction “commit và stop task đi”. README now lists all eleven registered builtins and describes the implemented shared UI, Commands, patches and diagrams. No final aggregate `npm run check`, full Chromium suite, final `npm run test:package`, `npm run test:overhead`, integrated workflow execution or phase-9 implementation review was completed. Earlier phase-specific results above remain valid; they do not establish final integrated qualification.

Unapplied workflow/package drafts were left outside the repository at `/tmp/raw-cli-tool-ui-workflow.pending.ts`, `/tmp/raw-cli-tool-ui-workflow.pending.spec.ts`, and `/tmp/raw-cli-package-diagram.pending.patch`. They are not shipped code or passed tests. Temporary files are not durable deliverables. Active delegated workers were interrupted. No publication was requested or performed.

Final phase-8 logs: `/tmp/raw-cli-p8-stable-build.log`, `/tmp/raw-cli-p8-stable-typecheck.log`, `/tmp/raw-cli-p8-mermaid-unit.log`, `/tmp/raw-cli-p8-focused.log`, `/tmp/raw-cli-p8-browser-final.log`. Actual light/dark visual captures were produced in the ignored Playwright `test-results/dashboard` directory; they are not committed artifacts.
