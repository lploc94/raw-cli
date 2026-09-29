import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionOperation } from "../src/sessions/operations.js";
import type { SessionSummary } from "../src/sessions/store.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

const reply = (text = "ok") => ({ frames: [openAiFrame({ content: text }, "stop"), openAiDone] });
type Fixture = Awaited<ReturnType<typeof dashboardFixture>>;
const session = (f: Fixture) => f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
const turn = async (f: Fixture, id: string, body: Record<string, unknown>) => {
  const response = await f.api(`/sessions/${id}/operations`, "POST", { kind: "turn", agent: "raw", ...body });
  return { status: response.status, body: await response.json() as SessionOperation & { error?: { code: string; message?: string } } };
};
const wire = (f: Fixture, index = -1) => f.provider.requests.at(index)!.body as Record<string, unknown>;

test("composer metadata describes controls per configured provider", async () => {
  const openai = await dashboardFixture({ agent: { request: { reasoning_effort: "low", service_tier: "flex" } } });
  const generic = await dashboardFixture({ model: { provider: "ollama" } });
  const deepseek = await dashboardFixture({ model: { provider: "deepseek" } });
  try {
    const meta = await openai.json<any>("/agents/raw/composer");
    assert.deepEqual(meta.controls.map((c: any) => [c.id, c.label, c.kind, c.current]), [["effort", "Reasoning", "level", "low"], ["serviceTier", "Service tier", "choice", "flex"]]);
    assert.deepEqual(meta.controls[1].options.map((o: any) => o.value), ["auto", "default", "flex", "fast", "priority"]);
    assert.deepEqual((await generic.json<any>("/agents/raw/composer")).controls, []);
    const ds = (await deepseek.json<any>("/agents/raw/composer")).controls;
    assert.deepEqual(ds.map((c: any) => [c.id, c.label]), [["effort", "Reasoning"]]);
    assert.equal(ds[0].current, undefined);
  } finally { await openai.close(); await generic.close(); await deepseek.close(); }
});

test("a turn override reaches only that provider request; config bytes and the next turn are untouched", async () => {
  const f = await dashboardFixture({ agent: { request: { reasoning_effort: "low", service_tier: "default" } }, responses: [reply(), reply(), reply(), reply()] });
  try {
    const { id } = await session(f);
    const before = readFileSync(f.configPath);
    const cases: Array<[Record<string, string>, Record<string, string>]> = [
      [{ effort: "xhigh", serviceTier: "priority" }, { reasoning_effort: "xhigh", service_tier: "priority" }],
      [{ effort: "none" }, { reasoning_effort: "none", service_tier: "default" }],
      [{ serviceTier: "flex" }, { reasoning_effort: "low", service_tier: "flex" }],
    ];
    let n = 0; const overridden: string[] = [];
    for (const [request, expected] of cases) {
      const sent = await turn(f, id, { clientRequestId: `o${n++}`, input: "hi", request });
      assert.equal(sent.status, 202, JSON.stringify(sent.body)); overridden.push(sent.body.id);
      assert.equal((await f.wait(sent.body.id)).state, "completed");
      const body = wire(f);
      assert.equal(body.reasoning_effort, expected.reasoning_effort);
      assert.equal(body.service_tier, expected.service_tier);
    }
    const plain = await turn(f, id, { clientRequestId: "plain", input: "again" });
    assert.equal((await f.wait(plain.body.id)).state, "completed");
    assert.equal(wire(f).reasoning_effort, "low", "no sticky override");
    assert.equal(wire(f).service_tier, "default");
    assert.deepEqual(readFileSync(f.configPath), before, "config bytes are never modified");
    for (const opId of overridden) {
      const receipt = JSON.stringify(f.server.context.store!.getOperation(opId));
      assert.ok(!/xhigh|priority|flex|"request"|serviceTier|effort/.test(receipt), "override is never persisted on receipts");
    }
  } finally { await f.close(); }
});

test("an invalid override is refused before acceptance; compact refuses it; providers without controls refuse it", async () => {
  const f = await dashboardFixture({ responses: [reply()] });
  const generic = await dashboardFixture({ model: { provider: "ollama" } });
  try {
    const { id } = await session(f);
    let n = 0;
    for (const request of [{ effort: "ultra" }, { effort: 3 }, { serviceTier: "standard_only" }, { reasoning_effort: "low" }, "high", null, []]) {
      const refused = await turn(f, id, { clientRequestId: `bad${n++}`, input: "x", request });
      assert.equal(refused.status, 422, JSON.stringify(request));
      assert.equal((refused.body as any).error.code, "invalid_request_option");
    }
    assert.equal(f.server.context.store!.listOperations(id).length, 0, "nothing accepted");
    assert.equal(f.provider.requests.length, 0);
    const compact = await f.api(`/sessions/${id}/operations`, "POST", { kind: "compact", agent: "raw", clientRequestId: "c", request: { effort: "low" } });
    assert.equal(compact.status, 400);
    const other = await session(generic);
    const refusedGeneric = await turn(generic, other.id, { clientRequestId: "g", input: "x", request: { effort: "low" } });
    assert.equal(refusedGeneric.status, 422);
    assert.equal((await turn(generic, other.id, { clientRequestId: "g2", input: "x", request: {} })).status, 202, "an empty object is a no-op");
  } finally { await f.close(); await generic.close(); }
});

test("a replayed clientRequestId returns the original receipt before its override is validated", async () => {
  const f = await dashboardFixture({ responses: [reply(), reply()] });
  try {
    const { id } = await session(f);
    const first = await turn(f, id, { clientRequestId: "same", input: "hi", request: { effort: "high" } });
    assert.equal((await f.wait(first.body.id)).state, "completed");
    const replay = await turn(f, id, { clientRequestId: "same", input: "hi", request: { effort: "ultra" } });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.id, first.body.id);
    const other = await turn(f, id, { clientRequestId: "same", input: "hi", request: { effort: "low", serviceTier: "flex" } });
    assert.equal(other.body.id, first.body.id);
    assert.equal(f.provider.requests.length, 1, "no second provider request");
  } finally { await f.close(); }
});

test("a provider rejection of the chosen value fails only that turn and the session continues", async () => {
  const f = await dashboardFixture({ responses: [{ status: 400, body: { error: { message: "unsupported tier xyz" } } }, reply("fine")] });
  try {
    const { id } = await session(f);
    const bad = await turn(f, id, { clientRequestId: "r1", input: "hi", request: { serviceTier: "priority" } });
    assert.equal(bad.status, 202);
    const done = await f.wait(bad.body.id);
    assert.equal(done.state, "error");
    assert.match(JSON.stringify(done), /unsupported tier xyz/);
    assert.equal(wire(f, 0).service_tier, "priority");
    const good = await turn(f, id, { clientRequestId: "r2", input: "again" });
    assert.equal((await f.wait(good.body.id)).state, "completed");
    assert.equal(wire(f).service_tier, undefined, "the next turn returns to the agent default");
  } finally { await f.close(); }
});
