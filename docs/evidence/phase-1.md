# Phase 1 evidence: foundation, profiles, prompt

Status: complete after `gpt-6-astra` implementation review APPROVE. Tested on macOS with local Node 26.0.0 and separately with Node 22.23.3. No paid API call or live model was used.

## Work delivered

- Strict TypeScript/ESM package and pinned SDKs, executable and library build, declaration output, reproducible npm lockfile.
- Named profile JSON config with provider/model/endpoint selection, lazy credential resolution, conflict checks, strict nested schema validation, redaction, immutable resolved settings, and exact default prompt.
- Credential-free `--help`, `--version`, `config init`, and `config list`. Task/REPL/ACP modes remain explicitly unavailable until their owning phases.
- Docs were written before tests and code. Test runner rejects unknown phase selectors and missing mapped suites.

## RED and GREEN record

- First focused RED: `npm run test:phase -- foundation` exited 1. Five cases failed because Phase 1 config/prompt/CLI modules were absent; SDK import fixture passed. This was the greenfield bootstrap failure, not a behavioral oracle.
- Initial implementation GREEN: 12/12 foundation tests passed, but `npm run typecheck` found two strict optional-value errors in `src/config.ts`; fixed before gates.
- Review-driven behavioral RED: six added cases failed against the first implementation: uppercase URL credential leak, same-as-default URL override, compact endpoint default, inherited CLI flag name, mutable config, and invalid config-list acceptance.
- Final focused GREEN: `npm run test:phase -- foundation` exited 0 with 18/18 passing, zero skipped/todo.
- `npm ci` exited 0. `npm run check` exited 0 with strict typecheck, tsup executable/library/declaration build, and 18/18 tests. `npm exec --yes --package=node@22 -- npm run check` exited 0 with the same gates and 18/18 tests under Node 22.23.3. One later `npm run check` was run sequentially after parallel gate commands to ensure the shared `dist/` artifact was rebuilt without a race.
- `git diff --check` exited 0. The default prompt is 25 `o200k_base` tokens against a <=50 budget. The combined prompt/tool-schema <=500 gate belongs to Phase 2 when production tool definitions exist.

## Acceptance map

| AC | Evidence |
|---|---|
| AC-1.1 | `npm ci`, final `npm run check`, Node 22 check; T-01a..e, 18/18 pass |
| AC-1.2 | T-01a..d: precedence, duplicate keys, active/inactive keys, CLI init/list/redaction, exact/empty prompt; 25-token measurement |
| AC-1.3 | T-01e imported and constructed OpenAI, Anthropic, Google SDK clients under Node 22; MCP/ACP SDK import checks; versions and request API choices recorded in `docs/providers.md` |

## Review

`codex-impl-review` with `gpt-6-astra`, working-tree scope, session `.codex-review/sessions/codex-impl-review-20260924-001`. Round 1 returned REVISE with six findings; all six were accepted, fixed in code and documented with behavioral RED/GREEN tests. Round 2 re-read the diff, independently ran `npm run check`, and explicitly returned APPROVE with no open findings. The runner's format detector classifies verdict-only Markdown as `unknown`; the preserved raw verdict says APPROVE and finalize records an explicit override. No finding was disputed. This is review approval of Phase 1 only.

## Code and artifact hashes at final gate

```text
395817116b6afb841228a43e72dfcec7541e32de370e32266d070ef154e2ade1  package.json
0350598e00170486506b3dfc58f0bbc9dd8b736083066e98a6ad01fa9395138f  package-lock.json
2bfe70a9f78c06b9090ed0db0551022ca21895e755d53792df0082fbef3b9b15  src/config.ts
9eb6b7b3454ac77441262df1d4d1884e49a0b89c86ceab32f5ee5d71193178e8  src/llm/prompt.ts
cf9770eb6f74e4d1bbcbcc5ccac63e92a2b3af0d0963b45cb8e7c74445b56512  bin/raw.ts
86f81cc1a2713e5d72f8520dd2165c51e27735ae056ec55e94cf167c4a571259  dist/index.js
602634af3bac206fda72e4f35797dcb74999b24d022cfbf9b81706b19f35abd2  dist/raw.js
```

`dist/` is generated and ignored by Git; Phase 8 will requalify installed artifacts from the final source. Provider streaming, primitive execution, MCP, ACP, compaction and cache behavior remain unqualified until their owning phases.
