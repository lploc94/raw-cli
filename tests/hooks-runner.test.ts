import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHook } from "../src/hooks/runner.js";
import type { SelectedHook } from "../src/hooks/contract.js";

async function fixture(source: string, timeoutMs = 1500): Promise<SelectedHook> {
  const folder = await mkdtemp(join(tmpdir(), "raw-hook-runner-"));
  await writeFile(join(folder, "run.mjs"), source);
  return { id: "agent/check", name: "check", folder, command: process.execPath,
    args: [join(folder, "run.mjs")], timeoutMs, events: [{ name: "PreToolUse" }] };
}
const request = { protocol_version: 1 as const, event: "PreToolUse" as const, cwd: process.cwd(),
  tool: { identity: "builtin/bash", name: "bash", arguments: { commands: [{ command: "rm x" }] } } };

test("hook runner accepts empty success and structured denial, with exit 2 taking precedence", async () => {
  const empty = await fixture("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  assert.equal((await runHook(empty, request)).decision, "continue");
  const deny = await fixture("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'deny',reason:'blocked'})); });");
  assert.deepEqual((await runHook(deny, request)).decision, "deny");
  const exitTwo = await fixture("process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({decision:'continue'})); process.exitCode=2; });");
  assert.equal((await runHook(exitTwo, request)).decision, "deny");
});

test("invalid output and nonblocking-looking exit codes are errors, not successful gates", async () => {
  for (const source of ["process.stdout.write('{} garbage')", "process.stdout.write('{')", "process.exitCode=1",
    "process.stdout.write('x'.repeat(70000))"]) {
    await assert.rejects(runHook(await fixture(source), request));
  }
});

test("hook runner bounds timeout and cancellation including descendants", async () => {
  const hang = await fixture("setInterval(() => {}, 1000)", 100);
  const started = Date.now();
  await assert.rejects(runHook(hang, request), /timeout/i);
  assert.ok(Date.now() - started < 3000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(runHook(await fixture("setInterval(() => {}, 1000)"), request,
    { signal: controller.signal }), /abort/i); }
  finally { clearTimeout(timer); }
  if (process.platform !== "win32") {
    const marker = join(await mkdtemp(join(tmpdir(), "raw-hook-descendant-")), "survived");
    const childSource = `import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 400) `)}],
        { stdio: "inherit" }); setInterval(() => {}, 1000);`;
    await assert.rejects(runHook(await fixture(childSource, 100), request), /timeout/i);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await assert.rejects(readFile(marker));
  }
});
