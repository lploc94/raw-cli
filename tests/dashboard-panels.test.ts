import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import type { PanelStackItem } from "../src/panels/stack.js";
import type { SessionSnapshot } from "../src/dashboard/sessions.js";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSummary } from "../src/sessions/store.js";
import { buildPanelStack, declarationsFor, loadDeclarationsForSaved } from "../src/panels/stack.js";
import { SessionStreams } from "../src/dashboard/streams.js";
import { dashboardFixture, eventStream } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

const todoCall = (id: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function",
  function: { name: "todo", arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const answer = { frames: [openAiFrame({ content: "done" }, "stop"), openAiDone] };

async function runTurn(f: Awaited<ReturnType<typeof dashboardFixture>>, sessionId: string, key: string) {
  const op = await f.json<SessionOperation>(`/sessions/${sessionId}/operations`, "POST", { clientRequestId: key, kind: "turn", agent: "raw", input: "go" });
  assert.equal((await f.wait(op.id)).state, "completed");
}

test("panel routes list declared panels before any data, then the committed document, in default order", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/todo"] } }, responses: [
    todoCall("c1", { title: "Ship", todos: [{ content: "Write tests", status: "in_progress" }, { content: "Docs", status: "pending" }] }), answer] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const empty = await f.json<{ agent: string; items: PanelStackItem[] }>(`/sessions/${session.id}/panels`);
    assert.equal(empty.agent, "raw");
    assert.equal(empty.items.length, 1);
    assert.deepEqual([empty.items[0]!.panel, empty.items[0]!.owner, empty.items[0]!.title, empty.items[0]!.icon, empty.items[0]!.revision,
      empty.items[0]!.updatedAt, empty.items[0]!.closed, empty.items[0]!.stale, empty.items[0]!.document],
    ["builtin/todo#todo", "builtin/todo", "Todo", "list-checks", 0, null, false, false, null]);
    assert.equal(empty.items[0]!.declaration.actions.length, 5);
    await runTurn(f, session.id, "t1");
    const filled = await f.json<{ agent: string; items: PanelStackItem[] }>(`/sessions/${session.id}/panels`);
    const item = filled.items[0]!;
    assert.equal(item.revision, 1);
    assert.equal(typeof item.updatedAt, "number");
    assert.equal(item.document?.title, "Ship");
    assert.equal(item.stale, false);
    const one = await f.json<PanelStackItem>(`/sessions/${session.id}/panels/${encodeURIComponent("builtin/todo#todo")}`);
    assert.deepEqual(one, item);
    const missing = await f.api(`/sessions/${session.id}/panels/${encodeURIComponent("builtin/todo#nope")}`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code?: string; error?: { code: string } }).error?.code ?? "unknown_panel", "unknown_panel");
    const snapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(snapshot.agent, "raw");
    assert.deepEqual(snapshot.panels, filled.items);
  } finally { await f.close(); }
});

test("?agent= recomputes stale flags and order against that agent; unknown agents are 422", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/todo"] } }, extraAgents: { bare: { model: "fixture", tools: { use: [] } } },
    responses: [todoCall("c1", { todos: [{ content: "a", status: "pending" }] }), answer] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    await runTurn(f, session.id, "t1");
    const own = await f.json<{ items: PanelStackItem[] }>(`/sessions/${session.id}/panels`);
    assert.equal(own.items[0]!.stale, false);
    const bare = await f.json<{ agent: string; items: PanelStackItem[] }>(`/sessions/${session.id}/panels?agent=bare`);
    assert.equal(bare.agent, "bare");
    assert.equal(bare.items.length, 1, "a stale panel that still holds data stays in the stack");
    assert.equal(bare.items[0]!.stale, true);
    assert.equal(bare.items[0]!.document !== null, true);
    const unknown = await f.api(`/sessions/${session.id}/panels?agent=ghost`);
    assert.equal(unknown.status, 422);
    assert.match(JSON.stringify(await unknown.json()), /unknown_agent/);
    assert.equal((await f.api(`/sessions/nope/panels`)).status, 404);
  } finally { await f.close(); }
});

test("a saved agent that no longer exists degrades: stored panels stay listed, none is marked stale", async () => {
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/todo"] } }, responses: [todoCall("c1", { todos: [{ content: "a", status: "pending" }] }), answer] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    await runTurn(f, session.id, "t1");
    writeFileSync(f.configPath, JSON.stringify({ ...f.config, default_agent: "other", agents: { other: { model: "fixture", tools: { use: [] } } } }));
    const degraded = await f.json<{ items: PanelStackItem[] }>(`/sessions/${session.id}/panels`);
    assert.equal(degraded.items.length, 1);
    assert.equal(degraded.items[0]!.stale, false);
  } finally { await f.close(); }
});

test("stack order: declared, then implicit by creation, then stale by creation", () => {
  const declaration = (id: string) => ({ id, title: id, icon: "panel" as const, open: "never" as const, context: "none" as const, acp_plan: false, actions: [] });
  const stored = (owner: string, id: string, createdAt: number) => ({ panelId: `${owner}#${id}`, owner, revision: 1, createdAt, updatedAt: createdAt + 10,
    closed: false, declaration: declaration(id), document: { blocks: [] } });
  const known = { declared: [{ owner: "a", declaration: declaration("second") }, { owner: "a", declaration: declaration("first") }, { owner: "b", declaration: declaration("empty") }],
    implicitOwners: ["mcp"] };
  const items = buildPanelStack(known, [stored("gone", "old", 1), stored("mcp", "late", 30), stored("a", "first", 5), stored("mcp", "early", 20), stored("gone", "older", 0)]);
  assert.deepEqual(items.map((item) => `${item.panel}${item.stale ? "!" : ""}${item.document ? "" : "?"}`),
    ["a#second?", "a#first", "b#empty?", "mcp#early", "mcp#late", "gone#older!", "gone#old!"]);
  assert.deepEqual(buildPanelStack(undefined, [stored("x", "b", 2), stored("x", "a", 1)]).map((item) => [item.panel, item.stale]), [["x#a", false], ["x#b", false]]);
});

test("the session stream carries panel frames: coalesced with the last state kept, and snapshots carry agent and panels", async () => {
  // Ten updates inside one tool call are a burst from the tool's point of view; the stream must send few frames and end on the last state.
  const updates = Array.from({ length: 10 }, (_, n) => ({ mode: "merge", todos: [{ id: "a", content: `step ${n}`, status: "pending" }] }));
  const f = await dashboardFixture({ agent: { tools: { use: ["builtin/todo"] } }, responses: [
    todoCall("c0", { todos: [{ id: "a", content: "start", status: "pending" }] }), ...updates.map((args, n) => todoCall(`c${n + 1}`, args)), answer] });
  try {
    const session = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    const stream = await eventStream(f.server, session.id);
    const snapshot = await stream.next();
    assert.equal(snapshot.type, "snapshot");
    assert.equal(snapshot.data.agent, "raw");
    assert.deepEqual(snapshot.data.panels, [(await f.json<{ items: PanelStackItem[] }>(`/sessions/${session.id}/panels`)).items[0]]);
    const op = await f.json<SessionOperation>(`/sessions/${session.id}/operations`, "POST", { clientRequestId: "burst", kind: "turn", agent: "raw", input: "go" });
    const frames: Array<{ revision: number; live: boolean; document: { blocks: Array<{ items: Array<{ label: string }> }> }; sequence: number }> = [];
    let done = false;
    const started = Date.now();
    while (!done && Date.now() - started < 20000) {
      const event = await stream.next();
      if (event.type === "panel") frames.push({ ...(event.data as object), sequence: event.sequence } as never);
      if (event.type === "operation" && (event.data as { state: string }).state === "completed") done = true;
    }
    assert.ok(done);
    await new Promise((resolve) => setTimeout(resolve, 400));
    while (true) {
      const next = await Promise.race([stream.next(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 300))]);
      if (!next) break;
      if (next.type === "panel") frames.push({ ...(next.data as object), sequence: next.sequence } as never);
    }
    assert.ok(frames.length >= 1);
    const elapsed = Date.now() - started;
    assert.ok(frames.length <= Math.ceil(elapsed / 250) + 2, `${frames.length} frames in ${elapsed} ms exceed 4 per second`);
    const last = frames.at(-1)!;
    assert.equal(last.revision, 11, "the newest committed revision is delivered, a throttle that drops the tail would end earlier");
    assert.equal(last.document.blocks[0]!.items[0]!.label, "step 9");
    for (let index = 1; index < frames.length; index++) assert.ok(frames[index]!.revision >= frames[index - 1]!.revision, "frames never go backwards");
    const finalSnapshot = await f.json<SessionSnapshot>(`/sessions/${session.id}`);
    assert.equal(finalSnapshot.panels[0]!.revision, 11);
    const reset = await eventStream(f.server, session.id, "expired:cursor:1");
    const resetFrame = await reset.next();
    assert.equal(resetFrame.type, "reset");
    assert.equal((resetFrame.data.panels as PanelStackItem[])[0]!.revision, 11);
    assert.equal(resetFrame.data.agent, "raw");
    reset.close(); stream.close();
  } finally { await f.close(); }
});

test("declarations are only used for the agent they were read for, even when the saved agent switches while loading", async () => {
  const declaration = { id: "p", title: "P", icon: "panel" as const, open: "never" as const, context: "none" as const, acp_plan: false, actions: [] };
  const knownFor = (owner: string) => ({ declared: [{ owner, declaration }], implicitOwners: [] });
  let saved: string | undefined = "A";
  const loads: string[] = [];
  const loaded = await loadDeclarationsForSaved(() => saved, async (agent) => {
    loads.push(agent);
    const result = knownFor(`owner-${agent}`);
    if (agent === "A") saved = "B"; // the user switches agents while A's declarations are being read
    return result;
  });
  assert.deepEqual(loads, ["A", "B"], "the stale read is discarded and repeated for the new saved agent");
  assert.equal(loaded.agent, "B");
  assert.equal(loaded.known?.declared[0]?.owner, "owner-B");
  let flapping = 0;
  const unstable = await loadDeclarationsForSaved(() => (flapping % 2 ? "X" : "Y"), async () => { flapping++; return knownFor("z"); });
  assert.equal(unstable.known, undefined, "an agent that never settles degrades instead of mixing agents");
  assert.equal(declarationsFor("B", loaded)?.declared[0]?.owner, "owner-B");
  assert.equal(declarationsFor("A", loaded), undefined, "a snapshot for another agent never reuses them");
  assert.equal(declarationsFor("A", undefined), undefined);
});

test("the per-panel coalescing table only keeps panels that are active right now", async () => {
  const context = { instanceId: "i", store: { historyWatermark: () => 0, sessionIsBusy: () => false, historyAfter: () => [] },
    operations: { activeIds: () => [], toolIdentity: () => undefined } };
  const streams = new SessionStreams(context as never, { removeSegment() {} } as never, () => ({}) as never, async () => ({ agent: undefined, known: undefined }));
  const table = () => (streams as unknown as { panelFrames: Map<string, unknown> }).panelFrames;
  const push = (session: string, revision: number) => streams.observe({ type: "event", sessionId: session, operationId: "op", event: {
    type: "panel_update", panel: "p", owner: "o", revision, closed: false, live: false, document: { blocks: [] } } } as never);
  try {
    for (let n = 0; n < 200; n++) push(`s${n}`, 1);
    assert.equal(table().size, 200, "every panel updated inside its window is tracked");
    await new Promise((resolve) => setTimeout(resolve, 300));
    push("fresh", 1);
    assert.ok(table().size <= 2, `idle entries were dropped, ${table().size} remain`);
    push("fresh", 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(table().size <= 2, "the table stays small after a waiting state has been flushed");
  } finally { streams.close(); }
});
