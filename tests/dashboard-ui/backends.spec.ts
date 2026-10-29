import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat } from "./fixtures.js";
import { createAcpSessionAgent } from "../../src/backends/factory.js";
import type { BackendOffered } from "../../src/backends/options.js";
import { attachSessionRuntimeWith } from "../../src/sessions/runtime.js";

const FAKE_ACP = join(import.meta.dirname, "..", "fixtures", "fake-acp-agent.mjs");
/** The dashboard's real host runtime, with the scripted ACP agent standing in for Claude Code. */
const scriptedBackend = attachSessionRuntimeWith((context) => createAcpSessionAgent(context,
  { command: process.execPath, args: [FAKE_ACP], env: { ...process.env, FAKE_ACP_STATE: join(context.cwd, "fake-acp") } }));
/** What a new conversation offers, with names as long as the CLIs list them (`gpt-6.1-terra`, Claude's dated ids). */
const DISCOVERED: BackendOffered = {
  model: { current: "small", options: [{ value: "small", label: "small" }, { value: "big", label: "big" },
    { value: "claude-sonnet-4-6-20260915", label: "Claude Sonnet 4.6 (September 2026) with extended context" },
    { value: "gpt-6.1-terra", label: "gpt-6.1-terra", hint: "Frontier agentic coding model for long multi-step work across a repository." }] },
  effort: { options: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
  mode: { current: "ask", options: [{ value: "ask", label: "Ask before edits" }, { value: "auto", label: "Auto" }] },
};
const TODO = { title: "Ship", todos: [{ content: "Write tests for the backend controls at narrow widths", status: "in_progress" }, { content: "Docs", status: "pending" }] };

const message = (page: Page) => page.getByRole("textbox", { name: "Message" });
const pill = (page: Page) => page.locator(".request-pill");
const answers = (page: Page) => page.getByTestId("assistant-message");
async function send(page: Page, text: string) {
  await message(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
/** Nothing on the page is wider than the viewport, and no element named here is clipped sideways. */
async function fits(page: Page, selectors: string[]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  for (const selector of selectors) {
    for (const box of await page.locator(selector).evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { selector: element.className, left: rect.left, right: rect.right };
    }))) {
      expect(box.left, box.selector).toBeGreaterThanOrEqual(0);
      expect(box.right, box.selector).toBeLessThanOrEqual(320);
    }
  }
}

test.describe("a Claude Code backend agent at 320 px", () => {
  test.use({
    viewport: { width: 320, height: 720 },
    scenario: {
      extraAgents: { ext: { backend: { kind: "claude", model: "small" }, system_prompt: "Be RAW.", tools: { use: ["builtin/todo"] } } },
      config: { default_agent: "ext" },
      attach: scriptedBackend,
      discoverBackend: async () => ({ offered: structuredClone(DISCOVERED) }),
    },
  });

  test("the composer offers the backend's selects, a choice runs the next turn, and an unlisted value shows the backend notice", async ({ page, raw }) => {
    await openChat(page, raw);
    await expect(page.locator(".chat-header .backend-badge")).toHaveText("Claude Code");
    await expect(pill(page)).toHaveText("Model: default");
    await pill(page).click();
    const model = page.getByLabel("Model", { exact: true });
    await expect(model.locator("option")).toHaveText(["Agent default (small)", "small", "big", "Claude Sonnet 4.6 (September 2026) with extended context · claude-sonnet-4-6-20260915", "gpt-6.1-terra"]);
    await model.selectOption("gpt-6.1-terra");
    await expect(page.locator(".request-hint")).toHaveText("Frontier agentic coding model for long multi-step work across a repository.");
    await page.getByLabel("Mode", { exact: true }).selectOption("auto");
    await fits(page, [".request-popover", ".request-select", ".request-hint", ".chat-header .backend-badge"]);
    await page.keyboard.press("Escape");
    // A value this conversation's CLI does not list goes through and comes back as a notice; the turn keeps the CLI's value.
    await send(page, "options");
    await expect(page.locator(".system-note").filter({ hasText: 'does not offer model "gpt-6.1-terra"' })).toBeVisible();
    await expect(answers(page).last()).toContainText("model=small effort=- mode=auto");
    // The session now lists what its own CLI session offers.
    await pill(page).click();
    await expect(model.locator("option")).toHaveText(["Agent default (small)", "small", "big", "mid"]);
    // Small offers no effort; the efforts of big are listed once a turn ran on it.
    await expect(page.getByLabel("Effort", { exact: true })).toHaveCount(0);
    await model.selectOption("big");
    await page.getByLabel("Mode", { exact: true }).selectOption({ index: 0 });
    await page.keyboard.press("Escape");
    await send(page, "options");
    await expect(answers(page)).toHaveCount(2);
    await expect(answers(page).last()).toContainText("model=big effort=low mode=ask");
    await pill(page).click();
    await page.getByLabel("Effort", { exact: true }).selectOption("high");
    await page.keyboard.press("Escape");
    await expect(pill(page)).toHaveText("Model: big · high");
    await send(page, "options");
    await expect(answers(page)).toHaveCount(3);
    await expect(answers(page).last()).toContainText("model=big effort=high mode=ask");
    // Reset sends nothing: the turn runs on the conversation's own values.
    await pill(page).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.keyboard.press("Escape");
    await send(page, "options");
    await expect(answers(page)).toHaveCount(4);
    await expect(answers(page).last()).toContainText("model=small effort=- mode=ask");
    await fits(page, [".system-note", ".chat-header .backend-badge", ".request-pill"]);
  });

  test("a bridged Raw tool fills the todo panel", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, `bridge todo ${JSON.stringify(TODO)}`);
    await expect(answers(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await page.getByRole("tab", { name: "Todo", exact: true }).click();
    await expect(page.locator(".todo-row").filter({ hasText: "Write tests for the backend controls at narrow widths" })).toBeVisible();
    await fits(page, [".inspector", ".todo-row"]);
  });

  test("a permission the CLI asks for shows the approval card, and the answer goes back to the CLI", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "permission");
    const allow = page.getByRole("button", { name: "Allow once" });
    await expect(allow).toBeVisible();
    await fits(page, [".conversation-scroll", ".composer-area"]);
    await allow.click();
    await expect(answers(page).last()).toContainText("permission:yes");
  });
});

test.describe("a Codex backend agent whose CLI cannot be asked", () => {
  test.use({
    viewport: { width: 320, height: 720 },
    scenario: { extraAgents: { ext: { backend: { kind: "codex" }, system_prompt: "Be RAW.", tools: { use: [] } } }, config: { default_agent: "ext" },
      discoverBackend: async () => ({ offered: {}, warning: "Codex could not start: not logged in" }) },
  });

  test("the composer hides the controls, says why and still sends; the agent row shows the backend", async ({ page, raw }) => {
    await openChat(page, raw);
    await expect(page.getByText("Codex could not be asked for its models: Codex could not start: not logged in. Turns use the agent's settings.")).toBeVisible();
    await expect(pill(page)).toHaveCount(0);
    await message(page).fill("hello");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await fits(page, [".composer-area"]);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    // At this width the model line names the CLI, and the name keeps its room beside New chat.
    const row = page.locator(".agent-row", { has: page.getByRole("link", { name: "ext", exact: true }) });
    await expect(row.locator(".agent-row-model")).toHaveText("Codex");
    const [name, actions] = await Promise.all([row.getByRole("link", { name: "ext", exact: true }).boundingBox(), row.locator(".actions").boundingBox()]);
    expect(name!.width).toBeGreaterThan(0);
    expect(name!.x + name!.width).toBeLessThanOrEqual(actions!.x);
    await fits(page, [".agent-row"]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(row.locator(".backend-badge")).toHaveText("Codex");
  });
});

test.describe("a config with only CLI backends", () => {
  test.use({
    viewport: { width: 320, height: 720 },
    scenario: { config: { models: {}, agents: { ext: { backend: { kind: "claude" }, tools: { use: [] } } }, default_agent: "ext" } },
  });

  test("creates an agent that runs a CLI, with no Raw model to pick", async ({ page, raw }) => {
    await page.goto(raw.server.launchUrl);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Create agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Create agent" });
    await dialog.getByLabel("Agent name").fill("coder");
    const runsOn = dialog.getByLabel("Runs on", { exact: true });
    await expect(runsOn.locator("option")).toHaveText(["Claude Code", "Codex", "Antigravity (agy)"]);
    await expect(dialog.getByLabel("Model", { exact: true })).toHaveCount(0);
    await runsOn.selectOption("codex");
    await fits(page, [".modal, [role=dialog]"]);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/coder$/);
    expect(JSON.parse(readFileSync(raw.configPath, "utf8")).agents.coder).toEqual({ backend: { kind: "codex" }, tools: { use: [] } });
  });
});
