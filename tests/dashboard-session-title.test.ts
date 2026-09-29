import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../src/sessions/store.js";
import { dashboardFixture } from "./fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "./fixtures/mock-provider.js";

const reply = { frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] };

test("a dashboard chat is titled from its first message, and a later message or a rename never changes it", async () => {
  const f = await dashboardFixture({ responses: [reply, reply, reply] });
  try {
    const { id, title } = await f.json<SessionSummary>("/sessions", "POST", { cwd: f.root });
    assert.equal(title, "New chat");
    const send = async (clientRequestId: string, input: string) => {
      const op = await f.json<{ id: string }>(`/sessions/${id}/operations`, "POST", { clientRequestId, kind: "turn", agent: "raw", input });
      await f.wait(op.id);
    };
    await send("one", "  Explain how\n  the session store works, in detail  ");
    assert.equal((await f.json<{ session: SessionSummary }>(`/sessions/${id}`)).session.title, "Explain how the session store works, in detail");
    await send("two", "a different second message");
    assert.equal((await f.json<{ session: SessionSummary }>(`/sessions/${id}`)).session.title, "Explain how the session store works, in detail");
    await f.json(`/sessions/${id}`, "PATCH", { title: "Mine" });
    await send("three", "third message");
    assert.equal((await f.json<{ session: SessionSummary }>(`/sessions/${id}`)).session.title, "Mine");
  } finally { await f.close(); }
});
