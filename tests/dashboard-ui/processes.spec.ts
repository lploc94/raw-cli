import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
const call = (name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id: "command", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const calls = (list: unknown[]) => ({ frames: [openAiFrame({ tool_calls: list.map((args, index) => ({ index, id: `c${index}`, type: "function", function: { name: "bash", arguments: JSON.stringify(args) } })) }, "tool_calls"), openAiDone] });
const section = (page: Page) => page.locator('[data-tab-panel="__commands"]');
const cards = (page: Page) => section(page).locator("li.command-card");
const KEY = "raw.dashboard.commands.v1";
const filter = (page: Page, name: RegExp) => section(page).getByRole("group", { name: "Filter commands" }).getByRole("button", { name });
const output = (card: Locator) => card.getByRole("button", { name: "Output", exact: true });
async function showCommands(page: Page) {
  if (!await page.locator(".inspector").count()) await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await page.getByRole("tab", { name: "Commands", exact: true }).click();
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
const tailText = (card: Locator) => card.locator(".command-tail-line").allTextContents();
test.describe("Commands foreground", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [
    call("bash", { command: "printf 'zero ok'", description: "Say ok" }),
    call("bash", { command: "printf 'two fails' >&2; exit 2", workdir: "sub", description: "Chạy linter" }),
    call("bash", { command: "sleep 5", timeout: 1000 }),
    answer,
  ] } });
  test("one card per command, newest first, with a status filter kept across tabs and reloads", async ({ page, raw }) => {
    mkdirSync(join(raw.root, "sub"));
    await openChat(page, raw);
    await send(page, "run commands");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    // Foreground calls never open the side panel by themselves.
    await expect(page.locator(".inspector")).toHaveCount(0);
    await showCommands(page);
    await expect(cards(page)).toHaveCount(3);
    const [slow, two, ok] = [cards(page).nth(0), cards(page).nth(1), cards(page).nth(2)];
    // A timeout: one compact row with its own chip and duration.
    await expect(slow).toHaveAttribute("data-compact", "true");
    await expect(slow.locator(".command-chip")).toHaveText("Timed out");
    await expect(slow.locator(".command-card-title")).toHaveText("sleep 5");
    await expect(slow.locator(".command-card-time")).toHaveText(/^1\.\d s$/);
    // A failure: the whole card, its exit chip, the description, the command, the other directory and the stderr lines.
    await expect(two).not.toHaveAttribute("data-compact");
    await expect(two).toHaveAttribute("data-tone", "failed");
    await expect(two.locator(".command-chip")).toHaveText("Exit 2");
    await expect(two.locator(".command-card-time")).toHaveText(/^\d+(\.\d)? m?s · \d\d:\d\d/);
    await expect(two.locator(".command-card-title")).toHaveText("Chạy linter");
    await expect(two.locator("code.command-card-line")).toHaveText("printf 'two fails' >&2; exit 2");
    await expect(two.locator(".command-card-cwd")).toHaveAttribute("title", join(raw.root, "sub"));
    await expect(two.locator('.command-tail-line[data-channel="stderr"]')).toHaveText("stderr: two fails");
    expect(await two.locator(".command-tail-line").evaluate((line) => getComputedStyle(line).color)).toBe(await two.locator(".command-chip").evaluate((chip) => getComputedStyle(chip).color));
    await expect(two.getByRole("button", { name: "Copy command", exact: true })).toBeVisible();
    await expect(output(two)).toHaveAttribute("aria-expanded", "false");
    await expect(two.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    // A success: a check, the description and the duration on one line, the command muted below.
    await expect(ok).toHaveAttribute("data-compact", "true");
    await expect(ok.locator(".command-card-glyph")).toHaveAttribute("data-tone", "success");
    await expect(ok.locator(".command-card-glyph")).toContainText("Succeeded");
    await expect(ok.locator(".command-chip")).toHaveCount(0);
    await expect(ok.locator(".command-card-title")).toHaveText("Say ok");
    await expect(ok.locator("code.command-card-sub")).toHaveText("printf 'zero ok'");
    await expect(ok.locator(".command-card-cwd")).toHaveCount(0);
    const line = await ok.locator("button.command-card-open").boundingBox();
    expect(line!.height).toBeLessThanOrEqual(22);
    expect(await ok.locator("code.command-card-sub").evaluate((element) => [getComputedStyle(element).whiteSpace, getComputedStyle(element).textOverflow])).toEqual(["nowrap", "ellipsis"]);
    // The filter: counts, an empty filter keeps its chips, and the choice survives a tab switch and a reload.
    await expect(filter(page, /^All 3$/)).toHaveAttribute("aria-pressed", "true");
    await expect(filter(page, /^Running 0$/)).toBeVisible();
    await filter(page, /^Failed 2$/).click();
    await expect(cards(page).filter({ visible: true })).toHaveCount(2);
    await expect(ok).toBeHidden();
    await filter(page, /^Running 0$/).click();
    await expect(cards(page).filter({ visible: true })).toHaveCount(0);
    await expect(section(page).getByText("Nothing is running.", { exact: true })).toBeVisible();
    await filter(page, /^Failed 2$/).click();
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("tab", { name: "Commands", exact: true }).click();
    await expect(filter(page, /^Failed 2$/)).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await showCommands(page);
    await expect(filter(page, /^Failed 2$/)).toHaveAttribute("aria-pressed", "true");
    await expect(cards(page).filter({ visible: true })).toHaveCount(2);
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), KEY) as { version: number; sessions: Record<string, { filter: string }> };
    expect(stored.version).toBe(1);
    expect(Object.values(stored.sessions).map((entry) => entry.filter)).toEqual(["failed"]);
    await filter(page, /^All 3$/).click();
    // Output opens the terminal frame with the exit status.
    await output(two).click();
    await expect(output(two)).toHaveAttribute("aria-expanded", "true");
    await expect(two.locator(".command-output pre")).toContainText("two fails");
    await expect(two.locator(".command-output .terminal-bar")).toContainText("exit 2");
    // Opening a compact row shows the whole card and moves focus to its Output button.
    await ok.locator("button.command-card-open").click();
    await expect(ok).not.toHaveAttribute("data-compact");
    await expect(output(ok)).toBeFocused();
    await expect(output(ok)).toHaveAttribute("aria-expanded", "true");
    await expect(ok.locator(".command-output pre")).toContainText("zero ok");
    // Closing it from the keyboard shows the compact row again, with focus on it.
    await page.keyboard.press("Enter");
    await expect(ok).toHaveAttribute("data-compact", "true");
    await expect(ok.locator("button.command-card-open")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(output(ok)).toBeFocused();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      expect((await new AxeBuilder({ page }).include(".inspector").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    }
  });
});

test.describe("Commands live tail", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [
    call("bash", { command: "for i in $(seq 1 60); do echo \"tick $i\"; echo \"warn $i\" >&2; sleep 0.15; done", description: "Theo dõi liên kết" }), answer,
  ] } });
  test("a running foreground card shows its last lines as they arrive, has no Stop, and stays put when it finishes in use", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "stream");
    await showCommands(page);
    const card = cards(page).first();
    await expect(card.locator(".command-chip")).toHaveText("Running");
    await expect(card).toHaveAttribute("data-tone", "running");
    await expect(card.locator(".command-card-title")).toHaveText("Theo dõi liên kết");
    await expect(card.locator(".command-card-kind")).toHaveText(/^\d\d:\d\d · foreground$/);
    await expect(card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    // Two samples: three lines from both channels, later each time.
    const tick = (lines: string[]) => Math.max(...lines.map((text) => Number(/(?:tick|warn) (\d+)/.exec(text)?.[1] ?? 0)));
    await expect.poll(async () => (await tailText(card)).length).toBe(3);
    const first = await tailText(card);
    await expect.poll(async () => tick(await tailText(card)), { timeout: 10000 }).toBeGreaterThan(tick(first) + 2);
    const second = await tailText(card);
    expect(second.some((text) => text.startsWith("stderr: warn"))).toBe(true);
    expect(second.some((text) => /^tick \d+$/.test(text))).toBe(true);
    // Under Running, with its output open and focused, the card finishes and keeps its frame and focus.
    await filter(page, /^Running 1$/).click();
    await output(card).click();
    await expect(card.locator(".command-output pre")).toContainText("tick");
    await output(card).focus();
    await expect(card).toHaveAttribute("data-state", "exited", { timeout: 15000 });
    await expect(filter(page, /^Running 0$/)).toHaveAttribute("aria-pressed", "true");
    await expect(card).toBeVisible();
    await expect(card.locator(".command-output pre")).toContainText("tick 60");
    await expect(output(card)).toBeFocused();
    await expect(card).toHaveAttribute("data-tone", "success");
    await expect(card.getByRole("button", { name: "Copy command", exact: true })).toBeVisible();
    // Choosing the filter again, even the current chip, applies it.
    await filter(page, /^Running 0$/).click();
    await expect(card).toBeHidden();
  });
});

test.describe("Commands scroll anchor", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [
    calls(Array.from({ length: 16 }, (_, index) => ({ command: `printf 'job ${index}'`, description: `Job ${index}` }))), answer,
    call("bash", { command: "printf 'late'", description: "Late job" }), answer,
  ] } });
  test("a new command above does not move the card being read", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "many");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await showCommands(page);
    await expect(cards(page)).toHaveCount(16);
    const content = section(page);
    await content.evaluate((element) => { element.scrollTop = 260; });
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
    // The card being read, by identity: an index would point at another card once one is inserted above.
    const read = section(page).locator(`li.command-card[data-id="${await cards(page).nth(8).getAttribute("data-id")}"]`);
    const before = (await read.boundingBox())!.y;
    await send(page, "one more");
    await expect(cards(page)).toHaveCount(17);
    await expect(cards(page).first()).toContainText("Late job");
    // The new card first shows running, then compact: neither change moves the reader.
    await expect(cards(page).first()).toHaveAttribute("data-compact", "true");
    expect(Math.abs((await read.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
    expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(260);
  });
});

test.describe("Commands output", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash", "builtin/process"] } }, responses: [
    call("bash", { command: "for i in $(seq 1 300); do echo \"line $i\"; sleep 0.02; done; sleep 60", run_in_background: true, description: "Stream lines" }), answer,
  ] } });
  test("a background card reads output only after Output, follows it, and keeps its place when Stop settles while focused", async ({ page, raw, context, browserName }) => {
    test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const reads: string[] = [];
    page.on("request", (request) => { if (/\/commands\/[^/]+\/output/.test(request.url())) reads.push(request.url()); });
    await openChat(page, raw);
    await send(page, "stream");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await showCommands(page);
    const card = cards(page).first();
    await expect(card.locator(".command-chip")).toHaveText("Running");
    await expect(card.locator(".command-card-title")).toHaveText("Stream lines");
    await expect(card.locator("code.command-card-line")).toHaveAttribute("title", "for i in $(seq 1 300); do echo \"line $i\"; sleep 0.02; done; sleep 60");
    await expect(card.locator(".command-card-kind")).toHaveText(/^\d\d:\d\d · background$/);
    // No tail for background jobs: their output is read through the policy-checked process control, only on request.
    await page.waitForTimeout(1500);
    await expect(card.locator(".command-tail")).toHaveCount(0);
    expect(reads).toEqual([]);
    await filter(page, /^Running 1$/).click();
    await output(card).click();
    const pre = card.locator(".command-output pre");
    await expect(pre).toContainText("line 40");
    expect(reads.length).toBeGreaterThan(0);
    await expect(pre).toContainText("line 250", { timeout: 15000 });
    await expect.poll(() => pre.evaluate((element) => element.scrollHeight > element.clientHeight && element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);
    await card.locator(".command-output").getByRole("button", { name: "Copy output" }).click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toMatch(/line 1\n[\s\S]*line 250/);
    // Stop from the keyboard: the card stays under Running with its new state, its result, and focus.
    const stop = card.getByRole("button", { name: "Stop", exact: true });
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(card.getByText("Stop completed.", { exact: true })).toBeVisible();
    await expect(card.locator(".command-chip")).toHaveText("Stopped");
    await expect(filter(page, /^Running 0$/)).toHaveAttribute("aria-pressed", "true");
    await expect(card).toBeVisible();
    await expect(card.locator(".command-output pre")).toBeVisible();
    expect(await card.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await card.getByRole("button", { name: "Copy command", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("for i in $(seq 1 300); do echo \"line $i\"; sleep 0.02; done; sleep 60");
  });
});

test.describe("Commands long command", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [call("bash", { command: `: '${"x".repeat(5000)}'; echo long done` }), answer] } });
  test("a command cut for display cannot be copied, and the filter survives a tab switch when storage fails", async ({ page, raw }) => {
    await page.addInitScript((key) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string) { if (name === key) throw new Error("quota"); return setItem.call(this, name, value); };
    }, KEY);
    await openChat(page, raw);
    await send(page, "long");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await showCommands(page);
    await filter(page, /^Failed 0$/).click();
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("tab", { name: "Commands", exact: true }).click();
    await expect(filter(page, /^Failed 0$/)).toHaveAttribute("aria-pressed", "true");
    await filter(page, /^All 1$/).click();
    const card = cards(page).first();
    await expect(card.locator(".command-card-title")).toHaveText(/^: 'x+…$/);
    await card.locator("button.command-card-open").click();
    await expect(card.locator("code.command-card-line")).toHaveText(/^: 'x+…$/);
    await expect(card.getByRole("button", { name: "Copy command (unavailable: the command was cut at 4 KiB)" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Copy command", exact: true })).toHaveCount(0);
  });
});

test.describe("Commands full output", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash"] } }, responses: [call("bash", { command: "seq 1 200000" }), answer] } });
  test("a saved full output loads in the frame and @ inserts its path", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "count");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await showCommands(page);
    const card = cards(page).first();
    await expect(card.locator(".command-tail-line")).toHaveCount(0);
    await card.locator("button.command-card-open").click();
    await card.getByRole("button", { name: "Load full output" }).click();
    await expect(card.locator(".terminal-frame").last()).toContainText("199999\n200000");
    await card.getByRole("button", { name: /^Insert @.+ into the message$/ }).click();
    const reference = await page.getByRole("textbox", { name: "Message" }).inputValue();
    expect(reference.startsWith("@") && reference.endsWith(" ")).toBe(true);
    const path = reference.slice(1, -1);
    expect(isAbsolute(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("199999\n200000");
  });
});

test.describe("Commands background from bash", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/bash", "builtin/process"] } }, responses: [call("bash", { command: "printf 'bash background'; sleep 60", run_in_background: true }), answer] } });
  test("a background bash call starts one managed job in the Commands panel", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "start from bash");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(section(page)).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(section(page).getByRole("button", { name: "Stop", exact: true })).toHaveCount(1);
    await output(cards(page).first()).click();
    await expect(section(page).locator("pre")).toContainText("bash background");
  });
});

test.describe("Commands background", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/process"], rules: [{ match: "builtin/process", effect: "ask", when: { source: "arguments", any: "action", regex: "^stop$" } }] } }, responses: [call("process", { action: "start", command: "printf 'background ready'; sleep 60" }), { hold: true }] } });
  test("background survives its handler, streams during an active turn and Stop asks approval", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "start background");
    await expect(section(page)).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest(".inspector"))).toBe(false);
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    await output(cards(page).first()).click();
    await expect(section(page).locator("pre")).toContainText("background ready");
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(cards(page).first().locator(".command-chip")).toHaveText("Stopped");
    await expect(section(page).locator("pre")).toContainText("background ready");
    await expect(section(page).locator("pre")).toContainText("[stdout]");
    await expect(section(page).getByText("Stop completed.", { exact: true })).toBeVisible();
    expect(raw.provider.requests.length).toBe(2);
  });
  test("a lost Stop response replays the failed receipt, then a fresh retry can request approval", async ({ page, raw }) => {
    let loseFirst = true;
    await page.route("**/commands/*/stop", async route => {
      if (!loseFirst) { await route.continue(); return; }
      loseFirst = false;
      await route.fetch();
      await route.abort("failed");
    });
    await openChat(page, raw);
    await send(page, "start background");
    await expect(section(page)).toBeVisible();
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(section(page).locator(".command-note[role=status]")).toContainText("Stop failed.");
    await section(page).getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(cards(page).first().locator(".command-chip")).toHaveText("Stopped");
  });
  test("Never suppresses background opening and hidden Commands remains hidden after reconnect", async ({ page, raw }) => {
    await page.addInitScript(() => localStorage.setItem("raw.dashboard.preferences.v1", JSON.stringify({ version: 1, panelOpen: "never" })));
    await openChat(page, raw);
    await send(page, "start background");
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await page.getByRole("tab", { name: "Commands", exact: true }).click();
    await page.getByRole("button", { name: "Commands panel menu", exact: true }).click();
    await page.getByRole("menuitem", { name: /Hide/ }).click();
    await expect(section(page)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Commands", exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "Side panel", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Commands", exact: true })).toHaveCount(0);
    await expect(section(page)).toHaveCount(0);
  });
});
