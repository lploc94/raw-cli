import assert from "node:assert/strict";
import test from "node:test";

const frame = `id: e:1\ndata: ${JSON.stringify({ id: "e:1", sequence: 1, type: "snapshot", data: {} })}\n\n`;
async function run(remote: boolean | undefined, cursor: string | undefined) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const received: unknown[] = [];
  const realFetch = globalThis.fetch;
  const realLocation = (globalThis as { location?: unknown }).location;
  const realHistory = (globalThis as { history?: unknown }).history;
  const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "localStorage", { value: { setItem() {}, getItem: () => null }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: { setItem() {}, getItem: () => null }, configurable: true, writable: true });
  Object.assign(globalThis, {
    location: { hash: "#token=tok-7", pathname: "/", search: "" },
    history: { state: null, replaceState() {} },
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
    if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
    if (realSessionStorage) Object.defineProperty(globalThis, "sessionStorage", realSessionStorage);
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

test("initializeToken persists the launch token in localStorage and recovers it when sessionStorage is cleared", async () => {
  const realFetch = globalThis.fetch;
  const realLocation = (globalThis as { location?: unknown }).location;
  const realHistory = (globalThis as { history?: unknown }).history;
  const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  let replacedUrl = "";
  const headers: string[] = [];
  Object.defineProperty(globalThis, "localStorage", {
    value: { setItem: (k: string, v: string) => local.set(k, v), getItem: (k: string) => local.get(k) ?? null },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: { setItem: (k: string, v: string) => session.set(k, v), getItem: (k: string) => session.get(k) ?? null },
    configurable: true,
    writable: true,
  });
  Object.assign(globalThis, {
    location: { hash: "#token=remote-qr-token", pathname: "/chat/s1", search: "" },
    history: { state: { rawIndex: 1 }, replaceState(_state: unknown, _unused: string, url: string) { replacedUrl = url; } },
    fetch: async (_url: string, init?: RequestInit) => {
      headers.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const { api, initializeToken } = await import("../web/src/api.js");
    initializeToken();
    assert.equal(replacedUrl, "/chat/s1");
    assert.equal(local.get("raw.dashboard.token"), "remote-qr-token");
    assert.equal(session.get("raw.dashboard.token"), "remote-qr-token");

    // Simulate mobile browser tab reload after screen off where hash was stripped and sessionStorage was cleared.
    (globalThis as unknown as { location: { hash: string; pathname: string; search: string } }).location = { hash: "", pathname: "/chat/s1", search: "" };
    session.clear();
    initializeToken();
    assert.equal(session.get("raw.dashboard.token"), "remote-qr-token");
    await api("/bootstrap");
    assert.deepEqual(headers, ["Bearer remote-qr-token"]);
  } finally {
    Object.assign(globalThis, { fetch: realFetch, location: realLocation, history: realHistory });
    if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
    if (realSessionStorage) Object.defineProperty(globalThis, "sessionStorage", realSessionStorage);
  }
});
