import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect, openChat, answer } from "./fixtures.js";

const message = (page: Page) => page.getByLabel("Message", { exact: true });
const pill = (page: Page) => page.locator(".request-pill");
const slider = (page: Page) => page.getByRole("slider", { name: "Reasoning" });
const lastBody = (raw: { provider: { requests: Array<{ body: unknown }> } }) => raw.provider.requests.at(-1)!.body as Record<string, unknown>;
const stored = (page: Page) => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("raw.dashboard.request.")).map(([, value]) => value));
async function send(page: Page, text: string) {
  await message(page).fill(text);
  await message(page).press("Enter");
}
async function choose(page: Page, effort: "End" | "ArrowRight", tier?: string) {
  await pill(page).click();
  await slider(page).focus();
  await page.keyboard.press(effort);
  if (tier) await page.getByRole("radio", { name: new RegExp(`^${tier}`) }).click();
  await page.keyboard.press("Escape");
}
/** Rewrites the composer metadata the dashboard receives, without touching the server. */
async function describe(page: Page, edit: (meta: any) => void) {
  await page.route("**/api/agents/*/composer", async (route) => {
    const response = await route.fetch();
    const meta = await response.json();
    edit(meta);
    await route.fulfill({ response, json: meta });
  });
}

test.describe("openai agent", () => {
  test("the pill shows the provider's label, and the slider and radio group work by keyboard", async ({ page, raw }) => {
    await openChat(page, raw);
    await expect(pill(page)).toHaveText("Reasoning");
    await expect(pill(page)).toHaveAccessibleName("Request settings: Reasoning Agent default, Service tier Agent default");
    await pill(page).click();
    await expect(page.getByRole("radiogroup", { name: "Service tier" })).toBeVisible();
    await expect(page.getByText("Fastest and most reliable; higher cost.")).toBeVisible();
    await slider(page).focus();
    await page.keyboard.press("ArrowRight");
    await expect(pill(page)).toHaveText("Reasoning: none");
    await expect(slider(page)).toHaveAttribute("aria-valuetext", "none");
    await page.keyboard.press("End");
    await expect(pill(page)).toHaveText("Reasoning: max");
    await page.keyboard.press("ArrowLeft");
    await expect(pill(page)).toHaveText("Reasoning: xhigh");
    await page.keyboard.press("Home");
    await expect(pill(page)).toHaveText("Reasoning");
    await expect(slider(page)).toHaveAttribute("aria-valuetext", "Agent default");
    await page.getByRole("radio", { name: /^priority/ }).click();
    await expect(pill(page)).toHaveText("Reasoning · priority");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    await expect(pill(page)).toBeFocused();
  });

  test("the open popover passes axe", async ({ page, raw }) => {
    await openChat(page, raw);
    await pill(page).click();
    await expect(page.locator(".request-popover")).toBeVisible();
    const result = await new AxeBuilder({ page }).include(".request-popover").include(".composer-area").analyze();
    expect(result.violations).toEqual([]);
  });

  test("the pointer moves the slider", async ({ page, raw }) => {
    await openChat(page, raw);
    await pill(page).click();
    const track = await page.locator(".slider-track").boundingBox();
    await page.mouse.click(track!.x + track!.width - 1, track!.y + track!.height / 2);
    await expect(pill(page)).toHaveText("Reasoning: max");
  });

  test("the choice reaches the provider for that turn and persists across sessions and reloads", async ({ page, raw }) => {
    await openChat(page, raw);
    await choose(page, "End", "priority");
    await expect(pill(page)).toHaveText("Reasoning: max · priority");
    await send(page, "first");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    expect(lastBody(raw)).toMatchObject({ reasoning_effort: "max", service_tier: "priority" });
    // The choice is remembered, not consumed by the turn.
    await expect(pill(page)).toHaveText("Reasoning: max · priority");
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await expect(pill(page)).toHaveText("Reasoning");
    await page.goBack();
    await expect(pill(page)).toHaveText("Reasoning: max · priority");
    await page.reload();
    await expect(pill(page)).toHaveText("Reasoning: max · priority");
    await send(page, "second");
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    expect(lastBody(raw)).toMatchObject({ reasoning_effort: "max", service_tier: "priority" });
    await pill(page).click();
    await page.getByRole("button", { name: "Reset" }).click();
    await page.keyboard.press("Escape");
    await expect(pill(page)).toHaveText("Reasoning");
    await send(page, "third");
    await expect(page.getByTestId("assistant-message")).toHaveCount(3);
    expect(lastBody(raw)).not.toHaveProperty("reasoning_effort");
    expect(lastBody(raw)).not.toHaveProperty("service_tier");
    expect(await stored(page)).toEqual([]);
  });

  test("a level and a tier vary the wire independently", async ({ page, raw }) => {
    await openChat(page, raw);
    await choose(page, "ArrowRight");
    await send(page, "one");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    expect(lastBody(raw)).toMatchObject({ reasoning_effort: "none" });
    expect(lastBody(raw)).not.toHaveProperty("service_tier");
    await pill(page).click();
    await page.getByRole("radio", { name: /^flex/ }).click();
    await page.keyboard.press("Escape");
    await send(page, "two");
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    expect(lastBody(raw)).toMatchObject({ reasoning_effort: "none", service_tier: "flex" });
  });

  test("the pill stays usable while a turn runs and affects the next turn", async ({ page, raw }) => {
    await openChat(page, raw);
    await send(page, "go");
    await choose(page, "End");
    await expect(pill(page)).toHaveText("Reasoning: max");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await send(page, "again");
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    expect(lastBody(raw)).toMatchObject({ reasoning_effort: "max" });
  });

  test("a value the loaded controls no longer offer is dropped; unknown descriptors are ignored", async ({ page, raw }) => {
    await openChat(page, raw);
    await choose(page, "End");
    await expect(pill(page)).toHaveText("Reasoning: max");
    await describe(page, (meta) => {
      meta.controls = [
        { id: "effort", label: "Effort", kind: "level", options: [{ value: "low", label: "low" }, { value: "high", label: "high" }] },
        { id: "temperature", label: "Temperature", kind: "level", options: [{ value: "0", label: "0" }] },
      ];
    });
    await page.reload();
    await expect(pill(page)).toHaveText("Effort");
    await expect(pill(page)).toHaveAccessibleName("Request settings: Effort Agent default");
    await pill(page).click();
    await expect(page.getByRole("slider")).toHaveCount(1);
    await page.keyboard.press("Escape");
    expect(await stored(page)).toEqual([]);
    await send(page, "hello");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    expect(lastBody(raw)).not.toHaveProperty("reasoning_effort");
  });

  test.describe("agent switch", () => {
    test.use({ scenario: { extraAgents: { second: { model: "fixture", system_prompt: "Other", tools: { use: [] }, request_timeout_ms: 5000 } } } });

    test("a stored value is pruned only after the new agent's controls load", async ({ page, raw }) => {
      await openChat(page, raw);
      await choose(page, "End", "flex");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/api/agents/second/composer", async (route) => {
        const response = await route.fetch();
        const meta = await response.json();
        meta.controls = [{ id: "effort", label: "Thinking", kind: "level", options: [{ value: "low", label: "low" }, { value: "high", label: "high" }] }];
        await gate;
        await route.fulfill({ response, json: meta });
      });
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: /^Agent:/ }).press("ArrowRight");
      await page.getByRole("menuitemradio", { name: "second" }).press("Enter");
      await expect(pill(page)).toHaveCount(0);
      expect(await stored(page)).toHaveLength(1);
      release();
      await expect(pill(page)).toHaveText("Thinking");
      expect(await stored(page)).toEqual([]);
      await send(page, "hello");
      await expect(page.getByTestId("assistant-message")).toHaveCount(1);
      expect(lastBody(raw)).not.toHaveProperty("reasoning_effort");
      expect(lastBody(raw)).not.toHaveProperty("service_tier");
    });
  });

  test("a slow or failed composer response keeps the choice, sends nothing, and restores it", async ({ page, raw }) => {
    await openChat(page, raw);
    await choose(page, "End", "flex");
    await page.route("**/api/agents/*/composer", (route) => route.abort());
    await page.reload();
    await expect(message(page)).toBeVisible();
    await expect(pill(page)).toHaveCount(0);
    expect(await stored(page)).toHaveLength(1);
    await send(page, "no controls");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    expect(lastBody(raw)).not.toHaveProperty("reasoning_effort");
    expect(lastBody(raw)).not.toHaveProperty("service_tier");
    await page.unroute("**/api/agents/*/composer");
    await page.reload();
    await expect(pill(page)).toHaveText("Reasoning: max · flex");
  });

  test("a refused submit shows in the composer error area and keeps the choice", async ({ page, raw }) => {
    await openChat(page, raw);
    await choose(page, "End");
    await page.route("**/api/sessions/*/operations", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 422, json: { error: { code: "invalid_request_option", message: "effort is not supported" } } })
        : route.continue(),
    );
    await send(page, "hello");
    await expect(page.getByText("effort is not supported")).toBeVisible();
    await expect(pill(page)).toHaveText("Reasoning: max");
    await expect(message(page)).toHaveValue("hello");
  });

  test("narrow viewports keep the toolbar inside the screen in both themes", async ({ page, raw }) => {
    await openChat(page, raw);
    await choose(page, "End", "priority");
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1440, 800, 320]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
        await expect(pill(page)).toBeInViewport();
        await pill(page).click();
        const box = (await page.locator(".request-popover").boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
      }
    }
  });
});

test.describe("provider rejection", () => {
  test.use({ scenario: { responses: [{ status: 400, body: { error: { message: "unsupported tier xyz" } } }, answer, answer] } });

  test("fails only that turn, keeps the choice and Send, and Agent default recovers", async ({ page, raw }) => {
    await openChat(page, raw);
    await choose(page, "End", "priority");
    await send(page, "will fail");
    await expect(page.locator(".run-status")).toContainText("unsupported tier xyz");
    await expect(pill(page)).toHaveText("Reasoning: max · priority");
    await message(page).fill("retry");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await pill(page).click();
    await page.getByRole("button", { name: "Reset" }).click();
    await page.keyboard.press("Escape");
    await message(page).press("Enter");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    expect(lastBody(raw)).not.toHaveProperty("reasoning_effort");
  });
});

test.describe("provider without request settings", () => {
  test.use({ scenario: { model: { provider: "ollama" } } });

  test("no pill is shown", async ({ page, raw }) => {
    await openChat(page, raw);
    await expect(pill(page)).toHaveCount(0);
    await send(page, "hi");
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
  });
});
