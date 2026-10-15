/**
 * The host-owned Approvals tab (docs/side-panel-design.md §3.3): a call waiting for permission shows the files it
 * intends to change and the lines it would write, and is answered from the panel itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";

test.use({ scenario: chatScenario });

const REPORT = "reports/links.md";
const PREFERENCES = "raw.dashboard.preferences.v1";
const tabOf = (page: Page) => page.getByRole("tab", { name: "Approvals", exact: true });
const panelOf = (page: Page) => page.locator('[data-tab-panel="__approvals"]');
const reviewOf = (page: Page) => panelOf(page).locator(".review-card");
const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
/** Layout faults inside the tab: the panel and its rows must not overflow, and a cut value keeps its full text. */
function panelFaults(page: Page) {
  return page.getByRole("tabpanel").evaluate((root) => {
    const faults: string[] = [];
    if (root.scrollWidth > root.clientWidth) faults.push(`tab content overflows by ${root.scrollWidth - root.clientWidth}px`);
    for (const card of root.querySelectorAll<HTMLElement>(".review-card"))
      if (card.scrollWidth > card.clientWidth) faults.push("a review card overflows");
    for (const row of root.querySelectorAll<HTMLElement>(".review-file-row")) {
      if (row.scrollWidth > row.clientWidth) faults.push(`a file row overflows: "${row.textContent}"`);
      for (const text of row.querySelectorAll<HTMLElement>(".review-file-name, .review-file-folder"))
        if (text.scrollWidth > text.clientWidth + 1 && !text.closest("[title]")) faults.push(`a cut value has no full text: "${text.textContent}"`);
    }
    return faults;
  });
}
/** Opens the side panel on the Approvals tab the way the in-chat card offers it. */
async function openReview(page: Page) {
  await page.locator("section.approval").getByRole("button", { name: "Review", exact: true }).click();
  await expect(panelOf(page)).toBeVisible();
}

test("a write waiting for permission is reviewed and allowed from the side panel", async ({ page, raw }) => {
  installChatWorkspace(raw);
  await seedChat(page, raw, "approval");
  // The panel here follows the todo panel; the pending write neither takes that tab nor renders its review yet.
  await expect(page.locator('.sp-tabs [role="tab"][aria-selected="true"]')).toHaveText(/Todo/);
  await expect(panelOf(page)).toHaveCount(0);
  // The card's own control keeps the dashboard's 32 px target, like the ones beside it.
  const review = page.locator("section.approval").getByRole("button", { name: "Review", exact: true });
  const box = await review.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  await openReview(page);
  await expect(tabOf(page)).toHaveAttribute("aria-selected", "true");
  const card = reviewOf(page);
  await expect(card).toHaveCount(1);
  // The same headline the in-chat card carries: the call's title and the path it was given.
  await expect(card.locator(".review-title")).toHaveText("Write");
  await expect(card.locator(".review-summary")).toHaveText("reports/links.md");
  // The intended file, and the lines the call would write, are readable before anything reaches the disk.
  const file = card.getByRole("button", { name: /links\.md/ });
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await file.click();
  await expect(file).toHaveAttribute("aria-expanded", "true");
  const diff = card.locator(".diff-view");
  await expect(diff).toContainText("+++ b/reports/links.md");
  await expect(diff).toContainText("+# Link report");
  await expect(diff).toContainText("+41 ok, 3 broken");
  expect(existsSync(join(raw.root, REPORT))).toBe(false);
  // The panel answers the same call the card would, and the tab leaves with the last pending approval.
  await card.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(() => raw.server.context.store!.listOperations()[0]?.state).toBe("completed");
  expect(readFileSync(join(raw.root, REPORT), "utf8")).toBe("# Link report\n\n41 ok, 3 broken\n");
  await expect(page.locator('[data-tab-panel="__approvals"]')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Approvals", exact: true })).toHaveCount(0);
});

test("denying from the side panel writes nothing", async ({ page, raw }) => {
  installChatWorkspace(raw);
  await seedChat(page, raw, "approval");
  await openReview(page);
  await reviewOf(page).getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(() => raw.server.context.store!.listOperations()[0]?.state).toBe("completed");
  expect(existsSync(join(raw.root, REPORT))).toBe(false);
  await expect(page.getByTestId("assistant-message").nth(1)).toContainText("Đã ghi báo cáo", { timeout: 30000 });
  await expect(page.locator('[data-tab-panel="__approvals"]')).toHaveCount(0);
});

test("a waiting approval survives a reload and is reviewed without the mouse", async ({ page, raw }) => {
  installChatWorkspace(raw);
  await seedChat(page, raw, "approval");
  await page.reload();
  // The pending call comes back from the session snapshot, and its review is still asked for before it shows.
  await expect(page.locator("section.approval")).toHaveCount(1);
  await expect(panelOf(page)).toHaveCount(0);
  await openReview(page);
  const card = reviewOf(page);
  await expect(card).toHaveCount(1);
  // The file row is an ordinary button: Enter opens it, Space closes it.
  const file = card.getByRole("button", { name: /links\.md/ });
  await file.focus();
  await page.keyboard.press("Enter");
  await expect(file).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(file).toHaveAttribute("aria-expanded", "false");
  // Exactly one tab is in the tab order, and the card opened that one.
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveText(/Approvals/);
  await axe(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await axe(page);
});

// The panel's own widths (docs/side-panel-design.md §10): the same geometry and target-size gates the other tabs get.
for (const width of [320, 360]) {
  test(`at ${width} px the review fits the panel, keeps its values and answers with full-size controls`, async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.addInitScript(([key, value]) => {
      if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
    }, [PREFERENCES, String(width)]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedChat(page, raw, "approval");
    await openReview(page);
    expect(Math.round((await page.locator(".inspector").boundingBox())!.width)).toBe(width);
    const strip = page.getByRole("tablist", { name: "Side panel tabs" });
    const stripBox = (await strip.boundingBox())!;
    const detailsTab = page.getByRole("tab", { name: "Details", exact: true });
    await expect(detailsTab.locator(".sp-badge")).toHaveText(/^\d+%$/);
    const detailsBox = (await detailsTab.boundingBox())!;
    expect(detailsBox.x).toBeGreaterThanOrEqual(stripBox.x - 0.5);
    expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 0.5);
    // The host tabs remain in the strip's keyboard order, even when the selected Approvals tab forces horizontal scrolling.
    for (const title of ["Overview", "Todo", "Files changed", "Commands", "Approvals", "Details"]) {
      const target = page.getByRole("tab", { name: title, exact: true });
      await expect(target).toHaveCount(1);
      await target.focus();
      await expect(target).toBeFocused();
      const box = (await target.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(stripBox.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 0.5);
      if (title !== "Details") {
        const pinned = (await detailsTab.boundingBox())!;
        expect(box.x + box.width, `${title} stays clear of the context badge`).toBeLessThanOrEqual(pinned.x + 0.5);
      }
    }
    const card = reviewOf(page);
    // A long path stays one ellipsised row whose full value is its title.
    const file = card.getByRole("button", { name: /links\.md/ });
    await expect(file).toHaveAttribute("title", /reports[\\/]links\.md$/);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      expect(await panelFaults(page)).toEqual([]);
      await axe(page);
    }
    // The lines the call would write scroll inside their block, and the panel still does not overflow.
    await file.click();
    await expect(card.locator(".diff-view")).toContainText("+++ b/reports/links.md");
    expect(await panelFaults(page)).toEqual([]);
    // Every control keeps the dashboard's 32 px target.
    const small = await panelOf(page).locator("button:visible").evaluateAll((buttons) => buttons
      .map((button) => ({ label: button.getAttribute("aria-label") ?? button.textContent ?? "", box: button.getBoundingClientRect() }))
      .filter((item) => item.box.width < 32 || item.box.height < 32)
      .map((item) => item.label));
    expect(small).toEqual([]);
  });
}
