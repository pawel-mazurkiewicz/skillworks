const assert = require("node:assert/strict");
const test = require("node:test");

function loadLogic() {
  return import("../public/mcp-logic.js");
}

test("escapeHtml escapes script tags, quotes, and ampersands", async () => {
  const { escapeHtml } = await loadLogic();
  assert.equal(
    escapeHtml("<script>alert('x')</script>"),
    "&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;"
  );
  assert.equal(escapeHtml(`say "hi" & bye`), "say &quot;hi&quot; &amp; bye");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("looksLikePlaceholder flags known placeholder shapes", async () => {
  const { looksLikePlaceholder } = await loadLogic();
  const positive = [
    "YOUR_API_KEY",
    "your_token",
    "<token>",
    "${VAR}",
    "xxx",
    "changeme",
    "CHANGEME",
    "token_here",
    "TOKEN_HERE",
    "please replace this",
  ];
  for (const value of positive) {
    assert.equal(looksLikePlaceholder(value), true, `expected placeholder: ${value}`);
  }
  const negative = ["sk-live-abc123", "npx", "-y", "https://example.com/mcp", "42"];
  for (const value of negative) {
    assert.equal(looksLikePlaceholder(value), false, `expected NOT placeholder: ${value}`);
  }
});

test("commandLooksShellRef flags shell variable and home-relative commands", async () => {
  const { commandLooksShellRef } = await loadLogic();
  assert.equal(commandLooksShellRef("$HOME/.local/bin/uvx"), true);
  assert.equal(commandLooksShellRef("~/bin/mcp"), true);
  assert.equal(commandLooksShellRef("npx${VAR}"), true);
  assert.equal(commandLooksShellRef("npx"), false);
  assert.equal(commandLooksShellRef("/usr/local/bin/uvx"), false);
});

test("slugifyId mirrors the Rust slugify (lowercase, collapse, trim, ascii-only)", async () => {
  const { slugifyId } = await loadLogic();
  assert.equal(slugifyId(""), "");
  assert.equal(slugifyId("Hello World! 2"), "hello-world-2");
  assert.equal(slugifyId("café-mcp"), "caf-mcp");
  assert.equal(slugifyId("  --Leading and Trailing--  "), "leading-and-trailing");
  assert.equal(slugifyId("Already-Slugified"), "already-slugified");
});

test("buildMcpRoutes contains all 9 MCP-servers-tab routes", async () => {
  const { buildMcpRoutes } = await loadLogic();
  const routes = buildMcpRoutes();
  assert.equal(routes.length, 9);
  const commands = routes.map((r) => r[2]).sort();
  assert.deepEqual(commands, [
    "mcp_activate",
    "mcp_add_from_url",
    "mcp_add_manual",
    "mcp_deactivate",
    "mcp_discover",
    "mcp_list_library",
    "mcp_remove_server",
    "mcp_status",
    "mcp_update_server",
  ]);
});

test("buildMcpRoutes arg builders produce exact camelCase payloads", async () => {
  const { buildMcpRoutes } = await loadLogic();
  const routes = buildMcpRoutes();
  const byCommand = Object.fromEntries(routes.map((r) => [r[2], r]));

  const statusUrl = new URL("/api/mcp/servers/status?project=%2Frepo", "http://localhost");
  assert.deepEqual(byCommand.mcp_status[3](statusUrl, null, []), { projectPath: "/repo" });

  const discoverUrl = new URL("/api/mcp/servers/discover", "http://localhost");
  assert.deepEqual(byCommand.mcp_discover[3](discoverUrl, null, []), { projectPath: undefined });

  const removeUrl = new URL("/api/mcp/servers/srv-1?project=%2Frepo", "http://localhost");
  assert.deepEqual(
    byCommand.mcp_remove_server[3](removeUrl, null, ["/api/mcp/servers/srv-1", "srv-1"]),
    { id: "srv-1", projectPath: "/repo" }
  );

  const spec = { id: "srv-1", command: "npx" };
  assert.deepEqual(byCommand.mcp_add_manual[3](null, { spec }, []), { spec });
  assert.deepEqual(byCommand.mcp_update_server[3](null, { spec }, []), { spec });

  const activateBody = {
    harness: "claude",
    scope: "project",
    variantLabel: "remote-http",
    projectPath: "/repo",
  };
  assert.deepEqual(
    byCommand.mcp_activate[3](null, activateBody, ["", "srv-1"]),
    {
      id: "srv-1",
      harness: "claude",
      scope: "project",
      variantLabel: "remote-http",
      projectPath: "/repo",
    }
  );

  const deactivateBody = { harness: "codex", scope: "global", projectPath: undefined };
  assert.deepEqual(
    byCommand.mcp_deactivate[3](null, deactivateBody, ["", "srv-1"]),
    { id: "srv-1", harness: "codex", scope: "global", projectPath: undefined }
  );

  assert.deepEqual(
    byCommand.mcp_add_from_url[3](null, { url: "https://x/mcp" }, []),
    { url: "https://x/mcp" }
  );

  assert.deepEqual(byCommand.mcp_list_library[3](), {});
});

test("silent is set only on the add_from_url route", async () => {
  const { buildMcpRoutes } = await loadLogic();
  const routes = buildMcpRoutes();
  for (const route of routes) {
    const [, , command, , , silent] = route;
    if (command === "mcp_add_from_url") {
      assert.equal(silent, true, "add_from_url must be silent");
    } else {
      assert.ok(!silent, `${command} must not be silent`);
    }
  }
});

test("generation guard drops stale writes", async () => {
  const { newGeneration, isStale } = await loadLogic();
  const first = newGeneration();
  const second = newGeneration();
  assert.equal(isStale(first, second), true, "an older generation is stale once a newer one exists");
  assert.equal(isStale(second, second), false, "the current generation is never stale");
});
