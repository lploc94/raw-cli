# Phase 8 evidence: CLI, package and runtime

Status: implementation, local gates and `gpt-6-astra` review complete on 2026-09-24. Scope: Phase 8 of `build-raw-cli-plan.md`.

## Documentation and RED/GREEN

`docs/cli.md` was written before the CLI implementation. `tests/cli.test.ts` first failed RED because task mode returned the Phase 1 placeholder error. Public subprocess tests now exercise `src/cli.ts` through `bin/raw.ts`; PTY tests use a development-only Python bridge and real terminal signals. One PTY regression failed RED because Ctrl-C during an idle readline question exited 0; aborting the pending question fixed it. Another failed RED because idle PTY EOF was mistaken for Ctrl-C; the close handler now distinguishes the signal path. The tarball test initially found an offline npm cache gap for an unpinned optional `@types/node` resolution; the temp consumer pins the same Node types version as the repo, and the offline package install succeeds after `npm ci`.

Review round 1 reproduced five gaps. Tests first failed for SIGINT during MCP discovery and for the non-TTY REPL waiting after `approval_required`; both now pass. Other regressions verify invalid syntax exits 2 and adjacent REPL lines are queued instead of dropped. `scripts/source-manifest.mjs` hashes the exact source, tests, package lock and build scripts; the Node 22/24 runner rejects a source change during its gates.

## Acceptance evidence

- AC-8.1: `tests/cli.test.ts` runs the public one-shot executable against the official OpenAI SDK mock endpoint. A real write occurs and its result reaches the next inference request; output is streamed once. Profile selection, `--` task delimiter, max-steps/provider/invalid-input exit codes, non-TTY approval refusal, real PTY allow/deny, Ctrl-C active/idle, and EOF active/idle are verified. `tests/repl.test.ts` drives the public REPL.
- AC-8.2: `tests/repl.test.ts` sends three turns, checks `/stats` makes zero requests, `/compact` makes one and keeps a labeled summary plus recent turns, `/clear` makes zero, and a later request excludes old summary/history.
- AC-8.3: `tests/package.test.ts` packs and installs the real artifact in a temp consumer outside the checkout, invokes installed help/version and a task that writes a sentinel, calls a real stdio MCP tool, imports the installed library to spawn an installed ACP child, and typechecks an import against packaged declarations. The test installs from the local npm cache and uses only local provider/protocol fixtures.
- AC-8.4: `scripts/verify-runtime.mjs` checks its own Node major, binds PATH to `process.execPath`, verifies the child major, and runs cumulative check, overhead and package gates with nonzero test counts. Exact Node 22/24 results are recorded below.
- AC-8.5: [Verification matrix](../verification.md) names all 33 ACs, I-01..12, D-01..11, test IDs, qualifications and limits. `scripts/test.mjs` fails if any required phase suite file is missing. The cumulative suite includes the package test.

## Gate record

- `npm ci`: passed on macOS 26.6.2.
- `npm run test:phase -- cli`: 11/11 passed with a fresh build.
- `npm run check`: strict typecheck, tsup build and 133/133 cumulative tests passed on host Node 26.0.0.
- `npm run test:overhead`: default prompt 25, prompt plus three built-ins 175 reference tokens.
- `npm run test:package`: 1/1 installed-consumer test passed.
- `npm exec --yes --package=node@22 -- node scripts/verify-runtime.mjs`: Node and child 22.23.3; cumulative 133/133, overhead 25/175, installed package 1/1; source manifest `695198a3731fc751f8959d77afc8efbf6e9795db6140bae427d38736c30db87f`.
- `npm exec --yes --package=node@24 -- node scripts/verify-runtime.mjs`: Node and child 24.21.0; cumulative 133/133, overhead 25/175, installed package 1/1; same source manifest.

## Tested artifact identity

Parent commit before Phase 8: `ebfc7954ea06f8f5f4738f88881a96dc438478dd`, plus the exact 64-file source/build input manifest in [phase-8-source-manifest.json](phase-8-source-manifest.json), SHA-256 `695198a3731fc751f8959d77afc8efbf6e9795db6140bae427d38736c30db87f`. Both Node runners checked that hash before and after their gates. Local `dist/raw.js`: 132792 bytes, SHA-256 `74ee5928534fc0153b84fdbafacc1b451ea43b75ef706c9175e260a1b107d9f8`; `dist/index.js`: 126717 bytes, SHA-256 `9c711455eb2da37b13fed1bdec014d999aaf7be85d8c62aec1691b056ba815b7`; `dist/index.d.ts`: 13863 bytes, SHA-256 `a17661ebf0b822fbf07c9df625f227a1a38601a3fc8c07b11ab7a3110956a656`. `raw-cli-0.1.0.tgz`: 64484 bytes, five entries, SHA-256 `7dd146dc231e7274cb0d03ed65817d214c87f1fbb4d7a670b5b42d6766825c58`. The tarball contains README and three dist files plus package metadata. Production package has nine direct runtime dependencies.

## Review and limits

`codex-impl-review` with `gpt-6-astra` round 1 found five in-scope gaps; round 2 closed those and found an MCP-config exit-code regression. Round 3 returned explicit `Status: APPROVE` with all six issues closed, no new defects, 42 focused tests and typecheck passing, and source/artifact hashes matching. The runner parsed the verdict-only response as `format: unknown`; the raw review and finalized metadata record APPROVE. Session: `.codex-review/sessions/codex-impl-review-20260924-009`. Only local macOS and local fixture services have run. CI is configured for macOS/Linux Node 22/24 but has not run remotely. No live hosted model, third-party IDE, actual provider cache hit, Windows binary or OS sandbox is claimed.
