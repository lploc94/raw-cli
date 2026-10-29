import type { RuntimeConfig } from "../config.js";
import type { AcpLaunch, AcpLaunchResolver } from "./acp-agent.js";
import { CLAUDE_ADAPTER, findExecutable, installedAdapter, type InstallContext } from "./adapters.js";

export const CLAUDE_MISSING = "Install Claude Code and log in (`claude`), or set backend.executable";

/**
 * The `session/new` metadata that carries the agent's system prompt (Fixed decision 2): a string replaces Claude Code's
 * own prompt, `{ append }` adds to it, and an agent without a prompt sends none.
 */
export function claudeSessionMeta(runtime: RuntimeConfig): Record<string, unknown> | undefined {
  const prompt = runtime.systemPrompt;
  if (!prompt) return undefined;
  return { systemPrompt: runtime.backend!.systemPromptMode === "append" ? { append: prompt } : prompt };
}

/** Starts claude-agent-acp under this Node, pointed at the user's `claude` (never the adapter's own native binary). */
export function claudeLaunch(runtime: RuntimeConfig, cwd: string, deps: Pick<InstallContext, "npm"> & { env?: NodeJS.ProcessEnv } = {}): AcpLaunchResolver {
  const env = deps.env ?? process.env;
  return async ({ notify, signal }): Promise<AcpLaunch> => {
    const executable = findExecutable(runtime.backend!.executable ?? "claude", env, cwd);
    if (!executable) throw new Error(CLAUDE_MISSING);
    const adapter = await installedAdapter(CLAUDE_ADAPTER, { env, notify, ...(signal ? { signal } : {}), ...(deps.npm ? { npm: deps.npm } : {}) });
    const sessionMeta = claudeSessionMeta(runtime);
    return { command: process.execPath, args: [adapter], env: { ...env, CLAUDE_CODE_EXECUTABLE: executable },
      ...(sessionMeta ? { sessionMeta } : {}), authHint: "run `claude` once and log in" };
  };
}
