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
