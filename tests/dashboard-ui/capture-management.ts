import { chromium } from "@playwright/test";
import { dashboardFixture } from "../fixtures/dashboard.js";
const raw = await dashboardFixture({
  agent: {
    tools: {
      use: [
        "builtin/read_file",
        "builtin/write_file",
        "builtin/bash",
        "builtin/list_skills",
        "builtin/load_skill",
      ],
      rules: [
        {
          match: "builtin/bash",
          effect: "ask",
          when: { any: "commands[*].command", regex: "(^|[;& ]+)rm[ ]" },
        },
      ],
    },
    skills: { use: ["builtin/create_skill"] },
  },
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "raw", exact: true }).first().click();
  await page.getByLabel("System prompt", { exact: true }).waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    if (!process.argv.includes("--packages-only")) await page.screenshot({
      path: `docs/dashboard/agent-${theme}-desktop.png`,
    });
  }
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page
    .getByRole("link", { name: "builtin/read_file", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Source tool.json", exact: true })
    .waitFor();
  if (!process.argv.includes("--packages-only")) await page.screenshot({ path: "docs/dashboard/tool-dark-desktop.png" });
  await page.getByRole("link", { name: "Packages", exact: true }).click();
  await page.getByLabel("Local package path").fill(`${process.cwd()}/examples/packages/mixed-kit`);
  await page.getByRole("button", { name: "Inspect path", exact: true }).click();
  await page.getByRole("heading", { name: "Review package", exact: true }).waitFor();
  await page.screenshot({ path: "docs/dashboard/package-dark-desktop.png" });
} finally {
  await browser.close();
  await raw.close();
}
