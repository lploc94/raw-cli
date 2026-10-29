#!/usr/bin/env node
// A stand-in `codex` for codex-acp: `codex app-server` answers every request with an empty result and logs each
// message (and its argv) as one JSON line to FAKE_CODEX_LOG, so a test sees what the real adapter sent Codex.
import { appendFileSync } from "node:fs";

const log = (message) => appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(message)}\n`);
log({ argv: process.argv.slice(2) });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log(message);
    if (message.id !== undefined && message.method) process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  }
});
