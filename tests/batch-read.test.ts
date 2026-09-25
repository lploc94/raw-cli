import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestToolRegistry } from "./fixtures/registry.js";
import type { ToolResult } from "../src/tools/types.js";

function entries(result: ToolResult): Array<Record<string, unknown>> {
  assert.equal(result.content[0]?.type, "json", JSON.stringify(result));
  return (result.content[0] as { type: "json"; value: { results: Array<Record<string, unknown>> } }).value.results;
}

test("one read call selects full, range and count independently with EOF and digest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-read-"));
  await writeFile(join(cwd, "full.txt"), "alpha\n");
  await writeFile(join(cwd, "lines.txt"), "one\r\ntwo\r\nthree");
  const result = await createTestToolRegistry().dispatch("read_file", { files: [
    { path: "full.txt" },
    { path: "lines.txt", start_line: 2, end_line: 2 },
    { path: "lines.txt", start_line: 2, max_lines: 9 },
    { path: "lines.txt", start_line: 99, max_lines: 3 },
  ] }, { cwd, maxOutputBytes: 8192, autoApprove: true });
  assert.equal(result.isError, false);
  const rows = entries(result);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.index), [0, 1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.text), ["alpha\n", "two\r\n", "two\r\nthree", ""]);
  assert.equal(rows[1]?.sha256, createHash("sha256").update("two\r\n").digest("hex"));
  assert.equal(rows[2]?.eof, true);
  assert.equal(rows[2]?.end_line, 3);
  assert.equal(rows[3]?.eof, true);
});

test("large full read returns a resumable prefix while later files fit the one serialized byte cap", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-large-"));
  await writeFile(join(cwd, "huge.txt"), "H".repeat(80) + "\n" + "x\n".repeat(50_000));
  await writeFile(join(cwd, "small.txt"), "small\n");
  const result = await createTestToolRegistry().dispatch("read_file", { files: [
    { path: "huge.txt" }, { path: "small.txt" }, { path: "missing.txt" },
  ] }, { cwd, maxOutputBytes: 1024, autoApprove: true });
  const rows = entries(result);
  assert.equal(rows[0]?.status, "partial");
  assert.match(String(rows[0]?.text), /^H{80}\n/);
  assert.equal(typeof rows[0]?.next_line, "number");
  assert.equal(rows[1]?.text, "small\n");
  assert.equal(rows[2]?.status, "error");
  const block = result.content[0]!;
  assert.ok(Buffer.byteLength(JSON.stringify(block.type === "json" ? block.value : null)) <= 1024);
});

test("range paging stops on a whole line and invalid batch shapes reject before approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-page-"));
  const original = `first\n${"s".repeat(100)}\nthird\n`;
  await writeFile(join(cwd, "lines.txt"), original);
  const registry = createTestToolRegistry();
  const first = entries(await registry.dispatch("read_file", { files: [
    { path: "lines.txt", start_line: 1, max_lines: 3, max_bytes: 215 },
  ] }, { cwd, maxOutputBytes: 8192, autoApprove: true }))[0]!;
  assert.equal(first.status, "partial");
  assert.equal(first.text, "first\n");
  assert.equal(first.next_line, 2);
  const second = entries(await registry.dispatch("read_file", { files: [
    { path: "lines.txt", start_line: 2, max_lines: 2 },
  ] }, { cwd, maxOutputBytes: 8192, autoApprove: true }))[0]!;
  assert.equal(first.text + String(second.text), original);
  let approvals = 0;
  const context = { cwd, maxOutputBytes: 8192, autoApprove: false,
    approve: () => { approvals++; return true; } };
  for (const args of [
    { path: "lines.txt" }, { files: [] }, { files: Array.from({ length: 17 }, () => ({ path: "lines.txt" })) },
    { files: [{ path: "lines.txt", start_line: 1, end_line: 3, max_lines: 2 }] },
  ]) {
    assert.equal((await registry.dispatch("read_file", args, context)).code, "invalid_arguments");
  }
  assert.equal(approvals, 0);
});

test("a long first line is not split and UTF-8 paging resumes on the next line", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-utf8-"));
  await writeFile(join(cwd, "long.txt"), "L".repeat(10_000) + "\nshort\n");
  await writeFile(join(cwd, "emoji.txt"), `😀\n${"n".repeat(100)}\n`);
  const registry = createTestToolRegistry();
  const long = entries(await registry.dispatch("read_file", { files: [
    { path: "long.txt", start_line: 1, max_lines: 2, max_bytes: 220 },
  ] }, { cwd, maxOutputBytes: 8192, autoApprove: true }))[0]!;
  assert.equal(long.status, "line_too_large");
  assert.equal(long.text, "");
  assert.equal(long.next_line, 1);
  const emoji = entries(await registry.dispatch("read_file", { files: [
    { path: "emoji.txt", start_line: 1, max_lines: 2, max_bytes: 215 },
  ] }, { cwd, maxOutputBytes: 8192, autoApprove: true }))[0]!;
  assert.equal(emoji.status, "partial");
  assert.equal(emoji.text, "😀\n");
  assert.equal(emoji.next_line, 2);
});

test("a later missing file keeps its error after an earlier read fills the response", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-error-budget-"));
  await writeFile(join(cwd, "noisy.txt"), Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(80)}\n`).join(""));
  const rows = entries(await createTestToolRegistry().dispatch("read_file", { files: [
    { path: "noisy.txt", start_line: 1 }, { path: "missing.txt" },
  ] }, { cwd, maxOutputBytes: 1024, autoApprove: true }));
  assert.equal(rows[0]?.status, "partial");
  assert.equal(rows[1]?.status, "error");
});

test("max_bytes limits a serialized item and a completed range fits exactly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-exact-budget-"));
  await writeFile(join(cwd, "tiny.txt"), "a\n");
  const registry = createTestToolRegistry();
  const args = { files: [{ path: "tiny.txt", start_line: 1, max_lines: 1 }] };
  const full = entries(await registry.dispatch("read_file", args, { cwd, maxOutputBytes: 8192 }))[0]!;
  const exact = Buffer.byteLength(JSON.stringify({ results: [full] }));
  const exactResult = await registry.dispatch("read_file", args, { cwd, maxOutputBytes: exact });
  assert.equal(entries(exactResult)[0]?.status, "ok");
  const limited = entries(await registry.dispatch("read_file", { files: [
    { path: "tiny.txt", start_line: 1, max_lines: 1, max_bytes: Buffer.byteLength(JSON.stringify(full)) - 1 },
  ] }, { cwd, maxOutputBytes: 8192 }))[0]!;
  assert.notEqual(limited.status, "ok");
  const tooLarge = entries(await registry.dispatch("read_file", { files: [{ path: "tiny.txt", max_bytes: 120 }] },
    { cwd, maxOutputBytes: 8192 }))[0]!;
  assert.equal(tooLarge.status, "line_too_large");
});

test("Unicode path errors survive a noisy prior read; empty results respect max_bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-unicode-error-"));
  await writeFile(join(cwd, "noisy"), "x\n".repeat(6000));
  await writeFile(join(cwd, "empty"), "");
  const registry = createTestToolRegistry();
  const rows = entries(await registry.dispatch("read_file", { files: [
    { path: "noisy", start_line: 1 }, { path: "漢".repeat(60) },
  ] }, { cwd, maxOutputBytes: 8192 }));
  assert.equal(rows[1]?.status, "error");
  for (const file of [{ path: "empty", start_line: 1, max_bytes: 1 },
    { path: "noisy", start_line: 9999, max_bytes: 1 }]) {
    const row = entries(await registry.dispatch("read_file", { files: [file] }, { cwd, maxOutputBytes: 8192 }))[0]!;
    assert.notEqual(row.status, "ok");
  }
});

test("a completed multiline range fits its exact serialized global and entry budgets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-batch-multiline-exact-"));
  await writeFile(join(cwd, "tiny"), "a\nb\n");
  const registry = createTestToolRegistry();
  const args = { files: [{ path: "tiny", start_line: 1, max_lines: 2 }] };
  const expected = entries(await registry.dispatch("read_file", args, { cwd, maxOutputBytes: 8192 }))[0]!;
  const globalExact = Buffer.byteLength(JSON.stringify({ results: [expected] }));
  const itemExact = Buffer.byteLength(JSON.stringify(expected));
  assert.equal(entries(await registry.dispatch("read_file", args, { cwd, maxOutputBytes: globalExact }))[0]?.status, "ok");
  assert.equal(entries(await registry.dispatch("read_file", { files: [
    { ...args.files[0], max_bytes: itemExact },
  ] }, { cwd, maxOutputBytes: 8192 }))[0]?.status, "ok");
});
