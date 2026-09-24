# Verification matrix

This record distinguishes local executable evidence from configured CI and unrun external integrations. The current configuration contract and six-phase review record are in [the redesign plan](../redesign-model-profile-configuration-plan.md). The original scaffold qualification remains in [the build plan](../build-raw-cli-plan.md) and `docs/evidence/phase-*.md`; its matrix below is historical baseline evidence.

## Configuration redesign qualification

| Phase | Evidence | GPT-6 Astra implementation review |
|---|---|---|
| 1: model/profile schema | Strict config, selected credential, removed direct override and 135 passing tests | `.codex-review/sessions/codex-impl-review-20260924-010` APPROVE |
| 2: API methods and controls | Four SDK methods, typed request fields, DeepSeek replay/cache and 146 passing tests | `.codex-review/sessions/codex-impl-review-20260924-011` APPROVE |
| 3: MCP and policy | Profile-selected tools, canonical allow/ask/deny and 161 passing tests | `.codex-review/sessions/codex-impl-review-20260924-012` APPROVE |
| 4: conditional vision | Native PNG/JPEG across four methods, text-only MCP fallback, bounded errors and 168 passing tests | `.codex-review/sessions/codex-impl-review-20260924-013` APPROVE |
| 5: automatic compact | Full-request estimate, image-safe chunking, rollback, calibration and 179 passing tests | `.codex-review/sessions/codex-impl-review-20260924-014` APPROVE |
| 6: public/package/install | 181/181 tests on Node 22 and 24, packed consumer write/MCP/vision/ACP, exact installed bytes, live DeepSeek below | `.codex-review/sessions/codex-impl-review-20260924-015` APPROVE |

The review runner sometimes failed to parse a verdict-only `APPROVE` response; the raw reviewer verdict was inspected and the session explicitly finalized as `APPROVE`. At the time of that review the base prompt used 25 reference tokens; the current prompt and tool-definition counts are reported by `npm run test:overhead`. Exactly three default built-ins remain. Phase 6 package qualification includes installed write, profile-selected MCP, native `view_image`, ACP and external TypeScript imports, without an approval flag.

## Acceptance criteria

| Criterion | Evidence |
|---|---|
| AC-1.1 | T-01a..e; strict typecheck/build in [Phase 1](evidence/phase-1.md) |
| AC-1.2 | T-01a..d; profile, credential, config command and prompt cases in Phase 1 |
| AC-1.3 | T-01e official SDK import and Node 22 in Phase 1; [provider API matrix](providers.md) |
| AC-2.1 | T-02d/e three primitive definitions and dispatch in [Phase 2](evidence/phase-2.md) |
| AC-2.2 | T-02a/b file, UTF-8, Bash and output cap cases in Phase 2 |
| AC-2.3 | T-02c real process group/descendant cancellation in Phase 2 |
| AC-2.4 | T-02e measured prompt and schemas in Phase 2; 25/175 was the historical report. Run `npm run test:overhead` for current counts. |
| AC-3.1 | T-03a six official SDK profile paths in [Phase 3](evidence/phase-3.md) |
| AC-3.2 | T-03b/c fragmented calls and opaque state replay in Phase 3 |
| AC-3.3 | T-03d terminal errors, no retry and cancellation in Phase 3 |
| AC-3.4 | T-03e native text/JSON/PNG/JPEG mapping in Phase 3 |
| AC-4.1 | T-04a integrated SDK/tool conversation in [Phase 4](evidence/phase-4.md) |
| AC-4.2 | T-04b one request per step and no last-step side effects in Phase 4 |
| AC-4.3 | T-04c/d valid error/cancel histories and single terminal event in Phase 4 |
| AC-4.4 | T-04e busy/close/cross-session isolation in Phase 4 |
| AC-5.1 | T-05a pinned task, summary and retained turns in [Phase 5](evidence/phase-5.md) |
| AC-5.2 | T-05b rollback, no-op, cancellation and request counts in Phase 5 |
| AC-5.3 | T-05c/d stable request prefixes and supported native cache controls in Phase 5 |
| AC-5.4 | T-05e known/unknown usage and cache coverage in Phase 5 |
| AC-6.1 | T-06a official SDK stdio/SSE/HTTP MCP paths in [Phase 6](evidence/phase-6.md) |
| AC-6.2 | T-06b selected aliases, ordering, validation and collision in Phase 6; T-07 alias regression |
| AC-6.3 | T-06c abort, deadline and owned child cleanup in Phase 6 |
| AC-6.4 | T-06d text/JSON/image/error/cap and native provider mapping in Phase 6 |
| AC-7.1 | T-07a/b independent ACP SDK baseline, resource links, stdio frames in [Phase 7](evidence/phase-7.md) |
| AC-7.2 | T-07c real reverse callback result to model in Phase 7 |
| AC-7.3 | T-07d ownership, busy, permission/callback cancellation and MCP/Bash cleanup in Phase 7 |
| AC-7.4 | T-07e local WebSocket and installed parent/child lifecycle in Phase 7 |
| AC-7.5 | T-07f compact extension rollback/status/usage in Phase 7 |
| AC-8.1 | T-08a/b subprocess one-shot, profile, exits, PTY approvals, Ctrl-C and EOF in [Phase 8](evidence/phase-8.md) |
| AC-8.2 | T-08c REPL multi-turn compact/clear/stats request counts and history in Phase 8 |
| AC-8.3 | T-08d packed consumer task edit, MCP, ACP, import and TypeScript declarations in Phase 8 |
| AC-8.4 | T-08e exact Node 22/24 process gates and package test in Phase 8 |
| AC-8.5 | This matrix, full cumulative suite, final hashes and review in Phase 8 |

## Invariants and design contracts

| Contract | Executable check or inspection |
|---|---|
| I-01 | T-01c/T-02e, `npm run test:overhead` |
| I-02 | T-02d/e, T-03a, T-08d built-in schema count |
| I-03 | T-03a, T-05c and T-08c captured messages; `src/llm/prompt.ts` inspection |
| I-04 | T-05c/d stable prefixes and prior history; T-08c REPL turns |
| I-05 | T-03b/c and T-04c/d matching call/result IDs |
| I-06 | T-02a absolute/relative paths, T-04e independent cwd; [tools](tools.md) permission statement |
| I-07 | T-02d registry ordering/approval and T-06b selected MCP exposure |
| I-08 | T-02c, T-03d, T-04c, T-06c, T-07d/e and T-08b real cancellation paths |
| I-09 | T-04e and T-07d session isolation/ownership |
| I-10 | T-01b sanitized config, T-07b pure stdout, T-07 review credential regression, T-08a CLI provider error |
| I-11 | T-05d/e usage/cache category tests; [provider limitations](providers.md) inspection |
| I-12 | Nonzero test counts for all selectors/gates, phase reviews and exact artifact record below |
| D-01 | T-01c/T-02e prompt and outgoing T-03a schemas |
| D-02 | T-01a/b/d profiles/config and T-08a public profile selection |
| D-03 | T-02a/b/d output/approval, T-04d limits, T-06d MCP caps, T-08b TTY/headless approval |
| D-04 | T-02c, T-03d, T-04c, T-06c, T-07d/e, T-08b |
| D-05 | T-03a..e provider/content tests and T-06d MCP image mapping |
| D-06 | T-04a..e agent/state tests; Phase 7 `tool_call` update regression |
| D-07 | T-05a/b, T-07f, T-08c explicit compact paths |
| D-08 | T-05c/d/e, T-06b deterministic schema, T-08c host stats |
| D-09 | T-06a..d and T-07a standard session MCP selection |
| D-10 | T-07a..f plus T-08d installed ACP parent/child |
| D-11 | T-08a..e CLI, package and runtime gates |

## Original scaffold qualification

The full local gate ran on macOS 26.6.2. Node 22.23.3 and 24.21.0 each ran `npm run check` (133/133), `npm run test:overhead` (25 prompt/175 combined reference tokens), and `npm run test:package` (1/1) through the exact executable recorded by `scripts/verify-runtime.mjs`. Both runners recorded source manifest SHA-256 `695198a3731fc751f8959d77afc8efbf6e9795db6140bae427d38736c30db87f`. The host's Node 26.0.0 also passed the same base checks; Node 26 is outside the supported qualification requirement. `npm ci` passed before the final gates. The package test uses an offline install after the lockfile install and resolves its executable/library from a temporary consumer outside the checkout.

Final source and artifact hashes, artifact sizes, and the approved Phase 8 review are recorded in [Phase 8 evidence](evidence/phase-8.md). `package.json` has nine direct runtime dependencies: official provider SDKs, official ACP/MCP SDKs, Ajv/schema formats, JSON parser and WebSocket transport. TypeScript, tsx, tsup and the reference tokenizer are development-only.

The original scaffold tests used mock provider HTTP endpoints and local MCP/ACP peers. They did not claim a live hosted-model response, third-party IDE compatibility, actual cache hit, Linux CI job or Windows run. The workflow configures macOS/Linux Node 22/24 jobs, but no remote workflow run is recorded. Raw uses the host account's permissions without an OS sandbox; remote cancellation cannot reverse a completed external side effect.

## Final configuration redesign qualification

On 2026-09-24, Node 22.23.3 and Node 24.21.0 each ran `scripts/verify-runtime.mjs` against identical source manifest SHA-256 `8d001cdd27480a364ff210d2f879583252a1c60687769ecf2123e281d8efd174`. Each run passed `npm run check` (181/181), `npm run test:overhead` (25 prompt and 175 combined reference tokens, exactly three base tools), and `npm run test:package` (1/1). The package test installed the tarball outside the checkout, ran write and selected MCP tool turns, sent a native JPEG through `view_image`, exercised standard ACP from a parent process, and typechecked the public imports. It did not pass `-y`.

`npm pack` produced `raw-cli-0.1.0.tgz`, 79,098 bytes, SHA-256 `aa5b4899dcf56e46e1649d122f65f1d48580d732981889263333b5aac97f8b10`. Global `raw` resolves to `/opt/homebrew/bin/raw`. Installed `/opt/homebrew/lib/node_modules/raw-cli/dist/raw.js` and the packed build's `dist/raw.js` both have SHA-256 `16a6088db34808cee1b639aaf426af736ed78b1626d5962e6a28fb7e37c643d2`; the installed library and build `dist/index.js` both have SHA-256 `71a02ada5d2c118b5bc98593e94b5906a3b351314b1cd4bb0bd03c47c593b8a2`. The old user config was copied intact to `~/.config/raw/config.json.backup-2026-09-24T12-54-47-112Z` with mode 0600. The new strict `models`/`profiles` config at `~/.config/raw/config.json` also has mode 0600, preserves the local literal key and DeepSeek `api_key_env`, and passes installed `raw config list` without displaying credentials.

An installed-library DeepSeek `deepseek-flash` session used only `read_file` on a temporary probe file, two turns and four requests. Per-request `prompt_cache_hit_tokens` were **128, 256, 384, 384**; `prompt_cache_miss_tokens` were **214, 176, 174, 260**. The total observed cache-read count was 1,152 of 1,976 input tokens. An independent installed `raw` REPL run used two `read_file` calls, four requests, no `-y` and no permission prompt; its `/stats` showed 1,024 cache-read tokens of 1,800 input tokens. These are reported provider counters, so the observed hit claim is grounded in actual usage rather than prefix similarity. The local Vast LLM profile has endpoint `http://127.0.0.1:8080/v1`, model `qwen-3.8` and the preserved user API key; `/v1/models` returned HTTP 503 while the user was starting that server, so local inference was not yet qualified.
