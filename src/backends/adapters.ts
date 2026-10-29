import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { isRegularFile, prepareSpawn } from "../platform/windows.js";

/** An ACP adapter Raw installs from npm on first use; never bundled (the Claude one contains proprietary code). */
export interface AdapterPackage { name: string; version: string; entry: string }

export const CLAUDE_ADAPTER: AdapterPackage = { name: "@agentclientprotocol/claude-agent-acp", version: "0.98.0", entry: "dist/index.js" };
export const CODEX_ADAPTER: AdapterPackage = { name: "@agentclientprotocol/codex-acp", version: "2.3.0", entry: "dist/index.js" };

/** How long one npm install may take: a first download over a slow network. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const STDERR_TAIL = 4000;

export interface InstallContext {
  env: NodeJS.ProcessEnv;
  notify: (message: string) => void;
  signal?: AbortSignal;
  /** Runs npm with `args` in `cwd`; replaced in tests. */
  npm?: (args: string[], cwd: string, signal?: AbortSignal) => Promise<void>;
}

export class AdapterInstallError extends Error {
  constructor(message: string) { super(message); this.name = "AdapterInstallError"; }
}

/** Where installed adapters live: beside Raw's packages, one directory per exact version. */
export function adapterDirectory(adapter: AdapterPackage, env: NodeJS.ProcessEnv): string {
  const data = env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(homedir(), ".local", "share");
  return join(data, "raw", "adapters", `${adapter.name.replace("/", "__")}@${adapter.version}`);
}

const entryIn = (directory: string, adapter: AdapterPackage) => join(directory, "node_modules", ...adapter.name.split("/"), adapter.entry);

/**
 * The adapter's entry script, installing it first when it is not there. Optional dependencies are omitted: they are the
 * CLIs' own native binaries, and Raw always points the adapter at the user's installed CLI. Concurrent Raw processes each
 * install into their own directory and the first rename wins.
 */
export async function installedAdapter(adapter: AdapterPackage, context: InstallContext): Promise<string> {
  const directory = adapterDirectory(adapter, context.env);
  const entry = entryIn(directory, adapter);
  if (existsSync(entry)) return entry;
  context.notify(`Installing ${adapter.name}@${adapter.version} from npm (first use; once per version)`);
  const staging = `${directory}.${process.pid}-${randomUUID().slice(0, 8)}`;
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, "package.json"), `${JSON.stringify({ private: true })}\n`);
    await (context.npm ?? runNpm(context.env))(["install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund",
      "--save-exact", `${adapter.name}@${adapter.version}`], staging, context.signal);
    if (!existsSync(entryIn(staging, adapter))) throw new AdapterInstallError(`npm installed ${adapter.name} without ${adapter.entry}`);
    try { renameSync(staging, directory); }
    catch (error) { if (!existsSync(entry)) throw error; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return entry;
}

function runNpm(env: NodeJS.ProcessEnv) {
  return (args: string[], cwd: string, signal?: AbortSignal) => new Promise<void>((done, fail) => {
    const prepared = prepareSpawn("npm", args, { cwd, env });
    if (!prepared.ok) { fail(new AdapterInstallError(`npm was not found (${prepared.message}); install Node.js with npm`)); return; }
    const child = spawn(prepared.file, prepared.args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL); });
    const timer = setTimeout(() => child.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { clearTimeout(timer); fail(new AdapterInstallError(`npm could not start: ${error.message}`)); });
    child.once("close", (code, killed) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) done();
      else if (signal?.aborted) fail(new AdapterInstallError("install cancelled"));
      else fail(new AdapterInstallError(`npm install ${args.at(-1)} failed (${killed ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

/**
 * The absolute path of `command` as the OS would find it, or undefined when it is not installed. The adapters start the
 * CLI without a shell, so they get this path rather than a bare name (on Windows a name may also be `claude.exe`).
 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const windows = process.platform === "win32";
  const usable = windows ? isRegularFile : (file: string) => { try { accessSync(file, constants.X_OK); return isRegularFile(file); } catch { return false; } };
  const extensions = windows ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())] : [""];
  const candidates = (base: string) => extensions.map((ext) => base + ext);
  if (/[\\/]/.test(command)) return candidates(resolve(cwd, command)).find(usable);
  for (const entry of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!directory || !isAbsolute(directory)) continue;
    const found = candidates(join(directory, command)).find(usable);
    if (found) return found;
  }
  return undefined;
}
