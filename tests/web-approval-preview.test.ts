import assert from "node:assert/strict";
import { test } from "node:test";
import type { Approval } from "../src/dashboard/approvals.js";
import { MAX_PREVIEW_BYTES, MAX_PREVIEW_ENTRIES, MAX_PREVIEW_LINES, PREVIEW_TRUNCATED, approvalPreviews } from "../web/src/panels/approval-preview.js";
import { diffKinds, diffStats } from "../web/src/tool-cards/result-data.js";

const CWD = "D:/projects/app";

/** One pending approval, with only the fields the preview reads given explicitly. */
function approval(over: Partial<Approval> & { name: string; arguments: Record<string, unknown> }): Approval {
  return {
    id: "a1", sessionId: "s1", operationId: "op1", callId: "call1", title: "Write",
    summary: "src/a.ts", createdAt: 1, deadline: 2, ...over,
  } as Approval;
}

const effectsOf = (...files: Array<{ path: string; operation: string }>) => ({ files }) as Record<string, unknown>;
/** The file entries of a preview: what most cases assert on; the omitted count has its own cases. */
const previews = (item: Approval, cwd: string | undefined) => approvalPreviews(item, cwd).entries;

test("the tool name the host sends, and a canonical one, both preview", () => {
  // `Approval.name` is the invoked name (`write_file`), not the canonical id the registry also knows.
  const short = previews(approval({
    name: "write_file",
    arguments: { path: "reports/links.md", content: "one\ntwo\n" },
    effects: effectsOf({ path: `${CWD}/reports/links.md`, operation: "write" }),
  }), CWD);
  assert.equal(short[0]?.diff, "--- a/reports/links.md\n+++ b/reports/links.md\n+one\n+two");
  assert.equal(short[0]?.added, 2);
  assert.equal(short[0]?.operation, "write");
  const edited = previews(approval({
    name: "edit_file", arguments: { path: "src/a.ts", old_string: "a", new_string: "b" },
    effects: effectsOf({ path: `${CWD}/src/a.ts`, operation: "edit" }),
  }), CWD);
  assert.deepEqual(diffStats(edited[0]!.diff!), { added: 1, removed: 1 });
  const patched = previews(approval({ name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Delete File: src/c.ts\n*** End Patch" } }), CWD);
  assert.equal(patched[0]?.operation, "delete");
  assert.match(patched[0]?.note ?? "", /deleted/i);
});

test("namespaced copies of editing tools stay on the safe fallback", () => {
  for (const [name, arguments_, operation] of [
    ["vendor/write_file", { path: "src/a.ts", content: "new" }, "write"],
    ["vendor#edit_file", { path: "src/a.ts", old_string: "old", new_string: "new" }, "edit"],
    ["vendor/apply_patch", { patch: "*** Begin Patch\n*** Add File: src/a.ts\n+new\n*** End Patch" }, "write"],
  ] as const) {
    const [entry] = previews(approval({
      name,
      arguments: arguments_,
      effects: effectsOf({ path: `${CWD}/src/a.ts`, operation }),
    }), CWD);
    assert.equal(entry?.operation, operation);
    assert.equal(entry?.diff, undefined);
    assert.match(entry?.note ?? "", /no file preview/i);
  }
});

test("write_file previews the new content as added lines", () => {
  const [entry] = previews(approval({
    name: "builtin/write_file", title: "Write file", summary: "reports/links.md",
    arguments: { path: "reports/links.md", content: "one\ntwo\n" },
    effects: effectsOf({ path: `${CWD}/reports/links.md`, operation: "write" }),
  }), CWD);

  assert.equal(entry?.operation, "write");
  assert.equal(entry?.path, `${CWD}/reports/links.md`);
  assert.deepEqual(entry?.display, { name: "links.md", folder: "reports" });
  assert.equal(entry?.diff, "--- a/reports/links.md\n+++ b/reports/links.md\n+one\n+two");
  assert.equal(entry?.added, 2);
  assert.equal(entry?.removed, undefined);
  assert.match(entry?.note ?? "", /previous content is not read/i);
});

test("editing header-like content renders it as changes, not additional file headers", () => {
  const [edited] = previews(approval({
    name: "edit_file",
    arguments: { path: "src/a.ts", old_string: "-- old header", new_string: "++ new header" },
    effects: effectsOf({ path: `${CWD}/src/a.ts`, operation: "edit" }),
  }), CWD);
  const rendered = edited!.diff!.split("\n");
  const kinds = diffKinds(rendered);
  assert.equal(kinds[rendered.indexOf("--- old header")], "diff-remove");
  assert.equal(kinds[rendered.indexOf("+++ new header")], "diff-add");
  assert.deepEqual(diffStats(edited!.diff!), { added: 1, removed: 1 });
  assert.equal(kinds.filter((kind) => kind.includes("diff-file")).length, 2);
});

test("edit_file previews the replaced text as a removed and an added line", () => {
  const [entry] = previews(approval({
    name: "builtin/edit_file", title: "Edit", summary: "src/a.ts",
    arguments: { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
    effects: effectsOf({ path: `${CWD}/src/a.ts`, operation: "edit" }),
  }), CWD);

  assert.equal(entry?.operation, "edit");
  assert.deepEqual(entry?.display, { name: "a.ts", folder: "src" });
  assert.ok(entry!.diff!.includes("-const a = 1;\n+const a = 2;"));
  assert.deepEqual(diffStats(entry!.diff!), { added: 1, removed: 1 });
  assert.equal(entry?.added, 1);
  assert.equal(entry?.removed, 1);
  assert.equal(entry?.note, undefined);
});

test("edit_file says when every occurrence is replaced", () => {
  const [entry] = previews(approval({
    name: "builtin/edit_file",
    arguments: { path: "src/a.ts", old_string: "a", new_string: "b", replace_all: true },
    effects: effectsOf({ path: `${CWD}/src/a.ts`, operation: "edit" }),
  }), CWD);

  assert.match(entry?.note ?? "", /every occurrence/i);
});

test("a file directly in the session directory has no folder", () => {
  const [entry] = previews(approval({
    name: "builtin/write_file",
    arguments: { path: "notes.md", content: "hi" },
    effects: effectsOf({ path: `${CWD}/notes.md`, operation: "write" }),
  }), CWD);

  assert.deepEqual(entry?.display, { name: "notes.md", folder: "project root" });
  assert.equal(entry?.diff, "--- a/notes.md\n+++ b/notes.md\n+hi");
});

test("apply_patch previews every file of the patch in patch order", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-old",
    "+new",
    "*** Add File: src/b.ts",
    "+fresh",
    "*** Delete File: src/c.ts",
    "*** End Patch",
  ].join("\n");
  const entries = previews(approval({
    name: "builtin/apply_patch", title: "Apply patch", summary: "3 files",
    arguments: { patch },
    effects: effectsOf(
      { path: `${CWD}/src/a.ts`, operation: "write" },
      { path: `${CWD}/src/b.ts`, operation: "write" },
      { path: `${CWD}/src/c.ts`, operation: "delete" },
    ),
  }), CWD);

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => [entry.display.name, entry.operation]), [["a.ts", "write"], ["b.ts", "write"], ["c.ts", "delete"]]);
  assert.equal(entries[0]?.diff, "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new");
  assert.equal(entries[0]?.added, 1);
  assert.equal(entries[0]?.removed, 1);
  assert.equal(entries[1]?.diff, "--- /dev/null\n+++ b/src/b.ts\n+fresh");
  assert.equal(entries[2]?.diff, undefined);
  assert.match(entries[2]?.note ?? "", /deleted/i);
});

test("a patch that moves a file reports both paths", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "*** Move to: src/nested/d.ts",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const entries = previews(approval({
    name: "builtin/apply_patch",
    arguments: { patch },
    effects: effectsOf(
      { path: `${CWD}/src/a.ts`, operation: "rename_source" },
      { path: `${CWD}/src/nested/d.ts`, operation: "rename_destination" },
    ),
  }), CWD);

  assert.deepEqual(entries.map((entry) => [entry.path, entry.operation]), [
    [`${CWD}/src/a.ts`, "rename_source"],
    [`${CWD}/src/nested/d.ts`, "rename_destination"],
  ]);
  assert.match(entries[0]?.note ?? "", /renamed to src\/nested\/d\.ts/i);
  assert.match(entries[1]?.note ?? "", /renamed from src\/a\.ts/i);
  assert.equal(entries[1]?.diff, undefined);
});

test("an unreadable patch still lists the intended files without a preview", () => {
  const entries = previews(approval({
    name: "builtin/apply_patch",
    arguments: { patch: "not a patch" },
    effects: effectsOf({ path: `${CWD}/src/a.ts`, operation: "write" }),
  }), CWD);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.path, `${CWD}/src/a.ts`);
  assert.equal(entries[0]?.operation, "write");
  assert.equal(entries[0]?.diff, undefined);
  assert.match(entries[0]?.note ?? "", /cannot be shown/i);
});

test("arguments of the wrong shape never throw and keep the intended files", () => {
  const entries = previews(approval({
    name: "builtin/write_file",
    arguments: { path: 42, content: { nested: true } },
    effects: effectsOf({ path: `${CWD}/src/a.ts`, operation: "write" }),
  }), CWD);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.path, `${CWD}/src/a.ts`);
  assert.equal(entries[0]?.diff, undefined);
});

test("a tool that changes no file reports nothing", () => {
  assert.deepEqual(previews(approval({
    name: "builtin/bash", title: "Run command", summary: "$ npm test",
    arguments: { command: "npm test" },
  }), CWD), []);
});

test("another tool with intended files is listed without a preview", () => {
  const entries = previews(approval({
    name: "local/deploy", title: "Deploy",
    arguments: { target: "prod" },
    effects: effectsOf({ path: `${CWD}/out/bundle.js`, operation: "write" }),
  }), CWD);

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.display, { name: "bundle.js", folder: "out" });
  assert.equal(entries[0]?.diff, undefined);
  assert.match(entries[0]?.note ?? "", /no file preview/i);
});

test("a long preview is cut and says so, while the counts stay complete", () => {
  const content = Array.from({ length: MAX_PREVIEW_LINES + 500 }, (_, index) => `line ${index}`).join("\n");
  const [entry] = previews(approval({
    name: "builtin/write_file",
    arguments: { path: "big.txt", content },
    effects: effectsOf({ path: `${CWD}/big.txt`, operation: "write" }),
  }), CWD);

  const lines = entry?.diff?.split("\n") ?? [];
  assert.equal(lines.at(-1), PREVIEW_TRUNCATED);
  assert.equal(lines.length, 2 + MAX_PREVIEW_LINES + 1);
  assert.equal(entry?.added, MAX_PREVIEW_LINES + 500);
});

test("a preview of very long lines is cut by bytes", () => {
  const content = Array.from({ length: 4 }, () => "x".repeat(40_000)).join("\n");
  const [entry] = previews(approval({
    name: "builtin/write_file",
    arguments: { path: "huge.txt", content },
    effects: effectsOf({ path: `${CWD}/huge.txt`, operation: "write" }),
  }), CWD);

  const diff = entry?.diff ?? "";
  const lines = diff.split("\n");
  assert.equal(lines.at(-1), PREVIEW_TRUNCATED);
  assert.ok(lines.length < 6, `expected the body to be cut, got ${lines.length} lines`);
  assert.ok(Buffer.byteLength(diff) <= MAX_PREVIEW_BYTES + Buffer.byteLength(PREVIEW_TRUNCATED) + 1);
  assert.equal(entry?.added, 4);
});

test("an aligned patch takes its paths from the host's projection, not from the patch text", () => {
  // The patch's own spelling can be lexical: `/c/tmp` and `..` are what the host resolves, not what it writes.
  const patch = ["*** Begin Patch", "*** Add File: ../outside/y.ts", "+x", "*** Add File: /c/tmp/x.ts", "+y", "*** End Patch"].join("\n");
  const entries = previews(approval({
    name: "apply_patch", arguments: { patch },
    effects: effectsOf(
      { path: "D:/projects/outside/y.ts", operation: "write" },
      { path: "C:/tmp/x.ts", operation: "write" },
    ),
  }), CWD);

  assert.deepEqual(entries.map((entry) => entry.path), ["D:/projects/outside/y.ts", "C:/tmp/x.ts"]);
  assert.deepEqual(entries.map((entry) => entry.display.folder), ["D:/projects/outside", "C:/tmp"]);
  assert.equal(entries[0]?.diff, "--- /dev/null\n+++ b/D:/projects/outside/y.ts\n+x");
});

test("a rename names the paths the host will move between", () => {
  const patch = ["*** Begin Patch", "*** Update File: ../outside/y.ts", "*** Move to: /c/tmp/z.ts", "@@", "-old", "+new", "*** End Patch"].join("\n");
  const entries = previews(approval({
    name: "apply_patch", arguments: { patch },
    effects: effectsOf(
      { path: "D:/projects/outside/y.ts", operation: "rename_source" },
      { path: "C:/tmp/z.ts", operation: "rename_destination" },
    ),
  }), CWD);

  assert.deepEqual(entries.map((entry) => entry.path), ["D:/projects/outside/y.ts", "C:/tmp/z.ts"]);
  assert.match(entries[0]?.note ?? "", /renamed to C:\/tmp\/z\.ts/i);
  assert.match(entries[1]?.note ?? "", /renamed from D:\/projects\/outside\/y\.ts/i);
});

test("a list cut by the bound reports how many files it left out", () => {
  const files = Array.from({ length: MAX_PREVIEW_ENTRIES + 7 }, (_, index) => ({ path: `${CWD}/src/f${index}.ts`, operation: "write" }));
  const result = approvalPreviews(approval({ name: "local/deploy", arguments: {}, effects: effectsOf(...files) }), CWD);

  assert.equal(result.entries.length, MAX_PREVIEW_ENTRIES);
  assert.equal(result.omitted, 7);
});

test("a complete list reports nothing left out", () => {
  const result = approvalPreviews(approval({
    name: "write_file", arguments: { path: "a.ts", content: "x" },
    effects: effectsOf({ path: `${CWD}/a.ts`, operation: "write" }),
  }), CWD);

  assert.equal(result.entries.length, 1);
  assert.equal(result.omitted, 0);
});

test("an added file is previewed against no previous version", () => {
  const patch = ["*** Begin Patch", "*** Add File: src/b.ts", "+fresh", "*** End Patch"].join("\n");
  const [entry] = previews(approval({
    name: "apply_patch", arguments: { patch },
    effects: effectsOf({ path: `${CWD}/src/b.ts`, operation: "write" }),
  }), CWD);

  assert.equal(entry?.diff, "--- /dev/null\n+++ b/src/b.ts\n+fresh");
});

test("a patch with more files than the limit is cut at the limit", () => {
  const sections = Array.from({ length: MAX_PREVIEW_ENTRIES + 5 }, (_, index) => `*** Add File: src/f${index}.ts\n+x`);
  const patch = ["*** Begin Patch", ...sections, "*** End Patch"].join("\n");
  const entries = previews(approval({ name: "builtin/apply_patch", arguments: { patch } }), CWD);

  assert.equal(entries.length, MAX_PREVIEW_ENTRIES);
});

test("a file outside the session directory keeps its absolute folder", () => {
  const [entry] = previews(approval({
    name: "builtin/write_file",
    arguments: { path: "../elsewhere/x.md", content: "hi" },
    effects: effectsOf({ path: "D:/other/x.md", operation: "write" }),
  }), CWD);

  assert.equal(entry?.path, "D:/other/x.md");
  assert.deepEqual(entry?.display, { name: "x.md", folder: "D:/other" });
  assert.equal(entry?.diff, "--- a/D:/other/x.md\n+++ b/D:/other/x.md\n+hi");
});

test("Windows separators are read like any other", () => {
  const [entry] = previews(approval({
    name: "builtin/write_file",
    arguments: { path: "src\\win.ts", content: "hi" },
    effects: effectsOf({ path: "D:\\projects\\app\\src\\win.ts", operation: "write" }),
  }), "D:\\projects\\app");

  assert.deepEqual(entry?.display, { name: "win.ts", folder: "src" });
  assert.equal(entry?.diff, "--- a/src/win.ts\n+++ b/src/win.ts\n+hi");
});

test("without a session directory every path stays absolute", () => {
  const [entry] = previews(approval({
    name: "builtin/write_file",
    arguments: { path: "src/a.ts", content: "hi" },
    effects: effectsOf({ path: `${CWD}/src/a.ts`, operation: "write" }),
  }), undefined);

  assert.equal(entry?.path, `${CWD}/src/a.ts`);
  assert.deepEqual(entry?.display, { name: "a.ts", folder: "D:/projects/app/src" });
});
