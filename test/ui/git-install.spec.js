// Playwright smoke suite for the pick-and-choose git install flow (spec:
// docs/superpowers/specs/2026-07-22-git-install-skill-selection-design.md).
//
// Same mocking setup as mcp-servers.spec.js: outside Tauri the api-shim
// fetches http://127.0.0.1:5179/api/*; every request is intercepted with
// page.route() and fulfilled from the fixtures below, so no backend runs.
// Chromium enforces CORS on fulfilled cross-origin responses, hence the
// access-control-allow-origin header on every fulfill.
const { test, expect } = require("@playwright/test");

const TARGETS = [
  { id: "claude-global", label: "Claude Code (global)", scope: "global", path: "/mock/.claude/skills" },
  { id: "codex-global", label: "Codex (global)", scope: "global", path: "/mock/.codex/skills" },
];

const STATE = {
  appHome: "/mock/.skillworks",
  configPath: "/mock/.skillworks/config.json",
  vaultRoot: "/mock/vault",
  project: { path: "", exists: false },
  recentProjects: [],
  projects: [],
  skills: [],
  customTargets: [],
  hiddenTargetIds: [],
  targets: TARGETS,
  summary: { skillCount: 0, targetCount: 2, enabledCount: 0, unmanagedCount: 0 },
  discovery: {
    sources: [],
    summary: { sourceCount: 0, existingCount: 0, importableCount: 0 },
  },
  suggestedImports: [],
};

const REPO_URL = "https://github.com/apollographql/skills";

function targetLinksFor(linkName) {
  return TARGETS.map((t) => ({
    targetId: t.id,
    targetLabel: t.label,
    scope: t.scope,
    linkName,
    linkPath: `${t.path}/${linkName}`,
  }));
}

const PLAN = {
  source: { repoUrl: REPO_URL, ref: "", subdir: "" },
  vaultRoot: "/mock/vault",
  candidates: [
    {
      name: "Rust Best Practices",
      sourcePath: "/tmp/clone/skills/rust-best-practices",
      realSourcePath: "/tmp/clone/skills/rust-best-practices",
      sourceKey: "skills/rust-best-practices",
      kind: "directory",
      action: "move",
      skipReason: "",
      willDedupe: false,
      vaultDestination: "/mock/vault/rust-best-practices",
      linkName: "rust-best-practices",
      targetLinks: targetLinksFor("rust-best-practices"),
    },
    {
      name: "Apollo Connectors",
      sourcePath: "/tmp/clone/skills/apollo-connectors",
      realSourcePath: "/tmp/clone/skills/apollo-connectors",
      sourceKey: "skills/apollo-connectors",
      kind: "directory",
      action: "move",
      skipReason: "",
      willDedupe: false,
      vaultDestination: "/mock/vault/apollo-connectors",
      linkName: "apollo-connectors",
      targetLinks: targetLinksFor("apollo-connectors"),
    },
  ],
  targets: TARGETS,
  summary: { candidates: 2, toMove: 2, toDedupe: 0, toSkip: 0 },
};

const MARKETPLACE = {
  data: [
    {
      id: "apollographql/skills/rust-best-practices",
      slug: "rust-best-practices",
      name: "Rust Best Practices",
      source: "apollographql/skills",
      sourceType: "github",
      installUrl: REPO_URL,
      url: "https://skills.sh/apollographql/skills/rust-best-practices",
    },
  ],
  pagination: { page: 0, perPage: 25, total: 1 },
};

// Installs the /api/** mocks. Returns a log of install POST bodies the
// tests assert against.
async function installApiMocks(page) {
  const installCalls = [];

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
    if (method === "POST" && pathname === "/api/install-git/preview") {
      return fulfillJson(route, PLAN);
    }
    if (method === "POST" && pathname === "/api/install-git") {
      installCalls.push(request.postDataJSON());
      return fulfillJson(route, {
        state: STATE,
        report: { imported: 1, skipped: 0, enabled: 2, errors: 0 },
      });
    }
    return fulfillJson(route, {});
  });

  return { installCalls };
}

async function openFromGitTab(page) {
  await page.goto("/");
  await page.locator('[data-top-tab="install"]').click();
  await page.locator('[data-install-tab="git"]').click();
}

// See mcp-servers.spec.js for why this try/catch exists: plain `node --test`
// also discovers this file and would otherwise fail on test.describe().
try {
  test.describe("git install skill selection", () => {
    test.beforeEach(async ({ page }) => {
      await installApiMocks(page);
    });

    test("preview renders install checkboxes and unchecking updates count and greys the target grid", async ({ page }) => {
      await openFromGitTab(page);
      await page.locator("#gitRepoInput").fill(REPO_URL);
      await page.locator("#gitPreviewButton").click();

      const items = page.locator(".preview-item");
      await expect(items).toHaveCount(2);
      const toggles = page.locator("input[data-install-key]");
      await expect(toggles).toHaveCount(2);
      await expect(toggles.nth(0)).toBeChecked();
      await expect(toggles.nth(1)).toBeChecked();
      await expect(page.locator("#previewSelectedCount")).toHaveText("installing 2 of 2");

      // Uncheck the Apollo skill.
      await page.locator('input[data-install-key="skills/apollo-connectors"]').uncheck();
      await expect(page.locator("#previewSelectedCount")).toHaveText("installing 1 of 2");
      const apolloItem = page.locator('.preview-item[data-source-key="skills/apollo-connectors"]');
      await expect(apolloItem).toHaveClass(/deselected/);
      await expect(
        apolloItem.locator("input[data-skill-key]").first(),
      ).toBeDisabled();

      await page.screenshot({ path: "test-results/git-install-selection.png" });
    });

    test("install payload carries only the selected source keys", async ({ page }) => {
      const { installCalls } = await installApiMocks(page);
      await openFromGitTab(page);
      await page.locator("#gitRepoInput").fill(REPO_URL);
      await page.locator("#gitPreviewButton").click();
      await expect(page.locator("#previewSelectedCount")).toHaveText("installing 2 of 2");

      await page.locator('input[data-install-key="skills/apollo-connectors"]').uncheck();
      await page.locator('#gitInstallForm button[type="submit"]').click();

      await expect.poll(() => installCalls.length).toBe(1);
      const body = installCalls[0];
      expect(body.selectedSourceKeys).toEqual(["skills/rust-best-practices"]);
      expect(Object.keys(body.perSkillTargets)).toEqual(["skills/rust-best-practices"]);
    });

    test("empty selection blocks submit with a toast and no request", async ({ page }) => {
      const { installCalls } = await installApiMocks(page);
      await openFromGitTab(page);
      await page.locator("#gitRepoInput").fill(REPO_URL);
      await page.locator("#gitPreviewButton").click();

      await page.locator('input[data-install-key="skills/rust-best-practices"]').uncheck();
      await page.locator('input[data-install-key="skills/apollo-connectors"]').uncheck();
      await expect(page.locator("#previewSelectedCount")).toHaveText("installing 0 of 2");
      await page.locator('#gitInstallForm button[type="submit"]').click();

      // Toast appears; no install request fired. The app has a single
      // persistent #toast element (public/index.html) whose text/visible
      // class are updated in place by showToast() (public/app.js) — there's
      // no list of stacked `.toast` nodes to disambiguate with `.last()`.
      await expect(page.locator("#toast")).toHaveText("No skills selected");
      expect(installCalls.length).toBe(0);
    });

    test("marketplace install auto-previews with only the clicked skill selected", async ({ page }) => {
      const { installCalls } = await installApiMocks(page);
      await page.goto("/");
      await page.locator('[data-top-tab="install"]').click();
      // Browse/Marketplace is the default install sub-tab and it triggers its
      // own loadMarketplace() the first time the Install tab is opened
      // (public/app.js's top-tab click handler) — wait for the mocked card
      // to actually render before clicking its install button.
      const installButton = page.locator('[data-marketplace-install]').first();
      await expect(installButton).toBeVisible();
      await installButton.click();

      // Jumped to From Git with the preview auto-run and only the clicked
      // slug selected.
      await expect(page.locator("#gitRepoInput")).toHaveValue(REPO_URL);
      await expect(page.locator("#previewSelectedCount")).toHaveText("installing 1 of 2");
      await expect(
        page.locator('input[data-install-key="skills/rust-best-practices"]'),
      ).toBeChecked();
      await expect(
        page.locator('input[data-install-key="skills/apollo-connectors"]'),
      ).not.toBeChecked();

      await page.locator('#gitInstallForm button[type="submit"]').click();
      await expect.poll(() => installCalls.length).toBe(1);
      expect(installCalls[0].selectedSourceKeys).toEqual(["skills/rust-best-practices"]);

      await page.screenshot({ path: "test-results/git-install-marketplace.png" });
    });
  });
} catch (error) {
  if (!/Playwright Test did not expect/.test(String(error && error.message))) {
    throw error;
  }
}
