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
