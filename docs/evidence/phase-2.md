# Phase 2 evidence: built-in tools and process cleanup

Status: complete on 2026-09-24. Scope: Phase 2 of `build-raw-cli-plan.md`.

## Source and contracts

Phase 1 supplied `RuntimeConfig.maxOutputBytes` and `autoApprove` in `src/config.ts`, the shared `ToolResult` shape in `src/tools/types.ts`, and the exact prompt in `src/llm/prompt.ts`. Phase 2 adds immutable production schemas and dispatch in `src/tools/registry.ts`, file primitives in `src/tools/primitives.ts`, Bash group ownership in `src/tools/process.ts`, and shared capping in `src/tools/results.ts`. The host account retains full permissions; `cwd` resolves relative paths and is not a sandbox.

## Tests first and gates

- Initial `npm run test:phase -- tools`: RED because `registry` and overhead implementation did not exist. The first implementation made 5/5 focused tests pass.
- Review round 1 produced eight concrete defects. New regression tests failed for UTF-8 replacement characters, approval cancellation, schema prototype keys, timeout overflow, dispatch error cap, escaped-pipe settlement, nested schema mutation and process-tree readiness. After fixes, focused tests passed 7/7 and `npm run check` passed 25/25.
- Review round 2 found BOM loss and a retained reaping timer. Both regressions were observed RED, then GREEN. Final `npm run check` passed typecheck, tsup build and 25/25 tests. `npm run test:overhead` passed.
- Real subprocess coverage: 200004 bytes of stdout drained after a 5-byte cap; exact cap and split UTF-8; 20 ms shell deadline; child/grandchild attempted delayed sentinel, readiness PID recorded before abort, child exit checked, unrelated process completed; escaped detached descendant retained output pipes yet timeout settled in about 1 second and no owned timeout remained.

## Acceptance

- AC-2.1: Three exported default definitions only; invalid arguments, hidden/unknown tools, duplicate registration, approval denial and absent headless approval have no side effects. Tests: `tests/registry.test.ts`, `tests/overhead.test.ts`.
- AC-2.2: File path/cwd isolation, nested parents, empty content, errors, bounded UTF-8 and BOM; Bash channels, status, cap and draining. Test: `tests/primitives.test.ts`.
- AC-2.3: Owned group termination, descendant exit and unrelated process preservation; escaped-pipe settlement is bounded. Test: `tests/primitives.test.ts`, fixtures in `tests/fixtures/`.
- AC-2.4: Production prompt 25 tokens; combined canonical prompt plus three schemas 175 `o200k_base` tokens. Exact serialized input and definitions: `docs/evidence/phase-2-overhead.json`.

## Review

`codex-impl-review` via `gpt-6-astra`: 3 rounds, 10 issues found and fixed, final raw verdict `APPROVE`. Session: `.codex-review/sessions/codex-impl-review-20260924-002`. The runner marked a verdict-only response `format:unknown`, but raw Markdown explicitly said `Status: APPROVE`; `finalize` recorded APPROVE. No unresolved in-scope issue.
