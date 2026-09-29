import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { PANEL_LIMITS, PanelError, type PanelDocument } from "../src/panels/contract.js";
import { applyUpdate } from "../src/panels/patch.js";
import { derivedProgress, derivedSummary, receiptLine, renderPanelText, truncateBytes } from "../src/panels/render.js";
import { validateDeclaration, validateDocument, validateUpdate } from "../src/panels/validate.js";

const doc = (...blocks: unknown[]) => ({ blocks }) as unknown as PanelDocument;
const rejects = (fn: () => unknown, code: string, pattern?: RegExp) => assert.throws(fn, (error) => {
  assert.ok(error instanceof PanelError, String(error));
  assert.equal(error.code, code);
  if (pattern) assert.match(error.message, pattern);
  return true;
});
const item = (n: number, extra: object = {}) => ({ id: `i${n}`, label: `Item ${n}`, ...extra });
const checklist = (items: unknown[], extra: object = {}) => ({ id: "c", kind: "checklist", items, ...extra });

test("every block kind accepts its minimum and a full example", () => {
  const full = doc(
    checklist([item(1, { status: "done", priority: "high", note: "n", ref: { path: "a.ts", line: 3 }, children: [item(2)] })]),
    { id: "s", kind: "steps", items: [{ id: "p1", label: "Plan", status: "done", detail: "ok", started_at: 1, ended_at: 2 }] },
    { id: "p", kind: "progress", label: "Index", value: 4, max: 10 },
    { id: "pi", kind: "progress", indeterminate: true },
    { id: "k", kind: "key_value", entries: [{ key: "Branch", value: "main", ref: { path: "x" } }] },
    { id: "t", kind: "table", columns: [{ id: "a", label: "A", align: "end" }], rows: [{ id: "r", status: "failed", cells: { a: "1" } }] },
    { id: "m", kind: "markdown", text: "# hi" },
    { id: "e", kind: "timeline", max: 5, events: [{ id: "e1", at: 1, level: "info", label: "x", detail: "y" }] },
    { id: "f", kind: "files", entries: [{ path: "a.ts", status: "added", line: 1, label: "l" }] });
  assert.deepEqual(validateDocument(structuredClone(full)), full);
  for (const block of full.blocks) validateDocument(doc(block));
  validateDocument(doc());
});

test("unknown fields are rejected in documents and known blocks, unknown kinds keep their fallback", () => {
  rejects(() => validateDocument({ blocks: [], extra: 1 }), "panel_invalid", /\/extra/);
  rejects(() => validateDocument(doc(checklist([], { extra: 1 }))), "panel_invalid", /\/blocks\/0\/extra/);
  rejects(() => validateDocument(doc(checklist([{ ...item(1), oops: 1 }]))), "panel_invalid", /\/blocks\/0\/items\/0\/oops/);
  validateDocument(doc({ id: "future", kind: "gantt", tasks: [1, 2], fallback: "Gantt: 2 tasks" }));
  assert.equal(renderPanelText("T", doc({ id: "future", kind: "gantt", fallback: "Gantt: 2 tasks" })).split("\n").at(-1), "Gantt: 2 tasks");
  assert.match(renderPanelText("T", doc({ id: "future", kind: "gantt" })), /Unsupported block "gantt"/);
});

test("limits hold at the boundary and fail one past it with panel_invalid", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => item(i));
  validateDocument(doc(checklist(many(200))));
  rejects(() => validateDocument(doc(checklist(many(201)))), "panel_invalid", /at most 200/);
  validateDocument(doc(...Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, kind: "markdown", text: "" }))));
  rejects(() => validateDocument(doc(...Array.from({ length: 21 }, (_, i) => ({ id: `b${i}`, kind: "markdown", text: "" })))), "panel_invalid");
  const steps = (n: number) => ({ id: "s", kind: "steps", items: Array.from({ length: n }, (_, i) => item(i)) });
  validateDocument(doc(steps(30)));
  rejects(() => validateDocument(doc(steps(31))), "panel_invalid");
  const kv = (n: number) => ({ id: "k", kind: "key_value", entries: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: "v" })) });
  validateDocument(doc(kv(50)));
  rejects(() => validateDocument(doc(kv(51))), "panel_invalid");
  const columns = (n: number) => ({ id: "t", kind: "table", columns: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: "c" })), rows: [] });
  validateDocument(doc(columns(8)));
  rejects(() => validateDocument(doc(columns(9))), "panel_invalid");
  rejects(() => validateDocument(doc(columns(0))), "panel_invalid");
  validateDocument(doc(checklist([item(1, { label: "x".repeat(200), note: "n".repeat(500) })])));
  rejects(() => validateDocument(doc(checklist([item(1, { label: "x".repeat(201) })]))), "panel_invalid", /label/);
  rejects(() => validateDocument(doc(checklist([item(1, { note: "n".repeat(501) })]))), "panel_invalid", /note/);
  validateDocument({ title: "t".repeat(80), subtitle: "s".repeat(120), summary: "m".repeat(120), blocks: [] });
  rejects(() => validateDocument({ title: "t".repeat(81), blocks: [] }), "panel_invalid");
  rejects(() => validateDocument({ summary: "m".repeat(121), blocks: [] }), "panel_invalid");
  rejects(() => validateDocument({ context_summary: "é".repeat(1025), blocks: [] }), "panel_invalid", /bytes/);
  validateDocument({ context_summary: "é".repeat(1024), blocks: [] });
});

test("the 200 item limit counts children and depth stops at 3", () => {
  const parent = (children: unknown[]) => item(0, { children });
  const leafs = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1));
  validateDocument(doc(checklist([parent(leafs(199))])));
  rejects(() => validateDocument(doc(checklist([parent(leafs(200))]))), "panel_invalid", /200 items/);
  const nest = (levels: number): unknown => levels === 0 ? item(99) : item(levels, { children: [nest(levels - 1)] });
  validateDocument(doc(checklist([nest(2)])));
  rejects(() => validateDocument(doc(checklist([nest(3)]))), "panel_invalid", /levels/);
});

test("ids follow their grammars and are unique within their scope", () => {
  rejects(() => validateDocument(doc({ id: "has space", kind: "markdown", text: "" })), "panel_invalid", /id/);
  rejects(() => validateDocument(doc({ id: "a", kind: "markdown", text: "" }, { id: "a", kind: "markdown", text: "" })), "panel_invalid", /duplicate/);
  rejects(() => validateDocument(doc(checklist([item(1), item(1)]))), "panel_invalid", /duplicate/);
  rejects(() => validateDocument(doc(checklist([item(1, { children: [item(1)] })]))), "panel_invalid", /duplicate/);
  validateDocument(doc({ id: "b", kind: "markdown", text: "" }, { ...checklist([item(1)]), id: "c2" }, { id: "s", kind: "steps", items: [item(1)] }));
  rejects(() => validateDocument(doc(checklist([{ ...item(1), id: "x".repeat(65) }]))), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "k", kind: "key_value", entries: [{ key: "a", value: "1" }, { key: "a", value: "2" }] })), "panel_invalid", /duplicate/);
  rejects(() => validateDocument(doc({ id: "f", kind: "files", entries: [{ path: "a" }, { path: "a" }] })), "panel_invalid", /duplicate/);
});

test("strings reject control characters other than newline and tab", () => {
  validateDocument(doc({ id: "m", kind: "markdown", text: "a\nb\tc" }));
  for (const bad of ["\u0000", "\u0007", "\r", "\u001b[31m", "\u007f"]) {
    rejects(() => validateDocument(doc({ id: "m", kind: "markdown", text: `x${bad}` })), "panel_invalid", /control/);
    rejects(() => validateDocument(doc(checklist([item(1, { label: `x${bad}` })]))), "panel_invalid", /control/);
  }
});

test("progress, table, timeline and markdown enforce their own contracts", () => {
  rejects(() => validateDocument(doc({ id: "p", kind: "progress", value: 5, max: 4 })), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "p", kind: "progress", value: 1, max: 0 })), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "p", kind: "progress", value: -1, max: 4 })), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "p", kind: "progress", value: Infinity, max: 4 })), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "p", kind: "progress", indeterminate: true, value: 1 })), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "t", kind: "table", columns: [{ id: "a", label: "A" }], rows: [{ id: "r", cells: { b: "x" } }] })), "panel_invalid", /unknown column/);
  rejects(() => validateDocument(doc({ id: "t", kind: "table", columns: [{ id: "a", label: "A" }], rows: [{ id: "r", cells: { a: "x".repeat(301) } }] })), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "e", kind: "timeline", max: 201, events: [] })), "panel_invalid");
  rejects(() => validateDocument(doc({ id: "e", kind: "timeline", max: 1, events: [
    { id: "a", at: 1, level: "info", label: "a" }, { id: "b", at: 2, level: "info", label: "b" }] })), "panel_invalid");
  validateDocument(doc({ id: "m", kind: "markdown", text: "x".repeat(PANEL_LIMITS.markdownBytes) }));
  rejects(() => validateDocument(doc({ id: "m", kind: "markdown", text: "x".repeat(PANEL_LIMITS.markdownBytes + 1) })), "panel_invalid");
});

test("the 64 KiB document limit is measured in serialized UTF-8 bytes", () => {
  const filler = (bytes: number) => doc(...Array.from({ length: Math.ceil(bytes / 16000) }, (_, i) =>
    ({ id: `m${i}`, kind: "markdown", text: "é".repeat(Math.min(8000, Math.ceil((bytes - i * 16000) / 2))) })));
  const size = (d: unknown) => Buffer.byteLength(JSON.stringify(d));
  const under = filler(60000);
  assert.ok(size(under) < PANEL_LIMITS.documentBytes);
  validateDocument(under);
  const over = filler(70000);
  assert.ok(size(over) > PANEL_LIMITS.documentBytes);
  rejects(() => validateDocument(over), "panel_too_large");
  // 32769 two-byte characters: fewer than 64 K characters but more than 64 KiB.
  const chars = doc(...Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, kind: "markdown", text: "é".repeat(7000) })));
  assert.ok(size(chars) > PANEL_LIMITS.documentBytes);
  rejects(() => validateDocument(chars), "panel_too_large");
});

test("derived progress counts leaf items, then steps, and derived summary names the active item", () => {
  const nested = doc(checklist([item(1, { status: "done" }), item(2, { status: "in_progress", children: [
    item(3, { status: "done" }), item(4, { status: "skipped" }), item(5, { status: "in_progress", label: "Deep task" })] })]));
  assert.deepEqual(derivedProgress(nested), { done: 3, total: 4 });
  assert.equal(derivedSummary(nested), "3/4 · Item 2"); // a parent in progress comes first in tree order
  assert.equal(derivedSummary(doc(checklist([item(1, { children: [item(2, { status: "in_progress", label: "Deep task" })] })]))), "0/1 · Deep task");
  const stepsOnly = doc({ id: "s", kind: "steps", items: [item(1, { status: "done" }), item(2)] });
  assert.deepEqual(derivedProgress(stepsOnly), { done: 1, total: 2 });
  assert.equal(derivedSummary(stepsOnly), "1/2");
  const checklistWins = doc({ id: "s", kind: "steps", items: [item(1)] }, { ...checklist([item(2, { status: "done" })]), id: "c2" });
  assert.deepEqual(derivedProgress(checklistWins), { done: 1, total: 1 });
  const none = doc({ id: "m", kind: "markdown", title: "Notes", text: "x" });
  assert.equal(derivedProgress(none), undefined);
  assert.equal(derivedSummary(none), "Notes");
  assert.equal(derivedSummary({ ...none, title: "Doc" , blocks: [] }, "Fallback"), "Doc");
  assert.equal(derivedSummary({ blocks: [] } as PanelDocument, "Fallback"), "Fallback");
  assert.equal(derivedSummary({ ...nested, summary: "given" }), "given");
  assert.equal(derivedSummary({ ...nested, summary: "" }), "", "an explicit empty summary is kept");
  assert.deepEqual(derivedProgress(doc(checklist([]), { id: "s", kind: "steps", items: [item(1)] })), { done: 0, total: 0 }, "an empty checklist still owns the progress");
  assert.deepEqual(derivedProgress({ ...nested, progress: { done: 9, total: 9 } }), { done: 9, total: 9 });
});

test("text rendering follows the glyph table for every kind", () => {
  const text = renderPanelText("Todo", {
    blocks: [
      checklist([item(1, { status: "done" }), item(2, { status: "in_progress", note: "wait", ref: { path: "a.ts", line: 4 }, children: [item(3, { status: "blocked" }), item(4, { status: "failed" })] }), item(5, { status: "skipped" })], { title: "Tasks" }),
      { id: "s", kind: "steps", items: [{ id: "p1", label: "Plan", status: "done", detail: "approved", started_at: 0, ended_at: 600000 }] },
      { id: "p", kind: "progress", label: "Indexing", value: 42, max: 100 },
      { id: "k", kind: "key_value", entries: [{ key: "Branch", value: "main" }] },
      { id: "t", kind: "table", columns: [{ id: "n", label: "Test" }, { id: "ms", label: "Time" }], rows: [{ id: "r", status: "failed", cells: { n: "login", ms: "12 ms" } }] },
      { id: "e", kind: "timeline", events: [{ id: "1", at: 1, level: "info", label: "first" }, { id: "2", at: 2, level: "error", label: "second", detail: "bad" }] },
      { id: "f", kind: "files", entries: [{ path: "src/a.ts", status: "modified", line: 42, label: "handler" }, { path: "b" }] },
    ],
  } as PanelDocument);
  const lines = text.split("\n");
  assert.equal(lines[0], "Todo (2/4)"); // leaves are 1, 3, 4, 5 and two are done or skipped
  for (const expected of ["## Tasks", "[x] Item 1", "[~] Item 2 — wait (a.ts:4)", "  [!] Item 3", "  [✗] Item 4", "[-] Item 5",
    "1. [x] Plan — approved (10m)", "Indexing 42%", "Branch: main", "[✗]  login  12 ms", "[error] second — bad", "M src/a.ts:42 handler", "R b"]) {
    assert.ok(lines.some((line) => line.replace(/\s+/g, " ").trim() === expected.replace(/\s+/g, " ").trim()), `missing: ${expected}\n${text}`);
  }
  assert.ok(lines.indexOf("[error] second — bad") < lines.indexOf("[info] first"), "timeline is newest first");
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, cells: { a: String(i) } }));
  const table = renderPanelText("T", doc({ id: "t", kind: "table", columns: [{ id: "a", label: "A" }], rows }));
  assert.match(table, /… 10 more rows$/);
});

test("receipts render without color and rejections name the code", () => {
  assert.equal(receiptLine({ title: "Todo", revision: 5, summary: "3/7 · Fix the API" }), "  ▸ Todo r5 · 3/7 · Fix the API");
  assert.equal(receiptLine({ title: "Todo", revision: 5, summary: "", error: { code: "panel_invalid", message: "x" } }), "  ▸ Todo update rejected: panel_invalid");
  assert.equal(Buffer.byteLength(truncateBytes("é".repeat(100), 21)) <= 21, true);
  assert.ok(truncateBytes("é".repeat(100), 21).endsWith("…"));
  assert.equal(truncateBytes("short", 21), "short");
});

// ---- update validation and the patch engine ----

const base = (): PanelDocument => doc(
  checklist([item(1, { status: "pending" }), item(2, { children: [item(3)] })], { title: "Tasks" }),
  { id: "t", kind: "table", columns: [{ id: "a", label: "A" }], rows: [{ id: "r1", cells: { a: "1" } }] },
  { id: "k", kind: "key_value", entries: [{ key: "x", value: "1" }] },
  { id: "f", kind: "files", entries: [{ path: "a.ts", status: "added" }] },
  { id: "e", kind: "timeline", max: 3, events: [{ id: "e1", at: 1, level: "info", label: "one" }] },
  { id: "m", kind: "markdown", text: "hi" });
const state = () => ({ document: base(), closed: false });
const patch = (...patches: unknown[]) => ({ panel: "todo", op: "patch", patches });

test("updates validate their shape", () => {
  rejects(() => validateUpdate({ panel: "Bad", op: "close" }), "panel_invalid");
  rejects(() => validateUpdate({ panel: "todo", op: "wipe" }), "panel_invalid");
  rejects(() => validateUpdate({ panel: "todo", op: "close", document: {} }), "panel_invalid", /document/);
  rejects(() => validateUpdate({ panel: "todo", op: "replace" }), "panel_invalid");
  rejects(() => validateUpdate({ panel: "todo", op: "patch", patches: [] }), "panel_invalid");
  rejects(() => validateUpdate({ panel: "todo", op: "patch", base_revision: -1, patches: [{ op: "remove_block", id: "a" }] }), "panel_invalid");
  rejects(() => validateUpdate(patch({ op: "explode" })), "panel_invalid", /patches\/0\/op/);
  rejects(() => validateUpdate(patch({ op: "remove_items", block: "c", ids: ["a"], keys: ["b"] })), "panel_invalid", /exactly one/);
  rejects(() => validateUpdate(patch({ op: "remove_items", block: "c" })), "panel_invalid", /exactly one/);
  rejects(() => validateUpdate(patch({ op: "set", field: "nope", value: 1 })), "panel_invalid");
  validateUpdate(patch({ op: "set", field: "summary", value: null }));
});

test("replace sets a validated copy and reopens; patch and close need an existing panel", () => {
  const input = base();
  const replaced = applyUpdate({ document: doc(), closed: true }, { panel: "todo", op: "replace", document: input });
  assert.equal(replaced.closed, false);
  assert.deepEqual(replaced.document, input);
  assert.notEqual(replaced.document, input);
  rejects(() => applyUpdate(undefined, patch({ op: "remove_block", id: "c" })), "panel_unknown");
  rejects(() => applyUpdate(undefined, { panel: "todo", op: "close" }), "panel_unknown");
  const closed = applyUpdate(state(), { panel: "todo", op: "close" });
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.document, base());
  assert.equal(applyUpdate(closed, patch({ op: "set", field: "title", value: "T" })).closed, true);
});

test("a failing patch leaves every input untouched and rejects the whole update", () => {
  const before = state();
  const snapshot = structuredClone(before);
  const bad = patch({ op: "set", field: "title", value: "changed" }, { op: "remove_block", id: "missing" });
  rejects(() => applyUpdate(before, bad), "panel_invalid", /patches\/1\/id/);
  assert.deepEqual(before, snapshot);
  // valid patches, invalid result: first patch is fine, the merged document breaks a limit
  const overflow = patch({ op: "upsert_items", block: "c", items: Array.from({ length: 200 }, (_, i) => item(100 + i)) });
  rejects(() => applyUpdate(before, overflow), "panel_invalid", /at most 200/);
  assert.deepEqual(before, snapshot);
  // a new item without a label fails final validation, so the whole update is dropped
  rejects(() => applyUpdate(before, patch({ op: "upsert_items", block: "c", items: [{ id: "new" }] })), "panel_invalid", /label/);
  assert.deepEqual(before, snapshot);
});

test("set updates header fields and null removes optional ones", () => {
  let next = applyUpdate(state(), patch({ op: "set", field: "title", value: "Hi" }, { op: "set", field: "progress", value: { done: 1, total: 2 } }, { op: "set", field: "status", value: "done" }));
  assert.equal(next.document.title, "Hi");
  assert.deepEqual(next.document.progress, { done: 1, total: 2 });
  next = applyUpdate(next, patch({ op: "set", field: "title", value: null }, { op: "set", field: "progress", value: null }));
  assert.equal("title" in next.document, false);
  assert.equal("progress" in next.document, false);
  rejects(() => applyUpdate(next, patch({ op: "set", field: "summary", value: 5 })), "panel_invalid");
});

test("set_block replaces by id, inserts before another block, and appends otherwise", () => {
  const md = (id: string, text: string) => ({ id, kind: "markdown", text });
  let next = applyUpdate(state(), patch({ op: "set_block", block: md("m", "new") }));
  assert.deepEqual(next.document.blocks.map((b) => b.id), ["c", "t", "k", "f", "e", "m"]);
  assert.equal((next.document.blocks.at(-1) as unknown as { text: string }).text, "new");
  next = applyUpdate(next, patch({ op: "set_block", block: md("first", "x"), before: "c" }, { op: "set_block", block: md("last", "y") }));
  assert.deepEqual(next.document.blocks.map((b) => b.id), ["first", "c", "t", "k", "f", "e", "m", "last"]);
  rejects(() => applyUpdate(next, patch({ op: "set_block", block: md("z", "x"), before: "ghost" })), "panel_invalid", /ghost/);
  rejects(() => applyUpdate(next, patch({ op: "set_block", block: { id: "z", kind: "markdown" } })), "panel_invalid");
});

test("upsert_items merges given fields, keeps omitted ones and appends new items", () => {
  let next = applyUpdate(state(), patch({ op: "upsert_items", block: "c", items: [{ id: "i1", status: "done" }, { id: "i9", label: "Nine" }] }));
  const items = (next.document.blocks[0] as unknown as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items[0], { id: "i1", label: "Item 1", status: "done" });
  assert.equal(items.at(-1)?.id, "i9");
  next = applyUpdate(next, patch({ op: "upsert_items", block: "c", parent: "i2", items: [{ id: "i10", label: "Under two" }, { id: "i3", status: "done" }] }));
  const two = (next.document.blocks[0] as unknown as { items: Array<{ id: string; children?: Array<Record<string, unknown>> }> }).items.find((entry) => entry.id === "i2")!;
  assert.deepEqual(two.children?.map((child) => child.id), ["i3", "i10"]);
  assert.equal(two.children?.[0]?.status, "done");
  // an existing item found in a child list is updated in place even when a different parent is named
  next = applyUpdate(next, patch({ op: "upsert_items", block: "c", parent: "i1", items: [{ id: "i3", note: "moved?" }] }));
  const three = (next.document.blocks[0] as unknown as { items: Array<{ id: string; children?: Array<Record<string, unknown>> }> }).items.find((entry) => entry.id === "i2")!.children![0]!;
  assert.equal(three.note, "moved?");
  rejects(() => applyUpdate(next, patch({ op: "upsert_items", block: "c", parent: "ghost", items: [{ id: "n", label: "n" }] })), "panel_invalid", /ghost/);
  rejects(() => applyUpdate(next, patch({ op: "upsert_items", block: "m", items: [{ id: "n" }] })), "panel_invalid", /does not support/);
  rejects(() => applyUpdate(next, patch({ op: "upsert_items", block: "t", parent: "r1", items: [{ id: "n", cells: {} }] })), "panel_invalid", /parent/);
  rejects(() => applyUpdate(next, patch({ op: "upsert_items", block: "ghost", items: [{ id: "n" }] })), "panel_invalid", /ghost/);
  // table rows by id, key_value by key, files by path
  next = applyUpdate(next, patch(
    { op: "upsert_items", block: "t", items: [{ id: "r1", cells: { a: "2" } }, { id: "r2", cells: { a: "3" } }] },
    { op: "upsert_items", block: "k", items: [{ key: "x", value: "2" }, { key: "y", value: "3" }] },
    { op: "upsert_items", block: "f", items: [{ path: "a.ts", status: "modified" }, { path: "b.ts" }] }));
  const [, table, kv, files] = next.document.blocks as unknown as Array<{ rows?: unknown[]; entries?: unknown[] }>;
  assert.deepEqual(table!.rows, [{ id: "r1", cells: { a: "2" } }, { id: "r2", cells: { a: "3" } }]);
  assert.deepEqual(kv!.entries, [{ key: "x", value: "2" }, { key: "y", value: "3" }]);
  assert.deepEqual(files!.entries, [{ path: "a.ts", status: "modified" }, { path: "b.ts" }]);
});

test("remove_items takes exactly the selector that fits the block kind and removes checklist children", () => {
  let next = applyUpdate(state(), patch({ op: "remove_items", block: "c", ids: ["i2"] }));
  assert.deepEqual((next.document.blocks[0] as unknown as { items: Array<{ id: string }> }).items.map((entry) => entry.id), ["i1"]);
  next = applyUpdate(state(), patch({ op: "remove_items", block: "c", ids: ["i3"] })); // nested id
  assert.equal((next.document.blocks[0] as unknown as { items: Array<{ children?: unknown[] }> }).items[1]?.children?.length, 0);
  next = applyUpdate(next, patch(
    { op: "remove_items", block: "t", ids: ["r1"] }, { op: "remove_items", block: "k", keys: ["x"] },
    { op: "remove_items", block: "f", paths: ["a.ts"] }, { op: "remove_items", block: "e", ids: ["e1"] }));
  const blocks = next.document.blocks as unknown as Array<Record<string, unknown[]>>;
  assert.deepEqual([blocks[1]!.rows, blocks[2]!.entries, blocks[3]!.entries, blocks[4]!.events], [[], [], [], []]);
  for (const [block, selector] of [["c", "keys"], ["c", "paths"], ["t", "keys"], ["k", "ids"], ["k", "paths"], ["f", "ids"], ["f", "keys"], ["e", "paths"]] as const) {
    rejects(() => applyUpdate(state(), patch({ op: "remove_items", block, [selector]: ["x"] })), "panel_invalid", /take/);
  }
  rejects(() => applyUpdate(state(), patch({ op: "remove_items", block: "c", ids: ["nope"] })), "panel_invalid", /does not exist/);
  rejects(() => applyUpdate(state(), patch({ op: "remove_items", block: "m", ids: ["x"] })), "panel_invalid", /does not support/);
  const before = state();
  rejects(() => applyUpdate(before, patch({ op: "remove_items", block: "c", ids: ["i1", "nope"] })), "panel_invalid");
  assert.deepEqual(before, state());
});

test("append_events keeps the newest events up to max and only works on timelines", () => {
  const ev = (n: number) => ({ id: `n${n}`, at: n, level: "info", label: `event ${n}` });
  const next = applyUpdate(state(), patch({ op: "append_events", block: "e", events: [ev(2), ev(3), ev(4)] }));
  assert.deepEqual((next.document.blocks[4] as unknown as { events: Array<{ id: string }> }).events.map((entry) => entry.id), ["n2", "n3", "n4"]);
  rejects(() => applyUpdate(state(), patch({ op: "append_events", block: "c", events: [ev(1)] })), "panel_invalid", /not a timeline/);
  rejects(() => applyUpdate(state(), patch({ op: "append_events", block: "e", events: [{ ...ev(1), id: "e1" }] })), "panel_invalid", /duplicate/);
});

test("remove_block deletes by id and reports unknown ids", () => {
  const next = applyUpdate(state(), patch({ op: "remove_block", id: "m" }, { op: "remove_block", id: "c" }));
  assert.deepEqual(next.document.blocks.map((b) => b.id), ["t", "k", "f", "e"]);
  rejects(() => applyUpdate(state(), patch({ op: "remove_block", id: "m" }, { op: "remove_block", id: "m" })), "panel_invalid", /patches\/1/);
});

test("random patch sequences match an independent reference model", () => {
  let seed = 12345;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 40; round++) {
    let actual = { document: doc(checklist([]), { id: "k", kind: "key_value", entries: [] }), closed: false };
    const model = new Map<string, string>();
    const order: string[] = [];
    for (let step = 0; step < 25; step++) {
      const key = `id${rand(8)}`;
      const ops: unknown[] = [];
      if (rand(3) === 0 && model.has(key)) { ops.push({ op: "remove_items", block: "c", ids: [key] }); model.delete(key); order.splice(order.indexOf(key), 1); }
      else {
        const label = `label ${rand(100)}`;
        ops.push({ op: "upsert_items", block: "c", items: model.has(key) ? [{ id: key, label }] : [{ id: key, label }] });
        if (!model.has(key)) order.push(key);
        model.set(key, label);
      }
      actual = applyUpdate(actual, patch(...ops));
      const items = (actual.document.blocks[0] as { items: Array<{ id: string; label: string }> }).items;
      assert.deepEqual(items.map((entry) => [entry.id, entry.label]), order.map((id) => [id, model.get(id)]));
    }
  }
});

// ---- declarations ----

test("declarations validate ids, limits, actions and templates", () => {
  const warnings: string[] = [];
  const declared = validateDeclaration({ id: "todo", title: "Todo", icon: "sparkles", actions: [
    { id: "complete", label: "Mark done", scope: "item", blocks: ["items"], kind: "tool", arguments: { todos: [{ id: "{{item.id}}" }] }, primary: true },
    { id: "go", label: "Continue", scope: "panel", kind: "prompt", text: "Do {{panel.id}}" }] }, "panels[0]", (m) => warnings.push(m));
  assert.equal(declared.icon, "panel");
  assert.equal(declared.open, "never");
  assert.equal(declared.context, "none");
  assert.equal(declared.acp_plan, false);
  assert.match(warnings[0]!, /unknown icon "sparkles"/);
  rejects(() => validateDeclaration({ id: "Todo", title: "T" }, "p"), "panel_invalid");
  rejects(() => validateDeclaration({ id: "t", title: "" }, "p"), "panel_invalid");
  rejects(() => validateDeclaration({ id: "t", title: "x".repeat(41) }, "p"), "panel_invalid");
  rejects(() => validateDeclaration({ id: "t", title: "T", extra: 1 }, "p"), "panel_invalid");
  rejects(() => validateDeclaration({ id: "t", title: "T", open: "always" }, "p"), "panel_invalid");
  const act = (n: number) => ({ id: `a${n}`, label: "L", scope: "panel", kind: "prompt", text: "x" });
  validateDeclaration({ id: "t", title: "T", actions: Array.from({ length: 8 }, (_, i) => act(i)) }, "p");
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: Array.from({ length: 9 }, (_, i) => act(i)) }, "p"), "panel_invalid");
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [act(1), act(1)] }, "p"), "panel_invalid", /duplicate/);
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [{ ...act(1), text: "{{item.secret}}" }] }, "p"), "panel_invalid", /template/);
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [{ ...act(1), kind: "tool" }] }, "p"), "panel_invalid", /arguments/);
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [{ ...act(1), scope: "panel", primary: true }] }, "p"), "panel_invalid", /item/);
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [{ ...act(1), arguments: {} }] }, "p"), "panel_invalid", /tool actions/);
  const primary = (n: number) => ({ id: `p${n}`, label: "L", scope: "item", kind: "tool", arguments: {}, primary: true });
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [primary(1), primary(2)] }, "p"), "panel_invalid", /primary/);
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [{ ...act(1), text: "x".repeat(2001) }] }, "p"), "panel_invalid");
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [{ id: "a", label: "x".repeat(33), scope: "panel", kind: "prompt", text: "x" }] }, "p"), "panel_invalid");
  validateDeclaration({ id: "t", title: "T", actions: [{ ...primary(1), when: { status: ["pending"] }, confirm: "Sure?" }] }, "p");
  rejects(() => validateDeclaration({ id: "t", title: "T", actions: [{ ...primary(1), when: { status: ["nope"] } }] }, "p"), "panel_invalid");
});

// ---- the published schema agrees with the validator on shape ----

test("schemas/raw-panel.schema.json and the validator agree on structural fixtures", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/raw-panel.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020.default({ strict: false, allErrors: true });
  const check = ajv.compile(schema);
  const replace = (...blocks: unknown[]) => ({ panel: "todo", op: "replace", document: { blocks } });
  const fixtures: Array<[string, unknown]> = [
    ["empty", replace()],
    ["checklist", replace(checklist([item(1, { children: [item(2)] })]))],
    ["all kinds", replace(checklist([item(1)]), { id: "s", kind: "steps", items: [item(1)] }, { id: "p", kind: "progress", value: 1, max: 2 },
      { id: "k", kind: "key_value", entries: [{ key: "a", value: "b" }] }, { id: "t", kind: "table", columns: [{ id: "a", label: "A" }], rows: [] },
      { id: "m", kind: "markdown", text: "x" }, { id: "e", kind: "timeline", events: [] }, { id: "f", kind: "files", entries: [] })],
    ["unknown kind", replace({ id: "x", kind: "gantt", anything: 1 })],
    ["close", { panel: "todo", op: "close" }],
    ["patch", patch({ op: "remove_block", id: "a" })],
    ["bad panel id", { panel: "Todo", op: "close" }],
    ["bad op", { panel: "todo", op: "wipe" }],
    ["missing blocks", { panel: "todo", op: "replace", document: {} }],
    ["unknown doc field", { panel: "todo", op: "replace", document: { blocks: [], extra: 1 } }],
    ["bad block id", replace({ id: "a b", kind: "markdown", text: "" })],
    ["checklist bad status", replace(checklist([item(1, { status: "nope" })]))],
    ["progress no max", replace({ id: "p", kind: "progress", value: 1 })],
    ["progress zero max", replace({ id: "p", kind: "progress", value: 0, max: 0 })],
    ["too many blocks", replace(...Array.from({ length: 21 }, (_, i) => ({ id: `b${i}`, kind: "markdown", text: "" })))],
    ["patch none", { panel: "todo", op: "patch", patches: [] }],
  ];
  for (const [name, value] of fixtures) {
    let accepted = true;
    try { validateUpdate(value); } catch { accepted = false; }
    assert.equal(check(value), accepted, `${name}: schema=${check(value)} validator=${accepted}`);
  }
});

// ---- review hardening ----

test("boundaries: 200 rows, files and events, 3 levels with empty children, and exactly 64 KiB", () => {
  const rows = (n: number) => ({ id: "t", kind: "table", columns: [{ id: "a", label: "A" }], rows: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, cells: {} })) });
  validateDocument(doc(rows(200)));
  rejects(() => validateDocument(doc(rows(201))), "panel_invalid", /at most 200/);
  const files = (n: number) => ({ id: "f", kind: "files", entries: Array.from({ length: n }, (_, i) => ({ path: `f${i}` })) });
  validateDocument(doc(files(200)));
  rejects(() => validateDocument(doc(files(201))), "panel_invalid", /at most 200/);
  const events = (n: number) => ({ id: "e", kind: "timeline", max: 200, events: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, at: i, level: "info", label: "x" })) });
  validateDocument(doc(events(200)));
  rejects(() => validateDocument(doc(events(201))), "panel_invalid", /at most 200/);
  // an empty children array at the deepest allowed level is not a fourth level
  validateDocument(doc(checklist([item(1, { children: [item(2, { children: [item(3, { children: [] })] })] })])));
  rejects(() => validateDocument(doc(checklist([item(1, { children: [item(2, { children: [item(3, { children: [item(4)] })] })] })]))), "panel_invalid", /levels/);
  rejects(() => validateDocument(doc(checklist([item(1, { children: "x" })]))), "panel_invalid", /children/);
  const sized = (target: number) => {
    const blocks = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, kind: "markdown", text: "" }));
    let remaining = target - Buffer.byteLength(JSON.stringify({ blocks }));
    for (const block of blocks) { const take = Math.min(remaining, PANEL_LIMITS.markdownBytes); block.text = "x".repeat(take); remaining -= take; }
    assert.equal(remaining, 0);
    return { blocks } as unknown as PanelDocument;
  };
  assert.equal(Buffer.byteLength(JSON.stringify(sized(65536))), 65536);
  validateDocument(sized(65536));
  assert.equal(Buffer.byteLength(JSON.stringify(sized(65537))), 65537);
  rejects(() => validateDocument(sized(65537)), "panel_too_large");
});

test("JSON-supplied __proto__ and prototype-named ids stay data and never reach Object.prototype", () => {
  const parsed = JSON.parse('{"panel":"todo","op":"patch","patches":[{"op":"upsert_items","block":"c","items":[{"id":"i1","__proto__":{"polluted":true}}]}]}');
  rejects(() => applyUpdate(state(), parsed), "panel_invalid", /__proto__/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const raw = JSON.parse('{"blocks":[{"id":"c","kind":"checklist","items":[{"id":"i1","label":"x","__proto__":{"a":1}}]}]}');
  rejects(() => validateDocument(raw), "panel_invalid", /__proto__/);
  // column ids that name inherited properties render as empty cells, not as inherited values
  const text = renderPanelText("T", doc({ id: "t", kind: "table", columns: [{ id: "constructor", label: "C" }, { id: "toString", label: "S" }], rows: [{ id: "r", cells: {} }] }));
  assert.ok(!text.includes("function") && !text.includes("[native"), text);
  const withCell = renderPanelText("T", doc({ id: "t", kind: "table", columns: [{ id: "constructor", label: "C" }], rows: [{ id: "r", cells: { constructor: "real" } }] }));
  assert.match(withCell, /real/);
});

test("replacing children in a checklist upsert refreshes the index for later items in the same patch", () => {
  const start = { document: doc(checklist([item(1, { children: [item(2)] })])), closed: false };
  // i2 is dropped by replacing i1's children; a later upsert of i2 must therefore add a new item, not edit a detached one
  const next = applyUpdate(start, patch({ op: "upsert_items", block: "c", items: [
    { id: "i1", children: [item(3)] }, { id: "i2", label: "Fresh i2" }] }));
  const items = (next.document.blocks[0] as unknown as { items: Array<{ id: string; label: string; children?: Array<{ id: string }> }> }).items;
  assert.deepEqual(items.map((entry) => entry.id), ["i1", "i2"]);
  assert.deepEqual(items[0]!.children?.map((entry) => entry.id), ["i3"]);
  assert.equal(items[1]!.label, "Fresh i2");
  // and an item inside the replacement subtree can be updated by the same patch
  const inner = applyUpdate(start, patch({ op: "upsert_items", block: "c", items: [
    { id: "i1", children: [item(3)] }, { id: "i3", status: "done" }] }));
  assert.equal((inner.document.blocks[0] as unknown as { items: Array<{ children: Array<{ status: string }> }> }).items[0]!.children[0]!.status, "done");
});

test("status can be removed, kinds reject control characters, and patch counts are not capped", () => {
  const next = applyUpdate({ document: { ...base(), status: "done" }, closed: false }, patch({ op: "set", field: "status", value: null }));
  assert.equal("status" in next.document, false);
  rejects(() => validateDocument(doc({ id: "x", kind: "a\u0000b" })), "panel_invalid", /kind/);
  const many = Array.from({ length: 150 }, (_, i) => ({ op: "set", field: "summary", value: `s${i}` }));
  assert.equal(applyUpdate(state(), patch(...many)).document.summary, "s149");
});

test("the published schema rejects malformed nested shapes the validator rejects", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/raw-panel.schema.json", import.meta.url), "utf8"));
  const check = new Ajv2020.default({ strict: false, allErrors: true }).compile(schema);
  const replace = (...blocks: unknown[]) => ({ panel: "todo", op: "replace", document: { blocks } });
  const bad: Array<[string, unknown]> = [
    ["checklist extra field", replace(checklist([], { extra: 1 }))],
    ["steps item without label", replace({ id: "s", kind: "steps", items: [{ id: "a" }] })],
    ["key_value entry without value", replace({ id: "k", kind: "key_value", entries: [{ key: "a" }] })],
    ["table row without cells", replace({ id: "t", kind: "table", columns: [{ id: "a", label: "A" }], rows: [{ id: "r" }] })],
    ["timeline event bad level", replace({ id: "e", kind: "timeline", events: [{ id: "1", at: 1, level: "loud", label: "x" }] })],
    ["files entry without path", replace({ id: "f", kind: "files", entries: [{ status: "added" }] })],
    ["progress with both", replace({ id: "p", kind: "progress", indeterminate: true, value: 1, max: 2 })],
    ["set unknown field", patch({ op: "set", field: "nope", value: 1 })],
    ["upsert without items", patch({ op: "upsert_items", block: "c" })],
    ["remove_items two selectors", patch({ op: "remove_items", block: "c", ids: ["a"], keys: ["b"] })],
    ["remove_items none", patch({ op: "remove_items", block: "c" })],
    ["set_block bad block", patch({ op: "set_block", block: { id: "a b", kind: "markdown", text: "" } })],
  ];
  for (const [name, value] of bad) {
    assert.equal(check(value), false, `schema accepted: ${name}`);
    assert.throws(() => validateUpdate(value), PanelError, `validator accepted: ${name}`);
  }
  // field values are checked when the patched document is validated as a whole
  assert.equal(check(patch({ op: "set", field: "status", value: "loud" })), false);
  rejects(() => applyUpdate(state(), patch({ op: "set", field: "status", value: "loud" })), "panel_invalid");
  const badEvent = patch({ op: "append_events", block: "e", events: [{ id: "1" }] });
  assert.equal(check(badEvent), false);
  rejects(() => applyUpdate(state(), badEvent), "panel_invalid");
  const good = [patch({ op: "set", field: "status", value: null }), patch({ op: "remove_items", block: "c", ids: ["a"] }),
    patch({ op: "append_events", block: "e", events: [{ id: "1", at: 1, level: "info", label: "x" }] }),
    replace({ id: "x", kind: "gantt", anything: 1 })];
  for (const value of good) { assert.equal(check(value), true); validateUpdate(value); }
});

test("malformed upserted children are reported as panel_invalid and leave the input unchanged", () => {
  const before = state();
  const snapshot = structuredClone(before);
  for (const children of ["x", 5, [1], [null], [[]], [{ id: "a" }], { id: "a" }]) {
    rejects(() => applyUpdate(before, patch({ op: "upsert_items", block: "c", items: [{ id: "i1", children }] })), "panel_invalid");
    rejects(() => applyUpdate(before, patch({ op: "upsert_items", block: "c", items: [{ id: "n", label: "n", children }] })), "panel_invalid");
    assert.deepEqual(before, snapshot);
  }
  // a later patch in the same update touching the malformed list also ends as panel_invalid
  rejects(() => applyUpdate(before, patch({ op: "upsert_items", block: "c", items: [{ id: "i1", children: [null] }] },
    { op: "remove_items", block: "c", ids: ["i3"] })), "panel_invalid");
  rejects(() => applyUpdate(before, patch({ op: "upsert_items", block: "c", items: [{ id: "i1", children: "x" }] },
    { op: "upsert_items", block: "c", parent: "i1", items: [{ id: "z", label: "z" }] })), "panel_invalid");
  assert.deepEqual(before, snapshot);
});

test("an empty fallback is honored, and the schema constrains title and fallback for every kind", () => {
  assert.equal(renderPanelText("T", doc({ id: "x", kind: "gantt", fallback: "" })).split("\n").at(-1), "");
  const check = new Ajv2020.default({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(new URL("../schemas/raw-panel.schema.json", import.meta.url), "utf8")));
  const replace = (block: unknown) => ({ panel: "todo", op: "replace", document: { blocks: [block] } });
  for (const block of [{ id: "x", kind: "gantt", title: "t".repeat(81) }, { id: "x", kind: "gantt", title: 5 }, { id: "x", kind: "gantt", fallback: 5 }]) {
    assert.equal(check(replace(block)), false);
    assert.throws(() => validateUpdate(replace(block)), PanelError);
  }
  assert.equal(check(replace({ id: "x", kind: "gantt", title: "ok", fallback: "f", tasks: [1] })), true);
});
