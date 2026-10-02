import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.js";

function source(root: string) {
  const folder = join(root, "shared-kit");
  cpSync(join(process.cwd(), "examples/packages/tool-only"), folder, {
    recursive: true,
  });
  mkdirSync(join(folder, "agents"));
  writeFileSync(
    join(folder, "agents/writer.json"),
    JSON.stringify({ system_prompt: { $input: "prompt" }, tools: { use: [] } }),
  );
  const manifest = JSON.parse(
    readFileSync(join(folder, "raw-package.json"), "utf8"),
  );
  manifest.files.push("agents/writer.json");
  manifest.exports.agents = { writer: "agents/writer.json" };
  manifest.inputs = {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Instructions for this agent" },
    },
    required: ["prompt"],
  };
  writeFileSync(join(folder, "raw-package.json"), JSON.stringify(manifest));
  return folder;
}
test("inspect, install, bind typed inputs, chat, export and download through real package APIs", async ({
  page,
  raw,
}) => {
  const folder = source(raw.root);
  const before = readFileSync(raw.configPath, "utf8");
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Packages", exact: true }).click();
  await page.getByRole("button", { name: "Import package" }).first().click();
  await page.getByLabel("Local package path").fill(folder);
  await page.getByRole("button", { name: "Inspect path", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review package", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Install alias").fill("shared");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Installed shared" }),
  ).toBeVisible();
  expect(readFileSync(raw.configPath, "utf8")).toBe(before);
  rmSync(folder, { recursive: true });
  await page.getByRole("link", { name: "shared", exact: true }).click();
  await page.getByRole("button", { name: "Use agent", exact: true }).click();
  await page.getByLabel("Local agent name").fill("writer");
  await page
    .getByLabel("Input prompt", { exact: true })
    .fill("Imported instructions");
  await page
    .getByRole("button", { name: "Create agent binding", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Agent writer created" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Chat with writer", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Use imported agent");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ready", exact: true }),
  ).toBeVisible();
  expect(JSON.stringify(raw.provider.requests[0]?.body)).toContain(
    "Imported instructions",
  );
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Packages", exact: true }).click();
  await page.getByRole("button", { name: "Export agent", exact: true }).click();
  await page.getByLabel("Export agent name").selectOption("writer");
  await page.getByLabel("Package name").fill("@test/exported");
  await page
    .getByRole("button", { name: "Build archive", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review package", exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download archive", exact: true })
    .click();
  const archive = await download;
  expect(archive.suggestedFilename()).toBe("raw-package.rawpkg");
  const path = await archive.path();
  expect(path).toBeTruthy();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Import package" }).first().click();
  await page.getByLabel("Upload package archive").setInputFiles(path!);
  await expect(
    page.getByRole("heading", { name: "Review package", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Install alias").fill("downloaded");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Installed downloaded" }),
  ).toBeVisible();
  expect(JSON.parse(readFileSync(raw.configPath, "utf8")).default_agent).toBe(
    "raw",
  );
});

test("package update failures and removal dependents stay actionable in their dialogs", async ({
  page,
  raw,
}) => {
  const folder = source(raw.root);
  await page.goto(raw.server.launchUrl);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("link", { name: "Packages", exact: true }).click();
  await page.getByRole("button", { name: "Import package" }).first().click();
  await page.getByLabel("Local package path").fill(folder);
  await page.getByRole("button", { name: "Inspect path", exact: true }).click();
  await page.getByLabel("Install alias").fill("shared");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("link", { name: "shared", exact: true }).click();
  await page.getByRole("button", { name: "Use agent", exact: true }).click();
  await page.getByLabel("Local agent name").fill("writer");
  await page.getByLabel("Input prompt", { exact: true }).fill("Prompt");
  await page
    .getByRole("button", { name: "Create agent binding", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Agent writer created" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Actions for shared" }).click();
  await page
    .getByRole("menuitem", { name: "Remove package", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove alias", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "agents.writer",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const manifest = JSON.parse(
    readFileSync(join(folder, "raw-package.json"), "utf8"),
  );
  delete manifest.exports.agents;
  writeFileSync(join(folder, "raw-package.json"), JSON.stringify(manifest));
  await page.getByRole("button", { name: "Actions for shared" }).click();
  await page
    .getByRole("menuitem", { name: "Update package", exact: true })
    .click();
  await page.getByLabel("Local package path").fill(folder);
  await page.getByRole("button", { name: "Inspect path", exact: true }).click();
  await page
    .getByRole("button", { name: "Update shared", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "would break",
  );
});
