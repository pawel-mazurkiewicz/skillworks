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

test("SDK server registers exactly the 9 skill tools", async () => {
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
