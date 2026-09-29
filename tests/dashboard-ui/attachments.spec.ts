import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect, openChat } from "./fixtures.js";
import { makePng } from "../fixtures/images.js";

const png = makePng();
const message = (page: Page) => page.getByLabel("Message", { exact: true });
const file = (name = "shot.png", bytes: Buffer = png, mimeType = "image/png") => ({ name, mimeType, buffer: bytes });
const requestBody = (raw: { provider: { requests: Array<{ body: unknown }> } }) => JSON.stringify(raw.provider.requests.at(-1)!.body);
const b64 = png.toString("base64");

async function chooseImage(page: Page, payload = file()) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add attachment" }).click();
  await page.getByRole("menuitem", { name: /Upload image/ }).click();
  await (await chooser).setFiles(payload);
}
async function dispatchFiles(page: Page, kind: "paste" | "drop", name = "dropped.png", text = "") {
  await page.evaluate(
    ({ kind, name, bytes, text }) => {
      const transfer = new DataTransfer();
      if (text) transfer.setData("text/plain", text);
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
      const target = kind === "paste" ? document.querySelector("textarea")! : document.querySelector(".composer-box")!;
      // Firefox ignores `clipboardData` in the ClipboardEvent constructor, so attach it to a plain event.
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: transfer });
      const event = kind === "paste" ? paste : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    },
    { kind, name, bytes: [...png], text },
  );
}
const ready = (page: Page, name: string) => page.locator(".attachment-chip.ready", { hasText: name });

test.describe("vision agent", () => {
  test.use({ scenario: { model: { vision: true } } });

  for (const via of ["menu", "paste", "drop"] as const)
    test(`image via ${via} reaches the model byte-for-byte and renders after reload`, async ({ page, raw }) => {
      await openChat(page, raw);
      if (via === "menu") await chooseImage(page);
      else await dispatchFiles(page, via);
      await expect(ready(page, via === "menu" ? "shot.png" : "dropped.png")).toBeVisible();
      await message(page).fill("what is this");
      await message(page).press("Enter");
      await expect(page.getByTestId("assistant-message")).toBeVisible();
      const body = requestBody(raw);
      expect(body).toContain(`data:image/png;base64,${b64}`);
      expect(body).toContain("what is this");
      await expect(page.locator(".attachment-chip")).toHaveCount(0);
      await expect(page.getByTestId("user-message").locator("img")).toBeVisible();
      await page.reload();
      const thumb = page.getByTestId("user-message").locator("img");
      await expect(thumb).toBeVisible();
      expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      await page.getByRole("button", { name: /^Open / }).click();
      await expect(page.getByRole("dialog").locator("img")).toBeVisible();
    });

  test("an attachment-only turn sends default text; removing a ready chip deletes the staged item", async ({ page, raw }) => {
    await openChat(page, raw);
    await chooseImage(page);
    await expect(ready(page, "shot.png")).toBeVisible();
    expect(raw.server.context.attachments!.size()).toBe(1);
    await page.getByRole("button", { name: "Remove shot.png" }).click();
    await expect.poll(() => raw.server.context.attachments!.size()).toBe(0);
    await chooseImage(page);
    await expect(ready(page, "shot.png")).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(requestBody(raw)).toContain("Please look at the attached image.");
  });

  test("invalid type and oversize are chip-level errors that never block the text turn", async ({ page, raw }) => {
    await openChat(page, raw);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    await page.getByRole("menuitem", { name: /Upload image/ }).click();
    await (await chooser).setFiles([file("notes.txt", Buffer.from("hi"), "text/plain"), file("huge.png", Buffer.alloc(9 * 1048576), "image/png")]);
    await expect(page.locator(".attachment-chip.error")).toHaveCount(2);
    await expect(page.getByText(/Unsupported type/)).toBeVisible();
    await expect(page.getByText(/Too large/)).toBeVisible();
    await message(page).fill("still works");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await message(page).press("Enter");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(requestBody(raw)).not.toContain("image_url");
  });

  test("Send waits for an in-flight upload; a failed upload can be retried", async ({ page, raw }) => {
    await openChat(page, raw);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let fail = true;
    await page.route("**/api/sessions/*/attachments", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      if (fail) { fail = false; await gate; return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "upload broke" } }) }); }
      return route.fallback();
    });
    await message(page).fill("text");
    await chooseImage(page);
    await expect(page.locator(".attachment-chip[aria-busy=true]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    release();
    await expect(page.getByText("upload broke")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Retry shot.png" }).click();
    await expect(ready(page, "shot.png")).toBeVisible();
  });

  test("@ picks a workspace file as a chip and the model receives the reference, not a text token", async ({ page, raw }) => {
    writeFileSync(join(raw.root, "note.txt"), "remember milk");
    await openChat(page, raw);
    const input = message(page);
    await input.pressSequentially("read @not");
    const option = page.getByRole("listbox", { name: "Suggestions" }).getByRole("option", { name: /note\.txt/ });
    await expect(option).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ready(page, "note.txt")).toBeVisible();
    await expect(input).toHaveValue("read ");
    await input.press("Enter");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(requestBody(raw)).toContain("note.txt");
    expect(requestBody(raw)).not.toContain("@not");
    await expect(page.getByTestId("user-message")).toContainText("note.txt");
  });

  test("the + menu is keyboard operable and returns focus to the message box", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("button", { name: "Add attachment" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    // Radix hides the rest of the page while a modal menu is open, so audit the menu itself.
    const axe = await new AxeBuilder({ page }).include("[role=menu]").analyze();
    expect(axe.violations).toEqual([]);
    await expect(page.getByRole("menuitem", { name: /Upload image/ })).toBeFocused(); // keyboard open focuses the first item
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // Reference workspace file…
    await expect(message(page)).toBeFocused();
    await expect(message(page)).toHaveValue("@");
    await expect(page.getByRole("listbox", { name: "Suggestions" })).toBeVisible();
  });

  test("a failed submit keeps chips and the draft for another try", async ({ page, raw }) => {
    await openChat(page, raw);
    await chooseImage(page);
    await expect(ready(page, "shot.png")).toBeVisible();
    await message(page).fill("keep this");
    await page.route("**/api/sessions/*/operations", (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "nope" } }) }) : route.fallback());
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("nope")).toBeVisible();
    await expect(ready(page, "shot.png")).toBeVisible();
    await expect(message(page)).toHaveValue("keep this");
    await page.unroute("**/api/sessions/*/operations");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    expect(requestBody(raw)).toContain(b64);
  });

  test("the server's per-chat count limit is a chip-level error that leaves other chips and the draft alone", async ({ page, raw }) => {
    await openChat(page, raw);
    await message(page).fill("draft stays");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add attachment" }).click();
    await page.getByRole("menuitem", { name: /Upload image/ }).click();
    await (await chooser).setFiles(Array.from({ length: 9 }, (_, i) => file(`img${i}.png`)));
    await expect(page.locator(".attachment-chip.ready")).toHaveCount(8);
    await expect(page.locator(".attachment-chip.error")).toHaveCount(1);
    await expect(message(page)).toHaveValue("draft stays");
  });

  test("pasting an image together with text keeps the text", async ({ page, raw }) => {
    await openChat(page, raw);
    await message(page).click();
    await dispatchFiles(page, "paste", "mixed.png", "cell text");
    await expect(ready(page, "mixed.png")).toBeVisible();
    // A synthetic paste event does not run the browser's default insertion, so assert the default was not cancelled.
    const prevented = await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "x");
      transfer.items.add(new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      document.querySelector("textarea")!.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });

  test("chips pass axe", async ({ page, raw }) => {
    await openChat(page, raw);
    await chooseImage(page);
    await expect(ready(page, "shot.png")).toBeVisible();
    const axe = await new AxeBuilder({ page }).include(".composer-area").analyze();
    expect(axe.violations).toEqual([]);
  });
});

test.describe("agent without vision", () => {
  test("uploads still work, the chip warns, and the model gets a placeholder instead of the image", async ({ page, raw }) => {
    await openChat(page, raw);
    await chooseImage(page);
    await expect(ready(page, "shot.png")).toBeVisible();
    await expect(page.getByText(/cannot see images/)).toBeVisible();
    await message(page).fill("describe");
    await message(page).press("Enter");
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    const body = requestBody(raw);
    expect(body).not.toContain("image_url");
    expect(body).not.toContain(b64);
    expect(body).toContain("Image omitted");
    await expect(page.getByText("Images in this chat are sent to this agent as text placeholders.")).toBeVisible();
    // A later text-only turn is never blocked.
    await message(page).fill("and now?");
    await message(page).press("Enter");
    await expect.poll(() => raw.provider.requests.length).toBe(2);
  });
});
