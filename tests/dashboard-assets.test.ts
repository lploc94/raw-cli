import assert from "node:assert/strict";
import test from "node:test";
import { dashboardFixture } from "./fixtures/dashboard.js";

test("built browser entry and local module assets are served without a development server", async () => {
  const f = await dashboardFixture();
  try {
    const response = await fetch(`${f.server.url}/settings/appearance`);
    assert.equal(response.status, 200); const html = await response.text();
    const nonce = /name="raw-style-nonce" content="([^"]+)"/.exec(html)?.[1]; assert.ok(nonce);
    assert.ok(response.headers.get("content-security-policy")?.includes(`'nonce-${nonce}'`));
    assert.doesNotMatch(response.headers.get("content-security-policy")!, /unsafe-inline/);
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(scripts.length); assert.doesNotMatch(html, /https?:\/\/|localhost:5173/);
    for (const path of scripts) { assert.ok(path.startsWith("/assets/")); const asset = await fetch(f.server.url + path); assert.equal(asset.status, 200); assert.match(asset.headers.get("content-type")!, /javascript/); }
    assert.equal(f.provider.requests.length, 0);
    // The composer ships in the static bundle, and its image loading stays within the CSP's same-origin/data: sources.
    const bundle = (await Promise.all(scripts.map(async (path) => (await fetch(f.server.url + path)).text()))).join("\n");
    for (const text of ["Add attachment", "Drop to attach", "No matching commands", "Reference workspace file", "Request settings", "Agent default", "Reset"]) assert.ok(bundle.includes(text), `bundle lacks ${text}`);
    assert.match(response.headers.get("content-security-policy")!, /img-src 'self' data:(?:;|$)/);
    assert.doesNotMatch(response.headers.get("content-security-policy")!, /blob:/);
  } finally { await f.close(); }
});
