import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDashboardCli } from "../src/dashboard/cli.js";
import { TunnelError, type QuickTunnel } from "../src/dashboard/tunnel.js";
import { posixOnly } from "./fixtures/platform.js";

const withoutSqliteWarning = (stderr: string) => stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\n\(Use `node --trace-warnings[^\n]*\n/g, "");
const TUNNEL_URL = "https://carol-engineering-robot-remedies.trycloudflare.com";
const LINK = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]+)/;

/** A GET to the local port with chosen Host/Origin headers (fetch cannot override Host). */
function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => { let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode!, body })); });
    req.on("error", reject); req.end();
  });
}
const listening = (port: number) => get(port, "/api/bootstrap", {}).then(() => true, () => false);

// ---- in-process: the real runDashboardCli with an injected tunnel factory ----

function inProcess(tty = false) {
  const root = mkdtempSync(join(tmpdir(), "raw-remote-cli-"));
  const savedEnv = { ...process.env };
  let stdout = ""; let stderr = "";
  Object.assign(process.env, { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") });
  return {
    io: { stdout: { isTTY: tty, write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } } },
    out: () => stdout, err: () => withoutSqliteWarning(stderr),
    waitFor: async (predicate: () => boolean) => { for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(predicate(), `timed out; stdout=${stdout} stderr=${stderr}`); },
    restore: () => { for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } rmSync(root, { recursive: true, force: true }); },
  };
}
const localLink = (out: string) => { const found = LINK.exec(out)!; return { port: Number(found[1]), token: found[2]! }; };

test("a registered tunnel prints the remote link, authenticates through the tunnel Host/Origin and reports remote", async () => {
  const io = inProcess(); const events: string[] = [];
  const fake: QuickTunnel = { url: TUNNEL_URL, closed: new Promise<void>(() => {}), close: async () => { events.push("tunnel.close"); } };
  try {
    const done = runDashboardCli({ port: 0, noOpen: true, remote: true }, { ...io.io, startTunnel: async (options) => { events.push(`start:${typeof options.port}`); return fake; } });
    await io.waitFor(() => io.out().includes("Press Ctrl-C to stop."));
    const { port, token } = localLink(io.out());
    const remote = new RegExp(`^Raw dashboard \\(remote\\): ${TUNNEL_URL.replace(/\./g, "\\.")}/#token=${token}$`, "m");
    assert.match(io.out(), remote);
    assert.match(io.out(), /Cloudflare terminates TLS/);
    assert.match(io.out(), /changes every run/);
    const via = await get(port, "/api/bootstrap", { Host: new URL(TUNNEL_URL).host, Origin: TUNNEL_URL, Authorization: `Bearer ${token}` });
    assert.equal(via.status, 200);
    assert.equal(JSON.parse(via.body).remote, true);
    assert.equal((await get(port, "/api/bootstrap", { Host: "other.trycloudflare.com", Authorization: `Bearer ${token}` })).status, 403);
    // The tunnel closes before the server: while tunnel.close() runs the listener still answers.
    fake.close = async () => { events.push(`tunnel.close:listening=${await listening(port)}`); };
    process.emit("SIGINT");
    await done;
    assert.deepEqual(events, [`start:number`, "tunnel.close:listening=true"]);
    assert.equal(await listening(port), false);
    assert.equal(io.err().includes("terminates"), false);
  } finally { io.restore(); }
});

for (const tty of [false, true]) test(`the QR code is printed only on a terminal (tty=${tty})`, async () => {
  const io = inProcess(tty);
  try {
    const done = runDashboardCli({ port: 0, noOpen: true, remote: true }, { ...io.io, startTunnel: async () => ({ url: TUNNEL_URL, closed: new Promise<void>(() => {}), close: async () => {} }) });
    await io.waitFor(() => io.out().includes("Press Ctrl-C to stop."));
    const blocks = /[█▀▄]/.test(io.out());
    assert.equal(blocks, tty);
    if (tty) {
      const qr = io.out().split("\n").filter((line) => /^[█▀▄ ]+$/.test(line) && line.trim() !== "").length;
      assert.ok(qr > 10, `QR lines: ${qr}`);
    }
    process.emit("SIGINT"); await done;
  } finally { io.restore(); }
});

for (const [name, failure, expected] of [
  ["a missing cloudflared", new TunnelError("cloudflared_not_found", "cloudflared was not found on PATH"), /cloudflared was not found.*brew install cloudflared/s],
  ["an early exit", new TunnelError("tunnel_exited", "cloudflared exited before the tunnel was ready (3)", ["failed to request quick Tunnel"]), /exited before the tunnel was ready \(3\)\n  failed to request quick Tunnel/],
  ["a deadline", new TunnelError("tunnel_timeout", "cloudflared did not register a tunnel within 45 s", ["INF Requesting new quick Tunnel"]), /did not register a tunnel within 45 s\n  INF Requesting/],
] as const) test(`${name} prints one warning, keeps the local dashboard and reports remote false`, async () => {
  const io = inProcess();
  try {
    const done = runDashboardCli({ port: 0, noOpen: true, remote: true }, { ...io.io, startTunnel: async () => { throw failure; } });
    await io.waitFor(() => io.out().includes("Press Ctrl-C to stop."));
    const { port, token } = localLink(io.out());
    assert.equal(io.out(), `Raw dashboard: http://127.0.0.1:${port}/#token=${token}\nPress Ctrl-C to stop.\n`);
    assert.equal(io.err().match(/remote access is off/g)?.length, 1);
    assert.match(io.err(), expected);
    const boot = await get(port, "/api/bootstrap", { Authorization: `Bearer ${token}` });
    assert.equal(boot.status, 200); assert.equal(JSON.parse(boot.body).remote, false);
    process.emit("SIGINT"); await done;
  } finally { io.restore(); }
});

test("a tunnel that exits after readiness turns remote off with one warning and the local dashboard keeps running", async () => {
  const io = inProcess(); let exitTunnel!: () => void;
  const closed = new Promise<void>((resolve) => { exitTunnel = resolve; });
  try {
    const done = runDashboardCli({ port: 0, noOpen: true, remote: true }, { ...io.io, startTunnel: async () => ({ url: TUNNEL_URL, closed, close: async () => {} }) });
    await io.waitFor(() => io.out().includes("Press Ctrl-C to stop."));
    const { port, token } = localLink(io.out());
    exitTunnel();
    await io.waitFor(() => io.err().includes("the quick tunnel stopped"));
    assert.equal(io.err().match(/quick tunnel stopped/g)?.length, 1);
    const boot = await get(port, "/api/bootstrap", { Authorization: `Bearer ${token}` });
    assert.equal(JSON.parse(boot.body).remote, false);
    assert.equal((await get(port, "/api/bootstrap", { Host: new URL(TUNNEL_URL).host, Authorization: `Bearer ${token}` })).status, 403);
    process.emit("SIGINT"); await done;
  } finally { io.restore(); }
});

test("cancelling while the tunnel starts leaves no listener and nothing pending", async () => {
  const io = inProcess(); let sawSignal: AbortSignal | undefined; let listenerPort = 0;
  try {
    const done = runDashboardCli({ port: 0, noOpen: true, remote: true }, { ...io.io,
      startTunnel: (options) => new Promise<QuickTunnel>((_, reject) => { sawSignal = options.signal; listenerPort = options.port; options.signal?.addEventListener("abort", () => reject(new TunnelError("tunnel_cancelled", "cancelled")), { once: true }); }),
    });
    await io.waitFor(() => listenerPort !== 0);
    assert.equal(await listening(listenerPort), true);
    process.emit("SIGINT");
    await done;
    assert.equal(sawSignal?.aborted, true);
    assert.equal(await listening(listenerPort), false);
    assert.equal(io.out().includes("Press Ctrl-C"), false);
    assert.equal(io.err().includes("remote access is off"), false);
  } finally { io.restore(); }
});

// ---- child process: dist/raw.js with a fake cloudflared first on PATH ----

const FAKE_CLOUDFLARED = `#!/usr/bin/env node
const fs = require("node:fs"); const dir = process.env.FAKE_DIR;
const at = (flag) => process.argv[process.argv.indexOf(flag) + 1];
fs.writeFileSync(dir + "/pid", String(process.pid)); fs.writeFileSync(dir + "/config-path", at("--config"));
process.on("SIGTERM", () => { fs.writeFileSync(dir + "/term", "term"); if (!process.env.FAKE_IGNORE_TERM) process.exit(0); });
console.error("2026-10-27T07:41:46Z INF |  https://carol-engineering-robot-remedies.trycloudflare.com                                |");
setTimeout(() => console.error("2026-10-27T07:41:47Z INF Registered tunnel connection connIndex=0 connection=1666b405 event=0 ip=198.41.200.23 location=sin02 protocol=quic"), 100);
setInterval(() => {}, 1000);
`;
function childFixture(withFake: boolean, extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "raw-remote-cli-")); const bin = join(root, "bin"); mkdirSync(bin);
  if (withFake) writeFileSync(join(bin, "cloudflared"), FAKE_CLOUDFLARED, { mode: 0o755 });
  const child = spawn(process.execPath, [join(process.cwd(), "dist/raw.js"), "dashboard", "--remote", "--no-open", "--port", "0"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: withFake ? `${bin}:${process.env.PATH}` : bin, FAKE_DIR: root, ...extraEnv, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") },
  });
  let stdout = ""; let stderr = "";
  child.stdout!.on("data", (c) => { stdout += c; }); child.stderr!.on("data", (c) => { stderr += c; });
  const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(predicate(), `timed out; stdout=${stdout} stderr=${stderr}`); };
  const stop = async (signal: NodeJS.Signals) => { const exit = once(child, "exit"); child.kill(signal); return (await exit)[0] as number | null; };
  return { root, bin, child, out: () => stdout, err: () => withoutSqliteWarning(stderr), waitFor, stop, cleanup: (c: ChildProcess) => { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("installed CLI with a fake cloudflared prints the remote link, authenticates through the tunnel Host and cleans up on SIGINT", { skip: posixOnly("signals") }, async () => {
  const f = childFixture(true);
  try {
    await f.waitFor(() => f.out().includes("Press Ctrl-C to stop."));
    const { port, token } = localLink(f.out());
    assert.match(f.out(), new RegExp(`^Raw dashboard \\(remote\\): ${TUNNEL_URL.replace(/\./g, "\\.")}/#token=${token}$`, "m"));
    const via = await get(port, "/api/bootstrap", { Host: new URL(TUNNEL_URL).host, Origin: TUNNEL_URL, Authorization: `Bearer ${token}` });
    assert.equal(via.status, 200); assert.equal(JSON.parse(via.body).remote, true);
    const pid = Number(readFileSync(join(f.root, "pid"), "utf8")); const configPath = readFileSync(join(f.root, "config-path"), "utf8");
    assert.equal(alive(pid), true); assert.equal(existsSync(configPath), true);
    assert.equal(await f.stop("SIGINT"), 0);
    assert.equal(alive(pid), false, "the fake child is gone before the CLI exits");
    assert.equal(existsSync(configPath), false, "its temp config is gone");
    assert.equal(f.err().includes("quick tunnel stopped"), false);
  } finally { f.cleanup(f.child); }
});

test("installed CLI without cloudflared on PATH warns once, prints the local link and keeps working", { skip: posixOnly("signals") }, async () => {
  const f = childFixture(false);
  try {
    await f.waitFor(() => f.out().includes("Press Ctrl-C to stop."));
    const { port, token } = localLink(f.out());
    assert.equal(f.out(), `Raw dashboard: http://127.0.0.1:${port}/#token=${token}\nPress Ctrl-C to stop.\n`);
    assert.equal(f.err().match(/remote access is off/g)?.length, 1);
    assert.match(f.err(), /brew install cloudflared/);
    const boot = await get(port, "/api/bootstrap", { Authorization: `Bearer ${token}` });
    assert.equal(JSON.parse(boot.body).remote, false);
    assert.equal(await f.stop("SIGINT"), 0);
  } finally { f.cleanup(f.child); }
});

test("a closed stdout pipe stops the run through the normal teardown: the tunnel child and its temp config are gone", { skip: posixOnly("signals") }, async () => {
  const f = childFixture(true);
  try {
    f.child.stdout!.destroy(); // the reader goes away before the CLI prints its link
    await f.waitFor(() => existsSync(join(f.root, "pid")));
    const pid = Number(readFileSync(join(f.root, "pid"), "utf8")); const configPath = readFileSync(join(f.root, "config-path"), "utf8");
    await once(f.child, "exit");
    assert.equal(alive(pid), false, "the fake child is gone");
    assert.equal(existsSync(configPath), false, "its temp config is gone");
  } finally { f.cleanup(f.child); }
});

test("a second Ctrl-C during teardown does not skip it: a child that ignores SIGTERM is still killed", { skip: posixOnly("signals") }, async () => {
  const f = childFixture(true, { FAKE_IGNORE_TERM: "1" });
  try {
    await f.waitFor(() => f.out().includes("Press Ctrl-C to stop."));
    const pid = Number(readFileSync(join(f.root, "pid"), "utf8")); const configPath = readFileSync(join(f.root, "config-path"), "utf8");
    const exit = once(f.child, "exit");
    f.child.kill("SIGINT");
    await f.waitFor(() => existsSync(join(f.root, "term"))); // teardown reached the child, which ignores it
    f.child.kill("SIGINT");
    const [code] = await exit;
    assert.equal(code, 0);
    assert.equal(alive(pid), false); assert.equal(existsSync(configPath), false);
  } finally { f.cleanup(f.child); }
});
