import { test as base, expect } from "@playwright/test";
import { dashboardFixture } from "../fixtures/dashboard.js";
import type { MockResponse } from "../fixtures/mock-provider.js";
import { openAiFrame, openAiDone } from "../fixtures/mock-provider.js";

export const answer = {
  frames: [
    openAiFrame({ reasoning: "Checking the request." }),
    openAiFrame(
      {
        content:
          "## Ready\n\nHere is your code:\n\n```ts\nconst answer = 42;\n```\n\n| State | Value |\n| --- | --- |\n| Result | Ready |",
      },
      "stop",
    ),
    openAiDone,
  ],
};
export const test = base.extend<{
  raw: Awaited<ReturnType<typeof dashboardFixture>>;
  scenario: { responses?: MockResponse[]; agent?: Record<string, unknown>; model?: Record<string, unknown> };
}>({
  scenario: [{}, { option: true }],
  raw: async ({ scenario }, use) => {
    const f = await dashboardFixture({
      responses: scenario.responses ?? [answer, answer, answer],
      agent: scenario.agent ?? {},
      ...(scenario.model ? { model: scenario.model } : {}),
    });
    try {
      await use(f);
    } finally {
      await f.close();
    }
  },
});
export { expect };
export async function openChat(
  page: import("@playwright/test").Page,
  raw: Awaited<ReturnType<typeof dashboardFixture>>,
) {
  await page.goto(raw.server.launchUrl);
  await page
    .getByRole("button", { name: "New chat", exact: true })
    .first()
    .click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}
