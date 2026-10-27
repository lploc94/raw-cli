import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { parseDashboardArgs, openDashboardBrowser } from "../src/dashboard/cli.js";
import { posixOnly } from "./fixtures/platform.js";

test("dashboard flags keep loopback and reject duplicate/unknown/invalid options", () => {
  assert.deepEqual(parseDashboardArgs(["--port", "0", "--no-open", "--agent", "raw"]), { port: 0, noOpen: true, agent: "raw" });
  for (const args of [["--host", "0.0.0.0"], ["--port", "65536"], ["--port", "-1"], ["--port", "0", "--port", "1"], ["--agent"]]) {
    assert.throws(() => parseDashboardArgs(args));
  }
});

test("--remote parses as a boolean, rejects duplicates and is listed in the help texts", async () => {
  assert.deepEqual(parseDashboardArgs(["--remote", "--no-open"]), { remote: true, noOpen: true });
  assert.deepEqual(parseDashboardArgs(["--no-open"]), { noOpen: true });
  assert.throws(() => parseDashboardArgs(["--remote", "--remote"]), /duplicate/);
  assert.throws(() => parseDashboardArgs(["--remote", "yes"]), /unknown/);
  const dashboardHelp = spawnSync(process.execPath, [join(process.cwd(), "dist/raw.js"), "dashboard", "--help"], { encoding: "utf8" });
  assert.match(dashboardHelp.stdout, /--remote/);
  const rootHelp = spawnSync(process.execPath, [join(process.cwd(), "dist/raw.js"), "--help"], { encoding: "utf8" });
  assert.match(rootHelp.stdout + rootHelp.stderr, /raw dashboard \[--port PORT\] \[--no-open\] \[--remote\]/);
});

test("browser opener failure is reported without requiring a shell", async () => {
  const result = await openDashboardBrowser("http://127.0.0.1:1234/#token=fixture", { command: "/definitely/missing/raw-opener" });
  assert.equal(result, false);
});

test("installed-style CLI prints a usable URL without opening and SIGINT closes the listener", { skip: posixOnly("signals") }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-dashboard-cli-"));
  const child = spawn(process.execPath, [join(process.cwd(), "dist/raw.js"), "dashboard", "--port", "0", "--no-open"], {
    cwd: root, env: { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = ""; const timer = setTimeout(() => reject(new Error("dashboard did not start")), 10_000); timer.unref();
      child.stdout.on("data", (chunk) => { output += String(chunk); const found = /http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/.exec(output);
        if (found) { clearTimeout(timer); resolve(found[0]); } });
      child.once("error", reject); child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`early dashboard exit ${code}`)); });
    });
    const parsed = new URL(url); const token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
    assert.equal((await fetch(`${parsed.origin}/api/bootstrap`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    const exit = once(child, "exit"); child.kill("SIGINT"); const [code] = await exit; assert.equal(code, 0);
    await assert.rejects(fetch(`${parsed.origin}/api/bootstrap`));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

test("CLI without --port says so when the default port is busy and still prints a usable link", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-dashboard-cli-"));
  const holder = createNetServer();
  await new Promise<void>((resolve) => { holder.once("error", () => resolve()); holder.listen(21517, "127.0.0.1", resolve); }); // busy either way
  const child = spawn(process.execPath, [join(process.cwd(), "dist/raw.js"), "dashboard", "--no-open"], {
    cwd: root, env: { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const output = await new Promise<string>((resolve, reject) => {
      let out = ""; const timer = setTimeout(() => reject(new Error("dashboard did not start")), 10_000); timer.unref();
      // stdout and stderr are separate pipes with no ordering between them: wait for both the link and the notice.
      const take = (chunk: unknown) => { out += String(chunk);
        if (/#token=[A-Za-z0-9_-]+/.test(out) && /port 21517 is in use; using \d+/.test(out)) { clearTimeout(timer); resolve(out); } };
      child.stdout.on("data", take); child.stderr.on("data", take);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`early dashboard exit ${code}`)); });
    });
    assert.match(output, /port 21517 is in use; using \d+/);
    assert.doesNotMatch(output, /127\.0\.0\.1:21517\//);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); holder.close(); rmSync(root, { recursive: true, force: true }); }
});

// The one Node 22 diagnostic that CI prints on stderr and a newer Node does not (same filter as tests/acp-transport.test.ts).
const withoutSqliteWarning = (stderr: string) => stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\n\(Use `node --trace-warnings[^\n]*\n/g, "");

test("without --remote nothing is spawned and the output is exactly the local launch lines", { skip: posixOnly("signals") }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-dashboard-cli-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const marker = join(root, "cloudflared-ran");
  writeFileSync(join(bin, "cloudflared"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(process.cwd(), "dist/raw.js"), "dashboard", "--port", "0", "--no-open"], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dashboard did not start")), 10_000); timer.unref();
      const poll = setInterval(() => { if (stdout.includes("Press Ctrl-C to stop.\n")) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 20); poll.unref();
    });
    const exit = once(child, "exit"); child.kill("SIGINT"); const [code] = await exit; assert.equal(code, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(withoutSqliteWarning(stderr), "");
    assert.equal(stdout.replace(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/, "http://127.0.0.1:<PORT>/#token=<TOKEN>"), "Raw dashboard: http://127.0.0.1:<PORT>/#token=<TOKEN>\nPress Ctrl-C to stop.\n");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});
