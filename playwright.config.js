const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:5173", reuseExistingServer: true, timeout: 20_000 },
  projects: [
    { name: "narrow",  use: { ...devices["Desktop Chrome"], viewport: { width: 800,  height: 700  } } },
    { name: "laptop",  use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800  } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
    { name: "wide",    use: { ...devices["Desktop Chrome"], viewport: { width: 2200, height: 1200 } } },
  ],
});
