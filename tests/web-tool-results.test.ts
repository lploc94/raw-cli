import assert from "node:assert/strict";
import { test } from "node:test";
import type { VisibleToolResult } from "../src/sessions/visible.js";
import { diffCountable, diffFileCount, diffKinds, diffStats, resultCopy } from "../web/src/tool-cards/result-data.js";
import { diffTotals } from "../web/src/tool-cards/diff-totals.js";

// What a work group counts and copies from tool results (docs/chat-design.md §6).
const result = (extra: Partial<VisibleToolResult>): VisibleToolResult => ({ name: "tool", failed: false, truncated: false, segments: [], ...extra });
const text = (value: string) => value.split("\n").map((line) => ({ kind: "text" as const, text: line }));
const edit = "--- a/one.js\n+++ b/one.js\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n";

test("per-file counts win, then a diff with a hunk for every file; group totals add up", () => {
  const counted = result({ host: { files: [{ path: "a", action: "edit", added: 5, removed: 2 }, { path: "b", action: "create", added: 3, removed: 0 }] } });
  assert.deepEqual(diffTotals([counted]), { added: 8, removed: 2 });
  const fromDiff = result({ host: { diff: edit } });
  assert.deepEqual(diffTotals([fromDiff]), { added: 2, removed: 1 });
  assert.deepEqual(diffTotals([counted, fromDiff]), { added: 10, removed: 3 });
  // A diff result's preview counts too; other results do not.
  assert.deepEqual(diffTotals([result({ resultType: "diff", segments: text(edit) })]), { added: 2, removed: 1 });
  assert.equal(diffTotals([result({ resultType: "text", segments: text(edit) })]), undefined);
});

test("unknown line counts stay unknown instead of +0 −0", () => {
  const binary = "--- a/image.bin\n+++ b/image.bin\n[binary content: 3 → 3 bytes]";
  assert.equal(diffCountable(binary), false);
  assert.equal(diffTotals([result({ host: { diff: binary } })]), undefined);
  // One countable file beside one that is not: the total would be partial.
  assert.equal(diffTotals([result({ host: { diff: `${edit}${binary}` } })]), undefined);
  // Files without counts and no diff (omitted), and failed calls, count nothing.
  assert.equal(diffTotals([result({ host: { files: [{ path: "a", action: "edit" }], diffOmitted: true } })]), undefined);
  assert.equal(diffTotals([result({ failed: true, status: "error", host: { diff: edit } })]), undefined);
});

test("a removed line that starts with `-- ` is a change, not a new file", () => {
  const sql = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+-- new comment\n select 1;\n";
  assert.equal(diffCountable(sql), true);
  assert.deepEqual(diffTotals([result({ host: { diff: sql } })]), { added: 1, removed: 1 });
  assert.equal(diffFileCount(result({ host: { diff: sql } })), 1);
});

test("a bare patch hunk keeps header-like removed and added content as changes", () => {
  const preview = "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n--- old header\n+++ new header";
  assert.deepEqual(diffKinds(preview.split("\n")), [
    "diff-meta diff-file", "diff-meta diff-file", "diff-hunk", "diff-remove", "diff-add",
  ]);
  assert.equal(diffCountable(preview), true);
  assert.deepEqual(diffStats(preview), { added: 1, removed: 1 });
});

test("the file count comes from host files, else from the diff's headers", () => {
  assert.equal(diffFileCount(result({ host: { files: [{ path: "a", action: "edit" }, { path: "b", action: "edit" }] } })), 2);
  assert.equal(diffFileCount(result({ host: { diff: `${edit}--- a/two.js\n+++ b/two.js\n@@ -1 +1 @@\n-x\n+y\n` } })), 2);
  assert.equal(diffFileCount(result({ resultType: "diff", segments: text("@@ -1 +1 @@\n-x\n+y") })), 0);
  // An added line whose text starts with `++ ` is a change, not another file.
  assert.equal(diffFileCount(result({ host: { diff: "--- a/c.c\n+++ b/c.c\n@@ -1 +1,2 @@\n x\n+++ counter;\n" } })), 1);
});

test("footer Copy: code lines for code, else the text and then the JSON", () => {
  const code = result({ resultType: "code", segments: [{ kind: "code", text: "const a = 1;" }, { kind: "text", text: "… [3 lines hidden] …" }, { kind: "code", text: "export { a };" }] });
  assert.deepEqual(resultCopy(code), { value: "const a = 1;\nexport { a };", label: "Copy code" });
  const mixed = result({ segments: text("Search results"), json: [{ count: 2 }] });
  assert.deepEqual(resultCopy(mixed), { value: 'Search results\n{\n  "count": 2\n}', label: "Copy result" });
  assert.deepEqual(resultCopy(result({ resultType: "json", json: [{ a: 1 }, { b: 2 }] })).value, JSON.stringify([{ a: 1 }, { b: 2 }], null, 2));
  assert.equal(resultCopy(result({ resultType: "markdown", segments: [{ kind: "markdown", text: "# Title" }] })).value, "# Title");
  // A failed code result is an error message, copied as text.
  assert.equal(resultCopy(result({ resultType: "code", failed: true, status: "error", segments: text("not found") })).label, "Copy result");
});
