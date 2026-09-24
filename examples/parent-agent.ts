import { resolve } from "node:path";
import { createAcpClient } from "../src/acp/client.js";

const cwd = resolve(process.argv[2] ?? process.cwd());
const task = process.argv.slice(3).join(" ");
if (!task) throw new Error("usage: node --import tsx examples/parent-agent.ts <cwd> <task>");

const parent = await createAcpClient({
  command: process.env.RAW_BINARY ?? "raw",
  args: ["--acp", "--stdio", "-y"],
  onUpdate(notification) {
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") process.stdout.write(update.content.text);
  },
});

try {
  const sessionId = await parent.newSession(cwd);
  const result = await parent.prompt(sessionId, task);
  process.stdout.write(`\n[${result.stopReason}]\n`);
} finally { await parent.close(); }
