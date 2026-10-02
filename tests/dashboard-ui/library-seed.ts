import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/** Opens a dashboard path directly; the launch URL's fragment carries the session token. */
export const openPath = (page: Page, launchUrl: string, path: string) =>
  page.goto(launchUrl.replace(/\/?(\?|#|$)/, `${path}$1`));

/** A package source folder with one tool and one agent export. */
export function packageSource(root: string, folderName = "shared-kit") {
  const folder = join(root, folderName);
  cpSync(join(process.cwd(), "examples/packages/tool-only"), folder, { recursive: true });
  mkdirSync(join(folder, "agents"));
  writeFileSync(join(folder, "agents/writer.json"), JSON.stringify({ system_prompt: { $input: "prompt" }, tools: { use: [] } }));
  const manifest = JSON.parse(readFileSync(join(folder, "raw-package.json"), "utf8"));
  manifest.files.push("agents/writer.json");
  manifest.exports.agents = { writer: "agents/writer.json" };
  manifest.inputs = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
  writeFileSync(join(folder, "raw-package.json"), JSON.stringify(manifest));
  return folder;
}

type Raw = { root: string; configPath: string; json: <T>(path: string, method?: string, body?: unknown) => Promise<T> };

/** Populates every Library section: a tool, skill and hook, vars, a provider, MCP servers and a package. */
export async function seedLibrary(raw: Raw) {
  await raw.json("/components/tools", "POST", { id: "local/probe", cloneFrom: "builtin/read_file" });
  await raw.json("/components/skills", "POST", { id: "local/guide", cloneFrom: "builtin/create_skill" });
  await raw.json("/components/hooks", "POST", {
    id: "local/guard",
    files: {
      "hook.json": JSON.stringify({ protocol_version: 2, name: "guard", command: "node", args: ["./index.mjs"], timeout_ms: 4000,
        events: [{ name: "PreToolUse", match: "builtin/bash", when: { source: "arguments", any: "commands[*].command", regex: "(^|[;& ]+)rm[ ]" } }, { name: "Stop" }] }),
      "index.mjs": "process.stdout.write('{}');\n",
    },
  });
  const config = JSON.parse(readFileSync(raw.configPath, "utf8"));
  config.var_providers = { host_label: { command: "node", args: ["provider.mjs"] } };
  config.vars = {
    greeting: { description: "A greeting shown at the start of a chat", type: "string", access: "read", source: { kind: "literal", value: "Hello" } },
    deploy_token: { description: "Deployment token passed to Bash", access: "use", source: { kind: "env", name: "DEPLOY_TOKEN" } },
    host: { description: "Machine label", access: "read", source: { kind: "provider", name: "host_label" } },
  };
  config.mcp = { servers: {
    search: { transport: "stdio", command: "node", args: ["server.mjs"] },
    remote_docs: { transport: "streamable-http", url: "https://example.invalid/mcp" },
  } };
  config.agents.raw.vars = ["greeting"];
  const tools = config.agents.raw.tools ?? {};
  config.agents.raw.tools = { ...tools, use: [...new Set([...(tools.use ?? []), "builtin/read_file", "local/probe", "mcp/remote_docs/search"])] };
  writeFileSync(raw.configPath, JSON.stringify(config));
  const stage = await raw.json<{ id: string }>("/packages/inspect", "POST", { path: packageSource(raw.root) });
  await raw.json("/packages/install", "POST", { stageId: stage.id, alias: "shared", action: "install" });
}
