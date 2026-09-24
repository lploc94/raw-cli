import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFilePath, loadConfig, parseCliArgs, readConfigDocument, redact } from "../src/config.js";
import { createAcpServer } from "../src/acp/methods.js";
import { serveAcpStdio, serveAcpWebSocket } from "../src/acp/transport.js";
import { runCli } from "../src/cli.js";
import { loadMcpConfig } from "../src/tools/mcp-client.js";

const version = "0.1.0";
class InputError extends Error {}

function input<T>(read: () => T): T {
  try { return read(); }
  catch (error) { throw new InputError(error instanceof Error ? error.message : String(error)); }
}

async function inputAsync<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) { throw new InputError(error instanceof Error ? error.message : String(error)); }
}

function help(): string {
  return `raw-cli ${version}
Usage: raw [options] [task]
       raw config init|list
       raw --acp --stdio
       raw --acp --ws --host 127.0.0.1 --port 8765

Options:
  --profile NAME             Select a configured LLM profile
  --provider NAME            Select provider directly
  --model NAME               Select model directly
  --base-url URL             Compatible API endpoint
  --config PATH              Use one alternate config file
  --system-prompt TEXT       Replace the system prompt literally
  --max-steps N              Maximum inference requests (default 25)
  --max-output-bytes N       Model-facing tool result cap (default 8192)
  --request-timeout-ms N     Inference/MCP deadline (default 120000)
  --interactive              Start a terminal REPL
  -y, --auto-approve         Compatibility alias (tools run automatically)
  --help, --version          Show help or version

REPL: /compact, /clear, /stats, /exit
Exit: 0 complete, 1 runtime error, 2 invalid input, 3 max steps, 130 cancelled
`;
}

async function run(): Promise<void> {
  const parsed = input(() => parseCliArgs(process.argv.slice(2)));
  if (parsed.command === "help") { process.stdout.write(help()); return; }
  if (parsed.command === "version") { process.stdout.write(`${version}\n`); return; }
  if (parsed.command === "config-init") {
    const path = input(() => configFilePath({ flags: parsed.flags }));
    const starter = {
      default_profile: "local",
      profiles: {
        local: {
          provider: "ollama",
          model: "YOUR_INSTALLED_MODEL",
          base_url: "http://127.0.0.1:11434/v1",
        },
      },
    };
    input(() => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    });
    process.stdout.write(`Created ${path}\n`);
    return;
  }
  if (parsed.command === "config-list") {
    const document = input(() => readConfigDocument({ flags: parsed.flags }));
    const profiles = document.data.profiles;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
      process.stdout.write("No configured profiles.\n");
      return;
    }
    for (const [name, raw] of Object.entries(profiles)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const data = raw as Record<string, unknown>;
      const endpoint = typeof data.base_url === "string" ? redact(data.base_url) : "default endpoint";
      process.stdout.write(`${name}\t${String(data.provider ?? "?")}\t${String(data.model ?? "?")}\t${endpoint}\n`);
    }
    return;
  }
  if (parsed.command === "acp") {
    const runtime = await inputAsync(() => loadConfig({ flags: parsed.flags }));
    const mcpServers = input(() => loadMcpConfig());
    if (parsed.acpTransport !== "ws") {
      await serveAcpStdio(createAcpServer({ runtime, mcpServers }));
      return;
    }
    const listener = await serveAcpWebSocket({ host: parsed.flags.host ?? "127.0.0.1", port: parsed.flags.port ?? 8765,
      serverFactory: () => createAcpServer({ runtime, mcpServers }) });
    process.stderr.write(`raw: ACP WebSocket listening on 127.0.0.1:${listener.port}\n`);
    await new Promise<void>((resolve) => {
      const stop = () => { void listener.close().then(resolve); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const runtime = await inputAsync(() => loadConfig({ flags: parsed.flags, requireModel: true }));
  const mcpServers = input(() => loadMcpConfig());
  process.exitCode = await runCli(runtime, parsed.command === "task" ? parsed.task : undefined, mcpServers);
}

void run().catch((error) => {
  process.stderr.write(`raw: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = error instanceof InputError ? 2 : 1;
});
