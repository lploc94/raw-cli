import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, chmod, symlink, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { applyFilePatch, applyStagedFilePatch, describePatchEffects, parseFilePatch, stageFilePatch, validateFilePatchSyntax } from "../src/tools/file-patch.js";
import type { ToolResult } from "../src/tools/types.js";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const cwd = async () => realpath(await mkdtemp(join(tmpdir(), "raw-patch-")));
const rows = (result: ToolResult) => (result.content.find(c => c.type === "json") as { value: { results: Array<Record<string, unknown>> } }).value.results;
const run = (root: string, body: string) => applyFilePatch(parseFilePatch(patch(body), root), { maxOutputBytes: 8192 });

test("syntax validation does not invent target aliases from an unavailable cwd", () => {
  const source = patch("*** Add File: ../a\n+x\n*** Add File: /a\n+y");
  assert.doesNotThrow(() => validateFilePatchSyntax(source));
  assert.doesNotThrow(() => parseFilePatch(source, "/work/project"));
  assert.throws(() => parseFilePatch(source, "/"), /patch_repeated_target/);
});

test("patch add update rename delete reports actual bytes and complete effects", async () => {
  const root = await cwd();
  await writeFile(join(root, "old"), "before\n");
  await writeFile(join(root, "remove"), "gone\n");
  const parsed = parseFilePatch(patch("*** Add File: nested/new\n+héllo\n*** Update File: old\n*** Move to: moved\n@@\n-before\n+after\n*** Delete File: remove"), root);
  assert.deepEqual(describePatchEffects(parsed).files, [
    { path: join(root, "nested/new"), operation: "write" },
    { path: join(root, "old"), operation: "rename_source" },
    { path: join(root, "moved"), operation: "rename_destination" },
    { path: join(root, "remove"), operation: "delete" },
  ]);
  const completed: string[] = [];
  const result = await applyFilePatch(parsed, { maxOutputBytes: 8192, onCompleted: change => { completed.push(change.path); } });
  assert.deepEqual(rows(result).map(r => r.status), ["ok", "ok", "ok"]);
  assert.deepEqual(completed, [join(root, "nested/new"), join(root, "moved"), join(root, "remove")]);
  assert.equal(await readFile(join(root, "nested/new"), "utf8"), "héllo\n");
  assert.equal(await readFile(join(root, "moved"), "utf8"), "after\n");
  await assert.rejects(access(join(root, "old")));
  await assert.rejects(access(join(root, "remove")));
});

test("later context conflict and repeated context cause zero mutations", async () => {
  const root = await cwd();
  await writeFile(join(root, "a"), "a\n");
  await writeFile(join(root, "b"), "same\nsame\n");
  for (const needle of ["missing", "same"]) {
    const result = await run(root, `*** Update File: a\n@@\n-a\n+changed\n*** Update File: b\n@@\n-${needle}\n+changed`);
    assert.equal(result.isError, true);
    assert.equal(await readFile(join(root, "a"), "utf8"), "a\n");
    assert.equal(await readFile(join(root, "b"), "utf8"), "same\nsame\n");
  }
});

test("preserves BOM mixed separators permissions and final newline state", async () => {
  const root = await cwd();
  await writeFile(join(root, "a"), "\uFEFFone\r\ntwo\r\nlast");
  await chmod(join(root, "a"), 0o751);
  assert.equal((await run(root, "*** Update File: a\n@@\n one\n-two\n+new\n+extra\n last\n*** End of File")).isError, false);
  assert.equal(await readFile(join(root, "a"), "utf8"), "\uFEFFone\r\nnew\r\nextra\r\nlast");
  assert.equal((await stat(join(root, "a"))).mode & 0o777, 0o751);
  assert.equal((await run(root, "*** Add File: no-eol\n+x\n*** No newline at end of file\n*** Add File: empty")).isError, false);
  assert.equal(await readFile(join(root, "no-eol"), "utf8"), "x");
  assert.equal((await readFile(join(root, "empty"))).length, 0);
});

test("rejects invalid dialect duplicate paths binary bytes and symlink parents", async () => {
  const root = await cwd();
  for (const body of ["*** Update File: a\n@@ -1 +1 @@\n-a\n+b", "*** Add File: a\n+x\n*** Delete File: ./a", "*** Add File: a\nnot prefixed", "*** Update File: a\n*** Move to: a\n@@\n-a\n+b"]) {
    assert.throws(() => parseFilePatch(patch(body), root));
  }
  await writeFile(join(root, "binary"), Buffer.from([0xff, 0]));
  assert.equal((await run(root, "*** Delete File: binary")).isError, true);
  const outside = await cwd();
  await symlink(outside, join(root, "linked"));
  assert.equal((await run(root, "*** Add File: linked/file\n+no")).isError, true);
  await assert.rejects(access(join(outside, "file")));
});

test("external edit after staging leaves every target unchanged", async () => {
  const root = await cwd();
  await writeFile(join(root, "a"), "a\n");
  await writeFile(join(root, "b"), "b\n");
  const staged = await stageFilePatch(parseFilePatch(patch("*** Update File: a\n@@\n-a\n+A\n*** Update File: b\n@@\n-b\n+B"), root));
  await writeFile(join(root, "b"), "external\n");
  const result = await applyStagedFilePatch(staged, { maxOutputBytes: 8192 });
  assert.equal(result.isError, true);
  assert.equal(await readFile(join(root, "a"), "utf8"), "a\n");
  assert.equal(await readFile(join(root, "b"), "utf8"), "external\n");
});

test("late external edit and abort keep successful rows and skip remaining rows", async () => {
  for (const abort of [false, true]) {
    const root = await cwd();
    await writeFile(join(root, "b"), "b\n");
    const controller = new AbortController();
    const result = await applyFilePatch(parseFilePatch(patch("*** Add File: a\n+A\n*** Update File: b\n@@\n-b\n+B\n*** Add File: c\n+C"), root), {
      maxOutputBytes: 8192, signal: controller.signal,
      onCompleted: async () => { if (abort) controller.abort(); else await writeFile(join(root, "b"), "external\n"); },
    });
    assert.deepEqual(rows(result).map(r => r.status), abort ? ["ok", "skipped", "skipped"] : ["ok", "error", "skipped"]);
    assert.equal(await readFile(join(root, "a"), "utf8"), "A\n");
    await assert.rejects(access(join(root, "c")));
  }
});

test("tiny output budget refuses mutation and observer failure does not fail writes", async () => {
  const root = await cwd();
  const parsed = parseFilePatch(patch("*** Add File: a\n+A"), root);
  assert.equal((await applyFilePatch(parsed, { maxOutputBytes: 1 })).isError, true);
  await assert.rejects(access(join(root, "a")));
  const result = await applyFilePatch(parsed, { maxOutputBytes: 8192, onCompleted: () => { throw Error("UI failed"); } });
  assert.equal(result.isError, false);
  assert.equal(await readFile(join(root, "a"), "utf8"), "A\n");
});

test("injected I/O failure after first success stops later patch operations", async () => {
  const root = await cwd();
  await writeFile(join(root, "delete"), "old\n");
  const original = fs.unlink;
  fs.unlink = (async (path: Parameters<typeof fs.unlink>[0]) => {
    if (String(path) === join(root, "delete")) throw Object.assign(Error("injected"), { code: "EIO" });
    return original(path);
  }) as typeof fs.unlink;
  syncBuiltinESMExports();
  try {
    const result = await run(root, "*** Add File: first\n+done\n*** Delete File: delete\n*** Add File: last\n+never");
    assert.deepEqual(rows(result).map(r => r.status), ["ok", "error", "skipped"]);
    assert.equal(await readFile(join(root, "first"), "utf8"), "done\n");
    assert.equal(await readFile(join(root, "delete"), "utf8"), "old\n");
    await assert.rejects(access(join(root, "last")));
  } finally { fs.unlink = original; syncBuiltinESMExports(); }
});

test("failed rename source deletion reports its completed destination creation", async () => {
  const root = await cwd();
  await writeFile(join(root, "old"), "old\n");
  const original = fs.unlink;
  fs.unlink = (async (path: Parameters<typeof fs.unlink>[0]) => {
    if (String(path) === join(root, "old")) throw Object.assign(Error("injected"), { code: "EIO" });
    return original(path);
  }) as typeof fs.unlink;
  syncBuiltinESMExports();
  try {
    const completed: Array<{ path: string; kind: string }> = [];
    const result = await applyFilePatch(parseFilePatch(patch("*** Update File: old\n*** Move to: new\n@@\n-old\n+new"), root), {
      maxOutputBytes: 8192, onCompleted: change => { completed.push({ path: change.path, kind: change.kind }); },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(completed, [{ path: join(root, "new"), kind: "added" }]);
    assert.equal(await readFile(join(root, "old"), "utf8"), "old\n");
    assert.equal(await readFile(join(root, "new"), "utf8"), "new\n");
  } finally { fs.unlink = original; syncBuiltinESMExports(); }
});

test("EOF anchors disambiguate repeated lines; unordered hunks fail", async () => {
  const root = await cwd();
  await writeFile(join(root, "a"), "same\nother\nsame\n");
  assert.equal((await run(root, "*** Update File: a\n@@\n-same\n+last\n*** End of File")).isError, false);
  assert.equal(await readFile(join(root, "a"), "utf8"), "same\nother\nlast\n");
  assert.equal((await run(root, "*** Update File: a\n@@\n-last\n+LAST\n@@\n-same\n+FIRST")).isError, true);
  assert.equal(await readFile(join(root, "a"), "utf8"), "same\nother\nlast\n");
});

test("absent newline update marker, empty sources, path count and source size limits", async () => {
  const root = await cwd();
  await writeFile(join(root, "a"), "a\n");
  assert.equal((await run(root, "*** Update File: a\n@@\n-a\n+b\n*** No newline at end of file")).isError, false);
  assert.equal(await readFile(join(root, "a"), "utf8"), "b");
  await writeFile(join(root, "empty"), "");
  assert.equal((await run(root, "*** Update File: empty\n@@\n+one")).isError, false);
  assert.equal(await readFile(join(root, "empty"), "utf8"), "one");
  assert.throws(() => parseFilePatch(patch(Array.from({ length: 65 }, (_, i) => `*** Add File: ${i}\n+x`).join("\n")), root));
  assert.throws(() => parseFilePatch(patch(`*** Add File: huge\n+${"x".repeat(1024 * 1024)}`), root));
  await writeFile(join(root, "huge"), Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  assert.equal((await run(root, "*** Delete File: huge")).isError, true);
});

test("dense source lines and aggregate staging bytes fail before any mutation", async () => {
  const root = await cwd();
  await writeFile(join(root, "dense"), "\n".repeat(200_001));
  const dense = await run(root, "*** Add File: first\n+never\n*** Delete File: dense");
  assert.equal(dense.isError, true);
  assert.match(JSON.stringify(dense), /patch_too_many_lines/);
  await assert.rejects(access(join(root, "first")));
  const body: string[] = [];
  for (let i = 0; i < 3; i++) {
    await writeFile(join(root, `large${i}`), "a\n" + "x".repeat(12 * 1024 * 1024));
    body.push(`*** Update File: large${i}\n@@\n-a\n+b`);
  }
  const aggregate = await run(root, body.join("\n"));
  assert.equal(aggregate.isError, true);
  assert.match(JSON.stringify(aggregate), /patch_staging_too_large/);
  for (let i = 0; i < 3; i++) assert.equal((await readFile(join(root, `large${i}`))).subarray(0, 2).toString(), "a\n");
});

test("many individually unique hunks cannot exceed the cumulative matching work limit", async () => {
  const root = await cwd();
  const lines = Array.from({ length: 4500 }, (_, i) => `line${i}`);
  const original = lines.join("\n") + "\n";
  await writeFile(join(root, "a"), original);
  const result = await run(root, "*** Update File: a\n" + lines.map(line => `@@\n-${line}\n+updated ${line}`).join("\n"));
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /patch_matching_limit/);
  assert.equal(await readFile(join(root, "a"), "utf8"), original);
});
