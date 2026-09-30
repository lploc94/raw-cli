import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tools/registry.js";
import { loadBundledTools } from "../src/tools/plugins/loader.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
async function registry(rules: ConstructorParameters<typeof ToolRegistry>[0] = []) {
  const registry = new ToolRegistry(rules); for (const tool of await loadBundledTools(["process"])) registry.register(tool); return registry;
}
test("packaged Process uses normal policy and validates all action arguments before approval or spawn", async () => {
  const tools = await registry([{ match: "builtin/process", effect: "ask" }]); let approvals = 0;
  const supervisor = new ProcessSupervisor(); const processes = supervisor.forSession("s");
  try {
    for (const args of [{ action: "start", command: "true", cwd: "/tmp" }, { action: "stop" }, { action: "output", id: "x", cursor: -1 }, { action: "list", command: "true" }, { action: "start", command: "true", env_refs: { "bad-name": "var" } }]) {
      const result = await tools.dispatch("process", args, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => { approvals++; return true; } });
      assert.equal(result.code, "invalid_arguments");
    }
    assert.equal(approvals, 0); assert.equal(processes.list().length, 0);
    const unavailable = await tools.dispatch("process", { action: "list" }, { cwd: process.cwd(), maxOutputBytes: 8192, approve: () => true });
    assert.equal(unavailable.code, "process_unavailable");
    const noVariables = await tools.dispatch("process", { action: "start", command: "true", env_refs: { KEY: "missing" } }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => true });
    assert.equal(noVariables.code, "vars_unavailable"); assert.equal(processes.list().length, 0);
    const denied = await tools.dispatch("process", { action: "start", command: "sleep 30" }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => false });
    assert.equal(denied.isError, true); assert.equal(processes.list().length, 0);
    const started = await tools.dispatch("process", { action: "start", command: "printf process; sleep 30" }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => { approvals++; return true; } });
    assert.equal(started.isError, false); assert.equal(started.content[0]!.type, "json");
    if (started.content[0]!.type !== "json") assert.fail("canonical start acknowledgement");
    const id = (started.content[0]!.value as { id: string }).id;
    const stopped = await tools.dispatch("process", { action: "stop", id }, { cwd: process.cwd(), maxOutputBytes: 8192, processes, approve: () => true });
    assert.equal(stopped.isError, false); assert.match(JSON.stringify(stopped), /stopped/);
  } finally { await supervisor.close(); }
});

test("Process output preserves paged JSON and advances cursors under escaped-text result budgets", async () => {
  const tools = await registry(); const supervisor = new ProcessSupervisor(); const processes = supervisor.forSession("output");
  try {
    const job = await processes.start({ command: "node -e \"process.stdout.write(String.fromCharCode(1).repeat(1500))\"", cwd: process.cwd() });
    for (let i = 0; i < 200 && processes.status(job.id).state === "running"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    let cursor = 0; let text = "";
    while (cursor < processes.status(job.id).cursor) {
      const result = await tools.dispatch("process", { action: "output", id: job.id, cursor }, { cwd: process.cwd(), maxOutputBytes: 512, processes, autoApprove: true });
      assert.equal(result.isError, false); assert.equal(result.truncated, false);
      const block = result.content[0]!; if (block.type !== "json") assert.fail("paged output remains JSON");
      const page = block.value as { nextCursor: number; chunks: Array<{ text: string }> };
      assert.ok(page.nextCursor > cursor, "each budget-aware page makes progress");
      text += page.chunks.map(chunk => chunk.text).join(""); cursor = page.nextCursor;
    }
    assert.equal(text, String.fromCharCode(1).repeat(1500));
  } finally { await supervisor.close(); }
});

test("Process action is a typed policy path so Stop can require approval independently of reads", async () => {
  const tools = await registry([{ match: "builtin/process", effect: "ask", when: { source: "arguments", any: "action", regex: "^stop$" } }]);
  const supervisor = new ProcessSupervisor(); const processes = supervisor.forSession("policy");
  try {
    const job = await processes.start({ command: "sleep 30", cwd: process.cwd() });
    const context = { cwd: process.cwd(), maxOutputBytes: 8192, processes, autoApprove: true };
    assert.equal((await tools.dispatch("process", { action: "status", id: job.id }, context)).isError, false);
    assert.equal((await tools.dispatch("process", { action: "stop", id: job.id }, { ...context, approve: () => false })).isError, true);
    assert.equal(processes.status(job.id).state, "running");
    assert.equal((await tools.dispatch("process", { action: "stop", id: job.id }, { ...context, approve: () => true })).isError, false);
  } finally { await supervisor.close(); }
});
