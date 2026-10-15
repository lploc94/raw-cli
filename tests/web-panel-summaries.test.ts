import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelDocument } from "../src/panels/contract.js";
import type { PanelStackItem } from "../src/panels/stack.js";
import type { CommandRecord } from "../src/processes/presentation.js";
import type { Approval } from "../src/dashboard/approvals.js";
import { compactTokens, reportsTokens, summarizeApprovals, summarizeCommands, summarizeContext, summarizePanel } from "../web/src/panels/summaries.js";

const item = (document: PanelDocument | null, extra: Partial<PanelStackItem> = {}): PanelStackItem => ({
  panel: "x#p", owner: "x", title: "Panel", icon: "panel", revision: document ? 1 : 0, updatedAt: document ? 1 : null, closed: false, stale: false,
  declaration: { id: "p", title: "Panel", icon: "panel", open: "never", context: "none", acp_plan: false, actions: [] }, document, ...extra,
});
const checklist = (statuses: Array<[string, string, string?]>): PanelDocument => ({
  blocks: [{ id: "c", kind: "checklist", items: statuses.map(([label, status, note], index) => ({ id: `i${index}`, label, status: status as "done", ...(note ? { note } : {}) })) }],
});

test("a checklist reports done of total, the item in progress and its progress", () => {
  const summary = summarizePanel(item(checklist([["Đọc log", "done"], ["Viết test", "done"], ["Kết thúc: kiểm tra lần cuối 44/44 liên kết", "in_progress"], ["Ngắn", "pending"], ["Bỏ qua", "skipped"]])));
  assert.deepEqual(summary.badge, { text: "3/5", tone: "muted", label: "3 of 5 done" });
  assert.equal(summary.meta, "3 of 5");
  assert.deepEqual(summary.lines, [{ text: "Kết thúc: kiểm tra lần cuối 44/44 liên kết", glyph: "running" }]);
  assert.deepEqual(summary.progress, { value: 0.6, tone: "accent" });
  assert.equal(summary.status, undefined);
  // Nothing in progress: the next unfinished item, nested children included.
  const nested: PanelDocument = { blocks: [{ id: "c", kind: "checklist", items: [{ id: "a", label: "Parent", status: "done", children: [{ id: "b", label: "Child left", status: "pending" }] }, { id: "d", label: "Later", status: "pending" }] }] };
  const next = summarizePanel(item(nested));
  assert.deepEqual(next.lines, [{ text: "Child left", glyph: "pending" }]);
  assert.deepEqual(next.badge, { text: "0/2", tone: "muted", label: "0 of 2 done" });
  // A done document shows its glyph instead of a badge, and no text pill.
  const done = summarizePanel(item({ ...checklist([["A", "done"], ["B", "done"]]), status: "done" }));
  assert.equal(done.status, "done");
  assert.equal(done.badge, undefined);
  assert.equal(done.meta, "2 of 2");
  assert.deepEqual(done.chips, []);
  assert.equal(summarizePanel(item({ ...checklist([["A", "failed"]]), status: "failed" })).status, "failed");
});

test("files report the count, totals only when known and the file names", () => {
  const files: PanelDocument = { blocks: [
    { id: "f", kind: "files", entries: [
      { path: "src/very/deep/nested/component-file-name-that-is-long.ts", status: "modified", added: 120, removed: 33 },
      { path: "README.md", status: "added", added: 5 },
    ] },
    { id: "g", kind: "files", entries: [{ path: "config/old-config.json", status: "deleted" }] },
  ] };
  const summary = summarizePanel(item(files));
  assert.deepEqual(summary.badge, { text: "3", tone: "muted", label: "3 files" });
  assert.deepEqual(summary.stats, { added: 125, removed: 33 });
  assert.deepEqual(summary.lines, [{ text: "component-file-name-that-is-long.ts, README.md, old-config.json" }]);
  const unknown = summarizePanel(item({ blocks: [{ id: "f", kind: "files", entries: [{ path: "a.ts" }] }] }));
  assert.equal(unknown.stats, undefined);
  assert.deepEqual(unknown.badge, { text: "1", tone: "muted", label: "1 file" });
  // Only removals known: no invented "+0".
  assert.deepEqual(summarizePanel(item({ blocks: [{ id: "f", kind: "files", entries: [{ path: "a.ts", removed: 4 }] }] })).stats, { removed: 4 });
});

test("steps show the current step, generic panels their progress and summary, empty panels say so", () => {
  const steps: PanelDocument = { blocks: [{ id: "s", kind: "steps", items: [{ id: "1", label: "Build", status: "done" }, { id: "2", label: "Deploy to staging", status: "in_progress" }, { id: "3", label: "Verify", status: "pending" }] }] };
  const summary = summarizePanel(item(steps));
  assert.deepEqual(summary.lines, [{ text: "Deploy to staging", glyph: "running" }]);
  assert.equal(summary.meta, "1 of 3");
  const generic = summarizePanel(item({ summary: "Halfway there", progress: { done: 1, total: 2 }, blocks: [{ id: "m", kind: "markdown", text: "x" }] }));
  assert.deepEqual(generic.badge, { text: "1/2", tone: "muted", label: "1 of 2 done" });
  assert.deepEqual(generic.lines, [{ text: "Halfway there" }]);
  assert.equal(generic.summary, "Halfway there");
  const plain = summarizePanel(item({ blocks: [{ id: "m", kind: "markdown", title: "Notes", text: "x" }] }));
  assert.equal(plain.badge, undefined);
  assert.deepEqual(plain.lines, [{ text: "Notes" }]);
  const empty = summarizePanel(item(null));
  assert.deepEqual(empty.lines, [{ text: "No data yet" }]);
  assert.equal(empty.summary, "No data yet");
  assert.equal(empty.badge, undefined);
  assert.equal(empty.progress, undefined);
});

test("closed and stale panels carry a muted chip", () => {
  assert.deepEqual(summarizePanel(item(checklist([["A", "pending"]]), { closed: true })).chips, [{ text: "Closed", tone: "muted" }]);
  assert.deepEqual(summarizePanel(item(checklist([["A", "pending"]]), { stale: true })).chips, [{ text: "Stale", tone: "muted" }]);
});

const command = (id: string, state: CommandRecord["state"], extra: Partial<CommandRecord> = {}): CommandRecord => ({
  id, sessionId: "s", kind: "foreground", owner: "builtin/bash", command: `cmd-${id}`, cwd: "/w", state, createdAt: 0, updatedAt: 0, cursor: 0, droppedBytes: 0, ...extra,
});

test("commands report running first, then failed, newest first", () => {
  const now = 1_000_000;
  const items = [
    command("ok", "exited", { exitCode: 0, label: "Install", createdAt: now - 50_000, endedAt: now - 40_000 }),
    command("lint", "exited", { exitCode: 2, label: "Chạy linter", createdAt: now - 30_000, endedAt: now - 29_000 }),
    command("watch", "running", { label: "Theo dõi liên kết sau khi cập nhật mục lục", kind: "background", createdAt: now - 125_000 }),
    command("slow", "timed_out", { createdAt: now - 20_000, endedAt: now - 10_000 }),
  ];
  const summary = summarizeCommands(items, now);
  assert.deepEqual(summary.badge, { text: "1", tone: "accent", label: "1 running" });
  assert.deepEqual(summary.chips, [{ text: "1 running", tone: "accent", spin: true }, { text: "2 failed", tone: "error" }]);
  assert.deepEqual(summary.lines, [
    { text: "Theo dõi liên kết sau khi cập nhật mục lục", glyph: "running", meta: "2m" },
    { text: "cmd-slow", glyph: "failed", meta: "timed out" },
  ]);
  const idle = summarizeCommands(items.filter((entry) => entry.id !== "watch"), now);
  assert.deepEqual(idle.badge, { text: "2", tone: "error", label: "2 failed" });
  assert.deepEqual(idle.lines, [{ text: "cmd-slow", glyph: "failed", meta: "timed out" }, { text: "Chạy linter", glyph: "failed", meta: "exit 2" }]);
  const fine = summarizeCommands([items[0]!], now);
  assert.deepEqual(fine.badge, { text: "1", tone: "muted", label: "1 command" });
  assert.deepEqual(fine.chips, []);
  assert.deepEqual(fine.lines, [{ text: "Install", glyph: "done", meta: "10s" }]);
  // A stopped job is neither running nor failed, and is not shown as a success.
  const stopped = summarizeCommands([command("x", "stopped", { endedAt: now })], now);
  assert.deepEqual(stopped.chips, []);
  assert.deepEqual(stopped.lines, [{ text: "cmd-x", meta: "stopped" }]);
  assert.deepEqual(summarizeCommands([], now).lines, [{ text: "No commands yet" }]);
});

test("approvals report how many wait, newest first, with the time left", () => {
  const now = 1_000_000;
  const pending = (id: string, title: string, createdAt: number, deadline: number) => ({ id, sessionId: "s", operationId: "op", callId: "call",
    name: "builtin/write_file", title, summary: "src/a.ts", arguments: {}, createdAt, deadline }) as Approval;
  const summary = summarizeApprovals([pending("a", "Write file", now - 90_000, now + 120_000), pending("b", "Edit src/app.ts", now - 10_000, now + 30_000)], now);
  assert.deepEqual(summary.badge, { text: "2", tone: "warning", label: "2 waiting for approval" });
  assert.deepEqual(summary.chips, [{ text: "2 waiting", tone: "warning" }]);
  assert.deepEqual(summary.lines, [
    { text: "Edit src/app.ts", meta: "30s" },
    { text: "Write file", meta: "2m" },
  ]);
  assert.equal(summary.status, undefined);
  assert.equal(summary.summary, "2 waiting for approval");
  // Only the two newest requests earn a line, and a deadline already past is not shown as negative time.
  const late = summarizeApprovals([pending("c", "Write file", now - 5_000, now - 1_000), pending("d", "Edit src/app.ts", now - 4_000, now + 1_000), pending("e", "Third", now - 3_000, now + 2_000)], now);
  assert.deepEqual(late.lines, [{ text: "Third", meta: "2s" }, { text: "Edit src/app.ts", meta: "1s" }]);
  assert.deepEqual(summarizeApprovals([pending("f", "Write file", now - 5_000, now - 1_000)], now).lines, [{ text: "Write file", meta: "0s" }]);
  assert.deepEqual(summarizeApprovals([], now).lines, [{ text: "Nothing waits for approval" }]);
  assert.equal(summarizeApprovals([], now).badge, undefined);
  assert.deepEqual(summarizeApprovals([], now).chips, []);
});

test("context use is measured against the compact trigger or the window, coloured by fill", () => {
  assert.equal(compactTokens(950), "950");
  assert.equal(compactTokens(6900), "6.9k");
  assert.equal(compactTokens(128_000), "128k");
  assert.equal(compactTokens(1_250_000), "1.3M");
  const warm = summarizeContext({ estimatedTokens: 6900, contextWindow: 8200 });
  assert.deepEqual(warm?.badge, { text: "84%", tone: "warning", label: "84% of the context window used" });
  assert.deepEqual(warm?.chips, [{ text: "84%", tone: "warning" }]);
  // With a limit the card shows the chip and the bar; the numbers stay in the summary.
  assert.deepEqual(warm?.lines, []);
  assert.equal(warm?.summary, "~6.9k / 8.2k tokens");
  assert.equal(warm?.progress?.tone, "warning");
  assert.ok(Math.abs(warm!.progress!.value - 6900 / 8200) < 1e-9);
  const trigger = summarizeContext({ estimatedTokens: 50_000, source: "provider", contextWindow: 200_000, compactTrigger: 52_000 });
  assert.deepEqual(trigger?.badge, { text: "96%", tone: "error", label: "96% of the auto-compact trigger used" });
  assert.equal(trigger?.summary, "50k / 52k tokens");
  const cool = summarizeContext({ estimatedTokens: 1000, contextWindow: 200_000 });
  assert.equal(cool?.badge?.tone, "muted");
  assert.equal(cool?.progress?.tone, "accent");
  // Past the trigger the bar is full, not wider.
  assert.equal(summarizeContext({ estimatedTokens: 9000, compactTrigger: 8000 })?.progress?.value, 1);
  assert.deepEqual(summarizeContext({ estimatedTokens: 1200 })?.lines, [{ text: "~1.2k tokens" }]);
  assert.equal(summarizeContext({ estimatedTokens: 1200 })?.badge, undefined);
  assert.equal(summarizeContext(undefined), undefined);
});

test("usage reports token counts when any request reported input, output or cache tokens", () => {
  const none = { requests: 2, inputTokensKnown: 0, inputCoverage: 0, outputTokensKnown: 0, outputCoverage: 0, cacheReadTokensKnown: 0, cacheWriteTokensKnown: 0, cacheReadCoverage: 0, cacheWriteCoverage: 0, cacheRatioCoverage: 0 };
  assert.equal(reportsTokens(none), false);
  assert.equal(reportsTokens({ ...none, inputCoverage: 1, inputTokensKnown: 10 }), true);
  assert.equal(reportsTokens({ ...none, outputCoverage: 1, outputTokensKnown: 10 }), true);
  assert.equal(reportsTokens({ ...none, cacheReadCoverage: 1, cacheReadTokensKnown: 100 }), true);
  assert.equal(reportsTokens({ ...none, cacheWriteCoverage: 2, cacheWriteTokensKnown: 50 }), true);
});
