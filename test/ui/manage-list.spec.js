// Playwright smoke suite for the manage-tab skill list (spec:
// docs/superpowers/specs/2026-07-23-vault-loading-performance-design.md).
//
// Selection is handled by delegated listeners and patches row classes in
// place — clicking a row must NOT rebuild the 1500-row list. The DOM-identity
// probe (an expando dataset flag on an untouched row) proves no re-render.
//
// Same mocking setup as marketplace.spec.js: every /api/** request is
// fulfilled from fixtures, so no backend runs.
const { test, expect } = require("@playwright/test");

const TARGETS = [
  {
    id: "claude-global",
    label: "Claude Code (global)",
    shortLabel: "Claude",
    scope: "global",
    path: "/mock/.claude/skills",
    // Slim map: only enabled/conflict entries are present; absent = disabled.
    skillStatuses: {
      "a/alpha": {
        enabled: true,
        managed: true,
        linkName: "alpha",
        linkPath: "/mock/.claude/skills/alpha",
        conflict: false,
        staleManifest: false,
      },
    },
    enabledSkillIds: ["a/alpha"],
    unmanaged: [],
  },
];

const SKILLS = [
  { id: "a/alpha", name: "Alpha", description: "First skill", author: "a", tags: ["General"], path: "/mock/vault/a/alpha" },
  { id: "b/beta", name: "Beta", description: "Second skill", author: "b", tags: ["General"], path: "/mock/vault/b/beta" },
  { id: "c/gamma", name: "Gamma", description: "Third skill", author: "c", tags: ["General"], path: "/mock/vault/c/gamma" },
];

const STATE = {
  appHome: "/mock/.skillworks",
  configPath: "/mock/.skillworks/config.json",
  vaultRoot: "/mock/vault",
  project: { path: "", exists: false },
  recentProjects: [],
  projects: [],
  skills: SKILLS,
  customTargets: [],
  hiddenTargetIds: [],
  targets: TARGETS,
  summary: { skillCount: 3, targetCount: 1, enabledCount: 1, unmanagedCount: 0 },
  discovery: {
    sources: [],
    summary: { sourceCount: 0, existingCount: 0, importableCount: 0 },
  },
  suggestedImports: [],
};

async function installApiMocks(page) {
  const fulfillJson = (route, json) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(json),
    });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state") {
      return fulfillJson(route, STATE);
    }
    if (url.pathname === "/api/sets") {
      return fulfillJson(route, {
        global: [],
        project: [],
        pinned: { ids: [], resolved: [], missing: [] },
      });
    }
    return fulfillJson(route, {});
  });
}

// See mcp-servers.spec.js for why this try/catch exists: plain `node --test`
// also discovers this file and would otherwise fail on test.describe().
try {
  test.describe("manage skill list", () => {
    test.beforeEach(async ({ page }) => {
      await installApiMocks(page);
      await page.goto("/");
      await expect(page.locator(".skill-list-item")).toHaveCount(3);
    });

    test("row click selects in place without rebuilding the list", async ({ page }) => {
      // Probe an unrelated row: if the list re-rendered, the expando is gone.
      await page.evaluate(() => {
        document.querySelectorAll(".skill-list-item")[2].dataset.probe = "kept";
      });

      const rows = page.locator(".skill-list-item");
      await rows.first().locator(".skill-list-button").click();
      await expect(rows.first()).toHaveClass(/is-selected/);
      await expect(page.locator("#skillDetail")).toBeVisible();

      // Selecting another row moves the class and still keeps DOM identity.
      await rows.nth(1).locator(".skill-list-button").click();
      await expect(rows.nth(1)).toHaveClass(/is-selected/);
      await expect(rows.first()).not.toHaveClass(/is-selected/);

      const probe = await page.evaluate(
        () => document.querySelectorAll(".skill-list-item")[2].dataset.probe,
      );
      expect(probe).toBe("kept");
    });

    test("row checkbox updates selection without rebuilding the list", async ({ page }) => {
      await page.evaluate(() => {
        document.querySelectorAll(".skill-list-item")[2].dataset.probe = "kept";
      });

      const firstCheckbox = page.locator('[data-select-row="a/alpha"]');
      await firstCheckbox.check();
      await expect(firstCheckbox).toBeChecked();

      const probe = await page.evaluate(
        () => document.querySelectorAll(".skill-list-item")[2].dataset.probe,
      );
      expect(probe).toBe("kept");

      // Checking every visible row syncs the select-visible checkbox.
      await page.locator('[data-select-row="b/beta"]').check();
      await page.locator('[data-select-row="c/gamma"]').check();
      await expect(page.locator("#selectVisibleCheckbox")).toBeChecked();
    });

    test("slim skillStatuses render enabled and disabled assignments", async ({ page }) => {
      const rows = page.locator(".skill-list-item");
      // Alpha has a status entry -> shows the target's short label.
      await expect(rows.first().locator(".assignment-summary")).toHaveText("Claude");
      // Beta has no entry in the slim map -> reads as disabled.
      await expect(rows.nth(1).locator(".assignment-summary")).toHaveText("Disabled");
    });
  });
} catch (error) {
  if (!/Playwright Test did not expect/.test(String(error && error.message))) {
    throw error;
  }
}
