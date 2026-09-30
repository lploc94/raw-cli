import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
const call = (name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "command", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const section = (page: import("@playwright/test").Page) => page.locator('[data-panel="__commands"]');
test.describe("Commands foreground", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [call("bash", { commands: [{ command: "printf 'hello commands'; exit 7" }] }), answer] } });
  test("foreground failure stays compact, does not steal focus and survives reload", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("run command");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await section(page).locator(".panel-toggle").click();
    await section(page).getByText(/Completed commands/).click();
    await expect(section(page)).toContainText("exit 7");
    await section(page).getByRole("button", { name: "Output", exact: true }).click();
    await expect(section(page).locator("pre")).toContainText("hello commands");
    await page.reload();
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await expect(section(page)).toHaveCount(1);
  });
});

test.describe("Commands background", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/process"], rules: [{ match: "builtin/process", effect: "ask", when: { source: "arguments", any: "action", regex: "^stop$" } }] } }, responses: [call("process", { action: "start", command: "printf 'background ready'; sleep 60" }), { hold: true }] } });
  test("background survives its handler, streams during an active turn and Stop asks approval", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("start background");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(section(page)).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest(".inspector"))).toBe(false);
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    await section(page).getByRole("button", { name: "Output", exact: true }).click();
    await expect(section(page).locator("pre")).toContainText("background ready");
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(section(page).getByText(/Completed commands/)).toBeVisible();
    await expect(section(page).locator("pre")).toContainText("background ready");
    await expect(section(page).locator("pre")).toContainText("[stdout]");
    await expect(section(page).getByText("Stop completed.", { exact: true })).toBeVisible();
    expect(raw.provider.requests.length).toBe(2);
  });
  test("a lost Stop response replays the failed receipt, then a fresh retry can request approval", async ({ page, raw }) => {
    let loseFirst = true;
    await page.route("**/commands/*/stop", async route => {
      if (!loseFirst) { await route.continue(); return; }
      loseFirst = false;
      await route.fetch();
      await route.abort("failed");
    });
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("start background");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(section(page)).toBeVisible();
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(section(page).getByRole("status")).toContainText("Stop failed.");
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(section(page).getByText(/Completed commands/)).toBeVisible();
  });
  test("Never suppresses background opening and hidden Commands remains hidden after reconnect", async ({ page, raw }) => {
    await page.addInitScript(() => localStorage.setItem("raw.dashboard.preferences.v1", JSON.stringify({ version: 1, panelOpen: "never" })));
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("start background");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await section(page).getByRole("button", { name: /menu/i }).click();
    await page.getByRole("menuitem", { name: /Hide/ }).click();
    await expect(section(page)).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await expect(section(page)).toHaveCount(0);
  });
});
