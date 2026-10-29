// Runs Raw's real terminal host (runCli) with a session agent that is not Raw's loop and an agent without a Raw model.
// argv: <config path> [task]; SEAM_LOG receives the agents' recorded calls as JSON when the host returns.
import { writeFileSync } from "node:fs";
import { loadConfig } from "../../src/config.js";
import { runCli } from "../../src/cli.js";
import { openSessionStore } from "../../src/sessions/store.js";
import { FakeSessionAgent } from "./fake-session-agent.js";

const [configPath, task] = process.argv.slice(2);
const runtime = await loadConfig({ configPath: configPath! });
if (runtime.modelConfig) throw new Error("the seam test needs an agent without a Raw model");
const store = openSessionStore();
const agents: FakeSessionAgent[] = [];
const code = await runCli(runtime, task, store, undefined, { createSessionAgent: () => {
  const agent = new FakeSessionAgent(`fake${agents.length + 1}`); agents.push(agent); return agent;
} });
writeFileSync(process.env.SEAM_LOG!, JSON.stringify({ code, agents: agents.map((agent) => agent.calls),
  sessions: store.listSessions().items.map((session) => session.agentName) }));
store.close();
process.exitCode = code;
