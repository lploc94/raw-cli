import assert from "node:assert/strict";
import test from "node:test";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { mkdtemp, readFile, access, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("acknowledged background process survives its start signal and is readable and stoppable later", async () => {
  const supervisor = new ProcessSupervisor();
  try {
    const signal = new AbortController(); const context = supervisor.forSession("session");
    const job = await context.start({ command: "printf '雪'; sleep 30", cwd: process.cwd(), signal: signal.signal });
    signal.abort(); await delay(80);
    assert.equal(context.status(job.id).state, "running"); assert.match(context.output(job.id).chunks.map(chunk => chunk.text).join(""), /雪/);
    assert.equal((await context.stop(job.id)).state, "stopped"); assert.equal((await context.stop(job.id)).state, "stopped");
    assert.throws(() => supervisor.forSession("foreign").status(job.id), /not found/);
  } finally { await supervisor.close(); }
});
test("supervisor reports nonzero exits, timeout, spawn errors and unsupported platform without false live state", async () => {
  const supervisor = new ProcessSupervisor();
  try {
    const context = supervisor.forSession("s");
    const failed = await context.start({ command: "exit 7", cwd: process.cwd() }); await delay(100);
    assert.equal(context.status(failed.id).state, "failed"); assert.equal(context.status(failed.id).exitCode, 7);
    const timeout = await context.start({ command: "sleep 30", cwd: process.cwd(), timeout_ms: 30 }); await delay(800);
    assert.equal(context.status(timeout.id).state, "timed_out");
    await assert.rejects(context.start({ command: "true", cwd: process.cwd(), bashPath: "/missing/raw-bash" }), /start/);
  } finally { await supervisor.close(); }
  const windows = new ProcessSupervisor({ platform: "win32" });
  try { await assert.rejects(windows.forSession("s").start({ command: "echo x", cwd: process.cwd() }), error => (error as {code?:string}).code === "unsupported_platform"); }
  finally { await windows.close(); }
});

test("output floods retain bounded UTF-8 logs with explicit expired cursors and bounded pages", async () => {
  const supervisor = new ProcessSupervisor();
  try {
    const context = supervisor.forSession("flood");
    const job = await context.start({ command: "node -e \"process.stdout.write('雪'.repeat(800000),()=>process.stderr.write('error-channel'))\"", cwd: process.cwd() });
    for (let i = 0; i < 300 && context.status(job.id).state === "running"; i++) await delay(10);
    assert.equal(context.status(job.id).state, "exited");
    const record = context.status(job.id);
    assert.ok(record.earliestCursor > 0);
    assert.ok(record.cursor - record.earliestCursor <= 1024 * 1024);
    const page = context.output(job.id, 0, 65536);
    assert.equal(page.truncated, true); assert.equal(page.droppedBytes, record.earliestCursor);
    assert.ok(page.chunks.reduce((n, chunk) => n + Buffer.byteLength(chunk.text), 0) <= 65536);
    assert.doesNotMatch(page.chunks.map(chunk => chunk.text).join(""), /�/);
    let cursor = page.nextCursor; let stderr = "";
    while (cursor < record.cursor) {
      const next = context.output(job.id, cursor, 65536);
      assert.ok(next.nextCursor > cursor);
      stderr += next.chunks.filter(chunk => chunk.channel === "stderr").map(chunk => chunk.text).join("");
      cursor = next.nextCursor;
    }
    assert.equal(stderr, "error-channel");
  } finally { await supervisor.close(); }
});

test("live admission caps reject additional starts before spawning and shutdown settles all owned jobs", async () => {
  const supervisor = new ProcessSupervisor(); const context = supervisor.forSession("limit");
  try {
    for (let i = 0; i < 8; i++) await context.start({ command: "sleep 30", cwd: process.cwd() });
    await assert.rejects(context.start({ command: "sleep 30", cwd: process.cwd() }), error => (error as { code?: string }).code === "process_limit");
    assert.equal(context.list().length, 8);
  } finally { await supervisor.close(); }
  assert.ok(context.list().every(record => record.state === "stopped"));
});

test("pre-acknowledgement cancellation settles the owned child and pre-aborted starts reserve nothing", async () => {
  const supervisor = new ProcessSupervisor(); const context = supervisor.forSession("cancel");
  try {
    const pre = new AbortController(); pre.abort();
    await assert.rejects(context.start({ command: "sleep 30", cwd: process.cwd(), signal: pre.signal }), /before spawn/);
    assert.equal(context.list().length, 0);
    const pending = new AbortController();
    const start = context.start({ command: "sleep 30", cwd: process.cwd(), signal: pending.signal }); pending.abort();
    await assert.rejects(start, /before acknowledgement/);
    assert.equal(context.list()[0]!.state, "stopped");
  } finally { await supervisor.close(); }
});

test("managed Stop terminates owned grandchildren before they can execute delayed side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-managed-tree-")); const marker = join(root, "owned");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const supervisor = new ProcessSupervisor(); const context = supervisor.forSession("tree");
  try {
    const job = await context.start({ command: `${quote(process.execPath)} ${quote(fileURLToPath(new URL("./fixtures/process-tree.cjs", import.meta.url)))} ${quote(marker)}`, cwd: root });
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) { try { pid = Number(await readFile(marker + ".ready", "utf8")); } catch { await delay(10); } }
    assert.ok(pid > 0);
    assert.equal((await context.stop(job.id)).state, "stopped");
    await delay(700);
    await assert.rejects(access(marker)); await assert.rejects(access(marker + ".parent"));
  } finally { await supervisor.close(); await rm(root, { recursive: true, force: true }); }
});

test("output resumes at the next UTF-8 boundary and rejects a page too small for one character", async () => {
  const supervisor = new ProcessSupervisor(); const context = supervisor.forSession("boundary");
  try {
    const job = await context.start({ command: "printf '雪'", cwd: process.cwd() });
    for (let i = 0; i < 100 && context.status(job.id).state === "running"; i++) await delay(10);
    const skipped = context.output(job.id, 1, 65536);
    assert.equal(skipped.nextCursor, 3); assert.equal(skipped.truncated, false);
    assert.throws(() => context.output(job.id, 0, 1), error => (error as { code?: string }).code === "output_budget_too_small");
  } finally { await supervisor.close(); }
});

test("natural command completion cleans non-detached descendants even when they close inherited pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raw-managed-natural-")); const marker = join(root, "escaped"); const script = join(root, "parent.cjs");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(script, `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');
    const child=spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'escaped'),600)",process.argv[2]],{stdio:'ignore'});
    writeFileSync(process.argv[2]+'.ready',String(child.pid));child.unref();`);
  const supervisor = new ProcessSupervisor(); const context = supervisor.forSession("natural");
  try {
    const job = await context.start({ command: `${quote(process.execPath)} ${quote(script)} ${quote(marker)}`, cwd: root });
    for (let i = 0; i < 100 && context.status(job.id).state === "running"; i++) await delay(10);
    assert.ok(Number(await readFile(marker + ".ready", "utf8")) > 0);
    assert.equal(context.status(job.id).state, "exited");
    await supervisor.close(); await delay(900);
    await assert.rejects(access(marker), "an ignored-stdio descendant still belongs to the managed job");
  } finally { await supervisor.close(); await rm(root, { recursive: true, force: true }); }
});
