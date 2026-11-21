import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { makePng } from "../fixtures/images.js";
import { installGate, setGate } from "./prompt-gate.js";

// docs/dashboard.md: a message sent while the agent works waits as a card above the composer and reaches the agent after
// the current step; Interrupt and send stops the step and starts a turn with it.
type Raw = Parameters<Parameters<typeof test>[2]>[0]["raw"];

const png = makePng();
const message = (page: Page) => page.getByLabel("Message", { exact: true });
const cards = (page: Page) => page.getByTestId("queued-input");
const button = (page: Page, name: string) => page.locator(".composer-area").getByRole("button", { name, exact: true });
const ready = (page: Page, name: string) => page.locator(".composer .attachment-chip.ready", { hasText: name });
/** A bash step that runs until the test calls `release` with the same name. */
const step = (name: string) => ({
  frames: [
    openAiFrame({ tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name: "bash",
      arguments: JSON.stringify({ command: `while [ ! -f release-${name} ]; do sleep 0.05; done`, description: `Wait for ${name}` }) } }] }, "tool_calls"),
    openAiDone,
  ],
});
const quick = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "call-quick", type: "function",
  function: { name: "bash", arguments: JSON.stringify({ command: "printf done", description: "Say done" }) } }] }, "tool_calls"), openAiDone] };
const release = (raw: Raw, name: string) => writeFileSync(join(raw.root, `release-${name}`), "");
/** The messages of the provider request at `index`. */
const messages = (raw: Raw, index: number) => (raw.provider.requests[index]!.body as { messages: unknown[] }).messages;
const lastMessage = (raw: Raw, index: number) => JSON.stringify(messages(raw, index).at(-1));
const sessionOf = (page: Page) => new URL(page.url()).pathname.split("/").at(-1)!;
const operations = (raw: Raw, page: Page) => raw.server.context.store!.listOperations(sessionOf(page), 20).toReversed();
const bash = { tools: { use: ["builtin/bash"] } };

async function startWork(page: Page, raw: Raw) {
  await openChat(page, raw);
  await message(page).fill("Run the checks");
  await message(page).press("Enter");
  await expect(page.locator(".work-group")).toHaveCount(1);
  await expect(button(page, "Stop")).toBeVisible();
}
async function chooseImage(page: Page) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add attachment" }).click();
  await page.getByRole("menuitem", { name: /Upload file/ }).click();
  await (await chooser).setFiles({ name: "shot.png", mimeType: "image/png", buffer: png });
}

test.describe("queue", () => {
  test.use({ scenario: { agent: bash, responses: [step("a"), quick, answer] } });

  test("a message typed while the agent works waits as a card, then reaches the agent after the current step", async ({ page, raw }) => {
    await startWork(page, raw);
    await message(page).fill("Also check the docs");
    await expect(button(page, "Send")).toBeEnabled();
    await expect(button(page, "Stop")).toHaveCount(0);
    await message(page).press("Enter");
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page)).toContainText("Also check the docs");
    await expect(cards(page)).toContainText("Sends after the current step");
    await expect(message(page)).toHaveValue("");
    await expect(button(page, "Stop")).toBeVisible();
    expect(raw.provider.requests.length).toBe(1);
    release(raw, "a");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    expect(raw.provider.requests.length).toBe(3);
    // The provider got the message after the step's result.
    expect(lastMessage(raw, 1)).toContain("Also check the docs");
    expect(JSON.stringify(messages(raw, 1).at(-2))).toContain("tool");
    // Its bubble sits where the agent got it: between the two Work groups of the one turn.
    const order = await page.locator(".conversation").evaluate((root) => [...root.querySelectorAll(".work-group, .message")]
      .map((element) => element.classList.contains("work-group") ? "work"
        : element.classList.contains("user") ? `user: ${element.querySelector(".message-body, .markdown")?.textContent?.trim() ?? element.textContent?.trim()}` : "assistant"));
    expect(order.length).toBe(5);
    expect(order[0]).toContain("Run the checks");
    expect(order[1]).toBe("work");
    expect(order[2]).toContain("Also check the docs");
    expect(order.slice(3)).toEqual(["work", "assistant"]);
    // The turn's time shows once, on its last group.
    const times = await page.locator(".work-group .work-time").allTextContents();
    expect(times[0]).toBe("Worked");
    expect(times[1]).toMatch(/^Worked \d+\.\ds$/);
  });
});

test.describe("stop and send now", () => {
  test.use({ scenario: { agent: bash, responses: [step("b"), answer] } });

  test("Stop pauses the waiting message and starts nothing; Send now sends it", async ({ page, raw }) => {
    await startWork(page, raw);
    await message(page).fill("Then summarize");
    await message(page).press("Enter");
    await expect(cards(page)).toContainText("Sends after the current step");
    await button(page, "Stop").click();
    await expect(cards(page)).toContainText("Paused");
    await page.waitForTimeout(1000);
    expect(raw.provider.requests.length).toBe(1);
    await expect(cards(page)).toHaveCount(1);
    await cards(page).getByRole("button", { name: "Send now" }).click();
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    expect(raw.provider.requests.length).toBe(2);
    expect(lastMessage(raw, 1)).toContain("Then summarize");
    await expect(page.locator(".message.user").last()).toContainText("Then summarize");
  });
});

test.describe("interrupt", () => {
  test.use({ scenario: { agent: bash, responses: [step("c"), step("d"), answer] } });

  test("Ctrl/⌘+Shift+Enter and Interrupt and send stop the step and start a turn with the message", async ({ page, raw }) => {
    await startWork(page, raw);
    await message(page).fill("Check the docs instead");
    await message(page).press("ControlOrMeta+Shift+Enter");
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    expect(lastMessage(raw, 1)).toContain("Check the docs instead");
    await expect.poll(() => operations(raw, page).map((op) => op.state)).toEqual(["cancelled", "running"]);
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator(".work-group")).toHaveCount(2);
    await message(page).fill("Only the readme");
    await page.locator(".composer-area").getByRole("button", { name: "More send options" }).click();
    await page.getByRole("menuitem", { name: "Interrupt and send" }).click();
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(raw.provider.requests.length).toBe(3);
    expect(lastMessage(raw, 2)).toContain("Only the readme");
    expect(operations(raw, page).map((op) => op.state)).toEqual(["cancelled", "cancelled", "completed"]);
  });
});

test.describe("edit and delete", () => {
  test.use({ scenario: { model: { vision: true }, agent: bash, responses: [step("e"), answer] } });

  test("Edit and Up put the text, file and image back, also after a reload; Delete removes a card", async ({ page, raw }) => {
    writeFileSync(join(raw.root, "notes.md"), "# Notes");
    await startWork(page, raw);
    await message(page).pressSequentially("Review @note");
    await page.getByRole("listbox", { name: "Suggestions" }).getByRole("option", { name: /notes\.md/ }).click();
    await message(page).pressSequentially("for typos");
    await chooseImage(page);
    await expect(ready(page, "notes.md")).toBeVisible();
    await expect(ready(page, "shot.png")).toBeVisible();
    await message(page).press("Enter");
    await expect(cards(page)).toContainText("Review for typos");
    await expect(cards(page)).toContainText("notes.md");
    await expect(cards(page)).toContainText("shot.png");
    await expect(page.locator(".composer .attachment-chip")).toHaveCount(0);
    // Edit puts the message before what is typed.
    await message(page).fill("Keep this too");
    await cards(page).getByRole("button", { name: "Edit" }).click();
    await expect(cards(page)).toHaveCount(0);
    await expect(message(page)).toHaveValue("Review for typos\n\nKeep this too");
    await expect(ready(page, "notes.md")).toBeVisible();
    await expect(ready(page, "shot.png")).toBeVisible();
    await message(page).press("Enter");
    await expect(cards(page)).toHaveCount(1);
    // After a reload the card comes from the server; Up in the empty box edits it.
    await page.reload();
    await expect(cards(page)).toContainText("Review for typos");
    await message(page).focus();
    await message(page).press("ArrowUp");
    await expect(cards(page)).toHaveCount(0);
    await expect(message(page)).toHaveValue("Review for typos\n\nKeep this too");
    await expect(ready(page, "notes.md")).toBeVisible();
    await expect(ready(page, "shot.png")).toBeVisible();
    await message(page).press("Enter");
    await expect(cards(page)).toHaveCount(1);
    await message(page).fill("Delete me");
    await message(page).press("Enter");
    await expect(cards(page)).toHaveCount(2);
    await cards(page).filter({ hasText: "Delete me" }).getByRole("button", { name: "Delete" }).click();
    await expect(cards(page)).toHaveCount(1);
    release(raw, "e");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    const delivered = lastMessage(raw, 1);
    expect(delivered).toContain("Review for typos");
    expect(delivered).toContain("notes.md");
    expect(delivered).toContain(`data:image/png;base64,${png.toString("base64")}`);
    expect(JSON.stringify(messages(raw, 1))).not.toContain("Delete me");
  });
});

test.describe("edit, then retry", () => {
  test.use({ scenario: { model: { vision: true }, agent: bash, responses: [step("j"), answer, answer] } });

  test("an image an edited message brought back is sent again by Retry", async ({ page, raw }) => {
    installGate(raw, {});
    await startWork(page, raw);
    await chooseImage(page);
    await expect(ready(page, "shot.png")).toBeVisible();
    await message(page).fill("Describe the screenshot");
    await message(page).press("Enter");
    await expect(cards(page)).toHaveCount(1);
    // While the page reads its copy of the image back, nothing of the message is in the box yet: it cannot leave without it.
    let go!: () => void;
    const held = new Promise<void>((resolve) => { go = resolve; });
    await page.route("**/api/sessions/*/attachments/*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await held;
      await route.fallback();
    });
    await cards(page).getByRole("button", { name: "Edit" }).click();
    await page.waitForTimeout(300);
    await expect(message(page)).toHaveValue("");
    await expect(button(page, "Send")).toHaveCount(0);
    go();
    await expect(message(page)).toHaveValue("Describe the screenshot");
    // The chip holds a copy of the image again, thumbnail and all.
    await expect(ready(page, "shot.png").locator(".chip-thumb")).toBeVisible();
    release(raw, "j");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(button(page, "Send")).toBeEnabled();
    setGate(raw, { deny: "blocked by policy" });
    await message(page).press("Enter");
    const pending = page.getByTestId("pending-message");
    await expect(pending).toContainText("Not delivered");
    setGate(raw, {});
    await pending.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    expect(raw.provider.requests.length).toBe(3);
    expect(lastMessage(raw, 2)).toContain("Describe the screenshot");
    expect(lastMessage(raw, 2)).toContain(`data:image/png;base64,${png.toString("base64")}`);
  });
});

test.describe("already sent", () => {
  test.use({ scenario: { agent: bash, responses: [step("f"), answer] } });

  test("deleting a message the agent took meanwhile says Already sent", async ({ page, raw }) => {
    await startWork(page, raw);
    await message(page).fill("Check the docs");
    await message(page).press("Enter");
    await expect(cards(page)).toHaveCount(1);
    let go!: () => void;
    const held = new Promise<void>((resolve) => { go = resolve; });
    await page.route("**/api/sessions/*/inputs/*", async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      await held;
      await route.fallback();
    });
    await cards(page).getByRole("button", { name: "Delete" }).click();
    release(raw, "f");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(lastMessage(raw, 1)).toContain("Check the docs");
    go();
    await expect(cards(page)).toContainText("Already sent");
    await expect(cards(page)).toHaveCount(0);
  });
});

test.describe("two tabs", () => {
  test.use({ scenario: { agent: bash, responses: [step("g"), answer] } });

  test("a message queued in one tab shows its card in another", async ({ page, raw }) => {
    await startWork(page, raw);
    const other = await page.context().newPage();
    await other.goto(`${page.url()}#token=${raw.server.token}`);
    await expect(button(other, "Stop")).toBeVisible();
    await message(page).fill("From the first tab");
    await message(page).press("Enter");
    await expect(cards(other)).toContainText("From the first tab");
    await cards(other).getByRole("button", { name: "Delete" }).click();
    await expect(cards(page)).toHaveCount(0);
    await other.close();
  });
});

test.describe("Ctrl/⌘-Enter preference", () => {
  test.use({ scenario: { agent: bash, responses: [step("h"), answer, answer] } });

  test("Enter adds a line, Ctrl/⌘+Enter queues and Ctrl/⌘+Shift+Enter interrupts", async ({ page, raw }) => {
    await page.addInitScript(() => localStorage.setItem("raw.dashboard.preferences.v1", JSON.stringify({ version: 1, sendMode: "modifier" })));
    await openChat(page, raw);
    await message(page).fill("Run the checks");
    await message(page).press("ControlOrMeta+Enter");
    await expect(page.locator(".work-group")).toHaveCount(1);
    await message(page).pressSequentially("First line");
    await message(page).press("Enter");
    await message(page).pressSequentially("Second line");
    await expect(cards(page)).toHaveCount(0);
    await expect(message(page)).toHaveValue("First line\nSecond line");
    await message(page).press("ControlOrMeta+Enter");
    await expect(cards(page)).toContainText("First line");
    await message(page).fill("Do this first");
    await message(page).press("ControlOrMeta+Shift+Enter");
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    expect(operations(raw, page)[0]!.state).toBe("cancelled");
    // The interrupting message starts the turn; the earlier waiting one follows it.
    const sent = JSON.stringify(messages(raw, 1));
    expect(sent).toContain("Do this first");
    expect(sent.indexOf("Do this first")).toBeLessThan(sent.indexOf("First line"));
  });
});
