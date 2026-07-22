# MCP Agent-Assisted Tools (Phase E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Node MCP stdio server to the official MCP SDK, then add agent-facing MCP-server management tools that mirror the Rust library/adapter/engine semantics.

**Architecture:** Part 1 replaces the hand-rolled JSON-RPC/stdio framing in `src/mcp-server.js` with `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), re-registering the 9 existing skill tools unchanged (`core.js` untouched). Part 2 adds `src/mcp-core.js` — a JS mirror of `spec.rs`/`adapters.rs`/`engine.rs` (library, adapter table, JSON+TOML engine) — plus 5 SDK tools (`list/add/activate/deactivate/remove_mcp_server`) that read/write the same `<appHome>/mcp/servers.json` the desktop app uses.

**Tech Stack:** Node.js (CommonJS `src/`), `@modelcontextprotocol/sdk` (v1.x), `zod`, `smol-toml`, `node --test`.

## Global Constraints

- **Stable SDK v1.x.** Add `@modelcontextprotocol/sdk@^1` (NOT the v2-alpha `@modelcontextprotocol/server` split). After install, VERIFY the exact import subpaths and `registerTool` signature against `node_modules/@modelcontextprotocol/sdk/package.json` `exports` — v1.x is typically `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`) and `@modelcontextprotocol/sdk/server/stdio.js` (`StdioServerTransport`), with `registerTool(name, { description, inputSchema }, handler)` where `inputSchema` is a **raw Zod shape object** (`{ field: z.string() }`) and the handler returns `{ content: [{ type: "text", text }] }`.
- **CJS interop.** `src/` is CommonJS; `core.js` stays `require`-based and untouched in Part 1. Load the ESM SDK from `mcp-server.js` via **dynamic `import()`** inside an async bootstrap (do NOT convert the repo to ESM or add `"type":"module"`).
- **Preserve existing behavior.** The 9 skill tools keep identical names, arguments, and returned payloads; the `--harness`/`--app-home`/`--home` CLI args and the session-scoped active project (mutated by `activate_project`) are preserved.
- **Lockstep with Rust.** The JS adapter table mirrors `src-tauri/src/backend/mcp/adapters.rs` **including the hardening additions** (Copilot renders `tools: ["*"]`, OpenCode renders `enabled: true`). A parity test guards drift.
- **Shared library file.** `<appHome>/mcp/servers.json`, shape `{ "servers": [...] }`, camelCase — the same file the Rust side reads/writes.
- **Safe writes.** Config-file mutations back up the prior file and write atomically with a **unique** temp name (pid + counter, not just pid — mirrors the Rust hardening fix).
- Commit messages: conventional, **no `Co-Authored-By` trailer**.
- Gate before the phase is done: `npm test` (node --test), `npm run build`, `npm run test:ui` all green (Part 1 and Part 2 each add `node --test` suites; no Rust change so `cargo test` is unaffected).

## File Structure

- `package.json` — add `@modelcontextprotocol/sdk`, `zod`, `smol-toml` to `dependencies`.
- `src/mcp-server.js` — rewritten onto the SDK; gains the 5 MCP tools in Part 2.
- `src/mcp-core.js` — NEW (Part 2): library, adapter table, engine, status. Required by `mcp-server.js`.
- `src/core.js` — untouched (Part 1); Part 2 does not modify it (mcp-core.js is standalone, reusing only small pure helpers by copy if needed).
- `test/mcp-server-sdk.test.js` — NEW: stdio SDK smoke (Part 1).
- `test/mcp-core.test.js` — NEW: spec/adapter/engine/tool tests + adapter parity (Part 2).

---

## PART 1 — MCP SDK migration

### Task 1: SDK deps + bootstrap + first tool + smoke test

**Files:**
- Modify: `package.json`
- Modify: `src/mcp-server.js`
- Create: `test/mcp-server-sdk.test.js`

**Interfaces:**
- Produces: an SDK-based server exposing (at least) `search_skills`; a `registerAllTools(server)` seam later tasks extend.

- [ ] **Step 1: Add dependencies**

Run: `npm install @modelcontextprotocol/sdk@^1 zod`
Then confirm the import paths:
Run: `node -e "console.log(Object.keys(require('@modelcontextprotocol/sdk/package.json').exports))"`
Expected: lists `./server/mcp.js` and `./server/stdio.js` (or equivalent). Record the exact paths; use them below.

- [ ] **Step 2: Write the failing smoke test**

Create `test/mcp-server-sdk.test.js`. It spawns the server over stdio, performs the MCP `initialize` handshake + `tools/list`, and calls `search_skills`. Use the SDK's own client to avoid hand-rolling JSON-RPC:

```js
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
  try { return await fn(client); } finally { await client.close(); }
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
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/mcp-server-sdk.test.js`
Expected: FAIL (server still hand-rolled; SDK client can't handshake, or search_skills output shape differs).

- [ ] **Step 4: Rewrite the server bootstrap onto the SDK**

Replace the manual stdin/`drainMessages`/`handleMessage`/`sendResult`/`sendError` machinery in `src/mcp-server.js` with an SDK bootstrap. Keep the top-of-file arg parsing (`parseArgs`, `resolveInitialProject`, `normalizeHarness`), `createManager`, `activeProject`, and `HARNESS_PROJECT_TARGETS`. Structure:

```js
#!/usr/bin/env node
const path = require("node:path");
const { createManager } = require("./core");
// ... keep existing arg parsing + manager setup + activeProject + helpers ...

async function main() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const server = new McpServer({ name: MCP_SERVER_NAME, version: readVersion() });
  registerSkillTools(server, z);      // Task 1 registers search_skills; Task 2 the rest
  // registerMcpTools(server, z);     // added in Part 2 (Task 6)
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`MCP server fatal: ${err.stack || err}\n`);
  process.exit(1);
});
```

Add a `readVersion()` that reads `package.json` `version` (fallback `"0.0.0"`). Add a `toContent(payload)` helper returning `{ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }` (matches the current `toolResult` JSON-string convention so output is unchanged). Implement `registerSkillTools(server, z)` that, for THIS task, registers only `search_skills`:

```js
function registerSkillTools(server, z) {
  server.registerTool("search_skills", {
    description: "Search the Skillworks vault for skills by name, description, or tags. Returns matching skills with id, name, description, and tags.",
    inputSchema: {
      query: z.string().optional().describe("Search text matched against skill name, description, and tags. Empty returns all skills."),
      limit: z.number().optional().describe("Maximum number of results to return. Defaults to 50."),
    },
  }, async ({ query, limit }) => {
    const state = await manager.getState(normalizeProjectArg(undefined));
    const result = searchSkills(state.skills, query || "", limit || 50); // reuse existing search logic from the old handler
    return toContent({ skills: result });
  });
}
```

Port the existing `search_skills` handler body (the old `if (name === "search_skills")` branch) into this closure verbatim — same filtering, same returned shape. Preserve all other old tool handlers TEMPORARILY as dead code (or stash them) so Task 2 can port them; do not delete the logic you still need.

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/mcp-server-sdk.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/mcp-server.js test/mcp-server-sdk.test.js
git commit -m "feat(mcp-node): migrate server to MCP SDK; port search_skills"
```

### Task 2: Migrate the remaining 8 skill tools

**Files:**
- Modify: `src/mcp-server.js`
- Modify: `test/mcp-server-sdk.test.js`

**Interfaces:**
- Consumes: `registerSkillTools`, `toContent`, `manager`, `activeProject`, `HARNESS_PROJECT_TARGETS` from Task 1.

- [ ] **Step 1: Extend the smoke test to assert all 9 tools + exercise two more**

Add assertions that `listTools()` returns exactly these 9 names: `list_skill_sets, activate_skill_set, create_skill_set, delete_skill_set, add_project, activate_project, search_skills, add_skills_to_project, remove_skills_from_project`. Add a call to `add_project` (temp dir) and `list_skill_sets`, asserting non-error content.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/mcp-server-sdk.test.js`
Expected: FAIL (only `search_skills` registered).

- [ ] **Step 3: Port the other 8 tools into `registerSkillTools`**

For each remaining tool, add a `server.registerTool(name, { description, inputSchema: <zod shape> }, handler)` call. Translate each tool's existing JSON-Schema `inputSchema` (in the old `tools()` array) into a Zod raw shape:
- `type:"string"` → `z.string()`, add `.optional()` when not in `required`, `.describe(...)` from the JSON-schema description.
- `type:"number"` → `z.number().optional()`.
- `enum:[...]` → `z.enum([...])`.
- `type:"array", items:{type:"string"}` → `z.array(z.string())`.
- For `anyOf: [{required:["setId"]},{required:["name"]}]` (activate/delete set): keep both fields `.optional()` in the shape and enforce "one of setId/name" INSIDE the handler (throw a clear error if neither given) — the SDK validates the shape, the handler validates the cross-field rule.

Port each handler body verbatim from the corresponding old `if (name === "...")` branch (they already call `manager.*`); wrap the return in `toContent(...)` preserving the exact payload keys the old `toolResult(...)` used. Then DELETE the old `tools()` array, `callTool`, `handleMessage`, `drainMessages`, and the manual stdio glue.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/mcp-server-sdk.test.js`
Expected: PASS (9 tools; the three exercised ones return expected content).

- [ ] **Step 5: Full Part-1 gate + commit**

Run: `npm test && npm run build`
Expected: green.
```bash
git add src/mcp-server.js test/mcp-server-sdk.test.js
git commit -m "feat(mcp-node): port remaining skill tools onto the SDK; drop hand-rolled stdio"
```

---

## PART 2 — MCP-server management mirror + tools

### Task 3: `mcp-core.js` — spec model, validation, variant resolution

**Files:**
- Create: `src/mcp-core.js`
- Create: `test/mcp-core.test.js`

**Interfaces:**
- Produces: `validateSpec(spec)`, `resolveEffective(spec, harnessId, scope, variantLabel?)`, `loadLibrary(appHome)`, `saveLibrary(appHome, servers)`, `libraryPath(appHome)`. Mirrors `src-tauri/src/backend/mcp/spec.rs`.

- [ ] **Step 1: Write failing tests**

```js
const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const mcp = require("../src/mcp-core");

const stdioSpec = () => ({
  id: "context7", name: "Context7", source: { kind: "manual" },
  transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"],
  env: {}, headers: {}, variants: [],
});

test("validateSpec accepts a good stdio spec and rejects bad ids", () => {
  assert.doesNotThrow(() => mcp.validateSpec(stdioSpec()));
  for (const bad of ["", "Has Space", "UPPER", "-lead"]) {
    assert.throws(() => mcp.validateSpec({ ...stdioSpec(), id: bad }));
  }
});

test("validateSpec enforces transport field rules", () => {
  assert.throws(() => mcp.validateSpec({ ...stdioSpec(), command: undefined }));
  assert.throws(() => mcp.validateSpec({ ...stdioSpec(), transport: "http", url: undefined }));
});

test("resolveEffective: explicit label > appliesTo > canonical", () => {
  const spec = { ...stdioSpec(), variants: [
    { label: "http", transport: "http", url: "https://mcp.context7.com/mcp" },
    { label: "codex", appliesTo: { harness: "codex" }, args: ["-y", "ctx", "--codex"] },
  ]};
  assert.equal(mcp.resolveEffective(spec, "claude", "global", "http").transport, "http");
  assert.deepEqual(mcp.resolveEffective(spec, "codex", "global").args, ["-y", "ctx", "--codex"]);
  assert.equal(mcp.resolveEffective(spec, "cursor", "global").args.at(-1), "@upstash/context7-mcp");
});

test("library round-trips and missing file is empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-lib-"));
  assert.deepEqual(await mcp.loadLibrary(dir), []);
  await mcp.saveLibrary(dir, [stdioSpec()]);
  assert.deepEqual(await mcp.loadLibrary(dir), [stdioSpec()]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/mcp-core.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the spec module**

Create `src/mcp-core.js` mirroring `spec.rs`. Complete code for validation + resolution:

```js
const path = require("node:path");
const fs = require("node:fs/promises");

const TRANSPORTS = new Set(["stdio", "http", "sse"]);
const SCOPES = new Set(["global", "project"]);

function validId(id) { return typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id); }

function checkTransportFields(transport, command, url, ctx) {
  if (!TRANSPORTS.has(transport)) throw new Error(`${ctx}: unknown transport ${transport}`);
  if (transport === "stdio" && !(command && command.length)) throw new Error(`${ctx}: stdio requires a command`);
  if ((transport === "http" || transport === "sse") && !(url && url.length)) throw new Error(`${ctx}: ${transport} requires a url`);
}

function validateSpec(spec) {
  if (!validId(spec.id)) throw new Error(`Invalid server id ${JSON.stringify(spec.id)}: must match ^[a-z0-9][a-z0-9-]*$`);
  if (!spec.name || !String(spec.name).trim()) throw new Error("Server name is required");
  checkTransportFields(spec.transport, spec.command, spec.url, spec.id);
  const seen = new Set();
  for (const v of spec.variants || []) {
    if (!v.label || !v.label.trim()) throw new Error(`${spec.id}: variant label must not be empty`);
    if (seen.has(v.label)) throw new Error(`${spec.id}: duplicate variant label ${JSON.stringify(v.label)}`);
    seen.add(v.label);
    if (v.appliesTo) {
      if (v.appliesTo.harness && !adapterFor(v.appliesTo.harness, true)) throw new Error(`${spec.id}: variant ${v.label} targets unknown harness ${v.appliesTo.harness}`);
      if (v.appliesTo.scope && !SCOPES.has(v.appliesTo.scope)) throw new Error(`${spec.id}: variant ${v.label} invalid scope ${v.appliesTo.scope}`);
    }
    checkTransportFields(v.transport || spec.transport, v.command ?? spec.command, v.url ?? spec.url, `${spec.id} variant ${v.label}`);
  }
}

function resolveEffective(spec, harnessId, scope, variantLabel) {
  let variant = null;
  if (variantLabel != null) {
    variant = (spec.variants || []).find((v) => v.label === variantLabel);
    if (!variant) throw new Error(`Variant ${JSON.stringify(variantLabel)} not found on server ${spec.id}`);
  } else {
    let best = -1;
    for (const v of spec.variants || []) {
      const a = v.appliesTo; if (!a) continue;
      let score = 0;
      if (a.harness) { if (a.harness !== harnessId) continue; score += 2; }
      if (a.scope) { if (a.scope !== scope) continue; score += 1; }
      if (score > best) { best = score; variant = v; }
    }
  }
  const inv = {
    transport: spec.transport, command: spec.command, args: [...(spec.args || [])],
    env: { ...(spec.env || {}) }, url: spec.url, headers: { ...(spec.headers || {}) },
  };
  if (variant) {
    if (variant.transport) inv.transport = variant.transport;
    if (variant.command !== undefined) inv.command = variant.command;
    if (variant.args) inv.args = [...variant.args];
    if (variant.env) inv.env = { ...variant.env };
    if (variant.url !== undefined) inv.url = variant.url;
    if (variant.headers) inv.headers = { ...variant.headers };
  }
  checkTransportFields(inv.transport, inv.command, inv.url, spec.id);
  return inv;
}

function libraryPath(appHome) { return path.join(appHome, "mcp", "servers.json"); }

async function loadLibrary(appHome) {
  try {
    const raw = await fs.readFile(libraryPath(appHome), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.servers) ? parsed.servers : [];
  } catch (e) { if (e.code === "ENOENT") return []; throw e; }
}

async function saveLibrary(appHome, servers) {
  const p = libraryPath(appHome);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await writeFileAtomic(p, `${JSON.stringify({ servers }, null, 2)}\n`);
}

// writeFileAtomic + adapterFor come from Tasks 4/5; declared here, defined there,
// all in the same module. (When implementing, put the whole module together.)
module.exports = { validateSpec, resolveEffective, libraryPath, loadLibrary, saveLibrary /* + Task 4/5 exports */ };
```

Note: `adapterFor` and `writeFileAtomic` are defined in Tasks 4 and 5 (same module). Implement Task 3 with a temporary local `writeFileAtomic` (pid+counter temp, mkdir, rename) and a stub `adapterFor` that Task 4 fills in — OR implement Tasks 3–5 in one sitting since they share `mcp-core.js`. Either way each task's tests must pass when its commit lands.

- [ ] **Step 4: Run tests, then commit**

Run: `node --test test/mcp-core.test.js`
Expected: PASS.
```bash
git add src/mcp-core.js test/mcp-core.test.js
git commit -m "feat(mcp-node): spec model, validation, variant resolution, library IO"
```

### Task 4: Adapter table + parity guard

**Files:**
- Modify: `src/mcp-core.js`
- Modify: `test/mcp-core.test.js`

**Interfaces:**
- Produces: `ADAPTERS` (7 entries), `adapters()`, `adapterFor(id, soft?)`, `configPathFor(adapter, scope, homeDir, projectRoot?)`. Mirrors `adapters.rs`.

- [ ] **Step 1: Write the parity + path tests**

```js
const EXPECTED = [
  ["claude","json",[".claude.json"],[".mcp.json"],["mcpServers"],"separateArgs","env","claudeTypes","url",true],
  ["codex","toml",[".codex","config.toml"],[".codex","config.toml"],["mcp_servers"],"separateArgs","env","none","url",true],
  ["cursor","json",[".cursor","mcp.json"],[".cursor","mcp.json"],["mcpServers"],"separateArgs","env","none","url",false],
  ["opencode","json",[".config","opencode","opencode.json"],["opencode.json"],["mcp"],"argvArray","environment","openCodeTypes","url",false],
  ["gemini","json",[".gemini","settings.json"],[".gemini","settings.json"],["mcpServers"],"separateArgs","env","none","geminiSplit",false],
  ["copilot","json",[".copilot","mcp-config.json"],[".mcp.json"],["mcpServers"],"separateArgs","env","copilotTypes","url",false],
  ["kiro","json",[".kiro","settings","mcp.json"],[".kiro","settings","mcp.json"],["mcpServers"],"separateArgs","env","none","url",false],
];

test("adapter table matches the Rust table (lockstep parity)", () => {
  const got = mcp.adapters().map((a) => [a.harnessId, a.format, a.globalPathParts, a.projectPathParts, a.keyPath, a.commandStyle, a.envField, a.discriminator, a.remoteUrlField, a.projectTrustNote]);
  assert.deepEqual(got, EXPECTED);
});

test("configPathFor resolves global + project", () => {
  const a = mcp.adapterFor("opencode");
  assert.equal(mcp.configPathFor(a, "global", "/home/u"), path.join("/home/u",".config","opencode","opencode.json"));
  assert.equal(mcp.configPathFor(a, "project", "/home/u", "/repo"), path.join("/repo","opencode.json"));
  assert.throws(() => mcp.configPathFor(mcp.adapterFor("claude"), "project", "/home/u"));
});
```

- [ ] **Step 2: Run → FAIL.** `node --test test/mcp-core.test.js`

- [ ] **Step 3: Implement the table** (verbatim values from `adapters.rs`):

```js
const ADAPTERS = [
  { harnessId: "claude", label: "Claude Code", format: "json", globalPathParts: [".claude.json"], projectPathParts: [".mcp.json"], keyPath: ["mcpServers"], commandStyle: "separateArgs", envField: "env", discriminator: "claudeTypes", remoteUrlField: "url", projectTrustNote: true },
  { harnessId: "codex", label: "Codex", format: "toml", globalPathParts: [".codex","config.toml"], projectPathParts: [".codex","config.toml"], keyPath: ["mcp_servers"], commandStyle: "separateArgs", envField: "env", discriminator: "none", remoteUrlField: "url", projectTrustNote: true },
  { harnessId: "cursor", label: "Cursor", format: "json", globalPathParts: [".cursor","mcp.json"], projectPathParts: [".cursor","mcp.json"], keyPath: ["mcpServers"], commandStyle: "separateArgs", envField: "env", discriminator: "none", remoteUrlField: "url", projectTrustNote: false },
  { harnessId: "opencode", label: "OpenCode", format: "json", globalPathParts: [".config","opencode","opencode.json"], projectPathParts: ["opencode.json"], keyPath: ["mcp"], commandStyle: "argvArray", envField: "environment", discriminator: "openCodeTypes", remoteUrlField: "url", projectTrustNote: false },
  { harnessId: "gemini", label: "Gemini CLI", format: "json", globalPathParts: [".gemini","settings.json"], projectPathParts: [".gemini","settings.json"], keyPath: ["mcpServers"], commandStyle: "separateArgs", envField: "env", discriminator: "none", remoteUrlField: "geminiSplit", projectTrustNote: false },
  { harnessId: "copilot", label: "Copilot CLI", format: "json", globalPathParts: [".copilot","mcp-config.json"], projectPathParts: [".mcp.json"], keyPath: ["mcpServers"], commandStyle: "separateArgs", envField: "env", discriminator: "copilotTypes", remoteUrlField: "url", projectTrustNote: false },
  { harnessId: "kiro", label: "Kiro", format: "json", globalPathParts: [".kiro","settings","mcp.json"], projectPathParts: [".kiro","settings","mcp.json"], keyPath: ["mcpServers"], commandStyle: "separateArgs", envField: "env", discriminator: "none", remoteUrlField: "url", projectTrustNote: false },
];
function adapters() { return ADAPTERS; }
function adapterFor(id, soft) { const a = ADAPTERS.find((x) => x.harnessId === id); if (!a && !soft) throw new Error(`Unsupported MCP harness: ${id}`); return a || null; }
function configPathFor(adapter, scope, homeDir, projectRoot) {
  let base, parts;
  if (scope === "global") { base = homeDir; parts = adapter.globalPathParts; }
  else if (scope === "project") { if (!projectRoot) throw new Error("Project scope requires an active project"); base = projectRoot; parts = adapter.projectPathParts; }
  else throw new Error(`Unknown scope: ${scope}`);
  return path.join(base, ...parts);
}
```

Add these to `module.exports`. **Header comment on both `ADAPTERS` and `adapters.rs`:** "Mirror — keep in lockstep; the Node parity test `adapter table matches the Rust table` must be updated in the same PR as any `adapters.rs` change."

- [ ] **Step 4: Run → PASS, commit**

```bash
git add src/mcp-core.js test/mcp-core.test.js
git commit -m "feat(mcp-node): adapter table mirror + lockstep parity test"
```

### Task 5: Engine — render + JSON/TOML read/write/remove

**Files:**
- Modify: `package.json` (add `smol-toml`), `src/mcp-core.js`, `test/mcp-core.test.js`

**Interfaces:**
- Produces: `renderEntry(adapter, inv)`, `writeEntry(path, adapter, id, inv)`, `removeEntry(path, adapter, id)`, `readEntries(path, adapter)`, `writeFileAtomic(path, text)`. Mirrors `engine.rs`.

- [ ] **Step 1: Add `smol-toml`** — `npm install smol-toml`.

- [ ] **Step 2: Write failing render + round-trip tests**

Cover, per adapter: stdio render (separateArgs vs opencode argvArray + `environment` + `enabled:true`; copilot `tools:["*"]`; claude `type:"stdio"`), remote render (gemini `httpUrl` for http / `url` for sse; codex TOML `url`), and a write→read→remove round trip on a temp file preserving a sibling entry + an unknown top-level key. Example assertions:

```js
test("render claude stdio + copilot tools + opencode shape", () => {
  const inv = { transport: "stdio", command: "npx", args: ["-y","p"], env: { K: "V" }, headers: {} };
  assert.deepEqual(mcp.renderEntry(mcp.adapterFor("claude"), inv), { type: "stdio", command: "npx", args: ["-y","p"], env: { K: "V" } });
  assert.deepEqual(mcp.renderEntry(mcp.adapterFor("copilot"), inv), { type: "local", command: "npx", args: ["-y","p"], env: { K: "V" }, tools: ["*"] });
  assert.deepEqual(mcp.renderEntry(mcp.adapterFor("opencode"), inv), { type: "local", command: ["npx","-y","p"], environment: { K: "V" }, enabled: true });
});

test("write/read/remove preserves siblings (cursor JSON)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-eng-"));
  const p = path.join(dir, "mcp.json");
  await fs.writeFile(p, JSON.stringify({ mcpServers: { other: { command: "x" } }, custom: 1 }));
  const a = mcp.adapterFor("cursor");
  await mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: [], env: {}, headers: {} });
  const entries = await mcp.readEntries(p, a);
  assert.deepEqual(new Set(entries.map(([k]) => k)), new Set(["other", "context7"]));
  assert.equal(JSON.parse(await fs.readFile(p, "utf8")).custom, 1);
  assert.equal(await mcp.removeEntry(p, a, "context7"), true);
  assert.equal((await mcp.readEntries(p, a)).length, 1);
});

test("codex TOML round trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-toml-"));
  const p = path.join(dir, "config.toml");
  await fs.writeFile(p, 'model = "gpt-5"\n[mcp_servers.other]\ncommand = "x"\n');
  const a = mcp.adapterFor("codex");
  await mcp.writeEntry(p, a, "context7", { transport: "stdio", command: "npx", args: ["-y","p"], env: { K: "V" }, headers: {} });
  const entries = await mcp.readEntries(p, a);
  const ctx = entries.find(([k]) => k === "context7")[1];
  assert.equal(ctx.command, "npx");
  assert.match(await fs.readFile(p, "utf8"), /gpt-5/); // sibling scalar preserved
});
```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement the engine.** Complete `renderEntry` (mirror `render_entry_json`/`render_entry_toml` + `discriminator_value`):

```js
const TOML = require("smol-toml");

function discriminatorValue(disc, transport) {
  if (disc === "none") return null;
  if (disc === "claudeTypes") return transport;                       // stdio|http|sse
  if (disc === "openCodeTypes") return transport === "stdio" ? "local" : "remote";
  if (disc === "copilotTypes") return transport === "stdio" ? "local" : transport; // local|http|sse
  return null;
}

function renderEntry(adapter, inv) {
  const obj = {};
  const t = discriminatorValue(adapter.discriminator, inv.transport);
  if (t) obj.type = t;
  if (inv.transport === "stdio") {
    const command = inv.command || "";
    if (adapter.commandStyle === "argvArray") obj.command = [command, ...inv.args];
    else { obj.command = command; obj.args = inv.args; }
    if (Object.keys(inv.env || {}).length) obj[adapter.envField] = { ...inv.env };
  } else {
    const urlKey = adapter.remoteUrlField === "geminiSplit" && inv.transport === "http" ? "httpUrl" : "url";
    obj[urlKey] = inv.url || "";
    if (Object.keys(inv.headers || {}).length) obj[adapter.format === "toml" ? "http_headers" : "headers"] = { ...inv.headers };
  }
  if (adapter.discriminator === "openCodeTypes") obj.enabled = true;
  if (adapter.harnessId === "copilot") obj.tools = ["*"];
  return obj;
}
```

For IO, mirror `engine.rs`: navigate `keyPath` in a parsed JSON object (create objects as needed), insert/replace/remove only `id`, preserve unknown keys; for TOML use `TOML.parse`/`TOML.stringify` on the whole doc, navigate `mcp_servers.<id>`. Every mutation: read (missing file → empty doc; malformed → throw, never clobber), back up the existing file (copy to `<file>.skillworks-backup-<pid>-<counter>`), then `writeFileAtomic`. `readEntries` returns `[[id, entryObject], ...]`. `writeFileAtomic(p, text)`:

```js
let __seq = 0;
async function writeFileAtomic(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${__seq++}.tmp`;   // unique temp (mirrors Rust hardening fix)
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, p);
}
```

Backup helper: if the file exists, `fs.copyFile(p, backupName)` before writing. TOML caveat: comments/formatting on Codex configs may reflow (smol-toml doesn't preserve them) — acceptable per spec; add a one-line code comment noting it.

- [ ] **Step 5: Run → PASS. Gate + commit**

Run: `node --test test/mcp-core.test.js && npm test`
```bash
git add package.json package-lock.json src/mcp-core.js test/mcp-core.test.js
git commit -m "feat(mcp-node): JSON/TOML engine — render/write/remove/read with atomic backups"
```

### Task 6: Status helper + wire the 5 MCP tools

**Files:**
- Modify: `src/mcp-core.js` (add `mcpStatus`), `src/mcp-server.js` (register tools), `test/mcp-core.test.js`, `test/mcp-server-sdk.test.js`

**Interfaces:**
- Consumes: everything from Tasks 3–5; `manager`/`activeProject` from Part 1.
- Produces: `mcpStatus(appHome, homeDir, projectRoot?)`; SDK tools `list_mcp_servers`, `add_mcp_server`, `activate_mcp_server`, `deactivate_mcp_server`, `remove_mcp_server`.

- [ ] **Step 1: Write `mcpStatus` test + tool smoke test**

In `test/mcp-core.test.js`, test `mcpStatus`: seed a library server + write it active into a temp claude global config, assert the status row shows `active: true` for claude/global and `false` elsewhere. In `test/mcp-server-sdk.test.js`, add a flow: `add_mcp_server` (structured spec) → `list_mcp_servers` shows it → `activate_mcp_server` (cursor/global) → `list_mcp_servers` shows active → `deactivate_mcp_server` → inactive → `remove_mcp_server` → gone. Point the server at a temp `--app-home`/`--home`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `mcpStatus`** (mirror `mcp_status`): for each library server × each adapter × {global, project?}, resolve the config path, `readEntries`, and mark `active` when `id` is present; attach `trustNote` when `adapter.projectTrustNote && scope==="project"`. Tolerate unreadable configs per-target (skip/mark, don't throw the whole call).

- [ ] **Step 4: Register the 5 tools** in `src/mcp-server.js` via a new `registerMcpTools(server, z)` called from `main()`. Each resolves `appHome`/`homeDir` from the manager's options and `projectRoot` from `activeProject`/arg. Shapes:

```js
server.registerTool("add_mcp_server", {
  description: "Add an MCP server to the Skillworks library from a structured spec you assembled (e.g. after reading a README). Does not activate it.",
  inputSchema: { spec: z.object({
    id: z.string(), name: z.string(), description: z.string().optional(),
    source: z.object({ kind: z.string(), url: z.string().optional() }).optional(),
    transport: z.enum(["stdio","http","sse"]),
    command: z.string().optional(), args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(), url: z.string().optional(),
    headers: z.record(z.string()).optional(), variants: z.array(z.any()).optional(),
  }) },
}, async ({ spec }) => { /* normalize defaults, validateSpec, reject dup id, saveLibrary */ });
```

`list_mcp_servers({ projectPath? })` → `{ servers, status }`; `activate_mcp_server({ id, harness, scope, variantLabel?, projectPath? })` → resolveEffective + writeEntry, return `{ configPath, trustNote }`; `deactivate_mcp_server({ id, harness, scope, projectPath? })` → removeEntry; `remove_mcp_server({ id, projectPath? })` → drop from library, return targets still active as a warning. Reuse the skill tools' `normalizeProjectArg`/active-project defaulting. All wrapped in `toContent(...)`. Validation/harness/scope errors → thrown Error (SDK returns tool error).

- [ ] **Step 5: Run → PASS. Full gate + commit**

Run: `node --test && npm test && npm run build`
Expected: green (Part 1 + Part 2 suites).
```bash
git add src/mcp-core.js src/mcp-server.js test/mcp-core.test.js test/mcp-server-sdk.test.js
git commit -m "feat(mcp-node): status helper + list/add/activate/deactivate/remove_mcp_server tools"
```

---

## Self-Review

- **Spec coverage:** Part 1 SDK migration + 9 tools preserved (Tasks 1–2); Part 2 library/validate/resolve (Task 3), adapter table + parity (Task 4), engine JSON+TOML (Task 5), status + 5 tools (Task 6). Lockstep parity test (Task 4), TOML caveat (Task 5), unique-temp atomic write (Task 5) — all present.
- **Type/name consistency:** `renderEntry`/`writeEntry`/`readEntries`/`removeEntry`/`resolveEffective`/`validateSpec`/`adapterFor`/`configPathFor`/`mcpStatus` used consistently across tasks; `mcp-core.js` is a single module assembled over Tasks 3–5 (noted so an implementer building Task 3 stubs `adapterFor`/`writeFileAtomic` or implements 3–5 together).
- **Placeholder scan:** no TBD/TODO; each code step carries real code or a precise mirror reference to a named Rust function. The one deferred detail (exact SDK import subpaths) is explicitly a verify-against-installed-version step, not a placeholder.
- **Risk:** SDK v1.x vs v2-alpha API drift — mitigated by the Global-Constraints verify step and pinning `@^1`.
