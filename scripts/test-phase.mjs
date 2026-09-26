import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suites = {
  foundation: ["config", "prompt", "foundation-cli"],
  tools: ["primitives", "registry", "overhead"],
  providers: ["providers", "provider-content"],
  agent: ["agent", "agent-lifecycle"],
  context: ["compact", "cache", "usage"],
  mcp: ["mcp", "mcp-content"],
  acp: ["acp", "acp-client", "acp-transport"],
  cli: ["cli", "repl", "package"],
  sessions: ["session-store", "session-agent", "session-process", "session-cli", "session-api", "session-acp",
    "session-retention", "session-transition", "session-replay", "tool-plugins", "cache", "provider-content", "auto-compact"],
  sharing: ["package-manifest", "component-references", "skill-frontmatter", "skill-tools", "bundled-skills"],
};

const selector = process.argv[2];
const files = selector && Object.hasOwn(suites, selector)
  ? suites[selector].map((name) => `tests/${name}.test.ts`)
  : undefined;

if (!files || files.some((file) => !existsSync(file))) {
  process.stderr.write(`Unknown selector or missing suite: ${selector ?? "<none>"}\n`);
  process.exitCode = 1;
} else {
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (build && build.status !== 0) process.exitCode = build.status ?? 1;
  else {
    const configHome = mkdtempSync(join(tmpdir(), "raw-test-config-"));
    const stateHome = mkdtempSync(join(tmpdir(), "raw-test-state-"));
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
      stdio: "inherit",
      env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    });
    rmSync(configHome, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
    process.exitCode = result.status ?? 1;
  }
}
