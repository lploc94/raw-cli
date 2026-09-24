# Phase 3 evidence: official provider adapters

Status: complete on 2026-09-24. Scope: Phase 3 of `build-raw-cli-plan.md`.

## SDK and wire paths

Production adapters import pinned official `openai`, `@anthropic-ai/sdk`, and `@google/genai` clients. `src/llm/client.ts` routes six provider profile names to those three clients; `src/llm/openai.ts`, `anthropic.ts`, and `google.ts` use Chat Completions streaming, Messages streaming, and Gemini `generateContentStream` respectively. Tests in `tests/providers.test.ts` and `tests/provider-content.test.ts` drive the real SDKs against `tests/fixtures/mock-provider.ts`, recording HTTP paths, headers, bodies, streamed chunks and follow-up requests. No external credential or paid service was used.

## Tests first and gates

- Initial focused provider suite was RED because `src/llm/client.ts` did not exist. First implementation passed 10/10 fixture tests after adapting Anthropic initial text and Gemini's model-in-URL request shape.
- Review round 1 found ten in-scope defects. New fixture regressions were RED before changes: parallel result ordering, OpenRouter opaque reasoning, missing Gemini arguments, provider/synthetic ID handling, duplicate linkage, malformed Anthropic event lifecycle, open response cleanup, large base64, and malformed arguments with usable linkage. They became GREEN after repairs.
- Review round 2 found a cross-turn Gemini synthetic-ID collision. A three-request fixture reproduced it RED, then GREEN after scoping ID provenance to one assistant batch.
- Final `npm run test:phase -- providers`: 17/17. Final `npm run check`: strict typecheck, tsup build and 42/42 tests. `npm run test:overhead`: default prompt 25 and combined prompt/schema 175 `o200k_base` tokens.

## Acceptance

- AC-3.1: Six provider profiles use correct official client, endpoint, model, system, tool schema, output limit and linked tool-result request. `tests/providers.test.ts`.
- AC-3.2: OpenAI fragmented/interleaved calls, Anthropic thinking/signature blocks, Google thought signatures, OpenRouter reasoning details and parallel result batches survive follow-up requests. `tests/provider-content.test.ts`.
- AC-3.3: 401/429/500, malformed frame, incomplete EOF, refusal, timeout and abort are terminal without hidden SDK retry. Live-response early error closes transport. `tests/provider-content.test.ts`.
- AC-3.4: Text/JSON/PNG/JPEG map to native SDK message content; unsupported MIME/base64 fails before inference. A 4 MiB image validates without stack overflow. `tests/provider-content.test.ts`.

## Review

`codex-impl-review` via `gpt-6-astra`: 3 rounds, 11 issues found and fixed, final raw verdict `APPROVE`. Session: `.codex-review/sessions/codex-impl-review-20260924-003`. The runner's parser reports `format:unknown` for the verdict-only final response; its raw Markdown explicitly says `Status: APPROVE`, and `finalize` recorded APPROVE. No unresolved in-scope issue. Live hosted-model compatibility remains unqualified because only local SDK wire fixtures were exercised.
