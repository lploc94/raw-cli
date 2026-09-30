import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
const call = (id: string, name: string, args: unknown) => ({ frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone] });
const section = (page: import("@playwright/test").Page) => page.locator('[data-panel="builtin/write_file#files_changed"]');
async function send(page: import("@playwright/test").Page, text: string, count: number) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("assistant-message")).toHaveCount(count);
}
async function show(page: import("@playwright/test").Page) {
  if (!await page.locator(".inspector").count()) await page.getByRole("button", { name: "Side panel", exact: true }).click();
  if (await section(page).locator(".panel-toggle").getAttribute("aria-expanded") !== "true") await section(page).locator(".panel-toggle").click();
}
test.describe("Files changed accumulated successes", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/write_file", "builtin/bash"] } }, responses: [
    call("patch", "write_file", { patch: "*** Begin Patch\n*** Add File: alpha.txt\n+hello\n*** Add File: beta.txt\n+world\n*** End Patch" }), answer,
    call("operations", "write_file", { operations: [
      { path: "alpha.txt", mode: "overwrite", content: "updated alpha\n" },
      { path: "failed.txt", mode: "replace_text", old_text: "missing", new_text: "replacement" },
      { path: "gamma.txt", mode: "overwrite", content: "gamma success\n" },
    ] }), answer,
    call("bash", "bash", { commands: [{ command: "printf untracked > shell-only.txt" }] }), answer,
  ] } });
  test("patch and legacy writes accumulate only successful paths, preserve diffs on reload and exclude shell changes", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "patch files", 1);
    await show(page);
    await expect(section(page).locator(".panel-files li")).toHaveCount(2);
    await expect(section(page)).toContainText("Successful tool writes in this session; not Git status or Bash edits.");
    await expect(section(page).locator(".panel-files")).toContainText("alpha.txt");
    await expect(section(page).locator(".panel-files")).toContainText("beta.txt");
    expect(readFileSync(join(raw.root, "alpha.txt"), "utf8")).toBe("hello\n");
    await send(page, "some writes succeed", 2);
    await expect(section(page).locator(".panel-files li")).toHaveCount(3);
    await expect(section(page).locator(".panel-files")).not.toContainText("failed.txt");
    await expect(section(page).locator(".panel-markdown")).toContainText("gamma success");
    expect(existsSync(join(raw.root, "failed.txt"))).toBe(false);
    await send(page, "shell change", 3);
    await expect(section(page).locator(".panel-files")).not.toContainText("shell-only.txt");
    expect(existsSync(join(raw.root, "shell-only.txt"))).toBe(true);
    await page.reload();
    await show(page);
    await expect(section(page).locator(".panel-files li")).toHaveCount(3);
    await expect(section(page).locator(".panel-markdown")).toContainText("gamma success");
    await section(page).locator(".panel-files button").filter({ hasText: /gamma\.txt$/ }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(/@.*gamma\.txt/);
  });
});
test.describe("Files changed preflight", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/write_file"] } }, responses: [
    call("conflict", "write_file", { patch: "*** Begin Patch\n*** Add File: alpha.txt\n+new\n*** Update File: beta.txt\n@@\n-wrong context\n+changed\n*** End Patch" }), answer,
  ] } });
  test("a later patch conflict publishes no successful file claims", async ({ page, raw }) => {
    writeFileSync(join(raw.root, "beta.txt"), "original\n");
    await openChat(page, raw);
    await send(page, "conflicting patch", 1);
    await show(page);
    await expect(section(page).locator(".panel-files li")).toHaveCount(0);
    expect(existsSync(join(raw.root, "alpha.txt"))).toBe(false);
    expect(readFileSync(join(raw.root, "beta.txt"), "utf8")).toBe("original\n");
  });
});
test.describe("Files changed bounded diff", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/write_file"] } }, responses: [
    call("large", "write_file", { operations: [{ path: "large.txt", mode: "overwrite", content: "retained content\n".repeat(600) }] }), answer,
  ] } });
  test("oversized diff visibly reports truncation", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "large write", 1);
    await show(page);
    await expect(section(page).locator(".panel-files")).toContainText("large.txt");
    await expect(section(page).locator(".panel-markdown")).toContainText("[diff truncated]");
  });
});
