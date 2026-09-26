import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runVariableProvider } from "../src/vars/provider.js";
const path = resolve("tests/fixtures/var-provider.mjs");
const spec = (mode: string, timeoutMs = 2000) => ({ command: process.execPath, args: [path, mode], cwd: process.cwd(), timeoutMs, maxOutputBytes: 65536 });
const request = { protocol_version: 1 as const, name: "x", params: { field: "value" } };
test("executable protocol sends one request and literal environment without shell expansion", async () => {
  const output = await runVariableProvider(spec("ok"), request, { env: { VAR_TEST: "$(no); ' literal" } });
  assert.deepEqual(output.value, { request, env: "$(no); ' literal", cwd: process.cwd() });
});
test("malformed, extra, invalid UTF-8, failed exit, output overflow and invalid response metadata fail", async () => {
  for (const mode of ["bad", "extra", "utf8", "exit", "overflow", "date", "unknown", "early"]) {
    await assert.rejects(runVariableProvider(spec(mode), request), error => {
      assert.doesNotMatch(String(error), /secret bytes|private stderr/); return true;
    });
  }
  await assert.rejects(runVariableProvider({ ...spec("ok"), command: "/missing/raw-provider" }, request), /var_provider_spawn/);
});
test("timeout and abort settle boundedly, including inherited pipes", async () => {
  for (const mode of ["hang", "descendant"]) {
    const started = Date.now();
    await assert.rejects(runVariableProvider(spec(mode, 150), request), /var_provider_timeout/);
    assert.ok(Date.now() - started < 3000);
  }
  await assert.rejects(runVariableProvider(spec("ok"), request, { signal: AbortSignal.abort() }), /aborted/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(runVariableProvider(spec("hang"), request, { signal: controller.signal }), /aborted/); }
  finally { clearTimeout(timer); }
});
