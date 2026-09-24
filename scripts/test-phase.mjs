import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const suites = {
  foundation: ["config", "prompt", "foundation-cli"],
  tools: ["primitives", "registry", "overhead"],
  providers: ["providers", "provider-content"],
  agent: ["agent", "agent-lifecycle"],
  context: ["compact", "cache", "usage"],
  mcp: ["mcp", "mcp-content"],
  acp: ["acp", "acp-client", "acp-transport"],
  cli: ["cli", "repl", "package"],
};

const selector = process.argv[2];
const files = selector && Object.hasOwn(suites, selector)
  ? suites[selector].map((name) => `tests/${name}.test.ts`)
  : undefined;

if (!files || files.some((file) => !existsSync(file))) {
  process.stderr.write(`Unknown selector or missing suite: ${selector ?? "<none>"}\n`);
  process.exitCode = 1;
} else {
  const build = selector === "cli" ? spawnSync("npm", ["run", "build"], { stdio: "inherit" }) : undefined;
  if (build && build.status !== 0) process.exitCode = build.status ?? 1;
  else {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
  }
}
