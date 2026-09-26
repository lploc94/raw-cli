# Session continuity, Milestone A

Date: 2026-09-26. Source: this repository after phases 1–3; tests used isolated temporary XDG homes and mock providers.

`npm run test:phase -- sessions` passed 130/130. `npm run check` passed 419/419 tests, including packed-consumer, MCP, ACP, vars, conditional Bash policy, UI and persistence suites. `npm run typecheck` and `git diff --check` passed. Final gate results after the Phase 3 refinements are in the implementation plan's progress log.

Direct witnesses cover unreadable schema-2/4/999/unversioned old stores alongside usable new sessions, preserved legacy bytes and scoped missing-ID diagnostics; A→B→B transitions for prompt/model/provider/method/endpoint/request/agent, provider-safe historical replay, same-process imported tool-helper changes, atomic failed transitions, CLI agent/config override and removed-config recovery, SDK runtime changes, and ACP agent/MCP changes. Captured mock requests establish generated-key and serialized-prefix stability after the changed attachment. They do not prove that an upstream provider returns a cache hit.

This is local macOS execution. It does not qualify another platform or a globally installed copy. Package-sharing behavior has a separate Milestone B gate.
