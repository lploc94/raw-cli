import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTunnelOutputParser, startQuickTunnel, tunnelConfig, tunnelEnv, TunnelError } from "../src/dashboard/tunnel.js";
import { posixOnly } from "./fixtures/platform.js";

// Output of a real `cloudflared tunnel --url` run (version 2026.1.2, loglevel info), trimmed to the lines that matter.
const URL_LINES = [
  "2026-10-27T07:41:41Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/).",
  "2026-10-27T07:41:41Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-10-27T07:41:46Z INF +--------------------------------------------------------------------------------------------+",
  "2026-10-27T07:41:46Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  "2026-10-27T07:41:46Z INF |  https://carol-engineering-robot-remedies.trycloudflare.com                                |",
  "2026-10-27T07:41:46Z INF +--------------------------------------------------------------------------------------------+",
  "2026-10-27T07:41:46Z INF Settings: map[config:/tmp/cfspike/config.yml ha-connections:1 loglevel:info no-autoupdate:true protocol:quic url:http://127.0.0.1:21999]",
];
const REGISTERED_LINE = "2026-10-27T07:41:47Z INF Registered tunnel connection connIndex=0 connection=1666b405-6275-42bc-ae93-087eac0540c0 event=0 ip=198.41.200.23 location=sin02 protocol=quic";
const URL = "https://carol-engineering-robot-remedies.trycloudflare.com";

const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("raw-tunnel-") && !name.startsWith("raw-tunnel-test-"));

const FAKE = `
const fs = require("node:fs");
const mode = process.env.FAKE_MODE; const lines = JSON.parse(process.env.FAKE_URL_LINES); const registered = process.env.FAKE_REGISTERED;
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), env: process.env, config: (() => { const i = process.argv.indexOf("--config"); try { return fs.readFileSync(process.argv[i + 1], "utf8"); } catch { return null; } })(), configPath: process.argv[process.argv.indexOf("--config") + 1] }));
if (mode === "ignore-term") process.on("SIGTERM", () => {});
if (mode === "silent") { setInterval(() => {}, 1000); return; }
if (mode === "early-exit") { process.stderr.write("failed to request quick Tunnel\\n"); process.exit(3); }
const text = lines.join("\\n") + "\\n";
if (mode === "split") { for (let i = 0; i < text.length; i += 7) process.stderr.write(text.slice(i, i + 7)); }
else process.stderr.write(text);
if (mode === "no-register") { setInterval(() => {}, 1000); return; }
setTimeout(() => {
  if (mode === "split") { const r = registered + "\\n"; for (let i = 0; i < r.length; i += 5) process.stdout.write(r.slice(i, i + 5)); } else process.stderr.write(registered + "\\n");
  if (mode === "exit-after-ready") setTimeout(() => process.exit(0), 100); else setInterval(() => {}, 1000);
}, 150);
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "raw-tunnel-test-"));
  const script = join(dir, "fake-cloudflared.js"); writeFileSync(script, FAKE);
  const record = join(dir, "record.json");
  const run = (mode: string, extra: Partial<Parameters<typeof startQuickTunnel>[0]> & { env?: NodeJS.ProcessEnv } = {}) => startQuickTunnel({
    port: 4321, command: process.execPath, commandArgs: [script], timeoutMs: 5_000, ...extra,
    env: { ...process.env, FAKE_MODE: mode, FAKE_RECORD: record, FAKE_URL_LINES: JSON.stringify(URL_LINES), FAKE_REGISTERED: REGISTERED_LINE, ...extra.env },
  });
  const recorded = () => JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string>; config: string | null; configPath: string };
  return { run, recorded, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the parser resolves only at the registration line, including when output is split mid-line", () => {
  const parser = createTunnelOutputParser();
  const text = URL_LINES.join("\n") + "\n";
  for (let i = 0; i < text.length; i += 11) parser.push(text.slice(i, i + 11));
  assert.equal(parser.url, URL);
  assert.equal(parser.registered, false); // the URL alone is not readiness
  for (let i = 0; i < REGISTERED_LINE.length; i += 9) parser.push(REGISTERED_LINE.slice(i, i + 9));
  assert.equal(parser.registered, false); // no newline yet
  parser.push("\n");
  assert.equal(parser.registered, true);
});
test("a registration line before any URL does not count, and a URL outside the table row still parses", () => {
  const parser = createTunnelOutputParser();
  parser.push(`${REGISTERED_LINE}\n`);
  assert.equal(parser.registered, false);
  parser.push(`INF visit ${URL} now\r\n`);
  assert.equal(parser.url, URL);
  parser.push(`${REGISTERED_LINE}\r\n`);
  assert.equal(parser.registered, true);
});
test("tunnelEnv drops TUNNEL_* variables except the network-shape allowlist and keeps everything else", () => {
  const out = tunnelEnv({ PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://p", TUNNEL_LOGLEVEL: "error", TUNNEL_TOKEN: "t", TUNNEL_URL: "u", TUNNEL_FOO: "x", tunnel_config: "c",
    TUNNEL_EDGE_IP_VERSION: "6", TUNNEL_TRANSPORT_PROTOCOL: "http2", TUNNEL_REGION: "us", TUNNEL_RETRIES: "3", TUNNEL_EDGE_BIND_ADDRESS: "1.2.3.4", TUNNEL_POST_QUANTUM: "true", NOT_TUNNEL: "1" });
  assert.deepEqual(out, { PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://p", TUNNEL_EDGE_IP_VERSION: "6", TUNNEL_TRANSPORT_PROTOCOL: "http2", TUNNEL_REGION: "us", TUNNEL_RETRIES: "3", TUNNEL_EDGE_BIND_ADDRESS: "1.2.3.4", TUNNEL_POST_QUANTUM: "true", NOT_TUNNEL: "1" });
});
test("tunnelConfig is one catch-all ingress to the dashboard port", () => {
  assert.equal(tunnelConfig(21517), "ingress:\n  - service: http://127.0.0.1:21517\n");
});

for (const mode of ["ok", "split"]) test(`the tunnel resolves after the registration line (${mode}), with an isolated config and a filtered env`, async () => {
  const f = fixture();
  const tunnel = await f.run(mode, { env: { TUNNEL_LOGLEVEL: "error", TUNNEL_TOKEN: "secret", TUNNEL_URL: "http://elsewhere", TUNNEL_FOO: "1", TUNNEL_EDGE_IP_VERSION: "6", TUNNEL_TRANSPORT_PROTOCOL: "http2", HTTPS_PROXY: "http://proxy" } });
  try {
    assert.equal(tunnel.url, URL);
    const seen = f.recorded();
    assert.deepEqual(seen.argv, ["tunnel", "--config", seen.configPath, "--no-autoupdate", "--loglevel", "info", "--url", "http://127.0.0.1:4321"]);
    assert.equal(seen.argv.at(-1), "http://127.0.0.1:4321");
    assert.equal(seen.argv[seen.argv.indexOf("--loglevel") + 1], "info");
    assert.equal(seen.config, "ingress:\n  - service: http://127.0.0.1:4321\n");
    for (const name of ["TUNNEL_LOGLEVEL", "TUNNEL_TOKEN", "TUNNEL_URL", "TUNNEL_FOO"]) assert.equal(seen.env[name], undefined, name);
    assert.equal(seen.env.TUNNEL_EDGE_IP_VERSION, "6"); assert.equal(seen.env.TUNNEL_TRANSPORT_PROTOCOL, "http2");
    assert.equal(seen.env.HTTPS_PROXY, "http://proxy"); assert.ok(seen.env.PATH);
    assert.ok(existsSync(seen.configPath), "config exists while the tunnel runs");
    await tunnel.close();
    assert.equal(existsSync(seen.configPath), false, "temp dir removed after close");
  } finally { await tunnel.close(); f.cleanup(); }
});
test("the tunnel does not resolve on the URL line alone: it hits the deadline, kills the child and removes the temp dir", async () => {
  const f = fixture();
  await assert.rejects(f.run("no-register", { timeoutMs: 600 }), (error: unknown) => error instanceof TunnelError && error.code === "tunnel_timeout" && error.lines.some((line) => line.includes(URL)));
  assert.equal(existsSync(f.recorded().configPath), false);
  f.cleanup();
});
test("a silent child hits the deadline too", async () => {
  const f = fixture();
  await assert.rejects(f.run("silent", { timeoutMs: 400 }), (error: unknown) => error instanceof TunnelError && error.code === "tunnel_timeout");
  assert.equal(existsSync(f.recorded().configPath), false);
  f.cleanup();
});
test("an early exit rejects with the exit code and the last output lines", async () => {
  const f = fixture();
  await assert.rejects(f.run("early-exit"), (error: unknown) => error instanceof TunnelError && error.code === "tunnel_exited" && /3/.test(error.message) && error.lines.includes("failed to request quick Tunnel"));
  assert.equal(existsSync(f.recorded().configPath), false);
  f.cleanup();
});
test("a missing binary rejects with cloudflared_not_found and leaves no temp dir", async () => {
  const before = leftovers().length;
  await assert.rejects(startQuickTunnel({ port: 1, command: join(tmpdir(), "definitely-missing-cloudflared"), timeoutMs: 2_000 }), (error: unknown) => error instanceof TunnelError && error.code === "cloudflared_not_found");
  assert.equal(leftovers().length, before);
});
test("aborting during startup cancels, kills the child and removes the temp dir", async () => {
  const f = fixture(); const controller = new AbortController();
  const started = f.run("no-register", { signal: controller.signal, timeoutMs: 5_000 });
  setTimeout(() => controller.abort(), 400);
  await assert.rejects(started, (error: unknown) => error instanceof TunnelError && error.code === "tunnel_cancelled");
  assert.equal(existsSync(f.recorded().configPath), false);
  f.cleanup();
});
test("closed settles when the child exits on its own after readiness, and the temp dir goes away", async () => {
  const f = fixture(); const tunnel = await f.run("exit-after-ready");
  await tunnel.closed;
  assert.equal(existsSync(f.recorded().configPath), false);
  await tunnel.close(); // already gone: still fine
  f.cleanup();
});
test("close() ends a child that ignores SIGTERM and is idempotent", { skip: posixOnly("signals") }, async () => {
  const f = fixture(); const tunnel = await f.run("ignore-term");
  const started = Date.now();
  await Promise.all([tunnel.close(), tunnel.close()]);
  assert.ok(Date.now() - started >= 1_500, "waited for the SIGTERM grace period before SIGKILL");
  await tunnel.closed;
  assert.equal(existsSync(f.recorded().configPath), false);
  f.cleanup();
});

// Real binary (offline subcommands only). Skipped when cloudflared is not installed.
const realCloudflared = spawnSync("cloudflared", ["--version"], { encoding: "utf8" }).status === 0;
test("real cloudflared: a hostile HOME ingress does not hijack the isolated config", { skip: !realCloudflared && "cloudflared is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-tunnel-test-"));
  try {
    mkdirSync(join(dir, "home", ".cloudflared"), { recursive: true });
    writeFileSync(join(dir, "home", ".cloudflared", "config.yml"), "ingress:\n  - service: http://127.0.0.1:9\n");
    writeFileSync(join(dir, "config.yml"), tunnelConfig(4321));
    const env = { ...tunnelEnv(process.env), HOME: join(dir, "home"), USERPROFILE: join(dir, "home") };
    const hostile = spawnSync("cloudflared", ["tunnel", "ingress", "rule", "https://x.trycloudflare.com"], { env, encoding: "utf8" });
    assert.match(hostile.stdout + hostile.stderr, /127\.0\.0\.1:9\b/); // without --config the user's file wins: the isolation is needed
    const isolated = spawnSync("cloudflared", ["tunnel", "--config", join(dir, "config.yml"), "ingress", "rule", "https://x.trycloudflare.com"], { env, encoding: "utf8" });
    assert.match(isolated.stdout + isolated.stderr, /service: http:\/\/127\.0\.0\.1:4321\b/);
    assert.doesNotMatch(isolated.stdout + isolated.stderr, /127\.0\.0\.1:9\b/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("real cloudflared: the filtered env keeps the IPv6 edge setting and drops the hazardous ones", { skip: !realCloudflared && "cloudflared is not installed" }, () => {
  const env = tunnelEnv({ ...process.env, TUNNEL_EDGE_IP_VERSION: "6", TUNNEL_LOGLEVEL: "error", TUNNEL_TOKEN: "x" });
  const help = spawnSync("cloudflared", ["tunnel", "--help"], { env, encoding: "utf8" }).stdout;
  assert.match(help, /--edge-ip-version value[^\n]*\(default: "6"\)/);
  assert.doesNotMatch(help, /--loglevel value[^\n]*\(default: "error"\)/);
});
