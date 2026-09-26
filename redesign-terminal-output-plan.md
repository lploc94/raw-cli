# Redesign Raw terminal output, themes, and syntax highlighting

## Plan schema
loop-plan/v1

## Target

Make `raw "query"`, the interactive REPL, and session-history viewing readable and visually coherent: a small agent/model header, clear assistant/tool activity, Markdown with real syntax highlighting, consistent semantic colors/icons, and an actionable context/usage/resume footer. Preserve streaming, shell piping, model behavior, and the existing tool-policy semantics.

The user approved the visual proposal and explicitly requested syntax highlighting, then requested this plan. This is planning approval only; implementation waits for approval of this document.

## Scope

- Refactor terminal presentation out of `src/cli.ts` into a small internal renderer, shared with history viewing.
- Add host-only display preferences: density, reasoning visibility, color, icons, theme, and semantic color overrides.
- Render Markdown headings, paragraphs, lists, quotes, links, tables, inline code, fenced code, and diffs; highlight code in structured built-in read previews too.
- Show concise tool summaries, useful errors and approval prompts, bounded previews, live activity, timings, and consistent history replay.
- Format turn status, estimated current context, observed session usage/cache coverage, continuation, and REPL `/stats`.
- Replace presentation-baked CLI history payloads with typed, bounded, style-independent display data. Bump the unreleased session schema once; no migration or compatibility path.
- Update CLI/config/context documentation, affected shipped setup-skill instructions, and consumer/PTY/regression coverage.

Explicit exclusions: full-screen TUI/alternate screen, interactive folding or mouse controls, new REPL commands, arbitrary theme scripts, plugin renderer extensions, changing tool schemas/policies, provider reasoning generation, pricing databases/cost estimation, new cache-miss normalization, telemetry export, redesigning `config list`/session-list/storage-stats tables, publication, global installation, or enabling GitHub Actions. Generic custom/MCP tools must work without new plugin metadata. No extra provider calls or filesystem reads to embellish output.

## Invariants

1. Presentation preferences never enter prompts, tool definitions, provider requests, model transcripts, tool/skill digests, cache keys, or session model-identity checks. Changing display preferences on resume does not invalidate a session or rotate its cache key.
2. One-shot redirected stdout remains the exact assistant text in arrival order, with the existing final-newline convention. Header, tool activity, reasoning, footer, and errors use stderr. Each redirected stream contains no generated ANSI, cursor operations, or animation. `sessions show` is explicitly a history-output command and can print the full transcript to stdout.
3. Terminal rendering never edits model text/results. Preview truncation is distinct from the model-facing `--max-output-bytes` cap; do not recover omitted model content by rereading files or executing tools.
4. Exit codes, cancellation/EOF behavior, durable commits/claims, MCP lifecycle, ACP protocol, and ordered conditional approval policies remain intact. An ordinary Bash call must not gain a confirmation prompt. A matching `ask` still shows the complete command before accepting fresh input.
5. Color is supplementary: state has a textual label or distinguishable symbol, and ASCII mode expresses the same meaning. No Nerd Font or emoji font requirement.
6. Timings/counts are observed host data. Unknown token/cache/window/duration data stays unknown, not zero. Context remains explicitly approximate and separate from cumulative session tokens. No fabricated final-answer classification or semantic tool-result summary.
7. Rendering must not erase scrollback, run a second model pass, duplicate streamed content, store ANSI, or leave a spinner/cursor/style active after completion, error, approval, interruption, or shutdown.
8. Follow the user's dev-phase policy: clean contracts over compatibility. Do not migrate old history, silently delete the user's database, rewrite their config, or install globally as part of these phases. Tests use disposable state.

## Baseline

- Planning baseline: `2945e6b` on `main`, clean working tree, three local commits ahead of `origin/main`. Previous setup-skill work is complete; do not repeat it.
- CTXE workspace `/Users/lploc94/projects/raw-cli`: `Ready`, fresh after incremental update; terminal orientation record 51 and integration-impact record 52. Record 52 had a partial documentation excerpt and unavailable package-root body; this plan relies on direct verified CLI docs/build files, not that unavailable body.
- Local `npm run check` completed during planning: 334 tests passed, 0 failed; log `/tmp/raw-terminal-plan-baseline.log`. This is baseline evidence, not evidence that the proposed behavior works.
- `src/cli.ts:textRun` currently writes text deltas directly, dims reasoning, prints JSON arguments and `raw:` result lines. It has no Markdown renderer or syntax highlighter.
- `src/sessions/display.ts:resultPreview` bounds a result to 2,000 Unicode characters and nine body lines plus one status line. `toolArguments` preserves complete Bash arguments and describes write payload sizes. Built-in batches are largely displayed as JSON rows.
- `src/agent.ts:execute/appendResult` persists CLI calls as formatted argument strings and results as formatted preview strings; assistant/reasoning text is separate. `SESSION_SCHEMA_VERSION` is 4. Model context is stored independently from visible history.
- `src/cli.ts:runCli` prints a completed one-shot footer only; `/stats` is JSON, REPL prompt is `> `, and `/clear` constructs a new session without replacing the local `record` variable. The redesign must bind any new footer/header to the actual active session.
- `src/llm/cache.ts:UsageSummary/summarizeUsage` exposes input/output and ratio coverage but no separate cache-read/cache-write coverage. Add those two aggregate coverage counts to distinguish absent cache fields from reported zero; keep provider normalization and cache arithmetic unchanged.
- `src/config.ts:parseConfigDocument` strictly permits root keys `default_agent`, `models`, `agents`, `mcp`, and `sessions`; `loadConfig` returns frozen host runtime settings. `bin/raw.ts` handles history commands before model construction.
- `tests/cli.test.ts` has real subprocess/mock-provider and Python PTY tests. `tests/session-cli.test.ts` covers resume/history/clear, `tests/repl.test.ts` covers command behavior, and package tests run installed CLI/MCP/ACP outside the checkout.
- GitHub Actions remains disabled by user request. All qualification here is local and uses mock providers.

## Design and project patterns

### Ownership and data flow

Use these internal modules, without introducing a public renderer plugin API:

| Owner | Responsibility |
| --- | --- |
| `src/config.ts` + new `src/terminal/options.ts` | Strict root `ui` parsing and immutable display-option resolution, separate from selected agent/model settings |
| new `src/terminal/theme.ts`, `layout.ts`, `writer.ts` | Semantic palette/icons, terminal-cell width, coordinated writes and bounded transient activity |
| new `src/sessions/visible.ts` | Typed style-independent display payloads and bounded tool-display projection; no Markdown/highlighter imports |
| `src/sessions/display.ts` | History adaptation and ACP conversion; eliminate legacy CLI payload branches after the schema change |
| new `src/terminal/markdown.ts`, `highlight.ts` | Incremental Markdown presentation and token-to-ANSI highlighting with plain fallback |
| new `src/terminal/tools.ts`, `renderer.ts`, `footer.ts` | Tool/status presentation, run lifecycle, and usage/context formatting |
| `src/cli.ts`, `bin/raw.ts` | Existing orchestration/input/exit ownership; instantiate the renderer and pass events/options |

Follow the existing `RunEvent` observer boundary and `structuredClone` isolation. Persist display data inside the existing agent/store commit paths, not from a renderer callback with side effects. Keep highlighter/Markdown dependencies out of `AgentSession`, ACP, and store imports. Plain commands must not initialize grammars unnecessarily. Do not create a parallel event bus, provider abstraction, or duplicate session store.

### Display configuration contract

Add optional root `ui`, allowed in canonical and alternate configs. It applies to the terminal application, not `agents.<name>` or `models.<alias>`. Example:

```json
{
  "ui": {
    "density": "normal",
    "reasoning": "summary",
    "color": "auto",
    "icons": "auto",
    "theme": "terminal",
    "palette": { "accent": "cyan", "thinking": "magenta" }
  }
}
```

- `density`: `compact | normal | verbose`, default `normal`.
- `reasoning`: `summary | full | hidden`. If absent, use `full` with verbose and `summary` otherwise. Explicit reasoning preference wins. Summary means a host activity label, never a generated summary of reasoning. Reasoning events still persist independently of visibility.
- `color`: `auto | always | never`, default `auto`.
- `icons`: `auto | unicode | ascii`, default `auto`; auto uses Unicode on capable TTYs and ASCII on plain/dumb output. Color disabling alone does not disable Unicode.
- `theme`: `terminal | dark | light`, default `terminal`; terminal uses the terminal's ANSI palette/default foreground. Explicit light/dark themes avoid unreliable background-color probing.
- `palette`: optional strict map of semantic roles to ANSI color names: `default`, `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, or their `bright_` variants. Roles: `accent`, `text`, `muted`, `thinking`, `path`, `code`, `success`, `warning`, `error`, `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_type`, `syntax_punctuation`. No arbitrary escape strings, JS, external theme files, or RGB schema in this change.
- Flags: `--display compact|normal|verbose`, `--reasoning summary|full|hidden`, `--color auto|always|never`, `--icons auto|unicode|ascii`, `--theme terminal|dark|light`. No new `RAW_*` environment variables. Flag > selected document `ui` > defaults. Existing strict duplicate/missing-value/unknown-key errors apply.
- Color resolution is per output stream: non-TTY and `TERM=dumb` always prohibit generated ANSI. For eligible TTYs, explicit `never` disables and explicit `always` enables; `auto` honors nonempty `NO_COLOR`. Document that `always` does not inject escapes into redirected streams. Animation eligibility is separate from color.
- Task/resume uses the selected config's `ui`. `sessions show` resolves display settings from explicit `--config` or canonical config, plus flags, without loading agent credentials, prompts, tools, or the session's saved config. A missing canonical config uses defaults. Existing malformed selected config errors remain explicit. Validate `ui` through `readConfigDocument` so `config list` catches errors without model access.
- ACP may validate the config containing `ui`, but ignores presentation preferences and never sends renderer text to the wire.

### Appearance and density

Header: `◆ raw · agent NAME · model ID`, then shortened cwd; `Resumed` on resume. Print once per one-shot process and at REPL session entry; after `/clear`, show the new active session boundary. No large logo or complete tool catalog by default.

Use icons `◆` brand, `❯` user/prompt, `●` assistant, `◌` thinking, `↳` read, `✎` write, `$` Bash, `◇` skill, `↗` MCP, `✓` success, `✗` failure, `!` attention, `↪` continuation. Image/generic tools use a neutral tool marker and their real names. Type and state remain separate. ASCII alternatives include `>`, `[tool]`, `[ok]`, `[error]`, `[wait]` and `[continue]`. Use one accent color; keep assistant prose in the default foreground and secondary metadata dim. Do not dim all code indiscriminately.

- Compact: header on one line, minimal successful-tool details, errors/approval fully intelligible, compact context and continuation.
- Normal: two-line header, readable tool arguments, successful preview body up to four logical lines, key metadata footer.
- Verbose: canonical tool identity, all retained display details up to the storage preview bound, full reasoning unless explicitly overridden, and coverage/timing details. This is not a promise to recover full model tool output from history.
- Errors may use the full retained preview in every density. All batch row statuses remain visible independently of the content-preview budget; at most 16 rows for current built-ins. Document the intentional replacement of the old total-ten-line layout contract with explicit summary + bounded body rules.
- Preserve complete Bash commands in displayed call/approval/history data. Normal output wraps them; compact may abbreviate a completed successful call, but never an approval or failed/rejected command. Write displays paths/modes/payload sizes rather than source payloads.
- Built-in formatting requires verified canonical built-in identity and matching result shape. A custom tool named `read_file` or an MCP result with a `results` array must not be interpreted as a built-in. Use host-only registry identity lookup; do not leak canonical identities into model schemas. Generic fallback must handle text, JSON, images, empty and malformed values.
- Timing shown on completion is measured around actual tool execution; rejected-before-start tools show `Not run`, never a successful duration. Partial/failed/cancelled batch status is not collapsed into a green check.

### Markdown and streaming contract

Use maintained parsers rather than regex syntax coloring. Planned dependencies: `marked` for Markdown tokens, `lowlight` with its public HAST/token API and common grammars for syntax, and `string-width`/`wrap-ansi` for terminal-cell-aware layout. Pin exact Node-22-compatible releases in `package.json`/lockfile during implementation; validate package exports in the packed consumer. Do not use undocumented highlight.js emitter/continuation internals or convert generated HTML with regex.

Support headings, emphasis, ordered/unordered/task lists, blockquotes, inline code/links, fenced code and GFM tables. Raw HTML renders as literal text, not executable terminal controls. Links retain a readable destination; no OSC hyperlink dependency. Tables fit the available width or fall back to labeled rows. Preserve code indentation and content; do not prepend copy-hostile line numbers to answer code. Handle backtick/tilde fences, optional info strings, empty/unclosed fences, CRLF, Unicode and split delimiters. Unknown/missing languages use plain code, not auto-detection guesses.

Initial guaranteed languages/aliases: JS/JSX, TS/TSX, Python, Bash/sh, JSON/JSONC, YAML, HTML/XML, CSS, SQL, Go, Rust, C/C++, Java, Markdown, and diff. Verify registration support; unsupported extensions fall back cleanly. Diff additions/deletions keep `+`/`-` as well as color. Read-file previews derive language from retained row paths; no additional file reads. Preserve omission markers outside highlighted source.

Streaming design: maintain committed scrollback plus a bounded mutable tail for the current incomplete Markdown block. On a shared interactive terminal, coordinate both streams through one writer; redraw only owned tail rows, never the whole transcript. Completed stable blocks are committed once. Limit redraw to 10 Hz and pending parser source to 32 KiB; mutable tail is at most `min(20, rows - 4)` rows, with a safe nonnegative fallback for tiny terminals. Split/flush oversized blocks progressively as literal text until the next safe block boundary; never truncate assistant content. Do not wait for a closing fence or run end to display code. Do not reparse the accumulated conversation on each delta. Table lookahead and incomplete inline constructs belong to the mutable tail, not committed history.

Use a monotonic clock/scheduler seam for deterministic tests. A visible answer preview must occur within 100 ms of an arriving nonempty delta under the fake scheduler. Completion, tool handoff, approval, cancellation, or error flushes remaining text exactly once and resets styles. Highlight/parser exceptions degrade the affected block to plain text without aborting agent work. Per-line syntax accuracy at the bounded fallback boundary may degrade to plain text; source text may not be lost.

For mixed/unknown terminal destinations, disable cursor-based tail redraw and animation; use append-only block/line streaming and literal fallback for partial blocks at the same latency bound. Both descriptors reporting `isTTY` is insufficient to prove they share a terminal: verify descriptor identity where available, otherwise use the append-only path. Redirected assistant stdout bypasses all Markdown transformations immediately. When color resolves to disabled (`never`, or `auto` with `NO_COLOR`), this design also uses append-only presentation with no generated ANSI/cursor sequences; textual layout and icon choice remain independent. `TERM=dumb` is fully append-only. Never animate while readline owns an idle prompt or an approval input.

### Display persistence and ACP

Introduce one typed CLI display contract, stored without ANSI or terminal-width decisions. Calls retain id, model-visible name, optional canonical identity, started/not-run state, and structured display-safe arguments (write bodies replaced by sizes). Results retain id/name, status/code/exit/truncation metadata, bounded typed preview segments (`text`, `code` with path/language hint, `json`, image description), batch row summaries, omission metadata and observed duration if available. Preview body text is capped at 2,000 Unicode code points / nine logical source lines with deterministic head/tail retention; summaries are bounded separately by row count. ANSI/styles do not count toward budgets because storage is unstyled.

Build a single pure projection used both for live display and durable records so the two cannot disagree about content. Capture execution timestamps in the agent's existing tool lifecycle, independent of renderer settings; keep them outside model context. A read preview must retain source/path segments rather than a JSON string with escaped newlines. `load_skill` defaults to its name/loaded state; generic verbose retained content remains bounded. Do not duplicate full tool results/images into display history.

Bump `SESSION_SCHEMA_VERSION` from 4 to 5 for this shape change and remove old CLI display fallbacks; retain clear fail-fast on unsupported database versions. This is a software data-contract change, not a version bump every time config/theme changes. No migration, automatic deletion, or dual writer. Keep ACP-native stored updates supported as a current distinct surface; this is not legacy compatibility. Update `storedAcpUpdates` to project CLI display records into legal ACP updates without terminal styling, maintaining the current bounded-output semantics for CLI-origin replay.

History replay is static, using the same semantic formatters and Markdown renderer in complete-block mode. It does not animate, measure new durations, restart tools, or retrieve model-context payloads. Pages may begin with a result or partial conversation: render an orphan result with its saved identity/status, do not crash or invent a call. Original semantic content and ordered states match live output; only historical/transient labels and width/theme may differ.

### Footer and interaction

Normal completed one-shot example (illustrative numbers):

```text
✓ Done · 8.4s · 3 tool calls
  Context  ▰▰▱▱▱▱▱▱▱▱  ~18.2k / 128k · 14.2% used
  Session  24.6k input · 1.1k output · 16.4k cache read

↪ Continue this session
  raw --resume SESSION_ID "query"
```

- Elapsed/tool count describe this turn; tokens/cache explicitly describe the session. Count started calls and show not-run/rejected calls separately when nonzero. Do not confuse provider requests with tool calls.
- Context uses `session.estimatedContextTokens()` and the configured window; unknown window omits percent/bar. Shortened numbers do not change the calculation. Bar visually clamps 0–100%, but numeric over-budget values remain truthful.
- Warning color derives from the configured compact trigger and the existing effective input budget (context minus output reserve and safety margin), not arbitrary utilization thresholds. Extract/reuse the budget calculation currently in `AgentSession.execute`; do not alter compact decisions. Show `compact threshold`/`input budget` labels when needed so users understand why the indicator changes before 100%.
- Normal usage appears only for completely covered fields; verbose and `/stats` show known totals with explicit `reported N/M requests` coverage. Add `cacheReadCoverage` and `cacheWriteCoverage` to the existing usage aggregate, counting presence including explicit zero. Ratio coverage remains a separate existing measure: read coverage does not require known input tokens. Cache-read ratio uses existing `summarizeUsage` semantics; never infer misses or count reads again as extra input tokens. Zero reported usage is different from missing usage. `/stats` exposes available read/write/ratio fields and host turn timing; no unsupported cache-miss or dollar amounts.
- Terminal outcome says `Done`, `Failed`, `Cancelled`, or `Stopped: max steps`, preserving error code and actionable message. Print a copyable full-ID resume command on ordinary saved-session outcomes, including interruption/failed tools, when the durable session remains usable. Do not offer resume after startup failure with no session or known persistence corruption. No repeated UUID elsewhere by default.
- REPL renders one compact per-turn summary and context near the next `❯` prompt. Full resume command on REPL exit, not every prompt. `/stats` is a readable table; `/clear` updates both active agent and session record; `/compact` uses the same status language. Piped REPL remains plain and preserves buffered input/EOF behavior.
- Approval displays tool identity and complete arguments above `[y/N]`. Stop transient rendering before reading input; preserve the existing fresh-line mark logic and default-no semantics. No new confirmation rules.

### Research basis

Reviewed during proposal/planning on 2026-09-26; these inform design, not a requirement to clone another app:

- [CLI Guidelines: output](https://clig.dev/#output): readable defaults, stdout/stderr separation and terminal-aware color/animation.
- [Claude Code status line](https://code.claude.com/docs/en/statusline): separate context/model/usage presentation.
- [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration): configurable footer components and accessibility.
- [Marked extension/token API](https://marked.js.org/using_pro), [Lowlight public API](https://github.com/wooorm/lowlight), [highlight.js API](https://highlightjs.readthedocs.io/en/latest/api.html): structured tokenization/highlighting; implementation must verify exact pinned versions.

## Global Gates

- Every phase updates its relevant docs before code, adds meaningful red tests, implements, runs focused checks and repository regressions, then obtains an implementation-review verdict of APPROVE before its cohesive commit. Self-review is sufficient unless a peer review is explicitly requested; do not spawn agents by default.
- Regression gate: `npm run check` must exit 0 after each integrated phase. Do not weaken unrelated provider/tool/MCP/ACP/cache/persistence tests to make appearance snapshots pass.
- New test files use Node's existing test runner and are discovered by `scripts/test.mjs`. Direct test commands below follow an initial `npm run build`; all process fixtures isolate XDG config/state and use mock providers.
- Test at 40, 80, and 120 terminal columns, a very small terminal, resize mid-stream, light/dark/terminal palettes, Unicode/ASCII, `NO_COLOR`, `TERM=dumb`, and separate stdout/stderr TTY combinations. Use deterministic virtual terminal screen/scrollback assertions plus real PTY integration; raw ANSI substring snapshots alone are insufficient.
- Matrix: success, empty response, text→tool→text, reasoning→text, malformed/rejected call, mixed batch, MCP/custom tool, compaction, provider error, cancellation, EOF, and restart/history replay.
- Record exact source commit, commands, packed-consumer result, and representative rendered transcripts in `docs/evidence/terminal-output.md`. No paid-model calls, CI activation, or live installation is necessary.

## Plan Review

Status: APPROVE (plan self-review, 2026-09-26). User authorized implementation on 2026-09-26.

- Intent fidelity: covers the accepted layout, semantic colors/icons, configurable density, genuine syntax highlighting, context/resume footer, and shared REPL/history presentation. Excludes unrequested full-screen UI, policy changes and publication.
- Integration review: traced config parsing, canonical tool provenance, agent/store atomic display writes, replay/ACP, `/clear` session identity, usage coverage, packaging and the shipped configuration skill.
- Anti-shortcut review: source preservation/chunk-split tests, rendered-screen assertions, generic-tool provenance tests, unchanged provider/cache assertions, and installed-consumer checks reject cosmetic-only implementations.
- Scope/phase review: six dependent commit boundaries, each with documentation, red tests, production obligations and full local regression gates. Required phase sections and existing test paths verified.
- Resumability: phases have explicit prerequisites and independent build gates; schema change is deliberate and one-time. No legacy fallback/migration or automatic user-state deletion.
- Review corrections: distinguish cache-field coverage from ratio coverage; require actual shared-terminal identity for redraw; preserve skill load caps and installed documentation availability.
- No independent peer review has been requested or claimed for this plan.

## Phase 1: Display options, theme primitives, and terminal test harness

Status: complete (2026-09-26). Implementation self-review: APPROVE.

### Goal
Establish strict host-only settings and a testable palette/layout/writer foundation.

### Current behavior and gap
`textRun` contains inline SGR handling; root config has no display settings. Tests can launch a PTY but cannot yet model screen state or resize reliably.

### Evidence
`src/config.ts:RawFlags/RuntimeConfig/parseConfigDocument/parseCliArgs/loadConfig`; `bin/raw.ts:help/run`; `src/cli.ts:textRun`; `tests/fixtures/pty-bridge.py`; `tests/config.test.ts`.

### Pattern
Follow strict `keys`/enum parsing, frozen runtime values, dependency-injected clocks and existing subprocess fixtures. UI-only parsing for history follows the no-provider behavior of existing session commands.

### Dependencies
None. The baseline tests already passed; do not repeat discovery or rewrite existing setup skills wholesale.

### Files and symbols
Modify `src/config.ts`, `bin/raw.ts`, `tests/config.test.ts`, `tests/config-v2.test.ts`, `tests/fixtures/pty-bridge.py`; add `src/terminal/options.ts`, `theme.ts`, `layout.ts`, `writer.ts`, `tests/terminal-options.test.ts`, `tests/terminal-layout.test.ts`, and `tests/fixtures/terminal-screen.ts`. Add only the layout dependencies needed now to `package.json`/lockfile.

### Behavioral contract
Implement the complete configuration/color/icon precedence above. Expose independent per-stream capabilities and a writer that suspends transient rows before permanent output/input. Width calculations count graphemes/terminal cells rather than JS string length. Implement semantic roles and all ASCII fallbacks; no production event-renderer switch yet.

### Documentation
Update `docs/configuration.md` and CLI help with the new settings, defaults and host-only ownership. Add `docs/terminal-output.md` with the visual and stream contract. Update the `configure_raw` skill root schema/UI reference in the same phase; keep its English body within the existing 8,192-byte selected-skill limit by editing for concision or moving extended examples to the installed terminal guide, without dropping required schema guidance. If referencing that guide, add it to package files now so this phase has no dangling installed reference. Regenerate shipped skill copies through the normal build.

### Tests first
Reject invalid types/enums/roles, unknown keys, duplicate flags and missing values. Assert config/flag precedence, immutable settings, default reasoning by density, independent TTY channels, explicit color versus `NO_COLOR`, redirected `always`, and `TERM=dumb`. Width tests cover combining Vietnamese text, CJK, emoji, ANSI, long paths and small columns. Test writer cleanup and suspend/resume with a fake scheduler.

### Anti-shortcut coverage
A stderr TTY must not color redirected stdout. Merely adding constants without wiring config/CLI parsing fails precedence tests. Plain-mode tests reject all generated escape sequences, not just a selected color code. Load history display options without credentials or a valid model selection.

### Implementation obligations
Keep display resolution independent of prompt/credential/plugin loading. Build a bounded writer with deterministic timer disposal; add PTY resize/mixed-descriptor support without changing existing fixture defaults. Provide screen assertions that evaluate cursor movement, not only strip ANSI.

### Acceptance criteria
- [x] AC-1.1: Valid UI configs/flags resolve exactly as specified and invalid inputs fail before provider work — options/config tests.
- [x] AC-1.2: Semantic roles/icons and width handling render at the required widths without escape leakage or broken Unicode — layout/screen tests.
- [x] AC-1.3: Existing model/config/MCP behavior and shipped skill loading remain green — full regression gate.

### Focused verification
`npm run build`

`node --import tsx --test tests/terminal-options.test.ts tests/terminal-layout.test.ts tests/config.test.ts tests/config-v2.test.ts tests/bundled-skills.test.ts`

Expected: all pass; no provider/network traffic.

### Phase gates
`npm run check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: add terminal display preferences and semantic themes`

## Phase 2: Structured display records and durable tool previews

Status: complete (2026-09-26). Implementation self-review: APPROVE.

### Goal
Make live and replayed tool presentation consume the same bounded semantic data.

### Current behavior and gap
CLI history stores JSON argument strings and flattened previews, losing file/code structure. Display formatting is imported into agent persistence. Built-in dispatch identity is available internally but current preview specialization uses names alone.

### Evidence
`src/agent.ts:execute/emit/appendResult`; `src/sessions/display.ts:toolArguments/resultPreview/renderStoredHistory/storedAcpUpdates`; `src/sessions/store.ts:VisibleRecord`; `src/sessions/schema.ts:SESSION_SCHEMA_VERSION`; `src/tools/registry.ts:ToolRegistration/definitions`; `src/tools/primitives.ts:readFileTool`.

### Pattern
Use existing atomic `commitMessage`/visible-history paths and detached `RunEvent` data. Reuse existing write-argument projection and batch result shapes; add a narrow read-only canonical-identity accessor to the registry rather than changing model definitions.

### Dependencies
Phase 1. No highlighting dependency in these modules.

### Files and symbols
Add `src/sessions/visible.ts`, `tests/terminal-records.test.ts`; modify `src/agent.ts`, `src/sessions/display.ts`, `src/sessions/store.ts` types as needed, `src/sessions/schema.ts`, `src/tools/registry.ts`, `src/cli.ts` current plain adapters, and affected session/preview tests. Retire the CLI re-export of `resultPreview` if replaced; update internal test imports instead of retaining a compatibility shim.

### Behavioral contract
Implement the typed call/result/status projection, canonical provenance, bounded source segments, per-row state, omission markers and observed execution duration. Bump session schema to 5 once; old databases fail without mutation. Keep ACP-native updates and CLI-to-ACP replay legal and style-free. Until the richer renderer lands, adapt the current plain output to the new records so this phase is independently runnable.

### Documentation
Update `docs/cli.md`, `docs/context.md`, `docs/configuration.md` with preview-body versus summary budgets and unreleased session incompatibility. Document that changing theme does not change schema version.

### Tests first
Persist/reopen read batches and compare path/code segments with live projection; preserve head/tail, Unicode boundaries and every bounded batch row status. Exercise rejected long Bash commands, invalid write argument keys, empty/image/generic JSON results, and a custom tool impersonating a built-in name. Verify history after compact can render retained previews without opening model payloads. Test v4 rejection with unchanged database bytes/version.

### Anti-shortcut coverage
Reject implementations that store colored output, parse escaped JSON previews to recover code, persist full write payloads/images, guess built-ins by name, or discard a later failed batch row. Capture next provider request and assert the exact structured tool result is unchanged. Compare ACP live/replay payloads independently of CLI formatting.

### Implementation obligations
One pure display projection supplies both live presentation and stored records. Measure tool time outside UI callbacks. Adapt store/history consumers and remove legacy CLI payload-shape branches; do not delete ACP surface handling. No SQL migration or user database cleanup command runs automatically.

### Acceptance criteria
- [x] AC-2.1: Stored display records retain bounded code/path/state data and replay independently of model context — records/session tests.
- [x] AC-2.2: Tool provenance prevents custom/MCP misclassification and all batch statuses survive truncation — projection tests.
- [x] AC-2.3: Schema 5 works across processes; schema 4 is rejected without mutation; ACP/provider payloads are unchanged — store/session/ACP tests.

### Focused verification
`npm run build`

`node --import tsx --test tests/terminal-records.test.ts tests/cli-preview.test.ts tests/session-store.test.ts tests/session-cli.test.ts tests/session-acp.test.ts tests/batch-integration.test.ts`

Expected: all pass, including negative schema/provenance cases.

### Phase gates
`npm run check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`refactor: persist structured terminal display records`

## Phase 3: Streaming Markdown and syntax highlighting

Status: complete (2026-09-26). Implementation self-review: APPROVE.

### Goal
Build and qualify readable Markdown/code rendering before attaching it to the full CLI lifecycle.

### Current behavior and gap
Assistant text streams unformatted; result previews are plain/dim. No parser, grammar registry or chunk-boundary tests exist.

### Evidence
`src/cli.ts:textRun` text/reasoning branches; `src/sessions/visible.ts` from Phase 2; `package.json`, `tsup.config.ts`, `tests/fixtures/mock-provider.ts`.

### Pattern
Pure formatters plus the Phase 1 writer/clock seam; use public Marked/Lowlight APIs and exact dependency pins, not custom syntax regexes.

### Dependencies
Phases 1–2. Add `marked`/`lowlight` dependencies here; validate their supported Node version and public exports.

### Files and symbols
Add `src/terminal/markdown.ts`, `highlight.ts`, `tests/terminal-markdown.test.ts`, `tests/terminal-highlight.test.ts`, and representative fixtures under `tests/fixtures/terminal/`; modify package manifests/build only as needed for reliable packaging.

### Behavioral contract
Implement the supported Markdown/language set, semantic syntax spans, code/path language selection, diff styling, narrow tables and bounded incremental-tail design above. Plain redirected stdout is a bypass, not rendered Markdown with ANSI stripped afterward. Formatting failures use source-preserving fallback.

### Documentation
Extend `docs/terminal-output.md` with language aliases, plain/unknown behavior, streaming/fallback limits and copyability. Record dependency rationale and package compatibility evidence.

### Tests first
Use recognizable keyword/string/comment/number examples and inspect distinct semantic spans, not just any ANSI presence. Feed identical source all at once, one character at a time and at fence/token/Unicode boundaries. Cover unclosed and empty fences, tilde fences, language aliases, multiline comments/strings, inline code/emphasis/links, lists/quotes/tables, raw HTML, diff headers and `+/-` lines. Exercise unknown grammars, formatter exceptions, >32 KiB blocks, no newline, tool handoff and cancellation.

### Anti-shortcut coverage
The final rendered source must contain each code character exactly once after removing layout decoration; a single color around a whole code block is insufficient. A fake scheduler must observe partial prose/code before stream completion. Large-block tests verify bounded pending storage and forward progress. Width tests inspect visible cells and scrollback, not ANSI string length. Ensure literal ANSI/control input cannot move the renderer's cursor on styled paths; raw redirected assistant bytes retain their existing pass-through contract.

### Implementation obligations
Use token trees for styling, bounded parser state, deterministic flush and style resets. Register/verify required grammars and aliases; unknown languages degrade plainly. Keep raw source separate from display spans. Do not add hidden model calls, full-transcript repaints, unbounded token-per-delta parsing, or ANSI to saved text.

### Acceptance criteria
- [x] AC-3.1: Required languages have genuine multi-token syntax styling; unknown languages remain readable — highlighting tests.
- [x] AC-3.2: Chunk splits, incomplete syntax, interruption and overflow retain all source exactly once with timely display — streaming tests.
- [x] AC-3.3: Markdown/code/tables remain readable across widths/themes/plain modes and formatter failure cannot fail a run — layout/fallback tests.

### Focused verification
`npm run build`

`node --import tsx --test tests/terminal-markdown.test.ts tests/terminal-highlight.test.ts tests/terminal-layout.test.ts`

Expected: all pass with deterministic clock and token/screen assertions.

### Phase gates
`npm run check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: render streaming Markdown with syntax highlighting`

## Phase 4: Live renderer, tool activity, and input-safe status presentation

Status: complete (2026-09-26). Implementation self-review: APPROVE.

### Goal
Replace scattered writes in the live run with the approved visual hierarchy and shared formatters.

### Current behavior and gap
`textRun`, `askPermission`, interrupt and compact branches own independent output and newline state. This can conflict with transient streaming rows and readline. Rich modules from earlier phases are not yet integrated.

### Evidence
`src/cli.ts:textRun/askPermission/statusCode/runCli`; `src/agent.ts:RunEvent`; `tests/cli.test.ts` PTY/newline/approval/cancellation cases; Phase 2 call/result records.

### Pattern
One terminal renderer per active CLI session owns output coordination; `runCli` retains agent/input ownership. Reuse fresh-line approval semantics and existing exit mapping.

### Dependencies
Phases 1–3.

### Files and symbols
Add `src/terminal/tools.ts`, `renderer.ts`, `tests/terminal-renderer.test.ts`, `tests/terminal-cli.test.ts`; refactor `src/cli.ts` and startup/resume output in `bin/raw.ts`; adapt existing `tests/cli.test.ts` appearance assertions while retaining behavioral oracles.

### Behavioral contract
Wire the header, assistant Markdown, reasoning modes, tool type/state icons, per-density previews, live duration/status and compact notices. Use actual canonical tool identity and generic fallbacks. Show arguments before execution/approval. Suspend animation/tail state around tools, prompts and errors. Only use in-place redraw when terminal ownership is established; otherwise append clear transitions. No assertion that arbitrary assistant segments are final answers.

### Documentation
Update `docs/cli.md` and `docs/terminal-output.md` with normal/compact/verbose examples, reasoning defaults, error/approval layout, and stream routing.

### Tests first
PTY runs cover reasoning→assistant, partial text→tool→text, multiple calls, partial batches, read-code previews, custom/MCP tools, empty results, approval-required/rejected paths, compact status, provider error and Ctrl-C during code/tool/reasoning. Assert command visibility precedes execution and policy behavior is unchanged. Test stdout pipe + stderr TTY, inverse descriptors and separate terminals with no unsafe cursor coordination.

### Anti-shortcut coverage
Mock-provider request bodies must match across UI settings after excluding only documented nondeterministic transport fields; compare raw tool content/schema order exactly. No-header/tool-label/color leakage to redirected stdout. Simulated terminal must show no stale spinner, overwritten answer, duplicate code or lost prompt after interruption/resize. A result with mixed statuses must remain visibly mixed.

### Implementation obligations
Remove duplicate formatting/write ownership from `textRun`, status, compact and signal handlers. Input coordination must retain buffered REPL lines, fresh approval answers and default-no behavior. Display-only failures recover as plain text; I/O failures follow existing error handling. Dispose timers/listeners in existing `finally` cleanup.

### Acceptance criteria
- [x] AC-4.1: One-shot TTY output implements the approved hierarchy, icons/themes and highlighted code across all density modes — screen/PTY tests.
- [x] AC-4.2: Approval/cancellation/EOF preserve behavior and leave terminal/input state clean — CLI/PTY tests.
- [x] AC-4.3: Pipes, model requests, tools, MCP and ACP retain their contracts — cross-mode assertions/full regression.

### Focused verification
`npm run build`

`node --import tsx --test tests/terminal-renderer.test.ts tests/terminal-cli.test.ts tests/cli.test.ts tests/batch-integration.test.ts tests/mcp-content.test.ts tests/acp.test.ts`

Expected: all pass, including chronological screen assertions and unchanged-provider requests.

### Phase gates
`npm run check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: present tool activity through the shared terminal renderer`

## Phase 5: Session footer, REPL statistics, and history replay

Status: complete (2026-09-26). Implementation self-review: APPROVE.

### Goal
Complete the same visual language across saved-session outcomes, REPL commands and history pages.

### Current behavior and gap
Footer is success-only and line-oriented; REPL `/stats` is JSON; history has an independent renderer. `/clear` needs active-record synchronization before new footer behavior uses it.

### Evidence
`src/cli.ts:runCli` one-shot footer and REPL branches; `bin/raw.ts` session-show/resume branches; `src/sessions/display.ts:renderStoredHistory/storedAcpUpdates`; `src/agent.ts:estimatedContextTokens/stats/execute` budget calculation; `src/llm/cache.ts:summarizeUsage`; `tests/session-cli.test.ts`, `tests/repl.test.ts`.

### Pattern
Reuse existing estimates/usage coverage and session IDs, extract the existing compact budget arithmetic without behavior change, and use the same semantic renderer for complete saved blocks. Read-only history stays independent of agent/model startup.

### Dependencies
Phases 1–4.

### Files and symbols
Add `src/terminal/footer.ts`, `tests/terminal-footer.test.ts`, `tests/terminal-history.test.ts`; modify `src/cli.ts`, `bin/raw.ts`, `src/sessions/display.ts`, `src/agent.ts`, `src/llm/cache.ts:UsageSummary/summarizeUsage`, and session/REPL/usage tests. Place the extracted pure input-budget helper in `src/llm/context.ts` (new internal module), called from both agent compaction and footer formatting. Add only aggregate cache read/write coverage; do not add pricing or new normalized provider usage fields.

### Behavioral contract
Implement footer/REPL/history contracts above. Resume advice uses the active durable record after clear; partial request coverage is labeled truthfully. Known startup/persistence failures never claim a resumable session. Replay uses retained structured previews, durations and unstyled assistant text; no live activity. Session-show options do not require provider credentials. Keep older-page cursors and orphan results readable.

### Documentation
Update `docs/cli.md`, `docs/context.md`, `docs/terminal-output.md` with metric scope, coverage/unknown rules, budget colors, exit/resume behavior and restart/history examples. Correct any conflicting legacy `/clear` descriptions encountered in these affected sections.

### Tests first
Cover unknown window, 0 input, missing versus explicit-zero usage, partial input/output/cache coverage, resumed cumulative usage, estimates above budget/window, long IDs and narrow widths. Verify success/error/cancel/max-steps outcomes and no-session/persistence-error exceptions. REPL tests exercise clear→new task→stats→exit, compact threshold, buffered input and SIGINT/EOF. Restart history with changed theme/density and compare retained content/state; page beginning with a result must work.

### Anti-shortcut coverage
Changing only `ui` between save and resume preserves cache key/context revision and effective request prefix. `/stats`/history/footer cause zero provider calls. Post-clear continuation must resume the new ID, not the pre-clear record. Missing cache ratio never appears as 0%; input+cache read is not double-counted. ACP-origin history remains viewable; CLI-origin ACP replay stays protocol-valid.

### Implementation obligations
Bind timing/record state to the active session and turn, keep footer emission single and centralized, and make history a static renderer path. Extract the effective input-budget calculation once and run existing compact tests to prove behavior unchanged. Do not try to diagnose general session recoverability by starting inference.

### Acceptance criteria
- [x] AC-5.1: All saved-session outcomes show truthful status/context/usage and valid continuation when appropriate — footer/process tests.
- [x] AC-5.2: REPL statistics, clear and resume use the correct active state without extra provider requests — REPL/session tests.
- [x] AC-5.3: History preserves readable highlighted content under different display settings and paging without changing model/cache state — history/ACP/cache tests.

### Focused verification
`npm run build`

`node --import tsx --test tests/terminal-footer.test.ts tests/terminal-history.test.ts tests/session-cli.test.ts tests/session-acp.test.ts tests/repl.test.ts tests/cache.test.ts tests/compact.test.ts tests/usage.test.ts`

Expected: all pass; read-only presentation creates no inference requests.

### Phase gates
`npm run check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`feat: unify session footers statistics and terminal history`

## Phase 6: Visual qualification, installed-consumer coverage, and documentation

Status: complete (2026-09-26). Implementation self-review: APPROVE.

### Goal
Qualify the complete design in the actual built/installed CLI and make its configuration understandable to users and the shipped setup agent.

### Current behavior and gap
Earlier phases establish isolated/integration behavior; package asset loading, terminal combinations and overall visual quality still require end-to-end evidence.

### Evidence
`tests/package.test.ts`, `tests/package-agent.test.ts`, `scripts/test.mjs`, `tsup.config.ts`, `src/skills/bundled/configure_raw/SKILL.md`, `docs/verification.md`, `README.md`.

### Pattern
Extend existing temporary packed-consumer installation and mock-provider/PTY fixtures. Keep tests local and deterministic. Generated skill/example files come from existing build scripts, not hand-maintained divergent copies.

### Dependencies
Phases 1–5.

### Files and symbols
Modify `tests/package.test.ts` and/or `tests/package-agent.test.ts` to cover installed syntax dependencies and no-color output; add `scripts/preview-terminal.mjs` for a deterministic no-network renderer gallery; finish `docs/terminal-output.md`, `docs/evidence/terminal-output.md`, `docs/verification.md`, README and affected setup-skill references. The preview script is a developer tool, not a new public CLI command.

### Behavioral contract
The packed CLI outside the checkout renders code/tools/footer with the chosen theme and still imports the library and runs MCP/ACP. Preview gallery exercises the production renderer with recorded synthetic events and fixed clock/IDs. Instructions accurately describe flags, root `ui`, defaults, limitations and the schema break. No renderer dependencies are accidentally required by model-only paths through eager initialization.

### Documentation
Capture representative normal, compact, verbose, light/dark, ASCII and narrow output, plus error/approval/history examples. Document real limitations such as unknown grammar and very-large-block plain fallback. Keep the configuration skill complete, English and under its existing load cap; update its packaged/examples copies through build. Add terminal docs to package files if the skill references them as installed resources.

### Tests first
Packed-consumer test executes a highlighted TTY response and read preview, then a redirected command with byte-exact stdout and no escapes. Verify installed docs/assets resolve outside the repo. Add gallery smoke coverage only for meaningful missing paths; use existing behavior tests rather than tests that merely mirror example strings.

### Anti-shortcut coverage
A source-only pass cannot substitute for an installed dependency-resolution test. Review actual rendered screens in light and dark terminal settings; strip-ANSI snapshots alone cannot qualify palette readability. Fixture identifiers/timing are deterministic, and examples never depend on the user's config/session state or a live provider.

### Implementation obligations
Run the full matrix and local package gate, fix actual readability/integration failures, record exact evidence and update this plan's checkboxes/reviews. Inspect diff for accidental provider/schema-policy changes. Leave GitHub Actions disabled and leave the user's global installation/config/database untouched.

### Acceptance criteria
- [x] AC-6.1: Built and packed installed CLI pass the visual/pipe/dependency matrix outside the checkout — package tests and evidence report.
- [x] AC-6.2: README/help/config docs and the shipped configure skill agree with actual UI schema and behavior — parser/example/skill tests plus inspection.
- [x] AC-6.3: Complete repository regression suite passes and recorded visual inspection confirms readable themes/icons/code/layout — local check and evidence report.

### Focused verification
`npm run test:package`

`node scripts/preview-terminal.mjs --width 40 --theme light --icons ascii`

`node scripts/preview-terminal.mjs --width 80 --theme dark --icons unicode`

`node scripts/preview-terminal.mjs --width 120 --theme terminal --icons unicode`

Expected: package tests exit 0; gallery runs without config/network and produces readable, bounded layouts. Redirecting gallery output produces plain text, so inspect colors in a TTY.

### Phase gates
`npm run check`

`git diff --check`

### Review
Implementation review is required; verdict must be APPROVE.

### Commit
`test: qualify terminal themes highlighting and installed output`

## Completion Criteria

- [x] All six phases and their acceptance criteria pass with implementation review APPROVE and cohesive commits.
- [x] One-shot, REPL and saved history share consistent header/text/tool/status/footer formatting, semantic themes/icons and genuine code highlighting.
- [x] Streaming remains progressive and source-preserving under chunk splits, resize, incomplete syntax, tool transitions and interruption.
- [x] Redirected stdout, model requests/cache identity, policies, MCP and ACP preserve their contracts.
- [x] Metrics are scoped/truthful; context estimates and coverage are explicit; continuation uses the active durable session.
- [x] New display records use schema 5, old sessions fail clearly without migration/deletion, and ordinary UI changes do not affect schema or cache identity.
- [x] Full local checks, installed-consumer evidence, documentation and setup-skill updates are complete; no CI enablement/global install/user-state mutation occurred.

## Progress Log

- 2026-09-26: User approved terminal layout/colors/icons and explicitly requested syntax highlighting, then invoked `$loop-plan`.
- 2026-09-26: CTXE readiness/terminal integration inspected; source, flags, history/ACP boundaries, tests and build commands verified. Local baseline: 334/334 tests pass.
- 2026-09-26: Drafted six phases and completed intent/integration/test/phase self-review: APPROVE. Corrected cache coverage, shared-terminal detection, and packaged skill-reference requirements. Implementation has not started; awaiting user approval.
- 2026-09-26: User approved implementation. Phase 1 in progress.
- 2026-09-26: Phase 1 complete, implementation self-review APPROVE. Red options/layout tests failed before code; focused tests passed. `npm run build` passed; `npm run check` passed 340/340 after final Phase 1 edits. PTY bridge now supports test resize, semantic theme/options are host-only, and configure skill remains 8,154 bytes. Evidence: `/tmp/raw-terminal-phase1-red.log`, `/tmp/raw-terminal-phase1-focused.log`, `/tmp/raw-terminal-phase1-final-check.log`.
- 2026-09-26: Phase 1 commit `ba16093`; Phase 2 in progress.
- 2026-09-26: Phase 2 complete, implementation self-review APPROVE. New record tests were red before production code; isolated focused suite passed 35/35, repair-focused suites passed 60/60, and final `npm run check` passed 346/346. Repaired the crash-recovery writer found by full regression and preserved head/tail under a near-budget preview. One direct focused invocation inherited the user's old global schema; it was stopped and rerun with isolated XDG state. Evidence: `/tmp/raw-terminal-phase2-red.log`, `/tmp/raw-terminal-phase2-final-focused.log`, `/tmp/raw-terminal-phase2-repair-focused.log`, `/tmp/raw-terminal-phase2-head-check.log`.
- 2026-09-26: Phase 2 commit `79d2619`; Phase 3 in progress.
- 2026-09-26: Phase 3 complete, implementation self-review APPROVE. Pinned Marked 18.0.14 and Lowlight 3.3.0 (public lexer/HAST APIs). Focused syntax/Markdown/layout suite passed 9/9; `npm run check` passed 352/352. Incremental formatter reparses only the bounded active block, displays partial frames immediately, and falls back to literal text after 32 KiB. Evidence: `/tmp/raw-terminal-phase3-red.log`, `/tmp/raw-terminal-phase3-focused3.log`, `/tmp/raw-terminal-phase3-check.log`.
- 2026-09-26: Phase 3 commit `2640e6b`; Phase 4 in progress.
- 2026-09-26: Phase 4 complete, implementation self-review APPROVE. Introduced one event renderer for rich and append-only CLI paths, semantic tool formatter, bounded transient writer, explicit no-color ASCII presentation, and control-byte display escaping. Screen/PTY tests cover final visible scrollback, densities, syntax colors, approval, cancellation, and piping. Focused CLI tests passed 31/31; final `npm run check` passed 359/359. Evidence: `/tmp/raw-terminal-phase4-red.log`, `/tmp/raw-terminal-phase4-repair.log`, `/tmp/raw-terminal-phase4-head-check.log`.
- 2026-09-26: Phase 4 commit `c4e5ebb`; Phase 5 in progress.
- 2026-09-26: Phase 5 complete, implementation self-review APPROVE. Extracted the effective context budget, added honest usage/cache coverage, and unified one-shot/REPL footers and static history rendering. The final `npm run check` passed 367/367; `/clear` uses its new durable ID, UI changes retain request cache identity, and persistence failures omit resume advice. Evidence: `/tmp/raw-terminal-phase5-final-focused.log`, `/tmp/raw-terminal-phase5-head-check2.log`.
- 2026-09-26: Phase 5 commit `6ab62f8`; Phase 6 complete, implementation self-review APPROVE. Packed CLI TTY read/answer syntax and plain redirected byte contract passed 2/2 package tests; source regression passed 368/368. Fixed compact/resumed headers, explicit context warning labels and verbose canonical identity after red focused tests. Gallery inspected in 40/80/120 columns and light/dark/terminal themes with NO_COLOR behavior. Source commit `0945f1c`; detailed evidence in `docs/evidence/terminal-output.md`. No CI/global installation/user state changes.
- 2026-09-26: Final integration repair `9ede783`: lazy CLI/history chunks keep Marked/Lowlight out of ACP startup. Two eager-bundle full runs exposed a 2-second ACP initialization timeout under parallel load; the focused ACP suite passed independently. After the repair, full `npm run check` passed 368/368 and installed-consumer `npm run test:package` passed 2/2. Final source and artifact hashes are in `docs/evidence/terminal-output.md`.
