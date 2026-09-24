import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";

const ctx = { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true };

test("deny hides schema and blocks direct dispatch while ordered last match wins", async () => {
  const registry = createToolRegistry([
    { match: "*", effect: "allow" },
    { match: "mcp:search/*", effect: "deny" },
    { match: "mcp:search/public", effect: "allow" },
    { match: "write_file", effect: "deny" },
  ]);
  let ran = false;
  for (const name of ["private", "public"]) registry.register({ name: `alias_${name}`, canonicalName: `mcp:search/${name}`,
    description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() { ran = true; return { isError: false, content: [{ type: "text", text: "ok" }] }; } });
  const names = registry.definitions().map((item) => item.name);
  assert.ok(!names.includes("write_file") && !names.includes("alias_private"));
  assert.ok(names.includes("alias_public") && names.includes("read_file"));
  const denied = await registry.dispatch("alias_private", {}, ctx);
  assert.equal(denied.code, "tool_denied");
  assert.equal(ran, false);
  const allowed = await registry.dispatch("alias_public", {}, ctx);
  assert.equal(allowed.isError, false);
  assert.equal(ran, true);
});

test("explicit ask cannot be bypassed by autoApprove and headless request fails closed", async () => {
  const registry = createToolRegistry([{ match: "bash", effect: "ask" }]);
  const input = { command: "printf should-not-run" };
  const missing = await registry.dispatch("bash", input, ctx);
  assert.equal(missing.code, "approval_required");
  const denied = await registry.dispatch("bash", input, { ...ctx, approve: async () => false });
  assert.equal(denied.code, "approval_denied");
  const calls: string[] = [];
  const allowed = await registry.dispatch("bash", { command: "printf yes" }, { ...ctx,
    approve: async (name) => { calls.push(name); return true; } });
  assert.equal(allowed.isError, false);
  assert.deepEqual(calls, ["bash"]);
});

test("wildcards cover embedded and trailing line breaks across entire canonical identity", async () => {
  let ran = 0;
  const denied = createToolRegistry([{ match: "acp:*", effect: "deny" }]);
  denied.register({ name: "alias", canonicalName: "acp:blocked\nextra", description: "hidden",
    inputSchema: { type: "object", properties: {} }, async handler() { ran++; return { isError: false, content: [] }; } });
  assert.ok(!denied.definitions().some((tool) => tool.name === "alias"));
  assert.equal((await denied.dispatch("alias", {}, ctx)).code, "tool_denied");
  const asked = createToolRegistry([{ match: "acp:blocked", effect: "allow" }, { match: "acp:*", effect: "ask" }]);
  asked.register({ name: "alias", canonicalName: "acp:blocked\n", description: "requires approval",
    inputSchema: { type: "object", properties: {} }, async handler() { ran++; return { isError: false, content: [] }; } });
  assert.equal((await asked.dispatch("alias", {}, ctx)).code, "approval_required");
  assert.equal(ran, 0);
});
