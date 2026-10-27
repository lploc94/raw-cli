import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommand } from "../platform/windows.js";

/**
 * Starts and supervises a Cloudflare quick tunnel (`cloudflared tunnel --url`) to the loopback dashboard.
 * Cloudflare terminates TLS and relays the traffic; the tunnel URL changes on every run and has no uptime guarantee.
 */
export type TunnelErrorCode = "cloudflared_not_found" | "tunnel_timeout" | "tunnel_exited" | "tunnel_cancelled";
export class TunnelError extends Error {
  constructor(readonly code: TunnelErrorCode, message: string, readonly lines: readonly string[] = []) { super(message); }
}
export interface QuickTunnel {
  /** `https://<name>.trycloudflare.com`, known only once the first tunnel connection is registered. */
  url: string;
  /** Settles when the child has exited, whatever the reason. */
  closed: Promise<void>;
  /** Stops the child (SIGTERM, then SIGKILL after 2 s), waits for it and removes the temp dir. Idempotent. */
  close(): Promise<void>;
}
export interface QuickTunnelOptions {
  port: number;
  signal?: AbortSignal;
  /** The executable; default `cloudflared` from PATH. */
  command?: string;
  /** Arguments placed before `tunnel ...` (tests run a script through `node`). */
  commandArgs?: readonly string[];
  /** The parent environment; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Deadline from spawn to the first registered connection. */
  timeoutMs?: number;
}

const KEPT_TUNNEL_VARIABLES = new Set(["TUNNEL_EDGE_IP_VERSION", "TUNNEL_EDGE_BIND_ADDRESS", "TUNNEL_REGION", "TUNNEL_TRANSPORT_PROTOCOL", "TUNNEL_RETRIES", "TUNNEL_POST_QUANTUM"]);
/**
 * The child's environment: everything of the parent except `TUNNEL_*` settings that could redirect it (token, URL,
 * log file, config, ...). Only the network-shape settings in the allowlist survive.
 */
export function tunnelEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) if (!/^TUNNEL_/i.test(name) || KEPT_TUNNEL_VARIABLES.has(name.toUpperCase())) env[name] = value;
  return env;
}
/** The config file passed with `--config`: one catch-all ingress, so a user's `~/.cloudflared/config.yml` cannot reroute the tunnel. */
export function tunnelConfig(port: number): string { return `ingress:\n  - service: http://127.0.0.1:${port}\n`; }

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED = "Registered tunnel connection";
/** Line-buffers cloudflared output across chunks; `registered` becomes true only after a registration line follows (or shares) the URL. */
export function createTunnelOutputParser(): { push(chunk: string): void; url: string | undefined; registered: boolean; tail(): string[] } {
  let partial = ""; const lines: string[] = [];
  const state = { url: undefined as string | undefined, registered: false };
  const take = (line: string) => {
    lines.push(line); if (lines.length > 20) lines.shift();
    if (!state.url) state.url = URL_PATTERN.exec(line)?.[0];
    if (state.url && line.includes(REGISTERED)) state.registered = true;
  };
  return {
    push(chunk) { partial = (partial + chunk).slice(-65_536); for (let end; (end = partial.indexOf("\n")) >= 0; ) { take(partial.slice(0, end).replace(/\r$/, "")); partial = partial.slice(end + 1); } },
    get url() { return state.url; },
    get registered() { return state.registered; },
    tail() { return partial ? [...lines, partial].slice(-20) : [...lines]; },
  };
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

export async function startQuickTunnel(options: QuickTunnelOptions): Promise<QuickTunnel> {
  const parentEnv = options.env ?? process.env;
  const args = [...(options.commandArgs ?? []), "tunnel", "--config", "", "--no-autoupdate", "--loglevel", "info", "--url", `http://127.0.0.1:${options.port}`];
  const dir = mkdtempSync(join(tmpdir(), "raw-tunnel-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const configIndex = args.indexOf("--config") + 1;
  try {
    const file = join(dir, "config.yml"); writeFileSync(file, tunnelConfig(options.port), { mode: 0o600 }); args[configIndex] = file;
  } catch (error) { cleanup(); throw error; }
  const resolved = resolveCommand(options.command ?? "cloudflared", args, { cwd: process.cwd(), env: parentEnv });
  if (!resolved.ok) { cleanup(); throw new TunnelError("cloudflared_not_found", "cloudflared was not found on PATH"); }
  const child = spawn(resolved.file, resolved.args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, env: tunnelEnv(parentEnv) });
  const exit = new Promise<void>((resolve) => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  const stop = async (): Promise<void> => {
    if (!exited(child)) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!exited(child)) child.kill("SIGKILL"); }, 2_000); timer.unref();
      await exit; clearTimeout(timer);
    } else await exit;
    cleanup();
  };
  const parser = createTunnelOutputParser();
  let ready: (() => void) | undefined; let failed: ((error: TunnelError) => void) | undefined;
  const startup = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const feed = (chunk: Buffer) => { parser.push(chunk.toString("utf8")); if (parser.registered) ready?.(); };
  child.stdout!.on("data", feed); child.stderr!.on("data", feed);
  child.once("error", (error: NodeJS.ErrnoException) => failed?.(error.code === "ENOENT"
    ? new TunnelError("cloudflared_not_found", "cloudflared was not found on PATH")
    : new TunnelError("tunnel_exited", `cloudflared could not start: ${error.message}`)));
  child.once("close", (code, signal) => failed?.(new TunnelError("tunnel_exited", `cloudflared exited before the tunnel was ready (${signal ?? code})`, parser.tail())));
  const timer = setTimeout(() => failed?.(new TunnelError("tunnel_timeout", `cloudflared did not register a tunnel within ${(options.timeoutMs ?? 45_000) / 1000} s`, parser.tail())), options.timeoutMs ?? 45_000);
  const onAbort = () => failed?.(new TunnelError("tunnel_cancelled", "Tunnel startup was cancelled"));
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
  try { await startup; }
  catch (error) { await stop(); throw error; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
  ready = failed = undefined;
  let closing: Promise<void> | undefined;
  return { url: parser.url!, closed: exit.then(cleanup), close: () => (closing ??= stop()) };
}
