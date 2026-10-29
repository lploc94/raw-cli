import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSessionStore } from "../src/sessions/store.js";

// Real CLIs, real accounts, network: run with RAW_LIVE_BACKENDS=claude,codex,agy on a machine where they are logged in.
const LIVE = new Set((process.env.RAW_LIVE_BACKENDS ?? "").split(",").map((kind) => kind.trim()).filter(Boolean));
const RAW = join(import.meta.dirname, "..", "bin", "raw.ts");

interface Live { root: string; work: string; env: NodeJS.ProcessEnv; config: string }

function live(kind: string, backend: Record<string, unknown>, tag: string): Live {
  const root = mkdtempSync(join(tmpdir(), `raw-live-${kind}-`));
  const work = join(root, "work");
  mkdirSync(work);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ default_agent: `${kind}-live`, agents: { [`${kind}-live`]: { backend,
    system_prompt: `You are ${tag}. Begin every reply with the exact text ${tag}. Use your own tools for file work.`, tools: { use: [] } } } }));
  // Adapters are installed into the user's data directory once, as a real first use would; sessions stay in the temp root.
  const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return { root, work, config, env: { ...process.env, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: data } };
}

function raw(target: Live, args: string[]): { stdout: string; stderr: string; status: number | null; session?: string } {
  const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), RAW, "--config", target.config, ...args],
    { cwd: target.work, env: target.env, encoding: "utf8", timeout: 300_000 });
  const session = /raw --resume (\S+)/.exec(run.stderr)?.[1];
  return { stdout: run.stdout, stderr: run.stderr, status: run.status, ...(session ? { session } : {}) };
}

function usedModels(target: Live, session: string): string[] {
  const store = openSessionStore({ env: target.env });
  try {
    const owner = store.claimSession(session);
    const state = store.readAgentState(session, owner);
    store.releaseSession(session, owner);
    return JSON.stringify(state).match(/"models":\[[^\]]*\]/g)?.flatMap((list) => JSON.parse(list.slice(9)) as string[]) ?? [];
  } finally { store.close(); }
}

test("claude: the agent's prompt replaces Claude Code's, its own tools write the file, the chosen model runs, --continue resumes",
  { skip: !LIVE.has("claude") && "set RAW_LIVE_BACKENDS=claude" }, () => {
  const tag = `RAW-TAG-${randomBytes(3).toString("hex").toUpperCase()}`;
  const target = live("claude", { kind: "claude", model: "haiku" }, tag);
  try {
    const first = raw(target, ["Create a file hello.txt in the current directory containing exactly: hello raw. Then reply done."]);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes(tag), first.stdout);
    assert.equal(readFileSync(join(target.work, "hello.txt"), "utf8").trim(), "hello raw");
    assert.ok(first.session);
    assert.ok(usedModels(target, first.session!).some((model) => /haiku/i.test(model)), "haiku reported by the CLI");
    const nonce = `N-${randomBytes(4).toString("hex")}`;
    const second = raw(target, ["--continue", `Remember this code: ${nonce}. Reply only OK.`]);
    assert.equal(second.status, 0, second.stderr);
    const third = raw(target, ["--continue", "What code did I ask you to remember? Reply with the code only."]);
    assert.equal(third.status, 0, third.stderr);
    assert.ok(third.stdout.includes(nonce), third.stdout);
  } finally { rmSync(target.root, { recursive: true, force: true }); }
});
