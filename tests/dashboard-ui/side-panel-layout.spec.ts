import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { ACTIVE_TODO, BACKGROUND, FAILING, FOREGROUND, TIMED_OUT, gadget, installStressTools, seedStress, stressScenario } from "./side-panel-stress.js";

// Geometry and content of the side panel with real-length data (docs/side-panel-design.md §10), at the supported widths.
const PREFERENCES = "raw.dashboard.preferences.v1";
const tab = (page: Page, title: string) => page.getByRole("tab", { name: title, exact: true });

/** Layout faults inside the selected tab: horizontal overflow, glyphs off the first text line, clamped text without its full value. */
function layoutFaults(page: Page) {
  return page.getByRole("tabpanel").evaluate((root) => {
    const faults: string[] = [];
    if (root.scrollWidth > root.clientWidth) faults.push(`tab content overflows by ${root.scrollWidth - root.clientWidth}px`);
    for (const card of root.querySelectorAll<HTMLElement>(".sp-card"))
      if (card.scrollWidth > card.clientWidth) faults.push(`card ${card.dataset.card} overflows`);
    for (const line of root.querySelectorAll<HTMLElement>(".sp-card-line")) {
      const glyph = line.querySelector(".sp-line-glyph svg")?.getBoundingClientRect();
      const text = line.querySelector<HTMLElement>(".sp-line-text")!;
      const first = text.getBoundingClientRect().top + parseFloat(getComputedStyle(text).lineHeight);
      if (glyph && (glyph.top + glyph.height / 2 < text.getBoundingClientRect().top || glyph.top + glyph.height / 2 > first))
        faults.push(`glyph off the first line of "${text.textContent}"`);
      if (text.scrollHeight > text.clientHeight + 1 && text.title !== text.textContent) faults.push(`clamped text without its full value: "${text.textContent}"`);
    }
    for (const title of root.querySelectorAll<HTMLElement>(".sp-card-title"))
      if (title.getBoundingClientRect().height > 24) faults.push(`card title wraps: "${title.textContent}"`);
    return faults;
  });
}

/** Command cards: no overflow, chips on the first row, truncated text with its full value in a title or the card's name. */
function commandFaults(page: Page) {
  return page.getByRole("tabpanel").evaluate((root) => {
    const faults: string[] = [];
    if (root.scrollWidth > root.clientWidth) faults.push(`tab content overflows by ${root.scrollWidth - root.clientWidth}px`);
    for (const card of root.querySelectorAll<HTMLElement>("li.command-card:not([hidden])")) {
      const box = card.getBoundingClientRect();
      if (card.scrollWidth > card.clientWidth) faults.push(`card ${card.dataset.id} overflows`);
      for (const child of card.querySelectorAll<HTMLElement>("button, .command-chip, code, .command-tail-line"))
        if (child.getBoundingClientRect().right > box.right + 0.5) faults.push(`"${child.textContent}" sticks out of its card`);
      for (const text of card.querySelectorAll<HTMLElement>(".command-card-title, .command-card-line, .command-card-sub, .command-tail-line")) {
        const cut = text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1;
        const full = (text.closest("[title]") as HTMLElement | null)?.title ?? "";
        const value = (text.textContent ?? "").replace(/^stderr: /, "").replace(/…$/, "");
        if (cut && !full.startsWith(value) && !card.getAttribute("aria-label")?.startsWith(value)) faults.push(`cut without its full value: "${text.textContent}"`);
      }
      const head = card.querySelector<HTMLElement>(".command-card-head");
      if (head && head.getBoundingClientRect().height > 22) faults.push(`card head wraps in ${card.dataset.id}`);
      const glyph = card.querySelector(".command-card-glyph svg")?.getBoundingClientRect();
      const title = card.querySelector<HTMLElement>(".command-card-open > .command-card-title")?.getBoundingClientRect();
      if (glyph && title && Math.abs(glyph.top + glyph.height / 2 - (title.top + title.height / 2)) > 3) faults.push(`glyph off the title line in ${card.dataset.id}`);
    }
    return faults;
  });
}

test.describe("side panel layout", () => {
  test.use({ scenario: stressScenario });
  for (const width of [320, 360]) {
    test(`at ${width} px the Overview cards and tab badges show the stress session without overflow, and each card opens its tab`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Overview").click();
      expect(Math.round((await page.locator(".inspector").boundingBox())!.width)).toBe(width);

      const card = (title: string) => page.locator(".sp-overview-card", { has: page.locator(".sp-card-title", { hasText: new RegExp(`^${title}$`) }) });
      await expect(card("Todo").locator(".sp-meta")).toHaveText("2 of 5");
      await expect(card("Todo").locator(".sp-card-line.glyph-running")).toContainText(ACTIVE_TODO);
      await expect(card("Todo").locator(".sp-bar > i")).toHaveAttribute("style", /width: 40%/);
      await expect(card("Files changed").locator(".sp-stat.added")).toHaveText(/^\+\d+$/);
      await expect(card("Files changed").locator(".sp-card-line")).toHaveText("component-file-name-that-is-long.ts, README.md, old-config.json");
      await expect(card("Commands").locator(".sp-chip")).toHaveText(["1 running", "2 failed"]);
      await expect(card("Commands").locator(".sp-card-line.glyph-running")).toContainText(BACKGROUND.description);
      await expect(card("Commands").locator(".sp-card-line.glyph-failed")).toContainText(FAILING.description);
      await expect(card("Commands").locator(".sp-card-line.glyph-failed .sp-line-meta")).toHaveText("exit 2");
      await expect(card("Gadget").locator(".sp-meta")).toHaveText("1 of 2");
      await expect(card("Context").locator(".sp-chip")).toHaveText(/^\d+%$/);
      await expect(page.locator(".sp-overview-card").last()).toHaveAttribute("data-card", "__details");

      await expect(tab(page, "Todo")).toHaveAccessibleDescription(/^2 of 5 done/);
      await expect(tab(page, "Files changed")).toHaveAccessibleDescription(/^Successful tool writes in this session; not Git status or Bash edits\. 3 files/);
      await expect(tab(page, "Commands")).toHaveAccessibleDescription(/^1 running/);
      await expect(tab(page, "Gadget")).toHaveAccessibleDescription(/^1 of 2 done/);
      await expect(tab(page, "Details")).toHaveAccessibleDescription(/^\d+% of the (context window|auto-compact trigger) used$/);
      // The tab strip never wraps: it is one row that scrolls sideways.
      const strip = (await page.getByRole("tablist").boundingBox())!;
      expect(strip.height).toBeLessThanOrEqual(40);

      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        expect(await layoutFaults(page)).toEqual([]);
        expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }

      // Every card opens its own tab; the Context card opens Details.
      const ids = await page.locator(".sp-overview-card").evaluateAll((cards) => cards.map((element) => (element as HTMLElement).dataset.card!));
      expect(ids.length).toBe(5);
      for (const id of ids) {
        await page.locator(`.sp-overview-card[data-card="${id}"]`).click();
        const selected = page.locator(`[role=tab][data-tab="${id}"]`);
        await expect(selected).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", (await selected.getAttribute("id"))!);
        await tab(page, "Overview").click();
      }
    });

    test(`at ${width} px Details shows the context first, the usage the provider reports, and every session value`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Details").click();
      const body = page.getByRole("tabpanel");
      const cards = body.locator(".details-card");
      await expect(cards.first()).toHaveAttribute("data-card", "context");
      const context = body.locator('.details-card[data-card="context"]');
      await expect(context.locator(".details-label")).toHaveText("Context");
      await expect(context.locator(".details-big")).toHaveText(/^~?\d+(\.\d)?k?$/);
      await expect(context.locator(".details-of")).toHaveText(/^\/ \d+(\.\d)?k? tokens$/);
      await expect(context.locator(".sp-chip")).toHaveText(/^\d+%$/);
      await expect(context.locator(".sp-bar > i")).toHaveAttribute("style", /width: \d/);
      await expect(context.locator(".details-line")).toHaveText(/^\d+ messages kept · no summary yet · auto compact (at [\d.]+k?|off)$/);
      await expect(context.getByRole("button", { name: "Compact now" })).toBeVisible();
      // The mock provider reports no token counts: one note, request counts, and no "Unavailable" rows anywhere.
      const usage = body.locator('.details-card[data-card="usage"]');
      await expect(usage.locator(".details-note")).toHaveText("This provider does not report token counts.");
      await expect(usage.locator("dt")).toHaveText(["Last turn", "This session", "Cache reads"]);
      await expect(usage.locator("dd").first()).toHaveText(/^\d+ requests?$/);
      await expect(body).not.toContainText("Unavailable");
      await expect(body.locator('.details-card[data-card="resume"] code')).toHaveText(/^raw --resume \S+ "Your next message"$/);
      await expect(body.getByRole("button", { name: "Copy resume command" })).toBeVisible();
      await expect(body.locator('.details-card[data-card="capabilities"]')).toContainText("Tools");
      const session = body.locator('.details-card[data-card="session"]');
      for (const label of ["ID", "Workspace", "Config for next turn", "Model"]) await expect(session.locator("dt", { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
      expect(await cards.evaluateAll((list) => list.map((card) => (card as HTMLElement).dataset.card))).toEqual(["context", "usage", "resume", "limits", "capabilities", "session"]);
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        expect(await body.evaluate((root) => [root.scrollWidth - root.clientWidth, ...[...root.querySelectorAll<HTMLElement>(".details-card")].map((card) => card.scrollWidth - card.clientWidth)].filter((overflow) => overflow > 0))).toEqual([]);
        expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }
    });

    test(`at ${width} px the Commands tab shows one readable card per command`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Commands").click();
      const cards = page.getByRole("tabpanel").locator("li.command-card");
      await expect(cards).toHaveCount(4);
      const [running, failed, succeeded, timedOut] = [cards.nth(0), cards.nth(1), cards.nth(2), cards.nth(3)];
      // commands.png: the running job, then "Earlier" over the others, newest first.
      await expect(page.getByRole("tabpanel").locator(".commands-list > li")).toHaveClass([/command-card/, /command-group-label/, /command-card/, /command-card/, /command-card/]);
      await expect(page.getByRole("tabpanel").locator(".command-group-label")).toHaveText("Earlier");
      await expect(running.locator(".command-chip")).toHaveText("Running");
      await expect(running.locator(".command-card-title")).toHaveText(BACKGROUND.description);
      await expect(running.locator("code.command-card-line")).toHaveAttribute("title", BACKGROUND.command);
      await expect(running.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(failed.locator(".command-chip")).toHaveText("Exit 2");
      await expect(failed.locator('.command-tail-line[data-channel="stderr"]')).toHaveText("stderr: error: missing semicolon");
      await expect(succeeded).toHaveAttribute("data-compact", "true");
      await expect(succeeded.locator(".command-card-title")).toHaveText(FOREGROUND.description);
      // Compact: one line for the title, one for the command.
      expect((await succeeded.boundingBox())!.height).toBeLessThanOrEqual(56);
      // A timed-out row: the clock glyph, the title, the chip as a word only; the reason is in the row's tooltip, not a line.
      await expect(timedOut).toHaveAttribute("data-compact", "true");
      await expect(timedOut.locator(".command-card-title")).toHaveText(TIMED_OUT.description);
      await expect(timedOut.locator(".command-chip")).toHaveText("Timed out");
      await expect(timedOut.locator(".command-chip svg")).toHaveCount(0);
      await expect(timedOut.locator(".command-card-glyph svg")).toHaveCount(1);
      await expect(timedOut.locator(".command-note")).toHaveCount(0);
      await expect(timedOut.locator("code.command-card-sub")).toHaveText(TIMED_OUT.command);
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        expect(await commandFaults(page)).toEqual([]);
        expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }
    });
  }
});

test.describe("side panel type", () => {
  test.use({ scenario: stressScenario });
  for (const width of [320, 360]) {
    test(`at ${width} px the panel uses the bundled OFL fonts and the mockups' sizes and spacing`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Commands").click();
      // Inter and JetBrains Mono ship with the dashboard (docs/dashboard.md): loaded from 'self', never a platform font.
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => [document.fonts.check('13px "Inter Variable"'), document.fonts.check('11px "JetBrains Mono Variable"')])).toEqual([true, true]);
      const loaded = await page.evaluate(() => [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")));
      expect(new Set(loaded)).toEqual(new Set(["Inter Variable", "JetBrains Mono Variable"]));
      const sheets = await page.evaluate(() => [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n"));
      expect(sheets).not.toMatch(/-apple-system|BlinkMacSystemFont|SF Pro|SFMono|ui-monospace|system-ui|Segoe UI|Helvetica|Menlo|Consolas/i);
      const style = (selector: string, ...names: string[]) => page.locator(selector).first().evaluate((element, list) => {
        const computed = getComputedStyle(element);
        return list.map((name) => computed.getPropertyValue(name));
      }, names);
      expect((await style(".inspector", "font-family"))[0]).toMatch(/^"Inter Variable"/);
      expect((await style(".command-card-line", "font-family"))[0]).toMatch(/^"JetBrains Mono Variable"/);
      // The approved mockups: the title row, the segmented tabs (docs/chat-design.md §3), the body and a command card.
      expect(await style(".side-panel-title h2", "font-size", "font-weight")).toEqual(["14px", "600"]);
      expect(await style(".side-panel-title", "height", "padding-left")).toEqual(["52px", "2px"]);
      expect(await style(".sp-tabs", "padding-top", "border-top-left-radius", "border-bottom-width")).toEqual(["3px", "10px", "0px"]);
      expect(await style(".sp-tab", "font-size", "padding-top", "padding-left", "border-top-left-radius")).toEqual(["12.5px", "5px", "8px", "7px"]);
      expect(await style('.sp-tab[aria-selected="true"]', "font-weight", "background-color", "border-bottom-width")).toEqual(["400", "rgb(255, 255, 255)", "0px"]);
      expect(await style(".sp-badge", "font-size")).toEqual(["10.5px"]);
      expect(await style(".sp-content", "padding-top", "padding-left", "padding-bottom", "font-size")).toEqual(["12px", "0px", "12px", "13px"]);
      expect(await style("li.command-card:not([data-compact])", "padding-top", "padding-left", "border-radius", "row-gap")).toEqual(["10px", "11px", "10px", "6px"]);
      expect(await style("li.command-card:not([data-compact]) .command-card-title", "font-size", "font-weight")).toEqual(["13px", "550"]);
      expect(await style(".command-chip", "font-size", "font-weight")).toEqual(["11px", "600"]);
      expect(await style(".command-card-line", "font-size", "padding-top", "padding-left", "border-radius")).toEqual(["11.5px", "5px", "7px", "6px"]);
      expect(await style(".command-group-label", "font-size", "letter-spacing", "text-transform")).toEqual(["11px", "0.8px", "uppercase"]);
      // No header inside a tab: its menu is in the title row, next to Close.
      await expect(page.locator(".sp-tab-header")).toHaveCount(0);
      await expect(page.locator(".side-panel-title").getByRole("button", { name: "Commands panel menu", exact: true })).toBeVisible();
      await tab(page, "Todo").click();
      expect(await style('.todo-group[data-group="next"] .todo-row', "padding-top", "padding-left", "column-gap")).toEqual(["5px", "4px", "9px"]);
      await tab(page, "Files changed").click();
      expect(await style("button.panel-file", "padding-top", "column-gap")).toEqual(["6px", "9px"]);
      expect(await style(".panel-file-name", "font-weight")).toEqual(["550"]);
      expect(await style(".panel-file-dir", "font-size")).toEqual(["11.5px"]);
      expect(await style(".panel-files li", "padding-top", "padding-bottom")).toEqual(["0px", "0px"]);
      // Every code element uses the bundled monospace: the resume command in Details, the bars at the mockup's 6 px.
      await tab(page, "Details").click();
      expect((await style('.details-card[data-card="resume"] code', "font-family"))[0]).toMatch(/^"JetBrains Mono Variable"/);
      expect(await style('.details-card[data-card="context"] .sp-bar', "height")).toEqual(["6px"]);
      // The dark palette of the mockups: the backdrop beside the card, the raised tab and solid status tints.
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      expect(await style(".inspector", "background-color")).toEqual(["rgb(7, 6, 11)"]);
      expect(await style('.sp-tab[aria-selected="true"]', "background-color")).toEqual(["rgb(42, 35, 56)"]);
      await tab(page, "Commands").click();
      expect(await style('.command-chip[data-tone="failed"]', "background-color")).toEqual(["rgb(42, 15, 26)"]);
      expect(await style('li.command-card[data-tone="running"]', "border-top-color")).toEqual(["rgb(76, 58, 134)"]);
    });
  }
});

/** Plugin-block faults: horizontal overflow anywhere in `root`, and status glyphs off their label's first line. */
function blockFaults(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((root) => {
    const faults: string[] = [];
    if (root.scrollWidth > root.clientWidth + 1) faults.push(`overflows by ${root.scrollWidth - root.clientWidth}px`);
    for (const element of root.querySelectorAll<HTMLElement>(".panel-block, .panel-step, .panel-event, .panel-kv > div, .panel-table-card"))
      if (element.scrollWidth > element.clientWidth + 1) faults.push(`${element.className} overflows`);
    for (const step of root.querySelectorAll<HTMLElement>(".panel-step")) {
      const glyph = step.querySelector(".panel-status svg")!.getBoundingClientRect();
      const label = step.querySelector<HTMLElement>(".panel-step-label")!;
      const top = label.getBoundingClientRect().top;
      const centre = glyph.top + glyph.height / 2;
      if (centre < top || centre > top + parseFloat(getComputedStyle(label).lineHeight)) faults.push(`glyph off the first line of "${label.textContent}"`);
    }
    return faults;
  });
}

test.describe("plugin blocks", () => {
  test.use({ scenario: stressScenario });
  for (const width of [320, 360]) {
    test(`at ${width} px steps, progress, log, facts and results read as in steps.png and kvtable.png`, async ({ page, raw }) => {
      installStressTools(raw);
      await page.addInitScript(([key, value]) => {
        if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, inspectorWidth: Number(value) }));
      }, [PREFERENCES, String(width)]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await seedStress(page, raw);
      await tab(page, "Gadget").click();
      const body = page.getByRole("tabpanel");
      const block = (kind: string) => body.locator(`.panel-block[data-kind="${kind}"]`);
      // Block titles are group labels; steps and tables count what they hold.
      await expect(body.locator(".panel-block-header h4")).toHaveText(["Steps · 1 of 3", "Progress", "Log", "Facts", "Results · 2 rows", "Notes", "Question", "Future"]);
      expect(await body.locator(".panel-block-header h4").first().evaluate((element) => [getComputedStyle(element).fontSize, getComputedStyle(element).textTransform, getComputedStyle(element).letterSpacing])).toEqual(["11px", "uppercase", "0.8px"]);
      // Steps: a stepper with a line between glyphs, the current step at weight 550 with its detail, durations at the right.
      const steps = block("steps").locator(".panel-step");
      await expect(steps).toHaveCount(3);
      await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
      expect(await steps.nth(1).locator(".panel-step-label").evaluate((element) => getComputedStyle(element).fontWeight)).toBe("550");
      await expect(steps.nth(1).locator(".panel-step-detail")).toHaveText("đang chạy kiểm tra từng trang một, có thể mất vài phút");
      await expect(steps.locator(".panel-step-line")).toHaveCount(2);
      const labelBox = (await steps.first().locator(".panel-step-label").boundingBox())!;
      const timeBox = (await steps.first().locator(".panel-step-time").boundingBox())!;
      expect(timeBox.x).toBeGreaterThan(labelBox.x + labelBox.width - 1);
      // Progress: the label and "3 / 10" on one line, then a 4 px bar.
      const progress = block("progress");
      await expect(progress.locator(".panel-progress-value")).toHaveText("3 / 10");
      const [label, value] = [(await progress.locator(".panel-progress-label").boundingBox())!, (await progress.locator(".panel-progress-value").boundingBox())!];
      expect(Math.abs(label.y + label.height / 2 - (value.y + value.height / 2))).toBeLessThan(2);
      await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
      await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "10");
      expect((await progress.locator(".sp-bar").boundingBox())!.height).toBe(4);
      // Log: newest first, a coloured dot, the time above the label, the label in the text colour.
      const events = block("timeline").locator(".panel-event");
      await expect(events.locator(".panel-event-label")).toHaveText(["Lỗi kết nối", "Sửa liên kết getting-started thành công"]);
      await expect(events.first().locator(".panel-event-detail")).toHaveText("ECONNRESET khi gọi docs.example.com sau 3 lần thử lại");
      const colours = await events.first().evaluate((element) => ({
        dot: getComputedStyle(element.querySelector(".panel-event-dot")!).backgroundColor,
        label: getComputedStyle(element.querySelector(".panel-event-label")!).color,
        text: getComputedStyle(document.querySelector(".inspector")!).color,
      }));
      expect(colours.label).toBe(colours.text);
      expect(colours.dot).not.toBe("rgba(0, 0, 0, 0)");
      expect((await events.first().locator("time").boundingBox())!.y).toBeLessThan((await events.first().locator(".panel-event-label").boundingBox())!.y);
      // Facts: the key above its value; a reference is a file chip with its folder, inserting the path.
      const facts = block("key_value").locator(".panel-kv > div");
      const [key, val] = [(await facts.first().locator("dt").boundingBox())!, (await facts.first().locator("dd").boundingBox())!];
      expect(val.y).toBeGreaterThanOrEqual(key.y + key.height - 1);
      const chip = facts.nth(1).locator(".panel-ref");
      await expect(chip).toHaveText("component-file-name.ts:42");
      await expect(chip).toHaveAttribute("title", "Insert @src/very/deep/nested/directory/structure/component-file-name.ts into the message");
      await expect(facts.nth(1).locator(".panel-ref-dir")).toHaveText("src/very/deep/nested/directory/structure");
      // Results: below 420 px each row is a card, never a table.
      const results = block("table");
      await expect(results.locator("table")).toHaveCount(0);
      const cards = results.locator(".panel-table-card");
      await expect(cards).toHaveCount(2);
      await expect(cards.locator(".panel-table-card-title")).toHaveText(["getting-started-with-the-command-line-and-configuration.md", "faq.md"]);
      await expect(cards.locator(".panel-table-card-cells")).toHaveText(["Trạng thái: liên kết ổn, xem lại sau 30 ngày · Liên kết: 44", "Trạng thái: lỗi · Liên kết: 0"]);
      await expect(cards.first().locator(".panel-status")).toHaveAttribute("title", "Done");
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        expect(await blockFaults(page, ".sp-content")).toEqual([]);
        expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      }
      await chip.click();
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("@src/very/deep/nested/directory/structure/component-file-name.ts ");
    });
  }
});

test.describe("inline plugin view", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/inline"] } }, responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "inline", arguments: "{}" } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "received" }, "stop"), openAiDone] }] } });
  test("at chat width the same blocks render, the table as a compact table, without overflow", async ({ page, raw }) => {
    const folder = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", "inline");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "tool.json"), JSON.stringify({ api_version: 2, id: "inline", version: "1.0.0", name: "inline", description: "Inline", entry: "./index.mjs",
      input_schema: { type: "object", properties: {}, additionalProperties: false }, panels: [{ id: "view", title: "Review", placement: "chat", actions: [
        { id: "submit", label: "Send answer", kind: "response", scope: "block", response: "submit", blocks: ["form"] },
        { id: "cancel", label: "Skip", kind: "response", scope: "block", response: "cancel", blocks: ["form"] }] }] }));
    const blocks = gadget.blocks.filter((entry) => ["steps", "key_value", "table"].includes(entry.kind));
    writeFileSync(join(folder, "index.mjs"), `export async function handler(args, context) { const result = await context.interactions.request({ panel: "view", document: { blocks: [
      ...${JSON.stringify(blocks)}, { id: "form", kind: "form", fields: [{ id: "ok", label: "Looks right", kind: "single_select", required: true, options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }] }] } });
      return { content: [{ type: "json", value: result }] }; }`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("show");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const view = page.locator(".inline-tool-view").last();
    await expect(view.locator(".panel-step")).toHaveCount(3);
    // The view is wider than the 420 px switch, so the table is a table with single-line cells and their full text in title.
    expect((await view.locator('.panel-block[data-kind="table"]').boundingBox())!.width).toBeGreaterThanOrEqual(420);
    await expect(view.locator("table.panel-table")).toBeVisible();
    await expect(view.locator(".panel-table-card")).toHaveCount(0);
    const cell = view.locator("table.panel-table tbody td", { hasText: "liên kết ổn" });
    await expect(cell).toHaveAttribute("title", "liên kết ổn, xem lại sau 30 ngày");
    expect(await cell.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      expect(await blockFaults(page, ".inline-tool-view")).toEqual([]);
      expect((await new AxeBuilder({ page }).include(".inline-tool-view").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    }
  });
});

test("the bundled fonts' licences ship with the dashboard", () => {
  for (const font of ["inter", "jetbrains-mono"]) expect(readFileSync(`dist/dashboard/licenses/${font}-OFL.txt`, "utf8")).toContain("SIL Open Font License, Version 1.1");
  // Only the two OFL families are bundled.
  expect(readdirSync("dist/dashboard/assets").filter((file) => file.endsWith(".woff2")).every((file) => /^(inter|jetbrains-mono)-/.test(file))).toBe(true);
});

test.describe("Details with reported usage", () => {
  const usage = (prompt: number, completion: number, cached?: number) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) } })}\n\n`;
  test.use({ scenario: { responses: [
    // The first request reports no cache counts: the session's cache values cover one of its two requests.
    { frames: [openAiFrame({ content: "First." }, "stop"), usage(1200, 30), openAiDone] },
    { frames: [openAiFrame({ content: "Second." }, "stop"), usage(1500, 40, 1000), openAiDone] },
  ] } });
  test("the usage card lists the reported counts for the last turn and the session, without the no-report note", async ({ page, raw }) => {
    await openChat(page, raw);
    for (const [index, text] of ["one", "two"].entries()) {
      await page.getByRole("textbox", { name: "Message" }).fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("assistant-message")).toHaveCount(index + 1);
    }
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await tab(page, "Details").click();
    const card = page.getByRole("tabpanel").locator('.details-card[data-card="usage"]');
    // Key/value rows as in details.png: each scope's requests and reported tokens, then the cache.
    await expect(card.locator("dt")).toHaveText(["Last turn", "This session", "Cache reads", "Session cache reads", "Cache read share", "Uncached input"]);
    await expect(card.locator("dd")).toHaveText(["1 request · 1,500 in · 40 out", "2 requests · 2,700 in · 70 out", "1 of 1 · 1,000 tokens", "1 of 2 · 1,000 tokens",
      "66.7% (1 of 1) · 66.7% (1 of 2) in session", "500 · — in session"]);
    await expect(card.locator(".details-note")).toHaveCount(0);
    await expect(page.getByRole("tabpanel")).not.toContainText("Unavailable");
    await expect(page.getByRole("tabpanel").locator('.details-card[data-card="context"] .details-of')).toBeVisible();
    // Long sessions: values for thousands of requests and millions of tokens wrap inside the card at the default width.
    await card.locator("dd").nth(1).evaluate((cell) => { cell.textContent = "1,000 requests · 12,345,678 in · 1,234,567 out"; });
    await card.locator("dd").nth(3).evaluate((cell) => { cell.textContent = "1,000 of 1,000 · 12,345,678 tokens"; });
    const fits = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { overflow: element.scrollWidth - element.clientWidth, right: Math.max(...[...element.querySelectorAll("dd")].map((cell) => Math.round(cell.getBoundingClientRect().right - box.right))) };
    });
    expect(fits.overflow).toBeLessThanOrEqual(0);
    expect(fits.right).toBeLessThan(0);
  });
});

// The chat's message typography stays in chat messages (docs/chat-design.md §5): a markdown block keeps the panel's type.
test.describe("markdown block type", () => {
  test.use({ scenario: stressScenario });
  test("a markdown block keeps the panel's type", async ({ page, raw }) => {
    installStressTools(raw);
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedStress(page, raw);
    await page.getByRole("tab", { name: /Gadget/ }).click();
    const block = page.locator(".sp-content .markdown").first();
    await expect(block.locator("p").first()).toHaveCSS("font-size", "13px");
    await expect(block.locator(":not(pre) > code").first()).toHaveCSS("font-size", "11.7px");
    await expect(block.locator(":not(pre) > code").first()).toHaveCSS("border-top-left-radius", "4px");
  });
});
