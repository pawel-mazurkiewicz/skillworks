# MCP Server Management — Phase A: Library + Adapter Engine

**Status:** Design approved (brainstorm), ready for implementation plan
**Date:** 2026-07-20
**Scope:** Phase A of a multi-phase feature. This spec covers the canonical
server library, the table-driven per-harness config engine, and
activate/deactivate/status/discover-read commands. Phases B–E (URL parser,
discovery UI, frontend, Node MCP-server tools) get their own specs.

---

## 1. Motivation

Skillworks manages **skills** by symlinking canonical vault entries into
per-harness directories across 13 harnesses × {global, project}. It should
manage **MCP servers** the same way: a curated library the user activates into
any harness + scope.

The difference — and the reason this is "more involved" — is that an MCP server
is not a symlinked directory but an **entry edited into a structured config
file**, and every harness uses a different file, format, key path, and entry
schema. Today `backend/mcp_register.rs` hand-rolls this for exactly 3 harnesses
and only for Skillworks' own server under a fixed key.

Phase A generalizes that into a **table-driven engine** so activation works for
an arbitrary user-curated library across the v1 harness set, with the existing
self-registration becoming one more caller of the same engine.

## 2. Goals / Non-goals

**Goals (Phase A):**
- Canonical, harness-agnostic `McpServerSpec` library persisted on disk.
- A per-harness **adapter descriptor** table for the v1 set (7 harnesses).
- One generic **engine** that reads/merges/writes JSON and TOML configs,
  translating a canonical spec into each harness's dialect, touching only our
  entry, preserving unknown keys (and comments where the format allows),
  backing up + writing atomically.
- Tauri commands: `mcp_list_library`, `mcp_add_manual`, `mcp_remove`,
  `mcp_activate`, `mcp_deactivate`, `mcp_status`, `mcp_discover` (read-only).
- Refactor `mcp_register.rs` to sit on the engine (no behavior change).
- Unit tests per adapter (round-trip, preserve-others, idempotent, remove).

**Non-goals (deferred to later phases):**
- URL/README heuristic parsing (Phase B).
- Discovery *reconciliation UI* and "import unmanaged" (Phase C; Phase A ships
  only the read-side `mcp_discover`).
- Frontend surface (Phase D).
- Node MCP-server agent tools mirror in `core.js` (Phase E).
- Harnesses beyond the v1 seven (Antigravity, CodeBuddy, OpenClaw, Trae, Qoder).
- Local micro-model parsing (explicitly rejected; possible future enhancement).
- Managing out-of-band enable/disable state (Gemini enablement file, Cursor UI
  toggle, Claude `disabledMcpjsonServers`). We manage **presence** only.

## 3. Data model

### 3.1 Library file

Stored at `<appHome>/mcp/servers.json` (dedicated file, not folded into
`config.json`, to keep config lean and mirror the vault/config separation).
Shape: `{ "servers": [ McpServerSpec, ... ] }`.

### 3.2 `McpServerSpec` (canonical, harness-agnostic)

```
McpServerSpec {
  id: String,                 // slug, stable, used as the config entry key
  name: String,               // display name
  description: Option<String>,
  source: { kind: "url" | "manual" | "discovered", url: Option<String> },
  transport: "stdio" | "http" | "sse",   // recommended / quick-start default
  // stdio fields:
  command: Option<String>,
  args: Vec<String>,
  env: BTreeMap<String, String>,
  // remote fields:
  url: Option<String>,
  headers: BTreeMap<String, String>,
  // optional alternate invocations:
  variants: Vec<McpVariant>,
}

McpVariant {
  label: String,
  applies_to: Option<{ harness: Option<String>, scope: Option<"global"|"project"> }>,
  // any of the same invocation fields, overriding the canonical spec:
  transport, command, args, env, url, headers  (all optional)
}
```

**Variant selection at activation:** explicit `variant_label` argument wins;
else the best `applies_to` match for the (harness, scope) target; else the
canonical top-level fields. The selected effective spec is what the engine
translates.

**Validation invariants:**
- `id` matches `^[a-z0-9][a-z0-9-]*$` (reused from skills' `safe_segment` style).
- `transport == "stdio"` ⇒ `command` present; `http|sse` ⇒ `url` present.
- Unknown `transport` rejected.

## 4. Harness adapter descriptors (v1 = 7)

A static table `MCP_ADAPTERS` (mirrors `targets.rs`'s `HARNESS_TARGETS`). Each:

```
McpAdapter {
  harness_id: &str,           // "claude","codex","cursor","opencode","gemini","copilot","kiro"
  format: Json | Toml,
  global_path: &[&str],       // relative to home dir
  project_path: &[&str],      // relative to repo root
  key_path: KeyPath,          // where entries live in the doc
  stdio_command_style: SeparateArgs | ArgvArray,
  env_field: Env | Environment | TomlSubtable,
  transport: ExplicitType { stdio, http, sse } | ImplicitByKey,
  remote_url_field: Url | HttpUrlForHttp | ServerUrl,   // Gemini splits http/sse
  project_trust_note: bool,   // Claude/Codex project scope needs in-tool approval
}
```

Concrete values from research (2026-07-20):

| harness | fmt | global | project | key_path | cmd style | env field | discriminator | remote url |
|---|---|---|---|---|---|---|---|---|
| claude | JSON | `~/.claude.json` | `.mcp.json` | `mcpServers` | separate | `env` | explicit (`stdio`/`http`/`sse`); omit for stdio ok | `url` |
| codex | TOML | `~/.codex/config.toml` | `.codex/config.toml` | `[mcp_servers.<id>]` | separate | subtable | implicit | `url` |
| cursor | JSON | `~/.cursor/mcp.json` | `.cursor/mcp.json` | `mcpServers` | separate | `env` | implicit | `url` |
| opencode | JSON | `~/.config/opencode/opencode.json` | `opencode.json` | `mcp` | **argv array** | `environment` | explicit (`local`/`remote`) | `url` |
| gemini | JSON | `~/.gemini/settings.json` | `.gemini/settings.json` | `mcpServers` | separate | `env` | implicit | `url` (sse) / `httpUrl` (http) |
| copilot | JSON | `~/.copilot/mcp-config.json` | `.mcp.json` | `mcpServers` | separate | `env` | explicit (`local`/`http`) | `url` |
| kiro | JSON | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` | `mcpServers` | separate | `env` | implicit | `url` |

Notes encoded as adapter flags:
- **OpenCode** is the outlier: `mcp` key, `command` as a single argv array
  (`[command, ...args]`), `environment` not `env`, required `type: local|remote`.
- **Gemini** remote splits by transport: `httpUrl` for streamable-http, `url`
  for sse.
- **Claude** may omit `type` for stdio; we write `type` explicitly for remote,
  and for stdio we write `type: "stdio"` (valid and unambiguous).
- **Codex** env is a nested TOML subtable `[mcp_servers.<id>.env]`.
- Claude/Codex **project** scope requires first-run trust approval in the tool;
  `mcp_status` surfaces this as a note, we do not attempt to set trust.

## 5. The engine

`backend/mcp/engine.rs` exposes, for a given `McpAdapter`, effective spec, and
target file path:

- `read_entries(path, adapter) -> Map<id, Value>` — presence read for status/discover.
- `write_entry(path, adapter, id, effective_spec)` — insert/replace only `id`.
- `remove_entry(path, adapter, id)` — remove only `id`.

Shared mechanics (reuse existing helpers):
- **JSON:** `serde_json` object model; navigate/create `key_path`; preserves
  unknown keys. (JSONC comment preservation for OpenCode is a known limitation —
  documented caveat for Phase A; standard JSON is emitted.)
- **TOML:** `toml_edit::DocumentMut` (already used) — preserves comments and
  other tables; write a fresh canonical subtable to avoid dotted-key dupes
  (pattern already proven in `mcp_register.rs::register_codex`).
- **Backup + atomic:** reuse `backup_existing` + `fs_atomic::{write_json_atomic,
  write_bytes_atomic}`. Every mutation backs up the prior file first.
- **Missing file/dirs:** treat as empty doc; create parent dirs on write.
- **Malformed existing config:** return a `Validation` error; never clobber.

**Canonical → dialect translation** is a pure function
`render_entry(adapter, effective_spec) -> Value/Table` that applies the adapter
flags (command style, env field, discriminator, remote url field). This is the
single place harness quirks live and the primary unit-test surface.

## 6. Commands (Tauri, in `commands.rs`)

- `mcp_list_library() -> Vec<McpServerSpec>`
- `mcp_add_manual(spec) -> McpServerSpec` — validate + persist to library.
- `mcp_remove(id) -> ()` — remove from library (does NOT deactivate; returns a
  warning list of targets where it is still active).
- `mcp_activate(id, harness, scope, variant_label?) -> ActivationResult` —
  resolve effective spec, engine `write_entry`, return path + trust note.
- `mcp_deactivate(id, harness, scope) -> ()` — engine `remove_entry`.
- `mcp_status(id?) -> Vec<McpTargetStatus>` — for each library server × v1
  target: `{ harness, scope, config_path, active, trust_note }`, read live.
- `mcp_discover() -> Vec<DiscoveredEntry>` — read all v1 targets, list entries
  not matched to a library id (unmanaged). Read-only in Phase A.

`activate`/`deactivate` require an active project for `scope == project`
(reuse the existing project-selection plumbing used by skills).

## 7. Error handling

- Unsupported harness / unknown scope → `Validation` error.
- Malformed target config → `Validation` error, no write.
- `scope == project` with no active project → `Validation` error.
- Invalid spec (missing command/url for transport) → `Validation` error at
  `add_manual`/`activate`.
- All writes: backup-then-atomic; partial multi-target activation reports
  per-target success/failure (mirrors `applySet` semantics in `sets.rs`).

## 8. `mcp_register.rs` refactor

Re-express the 3 existing writers (claude/codex/opencode) as engine calls with
a fixed `skillworks` id and the same invocation. Keep the public surface
(`register`, `unregister`, `status`, `invocation_for`) so the desktop
launch/register flow is unchanged. Existing tests must still pass; add
equivalence coverage. This proves the engine against known-good behavior.

## 9. Testing

- **Per-adapter round-trip:** write stdio + remote entry, read back, assert
  exact dialect (key path, field names, command style, discriminator, url
  field); re-write is idempotent; other servers + unknown top-level keys
  preserved; remove leaves siblings intact. (Extends the existing
  `mcp_register.rs` test style: tempdir + tokio.)
- **TOML comment preservation** for Codex (already-proven assertion pattern).
- **Variant selection:** explicit label > applies_to match > canonical.
- **Validation:** bad id/transport/missing-field rejected.
- **Engine equivalence:** refactored `mcp_register` output byte-compatible with
  pre-refactor fixtures.

## 10. Open questions carried to later phases

- JSONC comment preservation (OpenCode) — acceptable to drop in A; revisit if
  users complain (B/C).
- Copilot project path: `.mcp.json` chosen over `.github/mcp.json` for v1;
  revisit if needed.
- Discovery reconciliation heuristics beyond name-match (C).
- JSONC reads (OpenCode): a commented opencode.json fails parsing; Phase A
  surfaces this as a per-target status error (activation refuses to touch the
  file — clobber protection). A dependency-free lenient reader is a Phase B/C
  candidate.
