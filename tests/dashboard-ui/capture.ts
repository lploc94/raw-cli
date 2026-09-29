import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { openAiFrame, openAiDone } from "../fixtures/mock-provider.js";
import { makePngOfSize } from "../fixtures/images.js";

// Run after npm run build. These are real HTTP/tool flows in disposable local state.
mkdirSync("docs/dashboard", { recursive: true });
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
}
