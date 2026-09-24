# Phase 5 evidence: explicit compact and cache reuse

Status: complete on 2026-09-24. Scope: Phase 5 of `build-raw-cli-plan.md`.

## Documentation and RED/GREEN

`docs/context.md` records pinned original task, summary data, complete retained turns, atomic replacement, rollback, and lossy memory. `docs/providers.md` records supported native cache hints and the limits of cache-hit inference. Initial `npm run test:phase -- context` failed because the context modules were absent. After implementation, 11/11 focused tests passed. Review regressions were first observed RED (five failures across 14 tests) before the fixes. GPT-4.1 and GPT-5.2 dated snapshot regressions failed RED with unsupported-retention errors, then passed after the allowed-family snapshot rule. A real SDK `finish_reason=length` summary test failed RED with missing 800 input tokens, then passed after the adapters reported observed usage on rejected completions.

## Acceptance

- AC-5.1: `tests/compact.test.ts` exercises original task pinning, two complete retained turns, repeated task text, second compact, parallel tool linkage and the next real SDK request.
- AC-5.2: The same suite verifies zero-request noop and byte-identical rollback for failure, abort, empty, oversize and nonshrinking summary; rejected summary requests still count in usage.
- AC-5.3: `tests/cache.test.ts` captures three SDK requests across a tool round and new user turn. Prior messages, tool schemas and stable key remain identical prefixes. It checks OpenAI, Anthropic, Google and generic wire hints, explicit unsupported settings, and the GPT-4.1 dated snapshot model on the wire.
- AC-5.4: `tests/usage.test.ts` verifies inclusive OpenAI/Google inputs, disjoint Anthropic input categories, Google thought outputs, explicit zeros, absent fields, request counts and cumulative ratio coverage. `tests/compact.test.ts` additionally verifies a rejected real SDK summary retains 800 input, 512 output, 200 cached-read tokens and byte-identical transcript rollback.

## Verification

- `npm run test:phase -- context`: 17/17 passed after review fixes.
- `npm run check`: typecheck, tsup build and 72/72 cumulative tests passed.
- `npm run test:overhead`: default prompt 25 reference tokens; prompt plus built-in tool schemas 175.
- SDK fixtures are local HTTP servers. Stable request prefixes and sent cache fields are proven; actual remote cache hits or token savings are not asserted.

## Review

`codex-impl-review` using `gpt-6-astra` found six in-scope defects in session `.codex-review/sessions/codex-impl-review-20260924-005`. The first five concerned repeated original-task text, missing-usage request coverage, rejected summary usage, Google thoughts, and unsupported OpenAI 24-hour retention. ISSUE-6 found dated model snapshots; the initial GPT-4.1-only fix did not cover GPT-5.2, so the runner marked the repeated issue as stalemate. The implementation was then repaired at the family-rule level and independently reopened in session `.codex-review/sessions/codex-impl-review-20260924-006`. Its first round found rejected real SDK summaries could lose reported usage. Round 2 returned explicit raw `Status: APPROVE`, with 72/72 tests and 25/175 overhead verified; the runner's format parser marks verdict-only replies as `unknown`, so its final metadata retains the previous parsed `REVISE` despite the raw approved verdict. No unresolved in-scope finding remains.

## Tested source identity

Tests ran against committed Phase 4 parent `4b60c83` plus the Phase 5 working tree. SHA-256 of the primary production files: `src/agent.ts` `b1de641a9cb61ef9894ac59f8f2d29a073d9594ee271eca84575648524271a18`; `src/compact.ts` `27646857db3c2bc5125b5ea9b85fa3d1ee2980aef3e0b58aa0509e7d12c363e7`; `src/llm/cache.ts` `cef6caa2b6b22ad7bae493b2035e7d27b4dae0269ea207a0f667cbb078b852a2`. The same reviewed tree supplied the 72-test gate; local HTTP SDK fixtures do not prove paid backend cache savings.
