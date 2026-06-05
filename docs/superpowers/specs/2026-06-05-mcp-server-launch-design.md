# MCP Server Launch + Project/Skill Tools — Design

Date: 2026-06-05
Status: Approved (clarifications answered during brainstorming)

## Goal

Add to the Skillworks desktop app an option to "launch" (register) the bundled
MCP server with known coding harnesses, and extend the MCP server so an agent can
manage projects and skills during a session:

1. Desktop option to configure the MCP server automatically for Claude Code,
   Codex, and OpenCode, plus a copyable snippet for any other harness.
2. MCP tools: `add_project`, `activate_project` (session-scoped active project),
   `search_skills`, `add_skills_to_project`, `remove_skills_from_project`.

## Background / Current State

- The desktop app is a Tauri 2 shell with a native Rust backend
  (`src-tauri/src/backend/`) and a React + plain-CSS frontend (`public/app.js`).
- The MCP server is a Node stdio server (`src/mcp-server.js`) that uses the shared
  `src/core.js` manager and reads/writes the same on-disk config
  (`~/.agent-skill-manager/` or `SKILLWORKS_HOME`) as the desktop app. It runs as
  an independent process spawned by the agent harness.
- `core.js` `createManager()` already exposes the needed primitives:
  `addProject`, `getState(projectPath)` (returns vault skills + per-target link
  state), `toggleSkill` (link/unlink a skill into a target), `listSets`,
  `applySet`, etc.
- "Targets" model per-harness skill directories (e.g. `claude-project` →
  `<project>/.claude/skills`, `codex-project` → `<project>/.codex/skills`). These
  are the link destinations for project skills.
- The MCP server currently exposes only `list_skill_sets` and
  `activate_skill_set`.

## Key Decisions (from clarification)

1. **"Launch" = register only.** The app writes the MCP server entry into each
   harness's config; harnesses manage spawning and communication. No live
   test-spawn, no persistent daemon, no new transport. stdio stays.
2. **Server command is bundled, not published.** `src/mcp-server.js`, `core.js`,
   and `sets.js` ship as Tauri bundled resources. Registration writes
   `command: "node", args: ["<resources>/mcp/mcp-server.js", "--harness", "<id>",
   "--project-from-cwd"]`. Only runtime requirement: Node on PATH (detected; warn
   if missing). No npm publish required.
3. **Skill destination defaults to the calling harness.** Registration injects
   `--harness <id>` so the running server knows its own identity. `add/remove`
   tools link into the active project's dir for that harness by default, with an
   optional `harness` argument to act on a different harness when the user wants.

## Architecture

### A. Bundled server resources

- `tauri.conf.json` → `bundle.resources` maps the three JS files into an `mcp/`
  folder inside the app bundle resources.
- At runtime the Rust backend resolves the absolute path via Tauri's resource
  path API (`app.path().resolve("mcp/mcp-server.js", BaseDirectory::Resource)`).
- In dev (no bundle), fall back to the repo path (`<cwd>/src/mcp-server.js`) so
  `desktop:dev` works.

### B. Harness MCP config writers (`src-tauri/src/backend/mcp_register.rs`)

A new module with one writer per auto-harness. Each is idempotent: it merges the
`skillworks` entry into the existing config without disturbing other servers, and
unregister removes only that entry.

| Harness | File | Key | Format |
|---|---|---|---|
| Claude Code | `~/.claude.json` | top-level `mcpServers.skillworks` | JSON, `{type:"stdio", command, args, env}` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.skillworks]` | TOML via `toml_edit` (preserves comments) `command`, `args` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.skillworks` | JSON, `{type:"local", command:[node, ...], enabled:true}` |

Writes are atomic (reuse `fs_atomic`/temp-then-rename where applicable). Missing
parent dirs are created. A missing config file is created with just our entry.
Before modifying an existing config, the original is copied to a timestamped
sibling (`<name>.skillworks-backup-<UTC timestamp>`) so the user can recover
their previous harness config; fresh files (nothing to overwrite) skip backup.

Other harnesses: `mcp_manual_snippet()` returns a generic
`{command, args, env}` object plus a ready-to-paste JSON snippet.

Crate addition: `toml_edit` (for comment-preserving Codex edits).

### C. Tauri commands (`commands.rs`, registered in `lib.rs`)

- `mcp_registration_status() -> Vec<HarnessMcpStatus>` — for each auto-harness:
  `{ harness_id, label, config_path, registered: bool, node_present: bool,
  server_path }`.
- `register_mcp_server(harness_ids: Vec<String>) -> ...` — register the named
  harnesses; returns updated status.
- `unregister_mcp_server(harness_ids: Vec<String>) -> ...` — remove entries.
- `mcp_manual_snippet() -> { command, args, env, snippet }`.

### D. MCP server tools (`src/mcp-server.js`)

- Parse `--harness <id>`; store as `selfHarness`. Maintain an in-memory
  `activeProject` (initialized from existing project resolution) that
  `activate_project` mutates — session-scoped, per process.
- New tools (all return `toolResult` JSON), each resolving project from
  `args.projectPath ?? activeProject`:
  - `add_project(path, name?)` → `manager.addProject` (persists to config).
  - `activate_project(path)` → sets `activeProject`; returns project state.
  - `search_skills(query, limit?)` → filter `getState().skills` by
    name/description/tags; return matches.
  - `add_skills_to_project(skills[], harness?)` → for each skill,
    `manager.toggleSkill` to link into the `<harness|selfHarness>-project` target.
  - `remove_skills_from_project(skills[], harness?)` → same, unlink.
- Existing `list_skill_sets` / `activate_skill_set` keep working and also default
  to `activeProject`.

### E. Frontend (`public/app.js`)

New "MCP Server" section, styled with existing design tokens / panel rhythm:
- Three auto-harness rows (Claude Code, Codex, OpenCode): label, config path,
  status pill (Registered / Not registered), register/unregister button.
- "Other harnesses" block with the copyable command snippet.
- Node-missing warning banner when `node_present` is false.

## Data Flow

1. User opens MCP Server panel → `mcp_registration_status()` populates rows.
2. User clicks Register on a harness → `register_mcp_server([id])` writes config →
   status refreshes.
3. Harness later spawns `node .../mcp-server.js --harness <id> --project-from-cwd`.
4. Agent calls `add_project` / `activate_project` / `search_skills` /
   `add_skills_to_project` / `remove_skills_from_project`; server mutates the
   shared vault/config via `core.js`, defaulting skill links to `--harness`.

## Error Handling

- Config writers: surface clear errors on unreadable/malformed existing config
  (do not silently overwrite). Atomic writes prevent partial files.
- `node_present` false → register still allowed but UI warns it won't launch.
- MCP tools validate required args and return JSON-RPC errors via existing
  `sendError` path.

## Testing

- Rust unit tests (temp dirs) per writer: fresh file, existing file with other
  servers preserved, idempotent re-register, unregister removes only our entry,
  malformed input handling.
- Node `--test` for new tools: active-project state transitions, add/remove with
  default vs explicit harness, search matching.
- `npm test`, `npm run build`, and `cargo test` (in `src-tauri`) before commit.

## Out of Scope (YAGNI)

- Live test-spawn / health check of the server.
- Persistent background daemon or HTTP/SSE transport.
- Bundling the Node runtime itself.
- Per-project (`.mcp.json`) registration — user-scope only for now.
