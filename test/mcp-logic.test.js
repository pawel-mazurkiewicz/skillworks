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

test("buildMcpRoutes contains all 10 MCP-servers-tab routes", async () => {
  const { buildMcpRoutes } = await loadLogic();
  const routes = buildMcpRoutes();
  assert.equal(routes.length, 10);
  const commands = routes.map((r) => r[2]).sort();
  assert.deepEqual(commands, [
    "mcp_activate",
    "mcp_add_from_url",
    "mcp_add_manual",
    "mcp_deactivate",
    "mcp_discover",
    "mcp_list_library",
    "mcp_reconcile",
    "mcp_remove_server",
    "mcp_status",
    "mcp_update_server",
  ]);
});

test("buildMcpRoutes exposes reconcile route", async () => {
  const { buildMcpRoutes } = await loadLogic();
  const routes = buildMcpRoutes();
  const hit = routes.find((r) => "/api/mcp/servers/reconcile".match(r[1]));
  assert.ok(hit, "reconcile route present");
  assert.equal(hit[2], "mcp_reconcile");
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

test("MCP_HARNESSES mirrors the backend adapter table order and trust notes", async () => {
  const { MCP_HARNESSES } = await loadLogic();
  assert.equal(MCP_HARNESSES.length, 7);
  assert.deepEqual(
    MCP_HARNESSES.map((h) => h.id),
    ["claude", "codex", "cursor", "opencode", "gemini", "copilot", "kiro"]
  );
  assert.deepEqual(
    MCP_HARNESSES.filter((h) => h.trustNote).map((h) => h.id),
    ["claude", "codex"]
  );
  for (const h of MCP_HARNESSES) {
    assert.ok(h.label && typeof h.label === "string", `${h.id} needs a label`);
  }
});

test("validateSpecDraft: stdio transport requires a non-empty command", async () => {
  const { validateSpecDraft } = await loadLogic();
  const missing = validateSpecDraft({
    id: "srv-1",
    name: "Server",
    transport: "stdio",
    command: "",
    url: "",
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.command, "expected a command error");

  const ok = validateSpecDraft({
    id: "srv-1",
    name: "Server",
    transport: "stdio",
    command: "npx",
    url: "",
  });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, {});
});

test("validateSpecDraft: http/sse transports require a non-empty url", async () => {
  const { validateSpecDraft } = await loadLogic();
  for (const transport of ["http", "sse"]) {
    const missing = validateSpecDraft({
      id: "srv-1",
      name: "Server",
      transport,
      command: "",
      url: "",
    });
    assert.equal(missing.valid, false, `${transport} without url should be invalid`);
    assert.ok(missing.errors.url, `${transport} expected a url error`);

    const ok = validateSpecDraft({
      id: "srv-1",
      name: "Server",
      transport,
      command: "",
      url: "https://example.com/mcp",
    });
    assert.equal(ok.valid, true, `${transport} with url should be valid`);
  }
});

test("validateSpecDraft: name is required and id must match the backend pattern", async () => {
  const { validateSpecDraft } = await loadLogic();
  const noName = validateSpecDraft({
    id: "srv-1",
    name: "   ",
    transport: "stdio",
    command: "npx",
    url: "",
  });
  assert.equal(noName.valid, false);
  assert.ok(noName.errors.name, "expected a name error");

  const badId = validateSpecDraft({
    id: "Not Valid!",
    name: "Server",
    transport: "stdio",
    command: "npx",
    url: "",
  });
  assert.equal(badId.valid, false);
  assert.ok(badId.errors.id, "expected an id error");

  const unknownTransport = validateSpecDraft({
    id: "srv-1",
    name: "Server",
    transport: "carrier-pigeon",
    command: "npx",
    url: "",
  });
  assert.equal(unknownTransport.valid, false);
  assert.ok(unknownTransport.errors.transport, "expected a transport error");
});

test("variantFromForm: inherit vs override-with-value vs override-with-empty for a list field (args)", async () => {
  const { variantFromForm } = await loadLogic();

  const inherit = variantFromForm({
    label: "a",
    fields: { args: { override: false, value: ["-y", "leftover"] } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(inherit, "args"), false, "inherit must omit the key entirely");

  const overrideValue = variantFromForm({
    label: "a",
    fields: { args: { override: true, value: ["-y", "pkg@2"] } },
  });
  assert.deepEqual(overrideValue.args, ["-y", "pkg@2"]);

  const overrideEmpty = variantFromForm({
    label: "a",
    fields: { args: { override: true, value: [] } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(overrideEmpty, "args"), true, "override-empty must set the key");
  assert.deepEqual(overrideEmpty.args, []);

  // The critical distinction: inherit (no key) is NOT the same as
  // override-with-empty (key present, empty array).
  assert.notDeepEqual(inherit, overrideEmpty);
});

test("variantFromForm: inherit vs override-with-value vs override-with-empty for a kv field (env)", async () => {
  const { variantFromForm } = await loadLogic();

  const inherit = variantFromForm({
    label: "a",
    fields: { env: { override: false, value: [{ key: "TOKEN", value: "canonical" }] } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(inherit, "env"), false);

  const overrideValue = variantFromForm({
    label: "a",
    fields: { env: { override: true, value: [{ key: "TOKEN", value: "override-value" }] } },
  });
  assert.deepEqual(overrideValue.env, { TOKEN: "override-value" });

  const overrideEmpty = variantFromForm({
    label: "a",
    fields: { env: { override: true, value: [] } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(overrideEmpty, "env"), true);
  assert.deepEqual(overrideEmpty.env, {});
  assert.notDeepEqual(inherit, overrideEmpty);
});

test("variantFromForm: inherit vs override-with-value vs override-with-empty for a string field (command)", async () => {
  const { variantFromForm } = await loadLogic();

  const inherit = variantFromForm({
    label: "a",
    fields: { command: { override: false, value: "npx" } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(inherit, "command"), false);

  const overrideValue = variantFromForm({
    label: "a",
    fields: { command: { override: true, value: "uvx" } },
  });
  assert.equal(overrideValue.command, "uvx");

  const overrideEmpty = variantFromForm({
    label: "a",
    fields: { command: { override: true, value: "" } },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(overrideEmpty, "command"), true);
  assert.equal(overrideEmpty.command, "");
  assert.notDeepEqual(inherit, overrideEmpty);
});

test("variantFromForm builds appliesTo from harness/scope selects, omitting it when both are 'any'", async () => {
  const { variantFromForm } = await loadLogic();

  const any = variantFromForm({ label: "a", appliesToHarness: "", appliesToScope: "", fields: {} });
  assert.equal(Object.prototype.hasOwnProperty.call(any, "appliesTo"), false);

  const harnessOnly = variantFromForm({ label: "a", appliesToHarness: "claude", appliesToScope: "", fields: {} });
  assert.deepEqual(harnessOnly.appliesTo, { harness: "claude" });

  const both = variantFromForm({ label: "a", appliesToHarness: "codex", appliesToScope: "project", fields: {} });
  assert.deepEqual(both.appliesTo, { harness: "codex", scope: "project" });
});

test("formStateFromVariant derives override flags from key presence, falling back to canonical for inherited fields", async () => {
  const { formStateFromVariant } = await loadLogic();
  const canonical = {
    transport: "stdio",
    command: "npx",
    args: ["-y", "pkg"],
    env: { HOME_TOKEN: "canon" },
    url: "",
    headers: {},
  };
  const variant = {
    label: "remote-http",
    appliesTo: { harness: "claude" },
    transport: "http",
    args: [], // explicit override-with-empty
    // command, env, url, headers all inherited (absent)
  };
  const formState = formStateFromVariant(variant, canonical);

  assert.equal(formState.label, "remote-http");
  assert.equal(formState.appliesToHarness, "claude");
  assert.equal(formState.appliesToScope, "");

  assert.equal(formState.fields.transport.override, true);
  assert.equal(formState.fields.transport.value, "http");

  assert.equal(formState.fields.command.override, false);
  assert.equal(formState.fields.command.value, "npx", "inherited field previews the canonical value");

  assert.equal(formState.fields.args.override, true);
  assert.deepEqual(formState.fields.args.value, [], "override-with-empty must stay override:true, not fall back to canonical");

  assert.equal(formState.fields.env.override, false);
  assert.deepEqual(formState.fields.env.value, [{ key: "HOME_TOKEN", value: "canon" }]);

  assert.equal(formState.fields.headers.override, false);
  assert.deepEqual(formState.fields.headers.value, []);
});

test("variantFromForm + formStateFromVariant round-trip a variant exercising all three states across fields", async () => {
  const { variantFromForm, formStateFromVariant } = await loadLogic();
  const canonical = {
    transport: "stdio",
    command: "npx",
    args: ["-y", "pkg"],
    env: { A: "1" },
    url: "https://canonical.example/mcp",
    headers: { X: "1" },
  };
  const variant = {
    label: "custom",
    appliesTo: { scope: "project" }, // harness inherited/any, scope overridden
    // transport: inherited
    command: "uvx", // override-with-value
    args: [], // override-with-empty
    // env: inherited
    url: "", // override-with-empty (string)
    // headers: inherited
  };

  const formState = formStateFromVariant(variant, canonical);
  const rebuilt = variantFromForm(formState);
  assert.deepEqual(rebuilt, variant);
});

test("isDuplicateVariantLabel is case-sensitive, exact-match, and excludes the variant being edited", async () => {
  const { isDuplicateVariantLabel } = await loadLogic();
  const variants = [{ label: "Remote HTTP" }, { label: "local" }];
  assert.equal(isDuplicateVariantLabel("remote http", variants), false);
  assert.equal(isDuplicateVariantLabel("Remote HTTP", variants), true);
  assert.equal(isDuplicateVariantLabel("  LOCAL  ", variants), false);
  assert.equal(isDuplicateVariantLabel("new-one", variants), false);
  assert.equal(isDuplicateVariantLabel("", variants), false);
  // editing index 1 ("local") against its own unchanged label is not a dup
  assert.equal(isDuplicateVariantLabel("local", variants, 1), false);
  assert.equal(isDuplicateVariantLabel("local", variants, 0), true);
});

test("overriddenFieldsOf lists only the fields the variant actually overrides", async () => {
  const { overriddenFieldsOf } = await loadLogic();
  assert.deepEqual(overriddenFieldsOf({ label: "a" }), []);
  assert.deepEqual(overriddenFieldsOf({ label: "a", appliesTo: { harness: "claude" } }), []);
  assert.deepEqual(overriddenFieldsOf({ label: "a", command: "uvx", args: [] }), ["command", "args"]);
  assert.deepEqual(
    overriddenFieldsOf({ label: "a", transport: "http", url: "", headers: { X: "1" } }),
    ["transport", "url", "headers"]
  );
});

test("appliesToSummary renders plain-English harness/scope combinations", async () => {
  const { appliesToSummary } = await loadLogic();
  assert.equal(appliesToSummary(undefined), "any harness, any scope");
  assert.equal(appliesToSummary({}), "any harness, any scope");
  assert.equal(appliesToSummary({ harness: "claude" }), "Claude Code, any scope");
  assert.equal(appliesToSummary({ scope: "project" }), "any harness, project");
  assert.equal(appliesToSummary({ harness: "codex", scope: "global" }), "Codex, global");
  assert.equal(appliesToSummary({ harness: "unknown-harness" }), "unknown-harness, any scope");
});

test("groupDiscoveredByHarness groups entries by harness, preserving first-seen order", async () => {
  const { groupDiscoveredByHarness } = await loadLogic();
  const entries = [
    { harness: "claude", scope: "global", key: "a" },
    { harness: "codex", scope: "global", key: "b" },
    { harness: "claude", scope: "project", key: "c" },
  ];
  const grouped = groupDiscoveredByHarness(entries);
  assert.deepEqual(
    grouped.map((g) => g.harness),
    ["claude", "codex"]
  );
  assert.equal(grouped[0].items.length, 2);
  assert.equal(grouped[1].items.length, 1);
  assert.deepEqual(groupDiscoveredByHarness([]), []);
  assert.deepEqual(groupDiscoveredByHarness(undefined), []);
});

test("VARIANT_FIELD_KEYS matches the six overlayable McpVariant fields", async () => {
  const { VARIANT_FIELD_KEYS } = await loadLogic();
  assert.deepEqual(VARIANT_FIELD_KEYS, ["transport", "command", "args", "env", "url", "headers"]);
});

test("activeTargetsOf returns only active targets for the given server", async () => {
  const { activeTargetsOf } = await loadLogic();
  const statuses = [
    { serverId: "srv-1", harness: "claude", scope: "global", active: true },
    { serverId: "srv-1", harness: "claude", scope: "project", active: false },
    { serverId: "srv-1", harness: "codex", scope: "global", active: true },
    { serverId: "srv-2", harness: "claude", scope: "global", active: true },
  ];
  assert.deepEqual(activeTargetsOf("srv-1", statuses), [
    { harness: "claude", scope: "global" },
    { harness: "codex", scope: "global" },
  ]);
  assert.deepEqual(activeTargetsOf("srv-missing", statuses), []);
  assert.deepEqual(activeTargetsOf("srv-1", []), []);
  assert.deepEqual(activeTargetsOf("srv-1", undefined), []);
});

test("foundInSummary lists harness/scope pairs", async () => {
  const { foundInSummary } = await loadLogic();
  const s = foundInSummary([
    { harness: "claude", scope: "global" },
    { harness: "cursor", scope: "project" },
  ]);
  assert.match(s, /Claude Code/);
  assert.match(s, /global/);
  assert.match(s, /cursor|Cursor/);
});

test("formatDiffValue renders empty/undefined as an explicit dash", async () => {
  const { formatDiffValue } = await loadLogic();
  assert.equal(formatDiffValue(undefined), "—");
  assert.equal(formatDiffValue(""), "—");
  assert.equal(formatDiffValue("npx"), "npx");
});

test("splitReconcile tolerates missing fields", async () => {
  const { splitReconcile } = await loadLogic();
  const r = splitReconcile(null);
  assert.deepEqual(r, { imports: [], conflicts: [], warnings: [] });
  const r2 = splitReconcile({ imports: [{ key: "x" }] });
  assert.equal(r2.imports.length, 1);
  assert.deepEqual(r2.conflicts, []);
});
