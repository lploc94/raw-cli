import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test.describe("agent detail shell", () => {
  test("header shows breadcrumb, badges and actions, not Create agent", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    const header = page.locator(".detail-header");
    await expect(header.getByRole("heading", { name: "raw", level: 1 })).toBeVisible();
    await expect(header.getByText("fixture", { exact: true })).toBeVisible();
    await expect(header.getByText("Default", { exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Actions for raw" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create agent" })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Agents" }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole("list", { name: "Agent list" })).toBeVisible();
  });

  test("the save bar appears only for unsaved work and actions wait for it", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    const bar = page.locator(".sticky-savebar");
    await expect(page.getByLabel("System prompt", { exact: true })).toBeVisible();
    await expect(bar).toHaveCount(0);
    await page.getByLabel("System prompt", { exact: true }).fill("Changed");
    await expect(bar).toContainText("Unsaved changes");
    await expect(page.locator(".detail-header").getByRole("button", { name: "New chat" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Actions for raw" })).toBeDisabled();
    await bar.getByRole("button", { name: "Discard" }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByLabel("System prompt", { exact: true })).toHaveValue("Original prompt");
    await page.getByLabel("System prompt", { exact: true }).fill("Saved prompt");
    await bar.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    expect(JSON.parse(readFileSync(raw.configPath, "utf8")).agents.raw.system_prompt).toBe("Saved prompt");
  });

  test("tabs switch sections without the leave guard and keep the draft", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    const tabs = page.getByRole("tablist", { name: "Agent sections" });
    await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("System prompt", { exact: true }).fill("Draft across tabs");
    await tabs.getByRole("tab", { name: "Capabilities" }).click();
    await expect(page.getByLabel("Add tools", { exact: true })).toBeVisible();
    await expect(page.getByLabel("System prompt", { exact: true })).toBeHidden();
    await tabs.getByRole("tab", { name: "Policy" }).click();
    await tabs.getByRole("tab", { name: "JSON" }).click();
    await expect(page.getByText("Draft across tabs").first()).toBeAttached();
    await tabs.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByRole("dialog", { name: "Unsaved changes" })).toHaveCount(0);
    await expect(page.getByLabel("System prompt", { exact: true })).toHaveValue("Draft across tabs");
    await expect(page.locator(".sticky-savebar")).toContainText("Unsaved changes");
  });

  test("malformed JSON hides the form until it parses again", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    const tabs = page.getByRole("tablist", { name: "Agent sections" });
    await tabs.getByRole("tab", { name: "JSON" }).click();
    const editor = page.getByRole("textbox", { name: "Agent JSON" });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(",");
    await expect(page.locator(".error-banner").first()).toBeVisible();
    await tabs.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByLabel("System prompt", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Agent JSON" })).toBeVisible();
    await page.getByRole("button", { name: "Open Agent JSON" }).click();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Backspace");
    await tabs.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByLabel("System prompt", { exact: true })).toBeVisible();
  });

  test("a slow agent load shows a skeleton", async ({ page, raw }) => {
    await page.route("**/api/agents/raw", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await openAgents(page, raw.server.launchUrl);
    await page.getByRole("navigation", { name: "Agents" }).getByRole("link", { name: "raw", exact: true }).click();
    await expect(page.getByText("Loading agent", { exact: true })).toBeAttached();
    await expect(page.getByLabel("System prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Loading agent", { exact: true })).toHaveCount(0);
  });

  test("a failed agent load reports one error and no save bar", async ({ page, raw }) => {
    await page.route("**/api/agents/raw", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Injected load failure" } }) }),
    );
    await openAgents(page, raw.server.launchUrl);
    await page.getByRole("navigation", { name: "Agents" }).getByRole("link", { name: "raw", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator('[role="alert"]')).toHaveCount(1);
    await expect(page.locator(".sticky-savebar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Actions for raw" })).toBeDisabled();
  });

  test("a package-bound agent opens on JSON without form-only sections", async ({ page, raw }) => {
    const folder = join(raw.root, "shared-kit");
    cpSync(join(process.cwd(), "examples/packages/tool-only"), folder, { recursive: true });
    mkdirSync(join(folder, "agents"));
    writeFileSync(join(folder, "agents/writer.json"), JSON.stringify({ system_prompt: { $input: "prompt" }, tools: { use: [] } }));
    const manifest = JSON.parse(readFileSync(join(folder, "raw-package.json"), "utf8"));
    manifest.files.push("agents/writer.json");
    manifest.exports.agents = { writer: "agents/writer.json" };
    manifest.inputs = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
    writeFileSync(join(folder, "raw-package.json"), JSON.stringify(manifest));
    const stage = await raw.json<{ id: string }>("/packages/inspect", "POST", { path: folder });
    await raw.json("/packages/install", "POST", { stageId: stage.id, alias: "shared", action: "install" });
    const config = await raw.json<{ revision: string }>("/config");
    await raw.json("/packages/shared/agent", "POST", { revision: config.revision, name: "writer", exportName: "writer", model: "fixture", inputs: { prompt: "P" } });
    await openAgent(page, raw.server.launchUrl, "writer");
    const tabs = page.getByRole("tablist", { name: "Agent sections" });
    await expect(tabs.getByRole("tab", { name: "JSON" })).toHaveAttribute("aria-selected", "true");
    await expect(tabs.getByRole("tab", { name: "Capabilities" })).toHaveCount(0);
    await expect(tabs.getByRole("tab", { name: "Policy" })).toHaveCount(0);
    await expect(page.locator(".detail-header").getByText("Package", { exact: true })).toBeVisible();
    await tabs.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByText(/Package binding: pkg\/shared\//)).toBeVisible();
  });
});

test.describe("agent detail sections", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/read_file", "builtin/bash"] } } } });
  const saved = (raw: { configPath: string }) => JSON.parse(readFileSync(raw.configPath, "utf8")).agents.raw;
  const tab = (page: Page, name: string) =>
    page.getByRole("tablist", { name: "Agent sections" }).getByRole("tab", { name }).click();
  const save = async (page: Page) => {
    await page.locator(".sticky-savebar").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  };

  test("the prompt source switch writes the matching field", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    const source = page.getByRole("radiogroup", { name: "Prompt source" });
    await expect(source.getByRole("radio", { name: "Text" })).toHaveAttribute("aria-checked", "true");
    await source.getByRole("radio", { name: "File" }).click();
    await expect(source.getByRole("radio", { name: "File" })).toHaveAttribute("aria-checked", "true");
    await page.getByLabel("System prompt file", { exact: true }).fill("prompts/raw.md");
    await save(page);
    expect(saved(raw).system_prompt_file).toBe("prompts/raw.md");
    expect(saved(raw).system_prompt).toBeUndefined();
  });

  test("selections show an empty state, reorder and persist", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    await tab(page, "Capabilities");
    await expect(page.getByText("No hooks selected", { exact: true })).toBeVisible();
    await expect(page.getByText("No tools selected", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Move builtin/read_file down" }).click();
    await page.getByRole("button", { name: "Remove builtin/bash" }).click();
    await page.getByRole("button", { name: "Remove builtin/read_file" }).click();
    await expect(page.getByText("No tools selected", { exact: true })).toBeVisible();
    await page.getByLabel("Add tools", { exact: true }).selectOption("builtin/bash");
    await page.getByLabel("Add tools", { exact: true }).locator("../..").getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Add tools", { exact: true }).selectOption("builtin/read_file");
    await page.getByLabel("Add tools", { exact: true }).locator("../..").getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("No tools selected", { exact: true })).toHaveCount(0);
    await save(page);
    expect(saved(raw).tools.use).toEqual(["builtin/bash", "builtin/read_file"]);
  });

  test("moving a tool down persists the new order", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    await tab(page, "Capabilities");
    await page.getByRole("button", { name: "Move builtin/read_file down" }).click();
    await save(page);
    expect(saved(raw).tools.use).toEqual(["builtin/bash", "builtin/read_file"]);
  });

  test("selecting a skill still adds the skill tools", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    await tab(page, "Capabilities");
    await page.getByLabel("Add skills", { exact: true }).selectOption("builtin/create_skill");
    await page.getByLabel("Add skills", { exact: true }).locator("../..").getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByLabel("Selected tools")).toContainText("builtin/list_skills");
    await save(page);
    expect(saved(raw).tools.use).toEqual(["builtin/read_file", "builtin/bash", "builtin/list_skills", "builtin/load_skill"]);
    expect(saved(raw).skills.use).toEqual(["builtin/create_skill"]);
  });

  test("policy rules move both ways and the sample result is a typed badge", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    await tab(page, "Policy");
    const policy = page.getByRole("tabpanel", { name: "Policy" });
    await expect(policy.locator('[role="status"]')).toHaveCount(0);
    await policy.getByRole("button", { name: "Add rule" }).click();
    await policy.getByRole("button", { name: "Add rule" }).click();
    await policy.getByLabel("Rule 1 match").fill("builtin/read_file");
    await policy.getByLabel("Rule 1 effect").selectOption("deny");
    await expect(policy.getByRole("group", { name: "Rule 2" }).getByRole("button", { name: "Move down" })).toBeDisabled();
    await policy.getByRole("group", { name: "Rule 1" }).getByRole("button", { name: "Move down" }).click();
    await expect(policy.getByLabel("Rule 2 match")).toHaveValue("builtin/read_file");
    await policy.getByRole("button", { name: "Test rules" }).click();
    const result = policy.getByRole("status");
    await expect(result).toContainText("ask");
    await expect(result.locator(".badge")).toHaveClass(/\bwarning\b/);
    await policy.getByLabel("Sample canonical tool identity").fill("builtin/read_file");
    await policy.getByRole("button", { name: "Test rules" }).click();
    await expect(result).toContainText("deny");
    await expect(result.locator(".badge")).toHaveClass(/\berror\b/);
    await save(page);
    expect(saved(raw).tools.rules.map((rule: { match: string }) => rule.match)).toEqual(["builtin/bash", "builtin/read_file"]);
  });

  test("a removed condition can be recreated and still saves a valid rule", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    await tab(page, "Policy");
    const policy = page.getByRole("tabpanel", { name: "Policy" });
    await policy.getByRole("button", { name: "Add rule" }).click();
    await policy.getByRole("button", { name: "Remove condition" }).click();
    await policy.getByLabel("Rule 1 when.any").fill("commands[*].command");
    await policy.getByLabel("Rule 1 regex").fill("^rm ");
    await policy.getByLabel("Rule 1 effect").selectOption("allow");
    await policy.getByLabel("Rule 1 effect").selectOption("ask");
    await policy.getByLabel("Rule 1 regex").fill("^sudo ");
    await policy.getByLabel("Rule 1 when.any").fill("commands[*].command");
    await policy.getByRole("button", { name: "Test rules" }).click();
    await expect(policy.getByRole("status").locator(".badge")).toBeVisible();
    await save(page);
    expect(saved(raw).tools.rules).toEqual([
      { match: "builtin/bash", effect: "ask", when: { source: "arguments", regex: "^sudo ", any: "commands[*].command" } },
    ]);
  });

  test("sections are cards and nothing hides behind a disclosure", async ({ page, raw }) => {
    await openAgent(page, raw.server.launchUrl);
    for (const name of ["Overview", "Capabilities", "Policy", "JSON"]) {
      await tab(page, name);
      const panel = page.getByRole("tabpanel", { name });
      await expect(panel.locator("details")).toHaveCount(0);
      if (name !== "JSON") await expect(panel.locator(".card").first()).toBeVisible();
    }
    await expect(page.getByRole("textbox", { name: "Agent JSON" })).toBeVisible();
  });
});

test.describe("narrow screens", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  test("the list and every section fit without horizontal scrolling", async ({ page, raw }) => {
    await page.goto(raw.server.launchUrl.replace(/\/?(\?|#|$)/, "/agents$1"));
    const list = page.getByRole("list", { name: "Agent list" });
    await expect(list).toBeVisible();
    expect(await fits(page)).toBe(true);
    await expect(list.getByRole("button", { name: "New chat" })).toBeInViewport();
    await expect(list.getByRole("button", { name: "Actions for raw" })).toBeInViewport();
    await list.getByRole("link", { name: "raw", exact: true }).click();
    const header = page.locator(".detail-header");
    await expect(header.getByRole("button", { name: "New chat" })).toBeInViewport();
    await expect(header.getByRole("button", { name: "Actions for raw" })).toBeInViewport();
    const tabs = page.getByRole("tablist", { name: "Agent sections" });
    const tops = await tabs.getByRole("tab").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
    for (const name of ["Overview", "Capabilities", "Policy", "JSON"]) {
      await tabs.getByRole("tab", { name }).click();
      expect(await fits(page)).toBe(true);
    }
  });
});
