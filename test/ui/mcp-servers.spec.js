// Playwright smoke suite for the MCP Servers tab (Phase D, Task 10, spec
// §8 of docs/superpowers/specs/2026-07-21-mcp-management-phase-d-design.md).
//
// The app has no Node sidecar in the desktop build, but `public/api-shim.js`
// keeps a browser/dev fallback: outside of Tauri it calls `fetch()` against
// `http://127.0.0.1:5179/api/*` (see FETCH_API_ORIGIN + apiUrl() there). We
// never run that legacy server — instead every `/api/**` request is
// intercepted with `page.route()` and fulfilled from fixtures below, so the
// suite has no backend dependency at all.
const { test, expect } = require("@playwright/test");

const SERVERS = [
  {
    id: "everything",
    name: "Everything (stdio demo)",
    description: "Reference stdio MCP server used for local demos.",
    source: { kind: "manual" },
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    env: {},
    url: "",
    headers: {},
    variants: [],
  },
  {
    id: "weather-api",
    name: "Weather API",
    description: "Remote weather MCP server.",
    source: { kind: "url", value: "https://example.com/weather/mcp.json" },
    transport: "http",
    command: "",
    args: [],
    env: {},
    url: "https://weather.example.com/mcp",
    headers: {},
    variants: [],
  },
];

// mcp_reconcile fixture (Task 6, spec §6): one unmanaged import candidate
// found in a harness config, and one drift entry where the harness's
// on-disk invocation no longer matches the library's stored spec.
const RECONCILE_FIXTURE = {
  imports: [
    {
      key: "ctx",
      suggestedSpec: {
        id: "ctx",
        name: "ctx",
        source: { kind: "discovered" },
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        env: {},
        headers: {},
        variants: [],
      },
      foundIn: [{ harness: "cursor", scope: "global", configPath: "/tmp/cursor.json" }],
      warnings: [],
    },
  ],
  conflicts: [
    {
      serverId: "context7",
      harness: "cursor",
      scope: "global",
      configPath: "/tmp/cursor.json",
      diff: [{ field: "args", expected: "-y a", observed: "-y a --v" }],
      observedSpec: {
        id: "context7",
        name: "Context7",
        source: { kind: "manual" },
        transport: "stdio",
        command: "npx",
        args: ["-y", "a", "--v"],
        env: {},
        headers: {},
        variants: [],
      },
    },
  ],
  warnings: [],
};

// Default (empty) mcp_reconcile response — no unmanaged imports, no drift.
// Tests that want to exercise the Reconcile panel pass a `reconcile`
// override to installApiMocks (see the "reconcile panel" spec below); per
// Playwright's routing model the most-recently-registered page.route
// handler for an overlapping pattern runs first, so calling
// installApiMocks(page, { reconcile }) again inside a test body fully
// takes over every /api/** request for that test.
const EMPTY_RECONCILE = { imports: [], conflicts: [], warnings: [] };

// Installs a single catch-all handler for every /api/** request the app can
// issue during boot + the MCP Servers smoke flow. Returns a log the tests
// can assert against (e.g. which activate/deactivate calls fired) and a
// mutable `statuses` array so a toggle's effect is visible on the next
// GET /api/mcp/servers/status refresh (mirrors real backend behavior).
async function installApiMocks(page, { reconcile = EMPTY_RECONCILE } = {}) {
  const activationLog = [];
  let statuses = [];

  // The app's browser fallback (public/api-shim.js FETCH_API_ORIGIN) fetches
  // `/api/*` against `http://127.0.0.1:5179`, a different origin than the
  // Vite dev server (`http://127.0.0.1:5173`) the page is served from. Even
  // though Playwright intercepts the request before it hits the network,
  // Chromium still enforces CORS on the *fulfilled* response — so every
  // mocked response needs an explicit allow-origin header or the page's
  // fetch() call rejects with a CORS error and the UI never sees the data.
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

    if (method === "GET" && pathname === "/api/mcp/servers") {
      return fulfillJson(route, { servers: SERVERS });
    }
    if (method === "GET" && pathname === "/api/mcp/servers/status") {
      return fulfillJson(route, statuses);
    }
    if (method === "GET" && pathname === "/api/mcp/servers/discover") {
      return fulfillJson(route, []);
    }
    if (method === "GET" && pathname === "/api/mcp/servers/reconcile") {
      return fulfillJson(route, reconcile);
    }
    if (method === "POST" && pathname === "/api/mcp/servers/from-url") {
      const body = request.postDataJSON();
      return fulfillJson(route, {
        sourceUrl: body.url,
        fetchedUrl: body.url,
        warnings: [],
        drafts: [
          {
            spec: {
              id: "parsed-server",
              name: "Parsed Server",
              description: "",
              source: { kind: "url", value: body.url },
              transport: "stdio",
              command: "npx",
              args: ["-y", "parsed-server"],
              env: {},
              url: "",
              headers: {},
              variants: [],
            },
            evidence: ["Found a stdio command block in the README."],
          },
        ],
      });
    }
    const activateMatch = pathname.match(
      /^\/api\/mcp\/servers\/([^/]+)\/(activate|deactivate)$/
    );
    if (method === "POST" && activateMatch) {
      const [, id, action] = activateMatch;
      const body = request.postDataJSON();
      activationLog.push({ id, action, harness: body.harness, scope: body.scope });
      statuses = statuses.filter(
        (s) => !(s.serverId === id && s.harness === body.harness && s.scope === body.scope)
      );
      if (action === "activate") {
        statuses.push({
          serverId: id,
          harness: body.harness,
          scope: body.scope,
          active: true,
          configPath: "/mock/config.json",
        });
      }
      return fulfillJson(route, { ok: true });
    }
    if (method === "GET" && pathname === "/api/state") {
      // Shape mirrors src-tauri/src/backend/types.rs::State (camelCase) —
      // app.js's render() reads several of these fields unconditionally
      // (data.project.path, data.summary.*, data.discovery.summary.*), so a
      // bare `{}` fixture throws before the MCP Servers tab is reachable.
      return fulfillJson(route, {
        appHome: "/mock/.skillworks",
        configPath: "/mock/.skillworks/config.json",
        vaultRoot: "/mock/vault",
        project: { path: "", exists: false },
        recentProjects: [],
        projects: [],
        skills: [],
        customTargets: [],
        hiddenTargetIds: [],
        targets: [],
        summary: { skillCount: 0, targetCount: 0, enabledCount: 0, unmanagedCount: 0 },
        discovery: {
          sources: [],
          summary: { sourceCount: 0, existingCount: 0, importableCount: 0 },
        },
        suggestedImports: [],
      });
    }
    if (method === "GET" && pathname === "/api/sets") {
      return fulfillJson(route, {
        global: [],
        project: [],
        pinned: { ids: [], resolved: [], missing: [] },
      });
    }
    // Generic default so any other /api/* call the app makes during boot
    // (e.g. the Connector tab's own status/snippet routes) resolves cleanly
    // instead of hitting a real network connection that doesn't exist.
    return fulfillJson(route, {});
  });

  return { activationLog };
}

// This file lives under test/ui/ so `npm run test:ui` (Playwright) finds it
// via playwright.config.js's testDir. But package.json's *unmodified*
// `"test": "node --test"` script auto-discovers every .js file nested under
// any directory literally named `test` (see test/core.test.js etc.) — so
// plain `node --test` picks this file up too and tries to load it outside
// Playwright's own test-file loader, where `test.describe()` is documented
// to throw ("Playwright Test did not expect test.describe() to be called
// here"). Swallow only that specific, expected misuse error so `node --test`
// sees a trivial no-op pass here instead of a spurious failure; a real
// `npm run test:ui` run (via `playwright test`) never reaches the catch.
try {
  test.describe("MCP Servers tab smoke", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
  });

  test("app boots with 7 top tabs including Connector and MCP Servers", async ({ page }) => {
    await page.goto("/");
    const topTabs = page.locator("[data-top-tab]");
    await expect(topTabs).toHaveCount(7);

    const labels = await page.locator(".top-tab-label").allTextContents();
    expect(labels).toContain("Connector");
    expect(labels).toContain("MCP Servers");

    await page.screenshot({ path: "test-results/mcp-boot-tabs.png" });
  });

  test("MCP Servers sidebar renders from mocked library and a row opens the detail pane", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    const rows = page.locator(".mcp-servers-row");
    await expect(rows).toHaveCount(SERVERS.length);
    await expect(rows.first()).toBeVisible();

    await rows.first().click();

    const form = page.locator('[data-mcp-form="1"]');
    await expect(form).toBeVisible();
    await expect(form.locator('input[data-mcp-field="name"]')).toHaveValue(SERVERS[0].name);

    const matrix = page.locator(".mcp-servers-matrix");
    await expect(matrix).toBeVisible();
    // 7 harnesses (spec §4.1) as body rows.
    await expect(matrix.locator("tbody tr")).toHaveCount(7);

    await page.screenshot({ path: "test-results/mcp-detail-matrix.png" });
  });

  test("add-URL Parse flow renders a draft card from a mocked mcp_add_from_url response", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();
    await expect(page.locator(".mcp-servers-row")).toHaveCount(SERVERS.length);

    await page.locator('[data-mcp-add-url="1"]').fill("https://example.com/some-mcp-readme");
    await page.locator('.mcp-servers-add-url-row button[type="submit"]').click();

    const card = page.locator(".mcp-servers-draft-card");
    await expect(card).toHaveCount(1);
    await expect(card.locator('input[data-mcp-card-field="name"]')).toHaveValue("Parsed Server");

    await page.screenshot({ path: "test-results/mcp-add-url-draft.png" });
  });

  test("toggling a matrix checkbox issues the expected mocked activate request", async ({
    page,
  }) => {
    const requests = [];
    page.on("request", (req) => {
      if (/\/api\/mcp\/servers\/.+\/(activate|deactivate)$/.test(new URL(req.url()).pathname)) {
        requests.push(req);
      }
    });

    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();
    await page.locator(".mcp-servers-row").first().click();

    // "global" scope is always enabled (no project selected); target the
    // first harness row (Claude Code) global-column checkbox.
    const checkbox = page.locator('input[data-mcp-toggle="claude:global"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    await checkbox.click();

    await expect
      .poll(() => requests.map((r) => new URL(r.url()).pathname))
      .toContain(`/api/mcp/servers/${SERVERS[0].id}/activate`);

    const activateRequest = requests.find((r) => r.url().includes("/activate"));
    const activateBody = activateRequest.postDataJSON();
    expect(activateBody.harness).toBe("claude");
    expect(activateBody.scope).toBe("global");

    // After the toggle, refreshAll() re-fetches status and the checkbox
    // should reflect the backend-authoritative (now active) state.
    await expect(checkbox).toBeChecked();

    await page.screenshot({ path: "test-results/mcp-matrix-toggle.png" });
  });

  test("keyboard Tab reaches list -> form -> matrix with visible focus", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    const firstRow = page.locator(".mcp-servers-row").first();
    // Selecting a row re-renders the sidebar list (state.selectedId flips
    // the "is-selected" class), which replaces the button's DOM node and
    // drops the focus the native click gave it — so we click to select,
    // then explicitly re-focus the (re-rendered) row to start the Tab walk
    // from a known, deterministic point rather than asserting focus
    // survives the re-render (a separate, non-blocking UX nuance).
    await firstRow.click();
    await firstRow.focus();
    await expect(firstRow).toBeFocused();

    let reachedForm = false;
    let reachedMatrix = false;
    for (let i = 0; i < 120 && !reachedMatrix; i += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return { inForm: false, inMatrix: false, visible: false };
        return {
          inForm: Boolean(el.closest('[data-mcp-form="1"]')),
          inMatrix: Boolean(el.closest(".mcp-servers-matrix")),
          visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
        };
      });
      if (info.inForm) reachedForm = true;
      if (info.inMatrix) {
        // Matrix should only be reached after the form has been traversed.
        expect(reachedForm).toBe(true);
        expect(info.visible).toBe(true);
        reachedMatrix = true;
      }
    }

    expect(reachedForm).toBe(true);
    expect(reachedMatrix).toBe(true);
  });

  test("reconcile panel renders unmanaged imports + drift, and wires import/reapply/adopt", async ({
    page,
  }) => {
    // Overrides the default (empty) reconcile fixture installed by
    // beforeEach — the most-recently-registered page.route handler wins for
    // every subsequent /api/** request in this test.
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });

    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    // Section A: unmanaged servers (import candidates).
    await expect(page.getByText("Unmanaged servers")).toBeVisible();
    await expect(page.locator(".mcp-servers-reconcile-key", { hasText: "ctx" })).toBeVisible();

    // Section B: needs attention (drift entries) — "context7" isn't in the
    // mocked library, so the row falls back to the raw serverId.
    await expect(page.getByText("Needs attention")).toBeVisible();
    await expect(page.locator(".mcp-servers-reconcile-key", { hasText: "context7" })).toBeVisible();

    await page.screenshot({ path: "test-results/mcp-reconcile-panel.png" });

    // Import opens the existing review card, prefilled from suggestedSpec.
    await page.locator("[data-mcp-import]").click();
    const card = page.locator(".mcp-servers-draft-card");
    await expect(card).toHaveCount(1);
    await expect(card.locator('input[data-mcp-card-field="id"]')).toHaveValue("ctx");
    await expect(card.locator('input[data-mcp-card-field="name"]')).toHaveValue("ctx");

    // Reapply library: confirm, then expect an activate POST.
    page.once("dialog", (dialog) => dialog.accept());
    const reapplyRequest = page.waitForRequest(
      (req) => req.method() === "POST" && /\/activate$/.test(new URL(req.url()).pathname)
    );
    await page.locator("[data-mcp-reapply]").click();
    const activateReq = await reapplyRequest;
    expect(new URL(activateReq.url()).pathname).toBe("/api/mcp/servers/context7/activate");

    // Adopt into library: confirm, then expect a PATCH to /api/mcp/servers.
    page.once("dialog", (dialog) => dialog.accept());
    const adoptRequest = page.waitForRequest(
      (req) => req.method() === "PATCH" && new URL(req.url()).pathname === "/api/mcp/servers"
    );
    await page.locator("[data-mcp-adopt]").click();
    const patchReq = await adoptRequest;
    expect(patchReq.postDataJSON().spec).toMatchObject({ id: "context7", command: "npx" });
  });

  test("reconcile panel surfaces warnings even with no imports or conflicts", async ({ page }) => {
    // Every discovered entry was malformed and skipped into warnings — the
    // panel must not claim "everything matches" and hide the parse failures.
    const warning = 'cursor/global "srv": remote config entry has no url';
    await installApiMocks(page, {
      reconcile: { imports: [], conflicts: [], warnings: [warning] },
    });

    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    await expect(page.getByText("Couldn't read some entries")).toBeVisible();
    await expect(page.getByText(warning)).toBeVisible();
    await expect(
      page.getByText("Everything in your harness configs matches your library.")
    ).toHaveCount(0);
  });
});
} catch (err) {
  if (!/did not expect test\.describe/i.test(String(err && err.message))) {
    throw err;
  }
}
