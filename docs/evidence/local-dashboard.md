# Local dashboard qualification

The eight-phase dashboard implementation and its final committed-HEAD gates are complete.
The phase qualification results below are actual runs on macOS 26.6.2 (25G83),
arm64, Node 26.0.0. Linux and Windows were not qualified in this work. GitHub
Actions stayed disabled; no global install, personal Raw config edit or publication
was performed.

## Phase 8 gates

| Command | Result |
| --- | --- |
| `npm run check` | 532 Node tests passed, including installed CLI/SDK/ACP and dashboard coverage; both TypeScript projects and build passed |
| `npm run test:web` | 114 passed: 38 each on Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 |
| `npm run test:package` | 4 installed-consumer tests passed |
| `git diff --check` | Passed |

Logs were inspected at `/tmp/raw-dashboard-phase8-{check,all-engines,package}.log`.
An initial browser run had two ambiguous test locators where both the config
summary and editor exposed an alert. Scoping the assertion to the active editor
fixed the test; no product behavior was weakened. Only the subsequent complete
passing run qualifies the three engines.

## Installed delivery

`tests/dashboard-installed.test.ts` packs the current installation, installs it
with production dependencies in an unrelated temporary consumer, and launches its
actual `.bin/raw dashboard --port 0 --no-open` from another workspace. The browser
blocks requests to every origin except this server. No Vite is installed in the
consumer, and all three static/lazy asset files load locally.

The browser initializes the shared six-skill starter, edits a model connection,
inspects and installs an authored package, creates a typed agent binding, sends a
turn and reloads during a real tool's file effect. It verifies one effect, updates
the package, deletes its authored source, continues the same session, shuts down
the host and resumes that ID with the installed CLI. The changed package rotates
the runtime key once; the unchanged CLI follow-up keeps the key, tool schema and
prior message prefix. Two effects remain exactly two after reconnect/resume.

All six installed skills link to their shipped dashboard references. Source,
generated examples and installed bodies are checked, including the default 8 KiB
body limit. Actual model instruction-following quality is not inferred from mock
provider tests.

Pre-commit qualification ran on `79ab9b2` plus the Phase 8 worktree. The final
focused installed run used these exact bytes:

| Item | SHA-256 |
| --- | --- |
| npm archive | `cf0a763cf4a650a5c2c8a11676293ff0dd5164cd31173e2efff436d7075eacb5` |
| Executable-source manifest | `b16bd115aed62899d01870949c618e7d6dbc89f37827dbf0178cd27b18eff378` |
| Consumer dependency lock | `29c71c8f2c4c9fe73516cdde30ba0561ae8e2fd99191093d10031647a894f23d` |

The source manifest covers sorted paths and file bytes in `src`, `bin`, `web`,
`scripts`, package manifests and build/typecheck configs. The consumer lock hash
identifies that installation, including its temporary archive reference; it is not
a claim that separate temporary installs have identical lock bytes. The test loads
`index-B5k4LgUS.js`, `index-CUYdKA_J.css` and `CodeEditor-DIQqnq0-.js` from the packed
app and reports all three successful loads. A later rebuild does not substitute
for these tested bytes. Final committed-HEAD qualification follows below.

## Browser chat layer

Host: macOS 26.6.2, arm64, Node 26.0.0. Chromium 153.0.8010.12. Tests use temporary XDG roots, a localhost mock provider and real owned Bash/MCP fixtures. No personal Raw config or paid provider is used.

- Build/typecheck and the complete Node suite passed: 513/513.
- Chromium browser scenarios passed: 25/25. Coverage includes shared history, genuine supplied reasoning, highlighted Markdown, tool arguments/results, conditional Allow/Deny, reconnect and lost submit receipts, late responses, IME/send mode, Stop, compact outcomes, history pagination, and preference/cache isolation.
- Legacy tool IDs reused in distinct user turns remain separate. Historical preview abbreviation is distinguished from tool truncation.
- Browser errors and CSP violations were checked. Bundled library styles receive a per-document nonce; inline scripts and unrelated inline styles remain blocked.
- Accessibility scans cover light/dark, desktop/tablet/narrow layouts. Keyboard checks cover palette dismissal/focus restoration, panel resizing and narrow-inspector focus containment. Visible targets and horizontal clipping are asserted, including every navigation target at 320 CSS px.
- The screenshot run uses reduced motion and reports no page errors or horizontal overflow at 1440×900, 800×900 and 320×900. Desktop/tablet/narrow screenshots and the inspector were visually inspected. A clipped narrow Settings label was found through image review and corrected with a bounding-box regression.

The separate native macOS smoke uses a disposable headed Chromium profile and
actual Cmd-plus zoom: 1280×913 at 100% becomes 320×228 CSS pixels at 400%, with a
device-pixel-ratio change from 1 to 4 and no document-level horizontal overflow.
Sending and receiving chat remains reachable through vertical scrolling. The
complete browser-view bitmap was visually inspected; a CSS-sized surface capture
had cropped it and was replaced with a native view capture.

A user-observed VoiceOver smoke ran with native macOS permission on the same
Chromium page. The user confirmed hearing both “Message” and “Session details”
when focus moved to the editor and button. The owned browser and reader then
closed; the reader's stopped state was checked. Automated speech extraction via
AppleScript timed out or returned unavailable output on this host, so it is not
reported as a passing automated assertion. `native-smoke.ts --voiceover` now drives
the two listening positions and explicitly requires a separately recorded human
verdict. The native driver finished successfully, and the user supplied that
verdict in this session on 2026-09-26.

Automated accessibility scans and this bounded manual smoke do not establish full
WCAG conformance or comprehensive assistive-technology coverage.

Screenshots and their reproduction command are in [the dashboard guide](../dashboard.md#layout-examples). Source-server checks do not substitute for the installed-artifact test.

## Management layer

The authenticated HTTP tests cover actual config/source writes and fixed-revision
conflicts, strict repair, legal resource names, read-only forks, detach-before-delete,
no passive imports, explicit var access, MCP discovery/cancellation and diagnostic
allowlists. A running real tool retains its imported helper snapshot while its
helper, selected skill and prompt are edited; the next turn sees the edits and an
unchanged third turn preserves its prefix on the same session ID.

Chromium management/Settings scenarios cover creating and running a composed agent,
forking/attaching skills, editing tool code without importing it until a turn starts,
vars definitions/read, MCP definitions/discovery/exact selection, model edits and
credential keep/clear, setup/repair, key-based Settings search, stale draft review,
Ctrl/Cmd-S and Back/Discard history behavior. Editors pass light/dark accessibility
scans and 320 CSS px reflow with no CSP/page errors. Three management screenshots
were visually inspected; reproduction is in the dashboard guide. Source edits and
browser credentials remain in editor memory, outside the preferences store.

## Package layer

Real HTTP/archive tests cover mixed and standalone exports, typed recipient inputs,
passive install without model credentials, source removal before activation,
source-independent export/download/reinstall/run, package update on the same
session with a stable unchanged follow-up, failed update rollback, linked-source
inspection and independent forks. Guards include selections in package-agent
overrides when reporting removal/update dependents. Oversized, malformed and
interrupted uploads leave no alias or temporary partial artifact; shutdown also
interrupts an unfinished JSON body before awaiting file cleanup.

Chromium tests drive inspect → install → bind → chat → export → download → upload
and keep invalid update/removal errors in their dialogs. All package code executes
only when a selected agent starts a turn or an explicit var/MCP check runs.
A package inspection screenshot was visually reviewed alongside semantic tests.


## Contract and ownership audit

| Plan boundary | Evidence |
| --- | --- |
| One agent loop/store, format 5, passive history | `session-operations`, `session-view`, existing session/ACP tests and `dashboard-sessions` |
| One writer, durable acceptance, no replay after crash/reconnect | Process/sentinel tests, lease/receipt tests, HTTP streams, browser reconnect and installed consumer |
| Current config on the next turn; stable unchanged prefix | Management source/helper/prompt/skill snapshot tests, package update tests and installed browser-to-CLI flow |
| Explicit skill loading and conditional policy | Existing skill/policy suites, passive sentinels, HTTP approval lifecycle and browser Allow/Deny |
| Authoritative revision-checked config/files; passive catalogs | Shared management tests, stale-draft browser tests, explicit var/MCP checks and package sentinels |
| Loopback authentication and owned shutdown | Host/Origin/token/static-path tests, in-flight startup and MCP child reaping, partial upload/body cleanup |
| History versus active context; truthful outcomes | Compaction atomicity/rollback, historical projection, UTF-8 spooling/paging and usage coverage tests |
| Browser-only preferences and accessible navigation | Config-byte/model-prefix comparisons, keyboard/focus/reflow/contrast tests in three engines and reviewed screenshots |
| Installed assets, editors and English guidance | Installed consumer and bundled-skill tests, generated example parity and reviewed six dashboard references |

The cumulative review checked these interfaces against all phase acceptance
criteria and exclusions. CLI/ACP continue using the existing runtime; the browser
introduces no second conversation store, config format, automatic tool retry or
session compatibility gate. Package install and recipient activation remain
separate; no marketplace or remote publishing was added.


## Final committed-HEAD qualification

All commands below ran sequentially against product revision
`1766791a999c007bf88fc680fb61e0b2b1149c8f` with a clean worktree. No build overlapped a
browser run. The final installed dashboard archive is byte-identical to the final
focused pre-commit consumer above.

| Command | Result | Captured log SHA-256 |
| --- | --- | --- |
| `npm run check` | 532/532, build and both typechecks passed | `42cf49731b51ebaa537b0a8fab883f1a24e438d26e8f342a1b30ffece02b0d4b` |
| `npm run test:web` | 114/114 across three engines | `c0933b65716844f185576a3bdf6924e33987d9fae1999d43d858f24f4750dace` |
| `npm run test:package` | 4/4 installed consumers | `3bc0af7ef5a753c28b0bfc32899680c79d2e826ce1bb5475bf1ac02c79d5a0dd` |
| `git diff --check` | Passed | No whitespace errors |

Logs are `/tmp/raw-dashboard-final-{check,web,package}.log` on the qualification
host. The final installed run reported:

```json
{
  "sourceCommit": "1766791a999c007bf88fc680fb61e0b2b1149c8f",
  "artifactSha256": "cf0a763cf4a650a5c2c8a11676293ff0dd5164cd31173e2efff436d7075eacb5",
  "sourceManifestSha256": "b16bd115aed62899d01870949c618e7d6dbc89f37827dbf0178cd27b18eff378",
  "installedLockSha256": "c0d56d6ea17f8b264e53f7021da2236c137073832837b6599b25ab6554806dbc",
  "node": "v26.0.0",
  "platform": "darwin",
  "release": "25.6.0",
  "architecture": "arm64",
  "browser": "chromium",
  "browserVersion": "153.0.8010.12",
  "assets": [
    "CodeEditor-DIQqnq0-.js",
    "index-B5k4LgUS.js",
    "index-CUYdKA_J.css"
  ],
  "loadedAssetCount": 3
}
```

Final integration self-review: **APPROVE**. Direct source inspection resolved two
ordering concerns raised by the bounded CTXE trace (record 72):

- `SessionOperations.execute` persists/publishes `running` before calling
  `AgentSession.run`, so the first-user transaction's `running` predicate is met.
  The existing consumption/rollback tests and final full suite pass.
- Core `run_end` updates live metrics/history only; it is not a terminal operation
  SSE event. `SessionStreams.observe` publishes the terminal receipt from the
  host's operation event after runtime cleanup and durable persistence, and the
  web reducer keys completion on that operation state. Existing reconnect and
  operation tests pass. No behavior change was needed for either concern.

Every phase acceptance criterion and the plan's ownership/invariant boundaries
were mapped to the evidence above. The final bookkeeping commit changes only this
report and the plan, neither of which enters the npm artifact or executable-source
manifest. Qualification is limited to this host/runtime, these browser versions,
local mock providers and the bounded user-observed VoiceOver smoke. It is not a
paid-provider, native Linux/Windows, complete WCAG or model-behavior certification.
