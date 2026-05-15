const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

/**
 * a11y/all-tabs.spec.js — WCAG 2.2 AA scan of all workspace tabs.
 *
 * Iterates each tab and runs an axe-core scan. Serious/critical violations
 * must be zero. This replaces the single-tab manage.spec.js.
 */

const TABS = ["manage", "install", "sets", "configure", "cleanup"];

test.describe("all tabs — WCAG 2.2 AA serious/critical clean", () => {
  for (const tab of TABS) {
    test(`tab "${tab}"`, async ({ page }) => {
      await page.goto("/");
      
      // Switch to the target tab
      const tabButton = page.locator(`[data-top-tab="${tab}"]`);
      await tabButton.click();
      
      // Wait for content to load
      await page.waitForTimeout(500);
      
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
        .analyze();
      
      const blocking = results.violations.filter((v) => ["serious", "critical"].includes(v.impact));
      expect(blocking, `Tab "${tab}" has ${blocking.length} serious/critical violations`).toEqual([]);
    });
  }
});
