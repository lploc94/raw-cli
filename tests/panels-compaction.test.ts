import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../src/agent.js";
import { compactSession } from "../src/compact.js";
import type { ProviderAdapter, ProviderRequest, ProviderTurn } from "../src/llm/types.js";
import type { PanelDeclaration, StoredPanel } from "../src/panels/contract.js";
import { panelReminders } from "../src/panels/render.js";
import { openSessionStore } from "../src/sessions/store.js";
import { createTestToolRegistry } from "./fixtures/registry.js";

const decl = (id: string, context: "none" | "summary"): PanelDeclaration =>
  ({ id, title: id.toUpperCase(), icon: "list-checks", open: "never", context, acp_plan: false, actions: [] });
const provider = (generate: (request: ProviderRequest) => Promise<ProviderTurn>): ProviderAdapter =>
  ({ modelConfig: { agentName: "test", provider: "ollama", method: "openai-chat-completions", model: "fixture", vision: false }, generate });
const markdown = (text: string, extra: object = {}) => ({ op: "replace", document: { blocks: [{ id: "m", kind: "markdown", text }], ...extra } });

/** One tool per panel; each call publishes the text given in its arguments. */
function setup(panels: Array<[string, "none" | "summary"]>) {
  const root = mkdtempSync(join(tmpdir(), "raw-panels-compact-"));
  const store = openSessionStore({ env: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: root } });
  const id = store.createSession({ cwd: root, title: "session" }).id;
  const registry = createTestToolRegistry();
  for (const [name, context] of panels) {
    registry.register({ name, description: name, inputSchema: { type: "object", properties: { text: { type: "string" }, summary: { type: "string" }, title: { type: "string" }, close: { type: "boolean" } } }, panels: [decl(name, context)],
      handler: async (args) => ({ isError: false, content: [args.close ? { type: "panel", panel: name, op: "close" } as never : { type: "panel", panel: name, ...markdown(String(args.text ?? ""), { ...(typeof args.summary === "string" ? { context_summary: args.summary } : {}), ...(typeof args.title === "string" ? { title: args.title } : {}) }) } as never] }) });
  }
  const requests: ProviderRequest[] = [];
  const script: Array<Array<{ id: string; name: string; arguments: Record<string, unknown> }>> = [];
  let calls = 0;
  const main = provider(async (request) => {
    requests.push({ messages: structuredClone(request.messages), tools: request.tools, system: request.system, cacheKey: request.cacheKey } as ProviderRequest);
    const next = request.messages.at(-1)?.role === "tool" ? undefined : script.shift();
    return next ? { text: "", toolCalls: next.map((call) => ({ ...call, id: `${call.id}-${++calls}` })), finishReason: "tool_calls" } : { text: `ok ${"x".repeat(300)}`, toolCalls: [], finishReason: "stop" };
  });
  const agent = createAgent({ cwd: root, provider: main, registry, system: "s", whitelist: panels.map(([name]) => name), autoApprove: true, persistence: { store, sessionId: id, surface: "cli" } });
  const turn = (label: string, ...tools: Array<[string, Record<string, unknown>]>) => {
    if (tools.length) script.push(tools.map(([name, args], index) => ({ id: `${label}${index}`, name, arguments: args })));
    return agent.run(`${label} ${"y".repeat(400)}`);
  };
  const summarizer = provider(async () => ({ text: "Objective: keep going.", toolCalls: [], finishReason: "stop" }));
  const compact = () => compactSession(agent, { provider: summarizer, keepRecentTurns: 1, maxOutputTokens: 100 });
  const reminders = () => agent.transcript.flatMap((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Raw panel state]\n") ? [message.content] : []);
  return { agent, store, id, requests, turn, compact, reminders, close: async () => { await agent.close(); store.close(); } };
}

test("compaction appends one reminder per open summary panel, newest first, and none for context none", async () => {
  const s = setup([["alpha", "summary"], ["beta", "none"], ["gamma", "summary"]]);
  try {
    await s.turn("t1", ["alpha", { text: "alpha body", summary: "alpha summary text" }]);
    await s.turn("t2", ["beta", { text: "beta body" }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.turn("t3", ["gamma", { text: "gamma body" }]);
    await s.turn("t4");
    assert.deepEqual(s.reminders(), [], "a normal turn never carries a reminder");
    assert.ok(!s.requests.some((request) => JSON.stringify(request.messages).includes("Raw panel state")), "no request before a compaction mentions panel state");
    assert.equal(new Set(s.requests.map((request) => request.cacheKey)).size, 1, "the cache key never changes on normal turns");
    assert.equal((await s.compact()).status, "compacted");
    const found = s.reminders();
    assert.equal(found.length, 2);
    assert.match(found[0]!, /^\[Raw panel state\]\nCurrent state of GAMMA \(gamma\) at revision 1:\nGAMMA\ngamma body/, "the panel updated most recently comes first, rendered from the document");
    assert.equal(found[1], "[Raw panel state]\nCurrent state of ALPHA (alpha) at revision 1:\nalpha summary text", "context_summary is used verbatim");
    assert.ok(!found.some((text) => text.includes("BETA")));
    // Durable: the next request carries them after the summary.
    await s.turn("t5");
    const sent = s.requests.at(-1)!.messages.filter((message) => message.role === "user").map((message) => String(message.content));
    assert.ok(sent.some((text) => text.startsWith("[Raw panel state]\nCurrent state of GAMMA")));
  } finally { await s.close(); }
});

test("a closed panel gets no reminder, and a second compaction replaces the first one's reminders instead of stacking them", async () => {
  const s = setup([["alpha", "summary"], ["beta", "summary"]]);
  try {
    await s.turn("t1", ["alpha", { text: "first" }], ["beta", { text: "beta" }]);
    await s.turn("t1b", ["beta", { close: true }]);
    await s.turn("t2");
    await s.turn("t3");
    assert.equal((await s.compact()).status, "compacted");
    assert.equal(s.reminders().length, 1, "the closed panel has no reminder");
    assert.match(s.reminders()[0]!, /ALPHA/);
    await s.turn("t4", ["alpha", { text: "second" }]);
    await s.turn("t5");
    await s.turn("t6");
    assert.equal((await s.compact()).status, "compacted");
    const found = s.reminders();
    assert.equal(found.length, 1, "no stale copy is left behind");
    assert.match(found[0]!, /at revision 2:\nALPHA\nsecond/);
  } finally { await s.close(); }
});

test("reminder caps are byte caps: 2 KiB per body and 8 KiB together, cut with an ellipsis, multibyte-safe", async () => {
  const names = ["p1", "p2", "p3", "p4", "p5", "p6"] as Array<string>;
  const s = setup(names.map((name) => [name, "summary"] as [string, "summary"]));
  try {
    // 3-byte characters: a character-based cut at 2048 would produce 6 KiB.
    for (const [index, name] of names.entries()) {
      await s.turn(`t${index}`, [name, { text: "語".repeat(4000) }]);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await s.turn("last");
    assert.equal((await s.compact()).status, "compacted");
    const found = s.reminders();
    for (const text of found) {
      const body = text.slice(text.indexOf(":\n") + 2);
      assert.ok(Buffer.byteLength(body) <= 2048, `body is ${Buffer.byteLength(body)} bytes`);
      assert.ok(body.endsWith("…"));
      assert.doesNotMatch(body, /�/);
    }
    assert.ok(found.length >= 3 && found.length < 6, `the total cap leaves out the oldest panels (${found.length})`);
    assert.ok(found.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= 8 * 1024);
    assert.match(found[0]!, /^\[Raw panel state\]\nCurrent state of P6 /, "newest first");
  } finally { await s.close(); }
});

test("without a qualifying panel compaction adds nothing", async () => {
  const s = setup([["beta", "none"]]);
  try {
    await s.turn("t1", ["beta", { text: "x" }]);
    await s.turn("t2");
    await s.turn("t3");
    assert.equal((await s.compact()).status, "compacted");
    assert.deepEqual(s.reminders(), []);
  } finally { await s.close(); }
});

test("replacement recognises every valid title (empty, multiline) and never removes a genuine user message that merely resembles a reminder", async () => {
  const s = setup([["alpha", "summary"]]);
  try {
    await s.turn("t1", ["alpha", { text: "one", summary: "s1", title: "multi\nline title" }]);
    await s.turn("t2");
    await s.turn("t3");
    assert.equal((await s.compact()).status, "compacted");
    assert.equal(s.reminders().length, 1);
    assert.match(s.reminders()[0]!, /^\[Raw panel state\]\nCurrent state of multi\nline title /);
    await s.turn("Current state of X (y) at revision 9:\nthis is my own message");
    await s.turn("t5", ["alpha", { text: "two", summary: "s2", title: "" }]);
    await s.turn("t6");
    assert.equal((await s.compact()).status, "compacted");
    assert.equal(s.reminders().length, 1, "the earlier reminder was replaced");
    assert.match(JSON.stringify(s.agent.transcript) + JSON.stringify(s.requests.at(-1)!.messages), /this is my own message/);
  } finally { await s.close(); }
});

test("the total cap never cuts a reminder's header: one that no longer fits is left out, one with little room keeps its header and a cut body", () => {
  const panel = (id: string, owner: string, updatedAt: number, summary: string): StoredPanel => ({ panelId: `${owner}#${id}`, owner, revision: 3, createdAt: 1, updatedAt, closed: false,
    declaration: decl(id, "summary"), document: { title: id.toUpperCase(), context_summary: summary, blocks: [] } });
  const long = "x".repeat(5000);
  const head = (owner: string, id: string) => Buffer.byteLength(`[Raw panel state]\nCurrent state of ${id.toUpperCase()} (${owner}) at revision 3:\n`);
  // Three full 2 KiB reminders leave 8192 - 3 * (2048 + header) bytes; the fourth panel's owner makes its header larger than that.
  const left = 8192 - 3 * (2048 + head("o", "p1"));
  assert.ok(left > 100 && left < 2048);
  const wide = "w".repeat(left);
  const found = panelReminders([panel("p1", "o", 40, long), panel("p2", "o", 30, long), panel("p3", "o", 20, long), panel("p4", wide, 10, long)]);
  assert.equal(found.length, 3, "the fourth header does not fit, so the panel is omitted");
  for (const text of found) assert.match(text, /^\[Raw panel state\]\nCurrent state of P\d \(o\) at revision 3:\n/);
  // A panel whose header fits with little room to spare keeps the whole header and gets a cut body.
  const snug = "w".repeat(left - head("", "p4") - 30);
  const tight = panelReminders([panel("p1", "o", 40, long), panel("p2", "o", 30, long), panel("p3", "o", 20, long), panel("p4", snug, 10, long)]);
  assert.equal(tight.length, 4);
  assert.ok(tight[3]!.startsWith(`[Raw panel state]\nCurrent state of P4 (${snug}) at revision 3:\n`), "the header is whole");
  assert.ok(tight[3]!.endsWith("…"));
  assert.ok(tight.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= 8192);
});
