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
