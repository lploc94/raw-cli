# Side panel design

This document owns how the dashboard side panel looks and behaves. It replaces the layout parts of [panels-design.md](panels-design.md) §13.1 (the stack of accordion sections) and [tool-ux-design.md](tool-ux-design.md) §6 (the VS Code-style rows). The panel contract, block kinds, HTTP routes, stream frames and opening rules of §13.1 are unchanged.

The approved mockups are kept outside the repository: they were drawn with private sample content. The gallery (`docs/dashboard/side-panel-*.png`, §10), captured from a neutral stress session, shows the result.

## 1. Why it changed

The accordion stack put every panel in one column of 28 px headers and 24 px rows that shared the height. In use it failed in three ways:

- **Nothing was readable at the default width.** Rows wrapped at 320 px, so a status glyph sat on one line and its label on the next; key/value pairs and tables broke mid-word.
- **Heights froze.** Shares were measured only when the layout changed, so a section that grew kept a stale height: Commands showed 132 px of 178 px of content, and Todo got 460 px for 420 px.
- **Rows did not explain anything.** A command was a one-line row behind a toggle, and a reader had to open each one to learn what failed and why.

The new design gives each panel the full height in its own tab, and presents each kind of content as cards made for scanning: what is running, what failed, what is next.

## 2. Visual language

The side panel follows the rest of the dashboard (the OpenAI/ChatGPT-like look of the session list and chat), not VS Code:

- **Type.** Inter (variable) for text and JetBrains Mono (variable) for code, both bundled with the dashboard under the SIL Open Font License 1.1 ([dashboard.md](dashboard.md#fonts)), so every system renders the mockups' type; no platform font is named. Body text 13 px at line height 1.45, titles 13 px at weight 550, 11 to 11.5 px muted secondary text, 11 px uppercase group labels with 0.8 px tracking.
- **Spacing.** The values of the approved mockups are the reference: the title row 52 px high, 14 px at weight 600; tabs 12.5 px in a segmented strip (5 px by 8 px, [chat-design.md](chat-design.md) §3); the tab body 12 px above and below, flush with the strip at the sides, with 8 px between cards.
- Cards: 1 px `--border`, 10 px radius, 10 by 11 px padding, 6 px between rows.
- Chips for status: 11 px, weight 600, pill radius, tinted backgrounds derived from `--accent`, `--success`, `--warning` and `--error` in both themes. Status is never colour-only: every chip has a word or a glyph with an accessible name.
- Monospace (`--font-mono`) only for commands, output and paths in code: 11.5 px on a `--code` background, 6 px radius.
- **Row actions** (a checklist item's `⋯`, a file's `@`) appear on hover or keyboard focus, not after a click. With a pointer they reserve no column: an item's `⋯` floats over the row's right end, and a file's `@` takes its chevron's place, so labels and counts run to the edge as in the mockups. On touch screens they stay visible in their own column.

## 3. Frame: Overview and tabs

The side panel has a compact title row (Side panel, the selected panel's `⋯` menu, close) and a **tab strip** under it:

1. **Overview**, always first.
2. One tab per visible panel, in the stored per-agent order (the insertion rule of §13.1 is unchanged): declared tool panels, Commands, Approvals, plugin and MCP panels.
3. **Details**, always last.

Overview and Details cannot be moved or hidden.

The side panel sits on the app's backdrop beside the main card, with no border or background of its own; its 52 px title row shares the chat header's centre line, and the tab strip is a segmented control with no rule under it ([chat-design.md](chat-design.md) §3).

- **Tabs.** The active tab shows its icon and label; inactive tabs show their icon and badge, and the label in their tooltip and accessible name. The strip scrolls horizontally when it overflows, keeping the active tab in view. Details stays pinned at the right edge so its context-use badge remains visible; active-tab scrolling reserves that space, and every tab remains keyboard-reachable with a target of at least 32 px. A tab's tooltip and accessible description give the panel's explanation (its document `subtitle`) as a sentence, then its state ("Tracks the plan. 2 of 5 done, New update"). An unseen dot marks a panel updated since it was last viewed.
- **Badges.** Checklist progress `done/total`; files: the file count; Commands: the running count (accent), else the failed count (error), else the total; Approvals: the number of calls waiting (warning); Details: the context use in percent (warning from 80 %, error from 95 %); other panels: `done/total` when the document reports progress. A done or failed document shows a small status glyph instead; there is no text pill. Closed and Stale show as a muted chip in the Overview card; a closed panel's tab says so in a banner above its content.
- **Keyboard.** WAI-ARIA tabs with manual activation: arrow keys, `Home` and `End` move focus between tabs, `Enter` or `Space` selects. Tab moves into the active panel.
- **Reorder and hide.** Drag a tab along the strip, or use **Move left**, **Move right** and **Hide tab** in the title row's `⋯` menu, which acts on the selected tab. Order and hidden tabs are stored per agent as before.
- **Overview.** One card per visible panel: icon, title, status on the right (badge, chips, `+a −r`), up to two key lines from the panel's content (the todo item in progress; the running and failed commands; file totals and names; the current step; else the summary), and a thin progress bar when progress exists. Details appears as a Context card. Clicking a card selects its tab. Hidden panels are listed in a final row, "N hidden", that shows them again.
- **Tab content.** No header inside the tab, as in the mockups: the tab names the panel, its tooltip explains it, and the title row's `⋯` menu holds the panel actions, Hide completed for checklists, Move left/right and Hide tab. The content starts with the stale or closed banner and the rejected-update notice, then scrolls inside the remaining height. There is no height sharing and no divider.

### 3.1 What stays from §13.1

- **Updates never move the reader.** An update never switches the active tab, never moves focus and never scrolls the active tab's content. It changes badges, Overview cards and the unseen dot.
- **Active tab.** Stored per session in the browser; Overview by default.
- **Follow the tool.** When a panel declared `first_update` receives its first revision and its tab is not hidden, the side panel opens once per session without moving focus. It selects that panel's tab only when Overview is the active tab, so it never takes the user away from a panel they chose.
- **Receipts.** Clicking a receipt opens the side panel, unhides the panel's tab and selects it.
- **Seen.** A panel counts as seen when its tab is active and the side panel is open; Overview marks nothing seen.
- Announcements, stale and rejected states, panel and item actions, Hide completed, `@` insertion, the narrow drawer and the per-agent stack are unchanged.

### 3.2 Browser storage

`raw.dashboard.panels.v1` keeps `order`, `hidden` (per agent), `seen`, `opened` and `hideCompleted`, and gains `tab` (per session: the selected tab id). The fields `heights` and `expanded` of earlier versions are ignored when loaded and are no longer written. Corrupt or foreign data falls back to defaults field by field.

### 3.3 The Approvals tab

The **Approvals** tab is the second host-owned tab, beside Commands. It appears only while a call waits for permission, and it exists for the case the in-chat card cannot serve: deciding on an edit needs the change itself, not a six-line headline.

- **What it lists.** One card per pending approval of this session, newest first; the tab leaves when the last one is answered. Its revision is the newest request's time, so a call asked after you answered counts as unseen. Its Overview card carries the same count and the time each request has left.
- **It never opens itself.** The tab appears with its badge and is reached by the in-chat card's **Review**, which opens the side panel, unhides the tab and selects it ([chat-design.md](chat-design.md) §7). A pending call never moves a tab you chose, and it never opens the panel; a session whose last tab choice was this one returns to it when a new call waits.
- **Cards.** The `Waiting for you` chip, the tool name and the expiry at the right, then the call's headline — its title and its summary in monospace — and the files it intends to change. A file row carries the intended operation in a word (Write, Edit, Delete, Rename from, Rename to), the file name with its folder below ("project root" at the session directory), the lines the change adds and removes, and a chevron when a preview exists; clicking it opens the preview inline, scrolling inside the tab.
- **Previews come from the request, never from disk.** `apply_patch` shows every file of the patch in patch order, with the lines as the patch wrote them; `edit_file` shows the replaced text as removed and added lines; `write_file` shows the content that will be written and says that the previous content is not read. Nothing is read before the approval and no hunk numbering is invented, so a preview is what the call intends, not a diff of what is on disk. A preview is cut at 2000 lines or 64 KiB and says so, and arguments of an unexpected shape leave the intended files listed without one.
- **Tool identity and diff content.** Synthesized editing previews recognize only the exact built-in aliases (`write_file`, `edit_file`, `apply_patch`) and their `builtin/` canonical names. A third-party tool such as `owner/write_file` keeps its intended-file effects and raw **Arguments**, without borrowing built-in semantics. Diff file headers must be a paired `---` / `+++` header outside a hunk; header-looking content inside ordinary or bare `@@` patch hunks remains removed or added content.
- **Answers.** **Arguments** opens the exact arguments and the intended effects, then **Deny** and the primary **Allow once**, with the same meaning and the same endpoint as the in-chat card: one answer per call, the first answer wins, and a stale answer shows the server's message.

## 4. Commands

One card per command ([gallery](dashboard/side-panel-commands-dark.png)): running commands first, then, under an **Earlier** label, the others; each group newest first by start time. The label appears only when the filter shows both groups.

- **Filter.** Chips `All N`, `Running N`, `Failed N` (failed includes timed out and lost), stored per session. An empty filter shows a short note and keeps the chips. The chip counts cover the listed rows; "Older commands not shown" closes the list when the server cut older ones.
- **Running card.** Accent border, a `Running` chip with a spinner and the ticking duration, the call's description as the title (else the command), the command line in monospace with an ellipsis and the full text in `title`, the last three output lines for foreground Bash, and a footer: start time, foreground or background, **Output**, and **Stop for background jobs only**. Foreground Bash stops with the turn's Stop in the composer, because per-command Stop exists only for supervisor-managed processes.
- **Failed card.** Error border, an `Exit N` chip, duration and time, title, command, the last error lines, **Copy** and **Output**.
- **Timed out, stopped, lost.** One compact card: the state's glyph, the title, the chip as a word only (the glyph already marks the state), the duration, and the command as a muted second line when the title is the description. The record's error text is in the row's tooltip and in the opened card.
- **Succeeded.** One compact line: check glyph, title with ellipsis, duration; the command as a muted second line when the title is the description. Activating a compact card shows the whole card, opens its output and moves focus to its **Output** button.
- **Cards in use stay put.** A card whose output is open, that holds focus, that is stopping or that shows a notice stays in the current filter after its state changes, and leaves it only when it is no longer in use. New cards inserted above keep the reader's scroll anchor.
- **Output** opens the terminal frame inside the card (auto-follow, Copy output, Load more, full output and `@`). Background output is read through the process control only after Output is opened; there is no live tail for background jobs because every read of their output is policy-checked and audited.
- **Tail.** Foreground command records carry `tail`: the last three non-empty lines, each with its channel, terminal control sequences removed, a carriage return keeping only what follows it (progress bars), 160 bytes per line and 512 bytes in all, refreshed whenever the record is saved ([dashboard-api.md](dashboard-api.md)). A failed card highlights stderr lines.

## 5. Todo (checklist blocks)

([gallery](dashboard/side-panel-todo-dark.png))

- A header line "N of M done" (with the document title when it differs from the tab title) and a progress bar.
- **Groups by top-level subtree,** so hierarchy is never split: an item goes to **Now** when it or any descendant is in progress; else to **Next** when it or any descendant is unfinished (pending, blocked, failed); else to **Completed** (the whole subtree done or skipped).
- **Now** is a highlighted card: the active item's spinner glyph, its full label (wrapping allowed) and its note. A done parent shows its in-progress child under it, and the child's siblings stay with them.
- **Next** items keep the glyph on the first line and clamp labels to two lines with the label and note in `title`. Blocked and failed show their colour and status word.
- **Completed** is one toggle row, "Completed N · skipped M" (N counts the finished top-level items, M those skipped; "· skipped M" only when M > 0). Its open state is kept per session, panel and block for the page, so switching tabs keeps it and another chat's same panel starts closed; a reload closes it.
- The block title, when it differs from the tab title, sits on the count line; a document with one untitled checklist (the Todo shape) puts its document title there instead. An empty checklist keeps its title, without count or bar.
- An update that moves a subtree to another group keeps its disclosure state, and a focused control in it stays focused at its new place without scrolling.
- **Hide completed** hides the Completed row and finished items inside unfinished subtrees, never an unfinished item.
- The primary status action, item `⋯` actions, priority tag and ref chip are kept.

## 6. Files changed (files blocks)

([gallery](dashboard/side-panel-files-changed-dark.png))

- A summary line "N files changed" with `+a −r` (each only when known) and a ratio bar when both are known.
- Rows: a coloured status letter (A, M, D, R; a file icon when the entry has no status), the file name (or its `label`) at weight 550 with an ellipsis, its folder on a muted second line ("project root" for the session directory; the absolute folder outside it), `+N −M` (a zero count is left out unless the status implies it: an added file's `+N`, a deleted file's `−M`), and a chevron when a diff exists. Clicking opens the diff inline (400 px at most, scrolling); `@` on hover or keyboard focus inserts the path. Under the list, a hint "Click a file to see its diff · @ adds it to your message" when any file has a diff. A footer appears only when older history was omitted.

## 7. Details

([gallery](dashboard/side-panel-details-dark.png))

- **Context card.** Tokens in large type (`6.9k / 8.2k tokens`), the percent chip and a bar coloured by fill (warning from 80 %, error from 95 %), then one line with the retained messages, whether a summary exists and the auto-compact trigger ("auto compact off" without one, rounded), and **Compact now** (the same action as the composer's Context card, disabled while it is).
- **Usage card.** Key/value rows as in details.png: "Last turn" and "This session" (requests, then the input and output tokens when reported: "2 requests · 1,500 in · 40 out"), "Cache reads" for the last turn (requests that reported cache reads of all, and their tokens), then only what was reported: session cache reads, cache writes, cache read share (with the requests it covers: "66.7% (1 of 2)") and derived uncached input, each as "turn · session in session", a dash for a scope that did not report it. One note when the provider reports no input, output or cache token counts.
- **Summary card** when a summary exists (expandable, copyable).
- **Continue in terminal** with the copyable resume command.
- **Context limits.** The window, input budget, output reserve and exact auto-compact trigger when known, the estimated or provider-reported context tokens, and the history note with the measurement time.
- **Last attached capabilities** (tools, skills, variables) and **Session** (ID, workspace, config for the next turn, a previously saved config when it differs, model) in the final cards. Nothing Details shows today is dropped; unreported values are covered by the note.

## 8. Plugin blocks

([gallery](dashboard/side-panel-gadget-dark.png))

- **Block titles.** An 11 px uppercase group label; steps add how many are finished (done or skipped) of all (`Steps · 1 of 3`), a table its row count (`Results · 2 rows`).
- **Steps.** A vertical stepper with a connecting line, the glyph on the first line, the current step at weight 550 with its detail and `aria-current="step"`, the duration muted on the right: how long a finished step took, or how long the running step has run (refreshed every 15 s).
- **Progress.** Label (ellipsis and `title`) and `value / max` on one line, a 4 px bar; indeterminate bars animate unless reduced motion is set.
- **Timeline.** Newest first, a coloured level dot (with the level as hidden text), relative time ("1 min ago", "1 h ago") above the label, detail below.
- **Key/value.** The muted key above the value; values wrap at word boundaries; a ref is a file chip `name:line` (the full path is its accessible name and in `title`) inserting `@path`, followed by its folder cut to one line. Values use the text face: the contract has no hint that a value is code, so the mockup's monospace branch name is not reproduced.
- **Table.** Narrower than 420 px (always in the side panel, whose maximum width is 360 px), each row is a card: status glyph, the first column as title, the others as `Label: value`, ref chip, actions. From 420 px (inline chat views) a compact table with single-line cells, ellipsis and `title`. Never wider than its container.
- **Markdown.** 13 px prose; code blocks scroll inside.
- Unknown kinds keep their fallback text.

## 9. Questions (`ask_user` and form blocks)

([gallery](dashboard/side-panel-question-dark.png))

- A lone untitled form (an `ask_user` question) leads with its status chip and the question at 14 px, not the document title.
- Single-select options as radio cards, multi-select as checkbox cards. When the choice has a paired `<id>_other` text field (`ask_user` with `allow_other`), an **Other…** card opens that field and focuses it; for a single choice it replaces the chosen option, and closing it clears its text. Other text fields are full width.
- The cancel action first as a secondary button (`ask_user` labels it **Skip**), then the submit action (**Send answer**) as the primary button; a status chip "Waiting for you", "Answered", "Cancelled", "Expired" or "Interrupted".
- Byte limits appear only as a validation error ("Other is too long: at most 65,536 bytes"), checked before sending. Submission, idempotency, disabled states and acknowledgements are unchanged.
- Inline chat views use the same renderers at chat width.

## 10. Verification

- A stress session (`tests/dashboard-ui/side-panel-stress.ts`) with long Vietnamese todo items, deep paths, failing and streaming commands, a background job, a plugin panel with every block kind and a question.
- Geometry specs at 320 px and 360 px, light and dark, asserting the measured container width: no horizontal overflow, glyphs on the first text line, truncated text with its full value in `title` or the accessible name.
- A gallery (`tests/dashboard-ui/capture-side-panel.ts`) writes one image per tab, in dark and light, plus the pending question as the chat shows it, to `docs/dashboard/side-panel-*.png`; each is compared with its mockup by eye in review. These are not pixel assertions.
- The Approvals tab is covered by `tests/dashboard-ui/approval-review.spec.ts`: a write waits for permission, the card's **Review** opens the tab on it, the intended file and the lines it would write are readable before anything is written, **Deny** and **Allow once** answer from the panel, the tab leaves with the answer, a pending call survives a reload, the file row opens with `Enter` and closes with `Space`, and axe is clean in both themes.
