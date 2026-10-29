import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "../config.js";
import type { AcpLaunch, AcpLaunchResolver } from "./acp-agent.js";
import { CODEX_ADAPTER, findExecutable, installedAdapter, type InstallContext } from "./adapters.js";

export const CODEX_MISSING = "Install Codex and log in (`codex`), or set backend.executable";
/** Codex fails to start a thread on an empty instructions file, so an explicit empty replacement cannot be honoured. */
export const CODEX_EMPTY_PROMPT = "Codex cannot run with an empty system prompt; it keeps its own";

/** Where each Codex runtime keeps the prompt file `model_instructions_file` names: one directory per runtime. */
export function codexPromptRoot(env: NodeJS.ProcessEnv): string {
  const state = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(homedir(), ".local", "state");
  return join(state, "raw", "backends", "codex");
}

/**
 * The thread config that carries the agent's system prompt (Fixed decision 2, Decision 2026-10-29): codex-acp merges
 * `CODEX_CONFIG` into every thread it starts. Replace names a prompt file and drops the environment and permission
 * notes Codex adds; append adds the text as developer instructions; an agent without a prompt sets nothing.
 */
export function codexConfig(runtime: RuntimeConfig, promptFile: string): Record<string, unknown> | undefined {
  if (!runtime.systemPrompt) return undefined;
  if (runtime.backend!.systemPromptMode === "append") return { developer_instructions: runtime.systemPrompt };
  return { model_instructions_file: promptFile, include_environment_context: false, include_permissions_instructions: false };
}

/** Removes prompt directories a Raw that ended without closing its runtime left behind, once they are older than `days`. */
export function sweepCodexPrompts(root: string, days: number, now = Date.now()): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    const directory = join(root, name);
    try { if (now - statSync(directory).mtimeMs > days * 86_400_000) rmSync(directory, { recursive: true, force: true }); }
    catch { /* gone already, or another Raw is removing it */ }
  }
}

/** Starts codex-acp under this Node, pointed at the user's `codex`, with the agent's prompt in `CODEX_CONFIG`. */
export function codexLaunch(runtime: RuntimeConfig, cwd: string, deps: Pick<InstallContext, "npm"> & { env?: NodeJS.ProcessEnv } = {}): AcpLaunchResolver {
  const env = deps.env ?? process.env;
  return async ({ notify, signal }): Promise<AcpLaunch> => {
    const executable = findExecutable(runtime.backend!.executable ?? "codex", env, cwd);
    if (!executable) throw new Error(CODEX_MISSING);
    const adapter = await installedAdapter(CODEX_ADAPTER, { env, notify, ...(signal ? { signal } : {}), ...(deps.npm ? { npm: deps.npm } : {}) });
    const root = codexPromptRoot(env);
    sweepCodexPrompts(root, runtime.sessionsRetentionDays);
    const directory = join(root, randomUUID());
    const config = codexConfig(runtime, join(directory, "prompt.md"));
    if (runtime.backendPromptGiven && !runtime.systemPrompt && runtime.backend!.systemPromptMode === "replace") notify(CODEX_EMPTY_PROMPT);
    let cleanup: (() => void) | undefined;
    let prepare: (() => void) | undefined;
    if (config?.model_instructions_file) {
      // The sweep goes by age: each adapter start marks the directory in use, and restores a prompt a sweep removed.
      prepare = () => {
        const file = join(directory, "prompt.md");
        if (!existsSync(file)) { mkdirSync(directory, { recursive: true }); writeFileSync(file, runtime.systemPrompt); }
        const now = new Date();
        utimesSync(directory, now, now);
      };
      prepare();
      cleanup = () => rmSync(directory, { recursive: true, force: true });
    }
    // A CODEX_CONFIG the user set keeps its other settings; the prompt settings are the agent's.
    let inherited: Record<string, unknown> = {};
    try { const parsed: unknown = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : {}; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) inherited = parsed as Record<string, unknown>; }
    catch { notify("CODEX_CONFIG is not a JSON object; Codex starts without it"); }
    const merged = { ...inherited, ...config };
    const launchEnv: NodeJS.ProcessEnv = { ...env, CODEX_PATH: executable };
    if (Object.keys(merged).length) launchEnv.CODEX_CONFIG = JSON.stringify(merged);
    else delete launchEnv.CODEX_CONFIG;
    return { command: process.execPath, args: [adapter], env: launchEnv, authHint: "run `codex login`", ...(cleanup ? { cleanup } : {}),
      ...(prepare ? { prepare } : {}) };
  };
}
