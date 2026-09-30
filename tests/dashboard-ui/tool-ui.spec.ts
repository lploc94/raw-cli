import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

test.use({ scenario: { agent: { tools: { use: ["local/report"] } }, responses: Array.from({ length: 20 }, (_, index) => [
  { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "same-call-id", type: "function", function: { name: "report",
    arguments: JSON.stringify({ text: `Snapshot ${index}` }) } }] }, "tool_calls"), openAiDone] }, answer,
]).flat() } });

test("repeated inline views retain their snapshots after reload and backward paging without sidebar sections", async ({ page, raw }) => {
  const folder = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "report");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "report", version: "1.0.0", name: "report", description: "Report",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, entry: "./index.mjs",
    panels: [{ id: "report", title: "Report", placement: "chat" }] }));
  writeFileSync(join(folder, "index.mjs"), `export async function handler(args, context) {
    await context.panels.update('report', {op:'replace',document:{blocks:[{id:'body',kind:'markdown',text:args.text}]}});
    return {content:[]};
  }`);
  await openChat(page, raw);
  for (let index = 0; index < 20; index++) {
    await page.getByRole("textbox", { name: "Message" }).fill(`turn ${index}`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(index + 1);
    await expect(page.locator(".inline-tool-view").filter({ hasText: `Snapshot ${index}` }).last()).toBeVisible();
  }
  await page.reload();
  await expect(page.locator(".inline-tool-view").first()).toBeVisible();
  const older = page.getByRole("button", { name: "Load earlier" });
  for (let attempts = 0; attempts < 30 && await older.count(); attempts++) {
    await older.click();
    await page.waitForTimeout(50);
  }
  await expect(page.locator(".inline-tool-view")).toHaveCount(20);
  const snapshots = await page.locator(".inline-tool-view [data-kind=markdown]").allTextContents();
  expect(snapshots.map(text => text.trim()).sort()).toEqual(Array.from({ length: 20 }, (_, index) => `Snapshot ${index}`).sort());
  expect(new Set(await page.locator(".inline-tool-view").evaluateAll(elements => elements.map(element => element.getAttribute("data-instance")))).size).toBe(20);
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await expect(page.locator('.panel-stack [data-panel="local/report#report"]')).toHaveCount(0);
});

test.describe("inline action audit", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/report"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "report", arguments: "{}" } }] }, "tool_calls"), openAiDone] }, answer,
  ] } });
  test("a no-update action retains its user receipt across reload without duplicating the snapshot", async ({ page, raw }) => {
    const folder = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "report");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "report", version: "1.0.0", name: "report", description: "Report",
      input_schema: { type: "object", properties: { noop: { type: "boolean" } }, additionalProperties: false }, entry: "./index.mjs",
      panels: [{ id: "report", title: "Report", placement: "chat", actions: [{ id: "noop", label: "No update", kind: "tool", scope: "panel", arguments: { noop: true } }] }] }));
    writeFileSync(join(folder, "index.mjs"), `export async function handler(args, context) {
      if (!args.noop) await context.panels.update('report', {op:'replace',document:{blocks:[{id:'body',kind:'markdown',text:'Original snapshot'}]}});
      return {content:[{type:'text',text:args.noop?'No updates':'Published'}]};
    }`);
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("report");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".inline-tool-view")).toContainText("Original snapshot");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await page.getByRole("button", { name: "Actions for Report", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "No update", exact: true })).toBeEnabled();
    await page.getByRole("menuitem", { name: "No update", exact: true }).click();
    await expect(page.locator(".panel-receipt .panel-tag")).toHaveText("You");
    await expect(page.locator(".inline-tool-view")).toHaveCount(1);
    expect(raw.provider.requests).toHaveLength(2);
    await page.reload();
    await expect(page.locator(".inline-tool-view")).toContainText("Original snapshot");
    await expect(page.locator(".panel-receipt .panel-tag")).toHaveText("You");
    await expect(page.locator(".inline-tool-view")).toHaveCount(1);
    // Current policy and ownership must be reflected on historical snapshots.
    const tools = raw.config.agents.raw.tools as { use: string[]; rules?: { match: string; effect: string }[] };
    tools.rules = [{ match: "local/report", effect: "deny" }];
    writeFileSync(raw.configPath, JSON.stringify(raw.config));
    await page.reload();
    await expect(page.locator(".inline-tool-view")).toContainText("Original snapshot");
    await expect(page.getByRole("button", { name: "Actions for Report", exact: true })).toHaveCount(0);
    tools.use = []; tools.rules = [];
    writeFileSync(raw.configPath, JSON.stringify(raw.config));
    await page.reload();
    await expect(page.locator(".inline-tool-view")).toContainText("Original snapshot");
    await expect(page.locator(".inline-tool-view")).toContainText("not selected by this agent");
    await page.getByRole("button", { name: "Actions for Report", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "No update", exact: true })).toBeDisabled();
    expect(raw.provider.requests).toHaveLength(2);
  });
});
