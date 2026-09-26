import { spawn } from "node:child_process";
import { startDashboard } from "./server.js";

export interface DashboardFlags { port?: number; configPath?: string; agent?: string; noOpen?: boolean; help?: boolean }
export function parseDashboardArgs(args: readonly string[]): DashboardFlags {
  const flags: DashboardFlags = {}; const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) throw new Error(`duplicate dashboard option: ${arg}`); seen.add(arg);
    if (arg === "--no-open") { flags.noOpen = true; continue; }
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
    const child = spawn(command, args, { stdio: "ignore", shell: false });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5_000); timer.unref();
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
export async function runDashboardCli(flags: DashboardFlags): Promise<void> {
  if (flags.help) {
    process.stdout.write("Usage: raw dashboard [--port 8787|0] [--no-open] [--config PATH] [--agent NAME]\nRuns a local browser application until Ctrl-C. Port 0 chooses a free port.\n"); return;
  }
  const controller = new AbortController();
  let stopped!: () => void; const stopRequested = new Promise<void>((resolve) => { stopped = resolve; });
  const stop = () => { controller.abort(); stopped(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let server: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    server = await startDashboard({ ...(flags.port === undefined ? {} : { port: flags.port }),
      ...(flags.configPath ? { configPath: flags.configPath } : {}), ...(flags.agent ? { agent: flags.agent } : {}), signal: controller.signal });
    process.stdout.write(`Raw dashboard: ${server.launchUrl}\nPress Ctrl-C to stop.\n`);
    if (!flags.noOpen && process.stdout.isTTY && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) {
      if (!await openDashboardBrowser(server.launchUrl)) process.stderr.write("raw: browser did not open; use the printed dashboard link\n");
    }
    await stopRequested;
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { await server?.close(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
