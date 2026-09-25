import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function cli(args: string[], xdg: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "bin/raw.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: xdg, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" },
    timeout: 5000,
  });
}

test("T-01d: help/version do not need config or provider credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "raw-cli-"));
  const help = cli(["--help"], home);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /raw/);
  const version = cli(["--version"], home);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /0\.1\.0/);
});

test("T-01d: config init creates valid local starter, refuses overwrite, list is sanitized", () => {
  const home = mkdtempSync(join(tmpdir(), "raw-cli-"));
  const init = cli(["config", "init"], home);
  assert.equal(init.status, 0, init.stderr);
  const path = join(home, "raw", "config.json");
  const created = readFileSync(path, "utf8");
  const data = JSON.parse(created);
  assert.equal(data.default_agent, "local");
  assert.equal(data.models.local.provider, "ollama");
  assert.equal(data.agents.local.model, "local");
  const second = cli(["config", "init"], home);
  assert.notEqual(second.status, 0);
  assert.equal(readFileSync(path, "utf8"), created);
  const listed = cli(["config", "list"], home);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /local.*ollama/s);
  assert.doesNotMatch(listed.stdout, /API_KEY|secret/);
});

test("T-01d: config list redacts endpoint credentials and invalid flags fail before execution", () => {
  const home = mkdtempSync(join(tmpdir(), "raw-cli-"));
  mkdirSync(join(home, "raw"));
  writeFileSync(join(home, "raw", "config.json"), JSON.stringify({
    models: { remote: { provider: "custom", method: "openai-chat-completions", model_id: "m", base_url: "https://alice:pw@example.com/v1?token=secret" } },
    agents: { remote: { model: "remote", tools: { use: [] } } },
  }));
  const listed = cli(["config", "list"], home);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /remote/);
  assert.doesNotMatch(listed.stdout, /alice|pw|secret/);
  const invalid = cli(["--max-steps", "0", "write sentinel"], home);
  assert.equal(invalid.status, 2);
});

test("T-01e: selected official SDKs import and construct minimal clients", async () => {
  const { default: OpenAI } = await import("openai");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { GoogleGenAI } = await import("@google/genai");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const acp = await import("@agentclientprotocol/sdk");
  assert.ok(new OpenAI({ apiKey: "fixture" }));
  assert.ok(new Anthropic({ apiKey: "fixture" }));
  assert.ok(new GoogleGenAI({ apiKey: "fixture" }));
  assert.ok(typeof Client === "function");
  assert.ok(Object.keys(acp).length > 0);
});

test("T-01b: config list redacts uppercase URL credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "raw-cli-"));
  mkdirSync(join(home, "raw"));
  writeFileSync(join(home, "raw", "config.json"), JSON.stringify({
    models: { remote: { provider: "custom", method: "openai-chat-completions", model_id: "m", base_url: "HTTPS://alice:pw@example.com/v1?token=secret" } },
    agents: { remote: { model: "remote", tools: { use: [] } } },
  }));
  const listed = cli(["config", "list"], home);
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout + listed.stderr, /alice|pw|secret/);
});

test("config list reports model capability, selected MCP tools and policy without literal credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "raw-public-config-"));
  mkdirSync(join(home, "raw"));
  const secret = "literal-key-sentinel";
  writeFileSync(join(home, "raw", "config.json"), JSON.stringify({
    default_agent: "research",
    models: { flash: { provider: "deepseek", method: "openai-chat-completions", model_id: "deepseek-flash",
      base_url: "https://api.deepseek.com", api_key: secret, vision: true, context_window_tokens: 4096 } },
    agents: { research: { model: "flash", compact: { trigger_tokens: 1000, max_output_tokens: 100 },
      tools: { use: ["mcp/search/web_search"], rules: [{ match: "builtin/bash", effect: "deny" }] } } },
    mcp: { servers: { search: { transport: "stdio", command: "unused", args: [] } } },
  }));
  const listed = cli(["config", "list"], home);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /research.*flash.*deepseek-flash.*openai-chat-completions/s);
  assert.match(listed.stdout, /vision=true/);
  assert.match(listed.stdout, /mcp\/search\/web_search/);
  assert.match(listed.stdout, /deny:builtin\/bash/);
  assert.match(listed.stdout, /trigger=1000/);
  assert.doesNotMatch(listed.stdout + listed.stderr, new RegExp(secret));
});

test("T-01d: config list rejects malformed agent and compact definitions without credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "raw-cli-"));
  mkdirSync(join(home, "raw"));
  const path = join(home, "raw", "config.json");
  writeFileSync(path, JSON.stringify({ models: { bad: { provider: "custom", method: "openai-chat-completions", model_id: 42, api_key: "secret", base_url: "https://example.test" } }, agents: { bad: { model: "bad" } } }));
  const bad = cli(["config", "list"], home);
  assert.equal(bad.status, 2);
  assert.doesNotMatch(bad.stdout + bad.stderr, /secret/);
  writeFileSync(path, JSON.stringify({ agents: [] }));
  assert.equal(cli(["config", "list"], home).status, 2);
  writeFileSync(path, JSON.stringify({ models: { local: { provider: "ollama", method: "openai-chat-completions", model_id: "m" } }, agents: { local: { model: "local", compact: { agent: "missing" } } } }));
  assert.equal(cli(["config", "list"], home).status, 2);
});
