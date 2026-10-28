import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuthLimiter } from "../src/dashboard/auth-limit.js";
import { startDashboard } from "../src/dashboard/server.js";

const PUBLIC = "https://review-fixture.trycloudflare.com";
const PUBLIC_HOST = "review-fixture.trycloudflare.com";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-dashboard-remote-auth-"));
  const assetsRoot = join(root, "assets"); mkdirSync(join(assetsRoot, "assets"), { recursive: true });
  writeFileSync(join(assetsRoot, "index.html"), "<!doctype html><title>Raw fixture</title>");
  return { root, options: { port: 0, cwd: root, assetsRoot,
    env: { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") } },
    cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
/** `Host` must be settable per request, which `fetch` forbids. */
function raw(port: number, path: string, headers: Record<string, string>, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
}
const code = (response: { body: string }) => (JSON.parse(response.body) as { error?: { code?: string } }).error?.code;

test("a tunnel Host is rejected until its origin is registered, and again after it is revoked", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  const auth = { Authorization: `Bearer ${server.token}` };
  try {
    let response = await raw(server.port, "/api/bootstrap", { ...auth, Host: PUBLIC_HOST });
    assert.equal(response.status, 403); assert.equal(code(response), "foreign_host");
    assert.equal((await raw(server.port, "/", { Host: PUBLIC_HOST })).status, 403);
    const revoke = server.allowPublicOrigin(PUBLIC);
    assert.equal((await raw(server.port, "/api/bootstrap", { ...auth, Host: PUBLIC_HOST })).status, 200);
    assert.equal((await raw(server.port, "/api/bootstrap", { ...auth, Host: PUBLIC_HOST, Origin: PUBLIC })).status, 200);
    assert.equal((await raw(server.port, "/", { Host: PUBLIC_HOST })).status, 200);
    assert.equal((await raw(server.port, "/api/bootstrap", { ...auth, Host: `127.0.0.1:${server.port}` })).status, 200, "loopback keeps working");
    revoke();
    response = await raw(server.port, "/api/bootstrap", { ...auth, Host: PUBLIC_HOST });
    assert.equal(response.status, 403); assert.equal(code(response), "foreign_host");
    revoke(); // revoking twice is harmless
    assert.equal((await raw(server.port, "/api/bootstrap", { ...auth, Host: `127.0.0.1:${server.port}` })).status, 200);
  } finally { await server.close(); f.cleanup(); }
});

test("a registered tunnel origin admits only its exact Host and Origin", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  const auth = { Authorization: `Bearer ${server.token}` };
  try {
    server.allowPublicOrigin(PUBLIC);
    for (const host of [`${PUBLIC_HOST}.evil.example`, `evil-${PUBLIC_HOST}`, `${PUBLIC_HOST}:8443`, "other.trycloudflare.com", "evil.example"]) {
      const response = await raw(server.port, "/api/bootstrap", { ...auth, Host: host });
      assert.equal(response.status, 403, host); assert.equal(code(response), "foreign_host", host);
    }
    for (const origin of ["http://review-fixture.trycloudflare.com", "https://review-fixture.trycloudflare.com:444", "https://evil.example",
      "https://other.trycloudflare.com", "null", `${PUBLIC}.evil.example`]) {
      const response = await raw(server.port, "/api/bootstrap", { ...auth, Host: PUBLIC_HOST, Origin: origin });
      assert.equal(response.status, 403, origin); assert.equal(code(response), "foreign_origin", origin);
    }
  } finally { await server.close(); f.cleanup(); }
});

test("allowPublicOrigin accepts only a bare https quick-tunnel origin, one at a time, and not after close", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  try {
    for (const bad of ["http://x.trycloudflare.com", "https://x.example.com", "https://x.trycloudflare.com:8443", "https://user:pw@x.trycloudflare.com",
      "https://x.trycloudflare.com/path", "https://x.trycloudflare.com/?q=1", "https://x.trycloudflare.com/#frag", "https://a.b.trycloudflare.com",
      "https://trycloudflare.com", "https://x.trycloudflare.com.evil.example", "not a url", "",
      "https://x.trycloudflare.com:443", "https://x.trycloudflare.com/x/..", "https://x.trycloudflare.com/?", "https://x.trycloudflare.com/#", "https://x.trycloudflare.com//", " https://x.trycloudflare.com"]) {
      assert.throws(() => server.allowPublicOrigin(bad), /origin|quick tunnel/i, JSON.stringify(bad));
    }
    const revoke = server.allowPublicOrigin(`${PUBLIC}/`); // a trailing slash is the same origin
    assert.throws(() => server.allowPublicOrigin("https://second.trycloudflare.com"), /already/i);
    revoke();
    const again = server.allowPublicOrigin("https://second.trycloudflare.com");
    again();
    await server.close();
    assert.throws(() => server.allowPublicOrigin(PUBLIC), /stopping|closed/i);
  } finally { await server.close(); f.cleanup(); }
});

test("a stale revoker cannot remove a newer registration of the same origin", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  try {
    const old = server.allowPublicOrigin(PUBLIC); old();
    const current = server.allowPublicOrigin(PUBLIC);
    old();
    const bootstrap = await fetch(`${server.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${server.token}` } });
    assert.equal(((await bootstrap.json()) as { remote: boolean }).remote, true);
    current(); current();
    const after = await fetch(`${server.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${server.token}` } });
    assert.equal(((await after.json()) as { remote: boolean }).remote, false);
  } finally { await server.close(); f.cleanup(); }
});

test("bootstrap reports remote only while a public origin is registered", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  const auth = { Authorization: `Bearer ${server.token}` };
  const remote = async () => ((await (await fetch(`${server.url}/api/bootstrap`, { headers: auth })).json()) as { remote: boolean }).remote;
  try {
    assert.equal(await remote(), false);
    const revoke = server.allowPublicOrigin(PUBLIC);
    assert.equal(await remote(), true);
    revoke();
    assert.equal(await remote(), false);
  } finally { await server.close(); f.cleanup(); }
});

test("wrong tokens are throttled per client while the valid token is never blocked", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  const good = { Authorization: `Bearer ${server.token}` };
  try {
    server.allowPublicOrigin(PUBLIC);
    const bad = (ip: string) => raw(server.port, "/api/bootstrap", { Authorization: "Bearer wrong", Host: PUBLIC_HOST, "CF-Connecting-IP": ip });
    for (let attempt = 1; attempt <= 10; attempt++) assert.equal((await bad("203.0.113.9")).status, 401, `attempt ${attempt}`);
    const limited = await bad("203.0.113.9");
    assert.equal(limited.status, 429); assert.equal(code(limited), "rate_limited");
    assert.match(String(limited.headers["retry-after"]), /^[1-9]\d*$/);
    assert.equal((await raw(server.port, "/api/bootstrap", { ...good, Host: PUBLIC_HOST, "CF-Connecting-IP": "203.0.113.9" })).status, 200, "valid token from the throttled client");
    assert.equal((await bad("198.51.100.4")).status, 401, "another client is unaffected");
    assert.equal((await raw(server.port, "/api/bootstrap", { Authorization: "Bearer wrong", Host: PUBLIC_HOST })).status, 401, "missing header uses the shared key");
    // Host and Origin rejections are not token guesses and are never counted.
    for (let attempt = 0; attempt < 15; attempt++) assert.equal((await raw(server.port, "/api/bootstrap", { Authorization: "Bearer wrong", Host: "evil.example" })).status, 403);
    // Static assets need no token and are never counted.
    for (let attempt = 0; attempt < 15; attempt++) assert.equal((await raw(server.port, "/", { Host: PUBLIC_HOST, "CF-Connecting-IP": "192.0.2.1" })).status, 200);
  } finally { await server.close(); f.cleanup(); }
});

test("without a public origin the client key is the socket address", async () => {
  const f = fixture(); const server = await startDashboard(f.options);
  try {
    const bad = () => raw(server.port, "/api/bootstrap", { Authorization: "Bearer wrong", "CF-Connecting-IP": `192.0.2.${Math.floor(Math.random() * 200)}` });
    for (let attempt = 1; attempt <= 10; attempt++) assert.equal((await bad()).status, 401);
    assert.equal((await bad()).status, 429, "a spoofed header does not dodge the limit while the dashboard is local-only");
    assert.equal((await fetch(`${server.url}/api/bootstrap`, { headers: { Authorization: `Bearer ${server.token}` } })).status, 200);
  } finally { await server.close(); f.cleanup(); }
});

test("limiter: ten failures answer 401-class, the eleventh is limited with the remaining window, expiry releases the key", () => {
  let now = 1_000_000; const limiter = createAuthLimiter({ now: () => now });
  for (let attempt = 1; attempt <= 10; attempt++) assert.equal(limiter.fail("a").limited, false, `attempt ${attempt}`);
  now += 5_000;
  const blocked = limiter.fail("a");
  assert.equal(blocked.limited, true); assert.equal(blocked.retryAfterSeconds, 55);
  assert.equal(limiter.fail("b").limited, false, "keys are independent");
  now += 54_999; assert.equal(limiter.fail("a").limited, true, "still inside the window");
  now += 1; assert.equal(limiter.fail("a").limited, false, "a new window starts after 60 s");
  for (let attempt = 2; attempt <= 10; attempt++) assert.equal(limiter.fail("a").limited, false);
  assert.equal(limiter.fail("a").limited, true);
  assert.ok(limiter.fail("a").retryAfterSeconds >= 1);
});

test("limiter: churn at capacity never releases a throttled key and never tracks more than the cap", () => {
  let now = 0; const limiter = createAuthLimiter({ now: () => now });
  for (let attempt = 1; attempt <= 11; attempt++) limiter.fail("throttled");
  for (let index = 0; index < 999; index++) limiter.fail(`filler-${index}`);
  assert.equal(limiter.trackedKeys(), 1000);
  for (let index = 0; index < 1500; index++) limiter.fail(`newcomer-${index}`);
  assert.ok(limiter.trackedKeys() <= 1000, `tracked ${limiter.trackedKeys()}`);
  assert.equal(limiter.fail("throttled").limited, true, "an active throttled key is not evicted");
  // Overflow keys share one bucket: the eleventh failure among them (1,500 already happened) is limited.
  assert.equal(limiter.fail("another-newcomer").limited, true);
  now += 60_000;
  assert.equal(limiter.fail("throttled").limited, false, "expiry releases everything");
  assert.equal(limiter.fail("another-newcomer").limited, false);
  assert.ok(limiter.trackedKeys() <= 1000);
});
