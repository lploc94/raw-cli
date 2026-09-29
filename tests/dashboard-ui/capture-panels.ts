import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { openAiDone, openAiFrame } from "../fixtures/mock-provider.js";

// Run after npm run build. A real todo tool call against a mock provider, in disposable local state.
mkdirSync("docs/dashboard", { recursive: true });
const todos = ["Read the failing test", "Fix the parser", "Run the suite", "Update the docs"].map((content, index) => ({ content, status: index === 0 ? "done" : index === 1 ? "in_progress" : "pending" }));
const raw = await dashboardFixture({
  agent: { tools: { use: ["builtin/todo"] } },
  responses: [
    { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "todo1", type: "function", function: { name: "todo", arguments: JSON.stringify({ title: "Fix the parser", todos }) } }] }, "tool_calls"), openAiDone] },
    { frames: [openAiFrame({ content: "I made a plan and started on it." }, "stop"), openAiDone] },
  ],
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Message" }).fill("Fix the parser and tell me when the suite passes");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Work", { exact: true }).click();
  await page.locator(".panel-receipt").first().waitFor();
  await page.getByText("Update the docs", { exact: true }).waitFor();
  await page.screenshot({ path: "docs/dashboard/chat-dark-side-panel.png", animations: "disabled" });
  console.log("wrote docs/dashboard/chat-dark-side-panel.png");
} finally {
  await browser.close();
  await raw.close();
}
