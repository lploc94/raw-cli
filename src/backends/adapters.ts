import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isRegularFile, prepareSpawn, terminateTree } from "../platform/windows.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../tools/results.js";

/** An ACP adapter Raw installs from npm on first use; never bundled (the Claude one contains proprietary code). */
export interface AdapterPackage { name: string; version: string; entry: string }

export const CLAUDE_ADAPTER: AdapterPackage = { name: "@agentclientprotocol/claude-agent-acp", version: "0.98.0", entry: "dist/index.js" };
export const CODEX_ADAPTER: AdapterPackage = { name: "@agentclientprotocol/codex-acp", version: "2.3.0", entry: "dist/index.js" };

/** How long a cancelled install's processes get after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 1000;

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

/**
 * Runs npm as its own process group (a job on Windows), so cancelling the install stops everything npm started. No
 * deadline of its own: a slow first download is not a failure, and the user can cancel the turn.
 */
function runNpm(env: NodeJS.ProcessEnv) {
  return (args: string[], cwd: string, signal?: AbortSignal) => new Promise<void>((done, fail) => {
    const prepared = prepareSpawn("npm", args, { cwd, env });
    if (!prepared.ok) { fail(new AdapterInstallError(`npm was not found (${prepared.message}); install Node.js with npm`)); return; }
    const posix = process.platform !== "win32";
    const child = spawn(prepared.file, prepared.args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: posix,
      ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    let stderr = Buffer.alloc(0);
    let dropped = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > DEFAULT_MAX_OUTPUT_BYTES) { stderr = stderr.subarray(stderr.length - DEFAULT_MAX_OUTPUT_BYTES); dropped = true; }
    });
    const group = (name: NodeJS.Signals | 0): boolean => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, name); return true; }
      catch { return false; }
    };
    const stop = async () => {
      if (!posix) { terminateTree(child, { jobbed: prepared.jobbed, env }); return; }
      if (!group("SIGTERM")) return;
      for (let waited = 0; waited < STOP_GRACE_MS && group(0); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      group("SIGKILL");
    };
    const onAbort = () => { void stop(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { signal?.removeEventListener("abort", onAbort); fail(new AdapterInstallError(`npm could not start: ${error.message}`)); });
    // `exit`, not `close`: a descendant that keeps stderr open must not hold the install; what npm left behind is stopped.
    child.once("exit", (code, killed) => {
      signal?.removeEventListener("abort", onAbort);
      void (posix && group(0) ? stop() : Promise.resolve()).then(() => {
        child.stderr.destroy();
        const tail = `${dropped ? "[stderr truncated]\n" : ""}${stderr.toString("utf8")}`.trim();
        if (code === 0) done();
        else if (signal?.aborted) fail(new AdapterInstallError("install cancelled"));
        else fail(new AdapterInstallError(`npm install ${args.at(-1)} failed (${killed ?? `code ${code}`})${tail ? `: ${tail}` : ""}`));
      });
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
    // As the OS looks it up: a relative entry is relative to the working directory, and on POSIX an empty one is it.
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!directory && windows) continue;
    const found = candidates(join(resolve(cwd, directory), command)).find(usable);
    if (found) return found;
  }
  return undefined;
}
