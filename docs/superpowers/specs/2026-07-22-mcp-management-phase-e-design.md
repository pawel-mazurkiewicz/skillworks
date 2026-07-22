# MCP Server Management — Phase E: Agent-Assisted Tools (Node)

**Status:** Design approved (brainstorm), ready for implementation plan
**Date:** 2026-07-22
**Scope:** Phase E of the MCP-management feature (roadmap:
`2026-07-20-mcp-management-roadmap.md`). Exposes MCP-server management to a
coding agent through the legacy Node MCP stdio server (`src/mcp-server.js` +
`src/core.js`), mirroring the Rust library + adapter + engine semantics so an
agent can curate and activate servers headlessly. Two parts, shippable
separately: **Part 1** migrates the hand-rolled Node server onto the official
MCP SDK; **Part 2** adds the MCP-server management tools.

---

## 1. Motivation

The desktop app (Rust) is the primary MCP manager. The Node MCP server exists so
a **coding agent** can manage the same vault/config/manifest files headlessly —
today it only manages *skills*. Phase E gives the agent MCP-server tools so it
can, e.g., read a project's README itself, then add + activate the server it
describes — without a human opening the desktop app.

Two decisions shape this phase:
- **Robustness first.** The current `src/mcp-server.js` hand-rolls JSON-RPC over
  newline-delimited stdio and tool dispatch. Before growing the tool surface, we
  migrate it to the official MCP SDK for correct protocol handling, capability
  negotiation, and schema-validated tools.
- **Agent parses; no parser mirror.** The rationale that rejected a bundled local
  model — "the user's own frontier agent parses better" — applies here. The Node
  tools take a **structured spec**; the agent reads any URL/README itself and
  calls `add_mcp_server` with the fields. We do **not** mirror the ~1.5k-line
  Rust URL heuristic parser or the SSRF fetch guard.

## 2. Goals / Non-goals

**Goals:**
- **Part 1:** `src/mcp-server.js` runs on `@modelcontextprotocol/sdk`
  (`McpServer` + `StdioServerTransport`), with all **9 existing skill tools**
  re-registered via SDK tool registration + input schemas, preserving exact
  behavior, the `--harness`/`--app-home`/`--home` CLI args, and the
  session-scoped active project. `core.js` is untouched in Part 1.
- **Part 2:** a new MCP module in `core.js` mirroring the Rust `spec.rs`,
  `adapters.rs`, and `engine.rs`: the `servers.json` library, the 7-harness
  adapter table, and the JSON+TOML engine (render/write/remove/read) with
  backup-then-atomic writes; plus spec validation and variant resolution.
- **Part 2 tools** (SDK-registered): `list_mcp_servers`, `add_mcp_server`,
  `activate_mcp_server`, `deactivate_mcp_server`, `remove_mcp_server`.
- **All 7 harnesses**, including Codex (TOML) via a small `smol-toml` dependency.
- **Lockstep guard:** a parity test asserts the JS adapter table matches the Rust
  one's key facts, so drift is caught in CI.

**Non-goals:**
- URL heuristic parsing + SSRF fetch mirror (agent parses; no `add_from_url`).
- Comment-preserving Codex TOML (JS TOML libraries reflow; documented caveat).
- Reconcile/discovery tools on the Node side (possible later phase).
- Managing out-of-band enable/disable state (unchanged; presence only).
- Any change to the Rust/desktop side.

## 3. Part 1 — MCP SDK migration

**Dependency:** add `@modelcontextprotocol/sdk` (and its `zod` peer) to
`package.json` `dependencies`. The `src/` tree is CommonJS (`require`); the SDK
is ESM-first. The plan resolves interop (dynamic `import()` of the SDK from CJS,
or converting `mcp-server.js` to ESM / `.mjs`) — recommended: keep `core.js`
CommonJS untouched and load the SDK via dynamic `import()` in `mcp-server.js`, or
convert only `mcp-server.js` to ESM since it's the sole entry. Exact approach
confirmed against the SDK docs at plan time.

**Refactor:** replace the manual `process.stdin` newline framing +
`handleMessage` dispatch with:
- an `McpServer({ name: "skillworks", version })` instance,
- `StdioServerTransport`,
- one `server.registerTool(name, { description, inputSchema: <zod> }, handler)`
  per existing tool.

**Preserve exactly** (regression-guarded): the 9 skill tools
(`list_skill_sets`, `activate_skill_set`, `create_skill_set`,
`delete_skill_set`, `add_project`, `activate_project`, `search_skills`,
`add_skills_to_project`, `remove_skills_from_project`), their arguments and
returned payloads (wrap results in the SDK's content shape as the current
`toolResult` does), the CLI args, the `HARNESS_PROJECT_TARGETS` mapping, and the
session-scoped `activeProject` mutated by `activate_project`. Each handler still
calls the same `core.js` `manager` method — **no `core.js` change in Part 1**.

**Testable independently:** a stdio smoke test that initializes the SDK client,
lists tools (asserts the 9 are present with schemas), and invokes one
(`search_skills` against a temp vault) end-to-end. Part 1 is its own reviewable
unit / PR.

## 4. Part 2 — MCP management in `core.js`

A new section of `core.js` (or a sibling `src/mcp-core.js` required by
`core.js`/`mcp-server.js`) mirrors the Rust MCP backend. Prefer a dedicated
`src/mcp-core.js` module so the 2.6k-line `core.js` doesn't grow unbounded and
the mirror maps 1:1 to the Rust files.

### 4.1 Library (mirror `spec.rs`)
- `<appHome>/mcp/servers.json`, shape `{ "servers": [McpServerSpec, ...] }` —
  **the same file the desktop app reads/writes.**
- `McpServerSpec` fields identical to Rust (camelCase JSON is already the wire
  form): `id, name, description?, source{kind,url?}, transport, command?, args,
  env, url?, headers, variants[]`; `McpVariant{label, appliesTo?, ...overrides}`.
- `validateSpec` mirrors Rust: id `^[a-z0-9][a-z0-9-]*$`; stdio⇒command,
  http|sse⇒url; variant label non-empty/unique; `appliesTo` harness/scope valid.
- `resolveEffective(spec, harness, scope, variantLabel?)` mirrors Rust variant
  selection (explicit label > best `appliesTo` score > canonical).
- Load/save reuse the existing atomic-write + backup helpers in `core.js`
  (the skills side already writes JSON atomically with backups).

### 4.2 Adapter table (mirror `adapters.rs`)
A JS array of 7 descriptors with the exact fields from the Rust table: `harnessId,
label, format(json|toml), globalPathParts, projectPathParts, keyPath,
commandStyle(separateArgs|argvArray), envField, discriminator(none|claudeTypes|
openCodeTypes|copilotTypes), remoteUrlField(url|geminiSplit), projectTrustNote`.
Values copied verbatim from Phase A spec §4 (and the shipped `adapters.rs`,
**including the hardening additions**: Copilot renders `tools: ["*"]`).

### 4.3 Engine (mirror `engine.rs`)
- `renderEntry(adapter, effectiveInvocation)` → the harness dialect
  (JSON object or TOML table), applying command style, env field, discriminator,
  remote url field, OpenCode `enabled: true`, Copilot `tools: ["*"]`.
- `writeEntry(path, adapter, id, inv)` / `removeEntry(path, adapter, id)` /
  `readEntries(path, adapter)`: JSON via `JSON.parse`/`stringify` navigating
  `keyPath`, preserving unknown keys; TOML via `smol-toml` parse/stringify.
  Missing file ⇒ empty doc; malformed existing config ⇒ error, never clobber;
  backup-then-atomic on every mutation.
- **TOML caveat (documented):** `smol-toml` round-trips values but does not
  preserve comments/formatting like Rust `toml_edit`; a Codex write may reflow
  the file. Acceptable for the agent path; the desktop app remains the
  comment-preserving writer.

### 4.4 Activation status (for `list_mcp_servers`)
A `mcpStatus(projectPath?)` helper reads each v1 target and reports, per library
server × target, `{harness, scope, configPath, active, trustNote?}` — mirroring
Rust `mcp_status` (presence read only). Used by `list_mcp_servers`.

## 5. Part 2 — Tools (SDK-registered)

All take an optional `projectPath` (defaulting to the session active project for
`scope: "project"`), mirroring the skill tools' convention. Zod input schemas.

| Tool | Args | Behavior (core.js) |
|---|---|---|
| `list_mcp_servers` | `projectPath?` | library specs + per-target activation status |
| `add_mcp_server` | `spec` (structured McpServerSpec; `source.kind` defaults `"manual"`) | validate + persist to library; reject duplicate id |
| `activate_mcp_server` | `id, harness, scope, variantLabel?, projectPath?` | resolveEffective → `writeEntry`; returns path + trustNote |
| `deactivate_mcp_server` | `id, harness, scope, projectPath?` | `removeEntry` |
| `remove_mcp_server` | `id, projectPath?` | remove from library; return targets where still active (warning) |

The agent constructs the `spec` for `add_mcp_server` from whatever it read
(README/URL/prose) — no server-side parsing. `activate`/`deactivate` require an
active project for `scope == project` (reuse the skill tools' project plumbing).
Unsupported harness / unknown scope / invalid spec ⇒ tool error with a clear
message; Codex is fully supported (TOML).

## 6. Lockstep with Rust

`adapters.rs` ↔ the JS adapter table are two sources of truth. To catch drift:
- A Node test (`test/mcp-core.test.js`) asserts the JS table's 7 entries and
  their key facts (paths, keyPath, commandStyle, envField, discriminator,
  remoteUrlField, projectTrustNote) equal a checked-in expected snapshot that
  mirrors the Rust table; when `adapters.rs` changes, this test and its snapshot
  must be updated in the same PR (documented in both files' headers, matching the
  existing `targets.rs` ↔ `core.js` convention).
- Engine round-trip tests mirror the Rust ones (write stdio+remote per adapter,
  read back, assert dialect; idempotent re-write; siblings preserved; remove).

## 7. Testing

- **Part 1:** SDK stdio smoke (tools listed with schemas; one tool invoked e2e
  against a temp vault); the existing skill-tool behaviors still pass.
- **Part 2 (`node --test`, temp dirs):** `validateSpec` (good/bad ids, transport
  field rules, variants); `resolveEffective` (label > appliesTo > canonical);
  per-adapter render round-trip (incl. opencode argv/environment/enabled, codex
  TOML subtable env, gemini httpUrl/url split, copilot tools); write/read/remove
  preserves siblings + unknown keys; malformed config errors without clobber;
  the adapter-parity snapshot test; each tool's happy path + validation errors.
- No network in tests; TOML exercised via `smol-toml` against fixtures.

## 8. Open questions / carried forward

- SDK CJS/ESM interop specifics (dynamic import vs `.mjs` entry) — resolved in
  the plan against current `@modelcontextprotocol/sdk` docs.
- Whether to later add `reconcile`/discovery tools (Phase C parity) on the Node
  side — deferred.
- A thin SSRF-guarded `fetch_markdown` helper (fetch only, no parsing) could aid
  agents without web access — deferred; add only if a real need appears.
- Comment-preserving Codex TOML in JS — no equivalent to `toml_edit`; revisit if
  reflow bothers users.

## 9. Known limitations / follow-ups

- **Cross-process file locking is not implemented.** The Tauri desktop app
  (Rust) and this Node MCP server both read-modify-write the same shared
  files on disk (`<appHome>/mcp/servers.json`, and any given harness's
  config, e.g. `.claude.json` / `.codex/config.toml`) with no cross-process
  lock — only within-process guards (e.g. `MCP_LIBRARY_LOCK` on the Rust
  side). If the desktop app and an agent-driven Node tool call edit the same
  file at roughly the same time, one writer's change can be silently lost
  (last writer wins, not merged). Accepted as a documented limitation for
  v1; revisit if concurrent-edit reports come in.
