import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLAUDE_ADAPTER, adapterDirectory } from "../../src/backends/adapters.js";

const FAKE = join(import.meta.dirname, "fake-acp-agent.mjs");

/**
 * A `claude` on PATH and an installed "adapter" that is the scripted ACP agent, so Raw's real Claude Code launch runs
 * it. Returns the environment that points there; the agent logs its calls under `<root>/fake`.
 */
export function fakeClaudeEnv(root: string): Record<string, string> {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  chmodSync(claude, 0o755);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, XDG_DATA_HOME: join(root, "data"), FAKE_ACP_STATE: join(root, "fake") };
  const entry = join(adapterDirectory(CLAUDE_ADAPTER, env), "node_modules", ...CLAUDE_ADAPTER.name.split("/"), CLAUDE_ADAPTER.entry);
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(FAKE).href)};\n`);
  return env;
}
