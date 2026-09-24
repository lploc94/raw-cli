import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);

const required = ["config", "prompt", "foundation-cli", "primitives", "registry", "overhead", "providers",
  "provider-content", "agent", "agent-lifecycle", "compact", "cache", "usage", "mcp", "mcp-content",
  "acp", "acp-client", "acp-transport", "cli", "repl", "package"]
  .map((name) => `tests/${name}.test.ts`);
const missing = required.filter((file) => !files.includes(file));

if (files.length === 0 || missing.length) {
  process.stderr.write(`Missing required test files: ${missing.join(", ") || "all"}\n`);
  process.exitCode = 1;
} else {
  const configHome = mkdtempSync(join(tmpdir(), "raw-test-config-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
    stdio: "inherit",
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
  rmSync(configHome, { recursive: true, force: true });
  process.exitCode = result.status ?? 1;
}
