import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { openAiDone, openAiFrame, startMockProvider } from "./fixtures/mock-provider.js";
import { makePng } from "./fixtures/images.js";

async function command(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(90_000) });
  let stdout = "", stderr = ""; child.stdout.on("data", part => { stdout += String(part); }); child.stderr.on("data", part => { stderr += String(part); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, `${bin} ${args[0]}: ${stderr}`); return { stdout, stderr };
}
async function sourceHash(repo: string) {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" });
  assert.equal(listed.status, 0); const hash = createHash("sha256");
  for (const file of [...new Set(listed.stdout.split("\0").filter(file => /^(src|bin|web|scripts)\//.test(file) || /^(package.*\.json|.*config.*\.(ts|json))$/.test(file)))].sort()) {
    if (!file || !existsSync(join(repo, file))) continue;
    hash.update(file + "\0"); hash.update(await readFile(join(repo, file))); hash.update("\0");
  }
  return hash.digest("hex");
}

test("packed dashboard configures, reconnects, updates a package, then installed CLI resumes the same ID", { timeout: 150_000 }, async t => {
  const repo = process.cwd(), root = await mkdtemp(join(tmpdir(), "raw-dashboard-installed-"));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RAW_"))),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") };
  const consumer = join(root, "consumer"), workspace = join(root, "unrelated-workspace"), author = join(root, "author");
  const call = { frames: [openAiFrame({ tool_calls: [{ index: 0, id: "effect", type: "function", function: { name: "package_echo", arguments: '{"text":"test"}' } }] }, "tool_calls"), openAiDone] };
  const answer = (content: string) => ({ frames: [openAiFrame({ content }, "stop"), openAiDone] });
  const provider = await startMockProvider([call, answer("First installed answer"), call, answer("Updated installed answer"), answer("Image turn answer"), answer("CLI continued")]);
  let host: ReturnType<typeof spawn> | undefined, closed: Promise<number | null> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let stdout = "", stderr = "";
  try {
    await mkdir(consumer); await mkdir(workspace); await mkdir(author);
    await writeFile(join(consumer, "package.json"), '{"name":"raw-dashboard-consumer","private":true,"type":"module"}\n');
    const packed = await command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], repo, env);
    const tarball = join(root, (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename);
    const artifactHash = createHash("sha256").update(await readFile(tarball)).digest("hex");
    await command("npm", ["install", "--omit=dev", "--prefer-offline", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer, env);
    const installed = join(consumer, "node_modules/raw-cli"), bin = join(consumer, "node_modules/.bin/raw");
    assert.equal(existsSync(join(consumer, "node_modules/vite")), false);
    for (const file of ["docs/dashboard.md", "docs/dashboard-api.md", "docs/cli.md", "docs/architecture.md", "docs/hooks.md", "examples/hooks/guard/hook.json", "dist/dashboard/index.html"]) {
      assert.ok(existsSync(join(installed, file)), `installed artifact is missing ${file}`);
    }
    for (const skill of ["configure_raw", "create_agent", "create_skill", "create_tool", "create_hook", "add_mcp", "create_package"]) {
      assert.match(await readFile(join(installed, "dist/skills/builtin", skill, "SKILL.md"), "utf8"), /references\/dashboard\.md/);
      assert.ok((await readFile(join(installed, "dist/skills/builtin", skill, "references/dashboard.md"), "utf8")).length > 300);
    }
    // Author from installed examples, never from the checkout; model-facing execution is a real file effect.
    const source = join(author, "kit"); await cp(join(installed, "examples/packages/tool-only"), source, { recursive: true });
    await mkdir(join(source, "agents"));
    await mkdir(join(source, "hooks"), { recursive: true });
    await cp(join(installed, "examples/hooks/guard"), join(source, "hooks", "notice"), { recursive: true });
    await writeFile(join(source, "hooks/notice/hook.json"), JSON.stringify({ protocol_version: 2, name: "notice", events: [{ name: "UserPromptSubmit" }], command: "node", args: ["./index.mjs"] }));
    await writeFile(join(source, "hooks/notice/index.mjs"), `import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
      process.stdin.resume(); process.stdin.on('end', () => {appendFileSync(join(process.cwd(),'hook-effects.txt'),'notice\\n'); process.stdout.write(JSON.stringify({message:'Installed hook ran'}));});`);
    await writeFile(join(source, "agents/writer.json"), JSON.stringify({ system_prompt: "Installed package writer", tools: { use: ["#tools/echo"] }, hooks: { use: ["#hooks/notice"] } }));
    const manifest = JSON.parse(await readFile(join(source, "raw-package.json"), "utf8"));
    manifest.files.push("agents/writer.json", "hooks/notice"); manifest.exports.agents = { writer: "agents/writer.json" };
    manifest.exports.hooks = { notice: "hooks/notice" }; manifest.requires.push("raw.hook/2");
    await writeFile(join(source, "raw-package.json"), JSON.stringify(manifest));
    await writeFile(join(source, "tools/echo/helper.mjs"), 'export const value="v1";\n');
    await writeFile(join(source, "tools/echo/index.mjs"), `import {value} from './helper.mjs'; import {appendFileSync,existsSync} from 'node:fs'; import {join} from 'node:path';
      export async function handler(args,context){appendFileSync(join(context.cwd,'effects.txt'),value+'\\n'); while(!existsSync(join(context.cwd,'release'))) await new Promise(r=>setTimeout(r,20)); return {isError:false,content:[{type:'text',text:value}]};}\n`);
    host = spawn(bin, ["dashboard", "--port", "0", "--no-open"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    host.stdout!.on("data", part => { stdout += String(part); }); host.stderr!.on("data", part => { stderr += String(part); });
    closed = new Promise((resolve, reject) => { host!.once("close", resolve); host!.once("error", reject); });
    await expect.poll(() => (stdout + stderr).match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/)?.[0], { timeout: 15_000 }).toBeTruthy();
    const launchUrl = (stdout + stderr).match(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/)![0];
    const origin = new URL(launchUrl).origin;
    browser = await chromium.launch(process.env.RAW_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.RAW_TEST_CHROMIUM_EXECUTABLE } : {}); const browserVersion = browser.version(); const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    const assets = new Set<string>(), errors: string[] = [], external: string[] = [];
    await page.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); external.push(url.origin); return route.abort(); });
    page.on("response", response => { if (response.url().includes("/assets/")) { assert.ok(response.ok(), response.url()); assets.add(response.url()); } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(launchUrl); await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Initialize Raw", exact: true }).click();
    await expect(page.getByText("Config initialized", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Models & connections", exact: true }).click();
    await page.getByRole("link", { name: "local", exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).fill("openai");
    await page.getByLabel("Base URL", { exact: true }).fill(provider.url); await page.getByLabel("Model ID", { exact: true }).fill("installed-fixture");
    await page.getByLabel("Context window tokens", { exact: true }).fill("16384");
    await page.getByLabel("Credential action", { exact: true }).selectOption("value"); await page.getByLabel("New API key", { exact: true }).fill("installed-fixture-key");
    await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    assert.ok([...assets].some(url => /CodeEditor.*\.js/.test(url)), "lazy editor assets must be loaded from installed package");
    await page.getByRole("link", { name: "Library", exact: true }).click(); await page.getByRole("link", { name: "Packages", exact: true }).click();
    await page.getByRole("button", { name: "Import package" }).first().click(); await page.getByLabel("Local package path").fill(source); await page.getByRole("button", { name: "Inspect path", exact: true }).click();
    await page.getByLabel("Install alias").fill("kit"); await page.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Installed kit" })).toBeVisible();
    await page.getByRole("link", { name: "kit", exact: true }).click(); await page.getByRole("button", { name: "Use agent", exact: true }).click();
    await page.getByLabel("Local agent name").fill("writer"); await page.getByRole("button", { name: "Create agent binding", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Agent writer created" })).toBeVisible(); await page.getByRole("button", { name: "Chat with writer", exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const id = new URL(page.url()).pathname.split("/").at(-1)!; assert.match(id, /^[0-9a-f-]{36}$/);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("First installed turn"); await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => existsSync(join(workspace, "effects.txt")), { timeout: 15_000 }).toBe(true);
    assert.equal(await readFile(join(workspace, "hook-effects.txt"), "utf8"), "notice\n");
    await page.reload(); await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    assert.equal(await readFile(join(workspace, "effects.txt"), "utf8"), "v1\n"); await writeFile(join(workspace, "release"), "continue");
    await expect(page.getByText("First installed answer", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Side panel", exact: true }).click(); await page.getByRole("button", { name: "Details", exact: true }).click(); await expect(page.getByText(/16,384/).first()).toBeVisible(); await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Library", exact: true }).click(); await page.getByRole("link", { name: "Packages", exact: true }).click(); await page.getByRole("link", { name: "kit", exact: true }).click();
    await writeFile(join(source, "tools/echo/helper.mjs"), 'export const value="v2";\n');
    await page.getByRole("button", { name: "Actions for kit" }).click(); await page.getByRole("menuitem", { name: "Update package", exact: true }).click(); await page.getByLabel("Local package path").fill(source); await page.getByRole("button", { name: "Inspect path", exact: true }).click();
    await page.getByRole("button", { name: "Update kit", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: "Updated kit" })).toBeVisible();
    await rm(author, { recursive: true });
    await page.goto(`${origin}/chat/${id}`); await page.getByRole("textbox", { name: "Message", exact: true }).fill("After package update"); await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Updated installed answer", { exact: true })).toBeVisible(); assert.equal(await readFile(join(workspace, "effects.txt"), "utf8"), "v1\nv2\n");
    assert.equal(await readFile(join(workspace, "hook-effects.txt"), "utf8"), "notice\nnotice\n");
    // An image turn from the installed artifact: this agent's model has no vision, so the model receives a placeholder and the turn is not blocked.
    const png = makePng();
    await page.locator("input[type=file]").setInputFiles({ name: "installed.png", mimeType: "image/png", buffer: png });
    await expect(page.locator(".attachment-chip.ready", { hasText: "installed.png" })).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Look at this image"); await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Image turn answer", { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByTestId("user-message").last().locator("img")).toBeVisible();
    assert.deepEqual(errors, []); assert.deepEqual(external, []); await browser.close(); browser = undefined;
    host.kill("SIGTERM"); assert.equal(await closed, 0); host = undefined;
    const resumed = await command(bin, ["--resume", id, "Continue in CLI"], workspace, env); assert.equal(resumed.stdout, "CLI continued\n"); assert.match(resumed.stderr, new RegExp(id));
    assert.equal(await readFile(join(workspace, "hook-effects.txt"), "utf8"), "notice\nnotice\nnotice\nnotice\n"); // three dashboard turns (the third is the image turn) and the CLI turn
    const requests = provider.requests.map(item => item.body as { prompt_cache_key: string; messages: unknown[]; tools: unknown[] });
    assert.equal(requests.length, 6); assert.notEqual(requests[0]!.prompt_cache_key, requests[2]!.prompt_cache_key); assert.equal(requests[2]!.prompt_cache_key, requests[5]!.prompt_cache_key);
    const imageRequest = JSON.stringify(requests[4]); assert.match(imageRequest, /Image omitted/); assert.doesNotMatch(imageRequest, /image_url/); assert.ok(!imageRequest.includes(png.toString("base64")));
    assert.deepEqual(requests[5]!.messages.slice(0, requests[4]!.messages.length), requests[4]!.messages); assert.deepEqual(requests[5]!.tools, requests[4]!.tools);
    assert.equal(await readFile(join(workspace, "effects.txt"), "utf8"), "v1\nv2\n");
    const dependencyHash = createHash("sha256").update(await readFile(join(consumer, "package-lock.json"))).digest("hex");
    const staticFiles = (await readdir(join(installed, "dist/dashboard/assets"))).sort();
    t.diagnostic(JSON.stringify({ artifactSha256: artifactHash, sourceManifestSha256: await sourceHash(repo), installedLockSha256: dependencyHash,
      node: process.version, platform: process.platform, release: release(), architecture: process.arch, browser: "chromium", browserVersion, assets: staticFiles, loadedAssetCount: assets.size }));
  } finally {
    if (existsSync(workspace)) await writeFile(join(workspace, "release"), "cleanup");
    await browser?.close(); if (host) { host.kill("SIGTERM"); await closed; }
    await provider.close(); await rm(root, { recursive: true, force: true });
  }
});
