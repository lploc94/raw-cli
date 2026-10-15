import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { test, expect, openContext } from "./fixtures.js";
import { openPath, seedLibrary } from "./library-seed.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { QUESTION, REQUEST, chatScenario, installChatWorkspace, seedChat } from "./chat-stress.js";

// The chat area and the frame around it with real-length data (docs/chat-design.md), at the supported widths, in both
// themes. Values come from the approved mockups (kept local).
const THEMES = {
  dark: { backdrop: "rgb(7, 6, 11)", frame: "rgb(33, 27, 45)", canvas: "rgb(15, 12, 22)" },
  light: { backdrop: "rgb(238, 236, 243)", frame: "rgb(228, 225, 234)", canvas: "rgb(255, 255, 255)" },
} as const;
const TRANSPARENT = "rgba(0, 0, 0, 0)";
// Theme switches are measured at once: no colour transitions in between.
test.use({ reducedMotion: "reduce" });

const setTheme = (page: Page, theme: keyof typeof THEMES) => page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
/** Computed styles and box of the first element matching each selector (null when absent or hidden). */
const probe = (page: Page, selectors: string[]) => page.evaluate((list) => Object.fromEntries(list.map((selector) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element || !element.getClientRects().length) return [selector, null];
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return [selector, {
    top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, centre: box.top + box.height / 2,
    background: style.backgroundColor, radius: style.borderTopLeftRadius, borderColor: style.borderTopColor,
    borderTop: style.borderTopWidth, borderRight: style.borderRightWidth, borderBottom: style.borderBottomWidth, borderLeft: style.borderLeftWidth,
    paddingTop: style.paddingTop, paddingLeft: style.paddingLeft,
  }];
})), selectors);
/** A colour token resolved to the rgb() string computed styles report. */
const tokenColour = (page: Page, name: string) => page.evaluate((token) => {
  const sample = document.createElement("i");
  sample.style.color = `var(${token})`;
  document.body.append(sample);
  const colour = getComputedStyle(sample).color;
  sample.remove();
  return colour;
}, name);
const near = (actual: number, expected: number, slack = 1) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(slack);

test.describe("app frame", () => {
  test.use({ scenario: chatScenario });

  test("at 1440 px the rail, sidebar and side panel sit on the backdrop and the chat is the only card", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    // The todo opens the side panel; the header button closes it.
    for (const open of [true, false]) {
      if (!open) await page.getByRole("button", { name: "Side panel", exact: true }).click();
      await expect(page.getByRole("tablist", { name: "Side panel tabs" })).toBeVisible({ visible: open });
      for (const theme of ["dark", "light"] as const) {
        await setTheme(page, theme);
        const colours = THEMES[theme];
        const p = await probe(page, [".app-shell", ".rail", ".rail .brand", ".context-panel", ".workspace-button", ".main-column", ".app-toolbar", ".chat-main", ".inspector", ".sp-tabs", ".sp-tab.active", ".session-row.selected"]);
        const shell = p[".app-shell"]!, card = p[".chat-main"]!, ws = p[".workspace-button"]!, toolbar = p[".app-toolbar"]!;
        expect(shell.background).toBe(colours.backdrop);
        expect(shell.paddingTop).toBe("8px");
        // No full-height rules and no surfaces of their own beside the card.
        for (const side of [".rail", ".context-panel"]) {
          expect(p[side]!.borderRight, side).toBe("0px");
          expect(p[side]!.background, side).toBe(TRANSPARENT);
        }
        expect(p[".main-column"]!.background).toBe(TRANSPARENT);
        expect(card.radius).toBe("14px");
        expect(card.borderColor).toBe(colours.frame);
        expect(card.background).toBe(colours.canvas);
        // The chat header replaces the toolbar: the card starts on the workspace button's line.
        expect(toolbar).toBeNull();
        near(card.top, 8);
        near(card.bottom, 900 - 8);
        // The sidebar content is 16 px from the card; the rail logo and the 52 px workspace button share a centre line.
        near(card.left - ws.right, 16);
        near(ws.top, 9);
        near(ws.height, 52);
        near(p[".rail .brand"]!.centre, ws.centre);
        expect(p[".session-row.selected"]!.background).not.toBe(shell.background);
        if (!open) {
          near(card.right, 1440 - 8);
          expect(p[".inspector"]).toBeNull();
        } else {
          const side = p[".inspector"]!, strip = p[".sp-tabs"]!, active = p[".sp-tab.active"]!;
          expect(side.borderLeft).toBe("0px");
          expect(side.background).toBe(colours.backdrop);
          near(strip.left - card.right, 16);
          near(side.right, 1440 - 8);
          // The tab strip is a segmented control: no rule under it, the selected tab raised on its own surface.
          expect(strip.borderBottom).toBe("0px");
          expect(strip.radius).toBe("10px");
          expect(active.borderBottom).toBe("0px");
          expect(active.background).not.toBe(strip.background);
          expect(active.background).not.toBe(TRANSPARENT);
        }
        await axe(page);
      }
    }
  });

  test("other pages keep their toolbar inside the card, which starts on the workspace button's line", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    for (const route of ["Agents", "Library"]) {
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: route, exact: true }).click();
      await expect(page.locator(".app-toolbar")).toBeVisible();
      for (const theme of ["dark", "light"] as const) {
        await setTheme(page, theme);
        const p = await probe(page, [".app-shell", ".main-column", ".app-toolbar", ".context-panel"]);
        const card = p[".main-column"]!, toolbar = p[".app-toolbar"]!;
        expect(card.radius, route).toBe("14px");
        expect(card.borderColor).toBe(THEMES[theme].frame);
        expect(card.background).toBe(THEMES[theme].canvas);
        near(card.top, 8);
        expect(p[".context-panel"]!.background).toBe(TRANSPARENT);
        // The toolbar is inside the card and draws no full-width rule.
        expect(toolbar.top).toBeGreaterThanOrEqual(card.top);
        expect(toolbar.borderBottom).toBe("0px");
        await axe(page);
      }
    }
  });

  test("at 800 px the drawer opens from the toolbar and the card keeps its frame", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 800, height: 900 });
    await seedChat(page, raw);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const p = await probe(page, [".app-shell", ".rail", ".chat-main", ".context-panel"]);
      expect(p[".context-panel"]).toBeNull();
      expect(p[".rail"]!.borderRight).toBe("0px");
      expect(p[".chat-main"]!.radius).toBe("14px");
      near(p[".chat-main"]!.left, p[".rail"]!.right, 1);
      expect(await page.locator(".chat-header .agent-chip").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await axe(page);
    }
    await page.getByRole("button", { name: "Workspace menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(THEMES.light.backdrop);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("at 390 px the frame is full-bleed and the horizontal rail has no rule", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const p = await probe(page, [".app-shell", ".rail", ".chat-main"]);
      const card = p[".chat-main"]!, rail = p[".rail"]!;
      expect(p[".app-shell"]!.paddingTop).toBe("0px");
      expect(card.radius).toBe("0px");
      expect(card.borderTop).toBe("0px");
      near(card.left, 0);
      near(card.right, 390);
      expect(rail.borderBottom).toBe("0px");
      expect(rail.background).toBe(THEMES[theme].backdrop);
      expect(rail.background).not.toBe(card.background);
      await axe(page);
    }
  });

  test("the sidebar and side panel still resize from the gaps beside the card", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const sidebar = page.getByRole("separator", { name: "Context panel width" });
    const before = (await page.locator(".context-panel").boundingBox())!.width;
    await sidebar.focus();
    await page.keyboard.press("ArrowRight");
    await expect(sidebar).toHaveAttribute("aria-valuenow", String(before + 10));
    near((await page.locator(".context-panel").boundingBox())!.width, before + 10);
    // A small drag moves the edge by as much as the pointer, in the drag's direction, from wherever the handle is grabbed.
    const drag = async (name: string, panel: string, dx: number) => {
      await expect(page.getByRole("separator", { name })).toBeVisible();
      const handle = (await page.getByRole("separator", { name }).boundingBox())!;
      const start = (await page.locator(panel).boundingBox())!.width;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + dx, handle.y + handle.height / 2, { steps: 2 });
      await page.mouse.up();
      return (await page.locator(panel).boundingBox())!.width - start;
    };
    near(await drag("Context panel width", ".context-panel", 6), 6);
    near(await drag("Context panel width", ".context-panel", -6), -6);
    near(await drag("Inspector width", ".inspector", -6), 6);
    near(await drag("Inspector width", ".inspector", 6), -6);
    const side = page.getByRole("separator", { name: "Inspector width" });
    const width = (await page.locator(".inspector").boundingBox())!.width;
    await side.focus();
    await page.keyboard.press("ArrowRight");
    await expect(side).not.toHaveAttribute("aria-valuenow", String(width));
    expect((await page.locator(".inspector").boundingBox())!.width).not.toBe(width);
    // The handle lies in the gap: it does not cover the card.
    const handle = (await side.boundingBox())!;
    const card = (await page.locator(".chat-main").boundingBox())!;
    expect(handle.x).toBeGreaterThanOrEqual(card.x + card.width - 1);
    // When the window clips the preferred width, the drag starts from the width on screen.
    for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowLeft");
    await expect(side).toHaveAttribute("aria-valuenow", "360");
    await page.setViewportSize({ width: 340, height: 900 });
    // Crossing the breakpoint remounts the panel as an overlay: wait until it is on screen, clipped.
    await expect.poll(async () => (await page.locator(".inspector").boundingBox())?.width ?? 999).toBeLessThan(360);
    await expect(page.getByRole("dialog").locator(".inspector-resize")).toBeVisible();
    near(await drag("Inspector width", ".inspector", 6), -6);
  });
});

test.describe("chat header", () => {
  // The workspace lives in the temporary directory: as HOME, its path shows as ~/….
  test.use({ scenario: { ...chatScenario, env: { HOME: realpathSync(tmpdir()) } } });
  const header = ".chat-main > .page-header";

  test("at 1440 px one 52 px row on the frame's centre line replaces the toolbar", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const bar = page.locator(header);
    const title = bar.getByRole("heading", { level: 1 });
    const path = bar.locator(".workspace-path");
    const sidePanel = bar.getByRole("button", { name: "Side panel", exact: true });
    const cwd = realpathSync(raw.root);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await expect(page.locator(".app-toolbar")).toHaveCount(0);
      const p = await probe(page, [header, ".chat-main", ".workspace-button", ".rail .brand", ".side-panel-title"]);
      const row = p[header]!;
      near(p[".chat-main"]!.top, 8);
      near(row.height, 52);
      expect(row.borderBottom).toBe("0px");
      expect(row.paddingLeft).toBe("18px");
      for (const other of [".workspace-button", ".rail .brand", ".side-panel-title"]) near(p[other]!.centre, row.centre);
      // One line: a 15 px title that ends in an ellipsis, then the agent and the shortened path.
      // The session title is the request, cut by the server; the whole title is in the tooltip.
      const text = (await title.textContent())!;
      expect(text.length).toBeGreaterThan(40);
      expect(REQUEST.startsWith(text)).toBe(true);
      await expect(title).toHaveAttribute("title", text);
      await expect(title).toHaveCSS("font-size", "15px");
      await expect(title).toHaveCSS("font-weight", "600");
      await expect(title).toHaveCSS("text-overflow", "ellipsis");
      await expect(title).toHaveCSS("white-space", "nowrap");
      await expect(bar.locator(".agent-chip")).toHaveText("raw");
      // A short name is never clipped; only the path gives way.
      expect(await bar.locator(".agent-chip").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(path).toHaveAttribute("title", cwd);
      const tops = await bar.locator("h1, .agent-chip, .workspace-path, button:visible").evaluateAll((list) => list.map((element) => {
        const box = element.getBoundingClientRect();
        return box.top + box.height / 2;
      }));
      for (const centre of tops) near(centre, row.centre, 1.5);
      // The toolbar's controls, as icon buttons at the 32 px minimum target; the drawer trigger only below 900 px.
      await expect(bar.getByRole("button", { name: "Workspace menu" })).toBeHidden();
      for (const name of ["Quick navigation", "Activity", "Side panel", "More actions"]) {
        const button = bar.getByRole("button", { name, exact: name !== "Activity" });
        await expect(button).toBeVisible();
        await expect(button).toHaveCSS("width", "32px");
        await expect(button).toHaveCSS("border-top-left-radius", "8px");
      }
      // The side panel is open: the button says so and is tinted.
      await expect(sidePanel).toHaveAttribute("aria-expanded", "true");
      await expect(sidePanel).toHaveCSS("background-color", await tokenColour(page, "--accent-soft"));
      await axe(page);
    }
    await sidePanel.click();
    await expect(sidePanel).toHaveAttribute("aria-expanded", "false");
    await expect(sidePanel).toHaveCSS("background-color", TRANSPARENT);
    // Search and Activity open the shell's one palette and one activity dialog.
    await bar.getByRole("button", { name: "Quick navigation" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: "Activity" }).click();
    await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Other pages keep their toolbar and breadcrumb.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page.locator(".app-toolbar .breadcrumb")).toContainText("Agents");
  });

  test("at 390 px the header keeps the title, the drawer trigger and the actions", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw);
    const bar = page.locator(header);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await expect(page.locator(".app-toolbar")).toHaveCount(0);
      const row = (await probe(page, [header]))[header]!;
      near(row.height, 52);
      expect(row.borderBottom).toBe("0px");
      // The mockup's spacing holds at 390 px: 18 px and 14 px at the ends, 10 px between the parts, 8 px between buttons.
      expect(await bar.evaluate((element) => [getComputedStyle(element).paddingLeft, getComputedStyle(element).paddingRight, getComputedStyle(element).columnGap]))
        .toEqual(["18px", "14px", "10px"]);
      await expect(bar.locator(".actions")).toHaveCSS("column-gap", "8px");
      await expect(bar.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(bar.locator(".agent-chip")).toBeHidden();
      await expect(bar.locator(".workspace-path")).toBeHidden();
      await expect(bar.getByRole("button", { name: "Quick navigation" })).toBeHidden();
      await expect(bar.getByRole("button", { name: "Activity" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await axe(page);
    }
    await bar.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Copy workspace path" })).toBeVisible();
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: "Workspace menu" }).click();
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
  });
});

test.describe("chat header with a long agent name", () => {
  const name = "documentation-link-checker-with-a-very-long-agent-name-that-never-breaks";
  test.use({ scenario: { ...chatScenario, extraAgents: { [name]: { model: "fixture", system_prompt: "Check links", tools: { use: [] } } } } });
  test("the agent chip ends in an ellipsis and stays inside the header at every width", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "New chat agent" }).click();
    await page.getByRole("menuitemradio", { name }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    // The long request becomes the title, so the title, the chip and the path all compete for the row.
    await page.getByRole("textbox", { name: "Message" }).fill(REQUEST);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const bar = page.locator(".chat-main > .page-header");
    await expect(bar.getByRole("heading", { level: 1 })).toHaveText(/^Rà soát/);
    const chip = bar.locator(".agent-chip");
    await expect(chip).toHaveText(name);
    await expect(chip).toHaveAttribute("title", name);
    await expect(bar.locator(".workspace-path")).toHaveAttribute("title", /.+/);
    for (const width of [1440, 1000, 800, 600]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await bar.evaluate((element) => {
        const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
        const chip = element.querySelector<HTMLElement>(".agent-chip")!;
        return { bar: element.getBoundingClientRect(), metadata: box(".metadata"), chip: box(".agent-chip"), path: box(".workspace-path"), actions: box(".actions"), clipped: chip.scrollWidth > chip.clientWidth };
      });
      expect(boxes.clipped, `${width}`).toBe(true);
      near(boxes.bar.height, 52);
      expect(boxes.chip.right, `${width}`).toBeLessThanOrEqual(boxes.metadata.right + 0.5);
      expect(boxes.chip.right, `${width}`).toBeLessThanOrEqual(boxes.path.left + 0.5);
      expect(boxes.metadata.right, `${width}`).toBeLessThanOrEqual(boxes.actions.left);
    }
  });
});

test.describe("chat header outside HOME", () => {
  test.use({ scenario: { ...chatScenario, env: { HOME: "/raw-test-home-elsewhere" } } });
  test("a workspace outside HOME shows its full path", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const path = page.locator(".chat-main > .page-header .workspace-path");
    await expect(path).toHaveText(realpathSync(raw.root));
    await expect(path).toHaveAttribute("title", realpathSync(raw.root));
  });
});

test.describe("messages", () => {
  test.use({ scenario: chatScenario });
  const BUBBLE = { dark: "rgb(30, 25, 48)", light: "rgb(241, 239, 246)" } as const;
  /** The conversation column's content box. */
  const column = (page: Page) => page.locator(".conversation").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) };
  });

  test("a right-aligned user bubble, then the assistant's prose, table and code block", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const user = page.getByTestId("user-message").first();
    const bubble = user.locator(".bubble");
    const answer = page.getByTestId("assistant-message").first();
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      // No "You" label: the bubble is the user's, flush with the column's right edge.
      await expect(user.getByText("You", { exact: true })).toHaveCount(0);
      const col = await column(page);
      const box = (await bubble.boundingBox())!;
      near(box.x + box.width, col.right);
      expect(box.x).toBeGreaterThan(col.left + 40);
      await expect(bubble).toHaveCSS("border-top-left-radius", "18px");
      await expect(bubble).toHaveCSS("background-color", BUBBLE[theme]);
      await expect(bubble).toHaveCSS("font-size", "15px");
      // The time and Copy message sit under the bubble and appear on hover.
      const meta = user.locator(".message-meta");
      await page.mouse.move(0, 0);
      await expect(meta).toHaveCSS("opacity", "0");
      await bubble.hover();
      await expect(meta).toHaveCSS("opacity", "1");
      await expect(meta.locator("time")).toHaveAttribute("datetime", /T/);
      await expect(meta.getByRole("button", { name: "Copy message" })).toBeVisible();
      // The assistant: the r mark, Raw and the time; 15 px prose; a 17 px heading.
      await expect(answer.locator(".message-label .avatar")).toHaveText("r");
      await expect(answer.locator(".message-label strong")).toHaveText("Raw");
      await expect(answer.locator(".markdown p").first()).toHaveCSS("font-size", "15px");
      await expect(answer.locator(".markdown h2")).toHaveCSS("font-size", "17px");
      await expect(answer.locator(".markdown h2")).toHaveCSS("font-weight", "650");
      // The answer opens with its heading 2 px under the name row.
      await expect(answer.locator(".markdown h2")).toHaveCSS("margin-top", "2px");
      await expect(answer.locator(":not(pre) > code").first()).toHaveCSS("font-size", "13px");
      await expect(answer.locator(":not(pre) > code").first()).toHaveCSS("border-top-left-radius", "5px");
      // The table is one bordered box with rules between rows only.
      const table = answer.locator(".table-scroll");
      await expect(table).toHaveCSS("border-top-left-radius", "10px");
      await expect(table).toHaveCSS("border-top-width", "1px");
      await expect(answer.locator("th").first()).toHaveCSS("border-left-width", "0px");
      await expect(answer.locator("th").first()).toHaveCSS("font-size", "12px");
      await expect(answer.locator("td").first()).toHaveCSS("font-size", "13.5px");
      await expect(answer.locator("tbody tr").last().locator("td").first()).toHaveCSS("border-bottom-width", "0px");
      // The code block: a header with the language and Copy, code without ligatures.
      const code = answer.locator(".code-block");
      await expect(code).toHaveCSS("border-top-left-radius", "10px");
      await expect(code.locator(".code-label")).toContainText("js");
      await expect(code.getByRole("button", { name: "Copy code" })).toContainText("Copy");
      await expect(code.locator(".code-label")).toHaveCSS("font-size", "11.5px");
      await expect(code.locator("pre code")).toHaveCSS("font-variant-ligatures", "none");
      await expect(code.locator("pre code")).toHaveCSS("font-size", "13px");
      await expect(answer.locator(".message-actions").getByRole("button", { name: "Copy message" })).toBeVisible();
      await axe(page);
    }
  });

  test("at 390 px long text and an unbroken token wrap inside the column", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill(`Kiểm tra giúp tôi đoạn này: ${"a1b2c3d4e5".repeat(30)} rồi báo lại kết quả chi tiết cho từng trang tài liệu`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("user-message")).toHaveCount(2);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const overflow = await page.locator(".conversation-scroll").evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const col = await column(page);
      for (const bubble of await page.locator(".message.user .bubble").all()) {
        const box = (await bubble.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(col.left - 1);
        near(box.x + box.width, col.right);
      }
      await axe(page);
    }
  });
});

test.describe("work", () => {
  test.use({ scenario: chatScenario });
  /** The side panel's diff colours, read from a probe inside an `.inspector`. */
  const panelDiff = (page: Page) => page.evaluate(() => {
    const host = document.createElement("div");
    host.className = "inspector";
    host.innerHTML = `<div class="panel-file-diff"><span class="diff-line diff-add">+a</span><span class="diff-line diff-remove">-r</span></div>`;
    document.body.append(host);
    const read = (selector: string) => { const style = getComputedStyle(host.querySelector(selector)!); return [style.backgroundColor, style.color]; };
    const colours = { add: read(".diff-add"), remove: read(".diff-remove") };
    host.remove();
    return colours;
  });
  const lineOf = async (row: Locator) => {
    const line = (await row.locator(".tool-line").boundingBox())!;
    const glyph = (await row.locator(".tool-glyph").boundingBox())!;
    return { line, glyph };
  };

  test("a collapsed summary line with chips and pills, then rows and cards", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw);
    const group = page.locator(".work-group").first();
    const toggle = group.locator(".work-toggle");
    // Done and failed, yet collapsed: the header carries those states.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator(".work-content")).toBeHidden();
    await expect(group.locator(".work-time")).toHaveText(/^Worked \d+\.\ds$/);
    await expect(group.locator(".work-count")).toHaveText("· 4 tools");
    await expect(group.locator(".work-head .sp-chip")).toHaveText(["1 failed"]);
    await expect(group.locator(".work-pill")).toHaveText(["Todo 1/3", "+4 −1"]);
    await expect(group.locator(".work-head")).toHaveCSS("font-size", "13px");
    expect((await group.locator(".work-head").boundingBox())!.height).toBeLessThanOrEqual(32);
    // Receipts are pills now, never rows of their own inside a group.
    await expect(group.locator(".panel-receipt")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const rows = group.locator(".tool-row");
    await expect(rows).toHaveCount(4);
    await expect(group.locator(".reasoning")).toHaveCount(1);
    await expect(group.locator(".reasoning-toggle i")).toHaveCSS("font-style", "italic");
    await expect(group.locator(".reasoning-toggle i")).toHaveCSS("text-overflow", "ellipsis");
    const todo = rows.filter({ has: page.locator(".tool-title", { hasText: /^Todo$/ }) });
    const check = rows.filter({ has: page.locator(".tool-summary", { hasText: "$ node scripts/check-links.mjs --all --verbose" }) });
    const edit = rows.filter({ has: page.locator(".tool-summary", { hasText: /^scripts\/check-links\.mjs$/ }) });
    const lint = rows.filter({ has: page.locator(".tool-summary", { hasText: "$ npm run lint" }) });
    await expect(todo.locator(".receipt-pill")).toHaveText("1 of 3 done");
    await expect(edit.locator(".tool-diffstat")).toHaveText("+4 −1");
    // OK rows: no visible chip, the state as accessible text; the failed row: its chip, open, red border.
    for (const ok of [todo, check, edit]) {
      await expect(ok).toHaveAttribute("data-status", "ok");
      await expect(ok.locator(".tool-status")).toHaveCount(0);
      await expect(ok.locator(".tool-toggle")).toHaveAccessibleName(/^OK\b/);
      await expect(ok.locator(".tool-toggle")).toHaveAttribute("aria-expanded", "false");
    }
    await expect(lint.locator(".tool-status")).toHaveText("Exit 1");
    await expect(lint.locator(".tool-toggle")).toHaveAttribute("aria-expanded", "true");
    const card = lint.locator(".tool-card");
    await expect(card).toHaveClass(/failed/);
    await expect(card.locator(".term-line[data-channel=stderr]")).toHaveText(["scripts/check-links.mjs:3:5  error  Missing semicolon"]);
    await expect(card).not.toContainText("[stderr]");
    await expect(card).not.toContainText("[exit");
    await expect(card.locator(".tool-foot-meta")).toHaveText(/^stderr · exit 1 · \d+\.\d s$/);
    await expect(card.getByRole("button", { name: "Copy output" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Arguments" })).toHaveAttribute("aria-expanded", "false");
    await edit.locator(".tool-toggle").click();
    await expect(edit.locator(".diff-view .diff-add")).toHaveCount(4);
    await expect(edit.locator(".tool-foot-meta")).toHaveText("scripts/check-links.mjs");
    await expect(edit.getByRole("button", { name: "Copy diff" })).toBeVisible();
    // One file: the footer names it and the diff's file headers are hidden.
    await expect(edit.locator(".diff-file")).toHaveCount(2);
    for (const header of await edit.locator(".diff-file").all()) await expect(header).toBeHidden();
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      // Rows are one line with the glyph on it.
      for (const row of await rows.all()) {
        const { line, glyph } = await lineOf(row);
        expect(line.height).toBeLessThanOrEqual(34);
        expect(glyph.y).toBeGreaterThanOrEqual(line.y);
        expect(glyph.y + glyph.height).toBeLessThanOrEqual(line.y + line.height);
      }
      await expect(lint.locator(".tool-line")).toHaveCSS("border-top-left-radius", "8px");
      await expect(card).toHaveCSS("border-top-left-radius", "10px");
      await expect(card).toHaveCSS("border-top-color", await tokenColour(page, "--danger-border"));
      await expect(card.locator(".term-line[data-channel=stderr]")).toHaveCSS("color", await tokenColour(page, "--error"));
      await expect(card.locator(".tool-terminal")).toHaveCSS("font-size", "12px");
      const colours = await panelDiff(page);
      await expect(edit.locator(".diff-add").first()).toHaveCSS("background-color", colours.add[0]!);
      await expect(edit.locator(".diff-add").first()).toHaveCSS("color", colours.add[1]!);
      await expect(edit.locator(".diff-remove").first()).toHaveCSS("background-color", colours.remove[0]!);
      await axe(page);
    }
    // Each header pill opens its panel in the side panel.
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await expect(page.locator(".inspector")).toHaveCount(0);
    await group.locator(".work-pill", { hasText: "Todo 1/3" }).click();
    await expect(page.getByRole("tab", { name: /^Todo/ })).toHaveAttribute("aria-selected", "true");
    await group.locator(".work-pill", { hasText: "+4 −1" }).click();
    await expect(page.getByRole("tab", { name: /^Files changed/ })).toHaveAttribute("aria-selected", "true");
  });

  test("at 390 px the header and rows stay single lines inside the column", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw);
    const group = page.locator(".work-group").first();
    await group.locator(".work-toggle").click();
    const conversation = (await page.locator(".conversation").boundingBox())!;
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      expect((await group.locator(".work-head").boundingBox())!.height).toBeLessThanOrEqual(32);
      for (const row of await group.locator(".tool-row").all()) {
        const { line, glyph } = await lineOf(row);
        expect(line.height).toBeLessThanOrEqual(34);
        expect(glyph.y + glyph.height).toBeLessThanOrEqual(line.y + line.height);
        expect(line.x + line.width).toBeLessThanOrEqual(conversation.x + conversation.width + 0.5);
      }
      const overflow = await page.locator(".conversation-scroll").evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await axe(page);
    }
  });

  test("two groups that edit files show their own totals, and a pending approval is a chip", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw, "approval");
    const second = page.locator(".work-group").nth(1);
    await expect(second.locator(".work-head .sp-chip")).toHaveText(["Needs approval"]);
    await expect(second.locator(".work-time")).toHaveText("Working");
    await expect(second.locator(".work-spinner")).toBeVisible();
    await expect(second.locator(".tool-row")).toHaveAttribute("data-status", "approval");
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(second.locator(".work-time")).toHaveText(/^Worked /);
    await expect(second.locator(".work-pill")).toHaveText(["+3 −0"]);
    await expect(page.locator(".work-group").first().locator(".work-pill")).toHaveText(["Todo 1/3", "+4 −1"]);
  });
});

test.describe("work states", () => {
  // A reasoning-only reply, then one turn with a command that times out, a denied write and a tool whose second
  // panel update is rejected.
  test.use({ scenario: {
    agent: { tools: { use: ["builtin/bash", "builtin/write_file", "local/report", "local/probe"], rules: [
      { match: "builtin/bash", effect: "allow" }, { match: "builtin/write_file", effect: "deny" }, { match: "local/report", effect: "allow" },
      { match: "local/probe", effect: "allow" }] } },
    responses: [
      { frames: [openAiFrame({ reasoning: "Chỉ cần chào lại người dùng." }), openAiFrame({ content: "Xin chào" }, "stop"), openAiDone] },
      { frames: [openAiFrame({ tool_calls: [
        { index: 0, id: "slow", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30", timeout: 2500, description: "Chờ dịch vụ khởi động" }) } },
        { index: 1, id: "deny", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "notes.md", content: "x" }) } },
        { index: 2, id: "rep", type: "function", function: { name: "report", arguments: "{}" } },
        { index: 3, id: "probe", type: "function", function: { name: "probe", arguments: "{}" } },
      ] }, "tool_calls"), openAiDone] },
      { frames: [openAiFrame({ content: "Xong" }, "stop"), openAiDone] },
    ],
  } });

  test("reasoning only, running, timed out, denied, a rejected update and tool details", async ({ page, raw }) => {
    // The longest title and summary a panel document may have.
    const TITLE = "Báo cáo kiểm tra liên kết của toàn bộ tài liệu hướng dẫn và trang tham chiếu API";
    const SUMMARY = "Đã ghi kết quả của 44 liên kết trong 12 trang, trong đó 3 liên kết hỏng vì trang đích đã đổi tên hoặc bị xoá khỏi trang";
    expect([...TITLE].length).toBeLessThanOrEqual(80);
    expect([...SUMMARY].length).toBeLessThanOrEqual(120);
    const probe = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "probe");
    mkdirSync(probe, { recursive: true });
    writeFileSync(join(probe, "tool.json"), JSON.stringify({ api_version: 2, id: "probe", version: "1.0.0", name: "probe", description: "Probe",
      display: { title: "Probe", kind: "execute", result: "terminal" },
      input_schema: { type: "object", properties: {}, additionalProperties: false }, entry: "./index.mjs" }));
    writeFileSync(join(probe, "index.mjs"), `export async function handler() {
      return { content: [{ type: "text", text: "probe line" }, { type: "json", value: { record: 7 } }] };
    }`);
    const folder = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "report");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "report", version: "1.0.0", name: "report", description: "Report",
      input_schema: { type: "object", properties: {}, additionalProperties: false }, entry: "./index.mjs",
      panels: [{ id: "report", title: "Report", placement: "sidebar" }] }));
    writeFileSync(join(folder, "index.mjs"), `export async function handler() {
      return { content: [{ type: "text", text: "Published" },
        { type: "panel", panel: "report", op: "replace", document: { title: "${TITLE}", summary: "${SUMMARY}", blocks: [{ id: "b", kind: "markdown", text: "Đã ghi" }] } },
        { type: "panel", panel: "ghost", op: "replace", document: { blocks: [] } }] };
    }`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const box = page.getByRole("textbox", { name: "Message" });
    const send = async (text: string) => { await box.fill(text); await page.getByRole("button", { name: "Send", exact: true }).click(); };
    await send("Chào");
    await expect(page.getByTestId("assistant-message")).toContainText("Xin chào");
    const first = page.locator(".work-group").first();
    await expect(first.locator(".work-count")).toHaveText("· Reasoning");
    await expect(first.locator(".work-head .sp-chip")).toHaveCount(0);
    await expect(first.locator(".work-pill")).toHaveCount(0);
    await first.locator(".work-toggle").click();
    await expect(first.locator(".tool-row")).toHaveCount(0);
    const reasoning = first.locator(".reasoning-toggle");
    await expect(reasoning).toHaveAttribute("aria-expanded", "false");
    await reasoning.click();
    await expect(first.locator(".reasoning .markdown")).toHaveText("Chỉ cần chào lại người dùng.");

    await send("Chạy thử");
    const second = page.locator(".work-group").nth(1);
    // While the command runs: Working with a spinner, no time, the row's spinner and no chip.
    await expect(second.locator(".work-time")).toHaveText("Working");
    await expect(second.locator(".work-spinner")).toBeVisible();
    await expect(second.locator(".work-toggle")).toHaveAttribute("aria-expanded", "false");
    // The running group says Working; the status line does not repeat it, the live region does.
    await expect(page.locator(".working-status")).toHaveCount(0);
    await expect(page.locator("[role=status][aria-live=polite]").filter({ hasText: "Working" })).toHaveCount(1);
    await second.locator(".work-toggle").click();
    const slow = second.locator(".tool-row").filter({ hasText: "Chờ dịch vụ khởi động" });
    await expect(slow).toHaveAttribute("data-status", "running");
    await expect(slow.locator(".tool-status")).toHaveCount(0);
    await slow.locator(".tool-toggle").click();
    await expect(slow.locator(".tool-card")).toContainText("Live output is in Commands");
    await expect(page.getByTestId("assistant-message").nth(1)).toContainText("Xong", { timeout: 30000 });
    await expect(second.locator(".work-time")).toHaveText(/^Worked /);
    await expect(second.locator(".work-spinner")).toHaveCount(0);
    await expect(second.locator(".work-head .sp-chip")).toHaveText(["2 failed"]);
    await expect(slow).toHaveAttribute("data-status", "timeout");
    await expect(slow.locator(".tool-status")).toHaveText("Timed out");
    await expect(slow.locator(".tool-glyph")).toHaveAttribute("data-glyph", "clock");
    const denied = second.locator(".tool-row").filter({ hasText: "notes.md" });
    await expect(denied.locator(".tool-status")).toHaveText("Denied");
    await expect(denied.locator(".tool-glyph")).toHaveAttribute("data-glyph", "ban");
    await expect(denied.locator(".tool-toggle")).toHaveAttribute("aria-expanded", "true");
    // The report's panels: its pill, and the rejected update as an error pill.
    await expect(second.locator(".work-pill")).toHaveText([TITLE, "ghost"]);
    await expect(second.locator(".work-pill.tone-error")).toHaveText("ghost");
    const report = second.locator(".tool-row").filter({ has: page.locator(".tool-title", { hasText: /^report$/i }) });
    await expect(report.locator(".receipt-pill")).toHaveText([SUMMARY, "Update rejected"]);
    await expect(page.locator(".panel-receipt")).toHaveCount(0);
    // A terminal result with structured content keeps its JSON tree under the output, and every body has a footer Copy.
    const probed = second.locator(".tool-row").filter({ has: page.locator(".tool-title", { hasText: /^Probe$/ }) });
    await probed.locator(".tool-toggle").click();
    await expect(probed.locator(".tool-terminal")).toHaveText("probe line\n");
    await expect(probed.getByRole("list", { name: "JSON result" })).toContainText("record");
    await expect(probed.getByRole("button", { name: "Copy output" })).toBeVisible();
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await axe(page);
    }
    // At 390 px long panel titles and summaries end in an ellipsis inside the column.
    await page.setViewportSize({ width: 390, height: 844 });
    const conversation = (await page.locator(".conversation").boundingBox())!;
    for (const pill of await page.locator(".work-pill, .receipt-pill").all()) {
      const box = (await pill.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(conversation.x + conversation.width + 0.5);
    }
    await expect(second.locator(".work-pill").first()).toHaveAccessibleName(TITLE);
    expect((await second.locator(".work-head").boundingBox())!.height).toBeLessThanOrEqual(32);
    for (const row of await second.locator(".tool-line").all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(34);
    expect(await page.locator(".conversation-scroll").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Tool details: every group and row starts open.
    await page.evaluate(() => {
      const key = "raw.dashboard.preferences.v1";
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), version: 1, toolDetails: true }));
    });
    await page.reload();
    for (const group of await page.locator(".work-group").all())
      await expect(group.locator(".work-toggle")).toHaveAttribute("aria-expanded", "true");
    for (const row of await page.locator(".tool-row").all())
      await expect(row.locator(".tool-toggle")).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("approval", () => {
  test.use({ scenario: chatScenario });
  const WARNING_BORDER = { dark: "rgb(74, 58, 20)", light: "rgb(236, 217, 168)" } as const;

  test("a pending approval is one card after its group, and the row and header say so", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw, "approval");
    const card = page.locator("section.approval");
    await expect(card).toHaveCount(1);
    await expect(page.locator(".work-group section.approval")).toHaveCount(0);
    // Right after the group that holds the call.
    expect(await card.evaluate((element) => element.previousElementSibling?.classList.contains("work-group"))).toBe(true);
    const group = page.locator(".work-group").nth(1);
    await expect(group.locator(".work-head .sp-chip")).toHaveText(["Needs approval"]);
    await expect(group.locator(".work-toggle")).toHaveAttribute("aria-expanded", "false");
    await group.locator(".work-toggle").click();
    const row = group.locator(".tool-row");
    await expect(row).toHaveAttribute("data-status", "approval");
    await expect(row.locator(".tool-glyph")).toHaveAttribute("data-glyph", "shield");
    await expect(row.locator(".tool-status")).toHaveText("Needs approval");
    await expect(group.getByRole("button", { name: "Allow once" })).toHaveCount(0);
    // Row 1: the chip, the tool and when it expires; row 2: the headline and the lines it adds; the preview; the actions.
    await expect(card.locator(".approval-top .sp-chip")).toHaveText("Needs approval");
    await expect(card.locator(".approval-meta")).toHaveText(/^write_file · expires \d{1,2}:\d{2}/);
    await expect(card.locator(".approval-meta")).toHaveAttribute("title", /\d/);
    await expect(card.locator(".approval-title")).toHaveText("Write");
    await expect(card.locator(".approval-summary")).toHaveText("reports/links.md");
    await expect(card.locator(".approval-lines")).toHaveText("+3");
    await expect(card.locator(".approval-preview")).toHaveText("# Link report\n\n41 ok, 3 broken");
    await expect(card.locator(".approval-actions button")).toHaveText(["Arguments", "Deny", "Allow once"]);
    const allow = card.getByRole("button", { name: "Allow once", exact: true });
    await expect(allow).toHaveClass(/primary/);
    await expect(allow).toHaveAttribute("title", "Allow this call once? This does not change your rules.");
    await expect(card).not.toContainText("Permission needed");
    // The card does not take the focus.
    expect(await card.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    // Neither the visible status line nor a waiting body repeats it; the live region still announces it.
    await expect(page.locator(".working-status")).toHaveCount(0);
    await expect(page.locator("[role=status][aria-live=polite]").filter({ hasText: "Waiting for approval" })).toHaveCount(1);
    const args = card.getByRole("button", { name: "Arguments", exact: true });
    await expect(args).toHaveAttribute("aria-expanded", "false");
    await args.click();
    await expect(args).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".approval-arguments")).toContainText('"path": "reports/links.md"');
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await expect(card).toHaveCSS("border-top-color", WARNING_BORDER[theme]);
      await expect(card).toHaveCSS("border-top-left-radius", "12px");
      await expect(card).toHaveCSS("padding-top", "12px");
      await expect(card).toHaveCSS("padding-left", "14px");
      await expect(card.locator(".approval-title")).toHaveCSS("font-size", "14px");
      await expect(card.locator(".approval-preview")).toHaveCSS("font-size", "12px");
      await axe(page);
    }
    // After a reload the card is still one card after its group.
    await page.reload();
    await expect(page.locator("section.approval")).toHaveCount(1);
    expect(await page.locator("section.approval").evaluate((element) => element.previousElementSibling?.classList.contains("work-group"))).toBe(true);
    // Deny: the card goes and the row says Denied.
    await page.locator("section.approval").getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.locator("section.approval")).toHaveCount(0);
    const denied = page.locator(".work-group").nth(1);
    if ((await denied.locator(".work-toggle").getAttribute("aria-expanded")) === "false") await denied.locator(".work-toggle").click();
    await expect(denied.locator(".tool-row .tool-status")).toHaveText("Denied");
    await expect(denied.locator(".tool-row .tool-glyph")).toHaveAttribute("data-glyph", "ban");
  });

  test("at 390 px the card keeps its rows inside the column", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw, "approval");
    const card = page.locator("section.approval");
    const conversation = (await page.locator(".conversation").boundingBox())!;
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      const box = (await card.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(conversation.x + conversation.width + 0.5);
      for (const part of [".approval-top", ".approval-headline", ".approval-actions"])
        expect((await card.locator(part).boundingBox())!.height, part).toBeLessThanOrEqual(34);
      expect(await page.locator(".conversation-scroll").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
      await axe(page);
    }
  });
});

test.describe("approval without a preview", () => {
  // A command has no multi-line argument: no preview block, and no line count.
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"], rules: [{ match: "builtin/bash", effect: "ask" }] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "b", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "npm test", description: "Chạy bộ kiểm thử" }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "Đã chạy" }, "stop"), openAiDone] },
  ] } });
  test("a command shows its headline only, and Allow once runs it", async ({ page, raw }) => {
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await page.getByRole("textbox", { name: "Message" }).fill("chạy test");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.locator("section.approval");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".approval-title")).toHaveText("Chạy bộ kiểm thử");
    await expect(card.locator(".approval-summary")).toHaveText("$ npm test");
    await expect(card.locator(".approval-preview")).toHaveCount(0);
    await expect(card.locator(".approval-lines")).toHaveCount(0);
    await card.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Đã chạy", { timeout: 30000 });
    await expect(card).toHaveCount(0);
  });
});

test.describe("approval line counts and long previews", () => {
  // The count is the lines the call adds, not the preview's: an edit adds its new text, a write its content.
  const tool = (id: string, name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
  const LONG = Array.from({ length: 8 }, (_, index) => `dòng ${index + 1}`).join("\n") + "\n";
  test.use({ scenario: { agent: { tools: { use: ["builtin/edit_file", "builtin/write_file"], rules: [
    { match: "builtin/edit_file", effect: "ask" }, { match: "builtin/write_file", effect: "ask" }] } }, responses: [
    tool("e", "edit_file", { path: "notes.txt", old_string: "một\nhai\nba\nbốn", new_string: "năm\nsáu" }),
    tool("w", "write_file", { path: "long.txt", content: LONG }),
    tool("o", "write_file", { path: "one.txt", content: "một dòng" }),
    { frames: [openAiFrame({ content: "Xong" }, "stop"), openAiDone] },
  ] } });
  test("an edit counts its new text, a long preview is six lines, a one-line write has a count and no preview", async ({ page, raw }) => {
    writeFileSync(join(raw.root, "notes.txt"), "một\nhai\nba\nbốn\n");
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await page.getByRole("textbox", { name: "Message" }).fill("sửa và ghi");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.locator("section.approval");
    const allow = async () => {
      const id = await card.locator(".approval-summary").textContent();
      await card.getByRole("button", { name: "Allow once", exact: true }).click();
      await expect(card.locator(".approval-summary")).not.toHaveText(id ?? "");
    };
    await expect(card.locator(".approval-summary")).toHaveText("notes.txt");
    await expect(card.locator(".approval-lines")).toHaveText("+2");
    await expect(card.locator(".approval-preview")).toHaveText("một\nhai\nba\nbốn");
    await allow();
    await expect(card.locator(".approval-summary")).toHaveText("long.txt");
    await expect(card.locator(".approval-lines")).toHaveText("+8");
    await expect(card.locator(".approval-preview")).toHaveText("dòng 1\ndòng 2\ndòng 3\ndòng 4\ndòng 5\n…");
    await allow();
    await expect(card.locator(".approval-summary")).toHaveText("one.txt");
    await expect(card.locator(".approval-lines")).toHaveText("+1");
    await expect(card.locator(".approval-preview")).toHaveCount(0);
    await card.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("Xong", { timeout: 30000 });
  });
});

test.describe("question that failed", () => {
  // An ask_user call rejected before it asked has no question card: its row keeps the error.
  test.use({ scenario: { agent: { tools: { use: ["builtin/ask_user"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "q", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Một?", questions: [{ question: "Hai?" }] }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] },
  ] } });
  test("its row shows the failure message", async ({ page, raw }) => {
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await page.getByRole("textbox", { name: "Message" }).fill("hỏi tôi");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText("ok", { timeout: 30000 });
    const group = page.locator(".work-group").last();
    await group.locator(".work-toggle").click();
    const row = group.locator(".tool-row");
    await expect(row.locator(".tool-glyph")).toHaveAttribute("data-glyph", "x");
    await expect(row.locator(".tool-card")).toBeVisible();
    await expect(row.locator(".tool-card .tool-text")).toContainText("use question or questions, not both");
  });
});

test.describe("question", () => {
  test.use({ scenario: chatScenario });

  test("the question appears once; its row waits for you and shows only its arguments", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw, "question");
    const chat = page.locator(".chat-main");
    // Visible text only: the collapsed group's row also names the question.
    await expect(chat.getByText(QUESTION, { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(chat.getByText(/Waiting for the result/)).toHaveCount(0);
    await expect(page.locator(".working-status")).toHaveCount(0);
    await expect(page.locator("[role=status][aria-live=polite]").filter({ hasText: "Waiting for your answer" })).toHaveCount(1);
    const group = page.locator(".work-group").last();
    await expect(group.locator(".work-time")).toHaveText("Working");
    await group.locator(".work-toggle").click();
    const row = group.locator(".tool-row");
    await expect(row.locator(".tool-status")).toHaveText("Waiting for you");
    await expect(row.locator(".tool-status")).toHaveClass(/tone-accent/);
    await row.locator(".tool-toggle").click();
    const card = row.locator(".tool-card");
    const onlyArguments = async () => {
      await expect(card.locator(".tool-terminal, .tool-text, .json-tree, .tool-markdown, .tool-waiting")).toHaveCount(0);
      await expect(card.locator(".tool-card-foot button")).toHaveText(["Arguments"]);
      await card.getByRole("button", { name: "Arguments", exact: true }).click();
      await expect(card.locator(".tool-arguments")).toContainText(QUESTION);
    };
    await onlyArguments();
    await expect(chat.getByText(QUESTION, { exact: true }).filter({ visible: true })).toHaveCount(2);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await axe(page);
    }
    // Answered: the row is OK and still shows only its arguments.
    await page.getByRole("radio", { name: "Sửa tất cả" }).check();
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("ok", { timeout: 30000 });
    await page.reload();
    const answered = page.locator(".work-group").last();
    await answered.locator(".work-toggle").click();
    await expect(answered.locator(".tool-row")).toHaveAttribute("data-status", "ok");
    await answered.locator(".tool-toggle").click();
    const after = answered.locator(".tool-card");
    await expect(after.locator(".tool-terminal, .tool-text, .json-tree, .tool-markdown")).toHaveCount(0);
    await after.getByRole("button", { name: "Arguments", exact: true }).click();
    await expect(after.locator(".tool-arguments")).toContainText(QUESTION);
  });
});

test.describe("composer", () => {
  test.use({ scenario: chatScenario });
  const CARD = { dark: "rgb(20, 16, 32)", light: "rgb(255, 255, 255)" } as const;
  const HINT = "Enter to send · Shift Enter for a new line · / for commands";

  test("a card with a round Send, the context ring and its Context card, and the hint under it", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw, "answer");
    const area = page.locator(".composer-area");
    const box = area.locator(".composer-box");
    await expect(area.locator(".composer-footer")).toHaveCount(0);
    // A bubble and the group after it are about as far apart as in the mockup, its hover row included.
    const bubble = (await page.getByTestId("user-message").first().locator(".bubble").boundingBox())!;
    const group = (await page.locator(".work-group").first().boundingBox())!;
    expect(group.y - (bubble.y + bubble.height)).toBeLessThanOrEqual(40);
    // The toolbar, left to right.
    const toolbar = area.locator(".composer-toolbar");
    const names = await toolbar.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    expect(names).toEqual(["Add attachment", expect.stringMatching(/^Request settings: /), expect.stringMatching(/^Context: \d+% used$/), "Send"]);
    await expect(toolbar.locator(".request-pill .pill-text")).toHaveText("Reasoning: default");
    const ring = toolbar.getByRole("button", { name: /^Context: / });
    const send = toolbar.getByRole("button", { name: "Send", exact: true });
    const sendBox = (await send.boundingBox())!;
    expect([sendBox.width, sendBox.height]).toEqual([32, 32]);
    expect((await ring.boundingBox())!.x).toBeLessThan(sendBox.x);
    await expect(send).toHaveCSS("border-top-left-radius", "50%");
    await expect(send).toBeDisabled();
    await expect(send).toHaveCSS("opacity", "0.35");
    const add = (await toolbar.getByRole("button", { name: "Add attachment" }).boundingBox())!;
    expect([add.width, add.height]).toEqual([32, 32]);
    await expect(ring.locator("svg")).toHaveAttribute("width", "18");
    await expect(ring).toHaveText(/^\d+%$/);
    // The hint is visible under the card and describes the message box.
    const hint = area.locator(".composer-hint");
    await expect(hint).toHaveText(HINT);
    await expect(hint).toBeVisible();
    expect((await hint.boundingBox())!.y).toBeGreaterThan((await box.boundingBox())!.y + (await box.boundingBox())!.height - 1);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAccessibleDescription(HINT);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await expect(box).toHaveCSS("border-top-left-radius", "16px");
      await expect(box).toHaveCSS("border-top-width", "1px");
      await expect(box).toHaveCSS("background-color", CARD[theme]);
      for (const [side, value] of [["top", "12px"], ["right", "12px"], ["bottom", "10px"], ["left", "16px"]] as const)
        await expect(box).toHaveCSS(`padding-${side}`, value);
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveCSS("font-size", "15px");
    }
    // The Context card: the percent chip, the tokens, the bar, the line, Compact now and Details.
    const percent = (await ring.textContent())!;
    const card = await openContext(page);
    await expect(card.locator(".context-head .sp-chip")).toHaveText(percent);
    await expect(card.locator(".context-big")).toHaveText(/^~[\d.]+k$/);
    await expect(card.locator(".context-of")).toHaveText("/ 8.2k tokens");
    await expect(card.locator(".context-bar")).toBeVisible();
    await expect(card.locator(".context-line")).toHaveText(/^\d+ messages kept · auto compact off$/);
    expect((await card.boundingBox())!.width).toBe(250);
    // Above the ring.
    expect((await card.boundingBox())!.y + (await card.boundingBox())!.height).toBeLessThanOrEqual((await ring.boundingBox())!.y);
    await expect(card.getByRole("button", { name: "Compact now", exact: true })).toBeEnabled();
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await axe(page);
    }
    // Details opens the side panel on Details and closes the card.
    await card.getByRole("button", { name: "Details", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Details", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('.details-card[data-card="context"]')).toBeVisible();
  });

  test("while work runs: Stop is the round button and Compact now says why it waits", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedChat(page, raw, "approval");
    const toolbar = page.locator(".composer-toolbar");
    await expect(toolbar.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    const stop = toolbar.getByRole("button", { name: "Stop", exact: true });
    const box = (await stop.boundingBox())!;
    expect([box.width, box.height]).toEqual([32, 32]);
    await expect(stop).toHaveCSS("border-top-left-radius", "50%");
    const card = await openContext(page);
    await expect(card.getByRole("button", { name: "Compact now", exact: true })).toBeDisabled();
    await expect(card.locator(".context-reason")).toHaveText("Wait for the current work to finish");
    await axe(page);
  });

  test("the Ctrl/⌘-Enter preference changes the hint", async ({ page, raw }) => {
    await page.addInitScript(() => localStorage.setItem("raw.dashboard.preferences.v1", JSON.stringify({ version: 1, sendMode: "modifier" })));
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const hint = "Ctrl/⌘ Enter to send · Enter for a new line · / for commands";
    await expect(page.locator(".composer-hint")).toHaveText(hint);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAccessibleDescription(hint);
    // Not measured yet: the ring has no percent and its card says so.
    const ring = page.locator(".composer-toolbar").getByRole("button", { name: "Context: not measured yet", exact: true });
    await expect(ring).toHaveText("");
    const card = await openContext(page);
    await expect(card.locator(".context-note")).toHaveText("Measured after the first turn.");
    await expect(card.locator(".context-bar")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Compact now", exact: true })).toBeEnabled();
  });

  test("at 390 px the card is 12 px from the sides, the pill keeps its label and the hint is for screen readers", async ({ page, raw }) => {
    installChatWorkspace(raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await seedChat(page, raw, "answer");
    const area = page.locator(".composer-area");
    const box = (await area.locator(".composer-box").boundingBox())!;
    const frame = (await area.boundingBox())!;
    expect(box.x - frame.x).toBeCloseTo(12, 0);
    expect(frame.x + frame.width - (box.x + box.width)).toBeCloseTo(12, 0);
    await expect(area.locator(".request-pill .pill-text")).toHaveText("Reasoning: default");
    expect((await area.locator(".composer-toolbar").boundingBox())!.height).toBeLessThanOrEqual(34);
    const hint = area.locator(".composer-hint");
    expect((await hint.boundingBox())!.height).toBeLessThanOrEqual(1);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAccessibleDescription(HINT);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await axe(page);
    }
  });
});

test.describe("waiting messages", () => {
  test.use({ scenario: chatScenario });
  const QUEUED = [
    { input: "Sau khi sửa xong, chạy lại kiểm tra liên kết cho cả thư mục docs và ghi số liên kết hỏng vào báo cáo, kèm đường dẫn của từng trang có liên kết hỏng để tôi xem lại trước khi gửi." },
    { input: "Xem thêm script này", files: ["scripts/check-links.mjs"] },
    { input: "Bỏ qua các liên kết tới localhost." },
  ];
  /** Queues messages into the running turn, as the composer does. */
  const queue = async (raw: Parameters<typeof installChatWorkspace>[0] & { json: <T>(path: string, method?: string, body?: unknown) => Promise<T> }, page: Page, items: Array<{ input: string; files?: string[] }>) => {
    const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
    for (const item of items)
      await raw.json(`/sessions/${sessionId}/inputs`, "POST", { clientRequestId: crypto.randomUUID(), agent: "raw", mode: "queue", ...item });
  };

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }])
    test(`at ${viewport.width} px three cards sit above the composer card inside the column, and a fourth scrolls`, async ({ page, raw }) => {
      installChatWorkspace(raw);
      await page.setViewportSize(viewport);
      await seedChat(page, raw, "approval");
      await queue(raw, page, QUEUED);
      const cards = page.getByTestId("queued-input");
      await expect(cards).toHaveCount(3);
      await expect(cards.nth(0)).toContainText("Sends after the current step");
      await expect(cards.nth(1).locator(".sent-attachment")).toHaveText("check-links.mjs");
      const box = (await page.locator(".composer-box").boundingBox())!;
      const list = page.locator(".queued-inputs");
      for (const card of await cards.all()) {
        const at = (await card.boundingBox())!;
        expect(at.x).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(at.x + at.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(at.y + at.height).toBeLessThanOrEqual(box.y);
        for (const button of await card.getByRole("button").all()) {
          const target = (await button.boundingBox())!;
          expect(target.width).toBeGreaterThanOrEqual(32);
          expect(target.height).toBeGreaterThanOrEqual(32);
        }
      }
      // The long message shows two lines.
      const text = cards.nth(0).locator(".queued-text");
      const lineHeight = parseFloat(await text.evaluate((element) => getComputedStyle(element).lineHeight));
      expect((await text.boundingBox())!.height).toBeLessThanOrEqual(2 * lineHeight + 1);
      expect(await text.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      // Three cards show whole; a fourth scrolls, and the conversation keeps at least half the height.
      expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      await queue(raw, page, [{ input: "Cuối cùng, tóm tắt các thay đổi." }]);
      await expect(cards).toHaveCount(4);
      expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1);
      expect((await page.locator(".conversation-scroll").boundingBox())!.height).toBeGreaterThanOrEqual(viewport.height / 2);
      for (const theme of ["dark", "light"] as const) {
        await setTheme(page, theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await axe(page);
      }
    });
});

test.describe("markdown outside the chat", () => {
  // The chat's typography, table box and code header stay in chat messages; other Markdown keeps its look.
  test("a Library preview keeps its type, table and code block", async ({ page, raw }) => {
    await seedLibrary(raw);
    await openPath(page, raw.server.launchUrl, "/library/skills/local%2Fguide");
    await page.getByRole("tablist", { name: "Component sections" }).getByRole("tab", { name: "Source" }).click();
    await page.getByRole("radiogroup", { name: "Markdown view" }).getByRole("radio", { name: "Preview" }).click();
    const preview = page.locator(".markdown-preview");
    await expect(preview).toBeVisible();
    await expect(preview.locator("p").first()).toHaveCSS("font-size", "14px");
    await expect(preview.locator("h2").first()).toHaveCSS("font-size", "17px");
    await expect(preview.locator("h2").first()).toHaveCSS("font-weight", "700");
    await expect(preview.locator(".code-block").first()).toHaveCSS("border-top-left-radius", "7px");
    await expect(preview.locator(".code-label").first()).toHaveCSS("font-size", "10px");
    // Its Copy stays the 16 px icon button, with no word and no negative margins.
    const copy = preview.locator(".code-label").first().getByRole("button", { name: "Copy code" });
    await expect(copy).toHaveText("", { useInnerText: true });
    await expect(copy).toHaveCSS("margin-top", "0px");
    await expect(copy.locator("svg")).toHaveCSS("width", "16px");
    await expect(preview.locator(".table-scroll").first()).toHaveCSS("border-top-width", "0px");
    await expect(preview.locator("th").first()).toHaveCSS("border-left-width", "1px");
    await expect(preview.locator("th").first()).toHaveCSS("font-size", "12.6px");
    // Code everywhere: the code size setting and no ligatures.
    await expect(preview.locator("pre code").first()).toHaveCSS("font-size", await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--code-size").trim()));
    await expect(preview.locator("pre code").first()).toHaveCSS("font-variant-ligatures", "none");
  });
});
