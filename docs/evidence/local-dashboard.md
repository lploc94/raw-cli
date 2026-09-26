# Local dashboard qualification

This report is in progress. The chat layer is verified below; management, package workflows, all-engine final gates and installed-artifact qualification are completed in the remaining implementation phases.

## Browser chat layer

Host: macOS 26.6.2, arm64, Node 26.0.0. Chromium 153.0.8010.12. Tests use temporary XDG roots, a localhost mock provider and real owned Bash/MCP fixtures. No personal Raw config or paid provider is used.

- Build/typecheck and the complete Node suite passed: 513/513.
- Chromium browser scenarios passed: 25/25. Coverage includes shared history, genuine supplied reasoning, highlighted Markdown, tool arguments/results, conditional Allow/Deny, reconnect and lost submit receipts, late responses, IME/send mode, Stop, compact outcomes, history pagination, and preference/cache isolation.
- Legacy tool IDs reused in distinct user turns remain separate. Historical preview abbreviation is distinguished from tool truncation.
- Browser errors and CSP violations were checked. Bundled library styles receive a per-document nonce; inline scripts and unrelated inline styles remain blocked.
- Accessibility scans cover light/dark, desktop/tablet/narrow layouts. Keyboard checks cover palette dismissal/focus restoration, panel resizing and narrow-inspector focus containment. Visible targets and horizontal clipping are asserted, including every navigation target at 320 CSS px.
- The screenshot run uses reduced motion and reports no page errors or horizontal overflow at 1440×900, 800×900 and 320×900. Desktop/tablet/narrow screenshots and the inspector were visually inspected. A clipped narrow Settings label was found through image review and corrected with a bounding-box regression.

The 320 CSS px checks are reflow evidence, not a claim that native browser zoom or a screen reader was exercised. Full final qualification and its remaining manual limitations will be recorded below. Automated accessibility scans alone do not establish full WCAG conformance.

Screenshots and their reproduction command are in [the dashboard guide](../dashboard.md#layout-examples). Source-server checks do not substitute for the later installed-artifact test.

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
