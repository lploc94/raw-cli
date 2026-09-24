import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";
import type { ToolResult } from "../src/tools/types.js";

function rows(result: ToolResult): Array<Record<string, unknown>> {
  assert.equal(result.content[0]?.type, "json", JSON.stringify(result));
  return (result.content[0] as { type: "json"; value: { results: Array<Record<string, unknown>> } }).value.results;
}

test("bash batch is sequential, keeps channels separate and continues after nonzero exit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-bash-batch-"));
  const result = await createToolRegistry().dispatch("bash", { commands: [
    { command: "printf first > marker; printf out; printf err >&2" },
    { command: "test -f marker; exit 7" },
    { command: "cat marker; printf third >> marker" },
  ] }, { cwd, maxOutputBytes: 8192 });
  const entries = rows(result);
  assert.deepEqual(entries.map((row) => row.index), [0, 1, 2]);
  assert.deepEqual(entries.map((row) => row.exit_code), [0, 7, 0]);
  assert.equal(entries[0]?.stdout, "out");
  assert.equal(entries[0]?.stderr, "err");
  assert.equal(entries[2]?.stdout, "first");
  assert.equal(await readFile(join(cwd, "marker"), "utf8"), "firstthird");
  assert.equal(result.isError, false);
});

test("a noisy first command cannot hide or prevent later command outcomes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-bash-noisy-"));
  const result = await createToolRegistry().dispatch("bash", { commands: [
    { command: "printf '%05000d' 0" },
    { command: "printf middle > marker; printf M" },
    { command: "cat marker" },
  ] }, { cwd, maxOutputBytes: 1024 });
  const entries = rows(result);
  assert.deepEqual(entries.map((row) => row.status), ["ok", "ok", "ok"]);
  assert.equal(entries[0]?.truncated, true);
  assert.equal(entries[1]?.stdout, "M");
  assert.equal(entries[2]?.stdout, "middle");
  assert.equal(await readFile(join(cwd, "marker"), "utf8"), "middle");
  assert.ok(Buffer.byteLength(JSON.stringify({ results: entries })) <= 1024);
});

test("JSON-escaped output uses only its fair share, leaving later outputs intact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-bash-escaped-budget-"));
  const result = await createToolRegistry().dispatch("bash", { commands: [
    { command: "printf '\\001%.0s' {1..20000}" },
    { command: "printf '%01000d' 0" },
    { command: "printf '%01000d' 0" },
  ] }, { cwd, maxOutputBytes: 8192 });
  const entries = rows(result);
  assert.deepEqual(entries.map((row) => row.status), ["ok", "ok", "ok"]);
  assert.equal(entries[0]?.truncated, true);
  assert.equal(String(entries[1]?.stdout).length, 1000);
  assert.equal(String(entries[2]?.stdout).length, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify({ results: entries })) <= 8192);
});

test("timeout and abort stop the batch and mark every later index skipped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-bash-stop-"));
  const registry = createToolRegistry();
  const timed = rows(await registry.dispatch("bash", { commands: [
    { command: "sleep 2", timeout_ms: 50 }, { command: "touch timeout-marker" },
  ] }, { cwd, maxOutputBytes: 8192 }));
  assert.deepEqual(timed.map((row) => row.status), ["timeout", "skipped"]);
  await assert.rejects(access(join(cwd, "timeout-marker")));
  const controller = new AbortController();
  const pending = registry.dispatch("bash", { commands: [
    { command: "sleep 5" }, { command: "touch abort-marker" }, { command: "true" },
  ] }, { cwd, maxOutputBytes: 8192, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const aborted = rows(await pending);
  assert.deepEqual(aborted.map((row) => row.status), ["aborted", "skipped", "skipped"]);
  await assert.rejects(access(join(cwd, "abort-marker")));
});

test("invalid commands reject the whole call before approval and spawning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-bash-invalid-"));
  const registry = createToolRegistry([{ match: "bash", effect: "ask" }]);
  let approvals = 0;
  for (const input of [
    { command: "touch marker" },
    { commands: [] },
    { commands: [{ command: "touch marker" }, { command: "true", timeout_ms: 0 }] },
    { commands: Array.from({ length: 17 }, () => ({ command: "true" })) },
  ]) {
    assert.equal((await registry.dispatch("bash", input, { cwd, maxOutputBytes: 8192,
      approve: () => { approvals++; return true; } })).code, "invalid_arguments");
  }
  assert.equal(approvals, 0);
  await assert.rejects(access(join(cwd, "marker")));
});
