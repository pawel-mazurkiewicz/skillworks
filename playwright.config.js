// Minimal Playwright config for the MCP Servers tab smoke suite (Phase D,
// Task 10, spec §8). Chromium only, headless, against the Vite dev server —
// the app has no built-in test server, so `webServer` boots `npm run dev`
// (which wraps `vite`) and waits on its URL before tests run.
//
// The suite mocks every `/api/**` request via `page.route()` (see
// test/ui/mcp-servers.spec.js) — no backend process is required.
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/ui",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
