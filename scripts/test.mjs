import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);

const required = ["dashboard-sessions", "dashboard-streams", "dashboard-approval", "dashboard-server", "dashboard-cli", "management-config", "management-components", "config", "prompt", "foundation-cli", "primitives", "registry", "overhead", "providers",
  "provider-content", "agent", "agent-lifecycle", "compact", "cache", "usage", "mcp", "mcp-content",
  "acp", "acp-client", "acp-transport", "cli", "repl", "package", "session-operations", "session-view", "session-store", "session-agent", "session-process", "session-cli", "session-api", "session-acp", "session-retention", "session-transition", "session-replay", "tool-plugins", "package-manifest", "component-references", "skill-frontmatter", "package-export", "package-archive", "package-store", "package-lifecycle", "package-config", "package-cli", "package-runtime", "package-sharing-installed"]
  .map((name) => `tests/${name}.test.ts`);
const missing = required.filter((file) => !files.includes(file));

if (files.length === 0 || missing.length) {
  process.stderr.write(`Missing required test files: ${missing.join(", ") || "all"}\n`);
  process.exitCode = 1;
} else {
  const configHome = mkdtempSync(join(tmpdir(), "raw-test-config-"));
  const stateHome = mkdtempSync(join(tmpdir(), "raw-test-state-"));
  const dataHome = mkdtempSync(join(tmpdir(), "raw-test-data-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
    stdio: "inherit",
    env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, XDG_DATA_HOME: dataHome },
  });
  rmSync(configHome, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
  rmSync(dataHome, { recursive: true, force: true });
  process.exitCode = result.status ?? 1;
}
