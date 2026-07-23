// Playwright smoke suite for the marketplace browse cards (spec:
// docs/superpowers/specs/2026-07-22-marketplace-installed-descriptions-design.md).
//
// Same mocking setup as mcp-servers.spec.js / git-install.spec.js: every
// /api/** request is intercepted and fulfilled from fixtures, so no backend
// runs. Chromium enforces CORS on fulfilled cross-origin responses, hence
// the access-control-allow-origin header on every fulfill.
const { test, expect } = require("@playwright/test");

const TARGETS = [
  { id: "claude-global", label: "Claude Code (global)", scope: "global", path: "/mock/.claude/skills" },
];

const STATE = {
  appHome: "/mock/.skillworks",
  configPath: "/mock/.skillworks/config.json",
  vaultRoot: "/mock/vault",
  project: { path: "", exists: false },
  recentProjects: [],
  projects: [],
  skills: [
    {
      id: "rust-best-practices",
      name: "Rust Best Practices",
      path: "/mock/vault/rust-best-practices",
    },
  ],
  customTargets: [],
  hiddenTargetIds: [],
  targets: TARGETS,
  summary: { skillCount: 1, targetCount: 1, enabledCount: 0, unmanagedCount: 0 },
  discovery: {
    sources: [],
    summary: { sourceCount: 0, existingCount: 0, importableCount: 0 },
  },
  suggestedImports: [],
};

const RUST_ID = "apollographql/skills/rust-best-practices";
const APOLLO_ID = "apollographql/skills/apollo-connectors";
const RUST_DESCRIPTION = "Idiomatic Rust patterns and common pitfalls.";

const MARKETPLACE = {
  data: [
    {
      id: RUST_ID,
      slug: "rust-best-practices",
      name: "Rust Best Practices",
      source: "apollographql/skills",
      sourceType: "github",
      installUrl: "https://github.com/apollographql/skills",
      url: `https://skills.sh/${RUST_ID}`,
    },
    {
      id: APOLLO_ID,
      slug: "apollo-connectors",
      name: "Apollo Connectors",
      source: "apollographql/skills",
      sourceType: "github",
      installUrl: "https://github.com/apollographql/skills",
      url: `https://skills.sh/${APOLLO_ID}`,
    },
  ],
  pagination: { page: 0, perPage: 25, total: 2 },
};

async function installApiMocks(page) {
  const descriptionCalls = [];

  const fulfillJson = (route, json, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(json),
    });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/state") {
      return fulfillJson(route, STATE);
    }
    if (method === "GET" && pathname === "/api/sets") {
      return fulfillJson(route, {
        global: [],
        project: [],
        pinned: { ids: [], resolved: [], missing: [] },
      });
    }
    if (method === "GET" && pathname === "/api/marketplace/skills") {
      return fulfillJson(route, MARKETPLACE);
    }
    if (method === "POST" && pathname === "/api/marketplace/descriptions") {
      descriptionCalls.push(request.postDataJSON());
      // Rust gets a real description; Apollo's page had no meta
      // description, so the backend cached an empty string.
      return fulfillJson(route, { [RUST_ID]: RUST_DESCRIPTION, [APOLLO_ID]: "" });
    }
    return fulfillJson(route, {});
  });

  return { descriptionCalls };
}

async function openBrowseTab(page) {
  await page.goto("/");
  await page.locator('[data-top-tab="install"]').click();
}

// See mcp-servers.spec.js for why this try/catch exists: plain `node --test`
// also discovers this file and would otherwise fail on test.describe().
try {
  test.describe("marketplace browse cards", () => {
    test.beforeEach(async ({ page }) => {
      await installApiMocks(page);
    });

    test("installed pill renders only on the card matching a vault skill", async ({ page }) => {
      await openBrowseTab(page);

      const cards = page.locator(".marketplace-card");
      await expect(cards).toHaveCount(2);
      await expect(page.locator(".marketplace-installed")).toHaveCount(1);

      const rustCard = cards.filter({ hasText: "Rust Best Practices" });
      await expect(rustCard.locator(".marketplace-installed")).toHaveText("Installed");
      await expect(rustCard.locator("[data-marketplace-install]")).toHaveText("Use Git again");

      const apolloCard = cards.filter({ hasText: "Apollo Connectors" });
      await expect(apolloCard.locator(".marketplace-installed")).toHaveCount(0);
      await expect(apolloCard.locator("[data-marketplace-install]")).toHaveText("Use Git");

      await page.screenshot({ path: "test-results/marketplace-cards.png" });
    });

    test("descriptions hydrate lazily and empty results keep the placeholder", async ({ page }) => {
      const { descriptionCalls } = await installApiMocks(page);
      await openBrowseTab(page);
      await expect(page.locator(".marketplace-card")).toHaveCount(2);

      // Rust's card gets patched in place with the fetched description.
      const rustDesc = page.locator(`[data-marketplace-desc="${RUST_ID}"]`);
      await expect(rustDesc).toHaveText(RUST_DESCRIPTION);
      await expect(rustDesc).not.toHaveClass(/marketplace-desc-empty/);

      // Apollo's cached-empty description keeps the muted placeholder.
      const apolloDesc = page.locator(`[data-marketplace-desc="${APOLLO_ID}"]`);
      await expect(apolloDesc).toHaveText("No description available.");
      await expect(apolloDesc).toHaveClass(/marketplace-desc-empty/);

      // One hydration request carrying exactly the undescribed visible ids.
      await expect.poll(() => descriptionCalls.length).toBe(1);
      expect(descriptionCalls[0].ids.sort()).toEqual([APOLLO_ID, RUST_ID].sort());
    });

    test("busy toast appears during slow actions and never flashes on fast ones", async ({ page }) => {
      await openBrowseTab(page);
      await expect(page.locator(".marketplace-card")).toHaveCount(2);

      // Fast path: the initial load answered from instant mocks, so the
      // 300ms grace period must have kept the pill hidden.
      const busyToast = page.locator("#busyToast");
      await expect(busyToast).not.toHaveClass(/visible/);

      // Slow path: a later-registered route wins in Playwright, so this
      // delays only the refresh fetch.
      await page.route("**/api/marketplace/skills*", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(MARKETPLACE),
        });
      });
      await page.locator("#marketplaceRefreshButton").click();
      await expect(busyToast).toHaveClass(/visible/);
      // The action completing hides the pill again.
      await expect(busyToast).not.toHaveClass(/visible/);
    });
  });
} catch (error) {
  if (!/Playwright Test did not expect/.test(String(error && error.message))) {
    throw error;
  }
}
