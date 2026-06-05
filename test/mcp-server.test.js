const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SERVER = path.join(__dirname, "..", "src", "mcp-server.js");

async function writeSkill(dir, name, description) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

/**
 * Minimal stdio MCP client: spawns the server, frames JSON-RPC requests with
 * Content-Length headers, and resolves responses by id.
 */
function createClient({ appHome, home, project, harness }) {
  const args = ["--app-home", appHome, "--home", home, "--project", project];
  if (harness) {
    args.push("--harness", harness);
  }
  const child = spawn("node", [SERVER, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) return;
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;
      const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.slice(bodyEnd);
      const message = JSON.parse(body);
      if (message.id != null && pending.has(message.id)) {
        const { resolve } = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`,
      );
    });
  }

  async function call(name, args) {
    const response = await send("tools/call", { name, arguments: args });
    if (response.error) {
      throw new Error(response.error.message);
    }
    return JSON.parse(response.result.content[0].text);
  }

  return {
    send,
    call,
    close() {
      child.stdin.end();
      child.kill();
    },
    stderr: () => stderr,
  };
}

async function setupFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-mcp-"));
  const home = path.join(root, "home");
  const appHome = path.join(home, ".agent-skill-manager");
  const vault = path.join(appHome, "vault");
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  await writeSkill(path.join(vault, "ios", "swiftui"), "SwiftUI Patterns", "Use for SwiftUI iOS views.");
  await writeSkill(path.join(vault, "rust", "tokio"), "Tokio Async", "Use for async Rust runtimes.");
  return { root, home, appHome, vault, project };
}

test("lists the new project + skill tools", async () => {
  const fixture = await setupFixture();
  const client = createClient({
    appHome: fixture.appHome,
    home: fixture.home,
    project: fixture.project,
    harness: "claude",
  });
  try {
    const response = await client.send("tools/list", {});
    const names = response.result.tools.map((t) => t.name);
    for (const expected of [
      "add_project",
      "activate_project",
      "search_skills",
      "add_skills_to_project",
      "remove_skills_from_project",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  } finally {
    client.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("search_skills matches by name, description, and tags", async () => {
  const fixture = await setupFixture();
  const client = createClient({
    appHome: fixture.appHome,
    home: fixture.home,
    project: fixture.project,
    harness: "claude",
  });
  try {
    const all = await client.call("search_skills", {});
    assert.equal(all.total, 2);

    const swift = await client.call("search_skills", { query: "swiftui" });
    assert.equal(swift.total, 1);
    assert.equal(swift.skills[0].id, "ios/swiftui");

    const async = await client.call("search_skills", { query: "async rust" });
    assert.equal(async.total, 1);
    assert.equal(async.skills[0].id, "rust/tokio");
  } finally {
    client.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("activate_project sets the session default project", async () => {
  const fixture = await setupFixture();
  const otherProject = path.join(fixture.root, "other");
  await fs.mkdir(otherProject, { recursive: true });
  const client = createClient({
    appHome: fixture.appHome,
    home: fixture.home,
    project: fixture.project,
    harness: "claude",
  });
  try {
    const result = await client.call("activate_project", { path: otherProject });
    assert.equal(result.activeProject, otherProject);
    assert.equal(result.state.project.path, otherProject);

    // add without projectPath should now act on the activated project
    await client.call("add_skills_to_project", { skills: ["ios/swiftui"] });
    const linked = await fs.readdir(path.join(otherProject, ".claude", "skills"));
    assert.ok(linked.length >= 1, "skill linked into activated project");
  } finally {
    client.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("add/remove skills default to the registered harness and honor override", async () => {
  const fixture = await setupFixture();
  const client = createClient({
    appHome: fixture.appHome,
    home: fixture.home,
    project: fixture.project,
    harness: "claude",
  });
  try {
    // default harness = claude -> .claude/skills
    const added = await client.call("add_skills_to_project", { skills: ["ios/swiftui"] });
    assert.equal(added.targetId, "claude-project");
    const claudeDir = path.join(fixture.project, ".claude", "skills");
    assert.ok((await fs.readdir(claudeDir)).length >= 1);

    // explicit harness override -> codex
    const codexAdded = await client.call("add_skills_to_project", {
      skills: ["rust/tokio"],
      harness: "codex",
    });
    assert.equal(codexAdded.targetId, "codex-project");
    const codexDir = path.join(fixture.project, ".codex", "skills");
    assert.ok((await fs.readdir(codexDir)).length >= 1);

    // remove from claude
    await client.call("remove_skills_from_project", { skills: ["ios/swiftui"] });
    const remaining = await fs
      .readdir(claudeDir)
      .then((entries) => entries.filter((e) => e !== ".agent-skill-manager.json"))
      .catch(() => []);
    assert.equal(remaining.length, 0, "skill unlinked from claude project dir");
  } finally {
    client.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("add_skills_to_project without a harness identity errors clearly", async () => {
  const fixture = await setupFixture();
  const client = createClient({
    appHome: fixture.appHome,
    home: fixture.home,
    project: fixture.project,
    // no --harness registered
  });
  try {
    await assert.rejects(
      () => client.call("add_skills_to_project", { skills: ["ios/swiftui"] }),
      /Cannot determine harness/,
    );
  } finally {
    client.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
