import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { openAiFrame, openAiDone } from "../fixtures/mock-provider.js";
import { makePngOfSize } from "../fixtures/images.js";

// Run after npm run build. These are real HTTP/tool flows in disposable local state.
mkdirSync("docs/dashboard", { recursive: true });
const cleanup: string[] = [];
const raw = await dashboardFixture({
  model: { vision: true },
  agent: { tools: { use: ["builtin/bash"] } },
  responses: [
    {
      frames: [
        openAiFrame(
          {
            reasoning: "Checking the workspace before continuing.",
            tool_calls: [
              {
                index: 0,
                id: "workspace",
                type: "function",
                function: {
                  name: "bash",
                  arguments: '{"commands":[{"command":"pwd"}]}',
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
        openAiFrame(
          {
            content:
              '## Keep working in the same session\n\nYour conversation stays available in the terminal and the browser.\n\n```sh\nraw --resume <session-id> "Continue the task"\n```\n\n- Open **Work** to inspect tool arguments and results.\n- Use **Context** for usage and the current summary.\n- Changes to an agent apply to its next turn.',
          },
          "stop",
        ),
        openAiDone,
      ],
    },
  ],
});
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(raw.server.launchUrl);
  await page
    .getByRole("button", { name: "New chat", exact: true })
    .first()
    .click();
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  const sessionPath = new URL(page.url()).pathname;
  const id = sessionPath.split("/").at(-1)!;
  await raw.json(`/sessions/${id}`, "PATCH", {
    title: "Make sessions resumable",
  });
  await page.reload();
  await page.locator("input[type=file]").setInputFiles({
    name: "terminal-session.png",
    mimeType: "image/png",
    buffer: makePngOfSize(24 * 1024),
  });
  await page.locator(".attachment-chip.ready").waitFor();
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Explain how I can continue a task from the browser or terminal.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("heading", { name: "Keep working in the same session" })
    .waitFor();
  for (const [label, width] of [
    ["desktop", 1440],
    ["tablet", 800],
    ["narrow", 320],
  ] as const)
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${raw.server.url}/settings/appearance`);
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await page
        .getByLabel("Density", { exact: true })
        .selectOption(label === "desktop" ? "comfortable" : "compact");
      await page.goto(raw.server.url + sessionPath);
      await page
        .getByRole("heading", { name: "Keep working in the same session" })
        .waitFor();
      await page.locator(".request-pill").waitFor();
      await page.locator(".conversation-scroll").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: `docs/dashboard/chat-${theme}-${label}.png`,
        animations: "disabled",
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      if (overflow) throw new Error(`Horizontal overflow in ${label}/${theme}`);
      console.log(JSON.stringify({ label, theme, width, overflow }));
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(raw.server.url + sessionPath);
  await page.getByLabel("Message", { exact: true }).pressSequentially("/");
  await page.getByRole("listbox", { name: "Suggestions" }).waitFor();
  await page.screenshot({
    path: "docs/dashboard/chat-dark-commands.png",
    animations: "disabled",
  });
  await page.getByLabel("Message", { exact: true }).fill("");
  await page.locator(".request-pill").click();
  await page.getByRole("slider", { name: "Reasoning" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.getByRole("radio", { name: /^priority/ }).click();
  await page.locator(".request-popover").waitFor();
  await page.screenshot({
    path: "docs/dashboard/chat-dark-controls.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  // Workspace switcher and folder browser, with a few disposable folders.
  const demo = realpathSync(mkdtempSync(join(tmpdir(), "raw-demo-")));
  cleanup.push(demo);
  for (const name of ["api-server", "docs", "web-app", ".cache"]) mkdirSync(join(demo, name));
  mkdirSync(join(demo, "web-app", "src"));
  for (const name of ["api-server", "web-app"]) await raw.json("/sessions", "POST", { cwd: join(demo, name) });
  await raw.json("/sessions", "POST", { cwd: join(demo, "web-app") });
  await page.evaluate((path) => localStorage.setItem("raw.dashboard.workspaces.v1", JSON.stringify({ version: 1, pinned: [], hidden: [], opened: [{ path, at: Date.now() - 3_600_000 }] })), join(demo, "docs"));
  await page.reload();
  await page.locator(".workspace-button:visible").click();
  await page.locator(".workspace-popover").waitFor();
  await page.getByRole("button", { name: /^Pin api-server/ }).click();
  await page.locator(".workspace-row", { hasText: "web-app" }).waitFor();
  await page.screenshot({
    path: "docs/dashboard/workspace-dark-switcher.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Open folder…" }).click();
  await page.getByRole("dialog", { name: "Open folder" }).waitFor();
  await page.getByLabel("Workspace directory").fill(demo);
  await page.getByLabel("Workspace directory").press("Enter");
  await page.locator(".folder-entry", { hasText: "web-app" }).waitFor();
  await page.screenshot({
    path: "docs/dashboard/workspace-dark-browser.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.goto(raw.server.url + sessionPath);
  await page.getByRole("button", { name: "Session details" }).click();
  await page.getByRole("heading", { name: "Context", exact: true }).waitFor();
  await page.screenshot({
    path: "docs/dashboard/chat-dark-inspector.png",
    animations: "disabled",
  });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify({
      errors,
      engine: browser.version(),
      platform: process.platform,
      arch: process.arch,
    }),
  );
} finally {
  await browser.close();
  await raw.close();
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
}
