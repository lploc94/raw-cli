import { AxeBuilder } from "@axe-core/playwright";
import { test, expect, openChat } from "./fixtures.js";

const message = (page: import("@playwright/test").Page) => page.getByLabel("Message", { exact: true });
const lastUserText = (raw: { provider: { requests: Array<{ body: unknown }> } }) => {
  const body = raw.provider.requests.at(-1)!.body as { messages: Array<{ role: string; content: unknown }> };
  const user = body.messages.filter((entry) => entry.role === "user").at(-1)!;
  return typeof user.content === "string" ? user.content : JSON.stringify(user.content);
};

test.describe("composer layout", () => {
  test("auto-grows to a bound, then scrolls, and keeps the toolbar below", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    const height = async () => (await input.boundingBox())!.height;
    const one = await height();
    await input.fill("a\nb\nc");
    const three = await height();
    expect(three).toBeGreaterThan(one);
    await input.fill(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
    const many = await height();
    await input.fill(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
    expect(await height()).toBe(many);
    expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await input.fill("");
    expect(await height()).toBeLessThan(three);
    const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
    const box = await input.boundingBox();
    expect(send!.y).toBeGreaterThan(box!.y + box!.height - 1);
    for (const width of [1280, 820, 360]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    }
  });
});

test.describe("slash commands", () => {
  test.use({ scenario: { agent: { skills: { use: ["builtin/create_agent"] }, tools: { use: ["builtin/list_skills", "builtin/load_skill"] } } } });

  test("opens, filters, navigates and selects by keyboard while focus stays in the textarea", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    await input.click();
    await input.pressSequentially("/");
    const list = page.getByRole("listbox", { name: "Suggestions" });
    await expect(list).toBeVisible();
    await expect(input).toHaveAttribute("aria-controls", (await list.getAttribute("id"))!);
    await expect(input).toHaveAttribute("aria-autocomplete", "list");
    await expect(page.getByRole("option", { name: /\/compact/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /\/create-agent/ })).toBeVisible();
    const first = await input.getAttribute("aria-activedescendant");
    await page.keyboard.press("ArrowDown");
    expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);
    await expect(input).toBeFocused();
    await input.pressSequentially("det");
    await expect(list.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("/det");
    expect(raw.provider.requests.length).toBe(0);
  });

  test("Enter selects instead of sending; /details toggles the inspector", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    await input.pressSequentially("/detail");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    expect(raw.provider.requests.length).toBe(0);
    // Like any panel that opens, the details panel takes focus.
    await expect(page.getByRole("complementary").or(page.locator(".inspector")).first()).toBeVisible();
  });

  test("/rename opens the rename dialog and /new starts a new chat", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    await input.pressSequentially("/rename");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    const before = page.url();
    const count = () => raw.server.context.store!.listSessions({}).items.length;
    const sessions = count();
    await input.pressSequentially("/new");
    await page.keyboard.press("Enter");
    await expect(page).not.toHaveURL(before);
    expect(count()).toBe(sessions + 1);
  });

  test("a skill inserts exactly its sentence and that sentence is what the model receives", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    await input.pressSequentially("/");
    await expect(page.getByRole("option", { name: /\/create-agent/ })).toBeVisible(); // skills load after the agent is known
    await input.pressSequentially("create");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue('Use the skill "create-agent" for this task. ');
    await input.pressSequentially("build one");
    await input.press("Enter");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(lastUserText(raw)).toBe('Use the skill "create-agent" for this task. build one');
  });

  test("/compact posts a compact operation", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    await input.fill("seed");
    await input.press("Enter");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    await expect(page.getByRole("button", { name: "Compact context", exact: true })).toBeEnabled();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await input.pressSequentially("/compact");
    await page.keyboard.press("Enter");
    await expect.poll(() => raw.server.context.store!.listOperations(id, 10).some((op) => op.kind === "compact")).toBe(true);
    await expect(input).toHaveValue("");
  });

  test("an unknown /command sends verbatim; no-match state is announced", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    await input.pressSequentially("/zzz");
    await expect(page.getByText("No matching commands")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(lastUserText(raw)).toBe("/zzz");
  });

  test("IME composition never selects or sends", async ({ page, raw }) => {
    await openChat(page, raw);
    const input = message(page);
    await input.pressSequentially("/det");
    await input.dispatchEvent("compositionstart");
    await input.press("Enter");
    await expect(input).toHaveValue(/^\/det/);
    expect(raw.provider.requests.length).toBe(0);
    await input.dispatchEvent("compositionend");
  });

  test("the open popover passes axe", async ({ page, raw }) => {
    await openChat(page, raw);
    await message(page).pressSequentially("/");
    await expect(page.getByRole("listbox", { name: "Suggestions" })).toBeVisible();
    const result = await new AxeBuilder({ page }).include(".composer-area").analyze();
    expect(result.violations).toEqual([]);
  });

  test("drafts persist across session switches", async ({ page, raw }) => {
    await openChat(page, raw);
    await message(page).fill("keep me");
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await expect(message(page)).toHaveValue("");
    await page.goBack();
    await expect(message(page)).toHaveValue("keep me");
  });
  test("the list follows the query without stale picks, and stays inside a short viewport", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.setViewportSize({ width: 900, height: 320 });
    const input = message(page);
    await input.pressSequentially("/");
    await expect(page.getByRole("listbox", { name: "Suggestions" })).toBeVisible();
    const box = await page.locator(".suggestions").boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    await input.pressSequentially("rena");
    await page.keyboard.press("Enter");
    // The first Enter after typing must act on the /rena list, not on an earlier one.
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(raw.provider.requests.length).toBe(0);
  });
});

test("auto-grow refits when the width changes", async ({ page, raw }) => {
  await openChat(page, raw);
  await page.setViewportSize({ width: 1280, height: 800 });
  const input = message(page);
  await input.fill("word ".repeat(60));
  const wide = (await input.boundingBox())!.height;
  await page.setViewportSize({ width: 420, height: 800 });
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(wide);
});
