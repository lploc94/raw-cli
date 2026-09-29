import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_HIDDEN, MAX_OPENED, MAX_PINNED, arrange, baseName, displayPath, batchPaths, batches, chatsLabel, emptyState, filterRows, hide, includePaths, loadState, mergeItems,
  recordOpened, relativeTime, saveState, shortenPath, storageKey, togglePin, unhide, type WorkspaceItem, type WorkspaceState,
} from "../web/src/workspace/workspace-state.js";

const item = (cwd: string, updatedAt: number, sessions = 1, extra: Partial<WorkspaceItem> = {}): WorkspaceItem => ({ cwd, updatedAt, sessions, running: 0, exists: true, ...extra });
const store = (value: string | null) => ({ getItem: () => value });
const state = (extra: Partial<WorkspaceState> = {}): WorkspaceState => ({ ...emptyState(), ...extra });

test("state round-trips and corrupt or foreign storage becomes an empty state", () => {
  const saved: string[] = [];
  const filled = state({ pinned: ["/a"], hidden: ["/b"], opened: [{ path: "/c", at: 5 }] });
  saveState(filled, { setItem: (_key, value) => { saved.push(value); } });
  assert.deepEqual(loadState(store(saved[0]!)), filled);
  for (const raw of [null, "", "{", "[]", "3", JSON.stringify({ version: 2, pinned: ["/a"] }), JSON.stringify({ pinned: ["/a"] })]) assert.deepEqual(loadState(store(raw)), emptyState(), String(raw));
  assert.deepEqual(loadState(undefined), emptyState());
  assert.deepEqual(loadState({ getItem: () => { throw new Error("blocked"); } }), emptyState());
  assert.doesNotThrow(() => saveState(filled, { setItem: () => { throw new Error("full"); } }));
  assert.equal(storageKey, "raw.dashboard.workspaces.v1");
});

test("loading validates every member, deduplicates and enforces the caps", () => {
  const dirty = JSON.stringify({ version: 1, pinned: ["/a", 3, null, "", "/a", "/b", "x".repeat(5000)], hidden: "nope",
    opened: [{ path: "/o", at: 1 }, { path: "/o", at: 9 }, { path: "/bad", at: "1" }, { path: "/neg", at: -1 }, null, { path: 4, at: 1 }] });
  assert.deepEqual(loadState(store(dirty)), { version: 1, pinned: ["/a", "/b"], hidden: [], opened: [{ path: "/o", at: 9 }] });
  const many = (n: number) => Array.from({ length: n }, (_, index) => `/p${index}`);
  const loaded = loadState(store(JSON.stringify({ version: 1, pinned: many(80), hidden: many(300), opened: many(70).map((path, at) => ({ path, at })) })));
  assert.equal(loaded.pinned.length, MAX_PINNED); assert.equal(loaded.pinned.at(-1), "/p79");
  assert.equal(loaded.hidden.length, MAX_HIDDEN); assert.equal(loaded.opened.length, MAX_OPENED); assert.equal(loaded.opened.at(-1)!.path, "/p69");
});

test("pinning toggles and evicts the oldest pin at the cap; hiding and opening are inverses", () => {
  let s = togglePin(emptyState(), "/a"); assert.deepEqual(s.pinned, ["/a"]);
  assert.deepEqual(togglePin(s, "/a").pinned, []);
  for (let index = 0; index < MAX_PINNED + 3; index++) s = togglePin(s, `/n${index}`);
  assert.equal(s.pinned.length, MAX_PINNED); assert.ok(!s.pinned.includes("/a")); assert.equal(s.pinned.at(-1), `/n${MAX_PINNED + 2}`);
  let h = hide(state({ opened: [{ path: "/x", at: 1 }, { path: "/y", at: 2 }] }), "/x");
  assert.deepEqual(h.hidden, ["/x"]); assert.deepEqual(h.opened, [{ path: "/y", at: 2 }]);
  assert.deepEqual(hide(h, "/x").hidden, ["/x"], "no duplicates");
  assert.deepEqual(unhide(h, "/x").hidden, []);
  for (let index = 0; index < MAX_HIDDEN + 2; index++) h = hide(h, `/h${index}`);
  assert.equal(h.hidden.length, MAX_HIDDEN); assert.ok(!h.hidden.includes("/x"));
  const reopened = recordOpened(hide(emptyState(), "/z"), "/z", 50);
  assert.deepEqual(reopened.hidden, []); assert.deepEqual(reopened.opened, [{ path: "/z", at: 50 }]);
  const refreshed = recordOpened(reopened, "/z", 90); assert.deepEqual(refreshed.opened, [{ path: "/z", at: 90 }]);
  let o = emptyState(); for (let index = 0; index < MAX_OPENED + 5; index++) o = recordOpened(o, `/o${index}`, index);
  assert.equal(o.opened.length, MAX_OPENED); assert.equal(o.opened[0]!.path, "/o5");
});

test("arrange puts current first, then pins in pin order, then recent by rank, hiding removed entries", () => {
  const items = [item("/cur", 10), item("/p2", 20), item("/p1", 30), item("/old", 40), item("/new", 900), item("/gone", 1000), item("/mid", 500)];
  const s = state({ pinned: ["/p1", "/p2"], hidden: ["/gone"] });
  const out = arrange(items, s, "/cur");
  assert.equal(out.current.cwd, "/cur");
  assert.deepEqual(out.pinned.map((row) => row.cwd), ["/p1", "/p2"]);
  assert.ok(out.pinned.every((row) => row.pinned));
  assert.deepEqual(out.recent.map((row) => row.cwd), ["/new", "/mid", "/old"]);
  assert.ok(out.recent.every((row) => !row.pinned));
  const shuffled = arrange([...items].reverse(), s, "/cur");
  assert.deepEqual(shuffled.recent.map((row) => row.cwd), ["/new", "/mid", "/old"], "order does not depend on input order");
});

test("current is shown even when hidden or absent from the list; a pinned current is not repeated", () => {
  const hiddenCurrent = arrange([item("/a", 1)], state({ hidden: ["/cur"] }), "/cur");
  assert.equal(hiddenCurrent.current.cwd, "/cur"); assert.equal(hiddenCurrent.current.sessions, 0);
  const pinnedCurrent = arrange([item("/cur", 1), item("/b", 2)], state({ pinned: ["/cur", "/b"] }), "/cur");
  assert.deepEqual(pinnedCurrent.pinned.map((row) => row.cwd), ["/b"]);
  assert.equal(pinnedCurrent.current.pinned, true);
  assert.ok(!pinnedCurrent.recent.some((row) => row.cwd === "/cur"));
});

test("pinned paths the server did not list still appear, and an opened folder without chats leads recent", () => {
  const items = [item("/chatted", 1000), item("/older", 10)];
  const out = arrange(items, state({ pinned: ["/only-pinned"], opened: [{ path: "/fresh", at: 5000 }, { path: "/older", at: 20 }] }), "/cur");
  assert.deepEqual(out.pinned.map((row) => [row.cwd, row.sessions]), [["/only-pinned", 0]]);
  assert.deepEqual(out.recent.map((row) => row.cwd), ["/fresh", "/chatted", "/older"]);
  assert.equal(out.recent[0]!.rank, 5000); assert.equal(out.recent[0]!.sessions, 0);
  assert.equal(out.recent[2]!.rank, 20, "rank is the later of last use and open time");
  const hiddenOpened = arrange(items, state({ opened: [{ path: "/fresh", at: 5000 }], hidden: ["/fresh"] }), "/cur");
  assert.ok(!hiddenOpened.recent.some((row) => row.cwd === "/fresh"));
});

test("include paths are the deduplicated union of pins and opened folders and are sent in batches of 50", () => {
  const s = state({ pinned: ["/a", "/b"], opened: [{ path: "/b", at: 1 }, { path: "/c", at: 2 }] });
  assert.deepEqual(includePaths(s), ["/a", "/b", "/c"]);
  const pinned = Array.from({ length: 50 }, (_, index) => `/p${index}`); const opened = Array.from({ length: 50 }, (_, index) => `/o${index}`);
  const all = includePaths(state({ pinned, opened: opened.map((path, at) => ({ path, at })) }));
  assert.equal(all.length, 100);
  const parts = batches(all); assert.deepEqual(parts.map((part) => part.length), [50, 50]);
  assert.deepEqual(batches(["/a"]), [["/a"]]); assert.deepEqual(batches([]), []);
  assert.deepEqual(batches([1, 2, 3], 2), [[1, 2], [3]]);
});

test("batches also respect a URL length budget, and a lone path is never split", () => {
  const long = (n: number) => `/${String(n).padStart(2, "0")}/${"é".repeat(400)}`;
  const many = Array.from({ length: 12 }, (_, index) => long(index));
  const parts = batchPaths(many, 50, 6000);
  assert.deepEqual(parts.flat(), many, "order and membership are preserved");
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.map((path) => `include=${encodeURIComponent(path)}&`).join("").length <= 6000 || part.length === 1);
  assert.deepEqual(batchPaths([long(1)], 50, 10), [[long(1)]]);
  assert.deepEqual(batchPaths([], 50, 100), []);
  const short = Array.from({ length: 101 }, (_, index) => `/s${index}`);
  assert.deepEqual(batchPaths(short).map((part) => part.length), [50, 50, 1]);
});

test("stored values the server would reject are dropped on load, valid ones survive", () => {
  const dirty = JSON.stringify({ version: 1, pinned: ["/ok", "/nul\u0000byte", "   ", "\t"], hidden: ["/h", "/nul\u0000"],
    opened: [{ path: "/o", at: 1 }, { path: "/nul\u0000", at: 1 }, { path: "/far", at: 1e300 }, { path: "/edge", at: 8.64e15 }, { path: "/over", at: 8.64e15 + 1 }] });
  assert.deepEqual(loadState(store(dirty)), { version: 1, pinned: ["/ok"], hidden: ["/h"], opened: [{ path: "/o", at: 1 }, { path: "/edge", at: 8.64e15 }] });
  const wide = `/${"é".repeat(3100)}`; const longButValid = `/${"é".repeat(1500)}`; const longAscii = `/${"a".repeat(4000)}`; const lone = "/bad\ud800path";
  const hostile = loadState(store(JSON.stringify({ version: 1, pinned: [lone, wide, longButValid, longAscii, "/fine"], hidden: [lone, "/h"], opened: [{ path: lone, at: 1 }, { path: wide, at: 1 }, { path: "/o", at: 1 }] })));
  assert.deepEqual(hostile, { version: 1, pinned: [lone, wide, longButValid, longAscii, "/fine"], hidden: [lone, "/h"], opened: [{ path: lone, at: 1 }, { path: wide, at: 1 }, { path: "/o", at: 1 }] }, "every path the server would accept is kept, so no preference is lost");
  assert.deepEqual(includePaths(hostile), [longButValid, longAscii, "/fine", "/o"], "but only paths one request can carry are ever sent");
  assert.deepEqual(includePaths({ version: 1, pinned: [lone, "/a"], hidden: [], opened: [{ path: wide, at: 1 }, { path: "/b", at: 2 }] }), ["/a", "/b"], "and this holds for in-memory state too");
  assert.doesNotThrow(() => batchPaths(includePaths({ version: 1, pinned: [lone], hidden: [], opened: [] })));
  assert.doesNotThrow(() => relativeTime(8.64e15, 0));
  assert.doesNotThrow(() => relativeTime(Number.MAX_VALUE, Number.MIN_VALUE));
});

test("merging batches keeps the richest entry per path", () => {
  const merged = mergeItems([[item("/a", 0, 0), item("/b", 5, 2)], [item("/a", 9, 3, { running: 1 }), item("/b", 5, 1)]]);
  assert.deepEqual(merged.find((entry) => entry.cwd === "/a"), item("/a", 9, 3, { running: 1 }));
  assert.equal(merged.find((entry) => entry.cwd === "/b")!.sessions, 2);
  assert.equal(merged.length, 2);
});

test("filtering matches name or path as a substring first and as ordered characters second", () => {
  const rows = [{ cwd: "/Users/me/projects/raw-cli" }, { cwd: "/Users/me/rocket/web" }, { cwd: "/tmp/other" }];
  assert.deepEqual(filterRows(rows, "RAW").map((row) => row.cwd), ["/Users/me/projects/raw-cli"]);
  assert.deepEqual(filterRows(rows, "rcw").map((row) => row.cwd), ["/Users/me/projects/raw-cli", "/Users/me/rocket/web"]);
  assert.deepEqual(filterRows(rows, "me/r").map((row) => row.cwd), ["/Users/me/rocket/web", "/Users/me/projects/raw-cli"], "the direct match precedes the ordered-character match");
  assert.deepEqual(filterRows(rows, "zzz"), []);
  assert.deepEqual(filterRows(rows, "  "), rows);
});

test("paths are shortened against home and distinguish same-named folders", () => {
  assert.equal(shortenPath("/Users/me", "/Users/me"), "~");
  assert.equal(shortenPath("/Users/me/", "/Users/me/"), "~");
  assert.equal(shortenPath("/Users/me/projects/app", "/Users/me"), "~/projects/app");
  assert.equal(shortenPath("/Users/mentor/app", "/Users/me"), "/Users/mentor/app");
  assert.equal(shortenPath("/srv/app/", "/Users/me"), "/srv/app");
  assert.equal(shortenPath("/srv/app", ""), "/srv/app");
  assert.equal(shortenPath("/", "/Users/me"), "/");
  assert.notEqual(shortenPath("/Users/me/a/app", "/Users/me"), shortenPath("/Users/me/b/app", "/Users/me"));
  assert.equal(baseName("/Users/me/a/app"), "app"); assert.equal(baseName("/Users/me/a/app/"), "app"); assert.equal(baseName("/"), "/");
});

test("long paths are elided in the middle so both the root and the folder name stay visible", () => {
  assert.equal(displayPath("/Users/me/app", "/Users/me"), "~/app");
  const long = "/private/var/folders/_x/8bhwgz2d0m12ddzdfw27jjtc0000gn/T/raw-dashboard-flow-V0kPkY";
  const shown = displayPath(long, "/Users/me");
  assert.ok(shown.length <= 40); assert.ok(shown.startsWith("/private/")); assert.ok(shown.endsWith("dashboard-flow-V0kPkY")); assert.ok(shown.includes("…"));
  assert.equal(displayPath("/a/b", "/Users/me", 40), "/a/b");
  assert.notEqual(displayPath("/very/long/path/that/goes/on/and/on/and/on/and/on/first/app", "", 30), displayPath("/very/long/path/that/goes/on/and/on/and/on/and/on/second/app", "", 30));
});

test("relative time uses stable buckets and a date after a month", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const ago = (ms: number) => relativeTime(now - ms, now);
  assert.equal(relativeTime(0, now), ""); assert.equal(ago(0), "just now"); assert.equal(ago(44_000), "just now");
  assert.equal(relativeTime(now + 60_000, now), "just now", "clock skew");
  assert.equal(ago(45_000), "1 min ago"); assert.equal(ago(5 * 60_000), "5 min ago"); assert.equal(ago(59 * 60_000), "59 min ago");
  assert.equal(ago(60 * 60_000), "1 h ago"); assert.equal(ago(23 * 3_600_000), "23 h ago");
  assert.equal(ago(24 * 3_600_000), "1 d ago"); assert.equal(ago(29 * 86_400_000), "29 d ago");
  assert.equal(ago(31 * 86_400_000), "2026-08-29");
  assert.equal(chatsLabel(0), "0 chats"); assert.equal(chatsLabel(1), "1 chat"); assert.equal(chatsLabel(12), "12 chats");
});
