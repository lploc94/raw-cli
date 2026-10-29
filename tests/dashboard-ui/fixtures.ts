import { test as base, expect } from "@playwright/test";
import { dashboardFixture } from "../fixtures/dashboard.js";
import type { DashboardOptions } from "../../src/dashboard/server.js";
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
  scenario: { responses?: MockResponse[]; agent?: Record<string, unknown>; extraAgents?: Record<string, Record<string, unknown>>; model?: Record<string, unknown>; config?: Record<string, unknown>; env?: Record<string, string>;
    attach?: DashboardOptions["attach"]; discoverBackend?: DashboardOptions["discoverBackend"] };
}>({
  scenario: [{}, { option: true }],
  raw: async ({ scenario }, use) => {
    const f = await dashboardFixture({
      responses: scenario.responses ?? [answer, answer, answer],
      agent: scenario.agent ?? {},
      ...(scenario.extraAgents ? { extraAgents: scenario.extraAgents } : {}),
      ...(scenario.model ? { model: scenario.model } : {}),
      ...(scenario.config ? { config: scenario.config } : {}),
      ...(scenario.env ? { env: scenario.env } : {}),
      ...(scenario.attach ? { attach: scenario.attach } : {}),
      ...(scenario.discoverBackend ? { discoverBackend: scenario.discoverBackend } : {}),
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
/** The composer's Context card (docs/chat-design.md §8), opened from the context ring. */
export async function openContext(page: import("@playwright/test").Page) {
  await page.locator(".composer-area").getByRole("button", { name: /^Context: / }).click();
  const card = page.getByRole("dialog", { name: "Context", exact: true });
  await expect(card).toBeVisible();
  return card;
}
/** Compact now in the composer's Context card. */
export async function compactNow(page: import("@playwright/test").Page) {
  const card = await openContext(page);
  await card.getByRole("button", { name: "Compact now", exact: true }).click();
}
