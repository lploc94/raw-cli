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

test.describe("agents list", () => {
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/read_file", "builtin/bash"] } },
      extraAgents: { second: { model: "fixture", tools: { use: [] } } },
    },
  });
  const list = (page: Page) => page.getByRole("list", { name: "Agent list" });
  const row = (page: Page, name: string) =>
    list(page).getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });
  const menu = async (page: Page, name: string, item: string) => {
    await page.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: item, exact: true }).click();
  };
  const saved = (raw: { configPath: string }) => JSON.parse(readFileSync(raw.configPath, "utf8"));
  const conflict = (page: Page) =>
    page.route("**/api/agents", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "conflict", message: "Injected conflict" } }) })
        : route.continue(),
    );

  test("rows summarize model, selections and the default agent", async ({ page, raw }) => {
    await openAgents(page, raw.server.launchUrl);
    await expect(row(page, "raw")).toContainText("fixture");
    await expect(row(page, "raw")).toContainText("2 tools · 0 skills");
    await expect(row(page, "raw").getByText("Default", { exact: true })).toBeVisible();
    await expect(row(page, "second")).toContainText("0 tools · 0 skills");
    await expect(row(page, "second").getByText("Default", { exact: true })).toHaveCount(0);
    await expect(row(page, "second").getByRole("button", { name: "New chat" })).toBeVisible();
  });

  test("rename validates the new name and opens the renamed agent", async ({ page, raw }) => {
    await openAgents(page, raw.server.launchUrl);
    await menu(page, "second", "Rename");
    const dialog = page.getByRole("dialog", { name: "Rename agent" });
    const input = dialog.getByLabel("New agent name");
    const confirm = dialog.getByRole("button", { name: "Rename", exact: true });
    await expect(input).toHaveValue("second");
    await expect(confirm).toBeDisabled();
    await input.fill(" ");
    await expect(confirm).toBeDisabled();
    await input.fill("raw");
    await expect(confirm).toBeDisabled();
    await input.fill("renamed");
    await confirm.click();
    await expect(page).toHaveURL(/\/agents\/renamed$/);
    expect(Object.keys(saved(raw).agents).sort()).toEqual(["raw", "renamed"]);
    await page.getByRole("link", { name: "Agents", exact: true }).first().click();
    await expect(row(page, "renamed")).toBeVisible();
  });

  test("duplicate copies the agent and opens the copy", async ({ page, raw }) => {
    await openAgents(page, raw.server.launchUrl);
    await menu(page, "raw", "Duplicate");
    const dialog = page.getByRole("dialog", { name: "Duplicate agent" });
    await expect(dialog.getByLabel("New agent name")).toHaveValue("raw_copy");
    await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/raw_copy$/);
    const config = saved(raw);
    expect(config.agents.raw_copy.tools.use).toEqual(config.agents.raw.tools.use);
    await page.getByRole("link", { name: "Agents", exact: true }).first().click();
    await expect(row(page, "raw")).toBeVisible();
    await expect(row(page, "raw_copy")).toBeVisible();
  });

  test("set as default moves the badge and leaves the menu item off the default", async ({ page, raw }) => {
    await openAgents(page, raw.server.launchUrl);
    await menu(page, "second", "Set as default");
    await page.getByRole("dialog", { name: "Set default agent" }).getByRole("button", { name: "Set as default", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row(page, "second").getByText("Default", { exact: true })).toBeVisible();
    await expect(row(page, "raw").getByText("Default", { exact: true })).toHaveCount(0);
    expect(saved(raw).default_agent).toBe("second");
    await page.getByRole("button", { name: "Actions for second" }).click();
    await expect(page.getByRole("menuitem", { name: "Set as default" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  });

  test("delete is a destructive confirmation and removes the row", async ({ page, raw }) => {
    await openAgents(page, raw.server.launchUrl);
    await menu(page, "second", "Delete");
    const confirm = page.getByRole("dialog", { name: "Delete agent" }).getByRole("button", { name: "Delete agent", exact: true });
    await expect(confirm).toHaveClass(/\bdanger\b/);
    await confirm.click();
    // The open dialog hides the list from the accessibility tree, so wait for it to close first.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row(page, "raw")).toBeVisible();
    await expect(row(page, "second")).toHaveCount(0);
    await expect(page).toHaveURL(/\/agents$/);
    expect(saved(raw).agents.second).toBeUndefined();
  });

  test("a failed create shows one error, inside the dialog", async ({ page, raw }) => {
    await openAgents(page, raw.server.launchUrl);
    await conflict(page);
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByLabel("Agent name").fill("writer");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create agent" });
    await expect(dialog.getByRole("alert")).toBeVisible();
    // Count DOM alerts: the modal hides the page from the accessibility tree, not from view.
    await expect(page.locator('[role="alert"]')).toHaveCount(1);
  });

  test("a failed lifecycle action shows one error and keeps its dialog open", async ({ page, raw }) => {
    await openAgents(page, raw.server.launchUrl);
    await conflict(page);
    await menu(page, "second", "Rename");
    const dialog = page.getByRole("dialog", { name: "Rename agent" });
    await dialog.getByLabel("New agent name").fill("renamed");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    // Count DOM alerts: the modal hides the page from the accessibility tree, not from view.
    await expect(page.locator('[role="alert"]')).toHaveCount(1);
    await expect(dialog).toBeVisible();
  });
});
