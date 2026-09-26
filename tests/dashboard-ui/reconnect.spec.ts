import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

test.use({
  scenario: {
    agent: { tools: { use: ["builtin/bash"] } },
    responses: [
      {
        frames: [
          openAiFrame(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "once",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments:
                      '{"commands":[{"command":"printf x >> effect; sleep 1"}]}',
                  },
                },
              ],
            },
            "tool_calls",
          ),
          openAiDone,
        ],
      },
      {
        frames: [
          openAiFrame({ content: "Completed once" }, "stop"),
          openAiDone,
        ],
      },
    ],
  },
});
test("refresh during a real tool recovers the receipt without another submission", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page.getByRole("textbox", { name: "Message" }).fill("perform once");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Completed once", { exact: true })).toBeVisible();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(raw.provider.requests.length).toBe(2);
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(`${raw.root}/effect`, "utf8")).toBe("x");
});

test("completion updates Activity without moving focus out of Settings", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("work in the background");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Appearance", exact: true }).click();
  const theme = page.getByLabel("Theme", { exact: true });
  await theme.focus();
  await expect
    .poll(() => raw.server.context.store!.listOperations()[0]?.state)
    .toBe("completed");
  await expect(theme).toBeFocused();
  await expect(page).toHaveURL(/settings\/appearance$/);
});
