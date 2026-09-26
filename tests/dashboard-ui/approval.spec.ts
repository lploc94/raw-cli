import { test, expect, openChat } from "./fixtures.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test.use({
  scenario: {
    agent: {
      request_timeout_ms: 20000,
      tools: {
        use: ["builtin/bash"],
        rules: [
          {
            match: "builtin/bash",
            effect: "ask",
            when: { any: "commands[*].command", regex: "^rm\\b" },
          },
        ],
      },
    },
    responses: [
      {
        frames: [
          openAiFrame(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "approval",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"commands":[{"command":"rm not-present"}]}',
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
        frames: [openAiFrame({ content: "Denied safely" }, "stop"), openAiDone],
      },
    ],
  },
});
test("pending permission remains visible from Settings and denying does not edit policy", async ({
  page,
  raw,
}) => {
  await openChat(page, raw);
  await page.getByRole("textbox", { name: "Message" }).fill("try command");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Activity/ }).click();
  await page.getByRole("link", { name: /Needs approval/ }).click();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByText("Denied safely", { exact: true })).toBeVisible();
  expect(raw.config.agents.raw.tools).toEqual({
    use: ["builtin/bash"],
    rules: [
      {
        match: "builtin/bash",
        effect: "ask",
        when: { any: "commands[*].command", regex: "^rm\\b" },
      },
    ],
  });
});

test("Allow once executes only the pending call and leaves the rule unchanged", async ({
  page,
  raw,
}) => {
  const file = join(raw.root, "not-present");
  writeFileSync(file, "fixture");
  await openChat(page, raw);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("remove the fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect
    .poll(() => raw.server.context.store!.listOperations()[0]?.state)
    .toBe("completed");
  expect(existsSync(file)).toBe(false);
  expect(raw.provider.requests.length).toBe(2);
});
