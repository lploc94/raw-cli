import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFilePath, loadConfig, parseCliArgs, readConfigDocument, readSessionRetentionDays, redact } from "../src/config.js";
import { createAcpServer } from "../src/acp/methods.js";
import { serveAcpStdio, serveAcpWebSocket } from "../src/acp/transport.js";
import { runCli } from "../src/cli.js";
import { renderStoredHistory } from "../src/sessions/display.js";
import { openSessionStore } from "../src/sessions/store.js";

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
       raw sessions [--all] [--before CURSOR]
       raw sessions show ID [--before CURSOR]
       raw sessions delete ID|stats
       raw --acp --stdio
       raw --acp --ws --host 127.0.0.1 --port 8765

Options:
  --profile NAME             Select a configured LLM profile
  --config PATH              Use one alternate config file
  --system-prompt TEXT       Replace the system prompt literally
  --max-steps N              Maximum inference requests (default 25)
  --max-output-bytes N       Model-facing tool result cap (default 8192)
  --request-timeout-ms N     Inference/MCP deadline (default 120000)
  --interactive              Start a terminal REPL
  --continue                 Resume latest session in current workspace
  --resume ID                Resume a selected session in its stored cwd
  -y, --auto-approve         Compatibility alias (tools run automatically)
  --help, --version          Show help or version

Session options: --all (list all workspaces), --before CURSOR (older page)

REPL: /compact, /clear, /stats, /exit
Config: models define access paths; profiles select a model, MCP tools and policy.
Vision: a model with vision=true gets view_image; no image flag is needed.
Compact: profile compact.trigger_tokens enables automatic compaction.
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
      models: {
        local: {
          provider: "ollama",
          method: "openai-chat-completions",
          model_id: "YOUR_INSTALLED_MODEL",
          base_url: "http://127.0.0.1:11434/v1",
        },
      },
      profiles: { local: { model: "local" } },
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
    const models = document.data.models;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
      process.stdout.write("No configured profiles.\n");
      return;
    }
    for (const [name, raw] of Object.entries(profiles)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const data = raw as Record<string, unknown>;
      const alias = String(data.model ?? "?");
      const model = models && typeof models === "object" && !Array.isArray(models)
        ? (models as Record<string, unknown>)[alias] : undefined;
      const spec = model && typeof model === "object" && !Array.isArray(model) ? model as Record<string, unknown> : {};
      const endpoint = typeof spec.base_url === "string" ? redact(spec.base_url) : "default endpoint";
      const selectedMcp = data.mcp && typeof data.mcp === "object" && !Array.isArray(data.mcp)
        ? Object.entries(data.mcp).map(([server, tools]) => `${server}:${tools === "*" ? "*" : Array.isArray(tools) ? tools.join(",") : "?"}`).join(";") : "";
      const policy = data.tools && typeof data.tools === "object" && !Array.isArray(data.tools)
        ? (data.tools as { rules?: Array<{ match: string; effect: string }> }).rules ?? [] : [];
      const rules = policy.map((rule) => `${rule.effect}:${rule.match}`).join(",");
      const compact = data.compact && typeof data.compact === "object" && !Array.isArray(data.compact)
        ? data.compact as Record<string, unknown> : {};
      process.stdout.write(`${name}\t${alias}\t${String(spec.model_id ?? "?")}\t${String(spec.provider ?? "?")}\t${String(spec.method ?? "?")}\t${endpoint}`
        + `\tvision=${spec.vision === true}\tmcp=${selectedMcp || "none"}\trules=${rules || "default-allow"}`
        + `\ttrigger=${compact.trigger_tokens ?? "manual"}\n`);
    }
    return;
  }
  if (parsed.command === "acp") {
    const runtime = await inputAsync(() => loadConfig({ flags: parsed.flags }));
    const mcpServers = runtime.mcpServers;
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
  const store = input(() => openSessionStore());
  try {
    if (parsed.command.startsWith("sessions-")) {
      if (parsed.command === "sessions-list") {
        const page = input(() => store.listSessions({ ...(parsed.flags.allSessions ? {} : { cwd: process.cwd() }),
          ...(parsed.flags.before ? { before: parsed.flags.before } : {}) }));
        const retention = input(() => readSessionRetentionDays());
        for (const item of page.items) {
          process.stdout.write(`${item.id}\t${item.title}\t${item.cwd}\t${item.profileName ?? "?"}/${item.modelId ?? "?"}`
            + `\t${new Date(item.updatedAt).toISOString()}\t${new Date(item.updatedAt + retention * 86_400_000).toISOString()}\n`);
        }
        if (page.nextCursor) process.stdout.write(`next: ${page.nextCursor}\n`);
      } else if (parsed.command === "sessions-show") {
        const page = input(() => store.getSessionHistory({ sessionId: parsed.sessionId!,
          ...(parsed.flags.before ? { before: parsed.flags.before } : {}) }));
        for (const item of page.items) process.stdout.write(`${renderStoredHistory(item)}\n`);
        if (page.nextCursor) process.stdout.write(`next: ${page.nextCursor}\n`);
      } else if (parsed.command === "sessions-delete") {
        if (!store.getSession(parsed.sessionId!)) throw new InputError("session not found or expired");
        input(() => store.deleteSession(parsed.sessionId!));
        process.stdout.write(`Deleted ${parsed.sessionId}\n`);
      } else process.stdout.write(`${JSON.stringify(store.storageStats())}\n`);
      return;
    }
    const selected = input(() => parsed.flags.continue
      ? store.listSessions({ cwd: process.cwd(), limit: 1 }).items[0]
      : parsed.flags.resumeId ? store.getSession(parsed.flags.resumeId) : undefined);
    if ((parsed.flags.continue || parsed.flags.resumeId) && !selected) throw new InputError("session not found or expired");
    let runtime;
    if (selected) {
      const savedConfigPath = selected.configPath;
      const savedProfileName = selected.profileName;
      if (!savedConfigPath || !savedProfileName) throw new InputError("saved session has no config/profile identity");
      if (parsed.flags.profile && parsed.flags.profile !== savedProfileName) throw new InputError("explicit --profile differs from saved session");
      if (parsed.flags.configPath && configFilePath({ flags: parsed.flags }) !== savedConfigPath) {
        throw new InputError("explicit --config differs from saved session");
      }
      runtime = await inputAsync(() => loadConfig({ cwd: selected.cwd, flags: {
        ...parsed.flags, configPath: savedConfigPath, profile: savedProfileName,
      }, requireModel: true }));
      process.stderr.write(`raw: resuming in ${selected.cwd}\n`);
    } else runtime = await inputAsync(() => loadConfig({ flags: parsed.flags, requireModel: true }));
    process.exitCode = await runCli(runtime, parsed.command === "task" ? parsed.task : undefined,
      runtime.mcpServers, store, selected);
  } finally { store.close(); }
}

void run().catch((error) => {
  process.stderr.write(`raw: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = error instanceof InputError ? 2 : 1;
});
