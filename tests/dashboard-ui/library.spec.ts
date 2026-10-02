import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/** Opens a dashboard path directly; the launch URL's query carries the session token. */
export const openPath = (page: Page, launchUrl: string, path: string) =>
  page.goto(launchUrl.replace(/\/?(\?|#|$)/, `${path}$1`));

test.describe("library navigation", () => {
  test("the sidebar marks the current library section on list and detail routes", async ({ page, raw }) => {
    const nav = page.getByRole("navigation", { name: "Library categories" });
    await openPath(page, raw.server.launchUrl, "/library");
    await expect(nav.getByRole("link", { name: "Tools", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator("[aria-current]")).toHaveCount(1);
    await openPath(page, raw.server.launchUrl, "/library/hooks");
    await expect(nav.getByRole("link", { name: "Hooks", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Tools", exact: true })).not.toHaveAttribute("aria-current", "page");
    await openPath(page, raw.server.launchUrl, "/library/tools/builtin%2Fread_file");
    await expect(page.getByRole("heading", { name: "builtin/read_file" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Tools", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator("[aria-current]")).toHaveCount(1);
  });

  test("an unknown library section is reported instead of showing packages", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/typo");
    await expect(page.getByRole("heading", { name: "Library section not found" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Library section not found" })).toBeVisible();
    // In-app navigation reaches the same page.
    await openPath(page, raw.server.launchUrl, "/library");
    await page.evaluate(() => {
      history.pushState({}, "", "/library/typo");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByRole("heading", { name: "Library section not found" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Packages", exact: true })).toHaveCount(0);
    await page.getByRole("main").getByRole("link", { name: "Open Tools" }).click();
    await expect(page).toHaveURL(/\/library\/tools$/);
    await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
  });
});

const catalogRow = (page: Page, kind: string, id: string) =>
  page
    .getByRole("list", { name: `${kind} catalog` })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: id, exact: true }) });

test.describe("component catalog", () => {
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/read_file"] } },
      extraAgents: { second: { model: "fixture", tools: { use: ["builtin/read_file", "builtin/bash"] } } },
    },
  });

  test("rows show source, read-only state and usage from the catalog", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
    const read = catalogRow(page, "Tools", "builtin/read_file");
    await expect(read.locator(".badge").filter({ hasText: "Builtin" })).toBeVisible();
    await expect(read.locator(".badge").filter({ hasText: "Read-only" })).toBeVisible();
    await expect(read).toContainText("Used by 2");
    await expect(catalogRow(page, "Tools", "builtin/bash")).toContainText("Used by 1");
    await expect(catalogRow(page, "Tools", "builtin/write_file")).toContainText("Not selected");
    await expect(read.locator(".badge.error")).toHaveCount(0);
  });

  test("search narrows rows, and a search without matches differs from an empty catalog", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/tools");
    const rows = page.getByRole("list", { name: "Tools catalog" }).getByRole("listitem");
    await expect(catalogRow(page, "Tools", "builtin/write_file")).toBeVisible();
    const total = await rows.count();
    expect(total).toBeGreaterThan(2);
    await page.getByLabel("Search tools").fill("read_file");
    await expect(rows).not.toHaveCount(total);
    for (const text of await rows.allTextContents()) expect(text.toLowerCase()).toContain("read_file");
    await page.getByLabel("Search tools").fill("zzz-no-such-tool");
    await expect(page.getByText("No tools match “zzz-no-such-tool”.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No tools yet" })).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(rows).toHaveCount(total);
  });

  test("an empty catalog offers to create the first component", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/hooks");
    await expect(page.getByRole("heading", { name: "No hooks yet" })).toBeVisible();
    await expect(page.getByLabel("Search hooks")).toHaveCount(0);
    await page.getByRole("button", { name: "Create hook" }).click();
    await expect(page.getByRole("dialog", { name: "Create hook" })).toBeVisible();
  });

  test("a failed create shows one error, inside the dialog", async ({ page, raw }) => {
    await page.route("**/api/components/tools", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "conflict", message: "Injected conflict" } }) })
        : route.continue(),
    );
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await page.getByRole("button", { name: "Create tool", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create tool" });
    await dialog.getByLabel("Component folder").fill("probe");
    await dialog.getByRole("button", { name: "Create from example" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Injected conflict");
    // Count DOM alerts: the modal hides the page from the accessibility tree, not from view.
    await expect(page.locator('[role="alert"]')).toHaveCount(1);
    // Reopening starts clean.
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Create tool", exact: true }).click();
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  });

  test("a failed refresh keeps the cached rows and reports the error once", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/tools");
    await expect(catalogRow(page, "Tools", "builtin/read_file")).toBeVisible();
    await page.route("**/api/components/tools", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Injected failure" } }) }),
    );
    const nav = page.getByRole("navigation", { name: "Library categories" });
    await nav.getByRole("link", { name: "Hooks", exact: true }).click();
    // Let SWR's 2 s dedupe window pass so returning revalidates the cached list.
    await page.waitForTimeout(2100);
    await nav.getByRole("link", { name: "Tools", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Injected failure");
    await expect(page.locator('[role="alert"]')).toHaveCount(1);
    await expect(catalogRow(page, "Tools", "builtin/read_file")).toBeVisible();
    await page.unroute("**/api/components/tools");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  });
});

const saved = (raw: { configPath: string }) => JSON.parse(readFileSync(raw.configPath, "utf8"));
const usedByRow = (page: Page, agent: string) =>
  page.getByRole("list", { name: "Agents using this component" }).getByRole("listitem").filter({ has: page.locator(".used-by-name", { hasText: new RegExp(`^${agent}$`) }) });
const openComponent = async (page: Page, launchUrl: string, kind: string, id: string) => {
  await openPath(page, launchUrl, `/library/${kind}/${encodeURIComponent(id)}`);
  await expect(page.getByRole("heading", { level: 1, name: id, exact: true })).toBeVisible();
};

test.describe("component detail", () => {
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/read_file"] } },
      extraAgents: { second: { model: "fixture", tools: { use: [] } } },
    },
  });

  test("a builtin shows its breadcrumb, badges, Fork as the primary action and no Delete", async ({ page, raw }) => {
    await openComponent(page, raw.server.launchUrl, "tools", "builtin/read_file");
    const header = page.locator(".detail-header");
    const crumbs = header.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: "Library" })).toBeVisible();
    await expect(header.locator(".badge").filter({ hasText: "Builtin" })).toBeVisible();
    await expect(header.locator(".badge").filter({ hasText: "Read-only" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Fork to local" })).toHaveClass(/primary/);
    await header.getByRole("button", { name: "Actions for builtin/read_file" }).click();
    await expect(page.getByRole("menuitem", { name: "Fork to local" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete component" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Add text file" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await crumbs.getByRole("link", { name: "Tools" }).click();
    await expect(page).toHaveURL(/\/library\/tools$/);
  });

  test("Used by lists every agent and attaches or detaches one at a time", async ({ page, raw }) => {
    await openComponent(page, raw.server.launchUrl, "tools", "builtin/read_file");
    await expect(usedByRow(page, "raw").locator(".badge")).toHaveText("Attached");
    await expect(usedByRow(page, "second").locator(".badge")).toHaveText("Not attached");
    await page.getByRole("button", { name: "Detach from raw" }).click();
    await expect(usedByRow(page, "raw").locator(".badge")).toHaveText("Not attached");
    await expect(page.getByRole("status").filter({ hasText: "Detached" })).toBeVisible();
    expect(saved(raw).agents.raw.tools.use).not.toContain("builtin/read_file");
    await page.getByRole("button", { name: "Attach to second" }).click();
    await expect(usedByRow(page, "second").locator(".badge")).toHaveText("Attached");
    expect(saved(raw).agents.second.tools.use).toContain("builtin/read_file");
  });

  test("package-bound agents are listed without attach controls", async ({ page, raw }) => {
    // The selection API rejects package bindings; the view marks them from the config summary.
    await page.route("**/api/config", async (route) => {
      const response = await route.fetch();
      const view = await response.json();
      view.agentSummaries.second = { ...view.agentSummaries.second, from: "pkg/kit/agents/writer" };
      await route.fulfill({ response, json: view });
    });
    await openComponent(page, raw.server.launchUrl, "tools", "builtin/read_file");
    const row = usedByRow(page, "second");
    await expect(row.locator(".badge").filter({ hasText: "Package binding" })).toBeVisible();
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(row.getByRole("link", { name: "Edit in agent" })).toHaveAttribute("href", "/agents/second");
    await expect(page.getByLabel("Attach to agent").locator("option", { hasText: "second" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Attach to raw" }).or(page.getByRole("button", { name: "Detach from raw" }))).toBeVisible();
  });

  test("detaching an agent that uses the component through another reference warns instead of claiming success", async ({ page, raw }) => {
    await raw.json("/components/tools", "POST", { id: "local/shared", cloneFrom: "builtin/read_file" });
    const config = saved(raw);
    config.agents.second.tools.use = ["agent/shared"];
    writeFileSync(raw.configPath, JSON.stringify(config));
    await openComponent(page, raw.server.launchUrl, "tools", "local/shared");
    await expect(usedByRow(page, "second").locator(".badge")).toHaveText("Attached");
    await page.getByRole("button", { name: "Detach from second" }).click();
    await expect(page.getByText("second still uses this component through another reference.")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Detached" })).toHaveCount(0);
    await expect(usedByRow(page, "second").locator(".badge")).toHaveText("Attached");
    expect(saved(raw).agents.second.tools.use).toEqual(["agent/shared"]);
  });

  test("hook events read as a table rather than raw JSON", async ({ page, raw }) => {
    await raw.json("/components/hooks", "POST", {
      id: "local/guard",
      files: {
        "hook.json": JSON.stringify({ protocol_version: 2, name: "guard", command: "node", args: ["./index.mjs"], timeout_ms: 4000,
          events: [{ name: "PreToolUse", match: "builtin/bash", when: { source: "arguments", any: "commands[*].command", regex: "rm " } }, { name: "Stop" }] }),
        "index.mjs": "process.stdout.write('{}');\n",
      },
    });
    await openComponent(page, raw.server.launchUrl, "hooks", "local/guard");
    const events = page.getByRole("table", { name: "Hook events" });
    await expect(events.getByRole("row")).toHaveCount(3);
    await expect(events.getByRole("row").nth(1)).toContainText("PreToolUse");
    await expect(events.getByRole("row").nth(1)).toContainText("builtin/bash");
    await expect(events.getByRole("row").nth(1)).toContainText("commands[*].command");
    await expect(events.getByRole("row").nth(2)).toContainText("Any tool");
    expect(await events.textContent()).not.toMatch(/[{}]/);
    await expect(page.getByText("4000 ms")).toBeVisible();
  });

  test("the Source tab keeps a dirty draft across tab switches and saves it", async ({ page, raw }) => {
    await raw.json("/components/tools", "POST", { id: "local/probe", cloneFrom: "builtin/read_file" });
    await openComponent(page, raw.server.launchUrl, "tools", "local/probe");
    await expect(page.locator(".sticky-savebar")).toHaveCount(0);
    await page.getByRole("tab", { name: "Source" }).click();
    await page.getByLabel("Source file", { exact: true }).selectOption("index.mjs");
    const editor = page.getByRole("textbox", { name: "Source index.mjs", exact: true });
    await editor.fill("export async function handler() { return { isError: false, content: [] }; }\n");
    await expect(page.locator(".sticky-savebar")).toContainText("Unsaved changes");
    await expect(page.getByLabel("Source file", { exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByRole("dialog", { name: "Unsaved changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Actions for local/probe" })).toBeDisabled();
    await page.getByRole("tab", { name: "Source" }).click();
    await expect(editor).toContainText("isError: false, content: []");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    expect(readFileSync(join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "probe", "index.mjs"), "utf8")).toContain("content: []");
  });

  test("Markdown files toggle between source and a rendered preview without disclosures", async ({ page, raw }) => {
    await raw.json("/components/skills", "POST", { id: "local/guide", cloneFrom: "builtin/create_skill" });
    await openComponent(page, raw.server.launchUrl, "skills", "local/guide");
    await page.getByRole("tab", { name: "Source" }).click();
    const mode = page.getByRole("radiogroup", { name: "Markdown view" });
    await expect(page.getByRole("textbox", { name: "Source SKILL.md", exact: true })).toBeVisible();
    await mode.getByRole("radio", { name: "Preview" }).click();
    await expect(page.getByRole("textbox", { name: "Source SKILL.md", exact: true })).toHaveCount(0);
    await expect(page.locator(".markdown-preview").getByRole("heading").first()).toBeVisible();
    await expect(page.locator("details")).toHaveCount(0);
    await mode.getByRole("radio", { name: "Source" }).click();
    await expect(page.getByRole("textbox", { name: "Source SKILL.md", exact: true })).toBeVisible();
  });

  test("Delete is destructive, confirmed in a dialog, and returns to the list", async ({ page, raw }) => {
    await raw.json("/components/tools", "POST", { id: "local/gone", cloneFrom: "builtin/read_file" });
    await openComponent(page, raw.server.launchUrl, "tools", "local/gone");
    await expect(page.locator(".detail-header").getByRole("button", { name: "Fork to local" })).toHaveCount(0);
    await page.getByRole("button", { name: "Actions for local/gone" }).click();
    await page.getByRole("menuitem", { name: "Delete component" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete component" });
    const confirm = dialog.getByRole("button", { name: "Delete component" });
    await expect(confirm).toHaveClass(/danger/);
    await confirm.click();
    await expect(page).toHaveURL(/\/library\/tools$/);
    await expect(page.getByRole("link", { name: "local/gone", exact: true })).toHaveCount(0);
    expect(existsSync(join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "gone"))).toBe(false);
  });
});

test.describe("component detail data integrity", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/read_file"] } } } });

  test("switching files starts a fresh editor whose undo cannot restore the previous file", async ({ page, raw }) => {
    await raw.json("/components/tools", "POST", { id: "local/probe", cloneFrom: "builtin/read_file" });
    await openComponent(page, raw.server.launchUrl, "tools", "local/probe");
    await page.getByRole("tab", { name: "Source" }).click();
    await expect(page.getByRole("textbox", { name: "Source tool.json", exact: true })).toContainText("api_version");
    await page.getByLabel("Source file", { exact: true }).selectOption("index.mjs");
    const editor = page.getByRole("textbox", { name: "Source index.mjs", exact: true });
    await expect(editor).toContainText("src/tools/primitives.ts");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor).not.toContainText("api_version");
    await expect(page.locator(".sticky-savebar")).toHaveCount(0);
  });

  test("a failed usage check after detaching reports an error instead of a warning", async ({ page, raw }) => {
    let selected = false;
    await page.route("**/api/components/tools/**", async (route) => {
      const request = route.request();
      if (request.url().endsWith("/selection")) {
        selected = true;
        return route.continue();
      }
      if (selected && request.method() === "GET" && !request.url().includes("/file"))
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Injected failure" } }) });
      return route.continue();
    });
    await openComponent(page, raw.server.launchUrl, "tools", "builtin/read_file");
    await page.getByRole("button", { name: "Detach from raw" }).click();
    await expect(page.getByRole("alert")).toContainText("usage could not be checked");
    await expect(page.getByText("still uses this component")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Detached" })).toHaveCount(0);
    expect(saved(raw).agents.raw.tools.use).not.toContain("builtin/read_file");
  });

  test("a failed agent list load is reported, not shown as no agents", async ({ page, raw }) => {
    await page.route("**/api/config", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Injected failure" } }) }),
    );
    await openComponent(page, raw.server.launchUrl, "tools", "builtin/read_file");
    await expect(page.getByRole("alert").filter({ hasText: "Could not load agents" })).toBeVisible();
    await expect(page.getByText("No agents yet")).toHaveCount(0);
  });
});
