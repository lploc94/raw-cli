import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openChat } from "./fixtures.js";
import { workflowScenario, workflowAnswer, installWorkflowDiagram } from "../fixtures/tool-ui-workflow.js";

test.use({ scenario: workflowScenario });
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function showSection(page: Page, id: string) {
  if (!await page.locator(".inspector").count()) await page.getByRole("button", { name: "Side panel", exact: true }).click();
  const section = page.locator(`[data-panel="${id}"]`);
  if (await section.locator(".panel-toggle").getAttribute("aria-expanded") !== "true") await section.locator(".panel-toggle").click();
  return section;
}
test("Ask, Commands, Todo, patches and Mermaid survive reload and retry while Stop works during a held turn", async ({ page, raw }, info) => {
  test.setTimeout(60000);
  installWorkflowDiagram(raw.env);
  await openChat(page, raw);
  await send(page, "ask and start");
  await expect(page.getByRole("textbox", { name: "Workflow answer", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("textbox", { name: "Workflow answer", exact: true }).fill(workflowAnswer);
  let retried = false;
  await page.route("**/api/sessions/*/interactions/*/responses", async route => {
    const first = await route.fetch();
    const retry = await route.fetch();
    expect(retry.status()).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    retried = true;
    await route.fulfill({ response: retry });
  });
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(page.getByTestId("assistant-message")).toContainText("First turn complete.");
  expect(retried).toBe(true);
  await expect(page.getByRole("textbox", { name: "Workflow answer", exact: true })).toBeDisabled();
  const commands = await showSection(page, "__commands");
  await expect(commands).toContainText("Workflow job");
  await commands.getByRole("button", { name: "Output", exact: true }).click();
  await expect(commands.locator("pre")).toContainText("workflow ready");
  await send(page, "patch and diagram");
  await expect(page.getByTestId("assistant-message")).toHaveCount(2);
  const files = await showSection(page, "builtin/write_file#files_changed");
  await expect(files.locator(".panel-files li")).toHaveCount(1);
  await expect(files.locator(".panel-markdown")).toContainText("written exactly once 雪");
  const diagram = await showSection(page, "local/diagram#diagram");
  await expect(diagram.locator('svg[role="img"]')).toContainText("Patch");
  await expect(page.getByTestId("assistant-message").last().locator('svg[role="img"]')).toContainText("Answer");
  const todo = await showSection(page, "builtin/todo#todo");
  await expect(todo).toContainText("Finish integrated workflow");
  expect(readFileSync(join(raw.root, "workflow.txt"), "utf8")).toBe("written exactly once 雪\n");
  await page.screenshot({ path: info.outputPath("workflow-before-reload.png"), fullPage: true });
  await page.reload();
  await showSection(page, "__commands");
  await expect(commands.getByRole("button", { name: "Stop", exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Workflow answer", exact: true })).toHaveValue(workflowAnswer);
  await expect(page.getByRole("textbox", { name: "Workflow answer", exact: true })).toBeDisabled();
  await showSection(page, "local/diagram#diagram");
  await expect(diagram.locator('svg[role="img"]')).toContainText("Patch");
  await showSection(page, "builtin/write_file#files_changed");
  await expect(files.locator(".panel-files li")).toHaveCount(1);
  await showSection(page, "builtin/todo#todo");
  await expect(todo).toContainText("Finish integrated workflow");
  await send(page, "keep model pending");
  await expect.poll(() => raw.provider.requests.length).toBe(9);
  await commands.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).click();
  await expect(commands.getByText("Stop completed.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("assistant-message")).toHaveCount(2);
  expect(raw.provider.requests.length).toBe(9);
  await page.screenshot({ path: info.outputPath("workflow-stop-during-turn.png"), fullPage: true });
});
