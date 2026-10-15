import assert from "node:assert/strict";
import { test } from "node:test";
import type { Approval } from "../src/dashboard/approvals.js";
import { answerApproval } from "../web/src/approvals.js";

/** One pending approval, with only the identity fields an answer sends. */
const pending = (id: string, operationId: string, callId: string) => ({ id, operationId, callId }) as Approval;

/** Runs `body` with `fetch` replaced, restoring it even when the body throws. */
async function withFetch(handler: typeof fetch, body: () => Promise<void>): Promise<Array<{ url: string; init: RequestInit }>> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(url as string, init);
  }) as typeof fetch;
  try { await body(); } finally { globalThis.fetch = original; }
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("answering an approval posts the call identity and the answer", async () => {
  const calls = await withFetch(() => Promise.resolve(json({ answered: true })), () => answerApproval(pending("approval-1", "op-1", "call-1"), true));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/permissions/approval-1");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { operationId: "op-1", callId: "call-1", allow: true });
});

test("a denied answer sends allow false", async () => {
  const calls = await withFetch(() => Promise.resolve(json({ answered: true })), () => answerApproval(pending("approval-2", "op-2", "call-2"), false));

  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { operationId: "op-2", callId: "call-2", allow: false });
});

test("an approval answered twice keeps the server's message", async () => {
  await assert.rejects(
    () => withFetch(() => Promise.resolve(json({ error: { code: "stale_approval", message: "This approval is no longer waiting" } }, 409)),
      () => answerApproval(pending("approval-3", "op-3", "call-3"), true)),
    /no longer waiting/,
  );
});
