import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat, compactNow } from "./fixtures.js";
import { installGate, setGate } from "./prompt-gate.js";
import { makePng } from "../fixtures/images.js";

// docs/chat-design.md §5: your message shows the moment you send it, and says so when the agent never got it.
type Raw = Parameters<Parameters<typeof test>[2]>[0]["raw"];

const message = (page: Page) => page.getByLabel("Message", { exact: true });
const pending = (page: Page) => page.getByTestId("pending-message");
const sendButton = (page: Page) => page.getByRole("button", { name: "Send", exact: true });
/** The last provider request's newest message: the one this send delivered. */
const lastBody = (raw: Raw) => JSON.stringify((raw.provider.requests.at(-1)!.body as { messages: unknown[] }).messages.at(-1));

async function send(page: Page, text: string) {
  await message(page).fill(text);
  await sendButton(page).click();
}

test("your message shows at once, waits for the agent, then is the one bubble in the history", async ({ page, raw }) => {
  installGate(raw, { sleepMs: 1500 });
  await openChat(page, raw);
  await send(page, "Check the links in the docs");
  await expect(pending(page)).toContainText("Check the links in the docs", { timeout: 300 });
  await expect(pending(page)).toContainText(/Sending…|Waiting for the agent/, { timeout: 300 });
  await expect(message(page)).toHaveValue("");
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await expect(pending(page)).toContainText("Waiting for the agent");
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  await expect(pending(page)).toHaveCount(0);
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(page.getByTestId("user-message")).toContainText("Check the links in the docs");
});

test("a message a hook denies is not delivered; Edit puts it back and Retry delivers it", async ({ page, raw }) => {
  installGate(raw, { deny: "blocked by policy" });
  await openChat(page, raw);
  await send(page, "Deploy the docs site");
  await expect(pending(page)).toContainText("Not delivered · the agent did not receive this message");
  await expect(pending(page)).toContainText("blocked by policy");
  expect(raw.provider.requests.length).toBe(0);
  await pending(page).getByRole("button", { name: "Edit" }).click();
  await expect(message(page)).toHaveValue("Deploy the docs site");
  setGate(raw, {});
  await pending(page).getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  expect(raw.provider.requests.length).toBe(1);
  expect(lastBody(raw)).toContain("Deploy the docs site");
  await expect(pending(page)).toHaveCount(0);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
});

test("a later compaction leaves the message that was not delivered in place", async ({ page, raw }) => {
  installGate(raw, { deny: "blocked by policy" });
  await openChat(page, raw);
  await send(page, "Deploy the docs site");
  await expect(pending(page)).toContainText("Not delivered");
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await compactNow(page);
  await expect.poll(() => raw.server.context.store!.listOperations(id, 10).find((op) => op.kind === "compact")?.state).toMatch(/completed|error/);
  await expect(pending(page)).toContainText("Not delivered · the agent did not receive this message");
  await expect(pending(page).getByRole("button", { name: "Retry" })).toBeVisible();
});

test("in a long chat read from the middle, the message you send scrolls into view before its receipt", async ({ page, raw }) => {
  await openChat(page, raw);
  await send(page, "First request");
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15000 });
  const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
  for (let index = 0; index < 40; index++)
    raw.server.context.store!.appendHistory({ sessionId, kind: "assistant", payload: { text: `Note ${index}\n\n${"A line of notes. ".repeat(30)}` } });
  await page.reload();
  await expect(page.getByText(/^Note 39/)).toBeAttached();
  // Read from the middle of the chat: sending brings you to your message.
  const scroller = page.locator(".conversation-scroll");
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/sessions/*/inputs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    await route.fallback();
  });
  await send(page, "Check the links in the docs");
  await expect(pending(page)).toContainText("Sending…");
  await expect(pending(page)).toBeInViewport({ ratio: 1 });
  release();
  await expect(page.getByTestId("user-message").filter({ hasText: "Check the links in the docs" })).toBeVisible();
});

test("Stop while the turn starts leaves the message not delivered, saying it was stopped", async ({ page, raw }) => {
  installGate(raw, { sleepMs: 4000 });
  await openChat(page, raw);
  await send(page, "Summarize the release notes");
  await expect(pending(page)).toContainText("Waiting for the agent");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(pending(page)).toContainText("Not delivered · the agent did not receive this message");
  await expect(pending(page)).toContainText("Stopped before the agent received it");
  expect(raw.provider.requests.length).toBe(0);
});

test("a request the server refuses is not sent, and its text returns to the message box", async ({ page, raw }) => {
  await openChat(page, raw);
  await page.route("**/api/sessions/*/inputs", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { code: "invalid_request_option", message: "That option is not available" } }) })
      : route.fallback());
  await send(page, "Use the fast tier");
  await expect(pending(page)).toContainText("Not sent");
  await expect(pending(page)).toContainText("That option is not available");
  await expect(message(page)).toHaveValue("Use the fast tier");
});

test("a reload shows the waiting message again, and later the message that was not delivered", async ({ page, raw }) => {
  installGate(raw, { sleepMs: 4000 });
  await openChat(page, raw);
  await send(page, "Rename the setup guide");
  await expect(pending(page)).toContainText("Waiting for the agent");
  await page.reload();
  await expect(pending(page)).toContainText("Rename the setup guide");
  await expect(pending(page)).toContainText("Waiting for the agent");
  await expect(page.getByTestId("user-message")).toHaveCount(1, { timeout: 15000 });
  await expect(pending(page)).toHaveCount(0);
  setGate(raw, { deny: "blocked by policy" });
  await send(page, "Delete the changelog");
  await expect(pending(page)).toContainText("Not delivered");
  await page.reload();
  await expect(pending(page)).toContainText("Delete the changelog");
  await expect(pending(page)).toContainText("Not delivered · the agent did not receive this message");
  await expect(pending(page)).toContainText("blocked by policy");
});

test.describe("delivered turns", () => {
  test.use({ scenario: { responses: [{ frames: [] }, { hold: true }] } });
  test("a delivered message outside the loaded history, or stopped after delivery, shows no pending bubble", async ({ page, raw }) => {
    await openChat(page, raw);
    // The first answer: the mock provider's empty stream ends the turn after the message was delivered.
    await send(page, "First request");
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15000 });
    const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
    for (let index = 0; index < 60; index++)
      raw.server.context.store!.appendHistory({ sessionId, kind: "assistant", payload: { text: `Note ${index}` } });
    await page.reload();
    await expect(page.getByText("Note 59", { exact: true })).toBeVisible();
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    await expect(pending(page)).toHaveCount(0);
    // A turn stopped after the agent received the message.
    await send(page, "Second request");
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15000 });
    await expect(pending(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await expect(pending(page)).toHaveCount(0);
  });
});

test.describe("attachments", () => {
  test.use({ scenario: { model: { vision: true } } });
  const png = makePng();
  const ready = (page: Page, name: string) => page.locator(".attachment-chip.ready", { hasText: name });
  test("Retry and Edit keep the text, the file reference and the image; after a reload, the image is to attach again", async ({ page, raw }) => {
    writeFileSync(join(raw.root, "note.txt"), "remember milk");
    installGate(raw, { deny: "blocked by policy" });
    await openChat(page, raw);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    await page.getByRole("menuitem", { name: /Upload file/ }).click();
    await (await chooser).setFiles({ name: "shot.png", mimeType: "image/png", buffer: png });
    await expect(ready(page, "shot.png")).toBeVisible();
    await message(page).pressSequentially("read @not");
    await expect(page.getByRole("listbox", { name: "Suggestions" }).getByRole("option", { name: /note\.txt/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(ready(page, "note.txt")).toBeVisible();
    await message(page).pressSequentially("this please");
    await sendButton(page).click();
    await expect(pending(page)).toContainText("Not delivered");
    await expect(pending(page)).toContainText("shot.png");
    await expect(pending(page)).toContainText("note.txt");
    await expect(page.locator(".attachment-chip")).toHaveCount(0);
    // Edit in this page restores the text and both chips; the image uploads again, once however often you press Edit.
    await pending(page).getByRole("button", { name: "Edit" }).click();
    await pending(page).getByRole("button", { name: "Edit" }).click();
    await expect(message(page)).toHaveValue("read this please");
    await expect(ready(page, "note.txt")).toBeVisible();
    await expect(ready(page, "shot.png")).toBeVisible();
    await expect(page.locator(".attachment-chip", { hasText: "shot.png" })).toHaveCount(1);
    await expect(page.locator(".attachment-chip", { hasText: "note.txt" })).toHaveCount(1);
    // Retry sends all three as a new request, with the image uploaded again.
    setGate(raw, {});
    await pending(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(raw.provider.requests.length).toBe(1);
    expect(lastBody(raw)).toContain("read this please");
    expect(lastBody(raw)).toContain("note.txt");
    expect(lastBody(raw)).toContain(`data:image/png;base64,${png.toString("base64")}`);
    // The same message again, denied, then a reload: the image has to be attached again.
    setGate(raw, { deny: "blocked by policy" });
    await sendButton(page).click();
    await expect(pending(page)).toContainText("Not delivered");
    await page.reload();
    await expect(pending(page)).toContainText("Not delivered");
    await expect(pending(page)).toContainText("read this please");
    await expect(pending(page)).toContainText("note.txt");
    await expect(pending(page).getByText(/shot\.png.*attach again/)).toBeVisible();
    await pending(page).getByRole("button", { name: "Edit" }).click();
    await expect(message(page)).toHaveValue("read this please");
    await expect(ready(page, "note.txt")).toBeVisible();
    await expect(page.locator(".attachment-chip", { hasText: "shot.png" })).toHaveCount(0);
    setGate(raw, {});
    await pending(page).getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => raw.provider.requests.length).toBe(2);
    expect(lastBody(raw)).toContain("read this please");
    expect(lastBody(raw)).toContain("note.txt");
    expect(lastBody(raw)).not.toContain("data:image/png");
  });
});
