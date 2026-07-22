const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");

async function withClient(fn) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sw-mcp-"));
  const appHome = path.join(home, ".skillworks");
  const vault = path.join(appHome, "vault", "demo", "hello");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "SKILL.md"), "---\nname: Hello\ndescription: demo\n---\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "src", "mcp-server.js"), "--app-home", appHome, "--home", home],
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("SDK server lists tools and runs search_skills", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("search_skills"), `search_skills missing: ${names}`);
    const res = await client.callTool({ name: "search_skills", arguments: { query: "" } });
    const text = res.content.map((c) => c.text).join("");
    assert.match(text, /Hello|hello|demo/);
  });
});

test("SDK server registers exactly the 9 skill tools + 5 MCP-server-management tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = [
      "list_skill_sets",
      "activate_skill_set",
      "create_skill_set",
      "delete_skill_set",
      "add_project",
      "activate_project",
      "search_skills",
      "add_skills_to_project",
      "remove_skills_from_project",
      "list_mcp_servers",
      "add_mcp_server",
      "activate_mcp_server",
      "deactivate_mcp_server",
      "remove_mcp_server",
    ].sort();
    assert.deepEqual(names, expected, `unexpected tool set: ${names}`);
  });
});

test("SDK server exercises add_project and list_skill_sets", async () => {
  await withClient(async (client) => {
    const otherProject = await fs.mkdtemp(path.join(os.tmpdir(), "sw-mcp-project-"));
    const addRes = await client.callTool({ name: "add_project", arguments: { path: otherProject } });
    assert.ok(!addRes.isError, `add_project errored: ${JSON.stringify(addRes)}`);
    const addPayload = JSON.parse(addRes.content.map((c) => c.text).join(""));
    assert.equal(addPayload.project.path, otherProject);

    const listRes = await client.callTool({ name: "list_skill_sets", arguments: {} });
    assert.ok(!listRes.isError, `list_skill_sets errored: ${JSON.stringify(listRes)}`);
    const listPayload = JSON.parse(listRes.content.map((c) => c.text).join(""));
    assert.ok(Array.isArray(listPayload.global), "list_skill_sets returns a global array");
  });
});

function payloadOf(res) {
  return JSON.parse(res.content.map((c) => c.text).join(""));
}

test("MCP-server tool flow: add -> list (present) -> activate cursor/global -> list (active) -> deactivate -> list (inactive) -> remove -> gone", async () => {
  await withClient(async (client) => {
    const spec = {
      id: "context7",
      name: "Context7",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    };

    const addRes = await client.callTool({ name: "add_mcp_server", arguments: { spec } });
    assert.ok(!addRes.isError, `add_mcp_server errored: ${JSON.stringify(addRes)}`);
    const addPayload = payloadOf(addRes);
    assert.equal(addPayload.server.id, "context7");
    assert.equal(addPayload.server.source.kind, "manual"); // normalized default

    const listRes1 = await client.callTool({ name: "list_mcp_servers", arguments: {} });
    assert.ok(!listRes1.isError, `list_mcp_servers errored: ${JSON.stringify(listRes1)}`);
    const listPayload1 = payloadOf(listRes1);
    assert.ok(listPayload1.servers.some((s) => s.id === "context7"));
    const cursorGlobalRow1 = listPayload1.status.find((r) => r.serverId === "context7" && r.harness === "cursor" && r.scope === "global");
    assert.equal(cursorGlobalRow1.active, false);

    const activateRes = await client.callTool({
      name: "activate_mcp_server",
      arguments: { id: "context7", harness: "cursor", scope: "global" },
    });
    assert.ok(!activateRes.isError, `activate_mcp_server errored: ${JSON.stringify(activateRes)}`);
    const activatePayload = payloadOf(activateRes);
    assert.ok(activatePayload.configPath.endsWith(path.join(".cursor", "mcp.json")));
    assert.equal(activatePayload.trustNote, undefined); // cursor has no project trust note

    const listRes2 = await client.callTool({ name: "list_mcp_servers", arguments: {} });
    const listPayload2 = payloadOf(listRes2);
    const cursorGlobalRow2 = listPayload2.status.find((r) => r.serverId === "context7" && r.harness === "cursor" && r.scope === "global");
    assert.equal(cursorGlobalRow2.active, true);

    const deactivateRes = await client.callTool({
      name: "deactivate_mcp_server",
      arguments: { id: "context7", harness: "cursor", scope: "global" },
    });
    assert.ok(!deactivateRes.isError, `deactivate_mcp_server errored: ${JSON.stringify(deactivateRes)}`);
    const deactivatePayload = payloadOf(deactivateRes);
    assert.equal(deactivatePayload.removed, true);

    const listRes3 = await client.callTool({ name: "list_mcp_servers", arguments: {} });
    const listPayload3 = payloadOf(listRes3);
    const cursorGlobalRow3 = listPayload3.status.find((r) => r.serverId === "context7" && r.harness === "cursor" && r.scope === "global");
    assert.equal(cursorGlobalRow3.active, false);

    const removeRes = await client.callTool({ name: "remove_mcp_server", arguments: { id: "context7" } });
    assert.ok(!removeRes.isError, `remove_mcp_server errored: ${JSON.stringify(removeRes)}`);
    const removePayload = payloadOf(removeRes);
    assert.equal(removePayload.removed, "context7");
    assert.deepEqual(removePayload.stillActiveAt, []);

    const listRes4 = await client.callTool({ name: "list_mcp_servers", arguments: {} });
    const listPayload4 = payloadOf(listRes4);
    assert.ok(!listPayload4.servers.some((s) => s.id === "context7"), "context7 should be gone from the library");
  });
});

test("add_mcp_server rejects a duplicate id and an invalid spec", async () => {
  await withClient(async (client) => {
    const spec = { id: "dup-server", name: "Dup", transport: "stdio", command: "npx" };
    const first = await client.callTool({ name: "add_mcp_server", arguments: { spec } });
    assert.ok(!first.isError, `first add_mcp_server errored: ${JSON.stringify(first)}`);

    const dup = await client.callTool({ name: "add_mcp_server", arguments: { spec } });
    assert.ok(dup.isError, "adding a duplicate id should error");

    const badTransport = await client.callTool({
      name: "add_mcp_server",
      arguments: { spec: { id: "bad-remote", name: "Bad", transport: "http" } },
    });
    assert.ok(badTransport.isError, "http transport without a url should error");
  });
});

test("activate_mcp_server errors on an unknown id and an unknown harness", async () => {
  await withClient(async (client) => {
    const unknownId = await client.callTool({
      name: "activate_mcp_server",
      arguments: { id: "does-not-exist", harness: "cursor", scope: "global" },
    });
    assert.ok(unknownId.isError, "activating an unknown id should error");

    const spec = { id: "harness-check", name: "HC", transport: "stdio", command: "npx" };
    await client.callTool({ name: "add_mcp_server", arguments: { spec } });
    const unknownHarness = await client.callTool({
      name: "activate_mcp_server",
      arguments: { id: "harness-check", harness: "emacs", scope: "global" },
    });
    assert.ok(unknownHarness.isError, "activating an unknown harness should error");
  });
});
