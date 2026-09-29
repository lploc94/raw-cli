import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  await page.getByRole("button", { name: "Open this folder" }).click();
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

const dialog = (page: Page) => page.getByRole("dialog", { name: "Open folder" });
const pathField = (page: Page) => dialog(page).getByLabel("Workspace directory");
const entries = (page: Page) => dialog(page).locator(".folder-entry");
async function openFolder(page: Page, raw: Raw) {
  await open(page, raw);
  await popover(page).getByRole("button", { name: "Open folder…" }).click();
  await expect(dialog(page)).toBeVisible();
}
async function go(page: Page, path: string) {
  await pathField(page).fill(path);
  await pathField(page).press("Enter");
  await expect(pathField(page)).toHaveValue(path);
  await expect(dialog(page).locator(".folder-list")).toHaveAttribute("aria-busy", "false");
}

test.describe("folder browser", () => {
  test("it starts at the current workspace and navigates folders, Up, typed paths and the filter", async ({ page, raw }) => {
    const base = folder("browse");
    for (const name of ["beta", "Alpha", "sub"]) mkdirSync(join(base, name));
    mkdirSync(join(base, "sub", "inner")); writeFileSync(join(base, "notes.txt"), "x");
    await openFolder(page, raw);
    await expect(pathField(page)).toHaveValue(realpathSync(raw.root));
    await expect(dialog(page).getByRole("button", { name: "Parent folder" })).toBeEnabled();
    await go(page, base);
    await expect(entries(page)).toHaveText([/Alpha/, /beta/, /sub/]);
    await expect(dialog(page)).not.toContainText("notes.txt");
    await entries(page).filter({ hasText: "sub" }).click();
    await expect(pathField(page)).toHaveValue(join(base, "sub"));
    await expect(entries(page)).toHaveText([/inner/]);
    await dialog(page).getByRole("button", { name: "Parent folder" }).click();
    await expect(pathField(page)).toHaveValue(base);
    await dialog(page).getByLabel("Filter folders").fill("AL");
    await expect(entries(page)).toHaveText([/Alpha/]);
    await go(page, "/");
    await expect(dialog(page).getByRole("button", { name: "Parent folder" })).toBeDisabled();
  });

  test("hidden folders appear only with the toggle, which resets each time the dialog opens; links are marked", async ({ page, raw }) => {
    const base = folder("hidden");
    mkdirSync(join(base, ".secret")); mkdirSync(join(base, "real")); symlinkSync(join(base, "real"), join(base, "shortcut"));
    await openFolder(page, raw);
    await go(page, base);
    await expect(entries(page)).toHaveText([/real/, /shortcut/]);
    await expect(entries(page).filter({ hasText: "shortcut" }).getByText("symbolic link")).toBeAttached();
    await dialog(page).getByLabel("Show hidden folders").check();
    await expect(entries(page).filter({ hasText: ".secret" })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await popover(page).getByRole("button", { name: "Open folder…" }).click();
    await expect(dialog(page).getByLabel("Show hidden folders")).not.toBeChecked();
  });

  test("a folder with only files says so and shows no file names; errors stay inline and the dialog keeps working", async ({ page, raw }) => {
    const base = folder("errors"); const filesOnly = join(base, "files");
    mkdirSync(filesOnly); writeFileSync(join(filesOnly, "readme-secret.md"), "x"); mkdirSync(join(base, "kept"));
    await openFolder(page, raw);
    await go(page, base);
    await go(page, filesOnly);
    await expect(dialog(page).getByText("No subfolders")).toBeVisible();
    await expect(dialog(page)).not.toContainText("readme-secret");
    await go(page, base);
    await pathField(page).fill(join(base, "missing")); await pathField(page).press("Enter");
    await expect(dialog(page).getByRole("alert")).toContainText("existing directory");
    await expect(entries(page)).toHaveText([/files/, /kept/]);
    await dialog(page).getByRole("button", { name: "Parent folder" }).click();
    await expect(pathField(page)).toHaveValue(realpathSync(join(base, "..")));
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = join(base, "locked"); mkdirSync(locked); chmodSync(locked, 0);
      try {
        await pathField(page).fill(locked); await pathField(page).press("Enter");
        await expect(dialog(page).getByRole("alert")).toContainText("cannot be read");
        await expect(dialog(page).getByRole("button", { name: "Parent folder" })).toBeEnabled();
      } finally { chmodSync(locked, 0o755); }
    }
  });

  test("Open this folder switches the workspace, and the folder stays in Recent without a chat until removed", async ({ page, raw }) => {
    const base = folder("target"); const child = join(base, "project"); mkdirSync(child);
    await openFolder(page, raw);
    await go(page, base);
    await entries(page).filter({ hasText: "project" }).click();
    await expect(pathField(page)).toHaveValue(child);
    await dialog(page).getByRole("button", { name: "Open this folder" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toHaveAttribute("title", child);
    await page.reload();
    await trigger(page).click();
    await expect(row(page, child)).toContainText("0 chats");
    await row(page, child).getByRole("button", { name: /^More actions/ }).click();
    await page.getByRole("menuitem", { name: "Remove from recent" }).click();
    await expect(row(page, child)).toHaveCount(0);
  });

  test("a folder removed before Open fails inline and keeps the dialog open", async ({ page, raw }) => {
    const base = folder("vanish"); const child = join(base, "soon-gone"); mkdirSync(child);
    await openFolder(page, raw);
    await go(page, child);
    rmSync(child, { recursive: true });
    await dialog(page).getByRole("button", { name: "Open this folder" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("existing directory");
    await expect(dialog(page)).toBeVisible();
    await expect(trigger(page)).not.toHaveAttribute("title", child);
  });

  test("typing a valid path and pressing Open works even when browsing fails", async ({ page, raw }) => {
    const base = folder("offline");
    await page.route("**/api/workspaces/browse**", (route) => route.abort());
    await openFolder(page, raw);
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    await pathField(page).fill(base);
    await dialog(page).getByRole("button", { name: "Open this folder" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toHaveAttribute("title", base);
  });

  test("a slow earlier listing never overwrites a newer one", async ({ page, raw }) => {
    const slow = folder("slow"); const quick = folder("quick");
    mkdirSync(join(slow, "from-slow")); mkdirSync(join(quick, "from-quick"));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    await openFolder(page, raw);
    await page.route("**/api/workspaces/browse**", async (route) => {
      if (decodeURIComponent(route.request().url()).includes(`path=${slow}`)) await gate;
      await route.continue();
    });
    await pathField(page).fill(slow); await pathField(page).press("Enter");
    await pathField(page).fill(quick); await pathField(page).press("Enter");
    await expect(entries(page)).toHaveText([/from-quick/]);
    release();
    await page.waitForTimeout(300);
    await expect(entries(page)).toHaveText([/from-quick/]);
    await expect(pathField(page)).toHaveValue(quick);
  });

  test("changing the filter or the hidden toggle keeps the path being typed", async ({ page, raw }) => {
    const base = folder("typing"); mkdirSync(join(base, ".dot"));
    await openFolder(page, raw);
    await pathField(page).fill(`${base}/half-typed`);
    await dialog(page).getByLabel("Show hidden folders").check();
    await dialog(page).getByLabel("Filter folders").fill("x");
    await page.waitForTimeout(400);
    await expect(pathField(page)).toHaveValue(`${base}/half-typed`);
  });

  test("a failed first listing falls back to home without replacing a path typed meanwhile", async ({ page, raw }) => {
    const typed = folder("typed-during-fallback");
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/workspaces/browse**", async (route) => {
      if (route.request().url().includes("path=")) {
        await gate;
        await route.fulfill({ status: 400, json: { error: { code: "invalid_workspace", message: "Choose an existing directory" } } });
      } else await route.continue();
    });
    await open(page, raw);
    await popover(page).getByRole("button", { name: "Open folder…" }).click();
    await expect(dialog(page)).toBeVisible();
    await pathField(page).fill(typed);
    release();
    await expect(dialog(page).locator(".folder-list")).toHaveAttribute("aria-busy", "false");
    await expect(entries(page).first()).toBeVisible();
    await expect(pathField(page)).toHaveValue(typed);
  });

  test("changing the filter or the toggle before the first listing arrives still lists the starting folder", async ({ page, raw }) => {
    const start = realpathSync(raw.root);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    await page.route("**/api/workspaces/browse**", async (route) => {
      seen.push(decodeURIComponent(route.request().url()));
      if (seen.length === 1) await gate;
      await route.continue();
    });
    await open(page, raw);
    await popover(page).getByRole("button", { name: "Open folder…" }).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByLabel("Show hidden folders").check();
    await expect.poll(() => seen.length).toBeGreaterThan(1);
    expect(seen[1]).toContain(`path=${start}`);
    release();
    await expect(dialog(page).locator(".folder-list")).toHaveAttribute("aria-busy", "false");
    await expect(pathField(page)).toHaveValue(start);
  });

  test("changing the filter or the toggle while a navigation loads keeps navigating to the new folder", async ({ page, raw }) => {
    const base = folder("nav"); const target = join(base, "target"); mkdirSync(target); mkdirSync(join(target, "deep"));
    await openFolder(page, raw);
    await go(page, base);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/workspaces/browse**", async (route) => {
      if (decodeURIComponent(route.request().url()).includes(`path=${target}`) && !route.request().url().includes("q=")) await gate;
      await route.continue();
    });
    await entries(page).filter({ hasText: "target" }).click();
    await dialog(page).getByLabel("Show hidden folders").check();
    release();
    await expect(dialog(page).locator(".folder-list")).toHaveAttribute("aria-busy", "false");
    await expect(pathField(page)).toHaveValue(target);
    await expect(entries(page)).toHaveText([/deep/]);
  });

  test("after a failed Go, the filter and the toggle still refresh the listing that is on screen", async ({ page, raw }) => {
    const base = folder("failed-go");
    for (const name of ["alpha", "beta", ".dot"]) mkdirSync(join(base, name));
    await openFolder(page, raw);
    await go(page, base);
    await pathField(page).fill(join(base, "missing")); await pathField(page).press("Enter");
    await expect(dialog(page).getByRole("alert")).toContainText("existing directory");
    await dialog(page).getByLabel("Filter folders").fill("al");
    await expect(entries(page)).toHaveText([/alpha/]);
    await expect(dialog(page).getByRole("alert")).toHaveCount(0);
    await dialog(page).getByLabel("Filter folders").fill("");
    await dialog(page).getByLabel("Show hidden folders").check();
    await expect(entries(page)).toHaveText([/\.dot/, /alpha/, /beta/]);
    await expect(pathField(page)).toHaveValue(join(base, "missing"));
    await dialog(page).getByRole("button", { name: "Parent folder" }).click();
    await expect(pathField(page)).toHaveValue(realpathSync(join(base, "..")));
  });

  test("a pending Open cannot switch the workspace after the dialog was closed", async ({ page, raw }) => {
    const slow = folder("pending");
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/workspaces/validate", async (route) => {
      if ((route.request().postDataJSON() as { cwd: string }).cwd === slow) await gate;
      await route.continue();
    });
    await openFolder(page, raw);
    const before = await trigger(page).getAttribute("title");
    await pathField(page).fill(slow);
    await dialog(page).getByRole("button", { name: "Open this folder" }).click();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    release();
    await page.waitForTimeout(300);
    await expect(trigger(page)).toHaveAttribute("title", before!);
  });

  test("the dialog has no accessibility violations", async ({ page, raw }) => {
    const base = folder("axe"); mkdirSync(join(base, "one")); symlinkSync(join(base, "one"), join(base, "two"));
    await openFolder(page, raw);
    await go(page, base);
    await expect(entries(page)).toHaveCount(2);
    const result = await new AxeBuilder({ page }).include("[role=dialog]").analyze();
    expect(result.violations).toEqual([]);
  });

  test.describe("narrow viewport", () => {
    test.use({ viewport: { width: 390, height: 800 } });
    test("it works from the navigation drawer without horizontal overflow", async ({ page, raw }) => {
      const base = folder("narrow"); mkdirSync(join(base, "child"));
      await page.goto(raw.server.launchUrl);
      await page.getByRole("button", { name: "Workspace menu" }).click();
      await trigger(page).click();
      await popover(page).getByRole("button", { name: "Open folder…" }).click();
      await expect(dialog(page)).toBeVisible();
      await go(page, base);
      await expect(entries(page)).toHaveText([/child/]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog(page).getByRole("button", { name: "Open this folder" }).click();
      await expect(dialog(page)).toBeHidden();
      await page.getByRole("button", { name: "Workspace menu" }).click();
      await expect(trigger(page)).toHaveAttribute("title", base);
    });
  });
});
