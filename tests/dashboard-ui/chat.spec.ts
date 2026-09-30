import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

for (const outcome of ["failure", "cancelled", "not_smaller"] as const)
  test.describe(`compact ${outcome}`, () => {
    test.use({
      scenario: {
        agent: { compact: { keep_recent_turns: 0, max_output_tokens: 64 } },
        responses: [
          {
            frames: [
              openAiFrame({ content: "Seed context. ".repeat(140) }, "stop"),
              openAiDone,
            ],
          },
          outcome === "failure"
            ? {
                status: 500,
                body: { error: { message: "summary unavailable" } },
              }
            : outcome === "cancelled"
              ? { hold: true }
              : {
                  frames: [
                    openAiFrame({ content: "oversized ".repeat(2000) }, "stop"),
                    openAiDone,
                  ],
                },
        ],
      },
    });
    test("retains the previous context and an honest terminal marker", async ({
      page,
      raw,
    }) => {
      await openChat(page, raw);
      await page.getByRole("textbox", { name: "Message" }).fill("Seed");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByTestId("assistant-message")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Compact context", exact: true }),
      ).toBeEnabled();
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      const before = raw.server.context.store!.getContextSummary(id);
      await page
        .getByRole("button", { name: "Compact context", exact: true })
        .click();
      if (outcome === "cancelled") {
        await expect.poll(() => raw.provider.requests.length).toBe(2);
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      }
      await expect(page.locator(".compaction")).toContainText(
        outcome === "failure"
          ? "Compaction failed"
          : outcome === "cancelled"
            ? "Compaction cancelled"
            : "Summary was not smaller",
      );
      expect(raw.server.context.store!.getContextSummary(id)).toEqual(before);
      await expect(page.getByTestId("user-message")).toHaveCount(1);
    });
  });

test("real chat renders highlighted Markdown, reasoning and context without duplicate turns", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page.getByRole("textbox", { name: "Message" }).fill("Show the answer");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".hljs-keyword")).toContainText("const");
  await page.getByText("Work", { exact: true }).click();
  await expect(
    page.getByText("Checking the request.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Side panel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByText("8,192", { exact: false }).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy resume command" }),
  ).toBeVisible();
  expect(raw.provider.requests.length).toBe(1);
});

test.describe("compaction", () => {
  test.use({
    scenario: {
      agent: { compact: { keep_recent_turns: 0, max_output_tokens: 64 } },
      responses: [
        {
          frames: [
            openAiFrame({ content: "Detailed context. ".repeat(120) }, "stop"),
            openAiDone,
          ],
        },
        {
          frames: [
            openAiFrame({ content: "Remember the original task." }, "stop"),
            openAiDone,
          ],
        },
      ],
    },
  });
  test("manual compact keeps older history and one summary after refresh", async ({
    page,
    raw,
  }) => {
    await openChat(page, raw);
    await page
      .getByRole("textbox", { name: "Message" })
      .fill("Remember these details");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Compact context", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Compact context", exact: true })
      .click();
    const marker = page
      .locator(".compaction")
      .filter({ hasText: "Context compacted" });
    await expect(marker).toHaveCount(1);
    await marker.locator("summary").click();
    await expect(
      page.getByText("Remember the original task.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(marker).toHaveCount(1);
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await expect(page.getByTestId("assistant-message")).toContainText(
      "Detailed context.",
    );
    expect(raw.provider.requests.length).toBe(2);
  });
  test("empty compact is a visible no-op without a user turn or inference", async ({
    page,
    raw,
  }) => {
    await openChat(page, raw);
    await page
      .getByRole("button", { name: "Compact context", exact: true })
      .click();
    await expect(
      page.getByText("Nothing to compact", { exact: false }),
    ).toBeVisible();
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    expect(raw.provider.requests.length).toBe(0);
  });
});

test.describe("automatic compaction", () => {
  test.use({
    scenario: {
      agent: {
        compact: {
          keep_recent_turns: 1,
          trigger_tokens: 800,
          max_output_tokens: 64,
        },
      },
      responses: [
        {
          frames: [
            openAiFrame({ content: "body ".repeat(400) }, "stop"),
            openAiDone,
          ],
        },
        {
          frames: [
            openAiFrame({ content: "Saved summary" }, "stop"),
            openAiDone,
          ],
        },
        {
          frames: [
            openAiFrame({ content: "Continued after compact" }, "stop"),
            openAiDone,
          ],
        },
      ],
    },
  });
  test("automatic compact finishes the same submitted turn", async ({
    page,
    raw,
  }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("one");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Compact context", exact: true }),
    ).toBeEnabled();
    await page.getByRole("textbox", { name: "Message" }).fill("two");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("Continued after compact", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".compaction").filter({ hasText: "Context compacted" }),
    ).toHaveCount(1);
    await expect(page.getByTestId("user-message")).toHaveCount(2);
    expect(raw.provider.requests.length).toBe(3);
  });
});

test.describe("provider cancellation", () => {
  test.use({ scenario: { responses: [{ hold: true }] } });
  test("Stop cancels a held request while preserving the user turn", async ({
    page,
    raw,
  }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("wait");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => raw.provider.requests.length).toBe(1);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByText("Stopped · response may be incomplete", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
  });
});

test.describe("untrusted Markdown", () => {
  test.use({
    scenario: {
      responses: [
        {
          frames: [
            openAiFrame(
              {
                content:
                  "<script>globalThis.rawAttack=true</script>\n\n[bad](javascript:alert(1))\n\n![external](https://not-raw.invalid/image.png)\n\n```html\n<img src=x onerror=alert(1)>\n```",
              },
              "stop",
            ),
            openAiDone,
          ],
        },
      ],
    },
  });
  test("HTML, script links and remote images stay inert", async ({
    page,
    raw,
  }) => {
    const foreign: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(raw.server.url))
        foreign.push(request.url());
    });
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("render safely");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("assistant-message")).toContainText(
      "Image: external",
    );
    expect(
      await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { rawAttack?: boolean }).rawAttack,
      ),
    ).toBeUndefined();
    expect(foreign).toEqual([]);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  });
});

test("IME Enter does not send, and send-mode preferences leave model input unchanged", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("日本語");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  expect(raw.provider.requests.length).toBe(0);
  await input.dispatchEvent("compositionend");
  await input.fill("confirmed");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  expect(raw.provider.requests.length).toBe(1);
});

test.describe("context usage and title", () => {
  test.use({
    scenario: {
      agent: { compact: { keep_recent_turns: 0, max_output_tokens: 64, trigger_tokens: 4000 } },
      responses: [{ frames: [openAiFrame({ content: "ok" }, "stop"), openAiDone] }],
    },
  });
  test("the header takes the chat's new name from its first message, without a reload", async ({ page, raw }) => {
    await openChat(page, raw);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("New chat");
    await page.getByRole("textbox", { name: "Message" }).fill("Name this chat after me");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Name this chat after me");
    await expect(page.locator(".page-header .metadata")).not.toContainText("New chat");
  });
  test("usage and the ring are measured against the auto-compact trigger, not the model window", async ({ page, raw }) => {
    await openChat(page, raw);
    await page.getByRole("textbox", { name: "Message" }).fill("hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const footer = page.locator(".composer-footer");
    await expect(footer).toContainText("/ 4,000");
    await expect(footer).toContainText("until auto compact");
    await expect(footer).not.toContainText("8,192");
    const shown = /~([\d,]+) \/ 4,000 · ([\d.]+)%/.exec((await footer.textContent()) ?? "");
    expect(shown).not.toBeNull();
    const tokens = Number(shown![1]!.replaceAll(",", ""));
    expect(Number(shown![2])).toBeCloseTo(tokens / 4000 * 100, 1);
    await expect(footer.locator(".context-ring")).toContainText(`${Math.round(tokens / 40)}%`);
  });
});
