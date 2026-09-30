import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelStackItem } from "../src/panels/stack.js";
import { reduceEvent } from "../web/src/session.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import type { SessionSnapshot } from "../src/dashboard/sessions.js";
import type { SessionSummary } from "../src/sessions/store.js";
import type { DashboardEvent, DashboardEventData } from "../src/dashboard/streams.js";
import {
  DETAILS_ID, MAX_HEIGHT, MIN_HEIGHT, applyFrame, announcement, arrange, formatDuration, mergeStack, newAnnouncer, placeAt, planAnnouncements, relativeTime, setHideCompleted, stepDuration, currentOrder, emptyPrefs, firstOpenTarget, hasOpened, heightFor, isExpanded, layout, loadPrefs,
  markOpened, markSeen, mayAnnounce, move, rejectedCode, savePrefs, setExpanded, setHeight, setHidden, setOrder, storageKey, unseen,
} from "../web/src/panels/panel-state.js";

const item = (panel: string, revision = 0, open: "never" | "first_update" = "never"): PanelStackItem => ({
  panel, owner: panel.split("#")[0]!, title: panel, icon: "panel", revision, updatedAt: revision ? 1 : null, closed: false, stale: false,
  declaration: { id: panel.split("#")[1]!, title: panel, icon: "panel", open, context: "none", acp_plan: false, actions: [] },
  document: revision ? { blocks: [] } : null,
});
const store = (value: string | null) => ({ getItem: () => value });

test("inline stream frames stay outside the sidebar and disappear on commit, terminal cleanup and reset", async () => {
  const f = await dashboardFixture();
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root, agent: "raw" });
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    const envelope = { id: "frame", instanceId: "host", sessionId: session.id, sequence: 1, operationId: "op" };
    let state = reduceEvent(undefined, { ...envelope, type: "snapshot", data: snapshot })!;
    const view = { instanceId: "v", runId: "run", toolCallId: "call", owner: "local/report", panelId: "report", sessionId: session.id, operationId: "op" };
    const data: DashboardEventData["panel"] = { panel: "local/report#report", owner: "local/report", revision: 2, closed: false, live: true,
      view, declaration: { ...item("local/report#report").declaration, placement: "chat" }, document: { blocks: [] } };
    state = reduceEvent(state, { ...envelope, type: "panel", data })!;
    assert.deepEqual(state.panels, []);
    assert.deepEqual(state.unknownPanels, []);
    assert.equal(state.panelTick, 0);
    assert.equal(state.views.v?.revision, 2);
    state = reduceEvent(state, { ...envelope, type: "panel", data: { ...data, revision: 1 } })!;
    assert.equal(state.views.v?.revision, 2);
    state = reduceEvent(state, { ...envelope, type: "history", data: { historyWatermark: 1, items: [{ id: "receipt", sequence: 1,
      createdAt: 1, kind: "panel_receipt", status: "complete", panelReceipt: { panel: "report", owner: "local/report", title: "Report", revision: 2,
        summary: "", status: "active", op: "replace", toolCallId: "call", source: "tool", view } }] } })!;
    assert.deepEqual(state.views, {});
    state = reduceEvent(state, { ...envelope, type: "panel", data })!;
    assert.deepEqual(state.views, {}, "late final frame cannot replace committed history");
    const other = { ...data, view: { ...view, instanceId: "other" } };
    state = reduceEvent(state, { ...envelope, type: "panel", data: other })!;
    state = reduceEvent(state, { ...envelope, type: "operation", data: { id: "op", sessionId: session.id, clientRequestId: "r", kind: "turn", agentName: "raw",
      configPath: f.configPath, input: "go", state: "cancelled", ownerGeneration: 1, acceptedAt: 1, updatedAt: 2 } })!;
    assert.deepEqual(state.views, {});
    state = reduceEvent(state, { ...envelope, type: "panel", data: other })!;
    assert.deepEqual(state.views, {}, "late provisional frame cannot revive a terminal operation");
    state = reduceEvent(state, { ...envelope, operationId: "different", type: "panel", data: other })!;
    assert.equal(Object.keys(state.views).length, 1);
    state = reduceEvent(state, { ...envelope, type: "reset", data: snapshot } as DashboardEvent)!;
    assert.deepEqual(state.views, {});
  } finally { await f.close(); }
});

test("storage round-trips and corrupt or foreign storage yields defaults field by field", () => {
  const saved: string[] = [];
  let prefs = setOrder(emptyPrefs(), "a", ["x#1", "y#1"]);
  prefs = setHidden(prefs, "a", "y#1", true);
  prefs = setHeight(prefs, "a", 300);
  prefs = setExpanded(prefs, "s1", "x#1", true);
  prefs = markSeen(prefs, "s1", "x#1", 4);
  prefs = markOpened(prefs, "s1");
  savePrefs(prefs, { setItem: (_key, value) => { saved.push(value); } });
  assert.deepEqual(loadPrefs(store(saved[0]!)), prefs);
  for (const raw of [null, "", "{", "[]", "3", JSON.stringify({ version: 2, order: { a: ["x"] } }), JSON.stringify({ order: { a: ["x"] } })])
    assert.deepEqual(loadPrefs(store(raw)), emptyPrefs(), String(raw));
  assert.deepEqual(loadPrefs(undefined), emptyPrefs());
  assert.deepEqual(loadPrefs({ getItem: () => { throw new Error("blocked"); } }), emptyPrefs());
  assert.doesNotThrow(() => savePrefs(prefs, { setItem: () => { throw new Error("full"); } }));
  assert.equal(storageKey, "raw.dashboard.panels.v1");
  const mixed = loadPrefs(store(JSON.stringify({ version: 1, order: "nope", hidden: { a: ["h", 3, "h", ""] }, heights: { a: 9999, b: "x", c: 1 }, expanded: { s: ["p", DETAILS_ID] }, seen: { s: { p: 3, q: -1, r: 1.5 } }, opened: 4 }))) ;
  assert.deepEqual(mixed, { version: 1, order: {}, hidden: { a: ["h"] }, heights: { a: MAX_HEIGHT, c: MIN_HEIGHT }, expanded: { s: ["p", DETAILS_ID] }, seen: { s: { p: 3 } }, opened: [], hideCompleted: false });
  assert.equal(loadPrefs(store(JSON.stringify({ version: 1, hideCompleted: true }))).hideCompleted, true);
  assert.equal(loadPrefs(store(JSON.stringify({ version: 1, hideCompleted: "yes" }))).hideCompleted, false);
  assert.equal(setHideCompleted(emptyPrefs(), true).hideCompleted, true);
});

test("arrange keeps the stored order and inserts each new panel after its nearest present predecessor", () => {
  const defaults = ["a", "b", "c", "d", "e"];
  assert.deepEqual(arrange(defaults, []), defaults);
  // The user reversed part of the stack; a new "c" goes after its predecessor "b", not to the end and not by default sort.
  assert.deepEqual(arrange(defaults, ["e", "d", "b", "a"]), ["e", "d", "b", "c", "a"]);
  // No present predecessor: top of the stack.
  assert.deepEqual(arrange(defaults, ["e", "d"]), ["a", "b", "c", "e", "d"]);
  assert.deepEqual(arrange(["a", "b", "c"], ["c"]), ["a", "b", "c"]);
  // A predecessor that was itself just inserted counts as present.
  assert.deepEqual(arrange(["a", "b", "c", "d"], ["d", "a"]), ["d", "a", "b", "c"]);
  // Stored ids that no longer exist are ignored, duplicates collapse.
  assert.deepEqual(arrange(["a", "b"], ["gone", "b", "b", "a"]), ["b", "a"]);
  // Existing sections never change their relative order.
  const order = arrange(["a", "b", "c", "d", "e", "f"], ["f", "d", "b"]);
  assert.deepEqual(order.filter((id) => ["f", "d", "b"].includes(id)), ["f", "d", "b"]);
});

test("move steps over hidden neighbours and stops at the ends", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(move(order, "c", "up", new Set()), ["a", "c", "b", "d"]);
  assert.deepEqual(move(order, "c", "up", new Set(["b"])), ["c", "a", "b", "d"]);
  assert.deepEqual(move(order, "a", "up", new Set()), order);
  assert.deepEqual(move(order, "d", "down", new Set()), order);
  assert.deepEqual(move(order, "b", "down", new Set(["c", "d"])), order);
  assert.deepEqual(move(order, "zzz", "down", new Set()), order);
});

test("layout splits hidden from visible in the user's order per agent", () => {
  const items = [item("a#1"), item("b#1"), item("c#1")];
  let prefs = setOrder(emptyPrefs(), "one", ["c#1", "a#1", "b#1"]);
  prefs = setHidden(prefs, "one", "a#1", true);
  const shown = layout(items, prefs, "one");
  assert.deepEqual(shown.visible.map((entry) => entry.panel), ["c#1", "b#1"]);
  assert.deepEqual(shown.hidden.map((entry) => entry.panel), ["a#1"]);
  assert.deepEqual(layout(items, prefs, "two").visible.map((entry) => entry.panel), ["a#1", "b#1", "c#1"]);
  assert.deepEqual(currentOrder(items, prefs, null), ["a#1", "b#1", "c#1"]);
  assert.deepEqual(layout(items, setHidden(prefs, "one", "a#1", false), "one").hidden, []);
});

test("height is clamped per agent and expansion, seen and first-open are per session", () => {
  let prefs = setHeight(emptyPrefs(), "a", 5);
  assert.equal(heightFor(prefs, "a"), MIN_HEIGHT);
  assert.equal(heightFor(setHeight(prefs, "a", 99999), "a"), MAX_HEIGHT);
  assert.equal(heightFor(prefs, "b"), undefined);
  prefs = setExpanded(prefs, "s1", "p", true);
  assert.ok(isExpanded(prefs, "s1", "p")); assert.ok(!isExpanded(prefs, "s2", "p"));
  assert.ok(!isExpanded(setExpanded(prefs, "s1", "p", false), "s1", "p"));
  assert.ok(unseen(prefs, "s1", item("p", 2)));
  assert.ok(!unseen(markSeen(prefs, "s1", "p", 2), "s1", item("p", 2)));
  assert.ok(unseen(markSeen(prefs, "s1", "p", 2), "s1", item("p", 3)));
  assert.ok(!unseen(prefs, "s1", item("never", 0)));
  assert.equal(markSeen(prefs, "s1", "p", 0), prefs);
  assert.ok(!hasOpened(prefs, "s1")); assert.ok(hasOpened(markOpened(prefs, "s1"), "s1")); assert.ok(!hasOpened(markOpened(prefs, "s1"), "s2"));
  for (let index = 0; index < 80; index++) prefs = setExpanded(prefs, `session-${index}`, "p", true);
  assert.ok(Object.keys(prefs.expanded).length <= 50);
  assert.ok(isExpanded(prefs, "session-79", "p"));
});

test("live frames only move a panel forward and unknown panels ask for a refetch", () => {
  const items = [item("a#1", 3), item("b#1", 0)];
  const frame = (panel: string, revision: number) => ({ panel, revision, closed: false, document: { title: `r${revision}`, blocks: [] } });
  const older = applyFrame(items, frame("a#1", 3));
  assert.equal(older.known, true); assert.equal(older.items[0]!.document?.blocks.length, 0); assert.equal(older.items[0]!.revision, 3);
  assert.equal(applyFrame(items, frame("a#1", 2)).items[0]!.revision, 3);
  const newer = applyFrame(items, frame("a#1", 4));
  assert.equal(newer.items[0]!.revision, 4); assert.equal(newer.items[0]!.document?.title, "r4");
  assert.equal(applyFrame(items, frame("b#1", 1)).items[1]!.revision, 1);
  assert.equal(applyFrame(items, { ...frame("a#1", 5), closed: true }).items[0]!.closed, true);
  assert.equal(items[0]!.revision, 3);
  const unknown = applyFrame(items, frame("z#9", 1));
  assert.equal(unknown.known, false); assert.equal(unknown.items.length, 2);
});

test("first open picks the first declared first_update panel that just got its first revision and is not hidden", () => {
  const items = [item("a#1", 1, "first_update"), item("b#1", 1, "first_update"), item("c#1", 2, "never")];
  const before = new Map([["a#1", 0], ["b#1", 0], ["c#1", 1]]);
  assert.equal(firstOpenTarget({ before, items, hidden: new Set() }), "a#1");
  assert.equal(firstOpenTarget({ before, items, hidden: new Set(["a#1"]) }), "b#1");
  assert.equal(firstOpenTarget({ before, items, hidden: new Set(["a#1", "b#1"]) }), undefined);
  // Later updates never qualify; a panel absent before (implicit) does.
  assert.equal(firstOpenTarget({ before: new Map([["a#1", 1]]), items: [item("a#1", 2, "first_update")], hidden: new Set() }), undefined);
  assert.equal(firstOpenTarget({ before: new Map(), items: [item("i#1", 1, "first_update")], hidden: new Set() }), "i#1");
  assert.equal(firstOpenTarget({ before, items: [item("a#1", 0, "first_update")], hidden: new Set() }), undefined);
});

test("announcements read the progress and are limited to one per 5 seconds", () => {
  const withProgress = { ...item("t#1", 1), title: "Todos", document: { progress: { done: 2, total: 5 }, blocks: [] } };
  assert.equal(announcement(withProgress), "Todos: 2 of 5 done");
  assert.equal(announcement(item("t#1", 1)), undefined);
  const checklist = { ...item("t#1", 1), title: "Todo", document: { blocks: [{ id: "items", kind: "checklist", items: [{ id: "a", label: "A", status: "done" }, { id: "b", label: "B", status: "pending" }, { id: "c", label: "C", status: "skipped" }] }] } } as PanelStackItem;
  assert.equal(announcement(checklist), "Todo: 2 of 3 done", "progress is derived from the checklist when the document has none");
  assert.equal(announcement(item("t#1", 0)), undefined);
  assert.ok(mayAnnounce(undefined, 100)); assert.ok(!mayAnnounce(100, 4999 + 100)); assert.ok(mayAnnounce(100, 5100));
});

test("a rejected update shows only while the newest receipt of that panel is an error", () => {
  const receipt = (full: string, code?: string) => ({ panelReceipt: { owner: full.split("#")[0]!, panel: full.split("#")[1]!, ...(code ? { error: { code } } : {}) } });
  assert.equal(rejectedCode([receipt("a#1"), receipt("a#1", "panel_invalid")], "a#1"), "panel_invalid");
  assert.equal(rejectedCode([receipt("a#1", "panel_invalid"), receipt("a#1")], "a#1"), undefined);
  assert.equal(rejectedCode([receipt("a#1", "panel_invalid"), receipt("b#1")], "a#1"), "panel_invalid");
  assert.equal(rejectedCode([{}, receipt("b#1", "panel_limit")], "a#1"), undefined);
  assert.equal(rejectedCode([receipt("x/y#1", "panel_limit")], "x/y#1"), "panel_limit", "owners contain slashes; the local id alone would never match");
  assert.equal(rejectedCode([receipt("x/y#1", "panel_limit")], "1"), undefined);
});

test("placeAt drops a dragged section into the target's place, up or down", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(placeAt(order, "a", "c"), ["b", "c", "a", "d"]);
  assert.deepEqual(placeAt(order, "d", "b"), ["a", "d", "b", "c"]);
  assert.deepEqual(placeAt(order, "b", "b"), order);
  assert.deepEqual(placeAt(order, "b", "zzz"), order);
  assert.deepEqual(placeAt(order, "zzz", "a"), order);
});

test("mergeStack keeps revisions that live frames already advanced and reports panels still unlisted", () => {
  const live = [item("a#1", 5), item("b#1", 1)];
  const fetched = [item("a#1", 4), item("b#1", 1), item("c#1", 2)];
  const merged = mergeStack(live, fetched, ["c#1", "d#1"]);
  assert.deepEqual(merged.items.map((entry) => [entry.panel, entry.revision]), [["a#1", 5], ["b#1", 1], ["c#1", 2]]);
  assert.deepEqual(merged.unresolved, ["d#1"]);
  assert.equal(mergeStack(live, [item("a#1", 9)], []).items[0]!.revision, 9, "a newer fetched revision wins");
  assert.deepEqual(mergeStack(live, [], ["x#1"]).items, [], "the fetch is the authority on which panels exist");
});

test("announcements: every changed panel is spoken in one pass and a throttled one is delivered later", () => {
  const progress = (panel: string, done: number) => ({ panel, title: panel, document: { progress: { done, total: 5 }, blocks: [] } });
  const state = newAnnouncer();
  assert.deepEqual(planAnnouncements(state, [progress("a", 0), progress("b", 0)], 1000), { say: undefined, wait: undefined }, "first sight is only a baseline");
  const both = planAnnouncements(state, [progress("a", 1), progress("b", 2)], 2000);
  assert.equal(both.say, "a: 1 of 5 done. b: 2 of 5 done", "simultaneous panels are both spoken, none overwrites another");
  const held = planAnnouncements(state, [progress("a", 3), progress("b", 2)], 3000);
  assert.equal(held.say, undefined); assert.equal(held.wait, 4000, "a waits for the rest of its 5 s window");
  assert.deepEqual(planAnnouncements(state, [progress("a", 3), progress("b", 2)], 6999), { say: undefined, wait: 1 });
  assert.equal(planAnnouncements(state, [progress("a", 3), progress("b", 2)], 7000).say, "a: 3 of 5 done", "the held update is delivered, not lost");
  // A held update that reverted to what was already said is dropped.
  const other = newAnnouncer();
  planAnnouncements(other, [progress("a", 0)], 0); planAnnouncements(other, [progress("a", 1)], 10);
  planAnnouncements(other, [progress("a", 2)], 20);
  assert.deepEqual(planAnnouncements(other, [progress("a", 1)], 30), { say: undefined, wait: undefined });
});

test("step durations need both timestamps (zero counts) and relative times read naturally", () => {
  assert.equal(stepDuration({ started_at: 1759140000000, ended_at: 1759140600000 }), "10m");
  assert.equal(stepDuration({ started_at: 0, ended_at: 45000 }), "45s");
  assert.equal(stepDuration({ started_at: 5 }), undefined);
  assert.equal(stepDuration({ ended_at: 5 }), undefined);
  assert.equal(stepDuration({ started_at: 10, ended_at: 5 }), undefined);
  assert.equal(formatDuration(3900000), "1h 5m"); assert.equal(formatDuration(3600000), "1h");
  const now = 10_000_000;
  assert.equal(relativeTime(now - 10_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
});
