import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";

const context = (cwd: string, maxOutputBytes = 8192) => ({ cwd, maxOutputBytes, autoApprove: true });

test("files resolve per session, create parents, accept empty content and surface errors", async () => {
  const [a, b] = await Promise.all([mkdtemp(join(tmpdir(), "raw-a-")), mkdtemp(join(tmpdir(), "raw-b-"))]);
  const registry = createToolRegistry();
  await Promise.all([
    registry.dispatch("write_file", { path: "nested/item", content: "alpha" }, context(a)),
    registry.dispatch("write_file", { path: "nested/item", content: "beta" }, context(b)),
  ]);
  assert.equal(await readFile(join(a, "nested/item"), "utf8"), "alpha");
  assert.equal(await readFile(join(b, "nested/item"), "utf8"), "beta");
  const empty = await registry.dispatch("write_file", { path: join(a, "empty"), content: "" }, context(b));
  assert.equal(empty.isError, false);
  assert.equal(await readFile(join(a, "empty"), "utf8"), "");
  const read = await registry.dispatch("read_file", { files: [{ path: "nested/item" }] }, context(b));
  assert.equal(read.content[0]?.type, "json");
  assert.equal(read.content[0]?.type === "json"
    ? (read.content[0].value as { results: Array<{ text: string }> }).results[0]?.text : "", "beta");
  assert.equal((await registry.dispatch("read_file", { files: [{ path: "missing" }] }, context(a))).isError, true);
  assert.equal((await registry.dispatch("read_file", { files: [{ path: a }] }, context(a))).isError, true);
  await writeFile(join(a, "utf8"), "😀😀");
  const bounded = await registry.dispatch("read_file", { files: [{ path: "utf8", max_bytes: 4 }] }, context(a));
  assert.equal(bounded.content[0]?.type === "json"
    ? (bounded.content[0].value as { results: Array<{ status: string }> }).results[0]?.status : "", "line_too_large");
  await writeFile(join(a, "replacement"), "�x");
  const replacement = await registry.dispatch("read_file", { files: [{ path: "replacement" }] }, context(a));
  assert.equal(replacement.content[0]?.type === "json"
    ? (replacement.content[0].value as { results: Array<{ text: string }> }).results[0]?.text : "", "�x");
  await writeFile(join(a, "bom"), "\uFEFFabc");
  const bom = await registry.dispatch("read_file", { files: [{ path: "bom" }] }, context(a));
  assert.equal(bom.content[0]?.type === "json"
    ? (bom.content[0].value as { results: Array<{ text: string }> }).results[0]?.text : "", "\uFEFFabc");
});

test("bash preserves output channels, exit status and bounded UTF-8 while draining large pipes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-bash-"));
  const registry = createToolRegistry();
  const result = await registry.dispatch("bash", { command: "printf hi; printf err >&2; exit 7" }, context(cwd));
  assert.equal(result.exitCode, 7);
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.filter((x) => x.type === "text").map((x) => [x.channel, x.text]), [["stdout", "hi"], ["stderr", "err"]]);
  const exact = await registry.dispatch("bash", { command: "printf abcde" }, context(cwd, 5));
  assert.equal(exact.truncated, false);
  assert.equal(exact.retainedBytes, 5);
  const huge = await registry.dispatch("bash", { command: "node -e 'process.stdout.write(\"😀\"+\"x\".repeat(200000))'" }, context(cwd, 5));
  assert.equal(huge.exitCode, 0);
  assert.equal(huge.truncated, true);
  assert.equal(huge.retainedBytes, 5);
  assert.equal(huge.observedBytes, 200004);
  const timeout = await registry.dispatch("bash", { command: "sleep 5", timeout_ms: 20 }, context(cwd));
  assert.equal(timeout.timedOut, true);
  assert.notEqual(timeout.exitCode, 0);
});

test("abort kills owned shell descendants and leaves unrelated processes running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-tree-"));
  const marker = join(cwd, "owned");
  const unrelated = join(cwd, "unrelated");
  const other = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'ok'), 900)", unrelated], { stdio: "ignore" });
  const otherExited = new Promise((resolve) => other.once("exit", resolve));
  const controller = new AbortController();
  const task = createToolRegistry().dispatch("bash", { command: `node ${JSON.stringify(new URL("./fixtures/process-tree.cjs", import.meta.url).pathname)} ${JSON.stringify(marker)}` }, { ...context(cwd), signal: controller.signal });
  let ownedPid = 0;
  for (let i = 0; i < 100; i++) {
    try { ownedPid = Number(await readFile(marker + ".ready", "utf8")); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(ownedPid > 0, "descendant started before abort");
  controller.abort();
  const result = await task;
  assert.equal(result.code, "aborted");
  await otherExited;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.throws(() => process.kill(ownedPid, 0), "owned descendant exited");
  await assert.rejects(access(marker));
  await assert.rejects(access(marker + ".parent"));
  assert.equal(await readFile(unrelated, "utf8"), "ok");
  const pre = new AbortController();
  pre.abort();
  assert.equal((await createToolRegistry().dispatch("bash", { command: `touch ${JSON.stringify(marker)}` }, { ...context(cwd), signal: pre.signal })).code, "aborted");
});

test("timeout settles even when an escaped descendant holds inherited output pipes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "raw-escaped-"));
  const pidFile = join(cwd, "pid");
  const started = Date.now();
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  try {
    const result = await createToolRegistry().dispatch("bash", {
      command: `node ${JSON.stringify(new URL("./fixtures/escaped-pipes.cjs", import.meta.url).pathname)} ${JSON.stringify(pidFile)}`,
      timeout_ms: 300,
    }, context(cwd));
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 2500, "settles inside cancellation budget");
  } finally {
    try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch { /* fixture may not have started */ }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length <= timersBefore, "no owned timeout remains after settlement");
});
