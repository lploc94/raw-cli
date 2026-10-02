import { AxeBuilder } from "@axe-core/playwright";
import { test, expect, openChat } from "./fixtures.js";

test("keyboard navigation and light/dark narrow layouts keep controls reachable", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page
    .getByRole("button", { name: "Quick navigation", exact: true })
    .focus();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(
    page.getByRole("dialog", { name: "Quick navigation" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Quick navigation", exact: true }),
  ).toBeFocused();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(
      await page
        .getByRole("navigation", { name: "Main" })
        .locator("a")
        .evaluateAll((links) =>
          links.every((link) => {
            const rect = link.getBoundingClientRect();
            return rect.x >= 0 && rect.right <= innerWidth && rect.width >= 32 && rect.height >= 32;
          }),
        ),
    ).toBe(true);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
});

test("the inspector traps focus on narrow screens and both panels resize from the keyboard", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  const separator = page.getByRole("separator", {
    name: "Context panel width",
  });
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "270");
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "260");
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  const inspectorWidth = page.getByRole("separator", {
    name: "Inspector width",
  });
  await inspectorWidth.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(inspectorWidth).toHaveAttribute("aria-valuenow", "330");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Side panel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Copy resume command" }).focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest(".inspector")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Side panel", exact: true }),
  ).toBeFocused();
});

test("comfortable and compact layouts pass contrast checks at desktop and tablet sizes", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page.getByRole("textbox", { name: "Message" }).fill("Show code");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  for (const width of [1440, 800])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        ({ theme, width }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.density =
            width === 1440 ? "comfortable" : "compact";
        },
        { theme, width },
      );
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      const targets = await page
        .locator("button:visible")
        .evaluateAll((buttons) =>
          buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              label: button.getAttribute("aria-label") ?? button.textContent,
              width: rect.width,
              height: rect.height,
            };
          }),
        );
      expect(
        targets.filter((item) => item.width < 32 || item.height < 32),
      ).toEqual([]);
    }
});

test("the agents list and every agent section pass axe in light and dark", async ({ page, raw }) => {
  test.slow();
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  const scan = async () =>
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.getByRole("list", { name: "Agent list" }).waitFor();
    await scan();
  }
  await page.getByRole("navigation", { name: "Agents" }).getByRole("link", { name: "raw", exact: true }).click();
  for (const section of ["Overview", "Capabilities", "Policy", "JSON"]) {
    await page.getByRole("tablist", { name: "Agent sections" }).getByRole("tab", { name: section }).click();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await scan();
    }
  }
  await page.getByRole("tablist", { name: "Agent sections" }).getByRole("tab", { name: "Overview" }).click();
  await page.getByLabel("System prompt", { exact: true }).fill("Unsaved");
  await scan();
});
