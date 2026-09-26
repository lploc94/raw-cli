import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { parseDashboardArgs, openDashboardBrowser } from "../src/dashboard/cli.js";

test("dashboard flags keep loopback and reject duplicate/unknown/invalid options", () => {
  assert.deepEqual(parseDashboardArgs(["--port", "0", "--no-open", "--agent", "raw"]), { port: 0, noOpen: true, agent: "raw" });
  for (const args of [["--host", "0.0.0.0"], ["--port", "65536"], ["--port", "-1"], ["--port", "0", "--port", "1"], ["--agent"]]) {
    assert.throws(() => parseDashboardArgs(args));
  }
});

test("browser opener failure is reported without requiring a shell", async () => {
  const result = await openDashboardBrowser("http://127.0.0.1:1234/#token=fixture", { command: "/definitely/missing/raw-opener" });
  assert.equal(result, false);
});

test("installed-style CLI prints a usable URL without opening and SIGINT closes the listener", async () => {
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
