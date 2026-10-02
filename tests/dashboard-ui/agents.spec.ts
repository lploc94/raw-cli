import { readFileSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, openChat, test } from "./fixtures.js";

const openAgents = async (page: Page, url: string) => {
  await page.goto(url);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
};
const openAgent = async (page: Page, url: string, name = "raw") => {
  await openAgents(page, url);
  await page.getByRole("navigation", { name: "Agents" }).getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${name}$`));
};
/** Resolves a token to the same color syntax getComputedStyle returns for backgrounds. */
const token = (page: Page, name: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, name);
const layout = (locator: Locator) =>
  locator.evaluate((element) => {
    const s = getComputedStyle(element);
    return [s.marginTop, s.marginBottom, s.columnGap, s.flexWrap, s.display, s.alignItems].join("|");
  });
// Measured on the pre-redesign stylesheet; consolidating `.actions` must not move other pages.
const actionsBaseline = "12px|12px|8px|wrap|flex|center";

test.describe("shared tokens and navigation", () => {
  test("the sidebar marks the open agent as the current page", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    const nav = page.getByRole("navigation", { name: "Agents" });
    await expect(nav.getByRole("link", { name: "raw", exact: true })).toHaveAttribute("aria-current", "page");
    // Any encoding of the same name is the same agent.
    await page.goto(raw.server.launchUrl.replace(/\/?(\?|#|$)/, "/agents/%72aw$1"));
    await expect(page.getByLabel("System prompt", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "raw", exact: true })).toHaveAttribute("aria-current", "page");
  });

  for (const theme of ["light", "dark"]) {
    test(`primary buttons draw from the accent tokens in ${theme} mode`, async ({ page, raw }) => {
      await openAgents(page, raw.server.launchUrl);
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await page.getByRole("button", { name: "Create agent" }).click();
      await page.getByLabel("Agent name").fill("styled");
      const create = page.getByRole("button", { name: "Create", exact: true });
      await expect(create).toHaveCSS("background-color", await token(page, "--accent"));
      await expect(create).toHaveCSS("color", await token(page, "--on-accent"));
      if (theme === "dark") await expect(create).not.toHaveCSS("color", "rgb(255, 255, 255)");
    });
  }

  test("consolidated action rows keep their spacing on chat, settings and conflict review", async ({ page, raw }) => {
    await openChat(page, raw);
    expect(await layout(page.locator(".page-header .actions"))).toBe(actionsBaseline);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
    await page.getByRole("link", { name: "Models & connections" }).click();
    await page.getByRole("link", { name: "fixture", exact: true }).first().click();
    await page.getByText("Model JSON").first().waitFor();
    expect(await layout(page.locator(".management-page .actions").last())).toBe(actionsBaseline);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByRole("navigation", { name: "Agents" }).getByRole("link", { name: "raw", exact: true }).click();
    await page.getByLabel("System prompt", { exact: true }).fill("Draft");
    const other = JSON.parse(readFileSync(raw.configPath, "utf8"));
    other.agents.raw.system_prompt = "External";
    writeFileSync(raw.configPath, JSON.stringify(other));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const review = page.getByRole("button", { name: "Review latest revision" });
    await review.waitFor();
    expect(await layout(review.locator(".."))).toBe(actionsBaseline);
  });
});
