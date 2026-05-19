# Rust Backend Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the Node.js sidecar entirely. Port the backend (`src/core.js` + `src/sets.js` + `src/server.js`) to native Rust as Tauri commands invoked over IPC. No more pkg compilation, no more port 5179, no more codesign-corruption fights, no more sidecar lifecycle bugs.

**Architecture:** Replace the HTTP server with `#[tauri::command]` functions in the Tauri Rust binary. The frontend continues to call `api("/api/...")`, but `api()` becomes a thin shim that translates each route to a Tauri `invoke()` call. The MCP server (`src/mcp-server.js`) and the standalone CLI (`npm start`) keep using the Node implementation — they are NOT distributed with the desktop app and don't need porting in lockstep.

**Tech stack:** Rust 2021, Tauri 2.x, `tokio` (already pulled in by Tauri), `serde`/`serde_json` (already pulled in), plus new crates listed in §Dependencies below. The pkg sidecar is deleted from the desktop bundle. The `dist/` frontend is unchanged except for the `api()` shim.

---

## Why this is worth it

The sidecar architecture has caused, in this order:
1. `Unknown API route` — stale binary that was rebuilt but didn't include the marketplace route.
2. `fetch failed` — pkg can't bundle Node 20's native `undici`/`fetch`.
3. Sidecar surviving app close — Tauri calls `process::exit()`, skipping Rust destructors.
4. `Load failed` on every page — pkg-compiled V8 needs `com.apple.security.cs.allow-jit`, Tauri doesn't apply bundle entitlements to external binaries.
5. `pkg/prelude/bootstrap.js: SyntaxError` — `@yao-pkg/pkg` produces ad-hoc-signed binaries; any subsequent `codesign --force` rewrites LINKEDIT and shifts pkg's appended-data offsets.

Each fix added more workaround surface area. The pkg sidecar is fundamentally a poor fit for the macOS hardened runtime + notarization world. Native Rust commands sidestep every one of the above bugs and shrink the bundle by ~95 MB.

---

## File Structure

**Create:**
- `src-tauri/src/lib.rs` — split `main.rs` into a binary that delegates to a library crate (lets us share code with future MCP rewrite + makes testing possible).
- `src-tauri/src/backend/mod.rs` — root of the backend port.
- `src-tauri/src/backend/state.rs` — `AppState` (config dir, vault root, in-memory cache), `Manager` struct.
- `src-tauri/src/backend/config.rs` — read/write `~/.agent-skill-manager/config.json` with atomic writes.
- `src-tauri/src/backend/types.rs` — all the DTOs that go over IPC (`SkillRecord`, `TargetRecord`, `ProjectRecord`, `State`, etc.). All `#[derive(Serialize, Deserialize)]`.
- `src-tauri/src/backend/skills.rs` — `discoverSkills`, `parseFrontmatter`, `readSkillMetadata`, `findSkillRoots`, manifest read/write.
- `src-tauri/src/backend/targets.rs` — `buildTargets`, `inspectTarget`, `listTargetEntries`, harness target definitions.
- `src-tauri/src/backend/projects.rs` — project records, scan, normalize, pinned sets, project record persistence.
- `src-tauri/src/backend/imports.rs` — `findImportCandidates`, `importSkills`, `importPaths` (move-into-vault flow).
- `src-tauri/src/backend/git_install.rs` — clone-to-temp, parse repo skills, `previewGitInstall`, `installFromGit`.
- `src-tauri/src/backend/sets.rs` — port of `src/sets.js` (set CRUD, plan/apply/snapshot).
- `src-tauri/src/backend/marketplace.rs` — `fetchMarketplaceSkills` (skills.sh API + HTML scrape fallback).
- `src-tauri/src/backend/commands.rs` — the `#[tauri::command]` layer; one function per current HTTP route.
- `src-tauri/src/backend/fs_atomic.rs` — `write_json_atomic` helper (mirrors `writeJson` in `core.js`).
- `src-tauri/src/backend/symlinks.rs` — symlink helpers (`is_symlink_to`, `unlink_if_symlink`, `remove_known_symlinks_to`).
- `public/api-shim.js` — replaces `api()` in `public/app.js`. When running in Tauri, calls `invoke()`; when running in browser (dev / CLI server), falls back to `fetch()`.
- `docs/superpowers/specs/2026-05-19-rust-backend-design.md` — companion design doc with the exact command surface (created as the first task; see Phase 0).

**Modify:**
- `src-tauri/src/main.rs` — register all backend commands via `.invoke_handler(tauri::generate_handler![...])`. Delete `start_server_sidecar` and the `DesktopServer` state.
- `src-tauri/Cargo.toml` — add new dependencies (see §Dependencies).
- `src-tauri/tauri.conf.json` — remove `bundle.externalBin`, remove `bundle.macOS.entitlements`, remove `connect-src http://127.0.0.1:5179` from CSP, remove `Entitlements.plist` reference.
- `src-tauri/capabilities/default.json` — remove the `shell:allow-execute` permission for the sidecar.
- `package.json` — remove `desktop:sidecar` script and `desktop:sign` script; remove `@yao-pkg/pkg` from `devDependencies`; remove the `pkg` config block; remove `binaries/skillworks-server` from `externalBin` references.
- `scripts/release/release-macos.sh` — drop steps 1-3 (sidecar build + lipo) and the manual sidecar resign step (5). Let Tauri build+sign+notarize the bundle normally with `bundle.macOS.entitlements` removed. Whole script collapses to ~30 lines.
- `scripts/release/release-linux.sh`, `scripts/release/release-windows.ps1` — drop sidecar steps.
- `scripts/vite-dev.js` — drop the `node src/server.js` spawn; only run Vite. Frontend in dev mode talks to Tauri commands via `invoke()`; if running browser-only (no Tauri), use a long-running `node src/server.js` started manually (`npm start`).
- `public/app.js` — replace direct `fetch()`-via-`apiUrl()` calls with the new `api-shim.js` (mostly mechanical).

**Delete (Phase 9):**
- `src-tauri/binaries/` directory and its `.gitkeep`.
- `src-tauri/Entitlements.plist`.
- `scripts/build-tauri-sidecar.js`, `scripts/rename-tauri-sidecar.js`, `scripts/sign-sidecar.sh`.

**Leave alone (for now):**
- `src/core.js`, `src/sets.js`, `src/server.js`, `src/mcp-server.js`, `test/core.test.js` — still used by `npm start` (browser-only CLI mode) and `npm run mcp` (MCP server). Mark them in their headers as legacy/Node-only. Decision on long-term fate deferred to a follow-up plan (probably: keep `mcp-server.js`, delete the rest once Rust port is stable).

**Conventions to follow:**
- Every Tauri command name uses `snake_case` and starts with a verb: `get_state`, `read_skill`, `save_skill`, `toggle_skill`, `bulk_copy_skills`, etc. The shim maps `POST /api/bulk-copy` → `invoke("bulk_copy_skills", { ... })`.
- DTOs use `#[serde(rename_all = "camelCase")]` so the JS side keeps the existing field names (no frontend renames needed).
- All file I/O goes through `fs_atomic::write_json_atomic` for writes; reads use `tokio::fs`.
- All errors returned to JS use `Result<T, BackendError>` where `BackendError` is `#[derive(Debug, thiserror::Error, serde::Serialize)]` with an `error: String` field, so the frontend's existing `if (!response.ok) { showToast(payload.error) }` pattern keeps working after the shim translates exceptions.
- Path inputs from JS arrive as `String`, normalized server-side via the same rules as `normalizePath` in `core.js`.
- No symlink follow when computing canonical IDs (matches current behavior).

---

## Dependencies (additions to `src-tauri/Cargo.toml`)

```toml
[dependencies]
# already present: serde, serde_json, tauri, tauri-plugin-shell (KEEP — used for "open in finder"), tauri-plugin-updater
tokio = { version = "1", features = ["fs", "process", "rt-multi-thread", "macros"] }
thiserror = "2"
anyhow = "1"
serde_yaml = "0.9"        # frontmatter parsing
walkdir = "2"             # directory traversal
glob = "0.3"              # glob patterns for source scanning
dirs = "5"                # user home / config dir resolution
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls", "gzip"] }
scraper = "0.20"          # HTML fallback parsing for skills.sh
url = "2"
hex = "0.4"               # short-hash IDs
sha2 = "0.10"             # for the same
git2 = { version = "0.19", default-features = false, features = ["vendored-libgit2"] }  # vendored avoids libgit2 system dep
tempfile = "3"            # ephemeral clone dirs
regex = "1"
once_cell = "1"
```

`git2` with `vendored-libgit2` adds ~3 MB to the binary but means no system dependency. If this size matters more than reproducibility, swap for `gix` later. For Phase 5 it's the easier path.

---

## Decisions to validate before Phase 1

1. **Single binary or feature flag for MCP?** Recommendation: leave the MCP server as JS for now. The MCP user base is one person and shipping `npm run mcp` is fine. Revisit after Rust port lands.
2. **Custom protocol or pure IPC?** Recommendation: pure IPC (`invoke()`). No custom URL scheme. The frontend doesn't need URLs — it needs RPC. Custom protocols add complexity without benefit here.
3. **Async runtime?** Tauri 2 includes `tokio` already. Use it.
4. **Streaming for long ops (`scan_projects`, `install_from_git`)?** Recommendation: use Tauri events (`app.emit("scan_progress", payload)`) for progress, with a single Promise return for completion. Matches the current "fire-and-await-result" pattern in `app.js`.
5. **Where does `~/.agent-skill-manager/` live in tests?** Recommendation: a `BackendConfig { app_home: PathBuf }` injected at startup. Tests construct managers with temp dirs.

---

## Phasing

Each phase ends with the desktop app still launchable and as many tabs working as that phase covers. The phase boundaries match what's testable in isolation.

### Phase 0 — Design lock-in (no code)

- [ ] **Task 0.1** — Write `docs/superpowers/specs/2026-05-19-rust-backend-design.md`. Contents:
  - Full inventory of the 31 current HTTP routes with their request/response JSON shapes (cribbed from `handleApi` + `core.js` return values).
  - Mapping table: HTTP route → Tauri command name → DTO names.
  - The complete `BackendError` taxonomy (variants for `NotFound`, `Conflict`, `Io`, `Validation`, etc.).
  - The decision log for the five questions in §Decisions above.
- [ ] **Task 0.2** — Verify the design doc against `public/app.js` by grepping for every `api(` call and confirming each is in the mapping table. Update the doc if any route is missing.

### Phase 1 — Skeleton + first command (`get_state` minus the hard parts)

- [ ] **Task 1.1** — Split `main.rs` into `main.rs` (just bootstraps) + `lib.rs` (the rest). Verify the desktop app still builds and runs (with the existing JS sidecar still in place).
- [ ] **Task 1.2** — Add new crate dependencies (Cargo.toml). Resolve compilation; `cargo check` passes.
- [ ] **Task 1.3** — Create `backend/mod.rs`, `backend/types.rs`, `backend/state.rs`, `backend/fs_atomic.rs`, `backend/config.rs`. Implement:
  - `BackendError` + `BackendResult<T>`.
  - `Config` struct (mirrors what `core.js` reads/writes).
  - `Manager { config: Config, app_home: PathBuf }` with `Manager::new(app_home)`.
  - `write_json_atomic` (write to temp file in same dir, fsync, rename).
- [ ] **Task 1.4** — Implement the simplest possible `get_state` command — returns a stubbed `State` struct (vault root, config path, app home, empty arrays for everything else). Register it. From the JS console, run `await window.__TAURI__.core.invoke('get_state')` and confirm it returns. **Do not wire it into the frontend yet** — we'll do that in Phase 8.
- [ ] **Task 1.5** — Write Rust unit tests for `Config` round-trip (write then read).

### Phase 2 — Skill discovery, target inspection, full `get_state`

- [ ] **Task 2.1** — Port `parseFrontmatter` and `readSkillMetadata` to `backend/skills.rs`. Add tests using sample fixture files (port `test/core.test.js` fixtures to `src-tauri/tests/fixtures/`).
- [ ] **Task 2.2** — Port `findSkillRoots`, `discoverSkills`, `readManifest`, `writeManifest`. Add tests.
- [ ] **Task 2.3** — Port the `HARNESS_TARGETS` table + `buildTargets` to `backend/targets.rs`. The harness table is data, not logic — translate it directly. Add tests for `buildTargets` output shape.
- [ ] **Task 2.4** — Port `inspectTarget` and `listTargetEntries` (the symlink walking). Add tests covering: skill present as file, skill present as symlink to vault, target dir missing, target dir has unrelated files.
- [ ] **Task 2.5** — Port `normalizeProjectRecords` and `buildProjectRecord` to `backend/projects.rs`.
- [ ] **Task 2.6** — Wire `get_state` to compose real output from the above. Compare its JSON output byte-for-byte against the JS server's `/api/state` for a real vault. Diff must be empty (modulo key ordering).

### Phase 3 — Skill read/write + toggle

- [ ] **Task 3.1** — Commands: `read_skill_file`, `save_skill_file`. Mirror `readSkillFile`/`saveSkillFile` in `core.js`. Tests for both.
- [ ] **Task 3.2** — Commands: `toggle_skill`. Implement `enable_skill` and `disable_skill` private helpers (these do the symlink dance + manifest update). Tests with isolated temp vaults.
- [ ] **Task 3.3** — Commands: `bulk_toggle_skills`, `bulk_copy_skills`, `bulk_move_skills`, `bulk_delete_skills`. Tests.
- [ ] **Task 3.4** — Commands: `find_vault_duplicates`, `dedupe_vault_skills`. Tests.

### Phase 4 — Projects + config

- [ ] **Task 4.1** — Commands: `write_config`, `add_project`, `remove_project`, `clear_scanned_projects`, `scan_projects`. The scan is the biggest single piece — port `scanProjectRoots`, `walkForProjects`, `findProjectSkillSources`, `discoverSources`.
- [ ] **Task 4.2** — Tauri event emission for `scan_projects` progress (optional, can defer to Phase 8 polish).
- [ ] **Task 4.3** — Command: `pick_directory` — uses `tauri_plugin_dialog` (add to Cargo.toml + capabilities). Replaces the macOS `osascript` hack in `pickDirectory()`.

### Phase 5 — Imports + git installs

- [ ] **Task 5.1** — Commands: `import_skills`, `import_paths`. Port `findImportCandidates`, `moveDirectory`, `uniqueSkillDestination`, `inferAuthor`, `inferTags`.
- [ ] **Task 5.2** — Commands: `preview_git_install`, `install_from_git`. Use `git2` to clone to `tempfile::TempDir`, then run the existing import logic. Test against a small public repo (cache the response, don't hit the network in CI).

### Phase 6 — Sets

- [ ] **Task 6.1** — Port `src/sets.js` to `backend/sets.rs`. Add `normalizeSet`, `normalizeEntries`, `newSetId`, `readProjectSets`, `writeProjectSets`, `listGlobalSets`.
- [ ] **Task 6.2** — Commands: `list_sets`, `create_set`, `update_set`, `delete_set`, `snapshot_set`, `plan_apply_set`, `apply_set`, `set_project_pinned_sets`. Tests.

### Phase 7 — Marketplace

- [ ] **Task 7.1** — `backend/marketplace.rs`: port `fetchMarketplaceSkills`, `fetchSkillsJson`, `fetchSkillsPage`, `scrapeMarketplaceSkills`, `extractSkillLinks`, `humanizeSkillSlug`. Uses `reqwest` for HTTP, `scraper` for HTML fallback. No more `node:https` dance.
- [ ] **Task 7.2** — Command: `fetch_marketplace_skills`. Test with a recorded response (mock the HTTP layer with a trait, or just hit the real API in an `#[ignore]` test).

### Phase 8 — Frontend migration

- [ ] **Task 8.1** — Create `public/api-shim.js`. Export `api(path, options)` with the same signature as the current one. Internally:
  ```js
  const ROUTE_MAP = {
    "GET /api/state": ["get_state", (url) => ({ project: url.searchParams.get("project") })],
    "POST /api/toggle": ["toggle_skill", (url, body) => body],
    // ... one entry per route
  };
  ```
  When `isTauriDesktop()`, invoke the mapped command; otherwise fall back to `fetch`.
- [ ] **Task 8.2** — Replace the existing `api()` and `apiUrl()` in `public/app.js` with imports from the shim. Verify every API call in `app.js` still works against the Rust commands by clicking through every tab.
- [ ] **Task 8.3** — Update the CSP in `tauri.conf.json` — remove `http://127.0.0.1:5179` from `connect-src` (no longer needed). Confirm marketplace fetches still work (they originate from Rust now, not the WebView).

### Phase 9 — Sidecar removal

- [ ] **Task 9.1** — Delete `start_server_sidecar`, `DesktopServer` struct, `RunEvent::Exit` handler from `main.rs`. The `Drop` impl goes away too.
- [ ] **Task 9.2** — Delete `src-tauri/binaries/`, `src-tauri/Entitlements.plist`, `scripts/build-tauri-sidecar.js`, `scripts/rename-tauri-sidecar.js`, `scripts/sign-sidecar.sh`.
- [ ] **Task 9.3** — Update `package.json`: remove `desktop:sidecar`, `desktop:sign`, `@yao-pkg/pkg` from `devDependencies`, the `pkg` config block.
- [ ] **Task 9.4** — Update `tauri.conf.json`: remove `bundle.externalBin`, `bundle.macOS.entitlements`. CSP already done in 8.3.
- [ ] **Task 9.5** — Update `capabilities/default.json`: remove `shell:allow-execute` for the sidecar.
- [ ] **Task 9.6** — Strip the sidecar steps from `release-macos.sh`, `release-linux.sh`, `release-windows.ps1`. With Tauri signing the only Rust binary (which has no special JIT needs), the release script collapses to: build, sign-and-notarize (Tauri does it), upload.
- [ ] **Task 9.7** — Strip `node src/server.js` from `scripts/vite-dev.js`. `npm run dev` now starts only Vite; Tauri dev (`npm run desktop:dev`) handles the backend via invoke.

### Phase 10 — Cleanup + parity verification

- [ ] **Task 10.1** — Add a header comment to `src/core.js`, `src/server.js`, `src/sets.js` explaining they're now legacy (used only for `npm start` browser mode + MCP). Decision on deletion deferred.
- [ ] **Task 10.2** — Update `README.md` and `CLAUDE.md` to describe the new architecture.
- [ ] **Task 10.3** — Run a full release (`./scripts/release/release-macos.sh v0.x.x`) end-to-end. Verify the resulting `.app` opens, all tabs work, marketplace browses, git installs work, sets apply.
- [ ] **Task 10.4** — Bundle size sanity check: should be ~50 MB total (Rust binary) vs ~125 MB currently (binary + 94 MB sidecar). Document the new size.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Subtle behavior differences between Node and Rust (path normalization, symlink semantics, JSON key ordering) | Phase 2.6 byte-for-byte diff against the JS server. Port `test/core.test.js` fixtures to Rust tests early. |
| `git2`/`libgit2` build issues on Windows | Use `vendored-libgit2` feature. If still broken, swap for `gix` (pure Rust) in Phase 5. |
| MCP server (`src/mcp-server.js`) silently rots while we're refactoring core | Explicitly out of scope — flag it in Phase 10.1. Decide its fate after this lands. |
| Frontend shim has typos and breaks specific tabs without notice | Phase 8.2 requires clicking through every tab manually. Better: a smoke-test playwright script as part of Phase 8. |
| Long port — 2600+ lines | Phases are small enough to ship one per session. Each phase leaves the app in a working state with mixed Rust/JS backends coexisting. |
| `scan_projects` performance regression | Rust should be faster, not slower. If not, profile with `tracing` (added in Phase 4 if needed). |

---

## Out of scope

- Porting the MCP server (`src/mcp-server.js`) to Rust.
- Porting the CLI mode (`npm start`) to Rust.
- Adding new features. This is a pure refactor; the API surface is preserved exactly.
- Replacing the frontend stack. React + plain CSS stays.
- Windows / Linux validation beyond confirming it compiles. Real testing happens in a separate session once macOS is solid.
