import { chromium } from "@playwright/test";
import { dashboardFixture } from "../fixtures/dashboard.js";
import { openPath, seedLibrary } from "./library-seed.js";
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
          when: { source: "arguments", any: "commands[*].command", regex: "(^|[;& ]+)rm[ ]" },
        },
      ],
    },
    skills: { use: ["builtin/create_skill"] },
  },
  extraAgents: {
    reviewer: { model: "fixture", system_prompt: "Review changes carefully.", tools: { use: ["builtin/read_file"] } },
  },
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  // Screenshots should not catch the route ease-in mid-animation.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("list", { name: "Agent list" }).waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    if (!process.argv.includes("--packages-only")) await page.screenshot({
      path: `docs/dashboard/agents-list-${theme}-desktop.png`,
    });
  }
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
  // Library: seeded after the Agents shots, since the seed changes the raw agent's selection.
  await seedLibrary(raw);
  const shoot = async (path: string, ready: () => Promise<unknown>, files: Record<string, string>) => {
    await openPath(page, raw.server.launchUrl, path);
    await ready();
    for (const [theme, file] of Object.entries(files)) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
      if (!process.argv.includes("--packages-only")) await page.screenshot({ path: `docs/dashboard/${file}` });
    }
  };
  await shoot("/library/tools", () => page.getByRole("list", { name: "Tools catalog" }).waitFor(), {
    light: "library-tools-light-desktop.png",
    dark: "library-tools-dark-desktop.png",
  });
  await shoot("/library/tools/local%2Fprobe", () => page.getByRole("list", { name: "Agents using this component" }).waitFor(), {
    dark: "tool-dark-desktop.png",
  });
  await shoot("/library/vars", () => page.getByRole("list", { name: "Variables" }).waitFor(), { dark: "vars-dark-desktop.png" });
  await openPath(page, raw.server.launchUrl, "/library/packages");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.getByRole("button", { name: "Import package" }).click();
  await page.getByLabel("Local package path").fill(`${process.cwd()}/examples/packages/mixed-kit`);
  await page.getByRole("button", { name: "Inspect path", exact: true }).click();
  await page.getByRole("heading", { name: "Review package", exact: true }).waitFor();
  await page.screenshot({ path: "docs/dashboard/package-dark-desktop.png" });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if (!process.argv.includes("--packages-only")) await page.screenshot({ path: "docs/dashboard/packages-dark-desktop.png" });
} finally {
  await browser.close();
  await raw.close();
}
