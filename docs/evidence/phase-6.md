# Phase 6 evidence: selected MCP tools and native content

Status: complete on 2026-09-24. Scope: Phase 6 of `build-raw-cli-plan.md`.

## Documentation and RED/GREEN

`docs/mcp.md` defines config overlay, three transports, explicit selection, aliases, deadlines, content and resource behavior before production changes. `npm run test:phase -- mcp` first failed RED because `src/tools/mcp-client.ts` did not exist. The implementation then passed focused fixtures. A Streamable HTTP fixture initially failed because a stateless SDK transport was reused across requests; the official fixture now uses a stateful session ID and passes.

## Acceptance evidence

- AC-6.1: `tests/mcp.test.ts` `T-06a` runs official SDK fixture servers over stdio, SSE and Streamable HTTP. It discovers a page-two tool, invokes it through `AgentSession` and captures the selected server sentinel in the next real OpenAI SDK request.
- AC-6.2: `T-06b` discovers 102 tools from two stdio servers but exposes only two selected aliases; direct dispatch of a hidden tool fails. Same original names reach distinct server sentinels, schemas validate arguments, `"*"` selects all, an unknown selection fails, long aliases remain unique and <=64 characters, and shuffled discovery leaves sorted model schemas. Empty selections expose none.
- AC-6.3: `T-06c` checks partial startup failure reaps the already opened stdio child PID, abort during a slow call produces one linked cancelled result with no late transcript change, SDK request timeout leaves the connection usable, dropped HTTP streams do not reconnect, SDK initialize receives the configured deadline, and echoed HTTP credentials stay out of startup/call errors.
- AC-6.4: `tests/mcp-content.test.ts` checks structured JSON de-duplication, distinct text, remote errors, output cap, 16 MiB rejection and explicit unsupported audio/resource/media. Real MCP PNG/JPEG results become native `image_url` payloads after matching tool messages in the next OpenAI SDK request. A 4 MB decoded image remains native; 17 MiB HTTP discovery and invocation responses are rejected before SDK parsing.

## Verification and limits

- `npm run test:phase -- mcp`: 18/18 passed.
- `npm run check`: TypeScript strict typecheck, tsup build and 90/90 cumulative tests passed.
- `npm run test:overhead`: default prompt 25 reference tokens, prompt plus three built-ins 175; selected external tool schemas are extra and are not included in the default budget claim.
- Parent tested revision: `fa041d2` plus this Phase 6 working tree. SHA-256: `src/tools/mcp-client.ts` `238f9827240bfe2b8595c60d5c7206250bccd62387279fbcb7d3de3c886dda46`; `src/tools/registry.ts` `3733a5443fd5c855ef12d3395789a7cf7de26f4478fb8c1844d27770ee00f17d`.
- Transport tests use local SDK fixture servers, not third-party MCP services. Remote cancellation is best effort and does not reverse a server side effect.

## Review

`codex-impl-review` with `gpt-6-astra` round 1 in `.codex-review/sessions/codex-impl-review-20260924-007` returned REVISE with six reproduced defects: stack-overflowing base64 regex, missing HTTP size bound, credential leakage in SDK errors, `$async` schema bypass, hidden reconnects and the SDK's 60-second initialize timeout. Round 2 confirmed five fixes, and found a startup reconnect gap plus CR-only SSE framing regression. Both failed RED and passed after repair. Round 3 returned explicit raw `Status: APPROVE`, independently running 90/90 cumulative and 18/18 MCP tests; the runner parser reports `unknown` for verdict-only output and retains its previous parsed `REVISE` metadata. No in-scope finding remains.
