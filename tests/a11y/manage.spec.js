const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

test("manage tab — WCAG 2.2 AA serious/critical clean", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter((v) => ["serious", "critical"].includes(v.impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
