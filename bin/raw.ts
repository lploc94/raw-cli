import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFilePath, parseCliArgs, readConfigDocument, redact } from "../src/config.js";

const version = "0.1.0";

function help(): string {
  return `raw-cli ${version}
Usage: raw [options] [task]
       raw config init|list
       raw --acp --stdio

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
  -y, --auto-approve         Skip tool confirmation
  --help, --version          Show help or version
`;
}

function run(): void {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.command === "help") { process.stdout.write(help()); return; }
  if (parsed.command === "version") { process.stdout.write(`${version}\n`); return; }
  if (parsed.command === "config-init") {
    const path = configFilePath({ flags: parsed.flags });
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`Created ${path}\n`);
    return;
  }
  if (parsed.command === "config-list") {
    const document = readConfigDocument({ flags: parsed.flags });
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
  throw new Error(`The ${parsed.command} mode is not implemented in Phase 1`);
}

try {
  run();
} catch (error) {
  process.stderr.write(`raw: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 2;
}
