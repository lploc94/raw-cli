import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { dashboardFixture } from "../fixtures/dashboard.js";

// Ad hoc native qualification on macOS, deliberately outside automated browser gates.
// Uses one disposable browser profile and restores the previously focused application.
const apple = (source: string, timeout = 10_000) => execFileSync("osascript", ["-e", source], { encoding: "utf8", timeout }).trim();
if (process.platform !== "darwin") throw new Error("This native smoke uses macOS accessibility automation");
const previous = Number(apple('tell application "System Events" to get unix id of first application process whose frontmost is true'));
const profile = mkdtempSync(join(tmpdir(), "raw-native-browser-"));
const raw = await dashboardFixture();
const context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null, args: ["--window-size=1280,1000", "--force-renderer-accessibility"] });
try {
  const page = context.pages()[0]!; page.setDefaultTimeout(15_000); await page.goto(raw.server.launchUrl);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  const cdp = await context.browser()!.newBrowserCDPSession();
  const info = await cdp.send("SystemInfo.getProcessInfo") as { processInfo: Array<{ type: string; id: number }> };
  const pid = info.processInfo.find(process => process.type === "browser")!.id;
  apple(`tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`);
  const baseline = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio }));
  for (let n = 0; n < 12 && (await page.evaluate(() => devicePixelRatio)) / baseline.ratio < 3.9; n++) {
    apple(`tell application "System Events" to tell first application process whose unix id is ${pid} to keystroke "+" using command down`);
    await page.waitForTimeout(150);
  }
  const zoomed = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth }));
  console.log(JSON.stringify({ baseline, zoomed, zoom: zoomed.ratio / baseline.ratio }));
  assert.ok(zoomed.ratio / baseline.ratio >= 3.9, "native browser zoom must reach 400%");
  assert.ok(zoomed.scrollWidth <= zoomed.width, "native zoom must not cause horizontal document overflow");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Check native zoom");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("answer", { exact: true })).toBeVisible();
  const pageCdp = await context.newCDPSession(page);
  // A surface screenshot uses CSS-sized bounds after native zoom and crops the bitmap.
  // Capture the actual browser view so qualification records the complete viewport.
  const capture = await pageCdp.send("Page.captureScreenshot", { format: "png", fromSurface: false });
  writeFileSync("docs/dashboard/chat-native-400-percent.png", Buffer.from(capture.data, "base64"));
  apple(`tell application "System Events" to tell first application process whose unix id is ${pid} to keystroke "0" using command down`);
  if (process.argv.includes("--voiceover")) {
    const wasRunning = apple('application "VoiceOver" is running') === "true";
    try {
      if (!wasRunning) execFileSync("open", ["-a", "/System/Library/CoreServices/VoiceOver.app"]);
      console.log("VoiceOver started; waiting for the native reader and any user permission prompt.");
      // The launcher may still be waiting for first-use consent. Focus only after
      // the reader itself exists, otherwise the consent dialog consumes focus.
      await expect.poll(() => spawnSync("pgrep", ["-x", "VoiceOver"]).status, { timeout: 45_000 }).toBe(0);
      console.log("VoiceOver reader is ready.");
      await page.waitForTimeout(5000);
      apple(`tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`);
      await page.getByRole("button", { name: "Session details", exact: true }).focus();
      await page.getByRole("textbox", { name: "Message", exact: true }).click();
      console.log("Manual listening: Message editor. Record the actual announcement separately.");
      await page.waitForTimeout(10_000);
      await page.getByRole("button", { name: "Session details", exact: true }).focus();
      console.log("Manual listening: Session details button. Record the actual announcement separately.");
      await page.waitForTimeout(10_000);
      console.log("Listening steps finished; this driver does not assert a screen-reader verdict.");
    } finally { if (!wasRunning) apple('tell application "VoiceOver" to quit'); }
  }
} finally {
  await context.close(); await raw.close(); rmSync(profile, { recursive: true, force: true });
  apple(`tell application "System Events" to set frontmost of first application process whose unix id is ${previous} to true`);
}
