# Rewrite Raw's five setup skills from research and execution evidence

## Plan schema
loop-plan/v1

## Target

Research skill-authoring practice, provide a reusable cheatsheet, and rewrite `configure_raw`, `create_skill`, `create_tool`, `create_agent`, and `add_mcp` into accurate, task-directed instructions usable from an installed Raw package. Prove their examples and evaluate real model behavior, including the user's observed how-to session failure.

## Scope

- Research/authoring guide: `docs/skill-authoring.md`, initially drafted during discovery, linked from README and skill docs and included in the package for human readers.
- Rewrite all five source bodies, improve their selection descriptions, and bump their manifest versions to `1.1.0`. Keep IDs/names stable. Regenerate `examples/skills` through the existing build.
- Improve existing example/packaging checks and add a small, explicit local evaluation fixture/runner for the five skills. No new dependency or generic evaluation framework.
- Keep the current Raw manifest, tool, config and session contracts. No resource-loading API, YAML-frontmatter migration, credential-filtering runtime feature, or new tool.
- Do not edit the user's personal config, delete sessions, install globally, publish, push commits, or enable/run GitHub Actions as part of this plan. The existing disabled workflow remains disabled. Phase commits are local.

## Invariants

1. Initial provider context has no skill catalog/body; discovery and loads remain linked tail results. Preserve selection, cache, resume and compaction behavior.
2. All five skills work without the source checkout and fit the default 8192-byte cap; catalog also fits. Preserve substantive schema/type guidance rather than replacing it with generic advice.
3. Explain-only requests do not authorize edits or mandatory smoke tests. Authorized edits proceed without redundant permission requests and preserve unrelated configuration.
4. Config credentials must not be requested in model-visible output. This rewrite teaches safe inspection; it does not claim that free-form tools enforce secret isolation.
5. Examples match current code, including exact tool IDs, model/agent distinction, optional unauthenticated custom endpoints, literal MCP env/header values and canonical-only `sessions`.
6. Offline tests cannot stand in for real-model skill-quality evidence. Live evaluation is explicit, bounded and local; never part of `npm test` or CI.
7. All five `SKILL.md` bodies, manifest descriptions and authored example skill bodies/descriptions are English, per the user's implementation clarification. Evaluation prompts may be multilingual.

## Baseline

- Planning baseline: clean `main` at `744b380`, tracking `origin/main`. No production edits have occurred during discovery.
- CTXE readiness: `/Users/lploc94/projects/raw-cli` is Ready; routing record 48 and focused library evaluation trace record 49. Direct reads confirmed the relevant current source.
- Current Markdown bytes: configure_raw 7877; create_skill 5766; create_tool 6349; create_agent 7633; add_mcp 7259.
- `src/skills/loader.ts:parseManifest/loadSelectedSkills` accepts five exact manifest fields and loads only `SKILL.md`. `SelectedSkill` contains no resource path. `scripts/copy-bundled-skills.mjs` copies exactly two files to dist and examples.
- `tests/bundled-skills.test.ts` and `tests/package.test.ts` contain minimum-length assertions; `tests/setup-skill-examples.test.ts` executes useful examples but identifies fences by numeric order.
- Session review already established correct list/load selection, 16 tool calls, a credential-bearing complete-config read, and incorrect custom-provider-auth advice. No private transcript or credential is needed in the repository.
- Additional source-grounded gaps: `configure_raw` omits OpenRouter's chat default endpoint; generic backup/temporary-copy advice mishandles canonical `sessions`; `config list` checks schema but does not load prompt files or selected plugins.
- Research was completed against official Agent Skills and Claude authoring sources, linked in `docs/skill-authoring.md`. No paid model baseline or test suite was run during planning.

## Design and project patterns

### Authoring and ownership

Use the guide's seven adaptable parts: selection, routing, inputs, procedure, contract/example, verification/recovery, completion report. Keep descriptions focused on user intent. Put the explain/change/diagnose decision before imperative mutation steps. Do not force every skill to duplicate every heading or load `configure_raw` for a basic registration edit.

`src/skills/bundled` stays authoritative. Build-generated `examples/skills` must match. Package the human guide via the existing `package.json.files` allowlist and link it from README/docs; skill bodies must not require that guide's filesystem location at runtime. Retain existing working inline examples, with meaningful labels for extraction. Mark the MCP echo fixture as optional testing material rather than an obligatory step when adding a real server.

### Responsibility of each rewritten skill

| Skill | Required outcome and corrections |
| --- | --- |
| configure_raw | Explain/change/diagnose existing config; full field/type and provider/request coverage; safe targeted reads and edits; endpoint/auth defaults; model alias versus agent choice; canonical candidate validation; check levels and resume implications |
| create_skill | Gather actual tasks and failure examples; write a useful description/body with the cheatsheet's method; strict manifest/root/registration; positive, boundary and near-miss evaluation; exact list/load visibility |
| create_tool | Decide whether a callable action is needed; clear schema/handler/output/side-effect contract; whole-batch semantic preflight; existing standalone ESM example; correct registration/policy and functional checks |
| create_agent | Role/prompt/model/tools/skills/MCP/policy composition; reuse existing model where appropriate; preserve default_agent unless requested; distinguish local dependencies from portable assets; verify a copied agent outside the original path |
| add_mcp | Establish actual server and original tool names; stdio/HTTP config and credential limitations; exact selection; distinguish static validation, catalog discovery and real harmless invocation; no mandatory demo-server detour |

Keep model capability examples as user-supplied placeholders; do not claim current upstream availability from memory. Keep `rm` rules conditional rather than asking for every Bash invocation.

### Evaluation design

Use the existing exported `loadConfig`, `createProvider`, `createRuntimeTools`, `createAgent`, `AgentSession.run`, `transcript` and `stats()` surfaces. A small development runner uses per-case temporary homes/XDG roots/cwd, fake configuration/assets and no persisted production session. Skills from a specified source directory are copied into config-adjacent fixtures; names stay unchanged. All five remain selected so routing is tested against the real competing catalog. Keep prompt, provider settings and tools constant between versions.

Resolve only the selected evaluator model in trusted host code. Real credentials stay in provider memory, never in fixture files, prompts, traces, shell arguments or tool child environments. Sanitize inherited tool environment in the evaluator process. Temporary directories and environment control are not an OS sandbox; no personal paths or production MCP servers are part of the cases. Fake secret markers deliberately remain visible if an unsafe read occurs so grading can detect it. Do not silently redact away a failed behavior.

Store twelve named cases in `tests/fixtures/setup-skill-evals.json`: one how-to and one execution task per skill, plus two realistic near misses. Include the exact reported generic question about adding a model; an unauthenticated custom endpoint; a synthetic credential-bearing config; canonical sessions; preserved unrelated settings; skill/tool registration; portable agent; and the local MCP fixture. Near misses cover ordinary application configuration and an ordinary Markdown checklist, with no Raw setup intent.

Run current and candidate cases once each (24 initial runs total), same selected model/request settings, maximum 12 requests and 120 seconds per case; stop timed-out runs and close sessions/MCP. After a correction, rerun every affected candidate case, including earlier passes, with at most one additional candidate run per case (at most 36 total runs). The runner is explicitly invoked, not an npm test side effect. Capture per-case requests, tool calls, available usage, artifact checks and full model-facing trace; omit reasoning deltas from review artifacts. Report real-model variability and missing usage honestly.

Bind each result to the ordered model-visible catalog hash, per-skill manifest/body hashes, case prompt/fixture hash, evaluator/system-prompt version, and non-secret model/request-settings fingerprint. Record both expected skill dependencies and actual loaded skills. Any catalog description/name/order change invalidates all twelve routing results. A body change invalidates every case expected to use or actually loading that body, including a previously passing how-to or near-miss case. Changes to fixture, prompt, evaluator or model settings invalidate their affected results. Reuse an earlier pass only when all relevant inputs still match the final candidate, with its provenance explicit. Re-run deterministic loading/packaging checks against all final bytes regardless of which live results can be reused. The final report must not aggregate stale passes into AC-11; exhausted retry budget or remaining stale/failing cases leaves live qualification pending without claiming completion or automatically increasing the budget.

For generic how-to fixtures, the expected trace is list/load followed by an answer without Bash/file exploration or mutation. Execution fixtures must produce the requested usable artifact and preserve unrelated data. Near misses must not load a setup skill. Mechanical grading plus human review must distinguish wrong claims, pointless work, and honest unverified behavior. No exact-prose grading or mock-generated success reports.

## Global Gates

- All verification runs locally. `npm run check` is the final repository regression gate; it already builds and includes package tests. Do not rerun package installation suites unnecessarily.
- Focused suites after a build: `node --import tsx --test tests/bundled-skills.test.ts tests/setup-skill-examples.test.ts tests/skill-tools.test.ts`.
- `git diff --check` and inspection that generated assets match source, every body/catalog fits, all examples have tested insertion locations, and new guide links/package paths exist.
- No minimum-length or exact-heading test may be used as proof of skill quality. New tests must exercise examples, observable artifacts or evaluation collection/grading.
- All twelve candidate evaluation cases meet their hard assertions with results valid for the final catalog and relevant body/case/settings hashes; no stale pass counts. Record any limitation instead of claiming universal model reliability. If provider access fails or the fixed retry budget cannot qualify final inputs, mark live qualification pending and do not declare the quality goal complete.

## Plan Review

APPROVE — self-review and independent `codex-plan-review` with `gpt-6-astra` completed 2026-09-26. Round 1 returned one medium sequencing issue about evaluation results becoming stale after corrections; ISSUE-1 was accepted and fixed. Round 2 explicitly returned APPROVE with no issues remaining, confirming input-bound results, reruns of affected earlier passes, and stale-evidence rejection within the unchanged 36-run maximum. Review session: `.codex-review/sessions/codex-plan-review-20260926-001`. The user approved implementation on 2026-09-26.

## Phase 1: Establish the authoring guide and behavioral baseline

Status: complete

### Goal

Make the research actionable and establish a reproducible baseline before changing skill content.

### Current behavior and gap

The current tests establish loading and executable examples, but byte minima do not evaluate selection, efficient task completion or disclosure through tool output. There is no reusable Raw-specific authoring guide or bounded current/candidate comparison.

### Evidence

`tests/bundled-skills.test.ts`, `tests/package.test.ts`, `scripts/overhead.mjs`, `src/agent.ts:AgentOptions/RunEvent/AgentSession`, `src/index.ts`, and research links in the guide.

### Pattern

Follow existing development scripts and Node test fixtures; call exported library APIs without adding runtime options. Retain the repo's deterministic test runner.

### Dependencies

Approved plan and an accessible selected evaluator model. Use the existing configured `raw` agent's model/settings by default, not its personal tool/MCP catalog.

### Files and symbols

`docs/skill-authoring.md`; new `scripts/evaluate-setup-skills.mjs` and its test-facing declarations `scripts/evaluate-setup-skills.d.mts` (following `scripts/overhead.mjs`/`.d.mts`), `tests/setup-skill-evaluation.test.ts`, `tests/fixtures/setup-skill-evals.json`; `docs/evidence/setup-skill-evaluation.md`. The runner documents flags `--variant`, `--skills-root`, `--output`, `--agent`, optional `--config` and `--case`.

### Behavioral contract

Snapshot current source bodies/manifests into a private temporary baseline before rewriting. Each case starts fresh; evaluation captures the actual transcript and artifact changes, never constructs a passing trace. Record the input hashes and expected/observed skill dependencies defined in Evaluation design, so later aggregation rejects stale evidence. A timeout/max-steps/error is recorded as such, not converted to success. No provider traffic occurs during test discovery or `npm test`.

### Documentation

Finalize the guide's sourced recommendations, Raw-specific adaptation and example outline. Document exact local evaluation commands, limits, data handling and interpretation in the evidence file; record the baseline source hash/model identity without credentials.

### Tests first

Use a mock provider solely to prove runner mechanics: separate cases, error/timeout reporting, detection of a synthetic key in a tool result, a missing requested artifact and an unintended unrelated config edit. Ensure fake success text does not override failing artifacts. Test provider credentials absent from serialized reports and fixture/config/tool environment while sentinel leakage remains detectable. Test that a catalog change invalidates all routing passes, a body change invalidates expected/observed dependent cases (including earlier passes), unchanged relevant inputs permit provenance-preserving reuse, and exhausted retry budget cannot yield a qualified aggregate with stale results.

### Anti-shortcut coverage

Do not label mocks as live evaluation. Do not grade solely by final answer or presence of a heading. Establish real baseline before changing the five bodies.

### Implementation obligations

Implement only the small fixed-case runner and fixtures; no LLM judge service, dependencies, benchmark platform or production API change. Close resources on success and failure. Keep detailed disposable traces outside tracked files; commit sanitized aggregate evidence.

### Acceptance criteria

- [x] AC-1: The guide distinguishes researched advice from Raw contract decisions and explains all recommended parts — document inspection.
- [x] AC-2: Twelve realistic cases cover five how-to, five execution and two near-miss requests with observable assertions — fixture review.
- [x] AC-3: Runner detects leaks, wrong artifacts, incomplete runs and stale result aggregation without exposing real credentials — deterministic runner tests.
- [x] AC-4: A baseline report records actual model outputs, calls and results before rewriting — live report and source hashes.

### Focused verification

`node --import tsx --test tests/setup-skill-evaluation.test.ts`

`node --import tsx scripts/evaluate-setup-skills.mjs --variant baseline --agent raw --skills-root src/skills/bundled --output /tmp/raw-setup-skills-baseline`

Expected: runner tests pass; baseline completes or records explicit per-case failures without hiding them.

### Phase gates

`npm run typecheck`

`git diff --check`

### Review

Implementation review is required; verdict must be APPROVE.

### Commit

`test: establish setup skill authoring and evaluation baseline`

## Phase 2: Rewrite configuration and skill creation guidance

Status: in_progress

### Goal

Fix the reported configuration workflow and make `create_skill` teach the researched authoring method.

### Current behavior and gap

`configure_raw` opens with an unconditional file read and mutation sequence, misses endpoint/auth detail, and suggests an invalid staging path for configs containing sessions. `create_skill` covers packaging more thoroughly than writing and evaluating effective instructions.

### Evidence

Both source skill folders; `src/config.ts:parseConfigDocument/defaultEndpoint/resolveKey`; `bin/raw.ts` config-list branch; `src/skills/loader.ts`; `tests/setup-skill-examples.test.ts`.

### Pattern

Use self-contained descriptions/bodies, the real config/skill loaders and the current build-copy pipeline. Examples remain executable text rather than duplicates reconstructed only in tests.

### Dependencies

Phase 1 baseline and guide.

### Files and symbols

`src/skills/bundled/{configure_raw,create_skill}/{SKILL.md,skill.json}`; corresponding generated examples; `tests/bundled-skills.test.ts`, `tests/setup-skill-examples.test.ts`; evidence report.

### Behavioral contract

Preserve complete config field/type/request guidance within the cap. Include accurate matching provider/method endpoints, key defaults and unauthenticated custom endpoints. Agent selection never masquerades as a direct model override. Safe reads must exclude secret values before tool output; targeted editing must preserve them locally. Canonical candidate validation retains sessions data. Explain static schema checks separately from prompt/asset/runtime checks.

`create_skill` teaches coherent scope, selection description, inputs, procedures, examples, verification, output expectations and near-miss evaluation, then registration. Its worked skill must demonstrate those principles and remain usable when copied to a config-local root.

### Documentation

Use the guide's terminology. Clearly label complete documents versus fragments. Describe authorization/input decisions without mandatory redundant approval. Document common failure recovery without requiring repo exploration.

### Tests first

Extend executable examples with a synthetic secret-bearing existing config, retained unrelated values and canonical sessions. Verify taught safe-inspection/edit example output omits sentinel values and invalid candidate handling leaves the original intact. Validate custom endpoint without a key, alias assignment, and a newly created skill's actual manifest/list/load behavior. Replace fragile fence-order selection with explicit example labels where needed.

### Anti-shortcut coverage

A rewrite that merely says 'never display secrets', drops schema detail to fit, or passes only keyword/length checks fails review. A temporary alternate config that drops `sessions` to pass validation also fails. General how-to must not run repository discovery or nested model tests.

### Implementation obligations

Rewrite both bodies/descriptions, bump versions to `1.1.0`, preserve identities and meaningful existing loader tests, and regenerate examples. Remove the corresponding artificial byte minima, retaining nonempty/content-integrity/cap checks.

### Acceptance criteria

- [ ] AC-5: Both descriptions/bodies satisfy the authoring guide and existing schema coverage under 8192 bytes — source/loader inspection.
- [ ] AC-6: Safe example preserves unrelated config and credentials, validates canonical sessions, and emits no sentinel — executable examples.
- [ ] AC-7: New skill example can be registered, listed and loaded and teaches evaluation beyond file format — loader tests and review.
- [ ] AC-8: A walkthrough against the fixed how-to/effectful cases finds unambiguous routing, correct model-auth advice and no instruction to expose complete config — implementation review; final model behavior is gated by AC-11.

### Focused verification

`npm run build`

`node --import tsx --test tests/bundled-skills.test.ts tests/setup-skill-examples.test.ts tests/skill-tools.test.ts`

Expected: all focused tests pass with rewritten source/extracted examples. Defer candidate live runs until the complete five-skill catalog is final in Phase 3, so description changes do not invalidate intermediate comparisons or spend extra provider calls.

### Phase gates

`npm run typecheck`

`git diff --check`

### Review

Implementation review is required; verdict must be APPROVE.

### Commit

`docs: rewrite Raw configuration and skill authoring instructions`

## Phase 3: Rewrite tool, agent and MCP guidance and qualify the kit

### Goal

Complete all five skills and demonstrate usable installed artifacts plus improved model behavior.

### Current behavior and gap

The remaining skills contain useful examples but mix reference, procedure and testing without routing by user intent. Some instructions rely on checkout knowledge. Package tests still use arbitrary body length as a quality signal.

### Evidence

Three source skill folders; `tests/setup-skill-examples.test.ts`, `tests/package.test.ts`, `tests/package-agent.test.ts`, `package.json.files`, `scripts/copy-bundled-skills.mjs`, `docs/skills.md`, README.

### Pattern

Preserve existing whole-batch plugin checks, portable-agent fixtures and MCP test server; improve task-directed instructions and executable example selection. Use installed-package tests outside checkout.

### Dependencies

Phases 1 and 2.

### Files and symbols

`src/skills/bundled/{create_tool,create_agent,add_mcp}/{SKILL.md,skill.json}`; generated examples; existing example/package tests; `docs/skills.md`, `docs/skill-authoring.md`, `README.md`, `package.json`; final evaluation evidence.

### Behavioral contract

Retain a real schema/ESM handler example and semantic batch preflight. Agent creation produces the requested role and selected capabilities without changing unrelated agents/defaults. MCP setup discovers actual original tool names and verifies the configured server, not a substitute demo; demo material is explicitly optional. No API promises for wildcard selection, header interpolation or absolute portable paths.

All five final bodies are self-contained, selected-only, tail-loaded and versioned. The human guide ships and is discoverable through README, but runtime skills do not require it. The installed kit must work without repository docs or tests being present.

### Documentation

Link the guide in README and `docs/skills.md`, remove its draft status after implementation, and record baseline/candidate model settings, input hashes, outcomes, tool counts, available usage and limitations in the evidence report. Identify any reused results and why their relevant inputs still match the final candidate. Record unresolved failures or stale evidence honestly.

### Tests first

Retain functional example tests for invalid later batch rows before side effects, successful tool invocation, copied agent prompt/assets and selected-only MCP startup/call. Add necessary boundary assertions for preservation/default handling and literal MCP credentials. Update packed checks to confirm source/generated equality, exact bodies and the shipped guide; remove remaining byte minima. Do not add tests asserting all prose headings.

### Anti-shortcut coverage

Reject rewritten prose whose examples no longer execute, example-only success while installed assets are missing, blanket Bash approval, invented MCP names, replacing the requested server with echo, or mock traces presented as model-quality proof.

### Implementation obligations

Rewrite the remaining descriptions/bodies, set versions `1.1.0`, regenerate examples, package the guide with the explicit existing files allowlist, and finish local qualification. Do not change runtime behavior or re-enable Actions to make verification easier.

### Acceptance criteria

- [ ] AC-9: Three remaining skills follow routing/contract/verification requirements and preserve their working examples — review and functional tests.
- [ ] AC-10: All five final installed skill bodies and generated copies match, fit caps and work outside checkout; guide is packaged — package tests.
- [ ] AC-11: All twelve candidate real-model cases pass hard outcome/disclosure/scope assertions with non-stale evidence for the final catalog and relevant body/case/settings hashes; quality and usage comparison records provenance — final evaluation report and stale-result checks.
- [ ] AC-12: Local regression suite and diff checks pass; no unrelated config/runtime/CI change — test output and final diff review.

### Focused verification

`npm run build`

`node --import tsx --test tests/bundled-skills.test.ts tests/setup-skill-examples.test.ts tests/skill-tools.test.ts tests/setup-skill-evaluation.test.ts`

`node --import tsx scripts/evaluate-setup-skills.mjs --variant candidate --agent raw --skills-root src/skills/bundled --output /tmp/raw-setup-skills-candidate`

Expected: deterministic checks pass and live report supplies real evidence for each candidate case; compare against Phase 1 baseline, then correct evidenced failures and rerun all affected cases (including earlier passes) within the stated retry bound. If a correction leaves any final-input case unqualified after the budget is spent, report live qualification pending instead of combining stale passes.

### Phase gates

`npm run check`

`git diff --check`

### Review

Implementation review is required; verdict must be APPROVE.

### Commit

`docs: complete and qualify the rewritten Raw setup skill kit`

## Completion Criteria

- [ ] Research-backed authoring cheatsheet is finalized, linked and shipped.
- [ ] All five skills and descriptions are rewritten, versioned and synchronized with examples.
- [ ] Exact Raw schema/registration/runtime boundaries are preserved and correctly taught.
- [ ] Reported how-to disclosure/over-exploration failure is covered with fake credentials and evaluated against the final kit.
- [ ] Functional, installed-package and local repository checks pass.
- [ ] Real-model evidence distinguishes quality improvements from deterministic wiring tests, qualifies the final relevant inputs rather than mixed stale revisions, and acknowledges limitations.
- [ ] All phase reviews are APPROVE and cohesive local commits exist; user config and GitHub Actions remain untouched.

## Progress Log

- 2026-09-26: Discovery and official-source research complete; cheatsheet draft and this plan written. Self-review APPROVE. Waiting for user approval before Phase 1 implementation; no production skill edits or live evaluator runs yet.
- 2026-09-26: Independent gpt-6-astra plan review round 1: one medium sequencing issue, ACCEPT. Added input hashes, dependency-aware invalidation including earlier passing cases, stale-aggregate rejection and pending qualification when the existing retry budget is exhausted. Sent revised plan for re-verification; no scope or budget expansion.
- 2026-09-26: Independent gpt-6-astra round 2: APPROVE, no remaining issues. Plan-only review complete; no implementation, live evaluations, user-config edits or CI actions performed.

- 2026-09-26: User approved implementation. Phase 1 in_progress; following loop-implement, with local verification and CI disabled.

- 2026-09-26: User clarified that skill bodies and descriptions must be English. Applied as invariant 7 and a final content-review requirement.

- 2026-09-26: Phase 1 complete, self-review APPROVE. Seven runner tests/typecheck/diff checks pass. Baseline: 12 live runs, 88 requests, 95 tool calls; raw mechanical 2/12, human-adjudicated 3/12 after documented interpreter-cache false positive. Snapshot/traces retained privately; nine synthetic-disclosure traces and three max-step runs confirm the target gaps. Phase 2 in_progress.
