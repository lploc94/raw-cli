import { spawn } from "node:child_process";
import { DEFAULT_DASHBOARD_PORT, startDashboard } from "./server.js";
import { onShutdown } from "../platform/signals.js";
import { renderQr } from "./qr.js";
import { startQuickTunnel, TunnelError, type QuickTunnel } from "./tunnel.js";

export interface DashboardFlags { port?: number; configPath?: string; agent?: string; noOpen?: boolean; remote?: boolean; help?: boolean }
export function parseDashboardArgs(args: readonly string[]): DashboardFlags {
  const flags: DashboardFlags = {}; const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new Error(`duplicate dashboard option: ${arg}`); seen.add(arg);
    if (arg === "--no-open") { flags.noOpen = true; continue; }
    if (arg === "--remote") { flags.remote = true; continue; }
    if (arg === "--help" || arg === "-h") { flags.help = true; continue; }
    if (!["--port", "--config", "--agent"].includes(arg)) throw new Error(`unknown dashboard option: ${arg}`);
    const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--port") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535) throw new Error("port must be an integer from 0 to 65535");
      flags.port = Number(value);
    } else if (arg === "--config") flags.configPath = value;
    else flags.agent = value;
  }
  return flags;
}
export async function openDashboardBrowser(url: string, options: { command?: string } = {}): Promise<boolean> {
  const command = options.command ?? (process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open");
  const args = process.platform === "win32" && !options.command ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false, windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5_000); timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
const INSTALL_HINT = "install it (macOS: brew install cloudflared; other systems: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run again";
const REMOTE_NOTICE = "Cloudflare terminates TLS and can see this traffic. The address changes every run, and anyone who has the link can use this dashboard until you stop it.";
/** Why the tunnel is missing, for the single warning that keeps the local dashboard running. */
function tunnelWarning(error: unknown): string {
  if (error instanceof TunnelError && error.code === "cloudflared_not_found") return `raw: remote access is off: cloudflared was not found; ${INSTALL_HINT}\n`;
  const lines = error instanceof TunnelError && error.lines.length ? `\n${error.lines.map((line) => `  ${line}`).join("\n")}` : "";
  return `raw: remote access is off: ${error instanceof Error ? error.message : String(error)}${lines}\n`;
}
export interface DashboardCliDeps {
  startTunnel?: typeof startQuickTunnel;
  /** Output sinks, replaced by tests that run the CLI in-process. */
  stdout?: { write(text: string): unknown; isTTY?: boolean };
  stderr?: { write(text: string): unknown };
}
export async function runDashboardCli(flags: DashboardFlags, deps: DashboardCliDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? process.stdout; const stderr = deps.stderr ?? process.stderr;
  if (flags.help) {
    stdout.write("Usage: raw dashboard [--port 21517|0] [--no-open] [--remote] [--config PATH] [--agent NAME]\nRuns a local browser application until Ctrl-C. Port 0 chooses a free port.\n--remote also opens it through a Cloudflare quick tunnel (needs cloudflared) and prints a QR code for a phone.\n"); return;
  }
  const controller = new AbortController();
  // In remote mode the server stops after the tunnel, so it listens to its own controller rather than the CLI's.
  const serverController = flags.remote ? new AbortController() : controller;
  let stopped!: () => void; const stopRequested = new Promise<void>((resolve) => { stopped = resolve; });
  const stop = () => { controller.abort(); stopped(); };
  // Remote mode owns a child process: keep the handler until teardown is done so a second Ctrl-C cannot skip it, and a closed pipe stops the run through the same path.
  if (flags.remote) process.on("SIGINT", stop); else process.once("SIGINT", stop);
  const outputs = flags.remote ? [deps.stdout ? undefined : process.stdout, deps.stderr ? undefined : process.stderr].filter((stream) => stream !== undefined) : [];
  for (const stream of outputs) stream.on("error", stop);
  const offStop = onShutdown(stop);
  let server: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let tunnel: QuickTunnel | undefined;
  try {
    server = await startDashboard({ ...(flags.port === undefined ? {} : { port: flags.port }),
      ...(flags.configPath ? { configPath: flags.configPath } : {}), ...(flags.agent ? { agent: flags.agent } : {}), signal: serverController.signal });
    if (flags.port === undefined && server.port !== DEFAULT_DASHBOARD_PORT) stderr.write(`raw: port ${DEFAULT_DASHBOARD_PORT} is in use; using ${server.port}\n`);
    let remoteLink: string | undefined;
    if (flags.remote) {
      stderr.write("raw: starting a Cloudflare quick tunnel (this can take a few seconds)\n");
      try {
        tunnel = await (deps.startTunnel ?? startQuickTunnel)({ port: server.port, signal: controller.signal });
        const revoke = server.allowPublicOrigin(tunnel.url);
        remoteLink = `${tunnel.url}/#token=${server.token}`;
        void tunnel.closed.then(() => { if (controller.signal.aborted) return; revoke(); stderr.write("raw: the quick tunnel stopped; remote access is off, the local dashboard keeps running\n"); });
      } catch (error) {
        await tunnel?.close(); tunnel = undefined;
        if (controller.signal.aborted) throw error;
        stderr.write(tunnelWarning(error));
      }
    }
    if (remoteLink) {
      stdout.write(`Raw dashboard (remote): ${remoteLink}\n`);
      if (stdout.isTTY) { try { stdout.write(`${renderQr(remoteLink)}\n`); } catch { /* the link alone is enough */ } }
      stdout.write(`Raw dashboard: ${server.launchUrl}\n${REMOTE_NOTICE}\nPress Ctrl-C to stop.\n`);
    } else stdout.write(`Raw dashboard: ${server.launchUrl}\nPress Ctrl-C to stop.\n`);
    if (!flags.noOpen && !remoteLink && stdout.isTTY && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) {
      if (!await openDashboardBrowser(server.launchUrl)) stderr.write("raw: browser did not open; use the printed dashboard link\n");
    }
    await stopRequested;
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { await tunnel?.close(); serverController.abort(); await server?.close(); process.off("SIGINT", stop); for (const stream of outputs) stream.off("error", stop); offStop(); }
}
