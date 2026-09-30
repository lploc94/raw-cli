import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestToolRegistry } from "./fixtures/registry.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ctx = { cwd: process.cwd(), maxOutputBytes: 8192, autoApprove: true };
const rmPattern = String.raw`(^|[;&|()\n])\s*(sudo\s+)?(/usr/bin/|/bin/)?rm(\s|$)`;

test("deny hides schema and blocks direct dispatch while ordered last match wins", async () => {
  const registry = createTestToolRegistry([
    { match: "*", effect: "allow" },
    { match: "mcp/search/*", effect: "deny" },
    { match: "mcp/search/public", effect: "allow" },
    { match: "builtin/write_file", effect: "deny" },
  ]);
  let ran = false;
  for (const name of ["private", "public"]) registry.register({ name: `alias_${name}`, canonicalName: `mcp/search/${name}`,
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
  const registry = createTestToolRegistry([{ match: "builtin/bash", effect: "ask" }]);
  const input = { commands: [{ command: "printf should-not-run" }] };
  const missing = await registry.dispatch("bash", input, ctx);
  assert.equal(missing.code, "approval_required");
  const denied = await registry.dispatch("bash", input, { ...ctx, approve: async () => false });
  assert.equal(denied.code, "approval_denied");
  const calls: string[] = [];
  const allowed = await registry.dispatch("bash", { commands: [{ command: "printf yes" }] }, { ...ctx,
    approve: async ({ name }) => { calls.push(name); return true; } });
  assert.equal(allowed.isError, false);
  assert.deepEqual(calls, ["bash"]);
});

test("wildcards cover embedded and trailing line breaks across entire canonical identity", async () => {
  let ran = 0;
  const denied = createTestToolRegistry([{ match: "acp:*", effect: "deny" }]);
  denied.register({ name: "alias", canonicalName: "acp:blocked\nextra", description: "hidden",
    inputSchema: { type: "object", properties: {} }, async handler() { ran++; return { isError: false, content: [] }; } });
  assert.ok(!denied.definitions().some((tool) => tool.name === "alias"));
  assert.equal((await denied.dispatch("alias", {}, ctx)).code, "tool_denied");
  const asked = createTestToolRegistry([{ match: "acp:blocked", effect: "allow" }, { match: "acp:*", effect: "ask" }]);
  asked.register({ name: "alias", canonicalName: "acp:blocked\n", description: "requires approval",
    inputSchema: { type: "object", properties: {} }, async handler() { ran++; return { isError: false, content: [] }; } });
  assert.equal((await asked.dispatch("alias", {}, ctx)).code, "approval_required");
  assert.equal(ran, 0);
});

test("matching Bash command in a later batch slot asks once before any command runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raw-conditional-bash-"));
  const marker = join(cwd, "marker");
  const registry = createTestToolRegistry([{ match: "builtin/bash", effect: "ask",
    when: { source: "arguments", any: "commands[*].command", regex: rmPattern } }]);
  const safe = await registry.dispatch("bash", { commands: [{ command: "printf ok" }] }, { ...ctx, cwd });
  assert.equal(safe.isError, false);
  const input = { commands: [{ command: "touch marker" }, { command: "rm -f marker" }] };
  let approvals = 0;
  const denied = await registry.dispatch("bash", input, { ...ctx, cwd,
    approve: async () => { approvals++; return false; } });
  assert.equal(denied.code, "approval_denied");
  assert.equal(approvals, 1);
  assert.equal(existsSync(marker), false);
  const allowed = await registry.dispatch("bash", input, { ...ctx, cwd,
    approve: async () => { approvals++; return true; } });
  assert.equal(allowed.isError, false);
  assert.equal(approvals, 2);
  assert.equal(existsSync(marker), false);
});

test("conditional ask binds a nested typed string path and ordered allow can override it", async () => {
  let calls = 0;
  const registration = { name: "typed", canonicalName: "agent/typed", description: "typed",
    inputSchema: { type: "object" as const, properties: { payload: { type: "object", properties: { text: { type: "string" } } } } },
    async handler() { calls++; return { isError: false, content: [{ type: "text" as const, text: "ok" }] }; } };
  const registry = createTestToolRegistry([{ match: "agent/typed", effect: "ask",
    when: { source: "arguments", any: "payload.text", regex: "delete" } }]);
  registry.register(registration);
  assert.equal((await registry.dispatch("typed", { payload: { text: "keep" } }, ctx)).isError, false);
  assert.equal((await registry.dispatch("typed", {}, ctx)).isError, false);
  assert.equal((await registry.dispatch("typed", { payload: { text: "delete" } }, ctx)).code, "approval_required");
  assert.equal(calls, 2);
  const override = createTestToolRegistry([{ match: "agent/typed", effect: "ask",
    when: { source: "arguments", any: "payload.text", regex: "delete" } }, { match: "agent/typed", effect: "allow" }]);
  override.register(registration);
  assert.equal((await override.dispatch("typed", { payload: { text: "delete" } }, ctx)).isError, false);
  const invalid = createTestToolRegistry([{ match: "agent/typed", effect: "ask",
    when: { source: "arguments", any: "payload.missing", regex: "x" } }]);
  assert.throws(() => invalid.register(registration), /when\.any|schema/i);
  const referenced = createTestToolRegistry([{ match: "agent/referenced", effect: "ask",
    when: { source: "arguments", any: "rows[*].command", regex: "rm" } }]);
  referenced.register({ name: "referenced", canonicalName: "agent/referenced", description: "referenced",
    inputSchema: { type: "object", properties: { rows: { $ref: "#/$defs/rows" } },
      $defs: { rows: { type: "array", items: { type: "object", properties: { command: { type: "string" } } } } } },
    async handler() { return { isError: false, content: [] }; } });
  assert.equal((await referenced.dispatch("referenced", { rows: [{ command: "rm x" }] }, ctx)).code, "approval_required");
});

test("RE2 conditional pattern bounds hostile input and unconditional deny stays hidden", async () => {
  const registry = createTestToolRegistry([{ match: "builtin/bash", effect: "ask",
    when: { source: "arguments", any: "commands[*].command", regex: "(a+)+$" } }]);
  const result = await registry.dispatch("bash", { commands: [{ command: "printf " + "a".repeat(20_000) + "!" }] }, ctx);
  assert.equal(result.isError, false);
  const hidden = createTestToolRegistry([{ match: "builtin/bash", effect: "deny" }, { match: "builtin/bash", effect: "ask",
    when: { source: "arguments", any: "commands[*].command", regex: "rm" } }]);
  assert.ok(!hidden.definitions().some((tool) => tool.name === "bash"));
  assert.equal((await hidden.dispatch("bash", { commands: [{ command: "rm x" }] }, ctx)).code, "tool_denied");
});
