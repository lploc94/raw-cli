# Shared tool UI and extended builtins — verification evidence

This records the cloud continuation of `refactor-tool-ui-and-extend-builtins-plan.md` from `6034478657b1640aaa12f74c2ca58bc044332314` and the subsequent macOS qualification. Work was stopped after phase 8, then resumed from `origin/work` at `2b9bb0d` at the user's request. Phase 9 local qualification is complete; the user explicitly waived current CI qualification and requested local installation and commit/push.

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

Resumed locally on macOS with Node 26.0.0 and npm 11.12.1. Default Chromium, Firefox and WebKit executables are available; the cloud browser exception is unnecessary here. The integrated fixtures cover answer retry, background lifetime across turns, patches and immutable history, Todo, a copied third-party diagram tool, reconnect, Stop during a pending model request, and real killed-built-host recovery. The installed-package probe additionally loads the shipped diagram example outside the checkout.

Actual Chromium captures from the built dashboard: [workflow with Todo and diagrams](tool-ui-workflow.png), [Mermaid in a narrow dark sidebar](tool-ui-mermaid-dark.png). Browser tests also verify the form, Commands, Files changed, source/error fallback, keyboard interaction and axe results. These are fixture sessions, without a paid provider.

Three integration defects have regression evidence and fixes: Stop feedback was hidden when its row became terminal; dead-host pending controls remained running for an already-open observer; and a persisted library agent could accept an in-memory or wrong-database interaction host. A fourth defect discovered by the full browser gate was the dashboard's Create hook template omitting the required current `protocol_version: 2`. The template is updated directly, without an old-format adapter.

Initial aggregate Node check was 882/883. Its remaining failure was a copied-tool fixture using macOS's symlink `/var` as cwd; canonicalizing the fixture root preserves the patch contract's rejection of symlink ancestors. Initial full browser gate was 492/495; all three failures were Create hook, one per browser. Both final gates passed after correction. One extra focused workflow invocation overlapped a package rebuild and failed to find a pending question; it is excluded from qualification. The exact focused rerun after the build completed passed 2/2, with no assertion change.

| Final local command | Result |
| --- | --- |
| `npm run check` | Typecheck/build passed; 884/884 Node tests passed |
| `npm run test:web` | 495/495 passed, 165 per configured Chromium/Firefox/WebKit project |
| `npm run test:package` | 4/4 passed; installed Ask, Process, patch/effects/Files changed and copied diagram outside checkout |
| `npm run test:overhead` | Passed; 41 prompt tokens, 1,612 combined tokens for the existing measured default selection |
| `node --import tsx --test tests/tool-ui-workflow.test.ts` | 2/2 passed on complete built artifacts |
| `npm run test:web -- tests/dashboard-ui/tool-ui-workflow.spec.ts` | 3/3 passed on the final built dashboard, including moving focus away from Stop |
| Interaction/control/workflow/plugin regressions | 38/38 passed |
| `git diff --check` | Passed |

Implementation review `codex-impl-review-20260930-008`, thread `01a0f245-4978-7b12-9843-aea239dababf`: round 1 raw **APPROVE**, including the added Hook template repair; no findings. Reviewer independently verified typecheck, Mermaid/Commands and dead-host control transitions, live/terminal isolation, audit preservation and retention. Runner finalized APPROVE and stopped normally. Final-HEAD local gate revalidation and installation follow the phase commit.

The GitHub API is accessible from this host. Repository Actions permissions allow workflows, but `gh workflow list --all` reports the CI workflow (`367120458`) as `disabled_manually`. The user explicitly instructed “CI tắt, cài vào máy tôi và commit push đi”: keep CI disabled and accept local qualification. No current-source Linux/CI pass is claimed; previous Linux phase evidence above remains distinct. This exception closes the CI decision without changing the workflow setting.

The prior cloud stop left unapplied drafts outside the repository. This continuation recreated the workflow from verified current contracts; those temporary drafts are not evidence or shipped code. No PR, merge, deployment or release is part of this plan.

Final phase-8 logs: `/tmp/raw-cli-p8-stable-build.log`, `/tmp/raw-cli-p8-stable-typecheck.log`, `/tmp/raw-cli-p8-mermaid-unit.log`, `/tmp/raw-cli-p8-focused.log`, `/tmp/raw-cli-p8-browser-final.log`. Actual light/dark visual captures were produced in the ignored Playwright `test-results/dashboard` directory; they are not committed artifacts.
