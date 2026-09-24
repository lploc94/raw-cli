# Phase 4 evidence: bounded agent loop

Status: complete on 2026-09-24. Scope: Phase 4 of `build-raw-cli-plan.md`.

## Integration and tests

`src/agent.ts` owns per-session transcript, state, request controller, step count and raw usage. It uses the committed `ProviderAdapter.generate` interface from Phase 3 and `ToolRegistry.dispatch` from Phase 2. The registry now reports `tool_start` after approval, before execution. `docs/architecture.md` records the state/sequence contract.

- Initial `npm run test:phase -- agent`: RED because `src/agent.ts` did not exist. Integrated SDK fixture and lifecycle tests then passed 9/9.
- Added RED/GREEN tests for a provider that ignores abort and responds late; first attempted noninteractive tool without approval; abort during unresolved approval; max=1 and max=25 last-step tool; closing while active. These brought focused tests to 10/10 before review.
- `gpt-6-astra` review round 1 found three event-boundary defects. RED/GREEN regressions cover throwing `tool_result`/`run_end` observers, mutable event arguments/results/usage, and abort from usage delivery. Focused agent tests now pass 13/13.
- Final `npm run check`: typecheck, tsup build and 55/55 cumulative tests. `npm run test:overhead`: 25 prompt / 175 combined reference tokens.

## Acceptance

- AC-4.1: Real OpenAI SDK fixture requests write/read/Bash, then answers; a later user turn receives exact prior call/result history and does not rerun tools. `tests/agent.test.ts`.
- AC-4.2: One inference request equals one step. Max=1 and max=25 final-step tool calls do not dispatch or commit dangling declarations; 24 earlier calls execute in order. `tests/agent.test.ts`.
- AC-4.3: Provider abort, late response, approval abort, active tool abort, denial, malformed args, unknown tool and shell nonzero exit preserve matching results and one terminal event. Observer failures cannot orphan calls or mutate authorized execution. `tests/agent-lifecycle.test.ts`.
- AC-4.4: Same-session busy rejection, separate cwd/history/usage, close/abort behavior and rejection after close. `tests/agent-lifecycle.test.ts`.

## Review

`codex-impl-review` via `gpt-6-astra`: 2 rounds, 3 findings fixed, final raw verdict `APPROVE`. Session: `.codex-review/sessions/codex-impl-review-20260924-004`. The runner parser reports `format:unknown` on the verdict-only response, but raw Markdown explicitly says `Status: APPROVE`; `finalize` recorded APPROVE. No unresolved in-scope finding.
