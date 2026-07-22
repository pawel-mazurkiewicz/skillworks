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
    headers: {},
    // Task 7: this variant controls the "kiro" harness — the RECONCILE_FIXTURE
    // drift entry against "everything"/kiro is what "Update variant" targets.
    variants: [{ label: "kiro tweak", appliesTo: { harness: "kiro" }, args: ["-y", "@modelcontextprotocol/server-everything", "--old"] }],
  },
  {
    id: "weather-api",
    name: "Weather API",
    description: "Remote weather MCP server.",
    source: { kind: "url", url: "https://example.com/weather/mcp.json" },
    transport: "http",
    args: [],
    env: {},
    url: "https://weather.example.com/mcp",
    headers: {},
    variants: [],
  },
  {
    // Task 7: already in the library (unlike the earlier "server not yet
    // adopted" scenario this fixture also exercises) so the RECONCILE_FIXTURE
    // drift entry against it can be captured as an "Add as variant" row.
    id: "context7",
    name: "Context7",
    description: "Reference server used to exercise reconcile drift.",
    source: { kind: "manual" },
    transport: "stdio",
    command: "npx",
    args: ["-y", "a"],
    env: {},
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
      fingerprint: "fp-ctx",
      warnings: [],
    },
    {
      key: "unityMCP",
      suggestedSpec: {
        id: "unitymcp",
        name: "unityMCP",
        source: { kind: "discovered" },
        transport: "stdio",
        command: "npx",
        args: ["-y", "unity-mcp"],
        env: {},
        headers: {},
        variants: [],
      },
      foundIn: [{ harness: "kiro", scope: "global", configPath: "/tmp/kiro.json" }],
      matchesLibraryId: "everything",
      fingerprint: "fp-unity",
      warnings: [],
    },
    {
      key: "atlassian",
      suggestedSpec: {
        id: "atlassian",
        name: "atlassian",
        source: { kind: "discovered" },
        transport: "http",
        args: [],
        env: {},
        headers: {},
        url: "https://mcp.atlassian.com/v1/mcp/authv2",
        variants: [],
      },
      foundIn: [{ harness: "claude", scope: "plugin:atlassian", configPath: "/x/.mcp.json" }],
      fingerprint: "fp-atl",
      managedNote: "Managed by a Claude Code plugin — Skillworks won't modify it.",
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
    // Task 7: variant-controlled drift — "everything"/kiro is already
    // covered by the SERVERS "kiro tweak" variant, so this row offers
    // "Update variant" instead of "Adopt into library".
    {
      serverId: "everything",
      harness: "kiro",
      scope: "global",
      configPath: "/tmp/kiro-everything.json",
      adoptable: false,
      variantLabel: "kiro tweak",
      diff: [
        {
          field: "args",
          expected: "-y @modelcontextprotocol/server-everything --old",
          observed: "-y @modelcontextprotocol/server-everything --new",
        },
      ],
      observedSpec: {
        id: "everything",
        name: "Everything (stdio demo)",
        source: { kind: "manual" },
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything", "--new"],
        env: {},
        headers: {},
        variants: [],
      },
    },
    // Coverage-gap fix: a drift entry whose serverId has no match in SERVERS
    // at all (never adopted, or removed since) — libraryServerName() falls
    // back to the raw id, and renderConflictEntry has no `server` to build a
    // variantFromConflict plan from, so "Add as variant" is disabled.
    {
      serverId: "ghost-server",
      harness: "gemini",
      scope: "global",
      configPath: "/tmp/gemini-ghost.json",
      adoptable: true,
      diff: [{ field: "args", expected: "-y pkg", observed: "-y pkg --x" }],
      observedSpec: {
        id: "ghost-server",
        name: "ghost-server",
        source: { kind: "manual" },
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg", "--x"],
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
              source: { kind: "url", url: body.url },
              transport: "stdio",
              command: "npx",
              args: ["-y", "parsed-server"],
              env: {},
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

  test("added card auto-dismisses after a short linger", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();
    await expect(page.locator(".mcp-servers-row")).toHaveCount(SERVERS.length);

    await page.locator('[data-mcp-add-url="1"]').fill("https://example.com/some-mcp-readme");
    await page.locator('.mcp-servers-add-url-row button[type="submit"]').click();

    const card = page.locator(".mcp-servers-draft-card");
    await expect(card).toHaveCount(1);

    await card.locator("[data-mcp-card-add]").click();

    const added = page.locator(".mcp-servers-card-added");
    await expect(added).toBeVisible();

    // The fade must interpolate on the live node — a full re-render would
    // recreate the article already at opacity 0, snapping straight to
    // hidden instead of fading. Poll frequently through the linger + fade
    // window for a moment where the card is mid-transition (is-leaving
    // class present, computed opacity strictly between 0 and 1).
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const el = document.querySelector(".mcp-servers-draft-card.is-leaving");
            if (!el) return false;
            const opacity = Number(getComputedStyle(el).opacity);
            return opacity > 0 && opacity < 1;
          }),
        { timeout: 3500, intervals: [30] },
      )
      .toBe(true);

    // 2500ms linger + 280ms fade + margin.
    await expect(page.locator(".mcp-servers-draft-card")).toHaveCount(0, { timeout: 5000 });
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

    // Section B: needs attention (drift entries) — "context7" is in the
    // mocked library (Task 7 fixture addition), so the row shows its name.
    await expect(page.getByText("Needs attention")).toBeVisible();
    await expect(page.locator(".mcp-servers-reconcile-key", { hasText: "context7" })).toBeVisible();

    await page.screenshot({ path: "test-results/mcp-reconcile-panel.png" });

    // Two conflict rows now (context7 drift + the "kiro tweak" variant-
    // controlled drift added for Task 7) — scope reapply/adopt to row 0.
    const conflictRow0 = page.locator("[data-mcp-conflict-row]").first();

    // Import opens the existing review card, prefilled from suggestedSpec.
    // Fixture now carries multiple candidates (ctx, unityMCP, atlassian), so
    // scope to the "ctx" row's own Import button.
    const ctxRow = page.locator("[data-mcp-import-row]", { hasText: "ctx" }).first();
    await ctxRow.locator("[data-mcp-import]").click();
    const card = page.locator(".mcp-servers-draft-card");
    await expect(card).toHaveCount(1);
    await expect(card.locator('input[data-mcp-card-field="id"]')).toHaveValue("ctx");
    await expect(card.locator('input[data-mcp-card-field="name"]')).toHaveValue("ctx");

    // Reapply library: confirm, then expect an activate POST.
    page.once("dialog", (dialog) => dialog.accept());
    const reapplyRequest = page.waitForRequest(
      (req) => req.method() === "POST" && /\/activate$/.test(new URL(req.url()).pathname)
    );
    await conflictRow0.locator("[data-mcp-reapply]").click();
    const activateReq = await reapplyRequest;
    expect(new URL(activateReq.url()).pathname).toBe("/api/mcp/servers/context7/activate");

    // Adopt into library: confirm, then expect a PATCH to /api/mcp/servers.
    page.once("dialog", (dialog) => dialog.accept());
    const adoptRequest = page.waitForRequest(
      (req) => req.method() === "PATCH" && new URL(req.url()).pathname === "/api/mcp/servers"
    );
    await conflictRow0.locator("[data-mcp-adopt]").click();
    const patchReq = await adoptRequest;
    expect(patchReq.postDataJSON().spec).toMatchObject({ id: "context7", command: "npx" });
  });

  test("import scrolls the new draft card into view and highlights it", async ({ page }) => {
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    // Fixture carries multiple candidates (ctx, unityMCP, atlassian); scope
    // to the "ctx" row's own Import button to satisfy strict mode.
    const ctxRow = page.locator("[data-mcp-import-row]", { hasText: "ctx" }).first();
    await ctxRow.locator("[data-mcp-import]").click();

    const card = page.locator(".mcp-servers-draft-card");
    await expect(card).toHaveClass(/is-highlighted/);
    await expect(card).toBeInViewport();
  });

  test("matched candidate offers Link and Dismiss, not Import", async ({ page }) => {
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    const row = page.locator("[data-mcp-import-row]", { hasText: "unityMCP" });
    await expect(row.locator("[data-mcp-link]")).toHaveText(/Link to Everything/);
    await expect(row.locator("[data-mcp-dismiss-candidate]")).toBeVisible();
    await expect(row.locator("[data-mcp-import]")).toHaveCount(0);
  });

  test("dismiss posts key+fingerprint+targets and refreshes", async ({ page }) => {
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });

    let captured = null;
    let dismissed = false;
    const fulfillJson = (route, json) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(json),
      });

    // The reconcile mock must consult `dismissed`: serve RECONCILE_FIXTURE
    // before the dismiss, and the same fixture minus the unityMCP candidate
    // after (refreshAll re-fetches reconcile once the POST resolves). These
    // two routes are registered after installApiMocks, so per Playwright's
    // most-recently-registered-wins rule they take over from its catch-all
    // for these two paths.
    await page.route("**/api/mcp/servers/reconcile", async (route) => {
      if (!dismissed) return fulfillJson(route, RECONCILE_FIXTURE);
      return fulfillJson(route, {
        ...RECONCILE_FIXTURE,
        imports: RECONCILE_FIXTURE.imports.filter((c) => c.key !== "unityMCP"),
      });
    });
    await page.route("**/api/mcp/servers/reconcile/dismiss", async (route) => {
      captured = route.request().postDataJSON();
      dismissed = true;
      return fulfillJson(route, {});
    });

    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    const row = page.locator("[data-mcp-import-row]", { hasText: "unityMCP" });
    await row.locator("[data-mcp-dismiss-candidate]").click();
    await expect(page.locator("[data-mcp-import-row]", { hasText: "unityMCP" })).toHaveCount(0);
    expect(captured).toEqual({
      key: "unityMCP",
      fingerprint: "fp-unity",
      targets: [{ harness: "kiro", scope: "global" }],
    });
  });

  test("drift row offers Add as variant and saves a scoped variant", async ({ page }) => {
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    // Row 0: context7/cursor/global drift — context7 is in the mocked
    // library (SERVERS) with variants: [], so this is the adoptable row.
    const row = page.locator("[data-mcp-conflict-row]").first();
    const patchRequest = page.waitForRequest(
      (req) => req.method() === "PATCH" && new URL(req.url()).pathname === "/api/mcp/servers"
    );
    await row.locator("[data-mcp-adopt-variant]").click();
    const patchReq = await patchRequest;
    const spec = patchReq.postDataJSON().spec;
    expect(spec.variants.length).toBe(1);
    expect(spec.variants[0].appliesTo).toEqual({ harness: "cursor", scope: "global" });
    expect(spec.variants[0].label).toBe("cursor (global)");
    expect(spec.variants[0].args).toEqual(["-y", "a", "--v"]);
  });

  test("variant-controlled drift row offers Update variant and disables Adopt", async ({ page }) => {
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    // Row 1: everything/kiro drift, controlled by the "kiro tweak" variant
    // already on the "everything" SERVERS entry.
    const row = page.locator("[data-mcp-conflict-row]").nth(1);
    await expect(row.locator("[data-mcp-adopt-variant]")).toHaveText(/Update variant "kiro tweak"/);
    await expect(row.locator("[data-mcp-adopt]")).toBeDisabled();
  });

  test("drift row for a server not in the library falls back to the raw id and disables Add as variant", async ({
    page,
  }) => {
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    // "ghost-server" has no matching entry in SERVERS — libraryServerName()
    // falls back to the raw serverId, and renderConflictEntry has no
    // `server` to build a variant plan from.
    const row = page.locator("[data-mcp-conflict-row]", { hasText: "ghost-server" });
    await expect(row.locator(".mcp-servers-reconcile-key")).toHaveText("ghost-server");
    await expect(row.locator("[data-mcp-adopt-variant]")).toBeDisabled();
  });

  test("plugin candidate shows managed note and plugin scope label", async ({ page }) => {
    await installApiMocks(page, { reconcile: RECONCILE_FIXTURE });
    await page.goto("/");
    await page.locator('[data-top-tab="mcp-servers"]').click();

    const row = page.locator("[data-mcp-import-row]", { hasText: "atlassian" });
    await expect(row).toContainText("Claude Code / plugin: atlassian");
    await expect(row).toContainText("Managed by a Claude Code plugin");
    await expect(row.locator("[data-mcp-link]")).toHaveCount(0);
    await expect(row.locator("[data-mcp-import]")).toBeVisible();
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
