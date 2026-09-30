import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/dashboard-ui",
  fullyParallel: true,
  workers: 3,
  forbidOnly: !!process.env.CI,
  timeout: 30000,
  expect: { timeout: 8000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/dashboard",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.RAW_TEST_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.RAW_TEST_CHROMIUM_EXECUTABLE } } : {}) } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
