const { test, expect } = require("@playwright/test");

const surfaces = [
  { name: "manage-empty",    action: async () => {} },
  { name: "manage-selected", action: async ({ page }) => {
    await page.locator("#matrixBody .skill-list-button").first().click();
  }},
];

for (const surface of surfaces) {
  test(`baseline:${surface.name}`, async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await surface.action({ page });
    await expect(page).toHaveScreenshot(`${surface.name}.png`, { fullPage: false, animations: "disabled", caret: "hide" });
  });
}
