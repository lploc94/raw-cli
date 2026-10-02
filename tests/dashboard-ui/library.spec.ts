import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const withDefinitions = (raw: { configPath: string }) => {
  const config = saved(raw);
  config.var_providers = { cmd: { command: process.execPath, args: ["-e", "process.stdin.once('data',()=>console.log(JSON.stringify({value:'x'})))"] } };
  config.vars = {
    lit: { description: "A greeting", type: "string", access: "read", source: { kind: "literal", value: "Hello from vars" } },
    envy: { description: "Token", access: "use", source: { kind: "env", name: "SOME_TOKEN" } },
    prov: { description: "Provided", access: "read", source: { kind: "provider", name: "cmd" } },
  };
  config.mcp = { servers: {
    local: { transport: "stdio", command: "node", args: ["server.mjs"] },
    remote: { transport: "streamable-http", url: "https://example.invalid/mcp" },
  } };
  config.agents.raw.vars = ["lit"];
  config.agents.raw.tools = { use: ["mcp/remote/search"] };
  writeFileSync(raw.configPath, JSON.stringify(config));
};
const definitionRow = (page: Page, list: string, name: string) =>
  page.getByRole("list", { name: list }).getByRole("listitem").filter({ has: page.locator(".definition-name", { hasText: new RegExp(`^${name}$`) }) });

test.describe("vars and MCP", () => {
  test("variable rows summarize source, access, type and usage, with providers listed", async ({ page, raw }) => {
    withDefinitions(raw);
    await openPath(page, raw.server.launchUrl, "/library/vars");
    const lit = definitionRow(page, "Variables", "lit");
    await expect(lit).toContainText("A greeting");
    await expect(lit.locator(".badge").filter({ hasText: /^literal$/ })).toBeVisible();
    await expect(lit.locator(".badge").filter({ hasText: /^read$/ })).toBeVisible();
    await expect(lit).toContainText("string");
    await expect(lit).toContainText("Used by 1");
    const envy = definitionRow(page, "Variables", "envy");
    await expect(envy.locator(".badge").filter({ hasText: /^env$/ })).toBeVisible();
    await expect(envy.locator(".badge").filter({ hasText: /^use only$/ })).toBeVisible();
    await expect(envy).toContainText("Not selected");
    await expect(definitionRow(page, "Providers", "cmd")).toContainText("Used by 1 var");
    await expect(page.locator("details")).toHaveCount(0);
  });

  test("a row Check opens the Check tab ready to run, without running it", async ({ page, raw }) => {
    withDefinitions(raw);
    const checks: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/checks")) checks.push(request.url());
    });
    await openPath(page, raw.server.launchUrl, "/library/vars");
    await definitionRow(page, "Variables", "lit").getByRole("button", { name: "Check lit" }).click();
    await expect(page.getByRole("tab", { name: "Check" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Variable name")).toHaveValue("lit");
    await expect(page.getByRole("button", { name: "Read", exact: true })).toBeFocused();
    expect(checks).toEqual([]);
    await page.getByRole("button", { name: "Read", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Check" });
    await expect(panel.locator(".source-preview")).toContainText("Hello from vars");
    await expect(panel.getByRole("status")).toHaveCount(1);
    await expect(panel.getByRole("status")).toContainText("Check completed");
  });

  test("MCP rows show transport and usage without exposing locators", async ({ page, raw }) => {
    withDefinitions(raw);
    await openPath(page, raw.server.launchUrl, "/library/mcp");
    const remote = definitionRow(page, "MCP servers", "remote");
    await expect(remote.locator(".badge").filter({ hasText: /^HTTP$/ })).toBeVisible();
    await expect(remote).toContainText("Used by 1");
    await expect(definitionRow(page, "MCP servers", "local").locator(".badge").filter({ hasText: /^stdio$/ })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Overview" })).not.toContainText("example.invalid");
    await definitionRow(page, "MCP servers", "local").getByRole("button", { name: "Discover local" }).click();
    await expect(page.getByLabel("MCP server name")).toHaveValue("local");
    await expect(page.getByRole("button", { name: "Discover", exact: true })).toBeFocused();
  });

  test("an empty page offers Edit definitions, and the save bar persists edits", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/vars");
    await expect(page.getByRole("heading", { name: "No variables yet" })).toBeVisible();
    await page.getByRole("button", { name: "Edit definitions" }).click();
    await expect(page.getByRole("tab", { name: "Definitions" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".sticky-savebar")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Definitions JSON", exact: true }).fill(JSON.stringify({
      vars: { greeting: { description: "Greeting", access: "read", source: { kind: "literal", value: "Hi" } } }, var_providers: {},
    }));
    await expect(page.locator(".sticky-savebar")).toContainText("Unsaved changes");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    expect(saved(raw).vars.greeting.description).toBe("Greeting");
    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(definitionRow(page, "Variables", "greeting")).toContainText("Greeting");
  });

  test("providers stay listed when no variables exist", async ({ page, raw }) => {
    const config = saved(raw);
    config.var_providers = { cmd: { command: "node", args: [] } };
    writeFileSync(raw.configPath, JSON.stringify(config));
    await openPath(page, raw.server.launchUrl, "/library/vars");
    await expect(definitionRow(page, "Providers", "cmd")).toContainText("No vars");
    await expect(page.getByRole("list", { name: "Variables" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit definitions" })).toHaveCount(1);
  });

  test("the definitions save bar stays on its tab, so Check keeps one status and one error", async ({ page, raw }) => {
    withDefinitions(raw);
    await openPath(page, raw.server.launchUrl, "/library/vars");
    await page.getByRole("tab", { name: "Definitions" }).click();
    const editor = page.getByRole("textbox", { name: "Definitions JSON", exact: true });
    await expect(editor).toContainText("A greeting");
    await editor.fill(JSON.stringify({ vars: { lit: { description: "Changed", access: "read", source: { kind: "literal", value: "Hi" } } }, var_providers: {} }));
    await page.getByRole("tab", { name: "Check" }).click();
    await expect(page.getByRole("tab", { name: /Definitions/ })).toContainText("Unsaved");
    await expect(page.locator(".sticky-savebar")).toHaveCount(0);
    await expect(page.locator('[role="status"]')).toHaveCount(0);
    await page.getByRole("tab", { name: /Definitions/ }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await page.getByRole("tab", { name: "Check" }).click();
    await page.getByLabel("Variable name").fill("lit");
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect(page.locator(".source-preview")).toContainText("Hi");
    await expect(page.locator('[role="status"]')).toHaveCount(1);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  });

  test("a row action during a running check focuses Read once the check finishes", async ({ page, raw }) => {
    withDefinitions(raw);
    let finish = false;
    const row = { id: "held", kind: "var", name: "lit", agent: "raw", startedAt: new Date().toISOString() };
    await page.route("**/api/checks", (route) => route.fulfill({ json: { ...row, state: "running" } }));
    await page.route("**/api/checks/held", (route) =>
      route.fulfill({ json: finish ? { ...row, state: "completed", finishedAt: new Date().toISOString(), result: { value: "Hi" } } : { ...row, state: "running" } }),
    );
    await openPath(page, raw.server.launchUrl, "/library/vars");
    await definitionRow(page, "Variables", "lit").getByRole("button", { name: "Check lit" }).click();
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel check" })).toBeVisible();
    await page.getByRole("tab", { name: "Overview" }).click();
    await definitionRow(page, "Variables", "envy").getByRole("button", { name: "Check envy" }).click();
    await expect(page.getByLabel("Variable name")).toHaveValue("envy");
    await expect(page.getByRole("button", { name: "Read", exact: true })).toBeDisabled();
    finish = true;
    await expect(page.getByRole("button", { name: "Read", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Read", exact: true })).toBeFocused();
  });
});

function packageSource(root: string, folderName = "shared-kit") {
  const folder = join(root, folderName);
  cpSync(join(process.cwd(), "examples/packages/tool-only"), folder, { recursive: true });
  mkdirSync(join(folder, "agents"));
  writeFileSync(join(folder, "agents/writer.json"), JSON.stringify({ system_prompt: { $input: "prompt" }, tools: { use: [] } }));
  const manifest = JSON.parse(readFileSync(join(folder, "raw-package.json"), "utf8"));
  manifest.files.push("agents/writer.json");
  manifest.exports.agents = { writer: "agents/writer.json" };
  manifest.inputs = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
  writeFileSync(join(folder, "raw-package.json"), JSON.stringify(manifest));
  return folder;
}
type Raw = { root: string; json: <T>(path: string, method?: string, body?: unknown) => Promise<T> };
const install = async (raw: Raw, alias: string, action: "install" | "link" = "install", folderName?: string) => {
  const stage = await raw.json<{ id: string }>("/packages/inspect", "POST", { path: packageSource(raw.root, folderName ?? `${alias}-kit`) });
  await raw.json("/packages/install", "POST", { stageId: stage.id, alias, action });
};
const packageRow = (page: Page, alias: string) =>
  page.getByRole("list", { name: "Installed packages" }).getByRole("listitem").filter({ has: page.getByRole("link", { name: alias, exact: true }) });

test.describe("packages", () => {
  test("an empty list offers Import package", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/packages");
    await expect(page.getByRole("heading", { name: "No packages yet" })).toBeVisible();
    await page.getByRole("button", { name: "Import package" }).first().click();
    await expect(page.getByRole("dialog", { name: "Import package" }).getByLabel("Local package path")).toBeVisible();
  });

  test("rows show version, source kind, attention and usage", async ({ page, raw }) => {
    await install(raw, "shared");
    await install(raw, "authored", "link");
    rmSync(join(raw.root, "authored-kit"), { recursive: true });
    await openPath(page, raw.server.launchUrl, "/library/packages");
    const shared = packageRow(page, "shared");
    await expect(shared.locator(".badge").filter({ hasText: /^1\.0\.0$|^v?\d/ })).toBeVisible();
    await expect(shared.locator(".badge").filter({ hasText: "Artifact" })).toBeVisible();
    await expect(shared.locator(".badge").filter({ hasText: "Needs attention" })).toHaveCount(0);
    await expect(shared).toContainText("Not used");
    const authored = packageRow(page, "authored");
    await expect(authored.locator(".badge").filter({ hasText: "Linked" })).toBeVisible();
    await expect(authored.locator(".badge.warning").filter({ hasText: "Needs attention" })).toBeVisible();
    await page.getByLabel("Search packages").fill("zzz");
    await expect(page.getByText("No packages match “zzz”.")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(packageRow(page, "shared")).toBeVisible();
  });

  test("temporary artifacts show when they expire", async ({ page, raw }) => {
    const stage = await raw.json<{ expiresAt: string }>("/packages/inspect", "POST", { path: packageSource(raw.root) });
    await openPath(page, raw.server.launchUrl, "/library/packages");
    const expected = await page.evaluate(
      (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      stage.expiresAt,
    );
    const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Temporary artifacts" }) });
    await expect(card).toContainText(`Expires ${expected}`);
    await card.getByRole("button", { name: "Review" }).click();
    const dialog = page.getByRole("dialog", { name: "Review package" });
    await expect(dialog.getByText("Recipient input schema")).toBeVisible();
    await expect(page.locator("details")).toHaveCount(0);
  });

  test("an unknown alias reports that the package was not found", async ({ page, raw }) => {
    await openPath(page, raw.server.launchUrl, "/library/packages/nope");
    await expect(page.getByRole("heading", { name: "Package not found" })).toBeVisible();
    await page.getByRole("main").getByRole("link", { name: "Open Packages" }).click();
    await expect(page).toHaveURL(/\/library\/packages$/);
  });

  test("detail has a header, Use agent, a menu, cards and no disclosures", async ({ page, raw }) => {
    await install(raw, "shared");
    await openPath(page, raw.server.launchUrl, "/library/packages/shared");
    const header = page.locator(".detail-header");
    await expect(header.getByRole("heading", { level: 1, name: "shared" })).toBeVisible();
    await expect(header.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Packages" })).toBeVisible();
    await expect(header.locator(".badge").filter({ hasText: "Artifact" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Use agent" })).toHaveClass(/primary/);
    await header.getByRole("button", { name: "Actions for shared" }).click();
    for (const item of ["Add component", "Update package", "Fork package", "Remove package"])
      await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    await page.keyboard.press("Escape");
    for (const title of ["Overview", "Exports", "Requirements"])
      await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Packaged files" })).toBeVisible();
    await expect(page.locator("details")).toHaveCount(0);
  });

  test("a failed removal shows one error, inside a destructive dialog", async ({ page, raw }) => {
    await install(raw, "shared");
    const config = await raw.json<{ revision: string }>("/config");
    await raw.json("/packages/shared/agent", "POST", { revision: config.revision, exportName: "writer", inputs: { prompt: "x" }, name: "writer", model: "fixture" });
    await openPath(page, raw.server.launchUrl, "/library/packages/shared");
    await page.getByRole("button", { name: "Actions for shared" }).click();
    await page.getByRole("menuitem", { name: "Remove package" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove package" });
    const confirm = dialog.getByRole("button", { name: "Remove alias" });
    await expect(confirm).toHaveClass(/danger/);
    await confirm.click();
    await expect(dialog.getByRole("alert")).toContainText("agents.writer");
    // Count DOM alerts: the modal hides the page from the accessibility tree, not from view.
    await expect(page.locator('[role="alert"]')).toHaveCount(1);
  });

  test("binding defaults fill in when the config arrives after the dialog opens", async ({ page, raw }) => {
    await install(raw, "shared");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/config", async (route) => {
      await held;
      await route.continue();
    });
    await openPath(page, raw.server.launchUrl, "/library/packages/shared");
    await page.getByRole("button", { name: "Use agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Use agent" });
    await expect(dialog.getByLabel("Recipient model")).toHaveValue("");
    release();
    await expect(dialog.getByLabel("Recipient model")).toHaveValue("fixture");
    await dialog.getByLabel("Local agent name").fill("writer");
    await dialog.getByLabel("Input prompt", { exact: true }).fill("Prompt");
    await dialog.getByRole("button", { name: "Create agent binding" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Agent writer created" })).toBeVisible();
  });

  test("discarding an artifact holds every artifact action until it finishes", async ({ page, raw }) => {
    for (const name of ["one-kit", "two-kit"]) await raw.json("/packages/inspect", "POST", { path: packageSource(raw.root, name) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/packages/stages/*", async (route) => {
      if (route.request().method() === "DELETE") await held;
      await route.continue();
    });
    await openPath(page, raw.server.launchUrl, "/library/packages");
    const card = page.getByRole("list", { name: "Temporary artifacts" });
    await expect(card.getByRole("listitem")).toHaveCount(2);
    await card.getByRole("button", { name: "Discard artifact" }).first().click();
    for (const button of await card.getByRole("button").all()) await expect(button).toBeDisabled();
    release();
    await expect(card.getByRole("listitem")).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Discard artifact" })).toBeEnabled();
  });

  test("reloading the config keeps an explicit Keep unselected recipient", async ({ page, raw }) => {
    const stage = await raw.json<{ id: string }>("/packages/inspect", "POST", { path: join(process.cwd(), "examples/packages/mixed-kit") });
    await raw.json("/packages/install", "POST", { stageId: stage.id, alias: "mixed", action: "install" });
    await openPath(page, raw.server.launchUrl, "/library/packages/mixed");
    await page.getByRole("button", { name: "Actions for mixed" }).click();
    await page.getByRole("menuitem", { name: "Add component" }).click();
    const dialog = page.getByRole("dialog", { name: "Add component" });
    await dialog.getByLabel("Component kind").selectOption("vars");
    await expect(dialog.getByLabel("Recipient agent")).toHaveValue("raw");
    await dialog.getByLabel("Recipient agent").selectOption("");
    // An external edit makes the save conflict, which offers to reload the config.
    const config = saved(raw);
    config.agents.raw.system_prompt = "Edited elsewhere";
    writeFileSync(raw.configPath, JSON.stringify(config));
    await dialog.getByRole("button", { name: "Save component binding" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    const reloaded = page.waitForResponse((response) => response.url().endsWith("/api/config"));
    await dialog.getByRole("button", { name: "Reload config, keep form" }).click();
    await reloaded;
    await page.waitForTimeout(200);
    await expect(dialog.getByLabel("Recipient agent")).toHaveValue("");
  });
});
