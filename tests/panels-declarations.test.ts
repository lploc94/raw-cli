import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { hostCapabilities } from "../src/packages/contract.js";
import { exportAgentPackage } from "../src/packages/export.js";
import { isStalePanel, knownPanelDeclarations } from "../src/panels/declarations.js";
import type { PanelDeclaration } from "../src/panels/contract.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import { openSessionStore } from "../src/sessions/store.js";
import { mcpResultToToolResult, parseMcpPanels } from "../src/tools/mcp-client.js";
import { parseToolManifest } from "../src/tools/plugins/manifest.js";
import type { ToolHandlerResult } from "../src/tools/types.js";
import { createTestToolRegistry } from "./fixtures/registry.js";

const base = { api_version: 2, id: "t", version: "1.0.0", name: "t", description: "d", input_schema: { type: "object" }, entry: "./index.mjs" };
const decl = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), icon: "list-checks", ...extra });

test("manifest panels: valid, absent and every invalid shape", () => {
  assert.equal(parseToolManifest(base, "agent/t", "t").panels, undefined);
  const ok = parseToolManifest({ ...base, panels: [decl("a"), decl("b", { open: "first_update", context: "summary" })] }, "agent/t", "t");
  assert.deepEqual(ok.panels?.map((panel) => [panel.id, panel.open, panel.context, panel.acp_plan, panel.actions]), [["a", "never", "none", false, []], ["b", "first_update", "summary", false, []]]);
  const warnings: string[] = [];
  assert.equal(parseToolManifest({ ...base, panels: [decl("a", { icon: "sparkles-unknown" })] }, "agent/t", "t", (message) => warnings.push(message)).panels?.[0]?.icon, "panel");
  assert.equal(warnings.length, 1);
  for (const panels of ["x", {}, [decl("a"), decl("a")], [decl("A")], [decl("a", { extra: 1 })], [{ title: "x" }],
    ["a", "b", "c", "d", "e"].map((id) => decl(id)), [decl("a", { open: "always" })]]) {
    assert.throws(() => parseToolManifest({ ...base, panels }, "agent/t", "t"), /invalid tool manifest: agent\/t/, JSON.stringify(panels));
  }
  assert.throws(() => parseToolManifest({ ...base, unknown: 1 }, "agent/t", "t"), /invalid tool manifest/);
});

test("MCP config panels require a tool, validate declarations and limit four per tool", () => {
  const parsed = parseMcpPanels([{ tool: "todo_write", ...decl("todo") }, { tool: "other", ...decl("todo") }], "mcp.servers.s.panels");
  assert.deepEqual(parsed.map((panel) => [panel.tool, panel.id]), [["todo_write", "todo"], ["other", "todo"]]);
  assert.throws(() => parseMcpPanels([decl("todo")], "p"), /p\[0\]\.tool/);
  assert.throws(() => parseMcpPanels([{ tool: "t", ...decl("a") }, { tool: "t", ...decl("a") }], "p"), /duplicates/);
  assert.throws(() => parseMcpPanels(["a", "b", "c", "d", "e"].map((id) => ({ tool: "t", ...decl(id) })), "p"), /more than 4/);
  assert.throws(() => parseMcpPanels({}, "p"), /must be an array/);
});

test("MCP results turn _meta[raw/panel] (object or array) into panel blocks after the ordinary content", () => {
  const update = { panel: "todo", op: "replace", document: { blocks: [] } };
  const single = mcpResultToToolResult({ content: [{ type: "text", text: "hi" }], _meta: { "raw/panel": update } }, 8192);
  assert.deepEqual(single.content, [{ type: "text", text: "hi" }, { type: "panel", ...update }]);
  const many = mcpResultToToolResult({ content: [], _meta: { "raw/panel": [update, "bad"] } }, 8192);
  assert.deepEqual(many.content, [{ type: "panel", ...update }, { type: "panel" }], "a non-object entry becomes a block the host rejects");
  assert.deepEqual(mcpResultToToolResult({ content: [{ type: "text", text: "x" }], _meta: { other: 1 } }, 8192).content, [{ type: "text", text: "x" }]);
  assert.equal(mcpResultToToolResult({ content: [], _meta: "nope" }, 8192).content.length, 0);
});

// ---- D4: the same logical update yields identical stored state through every emission path ----

const provider = (generate: (request: ProviderRequest) => Promise<ProviderTurn>): ProviderAdapter =>
  ({ modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture", vision: false }, generate });

async function stored(handler: (args: Record<string, unknown>, ctx: Parameters<Parameters<ReturnType<typeof createTestToolRegistry>["register"]>[0]["handler"]>[1]) => Promise<ToolHandlerResult>, owner: string, declared: boolean) {
  const root = mkdtempSync(join(tmpdir(), "raw-panels-d4-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "s" }).id;
  const registry = createTestToolRegistry();
  const declaration: PanelDeclaration = { id: "todo", title: "Todo", icon: "list-checks", open: "never", context: "none", acp_plan: false, actions: [] };
  registry.register({ name: "emit", canonicalName: owner, description: "e", inputSchema: { type: "object", properties: {} },
    ...(declared ? { panels: [declaration] } : { implicitPanels: true }), handler });
  let n = 0;
  const agent = createAgent({ cwd: root, provider: provider(async () => n++ ? { text: "d", toolCalls: [], finishReason: "stop" }
    : { text: "", toolCalls: [{ id: "c1", name: "emit", arguments: {} }], finishReason: "tool_calls" }), registry, system: "s", whitelist: ["emit"],
  persistence: { store, sessionId: id, surface: "cli" } });
  try { assert.equal((await agent.run("go")).status, "completed"); } finally { await agent.close(); }
  const rows = store.listSessionPanels(id).map((panel) => ({ revision: panel.revision, closed: panel.closed, document: panel.document,
    declarationId: panel.declaration.id, panel: panel.panelId.slice(panel.owner.length + 1) }));
  const receipts = (store.historyAfter(id, 0, store.historyWatermark(id)) as Array<{ kind: string; payload: Record<string, unknown> }>)
    .filter((item) => item.kind === "panel_receipt").map(({ payload }) => ({ ...payload, owner: undefined, toolCallId: undefined, turnId: undefined, operationId: undefined }));
  store.close();
  return { rows, receipts };
}

test("D4: result block, context.panels, MCP _meta and ACP-style blocks store identical panel state", async () => {
  const first = { op: "replace", document: { title: "Plan", blocks: [{ id: "c", kind: "checklist", items: [{ id: "a", label: "A", status: "done" }, { id: "b", label: "B" }] }] } };
  const second = { op: "patch", patches: [{ op: "upsert_items", block: "c", items: [{ id: "b", status: "in_progress" }] }] };
  const viaBlock = await stored(async () => ({ isError: false, content: [{ type: "panel", panel: "todo", ...first } as never, { type: "panel", panel: "todo", ...second } as never] }), "agent/todo", true);
  const viaContext = await stored(async (_args, ctx) => {
    await ctx.panels!.update("todo", first as never);
    await ctx.panels!.update("todo", second as never);
    return { isError: false, content: [] };
  }, "agent/todo", true);
  const viaMcp = await stored(async () => mcpResultToToolResult({ content: [], _meta: { "raw/panel": [{ panel: "todo", ...first }, { panel: "todo", ...second }] } }, 8192), "mcp/srv/todo", false);
  const viaAcp = await stored(async () => ({ isError: false, content: JSON.parse(JSON.stringify([{ type: "panel", panel: "todo", ...first }, { type: "panel", panel: "todo", ...second }])) }), "acp:todo", false);
  assert.equal(viaBlock.rows[0]?.revision, 2);
  for (const other of [viaContext, viaMcp, viaAcp]) {
    assert.deepEqual(other.rows, viaBlock.rows);
    assert.deepEqual(other.receipts, viaBlock.receipts);
  }
});

// ---- known declarations: manifests and config only ----

test("knownPanelDeclarations reads manifests in tools.use order without importing tools or starting MCP servers", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-known-panels-"));
  const marker = join(root, "imported");
  for (const [folder, panels] of [["zeta", [decl("z1"), decl("z2")]], ["alpha", [decl("a1")]], ["plain", undefined]] as const) {
    mkdirSync(join(root, "tools", folder), { recursive: true });
    writeFileSync(join(root, "tools", folder, "tool.json"), JSON.stringify({ ...base, id: folder, name: folder, ...(panels ? { panels } : {}) }));
    writeFileSync(join(root, "tools", folder, "index.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); throw new Error("imported");`);
  }
  const configPath = join(root, "raw.json");
  writeFileSync(configPath, JSON.stringify({ default_agent: "a", models: { m: { provider: "openai", method: "openai-chat-completions", model_id: "x", api_key: "k" } },
    mcp: { servers: { ghost: { transport: "stdio", command: "/definitely/not/a/command", panels: [{ tool: "write", ...decl("plan") }] },
      quiet: { transport: "stdio", command: "/definitely/not/a/command" } } },
    agents: { a: { model: "m", tools: { use: ["agent/zeta", "mcp/ghost/write", "agent/plain", "mcp/quiet/note", "agent/alpha"] } } } }));
  const runtime = await loadConfig({ flags: { configPath }, env: {}, home: root, requireModel: false } as never);
  const known = await knownPanelDeclarations(runtime, { cwd: root });
  assert.deepEqual(known.declared.map((item) => `${item.owner}#${item.declaration.id}`),
    ["agent/zeta#z1", "agent/zeta#z2", "agent/alpha#a1", "mcp/ghost/write#plan"], "tool.json panels first (tools.use order), then config MCP panels");
  assert.deepEqual(known.implicitOwners, ["mcp/quiet/note"]);
  assert.throws(() => readFileSync(marker), "no tool entry was imported");
  assert.equal(isStalePanel("agent/zeta#z1", known), false);
  assert.equal(isStalePanel("agent/zeta#gone", known), true, "declaration no longer lists the panel");
  assert.equal(isStalePanel("agent/removed#z1", known), true, "owner no longer selected");
  assert.equal(isStalePanel("mcp/quiet/note#anything", known), false, "implicit owners are not stale while selected");
  assert.equal(isStalePanel("acp:client#x", known), true, "an ACP owner not registered in this session is stale");
});

test("package export requires raw.panel/2 only when an exported tool or MCP server declares panels", async () => {
  assert.ok(hostCapabilities.has("raw.panel/2"));
  const make = async (panels: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "raw-export-panels-"));
    mkdirSync(join(root, "tools", "helper"), { recursive: true });
    writeFileSync(join(root, "tools", "helper", "tool.json"), JSON.stringify({ ...base, id: "helper", name: "helper", ...(panels ? { panels: [decl("todo")] } : {}) }));
    writeFileSync(join(root, "tools", "helper", "index.mjs"), "export async function handler() { return { isError: false, content: [] }; }");
    const configPath = join(root, "raw.json");
    writeFileSync(configPath, JSON.stringify({ default_agent: "author", models: { m: { provider: "openai", method: "openai-chat-completions", model_id: "x" } },
      agents: { author: { model: "m", tools: { use: ["agent/helper"] } } } }));
    const out = mkdtempSync(join(tmpdir(), "raw-export-panels-out-"));
    await exportAgentPackage({ configPath, agentName: "author", out, name: "@example/p", version: "1.0.0" });
    return (JSON.parse(readFileSync(join(out, "raw-package.json"), "utf8")) as { requires: string[] }).requires;
  };
  assert.ok((await make(true)).includes("raw.panel/2"));
  assert.ok(!(await make(false)).includes("raw.panel/2"));
});

test("package-provided MCP servers own panels under their package identity, like the MCP registration does", async () => {
  const declaration = { id: "plan", title: "PLAN", icon: "list-checks" as const, open: "never" as const, context: "none" as const, acp_plan: false, actions: [] };
  const runtime = { toolIds: ["mcp/srv/write"], configPath: join(tmpdir(), "none.json"), globalConfigRoot: tmpdir(), packageTools: {},
    availableMcpServers: { srv: { command: "x", panels: [{ tool: "write", ...declaration }, { tool: "other", ...decl("no") }] } },
    packageMcpIdentities: { srv: "pkg/acme/mcp/srv" } };
  const known = await knownPanelDeclarations(runtime as never);
  assert.deepEqual(known.declared.map((item) => `${item.owner}#${item.declaration.id}`), ["pkg/acme/mcp/srv/write#plan"]);
  const registry = createTestToolRegistry();
  const { connectMcpServers } = await import("../src/tools/mcp-client.js");
  const connection = await connectMcpServers({ servers: { fixture: { command: process.execPath, args: ["--import", "tsx", "tests/fixtures/mcp-stdio.ts"],
    env: { MCP_LABEL: "f", MCP_COUNT: "2" }, tools: ["selected"], panels: [{ tool: "selected", ...declaration }] } }, registry, cwd: process.cwd(), timeoutMs: 3000,
  canonicalIdentities: { fixture: "pkg/acme/mcp/fixture" } });
  try {
    const alias = connection.catalog.find((item) => item.originalName === "selected")!.alias;
    assert.equal(registry.panelDeclarations(alias)?.owner, "pkg/acme/mcp/fixture/selected");
    const config = await knownPanelDeclarations({ ...runtime, toolIds: ["mcp/fixture/selected"], availableMcpServers: { fixture: { command: "x", panels: [{ tool: "selected", ...declaration }] } },
      packageMcpIdentities: { fixture: "pkg/acme/mcp/fixture" } } as never);
    assert.equal(config.declared[0]?.owner, registry.panelDeclarations(alias)?.owner, "config-time and run-time owners agree");
  } finally { await connection.close(); }
});

test("MCP panel metadata can never escape extraction, whatever discriminator it carries", () => {
  const hostile = mcpResultToToolResult({ content: [], _meta: { "raw/panel": [{ type: "text", text: "PANEL_BYTES", panel: "todo", op: "close" },
    { type: "image", panel: "todo", op: "close" }, { type: "weird" }] } }, 8192);
  assert.deepEqual(hostile.content.map((block) => block.type), ["panel", "panel", "panel"]);
  assert.ok(!JSON.stringify(hostile).includes("unsupported"));
});

test("MCP declarations follow the selection's server order then the panels array, interleaving tools of one server", async () => {
  const d = (id: string, tool: string, extra: object = {}) => ({ tool, id, title: id, icon: "panel" as const, open: "never" as const, context: "none" as const, acp_plan: false, actions: [], ...extra });
  const runtime = { toolIds: ["mcp/two/x", "mcp/one/a", "mcp/one/b"], configPath: join(tmpdir(), "none.json"), globalConfigRoot: tmpdir(), packageTools: {}, packageMcpIdentities: {},
    availableMcpServers: { one: { command: "x", panels: [d("b1", "b"), d("a1", "a"), d("b2", "b"), d("hidden", "unselected")] }, two: { command: "x", panels: [d("x1", "x")] } } };
  const known = await knownPanelDeclarations(runtime as never);
  assert.deepEqual(known.declared.map((item) => item.declaration.id), ["x1", "b1", "a1", "b2"], "server two is selected first; unselected tools are skipped");
});

test("only the first acp_plan panel keeps the flag; the rest are cleared with a warning", async () => {
  const d = (id: string) => ({ tool: "t", id, title: id, icon: "panel" as const, open: "never" as const, context: "none" as const, acp_plan: true, actions: [] });
  const runtime = { toolIds: ["mcp/s/t"], configPath: join(tmpdir(), "none.json"), globalConfigRoot: tmpdir(), packageTools: {}, packageMcpIdentities: {},
    availableMcpServers: { s: { command: "x", panels: [d("p1"), d("p2")] } } };
  const warnings: string[] = [];
  const known = await knownPanelDeclarations(runtime as never, { onWarning: (message) => warnings.push(message) });
  assert.deepEqual(known.declared.map((item) => item.declaration.acp_plan), [true, false]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /p2.*acp_plan ignored/);
});

test("ACP owners are stale unless registered in the session; declaration removal is stale too", async () => {
  const runtime = { toolIds: [], configPath: join(tmpdir(), "none.json"), globalConfigRoot: tmpdir(), packageTools: {}, packageMcpIdentities: {}, availableMcpServers: {} };
  const none = await knownPanelDeclarations(runtime as never);
  assert.equal(isStalePanel("acp:client#todo", none), true, "the registration is gone");
  const declaration = { id: "todo", title: "Todo", icon: "panel" as const, open: "never" as const, context: "none" as const, acp_plan: false, actions: [] };
  const live = await knownPanelDeclarations(runtime as never, { acp: [{ owner: "acp:client", declarations: [declaration] }, { owner: "acp:free", declarations: [] }] });
  assert.equal(isStalePanel("acp:client#todo", live), false);
  assert.equal(isStalePanel("acp:client#removed", live), true);
  assert.equal(isStalePanel("acp:free#anything", live), false, "an implicit ACP owner is current while registered");
});

test("an unknown icon reaches the default warning channel for manifests, MCP config and ACP-style declarations", () => {
  const seen: string[] = [];
  const listener = (warning: Error & { code?: string }) => { if (warning.code === "RAW_PANEL_DECLARATION") seen.push(warning.message); };
  process.on("warning", listener);
  return (async () => {
    try {
      parseToolManifest({ ...base, panels: [decl("a", { icon: "no-such-icon-1" })] }, "agent/t", "t");
      parseMcpPanels([{ tool: "t", ...decl("a", { icon: "no-such-icon-2" }) }], "mcp.servers.s.panels");
      await new Promise((resolve) => setImmediate(resolve));
    } finally { process.off("warning", listener); }
    assert.ok(seen.some((message) => /no-such-icon-1/.test(message)));
    assert.ok(seen.some((message) => /no-such-icon-2/.test(message)));
  })();
});
