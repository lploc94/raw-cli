# Keep sessions usable across changes, then add portable Raw packages

## Plan schema
loop-plan/v1

## Target

Let users continue working after changing their agent, prompt, tools, skills, model, variables, or installed packages. Unrelated old session data must never prevent creation of a new session. A real change may invalidate a reusable request prefix; once the change has been applied, subsequent unchanged turns and resumes must be stable again. Build portable agent/component packages only after this session behavior is qualified.

This plan supersedes the earlier suggestion that resuming a session must use its originally pinned package versions. Installation locks describe installed artifacts; saved session metadata describes history and detects changes. Neither is a requirement to restore an obsolete runtime just to continue a conversation.

## Scope

- Milestone A, phases 1–3: storage format isolation, resumable runtime changes, deterministic cache generations, provider-safe historical replay, and consistent CLI/library/ACP behavior.
- Milestone B, phases 4–8: a manifest-based package format for agents, prompts, skills, tools, vars, executable var providers, and MCP definitions; inspect/validate/export/pack/install/update/remove/link/fork; local agent bindings and component selection; documentation and five shipped setup skills.
- Initial distribution is a local folder or a `.rawpkg` ZIP archive, including archives downloaded by users from GitHub releases. An explicit dependency graph and source identity leave room for GitHub/catalog transports later.
- Out of scope: a hosted marketplace, accounts, ratings, signing infrastructure, automatic Git fetching, remote registry clients, a SemVer range solver, installing npm/pip/system dependencies on recipients' behalf, arbitrary install hooks, and mid-inference hot reload.
- No converter for unreleased session schemas 2–4, no legacy profile support, and no broad backward-compatibility layer. Existing readable schema-5 sessions must remain usable. Preserve unreadable legacy stores without making them a prerequisite for ordinary work.
- This turn creates the plan only. Implementation, global installation, personal config changes, and pushing require the subsequent implementation instruction; none are performed by this plan.

## Invariants

1. A new conversation does not depend on decoding or upgrading unrelated historical conversations.
2. A configuration/package/release version change alone is not a session incompatibility. No configuration edit increments the database storage format.
3. Current explicit configuration wins at attach/resume. Saved configuration and agent identity supply defaults, not equality constraints. Saved cwd remains the default workspace; this plan does not silently move a session between projects.
4. Current explicit tool/skill references must resolve. Historical references to removed or denied tools are history, not startup requirements. Do not silently omit a currently requested component to pretend a broken configuration works.
5. Resume never reexecutes historical or interrupted calls. Keep ownership fencing, recovery linkage, expiry, durable-before-dispatch, cancellation, and storage failure handling.
6. An unchanged effective request prefix and replay environment preserves Raw's generated cache key and serialized prefix. Ordinary message appends and deliberate compaction retain their existing semantics. Provider cache hits themselves are not guaranteed.
7. A changed runtime commits its new baseline atomically once. A failed transition leaves the prior baseline intact; retry cannot duplicate notices or repeatedly rotate the cache key.
8. Raw stores canonical conversation content. Historical replay adaptations must retain the original tool arguments/results, image payloads and opaque provider data in storage, even when a new provider cannot consume them.
9. Package release versions identify artifacts. Package format, tool/provider host contracts, database layout, session context revision, and model request fingerprints are distinct concepts. No exact Raw release-version equality checks.
10. Inspect, validate, export, pack, install and agent binding never import plugin handlers, execute providers, start MCP, invoke a model, or open the session store.
11. Only components explicitly selected by the effective agent are loaded. Installing a package does not grant its components to every agent or change `default_agent`.
12. Package inputs/local bindings remain separate from runtime variable readings. Export never resolves env/file/provider values merely because a variable is selected.
13. Authoring docs, schemas, skill descriptions and skill bodies are English. Preserve the selected Bash `rm` argument-pattern approval behavior; no blanket Bash prompts.

## Baseline

- Workspace: `/Users/lploc94/projects/raw-cli`; clean `main` at `5cd36df`, equal to `origin/main` when planning began.
- Latest implementation is runtime vars/providers; no package manager/import/export exists. Installed Raw and personal config were already updated in the prior task.
- Prior full verification on the same application source: `npm run check`, 395/395 passing; evidence `/tmp/raw-vars-final-check.log`. Planning inspected its terminal summary. Do not repeat an unchanged historical baseline merely to fill a checklist; execute the gates after implementation changes.
- CTXE: Ready, fresh, 216 indexed files. Routing record 57 and focused trace record 58 cover this request. The connector transport is closed; retrieval uses an owned temporary `ctxe mcp` stdio process through `/tmp/raw-vars-ctxe-call.py`, not a daemon. Direct source reads followed returned file/symbol routes and verified the decisive production branches. The Ask reported four missing indexed excerpt bodies; it did not block diagnosis, and no claim depends solely on those missing excerpts.
- `src/sessions/schema.ts: initializeSessionSchema` rejects every nonzero `PRAGMA user_version` other than 5. `bin/raw.ts: run` opens the global store before an ordinary new task. `tests/session-store.test.ts` currently asserts global refusal on version 999.
- `src/sessions/store.ts: initializeAgent` already transitions changed tool definitions/source and skills, but rejects changed agent/model/provider/method/endpoint/system/request/cache/runtime limits. `bin/raw.ts` also rejects explicit different `--agent` and `--config`.
- `src/agent.ts` restores saved ACP selections and rejects missing non-ephemeral names. `src/acp/methods.ts: startSession` checks old config/agent equality and activates saved MCP aliases before reconciling them.
- Provider adapters reuse opaque response blocks with different wire formats (`src/llm/openai.ts`, `responses.ts`, `anthropic.ts`, `google.ts`). Removing identity checks without replay handling would send foreign reasoning/signatures or incompatible calls to another API.
- Tools and skills resolve `builtin/local/agent` roots; skill loading requires `skill.json` and `SKILL.md`. Vars/providers resolve from the config directory. `examples/agents/project-helper` is a working copied-directory example, not an installable package.

## Design and project patterns

### A. Storage formats and session compatibility

Keep the current SQLite persistence, leases, transaction and payload machinery. Do not replace it with another database or an event-sourcing framework.

- Treat format 5 as the current physical storage family. Keep using the existing `$XDG_STATE_HOME/raw/sessions.sqlite` when it is empty/new or readable format 5, so existing current sessions remain accessible without conversion.
- If that legacy location contains an unsupported format or an unrelated unversioned database, leave it untouched and open a deterministic isolated family directory, `$XDG_STATE_HOME/raw/stores/storage-v5/sessions.sqlite`. Its `payloads/`, WAL and maintenance ownership are local to that directory. Once the family store exists, select it consistently on every open. A real future incompatible storage family uses a different directory; an application release does not.
- Probe before schema initialization or writes to the legacy database. Never relabel a foreign `user_version`, delete the store, move a live WAL, or catch arbitrary I/O/permission/SQLITE_BUSY errors as if they were format mismatches.
- New/list operations use the active readable family. A request for an unavailable old ID reports a scoped diagnostic with the preserved legacy path when applicable, rather than preventing other sessions. No automatic parsing or migration of schema-2/3/4 payloads.
- A malformed row or optional display payload affects that row/session, not opening the store or creating another session. Display format changes use event-specific readers/defaults rather than bumping the whole database.
- Add fields with defaults to host JSON records when needed. Keep existing columns and their meanings. A small additive `session_runtime_metadata(session_id PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, payload_json TEXT NOT NULL)` table, created idempotently like the existing `staged_payloads` table, stores base-selection provenance and transition fingerprints. No large payloads or secrets go in this table. Missing metadata on an existing format-5 row is initialized from supported saved fields plus current intent; no legacy database conversion framework or storage-version increment is required.

### B. Runtime changes become a committed transition

Extract a pure comparison/transition contract from `SessionStore.initializeAgent`, shared by initial attach, resume and ACP tool-view changes. Preserve the existing generated cache-key behavior for unchanged sessions.

| Change | Required behavior |
| --- | --- |
| Same effective runtime | Restore identical context/key; no new notice, revision or metadata churn. |
| Tool add/remove/reorder/name/schema/description | Use current selected definitions; advance generation once; rotate generated key; adapt historical structured tool replay when needed. |
| Selected executable source/helper bytes | Detect source change, use new code and rotate generated key once; do not replay past side effects. |
| Skill add/remove/description/body | Use current catalog/body; retain tail-only loading; one stale-information notice only if earlier visible list/load results became stale. No mandatory prefix rewrite. |
| Prompt/model/provider/method/endpoint/request/cache options | Use new configuration and commit a new baseline; rotate generated key once. Project incompatible historical provider/tool material for the new replay environment. |
| Agent name/config path/package release label only | Update provenance/defaults; do not rotate if effective prefix/code/replay inputs are unchanged. |
| Rules, execution limits or UI only | Apply current behavior; change the tool prefix only if exposure changes. No refusal and no unrelated key rotation. |
| Var definitions/readings/bindings | Current resolver with an empty runtime TTL cache on resume; prior results are historical. Values are never hashed into the static model prefix. |

Fingerprint normalized effective inputs, preserving explicitly ordered selection arrays and normalizing irrelevant object-key ordering. Exclude credentials, install paths, mtimes, release labels and unrelated package files. Canonicalize owned manifests before hashing: informational `version` fields must not sneak back into the behavioral digest through raw `tool.json` bytes or `snapshotSkills`. Code/helper bytes and effective schema/description/name remain behaviorally relevant. Keep explicit user-supplied cache-key precedence; generated-key rotation does not override it. Endpoint change detection may hash the actual resolved endpoint privately, but never store credentials or emit them in transition notices.

Canonical messages may gain an optional host-owned replay annotation. On an incompatible replay-environment change, retain original fields and mark the old prefix for a deterministic historical-text projection. A common request builder projects this prefix before token estimation and provider serialization:

- Preserve user and visible assistant text in order.
- Represent past tool calls and their outcomes as labeled historical text, including call IDs/names/arguments and result text; these are not requests to run tools again.
- Do not forward foreign opaque reasoning/signatures/encrypted items. Retain them in canonical storage.
- Preserve image bytes in storage; when an old image cannot be replayed, use an explicit textual historical attachment marker. Do not claim that the new model saw the image.
- New messages after the transition use native replay. An unchanged subsequent resume uses exactly the same projection, not a new lossy rewrite or new notice.
- Trigger portable replay for a changed provider/method/model/endpoint or incompatible request mode, and for a changed tool catalog where historical calls could refer to unavailable/changed schemas. Code-only changes need no projection. A prompt-only change need not discard otherwise valid opaque blocks.

Reuse `recoverInterruptedCallsInTransaction`, `validateStoredAgentState`, payload staging and atomic context replacement. Recover incomplete tool/result pairs before transition notices. Retain one bounded, host-generated transition event for UI/history; no timestamps or random metadata are inserted into the model prefix. Reset provider-dependent token calibration on replay-environment change and retain accumulated usage as historical usage.

For existing config-adjacent/global local tools, Phase 2 must also snapshot the selected tool directory's regular-file closure at attachment. Hash all owned file paths, bytes and relevant modes in deterministic order, excluding generated snapshot directories. Import the entry and its relative in-directory helpers from that immutable content-addressed snapshot, so Node's module cache cannot serve a previous helper version in a long-lived SDK/ACP process. Keep the snapshot under the tool root's containing directory to preserve normal ancestor lookup for declared external/bare dependencies; a tool cannot claim a relative helper outside its selected owned directory as part of this closure. Fail clearly if a selected owned file is unavailable, unreadable or escapes via a link. Phase 6 reuses this mechanism for linked packages and extends its owned root to the declared package file graph. Existing builtin tools are release-owned and need no writable snapshot; a new installed Raw release starts a new process.

CLI selection precedence on resume: explicit `--config` / `--agent` / `--system-prompt` overrides; otherwise saved config path and saved agent; then ordinary default selection only where no saved choice exists. If a saved file or agent has been removed, report that concrete missing resource with the usable override command. Do not silently choose an unrelated default. Persist successful overrides so the next plain `--resume ID` uses the new choices.

ACP uses the server's current runtime at attach. If the current base selection changed, it replaces the old selection. If it did not change, preserve an explicit ACP tool-view override while dropping historical entries no longer available/permitted and ephemeral callbacks that no longer exist. Distinguish base selection from an explicit override in durable metadata, not by guessing from the last exposed list. A pre-refactor format-5 row has no base-selection provenance: on its first new attach, use current configuration, record that baseline once, and preserve all history. A changed explicit current selection containing a typo still errors. Library callers' supplied runtime/selection wins; an omitted library selection can restore the available portion of the saved view.

### C. Package contract and component identity

Use a directory plus `raw-package.json`, published as a ZIP with suffix `.rawpkg`. The manifest has JSON Schema and the following bounded contract:

- Required: `schema_version: 1`, scoped `name` (`@owner/name`), SemVer `version`, nonempty `description`, explicit `files` and `exports`.
- Optional: `license`, `repository`, `keywords`, `inputs`, `requires`, `dependencies`, `metadata`.
- `exports` maps categories `agents`, `skills`, `tools`, `vars`, `var_providers`, `mcp` to named paths. Prompts/assets travel as referenced package-owned files. Each var/provider/MCP export file contains one definition, not an ambiguous map of exports.
- `files` is an explicit list of relative files/directories, with deterministic recursive expansion and deduplication; no ignore/glob language in v1. Exports and their referenced owned assets must be covered. All archive paths stay inside the package; no symlinks/hardlinks or special files in v1.
- `requires` declares supported host API/capability IDs and executable runtime/platform prerequisites. Raw application version metadata is advisory; reject an actually missing required contract/capability, not a different release number. Unsupported unused installed components do not block an unrelated selected agent.
- Dependencies are explicit aliases to exact `{name, version, digest, archive}` artifacts. `archive` is package-relative and included in the distributable closure. No network or range solving in v1; permit side-by-side versions in the artifact store and resolve dependency aliases in the owning package's graph. Reject cycles and missing/mismatched artifacts before commit.
- Manifest/package version is not folded into a component's behavioral fingerprint if the selected content is identical. A requested different artifact version can be installed without asking sessions to migrate.

References in package definitions are `#<kind>/<export>` for their own exports and `dep:<dependency-alias>#<kind>/<export>` for declared dependencies. Local config uses `pkg/<install-alias>/<kind>/<export>`. Internal resolution retains source origin, artifact digest, dependency owner and export identity; the short install alias is a user-controlled handle, not proof of publisher identity.

Tool/skill selection supports existing string references and an explicit `{ref, as}` selection for naming collisions. Resolve references before loading. Model-facing aliases obey existing tool-name constraints, are independent of install paths/digests, and remain stable until explicitly changed. Rules match canonical identities, not accidental model aliases. Preserve ordered selections and conditional `when` predicates.

Keep builtin/local/config-adjacent assets as first-class sources behind a common component resolver, rather than scattering `pkg/` string handling across loaders. Existing tool handler and executable var-provider protocols remain unchanged. Package ownership supplies roots for code/assets; a user-provided filesystem input resolves relative to the recipient config directory, never the publisher's cwd.

For skill portability, adopt the Agent Skills `SKILL.md` frontmatter as the authoritative name/description. Keep `scripts/`, `references/` and `assets/` with the skill. Remove Raw's required `skill.json` from shipped/local/package skill authoring rather than maintaining two metadata authorities. Package release metadata lives in the package; standalone optional skill version metadata is informational, not a compatibility gate. Keep Raw's existing explicit list/load tools and tail-only disclosure behavior. Preserve the five existing builtin selection IDs via explicit builtin export mappings; portable directory/frontmatter names can use the standard kebab-case names without forcing every agent config to rename those builtin references. Export ID, skill name and owned path are distinct documented fields. Scope support clearly: the portable file layout does not make arbitrary host-specific instructions interoperable.

### D. Inputs and local agent bindings

Package `inputs` uses an object JSON Schema (the project's AJV validator). Optional `x-raw-kind` marks `file`, `directory`, `env-name` or `var-source` inputs; ordinary fields use JSON types/defaults/enums. Required inputs are validated at activation, while an unconfigured package may still be installed/inspected. Validate only inputs referenced by the selected export closure: a weather provider's API input must not prevent using a pure skill in the same package. Restrict the supported input schema to per-property constraints, defaults and a required-name list; do not accept cross-property schema conditions whose meaning changes after projection. Dependency-owned inputs are supplied through a dependency reference's explicit `inputs` map, evaluated in its caller's input scope; they never read another package's values by name implicitly. Selection objects therefore accept `{ref, as?, inputs?}`; input maps are not runtime var readings.

Only designated definition value sites accept a whole-value `{"$input":"name"}` reference. These sites are documented in the package schema: var sources/params, provider argument/cwd entries, MCP endpoint/env/header/argument entries and explicit agent settings. Do not template arbitrary strings, JavaScript, shell command text or Markdown. A var-source binding is a structured current Raw variable source, not its resolved value. An env-name binding refers to a recipient environment name; read it only at the runtime binding site that explicitly consumes it. Never implicitly interpolate runtime vars throughout MCP config.

An installed-agent entry in ordinary config is:

```json
{
  "agents": {
    "researcher": {
      "from": "pkg/research-kit/agents/researcher",
      "model": "deepseek",
      "inputs": { "location": "Hanoi" },
      "overrides": { "max_steps": 30 }
    }
  }
}
```

Package agent definitions reuse current agent behavior fields but leave the model alias as a recipient binding. A package may document a model recommendation/required capabilities. Revalidate provider-specific request options after binding; do not silently discard invalid options.

Overrides use a documented allowlist of ordinary agent fields. Scalars replace. `tools`, `skills`, `vars`, `request`, `compact` and rules replace their complete corresponding block/list; absent blocks inherit. No recursive magic merge or implicit union. To add one tool, edit the effective list explicitly (authoring skills show how). A local direct agent can select a package tool/skill using references, and root vars/providers/MCP entries may use `{from, inputs}` component bindings. Installing a skill alone must not require installing an agent.

### E. Artifact lifecycle and export

- Per-config installation index/lock is `<config-path>.packages.lock.json`; it owns install aliases, source provenance, exact root/dependency digests and development links. It is separate from model credentials and agent input values. Artifact store is `$XDG_DATA_HOME/raw/packages/sha256/<digest>/` (default `~/.local/share/raw/...`).
- One command mutates one logical authority: install/update/link/remove commit only the lock; agent-add commits only the config. Publish staged immutable artifact directories before atomically committing the index. Unreferenced staged artifacts are harmless and can be cleaned later. Serialize concurrent mutations with an owned lock and re-read before commit.
- `package install PATH [--as ALIAS]`: copy/verify a directory or unpack/verify an archive into the immutable store and register it. Idempotent for the same artifact; name collisions require an explicit alias/update operation. Installation alone does not require model credentials or package input values.
- `package update ALIAS --from PATH`: validate the new graph and affected effective agent bindings first, then switch the index atomically. Keep existing local inputs/overrides and old artifacts. Sessions adopt the current version on their next attach; running agents retain their captured runtime. If required inputs changed incompatibly, report the exact missing/invalid inputs. The user may install the artifact under a second alias and edit `from` plus inputs together in the agent config; this avoids a multi-file transaction or an unusable intermediate installation. Such real input incompatibility is distinct from a release-version difference.
- `package remove ALIAS`: remove a registered alias when not referenced; return exact dependent agent/package references otherwise. Do not delete those agents or an active process's files implicitly.
- `package link DIR [--as ALIAS]`: development source, snapshotted at runtime creation. Changes affect the next run/resume. Immutable runtime snapshots prevent a helper imported later from changing mid-turn.
- `package fork ALIAS --out DIR`: export editable source without mutating the installed artifact. A fork may then be linked or packed.
- `package export --agent NAME --out DIR`: construct an editable package from the selected effective agent and the declared transitive asset graph. Preserve policy and order; remove the sender's model alias in favor of a recipient binding. Builtins remain builtin references. Use declared tool/skill/provider roots/files; report unresolved external dependencies rather than guessing arbitrary script imports.
- Export literals and file contents only when explicitly authored as package assets or selected through an export include/binding choice. Config-local external paths, env bindings and private endpoints become typed input requirements. Never resolve a var/provider to turn a reading into a default. Produce a machine-readable report of included components, inputs, prerequisites and unresolved assets. A draft may have required inputs; a distributable must have a complete owned file/dependency closure.
- `package validate DIR|ARCHIVE` validates data, paths, graph and contracts without executing code. `package inspect` reports components, inputs and prerequisites. `package pack DIR --out FILE` writes a reproducible archive with sorted paths, normalized timestamps and an integrity inventory. Identical input bytes/modes produce identical output. Preserve executable mode as declared data and apply it on extraction.
- Bound archive count, total expanded bytes, nesting and per-file sizes; reject traversal, duplicate/conflicting paths, absolute paths, links and digest mismatches. Limits are explicit configurable host packaging limits, not hidden limitations on skill/tool functionality. Do not introduce a custom compression implementation; use a maintained ZIP implementation with pinned dependency/lockfile and bounded extraction APIs.
- `agent add NAME --from REF --model ALIAS [--inputs FILE]` validates and atomically adds the local binding. Existing names are not silently overwritten. `package list` and existing config listing show provenance/effective selection without resolving runtime values.

### F. Research basis

Patterns were researched in the preceding turn using official documentation, not treated as a universal agent-package standard:

- Claude plugin manifests and catalogs: https://code.claude.com/docs/en/plugins-reference and https://code.claude.com/docs/en/plugin-marketplaces
- Portable skills: https://agentskills.io/specification
- MCP bundles and user configuration: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- Metadata registry separated from code hosting: https://modelcontextprotocol.io/registry/about
- Installation locks: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/
- Package versus instance values/schema: https://helm.sh/docs/topics/charts/

## Global Gates

- Every phase: docs/contracts before production edits, red behavioral tests before implementation, focused verification, `npm run typecheck`, `git diff --check`, implementation self-review APPROVE, then its cohesive commit. Do not spawn review agents unless separately requested.
- Use isolated temporary XDG config/state/data homes in all test runners, including packed-consumer tests. No personal session deletion/config edits, paid provider calls, or GitHub Actions.
- Extend `scripts/test-phase.mjs` with `sessions` and later `sharing` selectors; they build first and run the specified suites in isolated homes. Keep automatic test discovery in `scripts/test.mjs` and add required new suites to its guard.
- Milestone A is a hard dependency gate: `npm run check` must pass after phase 3 before package implementation starts.
- Final: `npm run check`, `npm run test:package`, and `git diff --check`; the package test command must include the new installed sharing witness rather than only the old npm package tests.
- Provider assertions inspect deterministic mock HTTP requests for all four methods. Report serialized-prefix/key stability separately from provider-side cache usage. Existing cancellation, leases, payload reclamation, MCP, ACP, UI, vars and conditional Bash policy regressions must pass.
- Do not preserve tests asserting obsolete refusal behavior merely to keep the suite green; replace them with explicit transition/isolation assertions. Do not weaken corruption/ownership checks or swallow invalid current configuration errors.

## Plan Review

Status: APPROVE (plan self-review, 2026-09-26).

- Intent fidelity: session usability is the first milestone and its full regression gate precedes all package work. No force-resume/accept-cache-loss gate, original-package pin requirement, old-data deletion or generic legacy migration was introduced.
- Diagnosis fidelity: tool/skill changes are already partly supported; the plan targets the actual global schema gate, runtime-identity comparisons, historical ACP selections and missing replay normalization instead of claiming every change is currently rejected.
- Contract review: storage format, event payload, host capability, package release and context fingerprint are independent. Current readable schema-5 IDs remain usable; unreadable legacy storage only affects those historical IDs.
- Integration review: CLI/SDK/ACP, provider serialization and token estimation, explicit ACP selection, generated/explicit cache keys, variable projection, canonical policy identity, payload accounting and installed consumers have named owners and tests.
- Atomicity review: session transition/recovery commit together; package index is the sole lifecycle authority; agent bindings are a separate atomic config operation. No multi-file journal/update wizard was added to v1.
- Anti-shortcut review: A→B→B requests, old-store preservation, no historical dispatch, version-label-only updates, helper/development snapshots and recipient execution with the author tree absent all have observable oracles.
- Scope review: the first package version handles local folders/archives and exact bundled dependencies. A hosted marketplace, Git transport and range solver remain explicit follow-ups, not incomplete hidden requirements.
- Structural review: all eight phase blocks contain the required headings in order; AC-1 through AC-26 plus AC-7a are unique and observable; referenced existing source/test paths were checked; only this plan file changed.
- External `codex-plan-review` using `gpt-6-astra`: round 1 REVISE on helper-only source transitions; issue accepted and fixed in Phase 2; round 2 text verdict APPROVE with no remaining issue. The runner's markdown parser reports `format: unknown` for a zero-issue verdict despite its own output-format contract requiring verdict-only output; the saved raw review explicitly contains `### VERDICT` and `Status: APPROVE`. This is a parser limitation, not a missing review response.

This plan is approved for implementation by the user's latest instruction: run `loop-implement` when the `gpt-6-astra` plan reviewer approves. The approval criterion is now satisfied.

## Phase 1: Isolate unreadable stores from normal session creation
Status: complete (2026-09-26).

### Goal
Allow new sessions and active-store operations in the presence of unrelated unsupported historical data.
### Current behavior and gap
Opening the single global database calls `initializeSessionSchema` and throws before `runCli` can create a new row. The current regression test requires that undesirable global failure.
### Evidence
`src/sessions/schema.ts: initializeSessionSchema`; `src/sessions/store.ts: pathForState, SessionStore.constructor`; `bin/raw.ts: run`; `tests/session-store.test.ts: unsupported schema version fails without altering the database`.
### Pattern
Reuse `DatabaseSync`, store-local payload paths, private-directory creation, existing initial-schema race tests and maintenance fencing. Add a small physical-store locator/probe, not a migration framework.
### Dependencies
None. No package code in this phase.
### Files and symbols
Modify `src/sessions/schema.ts`, `store.ts`, `src/sessions/api.ts` as needed for scoped diagnostics; add `src/sessions/location.ts`; update `tests/session-store.test.ts`, `session-retention.test.ts`, `session-cli.test.ts`, `scripts/test-phase.mjs` and `scripts/test.mjs` isolation.
### Behavioral contract
Implement design A. Readable format-5 files remain in place and resume as before. Unsupported legacy files remain untouched, including payload directories. New sessions use the isolated active family. A subsequent open selects the same family. Real I/O failures remain errors. A malformed individual session cannot poison unrelated creation/listing metadata.
### Documentation
Update `docs/architecture.md`, `docs/context.md`, `docs/cli.md` with physical format versus context revision and the actual chosen paths. Remove instructions that require clearing old state before using Raw.
### Tests first
- Fixture databases labeled 2, 4, 999 and unrelated unversioned tables; new task succeeds with a mock provider and produces a resumable session.
- Verify legacy file/schema/content and payload tree unchanged; maintenance of the active store cannot sweep them.
- Readable baseline format-5 session ID/history remains accessible; no export/import conversion.
- Concurrent first opens choose one family and preserve separate session writers; active writer/busy and permission failures are not treated as incompatibility.
- A bad saved row fails only when used; another session can be created.
### Anti-shortcut coverage
An oracle checks that no `PRAGMA user_version` rewrite, deletion, rename or blanket catch-and-reset made the test pass. A second process resumes the new session using the same active path. Test payload isolation, not merely SQLite filenames.
### Implementation obligations
Keep constructor/resource cleanup correct; centralize store selection for CLI/ACP/library/maintenance. Set diagnostic provenance without adding recurring model text. Add the isolated `sessions` runner selector covering session suites, cache, provider-content and auto-compact tests.
### Acceptance criteria
- [x] AC-1: A CLI task with each unsupported legacy fixture exits 0 and its returned ID resumes — CLI/process tests.
- [x] AC-2: Legacy bytes/logical contents and payloads are preserved through active maintenance — storage tests.
- [x] AC-3: Current format-5 IDs still resume and writer fencing remains enforced — store/process regression suites.
### Focused verification
`npm run test:phase -- sessions`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation self-review: APPROVE. `location.ts` probes the legacy database read-only, isolates only supported format mismatches, preserves format-5 IDs, and keeps active payload maintenance inside its own directory. The separate legacy-path I/O test proves real errors are not swallowed. Diff inspected, no unrelated files staged.
### Commit
`fix: isolate legacy session stores from new conversations`

## Phase 2: Replace runtime identity refusals with durable transitions
Status: complete (2026-09-26).

### Goal
Make a changed valid runtime resumable while keeping unchanged prefixes stable and historical replay valid.
### Current behavior and gap
Tool/skill transitions already exist, but model/prompt/runtime comparisons throw. Opaque adapter fields cannot be reused safely across replay environments. Fingerprints only cover tool entry bytes and manifests, missing helper imports.
### Evidence
`src/sessions/store.ts: initializeAgent, snapshotSkills, staleSkillNames, replaceAgentContext, recoverInterruptedCallsInTransaction`; `src/agent.ts: AgentSession constructor and request construction`; `src/llm/types.ts: ModelMessage`; `src/tools/plugins/loader.ts: selectedManifest` currently hashes/imports entry bytes only; provider `inputMessages/inputItems/inputContents`; `tests/session-agent.test.ts`, `tests/cache.test.ts`.
### Pattern
Extend existing transactions, source digests and context revisions; retain the canonical-message/provider-adapter boundary. Use pure comparison and replay projection functions with table-driven tests.
### Dependencies
Phase 1.
### Files and symbols
Add `src/sessions/transition.ts`, `src/llm/replay.ts`, `src/tools/plugins/snapshot.ts`; modify `src/sessions/store.ts`, `restore.ts`, `src/agent.ts`, `src/llm/types.ts`, `src/llm/context.ts`, `src/tools/plugins/loader.ts` and provider request assembly as needed. Add `tests/session-transition.test.ts`, `tests/session-replay.test.ts`; extend tool-plugin, cache, agent, process and compaction tests.
### Behavioral contract
Implement design B's transition table. Keep valid original messages and one persisted new baseline. Existing local tools must execute from a fresh snapshot of the complete selected owned directory when any owned helper changes, in a new process and in a long-lived process; phase 6 reuses the snapshot mechanism for packages. Independent release/provenance metadata does not create a transition. Skill notices remain tail-only and deduplicated.
### Documentation
Document request prefix versus behavioral source digest versus replay environment, including explicit cache keys, historical image markers and provider-dependent usage/calibration. No guarantee of provider cache hit.
### Tests first
- A→B→B cross-process cases for prompt, model, provider, method, endpoint, request settings, schema, tool removal/reorder, code source and skills. First B works; second B does not rotate again.
- A→A preserves exact stored content, provider payload prefix, generated key and revision.
- Change only an imported relative `.mjs` helper under a selected local tool folder between attachments to the same long-lived SDK/ACP process: the next tool call returns the changed helper behavior and rotates once; a second unchanged attachment retains that behavior, key and prefix. Include a second-process witness and unchanged unrelated-file/mtime-only control.
- Full provider-method replay matrix with opaque blocks, multiple tool calls, images/resource links, tool removal and changed schemas. Mock requests must contain no foreign opaque structures/unlinked calls.
- Crash/injected failure during transition: prior baseline remains coherent, recovery results precede notices, retry commits once, no historical handler dispatch.
- UI-only/provenance-only changes do not rotate; explicit cache-key precedence still works; var values remain absent from fingerprint.
- Canonical opaque/image/tool data survives projection and later compaction/history operations under payload accounting.
### Anti-shortcut coverage
Do not accept deleting equality checks plus catching provider errors. Assert actual wire payloads and a successful next model answer. Do not clear the conversation, strip stored original data, create a new ID, or append a fresh notice on every resume.
### Implementation obligations
Build the effective replay view once per request through one common path used by estimation and adapters; persist only deterministic annotations/baselines. Reconcile payload references transactionally. Snapshot selected local tool roots before import, stage complete snapshots atomically, reuse identical digests, and never mix helper bytes from different generations. Reject links that escape the owned closure; exclude the generated snapshot directory from future hashes. Reset calibration only when its model assumptions change. Preserve active-turn immutability and existing explicit key semantics.
### Acceptance criteria
- [x] AC-4: All valid runtime-change cases continue on the same session ID with their historical content retained — transition matrix.
- [x] AC-5: Every changed-runtime test proves B→B key/prefix stability, not just A→B success — captured mock requests.
- [x] AC-6: Cross-provider/tool-removal replay succeeds without executing old calls or forwarding foreign opaque blocks — replay/provider/process tests.
- [x] AC-7: Failed transition retry is atomic and produces no duplicate notice/revision — injected failure tests.
- [x] AC-7a: A helper-only edit under a local selected tool executes new code on the next same-process attachment and then stabilizes — tool-plugin/SDK/ACP tests.
### Focused verification
`npm run test:phase -- sessions`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`refactor: reconcile session runtime changes without blocking resume`

## Phase 3: Apply current configuration consistently across CLI, SDK and ACP
Status: complete (2026-09-26).

### Goal
Complete and qualify the user-visible session fix before starting package work.
### Current behavior and gap
CLI and ACP reject explicit configuration/agent changes before reaching shared session reconciliation; saved ACP MCP/tool selections can still block resume. SDK selection precedence differs from CLI.
### Evidence
`bin/raw.ts: selected resume branch`; `src/cli.ts: createRuntimeAgent`; `src/sessions/api.ts: resumeSession`; `src/acp/methods.ts: startSession and _raw/session/configure`; `src/agent.ts: savedView`; conflicting assertions in `tests/session-cli.test.ts` and `tests/session-acp.test.ts`.
### Pattern
Keep `createRuntimeTools` and `createAgent` as shared runtime assembly. Resolve current intent before attachment and pass provenance to the transactional transition; preserve ACP claim-before-MCP-start behavior.
### Dependencies
Phase 2. This is the hard Milestone A release gate.
### Files and symbols
`bin/raw.ts`, `src/cli.ts`, `src/config.ts`, `src/sessions/api.ts`, `src/agent.ts`, `src/acp/methods.ts`, `src/terminal/history.ts`, relevant session/cache/provider tests, `docs/cli.md`, `docs/acp.md`, `docs/context.md`, `docs/architecture.md`, `docs/verification.md`.
### Behavioral contract
Explicit resume overrides are accepted and become saved defaults after successful attachment. Current config edits are used automatically. Historical missing MCP aliases/removed tools no longer fail resume; current explicit missing names still identify an invalid selection. ACP explicit view survives only while the base selection is unchanged, as in design B. No new upgrade/force-resume/accept-cache-loss flag.
### Documentation
Rewrite the CLI/ACP/library examples to demonstrate edit→resume→resume. Show real missing-config/cwd/credential diagnostics separately from a harmless identity change. Update the five setup skill instructions that still describe session restrictions; fuller package authoring updates follow in phase 8.
### Tests first
- CLI changes `--agent`, `--config`, prompt, model options and selected assets; second plain resume uses the new defaults and same ID.
- Saved config removed: explicit replacement succeeds; no override gives a concrete missing-resource error, not a version mismatch.
- ACP resumes with updated agent/server configuration, removed historical MCP alias and changed selection; an unavailable reverse callback can be registered again.
- CLI/library/ACP each prove stable unchanged follow-up and no maintenance/schema blocker from legacy state.
- Current invalid refs, busy ownership, expired IDs, invalid tool/result linkage, missing cwd and provider errors retain precise behavior.
### Anti-shortcut coverage
Exercise installed CLI subprocesses and ACP requests, not only a direct `initializeAgent` call. Do not silently fall back to an empty registry/default agent. Retain the existing no-dispatch-on-crash and real conditional Bash approval witnesses.
### Implementation obligations
Replace obsolete refusal tests with positive continuity tests; ensure startup errors release claims/MCP handles; keep footer resume instructions usable after successful overrides. Record Milestone A evidence separately before proceeding.
### Acceptance criteria
- [x] AC-8: CLI, SDK and ACP all satisfy edit→resume→unchanged-resume with one ID — integration tests.
- [x] AC-9: Old saved selections cannot block an otherwise valid current selection; current invalid config still fails locally — MCP/ACP/CLI tests.
- [x] AC-10: Full suite passes with all original persistence, vars, policy and UI guarantees preserved — `npm run check` and milestone evidence.
### Focused verification
`npm run test:phase -- sessions`
### Phase gates
`npm run check`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE. Do not begin phase 4 until AC-10 passes.
### Commit
`fix: use current agent configuration when resuming sessions`

## Phase 4: Define portable component and package contracts
Status: complete (2026-09-26).

### Goal
Establish one documented identity, manifest, input and path contract before adding package commands.
### Current behavior and gap
Config and loaders embed three roots and reject any other reference shape. Skill metadata is duplicated in a Raw-only sidecar. Package release identity and host compatibility have no separate contract.
### Evidence
`src/config.ts: toolSpec, skillSpec, agentSpec, parseDocument`; `src/tools/plugins/loader.ts: parseId, manifestFrom, selectedManifest`; `src/skills/loader.ts: parseManifest, loadSelectedSkills`; `src/vars/config.ts: parseVariableDefinitions`; `src/tools/registry.ts: canonicalIdentity, validateRegistrations`; `scripts/copy-bundled-skills.mjs` and package asset lists.
### Pattern
Reuse JSON Schema validation with AJV, explicit ordered IDs, realpath containment, frozen parsed structures and loader/runtime separation. Keep tool and var-provider execution protocols intact; normalize component ownership before calling existing validators.
### Dependencies
Milestone A must be complete and qualified.
### Files and symbols
Add `src/packages/contract.ts`, `manifest.ts`, `references.ts`, `inputs.ts`, `components.ts` and `schemas/raw-package.schema.json`; refactor shared parsing seams in config/tool/skill/var loaders. Update `src/skills/contract.ts`, bundled skill assets, `examples/skills`, `scripts/copy-bundled-skills.mjs`, skill tests and package declaration generation. Add `tests/package-manifest.test.ts` and `tests/component-references.test.ts`.
### Behavioral contract
Implement designs C/D as data-only APIs. Skill frontmatter is the only authoritative name/description; whole directories remain portable. Unknown optional metadata does not affect behavior; unknown required capabilities produce component-scoped errors. Version-only release changes pass the same supported contract. Absolute install locations never enter model-visible names.
### Documentation
Create `docs/packages.md` and schema examples before implementation. Update `docs/skills.md`, `docs/skill-authoring.md`, `docs/tools.md`, `docs/configuration.md` for exact refs, aliases, overrides and skill layout. Document every accepted input reference site and prohibit undeclared/template expansion elsewhere.
### Tests first
- Valid agent-only, skill-only, tool-only, var/provider-only and mixed manifests; empty/invalid exports, duplicate identities, unresolved refs, dependency cycles and escaping paths.
- Two packages both exporting `search`, with explicit stable aliases; rules still bind to their canonical identities.
- Same components under different package versions/installation paths resolve identically; missing required host capability identifies only the affected selection.
- Standard `SKILL.md` frontmatter plus references/scripts/assets loads through existing list/load semantics; malformed/duplicate YAML keys fail with file-local diagnostics.
- Typed input defaults/required fields, full-block override semantics, input path ownership, and rejection of arbitrary string/Markdown/shell interpolation.
### Anti-shortcut coverage
Importing the parser must not import a selected tool's JS. Place marker side effects in exported modules/providers and assert none run during data-only resolution. No broad dynamic object merging or duplicate skill metadata fallback.
### Implementation obligations
Extract a component resolver whose result includes owned root, canonical identity, metadata and file references. Keep local/builtin/config-adjacent sources first-class. Introduce a maintained YAML parser for frontmatter and a maintained SemVer validator rather than hand-written parsers; pin direct dependencies and lockfile, validating their public API before use. Add the isolated `sharing` test selector.
### Acceptance criteria
- [x] AC-11: All six export categories have validated, documented, unambiguous reference/input contracts — schema and manifest tests.
- [x] AC-12: Identical behavior under a different package release label is accepted and yields identical component fingerprints — reference tests.
- [x] AC-13: Shipped skills and a plain portable skill use a single frontmatter metadata source with unchanged tail loading — skill suites.
### Focused verification
`npm run test:phase -- sharing`
### Phase gates
`npm run typecheck`
`npm run test:package`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: define portable package and component contracts`

## Phase 5: Export and pack complete portable artifacts
Status: complete (2026-09-26).

### Goal
Let an author turn an existing agent or authored component folder into an inspectable, reproducible distribution artifact.
### Current behavior and gap
Copied directories work only when all needed assets and recipient prerequisites are manually assembled. Existing loaders do not expose a complete declared export graph; arbitrary host paths/model bindings can leak into supposedly portable definitions.
### Evidence
`examples/agents/project-helper/raw.json` and README; `examples/providers/host-info`; `src/vars/config.ts` config-relative sources/provider cwd; `src/tools/plugins/loader.ts` entry/manifest source hashing; `tests/package.test.ts` relocation witness.
### Pattern
Reuse component ownership from phase 4, existing copied-directory examples and package tests that execute outside the checkout. Treat export as static graph traversal and packaging as deterministic file processing.
### Dependencies
Phase 4.
### Files and symbols
Add `src/packages/export.ts`, `archive.ts`, `inspect.ts`, `files.ts` and data contracts; add `tests/package-export.test.ts`, `package-archive.test.ts`; extend `docs/packages.md`, example manifests and `package.json` dependencies/packaging files.
### Behavioral contract
Implement design E's export, validation, inspection and pack APIs. Export selected agent prompt/tools/skills/vars/providers/MCP/rules plus declared assets; preserve order and aliases. Convert recipient-specific model/path/env/service values into explicit binding requirements. Package dependencies travel as exact nested artifacts. Missing owned assets prevent a successful distributable validation; a draft reports them precisely.
### Documentation
Show source versus artifact versus installed instance, export include/binding options and the report schema. Explain limits of static closure discovery for arbitrary user code and how to declare a helper file or external executable requirement.
### Tests first
- Real mixed agent exported from a relocated config; its owned prompt/skill references/tool helper/provider script/data file are included, while model credentials/runtime readings/session data are not.
- Each var source kind exports according to the table; file/provider fixtures contain side-effect markers proving they were not read/executed to obtain values.
- Explicitly included authored literal/data assets survive round-trip; external paths become required inputs instead of guessed package paths.
- Pack twice from identical source with different mtimes/cwd/order and assert byte-identical archives/digests.
- ZIP traversal, links, duplicate/case-conflicting paths, expanded-size/count/nesting limits, corrupt/missing inventory and dependency digest mismatches are rejected before installation.
- Helper not declared/covered by the package file graph gives an actionable validation/export report; do not claim to statically analyze arbitrary runtime file access.
### Anti-shortcut coverage
Unpack into a new temporary directory after hiding the author's source tree; inspect/validate the result without a model/provider. Compare full selected policy and component references, not only manifest filenames. Never use a resolved `read_var` result as an exported default.
### Implementation obligations
Use a pinned maintained ZIP library with bounded decompression and deterministic writing. Keep paths portable across slash conventions/case-insensitive filesystems. Separate artifact transport hash from per-component behavior digest. Reuse common traversal in validate/pack/export so their definitions of closure cannot drift.
### Acceptance criteria
- [x] AC-14: Exported mixed agent has a complete declared owned/dependency closure and a precise recipient-input report — export tests.
- [x] AC-15: Identical source inputs produce identical artifacts and corrupted/escaping artifacts cannot validate — archive tests.
- [x] AC-16: All packaging operations remain free of model/plugin/provider/MCP/session side effects — marker and isolated-process tests.
### Focused verification
`npm run test:phase -- sharing`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: export and pack portable raw artifacts`

## Phase 6: Install, update and develop packages transactionally
Status: complete (2026-09-26).

### Goal
Provide the artifact store, installation lock and local authoring lifecycle without editing active session state.
### Current behavior and gap
There is no package installation authority or lifecycle. Copying files directly into global tools/skills cannot preserve independent versions, dependency ownership or user edits across updates.
### Evidence
`src/config.ts: configFilePath, readConfigDocument`; existing XDG path patterns in `src/sessions/store.ts` and `src/tools/plugins/loader.ts`; package isolation in `tests/package.test.ts`; ownership patterns in the session store.
### Pattern
Staged immutable files plus one atomic authority update, as used by persistence payload staging. Keep package storage separate from session databases and config instance bindings.
### Dependencies
Phase 5.
### Files and symbols
Add `src/packages/store.ts`, `lock.ts`, `lifecycle.ts`, `snapshot.ts`; add `tests/package-store.test.ts`, `package-lifecycle.test.ts`, and process fixtures. Update package/architecture documentation and test XDG_DATA_HOME isolation.
### Behavioral contract
Implement install/update/remove/link/fork as in design E. Exact dependency artifacts may coexist; each root resolves its own declared graph. Preserve previous artifacts on update; root alias updates do not mutate the source of a running runtime. Validate affected current agent bindings before committing an update. No implicit overwrite, install hooks, subprocess setup, session access or default-agent edits.
### Documentation
Document lock records and source origins, exact dependency ownership, update rollback by reinstalling a prior artifact, development snapshots, failed-update behavior and intentional removal errors listing active dependents. Describe downloaded GitHub archive usage without claiming automatic Git transport.
### Tests first
- Clean install, idempotent reinstall, alias collision, side-by-side dependency versions and identical names from distinct origins.
- Inject interruption at extraction, artifact publication and index commit; readers see old or new complete state, never a partial graph.
- Concurrent installers/updates serialize without losing entries; stale process locks recover without stealing a live lock.
- Failed input/dependency validation leaves the prior alias/config untouched; valid update retains local inputs/overrides.
- Linked folder changes alter only the next snapshot; lazy helper imports in an already created runtime still use old snapshot bytes.
- Fork/edit/repack leaves the installed artifact unchanged; remove identifies dependents and never recursively deletes their configuration.
### Anti-shortcut coverage
Run a reader during update and a provider/tool import after its source folder is edited. Assert index atomicity and runtime immutability, not only that an archive extracted. No raw-session version checks may appear in package lifecycle code.
### Implementation obligations
Hash complete selected component file closures, excluding labels/paths/mtime. Use per-artifact/development snapshots so Node import caching cannot retain helper modules from a prior version. Expose data-only effective binding validation for update; do not load executable code to check compatibility.
### Acceptance criteria
- [x] AC-17: Concurrent/faulted installation leaves one coherent lock and complete referenced artifacts — process/failure tests.
- [x] AC-18: Update keeps local bindings and running snapshots; next attach resolves the new artifact — lifecycle tests.
- [x] AC-19: Link/fork enables code/schema/prompt editing without corrupting installed artifacts — development tests.
### Focused verification
`npm run test:phase -- sharing`
### Phase gates
`npm run typecheck`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: manage immutable and development package installations`

## Phase 7: Bind packages into agents and expose the sharing CLI

### Goal
Make installed standalone components and complete agents usable through ordinary Raw CLI/library/ACP flows.
### Current behavior and gap
`loadConfig` parses local definitions, `createRuntimeTools` assembles local roots, and the CLI parser only knows current task/config/session/vars commands. Package loading must not become a second agent implementation.
### Evidence
`src/config.ts: parseDocument, loadConfig, loadVariableConfig, parseCliArgs`; `src/tools/plugins/runtime.ts: createRuntimeTools`; `src/tools/plugins/loader.ts`; `src/tools/mcp-client.ts`; `src/vars/config.ts`; `bin/raw.ts`; `src/index.ts`.
### Pattern
Resolve data to one effective config before existing runtime validation/assembly. Keep commands such as `vars list/get` credential-free and independent of model/MCP initialization. Follow config-init's explicit creation behavior and existing SDK exports.
### Dependencies
Phase 6 and all Milestone A behavior.
### Files and symbols
Add `src/packages/resolve-agent.ts`, `cli.ts`; integrate `src/config.ts`, `bin/raw.ts`, `src/index.ts`, tool/skill/var loaders, MCP registration aliases and runtime source identity. Add `tests/package-config.test.ts`, `package-cli.test.ts`, `package-runtime.test.ts`; extend session/vars/MCP/ACP tests and API declaration tests.
### Behavioral contract
Implement the exact CLI verbs in design E and current config forms in design D. `package` commands dispatch before session/model startup. Effective agents use current local bindings, package assets and recipient model. Root direct vars/provider/MCP bindings and mixed local/package tools/skills are supported. Unselected incompatible/missing package assets do not poison an unrelated agent; selected missing references still error accurately.

Changing a package, agent binding, tool schema/helper code or prompt uses phases 2–3 transitions on next attach. Version-only package updates with identical effective content do not rotate the prefix. Adding a skill remains append-only on demand. Preserve stable MCP aliases and apply package policy rules through canonical identities; do not rewrite aliases with artifact hashes.
### Documentation
Complete command help and `docs/packages.md`, `docs/configuration.md`, `docs/cli.md`, `docs/vars.md`, `docs/mcp.md`, SDK examples and architecture flow. Every example identifies whether it is a source package, installed alias or agent instance.
### Tests first
- CLI author export→validate→pack; recipient install→agent add→run, using a mock model and a different model alias/cwd/config path.
- Install a standalone skill/tool/var provider and select it from an existing direct agent; no package agent required.
- Package command and `vars list/get` with no model credentials and with a legacy unsupported session store; no session files created or MCP/provider execution except the explicitly requested vars read.
- Two packages' same-named tools/skills plus configured MCP aliases coexist using explicit `as` names; rules match the right canonical identity.
- Package update/edit→resume same ID→second unchanged resume; removal from current selection works even with historical calls/list/load results.
- Release-label-only update leaves key/prefix unchanged; real helper-source/schema/prompt changes produce one transition.
- Fresh invalid current ref/unsupported required capability reports the offending component while unrelated agents continue.
### Anti-shortcut coverage
Run actual subprocesses and installed SDK types; do not hide a package behind a generated temporary global config or flatten every installed export into all agents. Compare real outgoing tools/system/history across updates and assert old handlers were not executed.
### Implementation obligations
Keep config resolution and input materialization side-effect free until runtime startup. Split selected-agent resolution from validation of unrelated installed component contents. Persist updated config/agent provenance through shared session transition APIs. Ensure base-selection snapshots used by ACP reflect effective package selection. Handle all error exits with cleanup and existing exit-code conventions.
### Acceptance criteria
- [ ] AC-20: Both complete agents and individual components install and run through ordinary CLI/SDK/ACP machinery — runtime/CLI tests.
- [ ] AC-21: Package changes never require state upgrade, version restoration or a new conversation ID; unchanged follow-up is stable — package/session matrix.
- [ ] AC-22: Data-only commands work without credentials/session access; unused package issues cannot block unrelated work — CLI isolation tests.
- [ ] AC-23: Package aliases preserve current policy/vars/MCP semantics and selection order — policy/MCP/vars integration tests.
### Focused verification
`npm run test:phase -- sharing`
`npm run test:phase -- sessions`
### Phase gates
`npm run check`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`feat: run package agents and components through raw configuration`

## Phase 8: Ship authoring guidance and qualify the installed sharing workflow

### Goal
Deliver a usable author/recipient workflow with accurate setup skills and prove that the original session problem remains fixed after package integration.
### Current behavior and gap
The five shipped skills teach config-local tools/skills/agents/MCP and vars. They do not explain package ownership, typed binding, install/update/fork, or the new resume rules. Existing packed-consumer tests only cover raw-cli itself and copied directories.
### Evidence
`src/skills/builtin/{configure_raw,create_skill,create_tool,create_agent,add_mcp}` and generated examples; `docs/skill-authoring.md`; `tests/setup-skill-examples.test.ts`, `tests/package.test.ts`, `tests/package-agent.test.ts`; `package.json: files/scripts`.
### Pattern
Keep the existing five task-specific skills, executable examples and actual npm-packed consumer witness. Put detailed reference material in companion files where needed; English instructions and explicit triggers remain mandatory.
### Dependencies
Phase 7.
### Files and symbols
Update all five shipped skills and their references/examples, README, docs listed above, `examples/packages/` (new complete mixed package plus standalone examples), build/copy scripts, `package.json: files/test:package`; add `tests/package-sharing-installed.test.ts` and `docs/evidence/session-continuity-and-packages.md`.
### Behavioral contract
The default raw setup agent can guide users through configuring, creating and sharing each component. Skills explain local bindings versus shareable definitions, dynamic vars versus defaults, argument-specific Bash policy, edit→resume continuity, meaningful compatibility errors and snapshot-based development. A recipient can use downloaded artifacts with no author filesystem/state present.
### Documentation
Publish a concise end-to-end author/recipient cheatsheet, exact schema reference, update/fork/rollback examples and future marketplace seam. Remove stale statements requiring saved identity equality, clearing state, `skill.json`, or pinned original package versions on resume. Do not claim a hosted marketplace or automatic GitHub fetch exists.
### Tests first
- Pack raw-cli, install into an isolated temporary prefix and invoke only the installed binary/SDK.
- Author creates a mixed package (prompt, tool with helper, portable skill with resource, var/provider, MCP definition, conditional rule); recipient installs from another cwd with distinct XDG homes/model binding and runs it against local mock services.
- Seed unsupported old session database before recipient's first run; new session succeeds. Update selected prompt/tool/skill/provider and resume; second unchanged resume is stable. Update only package version next; no needless key change.
- Install skill-only and tool-only artifacts into an existing agent. Link/fork/edit paths work after the repository and author directories are unavailable.
- Validate each shipped skill's schema examples and referenced resources; compare built/installed asset contents; check current list/load output caps and package file inclusion.
- SDK declaration check covers package lifecycle and agent-binding APIs; old MCP/vars/basic CLI/footer behavior remains covered.
### Anti-shortcut coverage
The recipient must not import code from the checkout, read author absolute paths, rely on globally installed author dependencies, or reset its state between update/resume assertions. Verify HTTP payload prefix/key equality for the unchanged follow-up, not a synthetic checksum alone.
### Implementation obligations
Include package schema/docs/examples and skill resources in published artifacts. Record exact source commit, archive digest, installed binary path and observed results in evidence. Native platform evidence must be labeled; macOS tests alone do not establish Windows/Linux runtime qualification. No GitHub Actions are enabled.
### Acceptance criteria
- [ ] AC-24: Installed author→artifact→recipient workflow works for mixed and standalone components with no source-checkout dependency — installed witness.
- [ ] AC-25: All five English setup skills accurately teach the final schema/workflows and their examples validate — skill/package tests.
- [ ] AC-26: Final full regression and installed package gates pass; evidence distinguishes verified behavior from deferred marketplace/platform work — final report.
### Focused verification
`npm run test:package`
### Phase gates
`npm run check`
`npm run test:package`
`git diff --check`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`docs: ship package authoring skills and installed continuity evidence`

## Completion Criteria

- [x] AC-1 through AC-10 and AC-7a pass before any package implementation starts.
- [x] Unsupported old state never prevents a new task; readable current sessions keep their IDs/history.
- [x] CLI, SDK and ACP accept valid current runtime changes, recover historical calls without dispatch, and stabilize after the transition.
- [x] Request prefix stability is proven by captured provider payloads; version/provenance-only changes do not create artificial incompatibility or rotation.
- [ ] AC-11 through AC-26 pass, covering the six export categories, complete owned/dependency closure, recipient inputs, lifecycle and current-agent integration.
- [ ] Package operations are independent of session schema, model credentials, executable plugin startup and runtime var resolution.
- [ ] Five shipped setup skills and all installed examples match the final contracts; docs clearly defer hosted marketplace/Git transport/range solving.
- [ ] Each phase has an APPROVE implementation review, its own commit and recorded commands/results. Final working tree contains no unintended changes.
- [ ] No legacy test data was deleted, no automatic deployment/global config update occurred, and no GitHub Actions minutes were consumed by this work unless separately requested.

## Progress Log

- 2026-09-26: Phase 6 complete. Added per-config atomic install authority, owned writer lock and stale-process recovery, immutable artifact/dependency publication, update/removal binding checks, and linked/forked development snapshots. Docs and red tests preceded implementation. `npm run test:phase -- sharing` passed 36/36, `npm run typecheck` passed, `git diff --check` passed. Self-review APPROVE: concurrent writers retain both aliases; injected faults leave old locks intact; runtime snapshots keep helper bytes; package operations do not open sessions or start executable components.
- 2026-09-26: Phase 5 complete. Added data-only mixed-agent export with explicit include/binding choices and missing-asset draft reports; bounded deterministic ZIP packing, integrity inventory, safe archive validation/extraction and nested exact dependency checks. Static selected tool imports and agent references must be covered by the declared graph. `npm run test:phase -- sharing` passed 29/29, `npm run typecheck` passed, `npm run test:package` passed 2/2, `git diff --check` passed; final export-path refinement passed focused export/archive tests 7/7 and typecheck. Self-review APPROVE: no runtime plugin/provider/MCP/model/session startup in packaging APIs; author-only paths and secret model fields are absent from the artifact by default.
- 2026-09-26: Phase 4 complete. Added `raw-package.schema.json` and data-only manifest, reference, input and component APIs; exact SemVer and YAML parsers are pinned. Migrated selected skills and five bundled examples to one Agent Skills frontmatter source, copied full skill directories, and removed `skill.json`. Docs explain six exports, aliases, input sites and package identity. Red tests preceded implementation. `npm run test:phase -- sharing` passed 19/19, `npm run typecheck` passed, `npm run check` passed 428/428, `npm run test:package` passed 2/2, `git diff --check` passed. Self-review APPROVE: parser/resolver imports no handlers or providers; release-only tool/package labels do not change fingerprints; selected skill bodies still load at the tail.
- 2026-09-26: Phase 3 complete. CLI explicit agent/config overrides now become saved defaults, SDK returns refreshed metadata, ACP uses current base selection while retaining compatible explicit views and pruning unavailable historical aliases. Removed-config recovery and A→B→B CLI/SDK/ACP tests added; selected bundled skill instructions updated within the 8 KiB load cap. `npm run test:phase -- sessions` passed 130/130; final `npm run check` passed 419/419; `git diff --check` passed. Local evidence: `docs/evidence/milestone-a-session-continuity.md`. Self-review APPROVE: no saved-runtime equality gate remains on these surfaces; current invalid references still fail and existing policy/vars/UI regressions pass.
- 2026-09-26: Phase 2 complete. Docs-first and red tests preceded transactional runtime transitions, canonical/provider replay projection and complete selected-tool folder snapshots. `npm run test:phase -- sessions` passed 127/127, `npm run typecheck` and `git diff --check` passed. Self-review APPROVE: transition notice is host-only, prior transcript remains canonical, stable B→B key and request prefix are asserted, helper-only source changes execute new bytes. ACP integration remains part of Phase 3's surface qualification.
- 2026-09-26: Phase 1 complete. Docs first, then 5 red integration/storage cases (`unsupported session schema version`); implemented read-only location selection, scoped missing-ID diagnostics for CLI/SDK/ACP and isolated active payload root. Final `npm run test:phase -- sessions` passed 106/106, `npm run typecheck` passed, `git diff --check` passed. AC-1–AC-3 reviewed APPROVE; commit below.
- 2026-09-26: Phase 1 in_progress. Plan reviewer APPROVE finalized in `/Users/lploc94/projects/raw-cli/.codex-review/sessions/codex-plan-review-20260926-002` (2 rounds, 1 accepted/fixed issue). Implementation started from clean main plus this untracked plan.
- 2026-09-26: Planning started from clean `5cd36df`; read loop-plan and applicable global instructions; verified prior 395/395 baseline evidence.
- 2026-09-26: CTXE routing record 57 and focused diagnosis record 58 identified global schema startup gate, runtime equality refusals, existing tool/skill transitions and ACP historical-selection blockers. Direct reads confirmed the production branches and obsolete refusal tests.
- 2026-09-26: Drafted eight phases in two ordered milestones. Rejected the earlier mandatory original-package-version resume proposal; sessions adopt current valid configuration and use deterministic transitions.
- 2026-09-26: Self-review clarified optional runtime metadata storage without a format bump, first-attach ACP baseline behavior, per-component rather than whole-package fingerprints, selected-input projection, builtin skill IDs versus portable names, and single-authority package updates. Plan verdict APPROVE; structural checks and whitespace inspection passed. No production tests were rerun for this documentation-only planning turn.
- 2026-09-26: External codex-plan-review round 1 (`gpt-6-astra`) returned REVISE on local imported-helper changes being deferred beyond Milestone A. Accepted ISSUE-1 and added a complete local owned-file snapshot/import mechanism and same-process helper-only A→B→B acceptance criterion AC-7a to Phase 2. Pending Codex re-verification.
- 2026-09-26: Review round 2 returned text verdict APPROVE and explicitly confirmed ISSUE-1 resolved, stable subsequent prefixes/keys, Milestone A dependency gate and no remaining blocking findings. Runner parser cannot structure zero-issue verdict-only text; raw verdict retained. User preauthorized implementation after this review.
