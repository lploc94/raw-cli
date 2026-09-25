import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestToolRegistry } from "./fixtures/registry.js";
import type { ToolResult } from "../src/tools/types.js";

function rows(result: ToolResult): Array<Record<string, unknown>> {
  assert.equal(result.content[0]?.type, "json", JSON.stringify(result));
  return (result.content[0] as { type: "json"; value: { results: Array<Record<string, unknown>> } }).value.results;
}

test("write batch applies four modes in order, including empty edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-write-"));
  const registry = createTestToolRegistry();
  const input = { operations: [
    { path: "nested/a.txt", mode: "overwrite", content: "alpha\n" },
    { path: "nested/a.txt", mode: "append", content: "beta\n" },
    { path: "nested/a.txt", mode: "replace_text", old_text: "beta", new_text: "gamma" },
    { path: "nested/a.txt", mode: "replace_lines", start_line: 2, end_line: 2, content: "delta", expected_sha256:
      createHash("sha256").update("gamma\n").digest("hex") },
    { path: "empty.txt", mode: "overwrite", content: "" },
  ] };
  const snapshot = structuredClone(input);
  const result = await registry.dispatch("write_file", input, { cwd, maxOutputBytes: 8192 });
  assert.deepEqual(input, snapshot);
  assert.deepEqual(rows(result).map((row) => row.status), ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(await readFile(join(cwd, "nested/a.txt"), "utf8"), "alpha\ndelta");
  assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "");
});

test("replace guards preserve bytes and later runtime items continue", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-guards-"));
  await writeFile(join(cwd, "crlf.txt"), "\uFEFFone\r\ntwo\r\nthree\r\n");
  await writeFile(join(cwd, "duplicate.txt"), "same same");
  const result = await createTestToolRegistry().dispatch("write_file", { operations: [
    { path: "crlf.txt", mode: "replace_lines", start_line: 2, end_line: 2, content: "bad", expected_sha256: "0".repeat(64) },
    { path: "duplicate.txt", mode: "replace_text", old_text: "same", new_text: "other" },
    { path: "crlf.txt", mode: "replace_lines", start_line: 2, end_line: 2, content: "new", expected_sha256:
      createHash("sha256").update("two\r\n").digest("hex") },
    { path: "later.txt", mode: "overwrite", content: "done" },
  ] }, { cwd, maxOutputBytes: 8192 });
  assert.deepEqual(rows(result).map((row) => row.status), ["error", "error", "ok", "ok"]);
  assert.equal(await readFile(join(cwd, "crlf.txt"), "utf8"), "\uFEFFone\r\nnew\r\nthree\r\n");
  assert.equal(await readFile(join(cwd, "duplicate.txt"), "utf8"), "same same");
  assert.equal(await readFile(join(cwd, "later.txt"), "utf8"), "done");
});

test("line delete, out-of-range and exact-text no-match report per-item outcomes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-delete-"));
  await writeFile(join(cwd, "target"), "a\nb\nc\n");
  const result = await createTestToolRegistry().dispatch("write_file", { operations: [
    { path: "target", mode: "replace_lines", start_line: 4, end_line: 4, content: "oops", expected_sha256: "0".repeat(64) },
    { path: "target", mode: "replace_text", old_text: "missing", new_text: "" },
    { path: "target", mode: "replace_lines", start_line: 2, end_line: 2, content: "", expected_sha256:
      createHash("sha256").update("b\n").digest("hex") },
  ] }, { cwd, maxOutputBytes: 8192 });
  assert.deepEqual(rows(result).map((row) => row.status), ["error", "error", "ok"]);
  assert.equal(await readFile(join(cwd, "target"), "utf8"), "a\nc\n");
});

test("deleting the BOM-bearing first line retains the BOM without an empty line", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-bom-delete-"));
  await writeFile(join(cwd, "target"), "\uFEFFfirst\r\nsecond\r\n");
  const result = await createTestToolRegistry().dispatch("write_file", { operations: [
    { path: "target", mode: "replace_lines", start_line: 1, end_line: 1, content: "", expected_sha256:
      createHash("sha256").update("\uFEFFfirst\r\n").digest("hex") },
  ] }, { cwd, maxOutputBytes: 8192 });
  assert.equal(rows(result)[0]?.status, "ok");
  assert.equal(await readFile(join(cwd, "target"), "utf8"), "\uFEFFsecond\r\n");
});

test("invalid batch and inadequate result budget fail before approval or writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-invalid-"));
  const registry = createTestToolRegistry([{ match: "builtin/write_file", effect: "ask" }]);
  let approvals = 0;
  for (const input of [
    { path: "old", content: "no" },
    { operations: [{ path: "marker", mode: "overwrite", content: "no" }, { path: "other", mode: "replace_text", old_text: "", new_text: "x" }] },
    { operations: [{ path: "marker", mode: "replace_lines", start_line: 1, end_line: 1, content: "x" }] },
    { operations: [] },
  ]) {
    const result = await registry.dispatch("write_file", input, { cwd, maxOutputBytes: 8192,
      approve: () => { approvals++; return true; } });
    assert.equal(result.code, "invalid_arguments");
  }
  assert.equal(approvals, 0);
  const low = await createTestToolRegistry().dispatch("write_file", { operations: [
    { path: "marker", mode: "overwrite", content: "no" },
  ] }, { cwd, maxOutputBytes: 1 });
  assert.equal(low.isError, true);
  await assert.rejects(access(join(cwd, "marker")));
});

test("abort immediately after the first write marks later operations skipped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-abort-"));
  const controller = new AbortController();
  const originalWriteFile = fs.writeFile;
  let writes = 0;
  fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
    await originalWriteFile(...args);
    if (++writes === 1) controller.abort();
  }) as typeof fs.writeFile;
  syncBuiltinESMExports();
  try {
    const result = await createTestToolRegistry().dispatch("write_file", { operations: [
      { path: "first", mode: "overwrite", content: "kept" },
      { path: "second", mode: "overwrite", content: "never" },
    ] }, { cwd, maxOutputBytes: 8192, signal: controller.signal });
    assert.deepEqual(rows(result).map((row) => row.status), ["ok", "skipped"]);
    assert.equal(await readFile(join(cwd, "first"), "utf8"), "kept");
    await assert.rejects(access(join(cwd, "second")));
    assert.equal(writes, 1);
  } finally {
    fs.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }
});

test("editing line one of a dense file stays within a small Node heap", () => {
  const script = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { createHash } from "node:crypto";
    import { createTestToolRegistry } from "./tests/fixtures/registry.ts";
    const source = Buffer.alloc(8 * 1024 * 1024, 10);
    fs.readFile = async () => source;
    fs.writeFile = async () => {};
    syncBuiltinESMExports();
    const result = await createTestToolRegistry().dispatch("write_file", { operations: [{
      path: "dense", mode: "replace_lines", start_line: 1, end_line: 1, content: "x",
      expected_sha256: createHash("sha256").update("\\n").digest("hex"),
    }] }, { cwd: "/virtual", maxOutputBytes: 8192 });
    if (result.content[0]?.type !== "json" || result.content[0].value.results[0].status !== "ok") process.exit(1);
  `;
  const child = spawnSync(process.execPath, ["--max-old-space-size=256", "--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
});
