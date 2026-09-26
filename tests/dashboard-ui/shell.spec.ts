import { readFileSync } from "node:fs";
import { test, expect, openChat } from "./fixtures.js";

test("workspace and rename validation remain inside the active dialog", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page.getByRole("button", { name: "Rename session" }).click();
  await page.getByLabel("Session title", { exact: true }).fill(" ");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "nonempty",
  );
  await page.getByLabel("Session title", { exact: true }).fill("Valid title");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(
    page.getByRole("heading", { name: "Valid title" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Workspace raw-dashboard/ }).click();
  await page.getByLabel("Workspace directory").fill(`${raw.root}/missing`);
  await page.getByRole("button", { name: "Use workspace" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "existing directory",
  );
  await page.getByLabel("Workspace directory").fill(raw.root);
  await page.getByRole("button", { name: "Use workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Start a conversation" }),
  ).toBeVisible();
  expect(raw.provider.requests.length).toBe(0);
});

test("browser preferences reject invalid persisted values and preserve an unchanged request prefix", async ({
  page,
  raw,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "raw.dashboard.preferences.v1",
      JSON.stringify({
        version: 1,
        theme: "invalid",
        density: "tiny",
        chatSize: -1,
        contextWidth: 90000,
        api_key: "not-a-preference",
      }),
    ),
  );
  await openChat(page, raw);
  const sessionUrl = page.url();
  const config = readFileSync(raw.configPath, "utf8");
  await expect(page.locator("html")).toHaveAttribute(
    "data-density",
    "comfortable",
  );
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--context-width"),
    ),
  ).toBe("260px");
  await page.getByRole("textbox", { name: "Message" }).fill("first");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Chat", exact: true }).last().click();
  await page.getByLabel("Send message with").selectOption("modifier");
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByRole("link", { name: "Chat", exact: true }).first().click();
  await page.locator(`a[href="${new URL(sessionUrl).pathname}"]`).click();
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("second");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await input.press("Enter");
  expect(raw.provider.requests.length).toBe(1);
  await input.press("ControlOrMeta+Enter");
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toHaveCount(2);
  const requests = raw.provider.requests.map(
    (request) =>
      request.body as { messages: unknown[]; prompt_cache_key: string },
  );
  expect(requests[1]!.prompt_cache_key).toBe(requests[0]!.prompt_cache_key);
  expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(
    requests[0]!.messages,
  );
  expect(readFileSync(raw.configPath, "utf8")).toBe(config);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("raw.dashboard.preferences.v1"),
    ),
  ).not.toContain("not-a-preference");
});

test("launch token, navigation, palette and browser preferences preserve config bytes", async ({
  page,
  raw,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (
      message.text().includes("violates the following Content Security Policy")
    )
      violations.push(message.text());
  });
  const config = readFileSync(raw.configPath, "utf8");
  await page.goto(raw.server.launchUrl);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  expect(
    await page.evaluate(() => sessionStorage.getItem("raw.dashboard.token")),
  ).toBe(raw.server.token);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(
    page.getByRole("dialog", { name: "Quick navigation" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search commands and sessions" })
    .fill("Appearance");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByLabel("Density", { exact: true }).selectOption("compact");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  expect(readFileSync(raw.configPath, "utf8")).toBe(config);
  expect(raw.provider.requests.length).toBe(0);
  expect(violations).toEqual([]);
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("a lost submit response finds its durable receipt and keeps a later draft", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page.route("**/api/sessions/*/operations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("textbox", { name: "Message" }).fill("only once");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(raw.provider.requests.length).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(raw.provider.requests.length).toBe(1);
});

test("a late accepted response cannot replace completed state or erase a newer draft", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/*/operations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("textbox", { name: "Message" }).fill("first");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Ready", exact: true }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("next draft");
    release();
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
      "next draft",
    );
    expect(raw.provider.requests.length).toBe(1);
  } finally {
    release();
  }
});

test("history pagination preserves the viewport and does not dispatch historical tools", async ({
  page,
  raw,
}) => {
  const session = raw.server.context.store!.createSession({
    cwd: raw.root,
    title: "Long history",
    agentName: "raw",
  });
  for (let index = 0; index < 75; index++)
    raw.server.context.store!.appendHistory({
      sessionId: session.id,
      kind: index % 2 ? "assistant" : "user",
      payload: {
        text: `Message ${index} with saved content`,
        input: `Message ${index} with saved content`,
      },
    });
  await page.goto(
    `${raw.server.launchUrl.replace("/#", `/chat/${session.id}#`)}`,
  );
  await expect(
    page.getByText("Message 74 with saved content", { exact: true }),
  ).toBeVisible();
  const viewport = page.locator(".conversation-scroll");
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  const anchor = page.getByText("Message 25 with saved content", {
    exact: true,
  });
  const before = await anchor.boundingBox();
  await page.getByRole("button", { name: "Load earlier" }).click();
  await expect(
    page.getByText("Message 0 with saved content", { exact: true }),
  ).toHaveCount(1);
  const after = await anchor.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(15);
  await expect(
    page.getByRole("button", { name: "Jump to latest" }),
  ).toBeVisible();
  expect(raw.provider.requests.length).toBe(0);
});

test("legacy tool IDs reused in different turns retain separate results and honest preview labels", async ({
  page,
  raw,
}) => {
  const store = raw.server.context.store!;
  const session = store.createSession({
    cwd: raw.root,
    title: "Historical tools",
    agentName: "raw",
  });
  for (const index of [1, 2]) {
    store.appendHistory({
      sessionId: session.id,
      kind: "user",
      payload: { input: `Old task ${index}` },
    });
    store.appendHistory({
      sessionId: session.id,
      kind: "tool_call",
      payload: {
        display: {
          id: "reused",
          name: "lookup",
          identity: "mcp/fixture/lookup",
          started: true,
          arguments: { query: index },
        },
      },
    });
    store.appendHistory({
      sessionId: session.id,
      kind: "tool_result",
      payload: {
        display: {
          id: "reused",
          name: "lookup",
          identity: "mcp/fixture/lookup",
          failed: index === 2,
          ...(index === 2 ? { code: "outcome_unknown" } : {}),
          truncated: index === 1,
          rows: [],
          segments: [
            {
              kind: "text",
              text: `Result ${index} … [middle characters hidden] …`,
            },
          ],
        },
      },
    });
  }
  await page.goto(raw.server.launchUrl.replace("/#", `/chat/${session.id}#`));
  await expect(page.locator(".tool-card")).toHaveCount(2);
  for (const group of await page.locator(".work-group").all())
    if ((await group.getAttribute("open")) === null)
      await group.locator(":scope > summary").click();
  const first = page.locator(".tool-card").first();
  if ((await first.getAttribute("open")) === null)
    await first.locator(":scope > summary").click();
  await expect(first).toContainText("Result 1");
  await expect(first).toContainText("Display abbreviated");
  await expect(first).toContainText("Tool truncated its output");
  const second = page.locator(".tool-card").nth(1);
  await expect(second).toContainText("Result 2");
  await expect(second).toContainText("Outcome unknown");
  expect(raw.provider.requests.length).toBe(0);
});

test("drafts survive navigation and saved session titles support rename and delete", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  const sessionUrl = page.url();
  await page.getByRole("textbox", { name: "Message" }).fill("unsent draft");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.goto(sessionUrl); // Reload intentionally loses an unsent memory draft.
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("kept while navigating");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "kept while navigating",
  );
  await page.getByRole("button", { name: "Rename session" }).click();
  await page.getByLabel("Session title", { exact: true }).fill("My task");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("heading", { name: "My task" })).toBeVisible();
  await page.getByRole("button", { name: "Delete session" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.getByRole("heading", { name: "Start a conversation" }),
  ).toBeVisible();
  expect(raw.provider.requests.length).toBe(0);
});
