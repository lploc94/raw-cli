import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { openPath, packageSource, seedLibrary } from "./library-seed.js";

// Agents, Library and Settings in the chat's look (docs/chat-design.md §3 "Second column").

/** Resolves a token to the colour syntax getComputedStyle returns for backgrounds. */
const token = (page: Page, name: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, name);
const style = (locator: Locator, property: "backgroundColor" | "textDecorationLine" | "boxShadow") =>
  locator.evaluate((element, property) => getComputedStyle(element)[property], property);
const setTheme = (page: Page, theme: string) =>
  page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
/** Moves the real pointer to a cell's centre: on a linked row the name link covers the cell, as it does for a user. */
const pointAt = async (page: Page, locator: Locator, click = false) => {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  if (click) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
const nav = (page: Page, name: string) => page.getByRole("navigation", { name });
const count = (page: Page, label: string) =>
  nav(page, "Library categories").getByRole("link", { name: label, exact: true }).locator(".nav-count");
test("management route pages ignore unrelated query parameters", async ({ page, raw }) => {
  await seedLibrary(raw);
  const launch = raw.server.launchUrl;
  await page.goto(launch);
  const origin = new URL(launch).origin;
  await page.goto(`${origin}/settings/models?from=palette`);
  await expect(page.getByRole("heading", { name: "Models & connections", exact: true })).toBeVisible();
  await page.goto(`${origin}/settings/models/fixture?from=palette`);
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue("fixture");
  await page.goto(`${origin}/agents/raw?from=palette`);
  await expect(page.getByLabel("System prompt", { exact: true })).toBeVisible();
  await page.goto(`${origin}/library/tools/local%2Fprobe?from=palette`);
  await expect(page.getByRole("heading", { name: "local/probe", exact: true })).toBeVisible();
  await page.goto(`${origin}/library/packages/shared?from=palette`);
  await expect(page.getByRole("heading", { name: "shared", exact: true })).toBeVisible();
});


test.describe("navigation rows", () => {
  test("navigation rows fill on hover and are never underlined", async ({ page, raw }) => {
    const pages = [
      { path: "/agents/raw", nav: "Agents", hover: "second", current: "raw" },
      { path: "/library/tools", nav: "Library categories", hover: "Skills", current: "Tools" },
      { path: "/settings/models", nav: "Settings categories", hover: "Chat", current: "Models & connections" },
    ];
    await raw.json("/agents", "POST", { revision: (await raw.json<{ revision: string }>("/config")).revision, action: "create", name: "second",
      value: { model: "fixture", tools: { use: [] } } });
    for (const item of pages) {
      await openPath(page, raw.server.launchUrl, item.path);
      const current = nav(page, item.nav).getByRole("link", { name: item.current, exact: true });
      await expect(current).toHaveAttribute("aria-current", "page");
      for (const theme of ["light", "dark"]) {
        await setTheme(page, theme);
        const hovered = nav(page, item.nav).getByRole("link", { name: item.hover, exact: true });
        await hovered.hover();
        const fill = await token(page, "--backdrop-hover");
        await expect.poll(() => style(hovered, "backgroundColor"), `${item.nav} ${theme} hover fill`).toBe(fill);
        expect(await style(hovered, "textDecorationLine"), `${item.nav} ${theme} underline`).toBe("none");
        expect(await style(current, "backgroundColor"), `${item.nav} ${theme} current`).toBe(await token(page, "--on-backdrop"));
        await page.mouse.move(0, 0);
      }
    }
  });

  test("Library rows show an icon and the count of their list", async ({ page, raw }) => {
    await seedLibrary(raw);
    const lists: [string, string, string][] = [
      ["Tools", "/library/tools", "Tools catalog"],
      ["Skills", "/library/skills", "Skills catalog"],
      ["Hooks", "/library/hooks", "Hooks catalog"],
      ["Vars", "/library/vars", "Variables"],
      ["MCP", "/library/mcp", "MCP servers"],
      ["Packages", "/library/packages", "Installed packages"],
    ];
    for (const [label, path, list] of lists) {
      await openPath(page, raw.server.launchUrl, path);
      const rows = page.getByRole("list", { name: list }).getByRole("listitem");
      await expect(rows.first()).toBeVisible();
      await expect(count(page, label), label).toHaveText(String(await rows.count()));
      const link = nav(page, "Library categories").getByRole("link", { name: label, exact: true });
      await expect(link.locator("svg")).toHaveCount(1);
    }
    // The accessible name is the label alone.
    await expect(nav(page, "Library categories").getByRole("link", { name: "Tools", exact: true })).toHaveCount(1);

    // A component created in the app counts at once. The catalog is the oracle: a local folder is listed under
    // `local/` and `agent/`, so one folder adds two rows.
    const catalog = async () => (await raw.json<unknown[]>("/components/tools")).length;
    await openPath(page, raw.server.launchUrl, "/library/tools");
    const tools = await catalog();
    await expect(count(page, "Tools")).toHaveText(String(tools));
    await page.getByRole("button", { name: "Create tool" }).click();
    await page.getByLabel("Component folder").fill("counted");
    await page.getByRole("button", { name: "Create from example" }).click();
    await expect(page.getByRole("heading", { name: "local/counted" })).toBeVisible();
    const created = await catalog();
    expect(created).toBeGreaterThan(tools);
    await expect(count(page, "Tools")).toHaveText(String(created));
    // Deleting it counts down again.
    await page.getByRole("button", { name: "Actions for local/counted" }).click();
    await page.getByRole("menuitem", { name: "Delete component" }).click();
    await page.getByRole("dialog", { name: "Delete component" }).getByRole("button", { name: "Delete component" }).click();
    await expect(page.getByRole("list", { name: "Tools catalog" })).toBeVisible();
    await expect(count(page, "Tools")).toHaveText(String(tools));

    // Installing a package changes the catalogs while Packages stays open.
    await openPath(page, raw.server.launchUrl, "/library/packages");
    await expect(count(page, "Tools")).toHaveText(String(tools));
    await page.getByRole("button", { name: "Import package" }).first().click();
    await page.getByLabel("Local package path").fill(packageSource(raw.root, "counted-kit"));
    await page.getByRole("button", { name: "Inspect path", exact: true }).click();
    await page.getByLabel("Install alias").fill("counted");
    await page.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Installed counted" })).toBeVisible();
    const installed = await catalog();
    expect(installed).toBeGreaterThan(tools);
    await expect(count(page, "Tools")).toHaveText(String(installed));
  });

  test("a count that fails to load is left out, and other pages fetch no catalog", async ({ page, raw }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(raw.server.launchUrl);
    await expect(page.getByRole("link", { name: "Agents", exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    expect(requests.filter((path) => /^\/api\/(components|packages)/.test(path))).toEqual([]);

    const fail = (route: { fulfill(options: object): Promise<void> }) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Injected failure" } }) });
    await page.route("**/api/components/hooks", fail);
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await expect(count(page, "Tools")).toHaveText(/^\d+$/);
    await expect.poll(() => requests.filter((path) => path === "/api/components/hooks").length).toBeGreaterThan(0);
    await expect(count(page, "Hooks")).toHaveCount(0);

    // A count that loaded is dropped when a later refresh of its list fails, not left stale.
    await page.unroute("**/api/components/hooks");
    await openPath(page, raw.server.launchUrl, "/library/hooks");
    await expect(count(page, "Hooks")).toHaveText(/^\d+$/);
    await expect(count(page, "Skills")).toHaveText(/^\d+$/);
    await page.route("**/api/components/skills", fail);
    // Past SWR's 2 s dedupe window, so opening Skills revalidates the cached list.
    await page.waitForTimeout(2100);
    await nav(page, "Library categories").getByRole("link", { name: "Skills", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Injected failure");
    await expect(count(page, "Skills")).toHaveCount(0);
    await expect(count(page, "Tools")).toHaveText(/^\d+$/);
  });
});

test.describe("agent rows", () => {
  const long = "release-notes-writer-for-the-vietnamese-documentation-site";
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/read_file", "builtin/bash"] } },
      extraAgents: {
        second: { model: "fixture", tools: { use: [] } },
        [long]: { model: "fixture", tools: { use: ["builtin/read_file"] } },
      },
    },
  });

  test("agent rows show avatar, subtitle and the default dot, and a long name stays on one line", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/agents");
    const agents = nav(page, "Agents");
    const row = (name: string) => agents.getByRole("link", { name, exact: true });
    await expect(row("raw").locator(".nav-agent small")).toHaveText("fixture · 2 tools · 0 skills");
    await expect(row("second").locator(".nav-agent small")).toHaveText("fixture · 0 tools · 0 skills");
    await expect(row(long).locator(".nav-agent small")).toHaveText("fixture · 1 tool · 0 skills");
    await expect(row("second").locator(".nav-avatar")).toHaveText("s");
    await expect(agents.locator(".nav-default")).toHaveCount(1);
    await expect(row("raw").locator(".nav-default")).toHaveCount(1);

    const box = async (name: string) => (await row(name).boundingBox())!;
    expect((await box(long)).height).toBe((await box("second")).height);
    expect((await box(long)).height).toBe((await box("raw")).height);
    const name = row(long).locator(".nav-agent strong > span").first();
    expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await agents.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
});

test.describe("lists", () => {
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/read_file", "builtin/bash"] } },
      extraAgents: { second: { model: "fixture", tools: { use: ["builtin/read_file"] } } },
    },
  });
  const catalogRow = (page: Page, id: string) =>
    page.getByRole("list", { name: "Tools catalog" }).getByRole("listitem").filter({ has: page.getByRole("link", { name: id, exact: true }) });
  const agentRow = (page: Page, name: string) =>
    page.getByRole("list", { name: "Agent list" }).getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });
  /** A local tool whose manifest no longer parses, so the catalog marks it Invalid. */
  const breakTool = async (raw: { json: (path: string, method?: string, body?: unknown) => Promise<unknown>; configPath: string }) => {
    await raw.json("/components/tools", "POST", { id: "local/broken", cloneFrom: "builtin/read_file" });
    const found = readdirSync(dirname(raw.configPath), { recursive: true, encoding: "utf8" }).find((path) => path.endsWith(join("broken", "tool.json")));
    writeFileSync(join(dirname(raw.configPath), found!), "{ not json");
  };

  test("a row opens from anywhere and its controls stay separate", async ({ page, raw }) => {
    await seedLibrary(raw);
    await breakTool(raw);
    await openPath(page, raw.server.launchUrl, "/agents");
    await pointAt(page, agentRow(page, "raw").locator(".agent-row-model"), true);
    await expect(page).toHaveURL(/\/agents\/raw$/);
    await openPath(page, raw.server.launchUrl, "/agents");
    await agentRow(page, "raw").getByRole("button", { name: "Actions for raw" }).click();
    await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
    await expect(page).toHaveURL(/\/agents$/);
    await page.keyboard.press("Escape");
    await agentRow(page, "raw").getByRole("button", { name: "New chat" }).click();
    await expect(page).toHaveURL(/\/chat\/[^/]+$/);

    await openPath(page, raw.server.launchUrl, "/library/tools");
    await pointAt(page, catalogRow(page, "builtin/read_file").locator(".component-row-usage"), true);
    await expect(page).toHaveURL(/\/library\/tools\/builtin%2Fread_file$/);
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await pointAt(page, catalogRow(page, "builtin/bash").locator(".component-row-badges .badge").first(), true);
    await expect(page).toHaveURL(/\/library\/tools\/builtin%2Fbash$/);
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await pointAt(page, catalogRow(page, "local/broken").locator(".badge.error"), true);
    await expect(page).toHaveURL(/\/library\/tools\/local%2Fbroken$/);

    await openPath(page, raw.server.launchUrl, "/library/packages");
    await pointAt(page, page.getByRole("list", { name: "Installed packages" }).getByRole("listitem").first().locator(".component-row-usage"), true);
    await expect(page).toHaveURL(/\/library\/packages\/shared$/);
  });

  test("linked rows fill on hover, show the chevron and never underline; vars rows do not", async ({ page, raw }) => {
    await seedLibrary(raw);
    for (const theme of ["light", "dark"]) {
      await openPath(page, raw.server.launchUrl, "/agents");
      await setTheme(page, theme);
      const agent = agentRow(page, "second");
      await pointAt(page, agent.locator(".agent-row-model"));
      await expect.poll(() => style(agent, "backgroundColor"), `agents ${theme}`).toBe(await token(page, "--panel-hover"));
      expect(await style(agent.getByRole("link", { name: "second", exact: true }), "textDecorationLine")).toBe("none");

      await openPath(page, raw.server.launchUrl, "/library/tools");
      await setTheme(page, theme);
      const tool = catalogRow(page, "builtin/bash");
      const chevron = tool.locator(".row-chevron");
      await page.mouse.move(0, 0);
      await expect.poll(() => chevron.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
      await pointAt(page, tool.locator(".component-row-usage"));
      await expect.poll(() => style(tool, "backgroundColor"), `tools ${theme}`).toBe(await token(page, "--panel-hover"));
      await expect.poll(() => chevron.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      expect(await style(tool.getByRole("link", { name: "builtin/bash", exact: true }), "textDecorationLine")).toBe("none");

      await openPath(page, raw.server.launchUrl, "/library/vars");
      await setTheme(page, theme);
      const variable = page.getByRole("list", { name: "Variables" }).getByRole("listitem").first();
      await page.mouse.move(0, 0);
      const rest = await style(variable, "backgroundColor");
      await variable.locator(".definition-name").hover();
      await page.waitForTimeout(250);
      expect(await style(variable, "backgroundColor"), `vars ${theme}`).toBe(rest);
      await expect(variable.locator(".row-chevron")).toHaveCount(0);
      await expect(variable.getByRole("link")).toHaveCount(0);
    }
  });

  test("keyboard focus rings the row", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/tools");
    const first = page.getByRole("list", { name: "Tools catalog" }).getByRole("listitem").first();
    expect(await style(first, "boxShadow")).toBe("none");
    await page.getByLabel("Search tools").focus();
    await page.keyboard.press("Tab");
    await expect(first.getByRole("link")).toBeFocused();
    expect(await style(first, "boxShadow")).not.toBe("none");
  });

  test("catalog rows are one line with one source pill and a usage chip", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/tools");
    const read = catalogRow(page, "builtin/read_file");
    const description = read.locator(".component-row-description");
    const { height, line } = await description.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      // `normal` line height: 1.4 × the font size bounds one line of Inter.
      line: parseFloat(getComputedStyle(element).lineHeight) || 1.4 * parseFloat(getComputedStyle(element).fontSize),
    }));
    expect(height).toBeLessThanOrEqual(line * 1.2);
    expect(await description.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const badges = read.locator(".component-row-badges .badge");
    await expect(badges).toHaveCount(1);
    await expect(badges).toContainText("Builtin");
    await expect(badges.locator("svg")).toHaveCount(1);
    await expect(read).toContainText("Read-only");
    await expect(read.locator(".component-row-usage")).toHaveText("Used by 2");
    await expect(read.locator(".component-row-usage")).toHaveClass(/sp-chip/);
    for (const theme of ["light", "dark"]) {
      await setTheme(page, theme);
      expect(await style(read.locator(".component-row-usage"), "backgroundColor")).toBe(await token(page, "--accent-soft"));
    }
    const write = catalogRow(page, "builtin/write_file");
    await expect(write.locator(".component-row-usage")).toHaveText("Not selected");
    await expect(write.locator(".component-row-usage")).not.toHaveClass(/sp-chip/);
    await expect(page.locator("label.search-input").getByLabel("Search tools")).toHaveAttribute("placeholder", "Search tools…");

    // Usage follows the agents: attaching the tool turns its row into a chip.
    await openPath(page, raw.server.launchUrl, "/library/tools/builtin%2Fwrite_file");
    await page.getByRole("button", { name: "Attach to second" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Attached" })).toBeVisible();
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await expect(write.locator(".component-row-usage")).toHaveText("Used by 1");
    await expect(write.locator(".component-row-usage")).toHaveClass(/sp-chip/);
  });

  for (const width of [900, 700]) {
    test(`a narrow card stacks badges under the name at ${width} px`, async ({ page, raw }) => {
      await seedLibrary(raw);
      await page.setViewportSize({ width, height: 800 });
      for (const [path, list] of [["/library/tools", "Tools catalog"], ["/library/packages", "Installed packages"]] as const) {
        await openPath(page, raw.server.launchUrl, path);
        const row = page.getByRole("list", { name: list }).getByRole("listitem").first();
        await expect(row).toBeVisible();
        const box = await row.evaluate((element) => {
          const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
          const s = getComputedStyle(element);
          return {
            content: element.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
            name: rect(".component-row-name"),
            description: rect(".component-row-description"),
            badges: rect(".component-row-badges"),
            usage: rect(".component-row-usage"),
          };
        });
        expect(box.badges.top, path).toBeGreaterThanOrEqual(box.name.bottom - 1);
        expect(box.description.width, path).toBeGreaterThanOrEqual(0.85 * box.content);
        expect(box.usage.width, path).toBeGreaterThan(0);
        expect(Math.abs(box.usage.top + box.usage.height / 2 - (box.badges.top + box.badges.height / 2)), path).toBeLessThan(6);
        await expect(row.locator(".component-row-usage")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      }
    });
  }
});
