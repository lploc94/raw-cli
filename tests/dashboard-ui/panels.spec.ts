import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat, answer } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

const call = (id: string, name: string, args: unknown) => ({
  frames: [openAiFrame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls"), openAiDone],
});
const todos = (count: number) => ({ title: "Ship", todos: Array.from({ length: count }, (_, index) => ({ content: `Step ${index + 1}`, status: index === 0 ? "in_progress" : "pending" })) });
const KEY = "raw.dashboard.panels.v1";
const stack = (page: Page) => page.locator(".panel-stack");
const section = (page: Page, panel: string) => page.locator(`[data-panel="${panel}"]`);
const toggle = (page: Page, title: string) => page.locator(".panel-toggle", { has: page.locator(".panel-title", { hasText: new RegExp(`^${title}$`) }) });
const side = (page: Page) => page.getByRole("button", { name: "Side panel", exact: true });
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
/** A local plugin whose panels are declared in tool.json; `publish` (a JS expression body) runs inside the handler. */
function plugin(raw: { env: NodeJS.ProcessEnv }, folder: string, panels: object[], publish = "") {
  const dir = join(raw.env.XDG_CONFIG_HOME!, "raw", "tools", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tool.json"), JSON.stringify({ api_version: 1, id: folder, version: "1.0.0", name: folder, description: `Tool ${folder}.`,
    input_schema: { type: "object", additionalProperties: false }, entry: "./index.mjs", panels }));
  writeFileSync(join(dir, "index.mjs"), `export async function handler(args, context) { ${publish} return { content: [{ type: "text", text: "ok" }] }; }`);
}
const decl = (id: string, title: string, extra: object = {}) => ({ id, title, icon: "list-checks", open: "never", ...extra });

test.describe("todo panel", () => {
  test.use({
    scenario: {
      agent: { tools: { use: ["builtin/todo"] } },
      responses: [call("c1", "todo", todos(3)), answer, call("c2", "todo", todos(60)), answer],
    },
  });

  test("the side panel starts closed, lists the declared section before any data and follows the accordion pattern", async ({ page, raw }) => {
    await openChat(page, raw);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await side(page).click();
    await expect(page.getByRole("heading", { name: "Side panel", exact: true })).toBeVisible();
    const todo = toggle(page, "Todo");
    await expect(todo).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("No data yet").first()).toBeVisible();
    await expect(toggle(page, "Details")).toHaveAttribute("aria-expanded", "false");
    await todo.focus();
    await page.keyboard.press("Enter");
    await expect(todo).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Space");
    await expect(todo).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    // The expand state is stored per session and survives a reload.
    await page.reload();
    await side(page).click();
    await expect(toggle(page, "Todo")).toHaveAttribute("aria-expanded", "true");
  });

  test("the first update opens the side panel once, expands the section without moving focus, and later updates never move or resize it", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(toggle(page, "Todo")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest(".inspector"))).toBe(false);
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    const target = section(page, "builtin/todo#todo");
    const before = await target.boundingBox();
    const bodyBefore = await target.locator(".panel-body").boundingBox();
    expect(before && bodyBefore).toBeTruthy();
    await send(page, "more");
    await expect(page.getByText("Step 60", { exact: true })).toBeAttached();
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    const after = await target.boundingBox();
    const bodyAfter = await target.locator(".panel-body").boundingBox();
    expect(after).toEqual(before);
    expect(bodyAfter).toEqual(bodyBefore);
    await expect(toggle(page, "Todo")).toHaveAttribute("aria-expanded", "true");
    await expect(stack(page).locator("[role=status]")).toHaveText("Todo: 0 of 60 done");
    await expect(section(page, "builtin/todo#todo").locator(".panel-progress-line")).toHaveCount(1);
    expect(await target.locator(".panel-body").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  });

  test("Never keeps the side panel closed and the unseen dot marks the update", async ({ page, raw }) => {
    await page.addInitScript(() => localStorage.setItem("raw.dashboard.preferences.v1", JSON.stringify({ version: 1, panelOpen: "never" })));
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.locator(".inspector")).toHaveCount(0);
    await side(page).click();
    await expect(section(page, "builtin/todo#todo").locator(".panel-unseen")).toBeVisible();
    await toggle(page, "Todo").click();
    await expect(section(page, "builtin/todo#todo").locator(".panel-unseen")).toHaveCount(0);
    await expect(page.getByText("Step 1", { exact: true })).toBeVisible();
  });

  test("a narrow viewport never opens the drawer by itself", async ({ page, raw }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "Side panel" })).toHaveCount(0);
    await side(page).click();
    await expect(page.getByRole("dialog", { name: "Side panel" })).toBeVisible();
    await expect(toggle(page, "Todo")).toBeVisible();
  });

  test("a receipt row opens, unhides and expands its section and a hidden section stays hidden on update", async ({ page, raw }) => {
    await page.addInitScript(([key]) => {
      if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, hidden: { raw: ["builtin/todo#todo"] } }));
    }, [KEY]);
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    // A hidden section never opens the side panel by itself.
    await expect(page.locator(".inspector")).toHaveCount(0);
    await page.getByText("Work", { exact: true }).click();
    const receipt = page.locator(".panel-receipt");
    await expect(receipt).toHaveCount(1);
    await expect(receipt).toContainText("Ship");
    await receipt.click();
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(toggle(page, "Todo")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/hidden section/)).toHaveCount(0);
  });

  test("Hide, Move up and Move down live in the section menu and the hidden row shows the section again", async ({ page, raw }) => {
    await openChat(page, raw);
    await side(page).click();
    await page.getByRole("button", { name: "Todo section menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Hide section" }).click();
    await expect(toggle(page, "Todo")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "1 hidden section" })).toBeVisible();
    await page.reload();
    await side(page).click();
    await page.getByRole("button", { name: "1 hidden section" }).click();
    await page.getByRole("button", { name: "Show Todo" }).click();
    await expect(toggle(page, "Todo")).toBeVisible();
  });

  test("the divider resizes from the keyboard, is remembered per agent and applies to every section", async ({ page, raw }) => {
    await openChat(page, raw);
    await side(page).click();
    await toggle(page, "Todo").click();
    const body = section(page, "builtin/todo#todo");
    const start = (await body.boundingBox())!.height;
    const separator = page.getByRole("separator", { name: "Section height" }).first();
    await separator.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await body.boundingBox())!.height).toBe(start + 48);
    await page.reload();
    await side(page).click();
    await expect.poll(async () => (await section(page, "builtin/todo#todo").boundingBox())!.height).toBe(start + 48);
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), KEY);
    expect(stored.heights.raw).toBe(start + 48);
  });

  test("the side panel passes axe in light and dark", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "plan it");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.getByText("Step 3", { exact: true })).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await toggle(page, "Details").click();
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
      await toggle(page, "Details").click();
    }
  });
});

test.describe("panel ordering", () => {
  test.use({
    scenario: { agent: { tools: { use: ["local/a", "local/b", "local/c", "local/d"] } }, responses: [answer] },
  });
  const seed = (raw: { env: NodeJS.ProcessEnv }) => {
    for (const name of ["a", "b", "c", "d"]) plugin(raw, name, [decl("p", name.toUpperCase())]);
  };
  const titles = (page: Page) => stack(page).locator(".panel-title").allTextContents();

  test("new panels are inserted after their nearest present predecessor, not appended and not default-sorted", async ({ page, raw }) => {
    seed(raw);
    // The user's order has D and B only, reversed from the defaults; A and C are new to the stack.
    await page.addInitScript(([key]) => {
      if (!localStorage.getItem(key!)) localStorage.setItem(key!, JSON.stringify({ version: 1, order: { raw: ["local/d#p", "local/b#p"] } }));
    }, [KEY]);
    await openChat(page, raw);
    await side(page).click();
    await expect(toggle(page, "A")).toBeVisible();
    expect(await titles(page)).toEqual(["A", "D", "B", "C", "Details"]);
  });

  test("dragging a header reorders the stack and persists, while a plain click still toggles", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await side(page).click();
    const header = (name: string) => toggle(page, name);
    await header("A").click();
    await expect(header("A")).toHaveAttribute("aria-expanded", "true");
    await header("A").click();
    const from = (await header("A").boundingBox())!;
    const to = (await header("C").boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + from.height / 2 + 20, { steps: 4 });
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await titles(page)).toEqual(["B", "C", "A", "D", "Details"]);
    await expect(header("A")).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await side(page).click();
    expect(await titles(page)).toEqual(["B", "C", "A", "D", "Details"]);
  });

  test("a fast drag whose first movement already leaves the source header still reorders", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await side(page).click();
    const from = (await toggle(page, "A").boundingBox())!;
    const to = (await toggle(page, "C").boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 60, to.y + to.height / 2);
    await page.mouse.up();
    expect(await titles(page)).toEqual(["B", "C", "A", "D", "Details"]);
  });

  test("Move up and Move down reorder by the keyboard and persist per agent", async ({ page, raw }) => {
    seed(raw);
    await openChat(page, raw);
    await side(page).click();
    expect(await titles(page)).toEqual(["A", "B", "C", "D", "Details"]);
    await page.getByRole("button", { name: "C section menu" }).click();
    await page.getByRole("menuitem", { name: "Move up" }).press("Enter");
    expect(await titles(page)).toEqual(["A", "C", "B", "D", "Details"]);
    await page.getByRole("button", { name: "A section menu" }).click();
    await page.getByRole("menuitem", { name: "Move down" }).press("Enter");
    expect(await titles(page)).toEqual(["C", "A", "B", "D", "Details"]);
    await page.reload();
    await side(page).click();
    expect(await titles(page)).toEqual(["C", "A", "B", "D", "Details"]);
    await expect(page.getByRole("button", { name: "Details section menu" })).toHaveCount(0);
  });
});

test.describe("panel widgets", () => {
  test.use({ scenario: { agent: { tools: { use: ["local/gadget"], rules: [{ match: "local/gadget", effect: "allow" }] } }, responses: [call("g1", "gadget", {}), answer] } });
  const gadgetDocument = {
    title: "Gadget run", subtitle: "All widgets", status: "active", summary: "Halfway", progress: { done: 1, total: 2 },
    blocks: [
      { id: "cl", kind: "checklist", title: "Checklist", items: [{ id: "i1", label: "Parent", status: "done", children: [{ id: "i2", label: "Child", status: "in_progress", note: "a note" }] }, { id: "i3", label: "Failing", status: "failed", ref: { path: "src/a.ts", line: 3 } }, { id: "i4", label: "Finished chore", status: "done" }] },
      { id: "st", kind: "steps", title: "Steps", items: [{ id: "s1", label: "First", status: "done", started_at: 1759140000000, ended_at: 1759140600000 }, { id: "s2", label: "Second", status: "in_progress", detail: "working" }] },
      { id: "pr", kind: "progress", title: "Progress", label: "Build", value: 3, max: 10 },
      { id: "kv", kind: "key_value", title: "Facts", entries: [{ key: "Branch", value: "main" }, { key: "File", value: "x", ref: { path: "src/b.ts" } }] },
      { id: "tb", kind: "table", title: "Results", columns: [{ id: "n", label: "Name" }, { id: "v", label: "Value", align: "end" }], rows: [{ id: "r1", status: "done", cells: { n: "alpha", v: "1" } }] },
      { id: "md", kind: "markdown", title: "Notes", text: "Some **bold** text" },
      { id: "tl", kind: "timeline", title: "Log", events: [{ id: "e1", at: 1700000000000, level: "success", label: "Older event" }, { id: "e2", at: 1700000100000, level: "info", label: "Newer event" }] },
      { id: "fl", kind: "files", title: "Files", entries: [{ path: "src/c.ts", status: "modified" }] },
      { id: "un", kind: "hologram", title: "Future", fallback: "Shown as plain text" },
    ],
  };
  const publish = `await context.panels.update("g", { op: "replace", document: ${JSON.stringify(gadgetDocument)} });`;

  test("all eight block kinds render, an unknown kind shows its fallback, file references insert @path, and axe is clean", async ({ page, raw }) => {
    plugin(raw, "gadget", [decl("g", "Gadget", { open: "first_update", icon: "gauge" })], publish);
    await openChat(page, raw);
    await send(page, "run gadget");
    await expect(toggle(page, "Gadget")).toHaveAttribute("aria-expanded", "true");
    const body = section(page, "local/gadget#g");
    for (const kind of ["checklist", "steps", "progress", "key_value", "table", "markdown", "timeline", "files"])
      await expect(body.locator(`[data-kind="${kind}"]`)).toHaveCount(1);
    await expect(body.getByText("Parent")).toBeVisible();
    await expect(body.locator(".panel-status.status-done").first().locator(".sr-only")).toHaveText("Done");
    await expect(body.locator("progress")).toHaveCount(1);
    await expect(body.getByRole("table")).toBeVisible();
    await expect(body.locator("strong", { hasText: "bold" })).toBeVisible();
    await expect(body.getByTestId("panel-fallback")).toHaveText("Shown as plain text");
    // Steps show how long a finished step took; the timeline is newest first with relative time; files show a status letter.
    await expect(body.locator('[data-kind="steps"] .panel-tag', { hasText: "10m" })).toHaveCount(1);
    await expect(body.locator('[data-kind="timeline"] li').first()).toContainText("Newer event");
    await expect(body.locator('[data-kind="timeline"] li').last()).toContainText("Older event");
    await expect(body.locator('[data-kind="timeline"] time').first()).toHaveText(/ago$/);
    await expect(body.locator('[data-kind="files"] .panel-tag')).toHaveText(/M/);
    // Checklist: children collapse, and "Hide completed" is remembered by the browser.
    await expect(body.getByText("Child", { exact: true })).toBeVisible();
    await body.getByRole("button", { name: "Collapse Parent" }).click();
    await expect(body.getByText("Child", { exact: true })).toHaveCount(0);
    await body.getByRole("button", { name: "Expand Parent" }).click();
    await expect(body.getByText("Child", { exact: true })).toBeVisible();
    await expect(body.getByText("Finished chore")).toBeVisible();
    await body.getByLabel("Hide completed").check();
    await expect(body.getByText("Finished chore")).toHaveCount(0);
    await expect(body.getByText("Parent", { exact: true })).toBeVisible();
    await page.reload();
    await side(page).click();
    await expect(section(page, "local/gadget#g").getByLabel("Hide completed")).toBeChecked();
    await expect(section(page, "local/gadget#g").getByText("Finished chore")).toHaveCount(0);
    await section(page, "local/gadget#g").getByLabel("Hide completed").uncheck();
    await body.getByRole("button", { name: "src/a.ts:3" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(/@src\/a\.ts /);
    expect(await body.locator(".panel-body").evaluate((element) => element.scrollHeight > 0)).toBe(true);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    }
  });
});

test.describe("agent switch", () => {
  test.use({ scenario: { agent: { tools: { use: ["builtin/todo"] } }, extraAgents: { bare: { model: "fixture", tools: { use: [] } } }, responses: [answer] } });
  test("choosing another agent rebuilds the stack for that agent and choosing back restores it", async ({ page, raw }) => {
    await openChat(page, raw);
    await side(page).click();
    await expect(toggle(page, "Todo")).toBeVisible();
    const pick = async (name: string) => {
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: /^Agent:/ }).press("ArrowRight");
      await page.getByRole("menuitemradio", { name }).press("Enter");
    };
    await pick("bare");
    await expect(toggle(page, "Todo")).toHaveCount(0);
    await expect(toggle(page, "Details")).toBeVisible();
    await pick("raw");
    await expect(toggle(page, "Todo")).toBeVisible();
  });
});


test.describe("unseen updates", () => {
  test.use({
    scenario: { agent: { tools: { use: ["local/one", "local/two"], rules: [{ match: "local/*", effect: "allow" }] } }, responses: [call("t1", "two", {}), answer] },
  });
  test("an update to an expanded section that is scrolled out of view keeps its unseen dot, also after reopening the panel, until it is scrolled into view", async ({ page, raw }) => {
    plugin(raw, "one", [decl("p", "One")]);
    plugin(raw, "two", [decl("p", "Two")], 'await context.panels.update("p", { op: "replace", document: { title: "Second", blocks: [{ id: "m", kind: "markdown", text: "hello" }] } });');
    // Both sections are expanded at 700 px each, so the second starts below the fold of the stack.
    await page.addInitScript(() => {
      if (!localStorage.getItem("raw.dashboard.panels.v1")) localStorage.setItem("raw.dashboard.panels.v1", JSON.stringify({ version: 1, heights: { raw: 700 }, opened: ["x"] }));
    });
    await openChat(page, raw);
    const sessionId = new URL(page.url()).pathname.split("/").pop()!;
    await page.evaluate(([id]) => {
      const key = "raw.dashboard.panels.v1";
      const value = JSON.parse(localStorage.getItem(key)!);
      value.expanded = { [id!]: ["local/one#p", "local/two#p"] };
      localStorage.setItem(key, JSON.stringify(value));
    }, [sessionId]);
    await page.reload();
    await side(page).click();
    await expect(toggle(page, "Two")).toHaveAttribute("aria-expanded", "true");
    await send(page, "run two");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    const dot = section(page, "local/two#p").locator(".panel-unseen");
    await expect(dot).toHaveCount(1);
    // Closing and reopening the side panel starts from unknown visibility: below-the-fold content is still unread.
    await page.getByRole("button", { name: "Close side panel" }).click();
    await side(page).click();
    await expect(section(page, "local/two#p").locator(".panel-unseen")).toHaveCount(1);
    await stack(page).evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect(section(page, "local/two#p").locator(".panel-unseen")).toHaveCount(0);
  });
});
