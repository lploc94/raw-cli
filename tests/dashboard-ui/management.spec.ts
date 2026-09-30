import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.js";

test("create, edit and select a hook through Library and Agents", async ({ page, raw }) => {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Hooks", exact: true }).click();
  await page.getByRole("button", { name: "Create hook" }).click();
  await page.getByLabel("Component folder").fill("guard");
  await page.getByRole("button", { name: "Create hook", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "local/guard" })).toBeVisible();
  const hook = JSON.parse(readFileSync(join(raw.env.XDG_CONFIG_HOME!, "raw", "hooks", "guard", "hook.json"), "utf8"));
  expect(hook.protocol_version).toBe(2);
  expect(hook.events).toEqual([{ name: "PreToolUse", match: "builtin/bash" }]);
  await page.getByLabel("Attach to agent").selectOption("raw");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Attached" })).toBeVisible();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "raw", exact: true }).first().click();
  await expect(page.getByLabel("Selected hooks")).toContainText("local/guard");
});

test("compose an agent, fork a skill, save ordered selections, and start real chat", async ({
  page,
  raw,
}) => {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent" }).click();
  await page.getByLabel("Agent name").fill("writer");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("System prompt", { exact: true })
    .fill("Use selected skills when relevant.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Skills", exact: true }).click();
  await page
    .getByRole("link", { name: "builtin/create_skill", exact: true })
    .click();
  await page.getByRole("button", { name: "Fork to local" }).click();
  await page.getByLabel("Component folder").fill("writing_guide");
  await page.getByRole("button", { name: "Create fork" }).click();
  await expect(
    page.getByRole("heading", { name: "local/writing_guide", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Attach to agent").selectOption("writer");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Attached" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "writer", exact: true }).first().click();
  await expect(page.getByLabel("Selected skills")).toContainText(
    "local/writing_guide",
  );
  await page
    .getByRole("button", { name: "New chat", exact: true })
    .last()
    .click();
  await page.getByRole("textbox", { name: "Message" }).fill("Use this agent");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  expect(JSON.stringify(raw.provider.requests[0]?.body)).toContain(
    "Use selected skills when relevant.",
  );
  const config = JSON.parse(readFileSync(raw.configPath, "utf8"));
  expect(config.agents.writer.tools.use).toEqual([
    "builtin/list_skills",
    "builtin/load_skill",
  ]);
  expect(config.default_agent).toBe("raw");
});

test("dirty editor guards navigation and conflict keeps draft plus explicit revision review", async ({
  page,
  raw,
}) => {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "raw", exact: true }).first().click();
  await page
    .getByLabel("System prompt", { exact: true })
    .fill("My unsaved prompt");
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Unsaved changes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  const other = JSON.parse(readFileSync(raw.configPath, "utf8"));
  other.agents.raw.system_prompt = "External prompt";
  writeFileSync(raw.configPath, JSON.stringify(other));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("revision conflict");
  await expect(page.getByLabel("System prompt", { exact: true })).toHaveValue(
    "My unsaved prompt",
  );
  await page.getByRole("button", { name: "Review latest revision" }).click();
  await expect(page.getByLabel("Latest on disk")).toContainText(
    "External prompt",
  );
  await page.getByRole("button", { name: "Reapply draft" }).click();
  await page
    .getByLabel("System prompt", { exact: true })
    .press("ControlOrMeta+s");
  await expect
    .poll(
      () =>
        JSON.parse(readFileSync(raw.configPath, "utf8")).agents.raw
          .system_prompt,
    )
    .toBe("My unsaved prompt");
});

test("variable definitions save through JSON and explicit Read uses the selected agent", async ({
  page,
  raw,
}) => {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Vars", exact: true }).click();
  await page.getByRole("button", { name: "Edit definitions" }).click();
  await page
    .getByRole("textbox", { name: "Definitions JSON", exact: true })
    .fill(
      JSON.stringify({
        vars: {
          greeting: {
            description: "Greeting",
            access: "read",
            source: { kind: "literal", value: "Hello from vars" },
          },
        },
        var_providers: {},
      }),
    );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "raw", exact: true }).first().click();
  await page.getByLabel("Add vars", { exact: true }).selectOption("greeting");
  await page
    .getByLabel("Add vars", { exact: true })
    .locator("../..")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Vars", exact: true }).click();
  await page.getByLabel("Variable name").fill("greeting");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator(".source-preview")).toContainText(
    "Hello from vars",
  );
  expect(raw.provider.requests.length).toBe(0);
});

test("tool source edits stay passive until an attached agent starts a turn", async ({
  page,
  raw,
}) => {
  const { existsSync } = await import("node:fs");
  const sentinel = `${raw.root}/tool-import`;
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Create tool", exact: true }).click();
  await page.getByLabel("Component folder").fill("probe");
  await page.getByRole("button", { name: "Create from example" }).click();
  await expect(
    page.getByRole("heading", { name: "local/probe", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Source file", { exact: true })
    .selectOption("index.mjs");
  await page
    .getByRole("textbox", { name: "Source index.mjs", exact: true })
    .fill(
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'imported'); export async function handler(){return {isError:false,content:[{type:'text',text:'ok'}]};}`,
    );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  expect(existsSync(sentinel)).toBe(false);
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Attached" }),
  ).toBeVisible();
  expect(existsSync(sentinel)).toBe(false);
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await page
    .getByRole("button", { name: "New chat", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Start");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  expect(existsSync(sentinel)).toBe(true);
});

test("MCP definitions discover explicitly and select exact original names", async ({
  page,
  raw,
}) => {
  const { existsSync } = await import("node:fs");
  const sentinel = `${raw.root}/mcp-started`,
    script = `${raw.root}/server.mjs`;
  writeFileSync(
    script,
    `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)},'started');
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
    const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo_text',description:'Echo',inputSchema:{type:'object',properties:{}}}]}:{};
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`,
  );
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: "Edit definitions" }).click();
  await page
    .getByRole("textbox", { name: "Definitions JSON", exact: true })
    .fill(
      JSON.stringify({
        mcp: {
          servers: {
            probe: {
              transport: "stdio",
              command: process.execPath,
              args: [script],
            },
          },
        },
      }),
    );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  expect(existsSync(sentinel)).toBe(false);
  await page.getByLabel("MCP server name").fill("probe");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("checkbox", { name: /echo_text/ }).check();
  await page
    .getByRole("button", { name: "Add selected tools to agent" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Selected for raw" }),
  ).toBeVisible();
  expect(
    JSON.parse(readFileSync(raw.configPath, "utf8")).agents.raw.tools.use,
  ).toContain("mcp/probe/echo_text");
});

test("Back protects a dirty draft without inserting duplicate history entries", async ({
  page,
  raw,
}) => {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "raw", exact: true }).first().click();
  await page.getByLabel("System prompt", { exact: true }).fill("Pending draft");
  await page.goBack();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("System prompt", { exact: true })).toHaveValue(
    "Pending draft",
  );
  await page.goBack();
  await page.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Start a conversation" }),
  ).toBeVisible();
});
