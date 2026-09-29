import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, expect } from "./fixtures.js";

type Raw = Parameters<Parameters<typeof test>[2]>[0]["raw"];
const trigger = (page: Page) => page.locator(".workspace-button:visible");
const popover = (page: Page) => page.locator(".workspace-popover");
const row = (page: Page, dir: string) => popover(page).locator(".workspace-row", { hasText: basename(dir) });
const storedState = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("raw.dashboard.workspaces.v1") ?? "null"));

const made: string[] = [];
test.afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function folder(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `raw-ui-${name}-`)));
  made.push(dir);
  return dir;
}
async function seed(raw: Raw, dir: string, chats: number) {
  const ids: string[] = [];
  for (let index = 0; index < chats; index++) ids.push((await raw.json<{ id: string }>("/sessions", "POST", { cwd: dir })).id);
  return ids;
}
async function open(page: Page, raw: Raw) {
  await page.goto(raw.server.launchUrl);
  await expect(trigger(page)).toBeVisible();
  await trigger(page).click();
  await expect(popover(page)).toBeVisible();
}

test("the switcher lists Current, Pinned and Recent with counts, and choosing a row switches the workspace", async ({ page, raw }) => {
  const a = folder("alpha"); const b = folder("beta");
  await seed(raw, a, 2); await seed(raw, b, 1);
  await open(page, raw);
  await expect(popover(page).getByRole("heading")).toHaveText(["Current", "Recent"]);
  await expect(row(page, a)).toContainText("2 chats");
  await expect(row(page, b)).toContainText("1 chat");
  await expect(row(page, b)).not.toContainText("1 chats");
  await expect(row(page, a).getByRole("button").first()).toHaveAttribute("title", a);
  await expect(popover(page).locator("[aria-current='true']")).toHaveCount(1);
  await row(page, a).getByRole("button").first().click();
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("title", a);
  await expect(trigger(page)).toBeFocused();
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.locator(".workspace-path")).toHaveAttribute("title", a);
  await trigger(page).click();
  await expect(row(page, a).locator("[aria-current='true']")).toHaveCount(1);
  await row(page, a).getByRole("button").first().click();
  await expect(popover(page)).toBeHidden();
  await expect(page.locator(".workspace-path")).toHaveAttribute("title", a);
});

test("filtering and keyboard navigation work and Escape returns focus to the button", async ({ page, raw }) => {
  const a = folder("alpha"); const b = folder("beta");
  await seed(raw, a, 1); await seed(raw, b, 1);
  await open(page, raw);
  await expect(page.getByRole("searchbox", { name: "Filter workspaces" })).toBeFocused();
  await page.keyboard.type(basename(b));
  await expect(popover(page).locator(".workspace-row")).toHaveCount(1);
  await expect(row(page, b)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(trigger(page)).toHaveAttribute("title", b);
  await trigger(page).click();
  await page.keyboard.type("zzzz-nothing");
  await expect(popover(page).getByText("No matching workspaces")).toBeVisible();
  await page.getByRole("searchbox", { name: "Filter workspaces" }).fill("");
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).locator("[data-row-main]").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).locator("[data-row-main]").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("searchbox", { name: "Filter workspaces" })).toBeFocused();
  const stops = await popover(page).locator("[data-row-main]").count();
  for (let index = 0; index < stops; index++) await page.keyboard.press("ArrowDown");
  await expect(popover(page).getByRole("button", { name: "Open folder…" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("pins and removals survive a reload, removal deletes nothing, and copy path works", async ({ page, raw, context, browserName }) => {
  const a = folder("alpha"); const b = folder("beta");
  const [aChat] = await seed(raw, a, 1); await seed(raw, b, 1);
  await open(page, raw);
  await row(page, a).getByRole("button", { name: /^Pin / }).click();
  await expect(popover(page).getByRole("heading")).toHaveText(["Current", "Pinned", "Recent"]);
  await expect(row(page, a).getByRole("button", { name: /^Unpin / })).toHaveAttribute("aria-pressed", "true");
  await row(page, b).getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: "Remove from recent" }).click();
  await expect(row(page, b)).toHaveCount(0);
  await page.reload();
  await trigger(page).click();
  await expect(popover(page).getByRole("heading")).toHaveText(["Current", "Pinned"]);
  await expect(row(page, a)).toBeVisible();
  await expect(row(page, b)).toHaveCount(0);
  expect(await storedState(page)).toMatchObject({ version: 1, pinned: [a], hidden: [b] });
  expect((await raw.json<{ session: { id: string } }>(`/sessions/${(await raw.json<{ items: Array<{ id: string }> }>(`/sessions?cwd=${encodeURIComponent(b)}`)).items[0]!.id}`)).session.id).toBeTruthy();
  expect((await raw.json<{ session: { id: string } }>(`/sessions/${aChat}`)).session.id).toBe(aChat);
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await row(page, a).getByRole("button", { name: /^More actions/ }).click();
    await page.getByRole("menuitem", { name: "Copy path" }).click();
    await expect(popover(page).getByRole("status")).toContainText(`Copied ${a}`);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(a);
  }
  await row(page, a).getByRole("button", { name: /^Unpin / }).click();
  await expect(popover(page).getByRole("heading")).toHaveText(["Current", "Recent"]);
  await expect(row(page, b)).toHaveCount(0);
});

test("a folder chosen with no chats stays in Recent after a reload", async ({ page, raw }) => {
  const empty = folder("empty"); const other = folder("other");
  await seed(raw, other, 1);
  await page.addInitScript((path) => {
    if (!localStorage.getItem("raw.dashboard.workspaces.v1")) localStorage.setItem("raw.dashboard.workspaces.v1", JSON.stringify({ version: 1, pinned: [], hidden: [], opened: [{ path, at: Date.now() }] }));
  }, empty);
  await open(page, raw);
  await expect(row(page, empty)).toContainText("0 chats");
  await expect(popover(page).locator(".workspace-row").nth(1)).toContainText(basename(empty));
  await row(page, other).getByRole("button").first().click();
  await expect(trigger(page)).toHaveAttribute("title", other);
  await page.reload();
  await trigger(page).click();
  await expect(row(page, empty)).toBeVisible();
  expect((await storedState(page)).opened.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([empty, other]));
});

test("a deleted folder is Missing and cannot be chosen but can be removed; one deleted after loading fails on click", async ({ page, raw }) => {
  const gone = folder("gone"); const stale = folder("stale"); const fine = folder("fine");
  await seed(raw, gone, 1); await seed(raw, stale, 1); await seed(raw, fine, 1);
  rmSync(gone, { recursive: true });
  await open(page, raw);
  await expect(row(page, gone)).toContainText("Missing");
  await expect(row(page, gone)).toContainText("Folder not found");
  await expect(row(page, gone).locator("[data-row-main]")).toHaveAttribute("aria-disabled", "true");
  await row(page, gone).locator("[data-row-main]").click({ force: true });
  await expect(popover(page)).toBeVisible();
  await expect(trigger(page)).not.toHaveAttribute("title", gone);
  await expect(row(page, fine)).not.toContainText("Missing");
  rmSync(stale, { recursive: true });
  await row(page, stale).locator("[data-row-main]").click();
  await expect(popover(page)).toBeVisible();
  await expect(row(page, stale)).toContainText("Missing");
  await expect(popover(page).getByRole("status")).toContainText("was not found");
  await expect(trigger(page)).not.toHaveAttribute("title", stale);
  await row(page, gone).getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: "Remove from recent" }).click();
  await expect(row(page, gone)).toHaveCount(0);
  await row(page, fine).locator("[data-row-main]").click();
  await expect(trigger(page)).toHaveAttribute("title", fine);
});

test.describe("a running chat", () => {
  test.use({ scenario: { responses: [{ hold: true }] } });
  test("shows a Running badge on its workspace", async ({ page, raw }) => {
    const a = folder("busy"); const b = folder("idle");
    const [chat] = await seed(raw, a, 1); await seed(raw, b, 1);
    const operation = await raw.json<{ id: string }>(`/sessions/${chat}/operations`, "POST", { clientRequestId: "run", kind: "turn", agent: "raw", input: "hold" });
    await open(page, raw);
    await expect(row(page, a)).toContainText("Running");
    await expect(row(page, b)).not.toContainText("Running");
    await raw.json(`/operations/${operation.id}/cancel`, "POST", {});
    await raw.wait(operation.id);
    await expect(row(page, a)).not.toContainText("Running");
  });
});

test("a failed list request shows an inline error and Open folder stays usable; corrupt storage is ignored", async ({ page, raw }) => {
  await page.addInitScript(() => localStorage.setItem("raw.dashboard.workspaces.v1", "{not json"));
  await page.route("**/api/workspaces?**", (route) => route.abort());
  await page.route("**/api/workspaces", (route) => route.abort());
  await open(page, raw);
  await expect(popover(page).getByRole("alert")).toContainText("Could not load workspaces");
  await expect(popover(page).locator(".workspace-row")).toHaveCount(1);
  await popover(page).getByRole("button", { name: "Open folder…" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Workspace directory")).toHaveValue(realpathSync(raw.root));
});

test("a slow selection cannot override a later choice made in the Open folder dialog", async ({ page, raw }) => {
  const slow = folder("slow"); const later = folder("later");
  await seed(raw, slow, 1); await seed(raw, later, 1);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/workspaces/validate", async (route) => {
    if ((route.request().postDataJSON() as { cwd: string }).cwd === slow) await gate;
    await route.continue();
  });
  await open(page, raw);
  await row(page, slow).locator("[data-row-main]").click();
  await popover(page).getByRole("button", { name: "Open folder…" }).click();
  await page.getByLabel("Workspace directory").fill(later);
  await page.getByRole("button", { name: "Use workspace" }).click();
  await expect(trigger(page)).toHaveAttribute("title", later);
  release();
  await page.waitForTimeout(300);
  await expect(trigger(page)).toHaveAttribute("title", later);
});

test("after a failed refresh the previous rows are not shown as if they were current, and a pinned row can still be removed", async ({ page, raw }) => {
  const a = folder("alpha"); const b = folder("beta");
  await seed(raw, a, 1); await seed(raw, b, 1);
  await open(page, raw);
  await expect(row(page, b)).toBeVisible();
  await row(page, b).getByRole("button", { name: /^Pin / }).click();
  await row(page, b).getByRole("button", { name: /^More actions/ }).click();
  await expect(page.getByRole("menuitem", { name: "Remove from recent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await page.route("**/api/workspaces?**", (route) => route.abort());
  await page.route("**/api/workspaces", (route) => route.abort());
  await trigger(page).click();
  await expect(popover(page).getByRole("alert")).toContainText("Could not load workspaces");
  await expect(row(page, a)).toHaveCount(0);
  await expect(row(page, b)).toContainText("0 chats");
});

test("Copy path reports an unavailable clipboard instead of failing", async ({ page, raw }) => {
  const a = folder("alpha");
  await seed(raw, a, 1);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await open(page, raw);
  await row(page, a).getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: "Copy path" }).click();
  await expect(popover(page).getByRole("status")).toContainText("Copy unavailable");
});

test("two folders with the same name stay distinguishable by path", async ({ page, raw }) => {
  const parent1 = folder("one"); const parent2 = folder("two");
  const a = join(parent1, "app"); const b = join(parent2, "app");
  mkdirSync(a); mkdirSync(b);
  await seed(raw, a, 1); await seed(raw, b, 1);
  await open(page, raw);
  await expect(popover(page).locator(".workspace-row-main", { hasText: "app" })).toHaveCount(2);
  await expect(popover(page).locator(".workspace-row-main[title='" + a + "']")).toBeVisible();
  await expect(popover(page).locator(".workspace-row-main[title='" + b + "']")).toBeVisible();
});

test("the open switcher has no accessibility violations", async ({ page, raw }) => {
  const a = folder("alpha"); rmSync(folder("gone"), { recursive: true });
  await seed(raw, a, 1);
  await open(page, raw);
  await row(page, a).getByRole("button", { name: /^Pin / }).click();
  const result = await new AxeBuilder({ page }).include(".workspace-popover").analyze();
  expect(result.violations).toEqual([]);
});

test.describe("narrow viewport", () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test("the switcher works inside the navigation drawer", async ({ page, raw }) => {
    const a = folder("alpha");
    await seed(raw, a, 1);
    await page.goto(raw.server.launchUrl);
    await page.getByRole("button", { name: "Workspace menu" }).click();
    await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
    await trigger(page).click();
    await expect(popover(page)).toBeVisible();
    await row(page, a).locator("[data-row-main]").click();
    await expect(popover(page)).toBeHidden();
    await page.getByRole("button", { name: "Workspace menu" }).click();
    await expect(trigger(page)).toHaveAttribute("title", a);
  });
});
