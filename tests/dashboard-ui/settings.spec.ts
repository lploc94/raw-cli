import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { test, expect } from "./fixtures.js";

test("Settings searches actual keys and isolates browser/config scopes", async ({
  page,
  raw,
}) => {
  const before = readFileSync(raw.configPath, "utf8");
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Search settings").fill("context_window_tokens");
  await expect(
    page
      .locator(".search-results")
      .getByRole("link", { name: /Models & connections/ }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: /Models & connections/ })
    .last()
    .click();
  await page.getByRole("link", { name: "fixture", exact: true }).click();
  await expect(
    page.getByText("Credential stored", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("fixture-key");
  expect(readFileSync(raw.configPath, "utf8")).toBe(before);
  expect(raw.provider.requests.length).toBe(0);
});

test("invalid config repair uses a lazy strict JSON editor and never discards a failed draft", async ({
  page,
  raw,
}) => {
  const before = readFileSync(raw.configPath, "utf8");
  writeFileSync(raw.configPath, "{broken");
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open config editor" }).click();
  const editor = page.getByRole("textbox", {
    name: "Config JSON",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await editor.fill('{"models": {},}');
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(readFileSync(raw.configPath, "utf8")).toBe("{broken");
  await editor.fill(before);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => readFileSync(raw.configPath, "utf8")).toBe(before);
});

test("missing config initializes the same six-skill starter without inference", async ({
  page,
  raw,
}) => {
  unlinkSync(raw.configPath);
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Initialize Raw" }).click();
  await expect(page.getByText("Config initialized")).toBeVisible();
  expect(
    JSON.parse(readFileSync(raw.configPath, "utf8")).agents.raw.skills.use
      .length,
  ).toBe(6);
  expect(raw.provider.requests.length).toBe(0);
});

test("management editors reflow, keep focus, and pass accessibility in light and dark", async ({
  page,
  raw,
}) => {
  const { AxeBuilder } = await import("@axe-core/playwright");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/.test(message.text()))
      errors.push(message.text());
  });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Open config editor" }).click();
  await expect(
    page.getByRole("textbox", { name: "Config JSON", exact: true }),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page.setViewportSize({ width: 320, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("model form edits keep the key and model JSON retains invalid drafts for repair", async ({
  page,
  raw,
}) => {
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("link", { name: "Models & connections", exact: true })
    .click();
  await page.getByRole("link", { name: "fixture", exact: true }).click();
  await page.getByLabel("Context window tokens").fill("16000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  const model = JSON.parse(readFileSync(raw.configPath, "utf8")).models.fixture;
  expect(model.context_window_tokens).toBe(16000);
  expect(model.api_key).toBe("fixture-key");
  await page.getByLabel("Credential action").selectOption("clear");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("No explicit credential", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Credential action")).toHaveValue("keep");
  expect(
    JSON.parse(readFileSync(raw.configPath, "utf8")).models.fixture.api_key,
  ).toBeUndefined();
  await page
    .getByText("Model JSON · supported connection fields", { exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Model JSON", exact: true });
  await editor.fill("{broken");
  await expect(editor).toContainText("{broken");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(
    JSON.parse(readFileSync(raw.configPath, "utf8")).models.fixture
      .context_window_tokens,
  ).toBe(16000);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Discard and leave" }).click();
  await expect(
    page.getByRole("heading", { name: "Tools", exact: true }),
  ).toBeVisible();
});
