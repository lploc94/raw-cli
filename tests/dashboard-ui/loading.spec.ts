import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rail = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true });
/** Only the shared `/config` resource, not `/config/document` or `/config/validate`. */
const isConfig = (url: string) => new URL(url).pathname === "/api/config";

test("a new chat shows its title before the event stream connects and holds a skeleton, not blank UI", async ({
  page,
  raw,
}) => {
  await page.route("**/api/sessions/*/events", async (route) => {
    await delay(1500);
    await route.continue();
  });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  // The stream is still held back: everything visible now came from the cached session list.
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("");
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/Loading/);
  await expect(page.getByText("Loading conversation")).toBeAttached();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(page.getByText("Loading conversation")).toHaveCount(0);
});

test("the sidebar keeps its rows when the list refreshes and never claims 'no sessions' while loading", async ({
  page,
  raw,
}) => {
  await page.route("**/api/sessions?*", async (route) => {
    await delay(800);
    await route.continue();
  });
  await page.goto(raw.server.launchUrl);
  await expect(page.getByText("Your saved sessions appear here.")).toHaveCount(0);
  await expect(page.getByText("Loading sessions")).toBeAttached();
  await expect(page.getByText("Your saved sessions appear here.")).toBeVisible();
});

test("management pages show a skeleton on the first load and cached content instantly afterwards", async ({
  page,
  raw,
}) => {
  await page.goto(raw.server.launchUrl);
  await rail(page, "Agents").click();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();

  // `/config` is now cached; a slow server must not blank the next page that reads it.
  await page.route("**/api/config", async (route) => {
    await delay(2500);
    await route.continue();
  });
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible({ timeout: 1000 });
  await expect(page.getByText("Loading settings")).toHaveCount(0);
});

test("a first visit with a slow server shows the page skeleton and then the page", async ({
  page,
  raw,
}) => {
  await page.route("**/api/config", async (route) => {
    await delay(1200);
    await route.continue();
  });
  await page.goto(raw.server.launchUrl);
  await rail(page, "Agents").click();
  await expect(page.getByText("Loading agents")).toBeAttached();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();
  await expect(page.getByText("Loading agents")).toHaveCount(0);
});

test("a failed management load explains itself and can be retried in place", async ({
  page,
  raw,
}) => {
  let failing = true;
  await page.route("**/api/config", (route) =>
    failing && isConfig(route.request().url())
      ? route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "bad_config", message: "Config is unreadable." } }),
        })
      : route.continue(),
  );
  await page.goto(raw.server.launchUrl);
  await rail(page, "Agents").click();
  const error = page.getByRole("alert").filter({ hasText: "Config is unreadable." });
  await expect(error).toBeVisible();
  failing = false;
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();
});

test("a skeleton that became visible stays long enough not to flash", async ({ page, raw }) => {
  await page.route("**/api/config", async (route) => {
    await delay(250);
    await route.continue();
  });
  await page.goto(raw.server.launchUrl);
  await rail(page, "Agents").click();
  await page.getByText("Loading agents").waitFor({ state: "attached" });
  const shown = Date.now();
  await expect(page.getByText("Loading agents")).toHaveCount(0);
  // Reveal delay (150ms) + minimum hold (300ms) since loading began; the response came at ~250ms.
  expect(Date.now() - shown).toBeGreaterThan(300);
});

test("a chat opened with an active title filter still has its header at once", async ({ page, raw }) => {
  await page.route("**/api/sessions/*/events", async (route) => {
    await delay(1200);
    await route.continue();
  });
  await page.goto(raw.server.launchUrl);
  await page.getByLabel("Search session titles").fill("nothing-matches-this");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("");
  await expect(page.getByText("Loading conversation")).toBeAttached();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("skeletons are static and visible immediately when reduced motion is requested", async ({
  page,
  raw,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/config", async (route) => {
    await delay(1500);
    await route.continue();
  });
  await page.goto(raw.server.launchUrl);
  await rail(page, "Agents").click();
  const region = page.locator(".skeleton-region").first();
  await expect(region).toBeAttached();
  await expect(region).toHaveCSS("opacity", "1");
  await expect(page.locator(".skeleton").first()).toHaveCSS("animation-name", "none");
});

test("configuration edits show up on every page that reads the shared config", async ({
  page,
  raw,
}) => {
  const configRequests: string[] = [];
  page.on("request", (request) => {
    if (isConfig(request.url()) && request.method() === "GET") configRequests.push(request.url());
  });
  await page.goto(raw.server.launchUrl);
  await rail(page, "Agents").click();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();
  await page.getByRole("button", { name: "Create agent" }).click();
  await page.getByLabel("Agent name").fill("shared-cache-agent");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "shared-cache-agent" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Models & connections" }).click();
  await rail(page, "Agents").click();
  await expect(page.getByRole("link", { name: "shared-cache-agent" }).first()).toBeVisible();
  // Reads are shared and deduplicated, not one fetch per page mount.
  expect(configRequests.length).toBeLessThan(9);
});

test("route changes ease the main content in, except when reduced motion is requested", async ({
  page,
  raw,
}) => {
  const count = () => page.evaluate(() => (window as unknown as { __eased: number }).__eased);
  await page.addInitScript(() => {
    const w = window as unknown as { __eased: number };
    w.__eased = 0;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      if (this.id === "main") w.__eased++;
      return original.apply(this, args);
    };
  });
  await page.goto(raw.server.launchUrl);
  expect(await count()).toBe(0);
  await rail(page, "Agents").click();
  await expect(page.getByRole("button", { name: "Create agent" })).toBeVisible();
  expect(await count()).toBe(1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await rail(page, "Library").click();
  await expect(page).toHaveURL(/\/library/);
  expect(await count()).toBe(1);
});

test.describe("a provisional summary agent", () => {
  test.use({
    scenario: {
      extraAgents: { second: { model: "fixture", system_prompt: "Other", tools: { use: [] }, request_timeout_ms: 5000 } },
    },
  });
  test("is reconciled with the agent the session actually saved", async ({ page, raw }) => {
    // The list/POST summary claims "second"; the session itself was created with the default agent.
    await page.route("**/api/sessions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, agentName: "second" } });
    });
    await page.goto(raw.server.launchUrl);
    await page.getByLabel("Search session titles").fill("nothing-matches-this");
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(page.locator(".agent-chip")).toHaveText("raw");
  });
});
