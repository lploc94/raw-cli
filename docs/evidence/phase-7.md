# Phase 7 evidence: ACP v1 and parent client

Status: implementation verified and approved on 2026-09-24. Scope: Phase 7 of `build-raw-cli-plan.md`.

## Documentation and RED/GREEN

`docs/acp.md` was written before handlers. It describes standard ACP v1, baseline content, locally selected session MCP, raw capability negotiation/extensions, errors, ownership, stdio purity and loopback WebSocket. The initial `npm run test:phase -- acp` failed RED because the ACP modules and daemon mode were absent. Tests subsequently exercised the production daemon and official SDK client. A WebSocket stream double-close failed RED and was fixed. A split/coalesced stdio notification test caught noisy unknown-session cancellation, fixed to be a no-op notification.

## Acceptance evidence

- AC-7.1: `tests/acp-transport.test.ts` launches `bin/raw.ts --acp --stdio` as a real child and uses the independent official `@agentclientprotocol/sdk` client for initialize/new/prompt/update. It sends text-only, resource-only and mixed prompts; captures URI/name/title/description/MIME/size/annotations in order on real OpenAI SDK requests; unsupported image prompt is rejected without inference. A standard `session/new` MCP server invokes a selected page-two tool without raw extensions. Split/coalesced frames, parse errors, invalid requests/params, version negotiation and pure stdout are covered.
- AC-7.2: `tests/acp.test.ts` registers a negotiated reverse tool and verifies the client callback's sentinel/image/error reach the model tool-result transcript. Missing capability, duplicate registration, timeout, cancellation notification and late response paths are exercised. `tests/acp-client.test.ts` exercises the exported parent helper against a real daemon and OpenAI SDK fixture.
- AC-7.3: In-process official SDK connections verify concurrent session cwd/result isolation, busy errors, cross-peer rejection, cancellation during pending permission/reverse callback and disconnect during active Bash, with no delayed filesystem side effect.
- AC-7.4: A real loopback WebSocket listener accepts SDK parent client initialize/new/prompt/cancel/close, rejects non-loopback bind and browser Origin, uses one JSON-RPC text frame, rejects binary/oversized frames and reports parse/invalid request errors. Parent stdio child PID exits after close.
- AC-7.5: `_raw/session/compact` succeeds, returns byte counts/usage, then noops without a request. A failed summary returns an error and leaves the prior prefix intact. A pinned original `resource_link` block with metadata survives compaction.
- Review regressions: real SDK 401 cannot leak an API key into ACP errors; disconnect during MCP discovery reaps the child; pending discovery cannot delay cancellation of another session's Bash, with an explicit discovery-start marker. Spawn ENOENT rejects cleanly; parent connection close aborts callbacks, and parent close reaps both daemon and MCP child PIDs. Reverse callback timeout sends cancel and JSON/4 MiB valid PNG reach the model. Runtime info shows hidden and deselected MCP aliases accurately; an unsupported unselected schema does not block a selected valid tool, while a selected alias collision fails. Invalid tool arguments still emit an initial `tool_call` before the failed update.

## Verification and limits

- `npm run test:phase -- acp`: 26/26 passed.
- `npm run test:phase -- mcp`: 19/19 passed after the catalog change.
- `npm run check`: strict typecheck, tsup build and 117/117 cumulative tests passed.
- `npm run test:overhead`: 25 prompt / 175 combined reference tokens; default prompt and three built-ins were unchanged.
- Parent tested revision: `7e7dc45` plus Phase 7 working tree. SHA-256: `src/acp/methods.ts` `ef2b7dd0d8cfb2349d6f7739575c9f4da5ba24ad679ccecc99f6fd74b5f11676`; `src/acp/transport.ts` `926a8b3a1d7f6199768592e8d2b18c2109ec76eaf946d6473f8c4e27eac5878b`; `src/acp/client.ts` `538be0fa5380ff664661f98f83000e90592ca9a3db7713caff026109914edede`; `src/tools/mcp-client.ts` `8f1515f9e98777492bebf6655067b00019b3ad15d40ec77eac26978a16d8d302`; `src/agent.ts` `45bb47e9b1c271b941fbb193a7f469abba8022489300d6eb754c29a52ae05dcb`.
- Local fixture backends and local WebSocket were tested; no third-party IDE compatibility or remote hosting is claimed. The server intentionally has no session persistence or OS sandbox.

## Review

`codex-impl-review` with `gpt-6-astra`: round 1 found eight defects; round 2 closed them and found four regressions; round 3 closed those and found two defects plus one test gap. Round 4 returned explicit `Status: APPROVE` with no new in-scope defects. All fifteen issues are fixed and verified. The runner marked the verdict-only round `format: unknown`; its raw reviewer text and the finalized review metadata record the approval. Session: `.codex-review/sessions/codex-impl-review-20260924-008`.
