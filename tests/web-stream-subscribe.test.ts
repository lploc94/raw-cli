import assert from "node:assert/strict";
import test from "node:test";

const frame = `id: e:1\ndata: ${JSON.stringify({ id: "e:1", sequence: 1, type: "snapshot", data: {} })}\n\n`;
async function run(remote: boolean | undefined, cursor: string | undefined) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const received: unknown[] = [];
  const realFetch = globalThis.fetch;
  const realLocation = (globalThis as { location?: unknown }).location;
  const realHistory = (globalThis as { history?: unknown }).history;
  Object.assign(globalThis, {
    location: { hash: "#token=tok-7", pathname: "/", search: "" },
    history: { state: null, replaceState() {} },
    sessionStorage: { setItem() {}, getItem: () => null },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(frame, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const { initializeToken, subscribe } = await import("../web/src/api.js");
    initializeToken();
    let connected = 0;
    await assert.rejects(subscribe("s/1 x", cursor, new AbortController().signal, (event) => received.push(event), () => connected++, remote), /Stream disconnected/);
    assert.equal(connected, 1);
  } finally {
    Object.assign(globalThis, { fetch: realFetch, location: realLocation, history: realHistory });
  }
  return { calls, received };
}

for (const [remote, method] of [[true, "POST"], [false, "GET"], [undefined, "GET"]] as const) {
  for (const cursor of [undefined, "e:0"]) {
    test(`subscribe remote=${remote} cursor=${cursor ?? "none"} issues ${method} and delivers the frame`, async () => {
      const { calls, received } = await run(remote, cursor);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, `/api/sessions/${encodeURIComponent("s/1 x")}/events`);
      assert.equal(calls[0]!.init.method ?? "GET", method);
      assert.deepEqual(calls[0]!.init.headers, { Authorization: "Bearer tok-7", ...(cursor ? { "Last-Event-ID": cursor } : {}) });
      assert.equal(received.length, 1);
    });
  }
}
