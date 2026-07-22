# MCP Reconcile & Add-Server Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five pre-0.3.0 MCP fixes from `docs/superpowers/specs/2026-07-22-mcp-reconcile-polish-design.md`: Link/Dismiss for matched import candidates, auto-dismissing "Added" cards, scroll-to-card on import, add-as-variant on drift rows, and import-only discovery of Claude Code plugin MCPs.

**Architecture:** Backend work lives in `src-tauri/src/backend/` (Rust, Tauri commands): a new persistent dismissal store, a new `mcp_reconcile_link` command, and a plugin-manifest scan folded into `mcp_reconcile_impl`. Frontend work lives in `public/mcp-servers.js` (vanilla-JS render functions + event delegation) and `public/mcp-logic.js` (pure helpers, node-testable), with routes mapped in `buildMcpRoutes`. UI behavior is verified by the Playwright suite in `test/ui/mcp-servers.spec.js`, which mocks all `/api/**` calls via `page.route()`.

**Tech Stack:** Rust (tokio, serde, tauri), vanilla JS ES modules, `node --test`, Playwright.

## Global Constraints

- Serena note: this project's Serena LSP only indexes JS/TS — use Serena symbolic tools for `public/*.js`, plain Read/Edit for `*.rs`.
- Rust tests: run `cargo test` from `src-tauri/` (workers: `cd src-tauri && cargo test <filter>`).
- JS unit tests: `npm test` (runs `node --test`, picks up `test/*.test.js`).
- UI tests: `npm run test:ui` (Playwright, requires `npx playwright install chromium` once per machine; no backend needed).
- All new serialized types use `#[serde(rename_all = "camelCase")]`, matching `src-tauri/src/backend/types.rs`.
- New CSS goes in `public/styles.css`, uses existing custom properties (`var(--green)` etc.), and every animation honors `prefers-reduced-motion: reduce`.
- Never add Co-Authored-By lines to commits.
- Copy style: plain literal English (per project design principles), e.g. "Managed by a Claude Code plugin — Skillworks won't modify it."
- Line numbers cited below are as of commit `4b06097` and are anchors, not gospel — locate by symbol name.

---

### Task 1: Backend — persistent dismissal store + reconcile filtering

**Files:**
- Create: `src-tauri/src/backend/mcp/dismissed.rs`
- Modify: `src-tauri/src/backend/mcp/mod.rs` (add `pub mod dismissed;`)
- Modify: `src-tauri/src/backend/commands.rs` (`mcp_reconcile_impl` ~line 2793; new command `mcp_reconcile_dismiss`; tests module)
- Modify: `src-tauri/src/backend/types.rs` (`McpImportCandidate` ~line 793: add `fingerprint`)
- Modify: `src-tauri/src/lib.rs` (register `mcp_reconcile_dismiss` after `mcp_reconcile`, line 53)

**Interfaces:**
- Consumes: `ObservedInvocation` (`mcp/engine.rs`), `write_json_atomic` (`fs_atomic.rs`), `resolve_mcp_app_home`, `MCP_LIBRARY_LOCK` (`commands.rs`).
- Produces:
  - `mcp::dismissed::fingerprint(obs: &ObservedInvocation) -> String`
  - `mcp::dismissed::DismissedEntry { key: String, harness: String, scope: String, fingerprint: String }`
  - `mcp::dismissed::load_dismissed(app_home: &Path) -> BackendResult<Vec<DismissedEntry>>`
  - `mcp::dismissed::save_dismissed(app_home: &Path, entries: &[DismissedEntry]) -> BackendResult<()>`
  - Tauri command `mcp_reconcile_dismiss(key: String, fingerprint: String, targets: Vec<McpDismissTarget>) -> BackendResult<()>` with `McpDismissTarget { harness: String, scope: String }` (Deserialize, camelCase)
  - `McpImportCandidate.fingerprint: String` in the reconcile response (all targets in a group share one invocation, hence one fingerprint).

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/backend/commands.rs` (near `reconcile_flags_unmanaged_drift_and_dedup`, ~line 4970 — reuse its `seed_library` helper and fixture style):

```rust
    #[tokio::test]
    async fn reconcile_dismiss_suppresses_candidate_until_config_changes() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".kiro/settings"))
            .await
            .unwrap();
        tokio::fs::write(
            home.join(".kiro/settings/mcp.json"),
            r#"{"mcpServers":{"unityMCP":{"command":"npx","args":["-y","unity-mcp"]}}}"#,
        )
        .await
        .unwrap();

        let out = mcp_reconcile_impl(None, Some(app_home.clone()), Some(home.clone()))
            .await
            .unwrap();
        let cand = out.imports.iter().find(|c| c.key == "unityMCP").unwrap();
        let fp = cand.fingerprint.clone();
        assert!(!fp.is_empty());

        mcp_reconcile_dismiss_impl(
            "unityMCP".into(),
            fp.clone(),
            vec![McpDismissTarget {
                harness: "kiro".into(),
                scope: "global".into(),
            }],
            Some(app_home.clone()),
        )
        .await
        .unwrap();

        // Dismissed: candidate no longer surfaces.
        let out = mcp_reconcile_impl(None, Some(app_home.clone()), Some(home.clone()))
            .await
            .unwrap();
        assert!(out.imports.iter().all(|c| c.key != "unityMCP"));

        // Config changes meaningfully -> fingerprint mismatch -> resurfaces.
        tokio::fs::write(
            home.join(".kiro/settings/mcp.json"),
            r#"{"mcpServers":{"unityMCP":{"command":"npx","args":["-y","unity-mcp","--port","9000"]}}}"#,
        )
        .await
        .unwrap();
        let out = mcp_reconcile_impl(None, Some(app_home), Some(home))
            .await
            .unwrap();
        assert!(out.imports.iter().any(|c| c.key == "unityMCP"));
    }

    #[tokio::test]
    async fn reconcile_dismiss_is_per_target() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".kiro/settings"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(home.join(".cursor"))
            .await
            .unwrap();
        // Identical invocation under the same key in two harnesses -> one
        // grouped candidate with two foundIn targets.
        let entry = r#"{"mcpServers":{"srv":{"command":"npx","args":["-y","pkg"]}}}"#;
        tokio::fs::write(home.join(".kiro/settings/mcp.json"), entry)
            .await
            .unwrap();
        tokio::fs::write(home.join(".cursor/mcp.json"), entry)
            .await
            .unwrap();

        let out = mcp_reconcile_impl(None, Some(app_home.clone()), Some(home.clone()))
            .await
            .unwrap();
        let cand = out.imports.iter().find(|c| c.key == "srv").unwrap();
        assert_eq!(cand.found_in.len(), 2);
        let fp = cand.fingerprint.clone();

        // Dismiss only the kiro target.
        mcp_reconcile_dismiss_impl(
            "srv".into(),
            fp,
            vec![McpDismissTarget {
                harness: "kiro".into(),
                scope: "global".into(),
            }],
            Some(app_home.clone()),
        )
        .await
        .unwrap();

        let out = mcp_reconcile_impl(None, Some(app_home), Some(home))
            .await
            .unwrap();
        let cand = out.imports.iter().find(|c| c.key == "srv").unwrap();
        assert_eq!(cand.found_in.len(), 1);
        assert_eq!(cand.found_in[0].harness, "cursor");
    }
```

Also add a unit test inside the new `dismissed.rs` module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mcp::spec::McpTransport;
    use std::collections::BTreeMap;

    fn obs(args: &[&str]) -> ObservedInvocation {
        ObservedInvocation {
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: None,
            tools: None,
            unmapped: vec![],
        }
    }

    #[test]
    fn fingerprint_is_stable_and_ignores_unmapped() {
        let mut a = obs(&["-y", "pkg"]);
        let b = obs(&["-y", "pkg"]);
        a.unmapped = vec!["timeout".into()];
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn fingerprint_changes_with_canonical_fields() {
        assert_ne!(fingerprint(&obs(&["-y", "pkg"])), fingerprint(&obs(&["-y", "pkg", "--x"])));
        let mut e = obs(&["-y", "pkg"]);
        e.env.insert("TOKEN".into(), "t".into());
        assert_ne!(fingerprint(&obs(&["-y", "pkg"])), fingerprint(&e));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test reconcile_dismiss fingerprint_`
Expected: compile errors ("cannot find function `mcp_reconcile_dismiss_impl`", "no module `dismissed`") — that counts as the failing state.

- [ ] **Step 3: Implement `dismissed.rs`**

Create `src-tauri/src/backend/mcp/dismissed.rs`:

```rust
//! Persistent per-target dismissals for reconcile import candidates.
//!
//! A dismissal pins the observed invocation via a fingerprint: if the on-disk
//! entry later changes meaningfully, the fingerprint no longer matches and the
//! candidate resurfaces.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use super::super::fs_atomic::write_json_atomic;
use super::super::state::BackendResult;
use super::engine::ObservedInvocation;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissedEntry {
    pub key: String,
    pub harness: String,
    pub scope: String,
    pub fingerprint: String,
}

pub fn dismissed_path(app_home: &Path) -> PathBuf {
    app_home.join("mcp").join("dismissed.json")
}

/// Canonical-field fingerprint of an observed invocation. Deliberately the
/// same field set `invocation_eq` compares (`unmapped` excluded). The JSON
/// string itself is the fingerprint — deterministic (BTreeMap keys are
/// sorted, field order is fixed here) and debuggable in dismissed.json.
pub fn fingerprint(obs: &ObservedInvocation) -> String {
    serde_json::json!({
        "transport": format!("{:?}", obs.transport),
        "command": obs.command,
        "args": obs.args,
        "env": obs.env,
        "url": obs.url,
        "headers": obs.headers,
        "enabled": obs.enabled,
        "tools": obs.tools,
    })
    .to_string()
}

pub async fn load_dismissed(app_home: &Path) -> BackendResult<Vec<DismissedEntry>> {
    let path = dismissed_path(app_home);
    match fs::read(&path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(super::super::state::BackendError::Io(err)),
    }
}

pub async fn save_dismissed(app_home: &Path, entries: &[DismissedEntry]) -> BackendResult<()> {
    write_json_atomic(&dismissed_path(app_home), entries).await
}
```

(Then append the `#[cfg(test)] mod tests` block from Step 1.)

Note: if `serde_json::from_slice`'s error doesn't auto-convert, follow whatever `From` impl `load_library` in `mcp/spec.rs:301` relies on — mirror that exact pattern.

Add to `src-tauri/src/backend/mcp/mod.rs`:

```rust
pub mod dismissed;
```

- [ ] **Step 4: Add the command + filtering in `commands.rs`**

Add the dismiss target type next to the other MCP request types (or directly above the command) and the command right after `mcp_reconcile_impl` (~line 2940):

```rust
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDismissTarget {
    pub harness: String,
    pub scope: String,
}

/// Persistently dismiss a reconcile import candidate for the given targets.
#[tauri::command]
pub async fn mcp_reconcile_dismiss(
    key: String,
    fingerprint: String,
    targets: Vec<McpDismissTarget>,
) -> BackendResult<()> {
    mcp_reconcile_dismiss_impl(key, fingerprint, targets, None).await
}

pub async fn mcp_reconcile_dismiss_impl(
    key: String,
    fingerprint: String,
    targets: Vec<McpDismissTarget>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<()> {
    use super::mcp::dismissed::{load_dismissed, save_dismissed, DismissedEntry};
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    let _guard = MCP_LIBRARY_LOCK.lock().await;
    let mut entries = load_dismissed(&app_home).await?;
    for t in targets {
        let e = DismissedEntry {
            key: key.clone(),
            harness: t.harness,
            scope: t.scope,
            fingerprint: fingerprint.clone(),
        };
        if !entries.contains(&e) {
            entries.push(e);
        }
    }
    save_dismissed(&app_home, &entries).await
}
```

In `mcp_reconcile_impl`: load dismissals once at the top (after `load_library`):

```rust
    let dismissed = super::mcp::dismissed::load_dismissed(&app_home).await?;
```

Then in the unmatched-entry branch (after `let observed = ...` succeeds and **after** the `library.iter().find(|s| s.id == key)` tracked check `continue`s, i.e. right before building `matches`, ~line 2869), skip dismissed targets:

```rust
                let fp = super::mcp::dismissed::fingerprint(&observed);
                if dismissed.iter().any(|d| {
                    d.key == key && d.harness == adapter.harness_id && d.scope == scope && d.fingerprint == fp
                }) {
                    continue;
                }
```

Finally, thread the fingerprint into the response. `ImportGroup` (the local struct used by `mcp_reconcile_impl` — find it near the function) gains nothing; compute at candidate-build time in the `for g in groups` loop (~line 2908):

```rust
        imports.push(McpImportCandidate {
            key: g.key,
            suggested_spec: spec,
            found_in: g.found_in,
            matches_library_id: g.matches,
            warnings: cand_warnings,
            fingerprint: super::mcp::dismissed::fingerprint(&g.observed),
        });
```

And in `src-tauri/src/backend/types.rs`, extend `McpImportCandidate` (~line 793):

```rust
pub struct McpImportCandidate {
    pub key: String,
    pub suggested_spec: super::mcp::spec::McpServerSpec,
    pub found_in: Vec<ReconcileTargetRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_library_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Canonical-invocation fingerprint shared by every foundIn target
    /// (grouping is by invocation equality). Passed back verbatim by the
    /// frontend when dismissing.
    pub fingerprint: String,
}
```

Fix any existing test constructors of `McpImportCandidate` that now miss the field (grep: `rg "McpImportCandidate \{" src-tauri`).

Register the command in `src-tauri/src/lib.rs` after `mcp_reconcile` (line 53):

```rust
        backend::commands::mcp_reconcile_dismiss,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test reconcile_ fingerprint_`
Expected: all reconcile tests (old + 2 new) and both fingerprint tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backend/mcp/dismissed.rs src-tauri/src/backend/mcp/mod.rs src-tauri/src/backend/commands.rs src-tauri/src/backend/types.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): persistent dismissals for reconcile import candidates"
```

---

### Task 2: Backend — `mcp_reconcile_link` command

**Files:**
- Modify: `src-tauri/src/backend/commands.rs` (new command after `mcp_reconcile_dismiss_impl`; tests module)
- Modify: `src-tauri/src/lib.rs` (register `mcp_reconcile_link`)

**Interfaces:**
- Consumes: `mcp_activate_impl`-style plumbing — `adapter_for`, `config_path_for`, `resolve_effective`, `write_entry`, `remove_entry`, `MCP_LIBRARY_LOCK`, `load_library` (all already imported in commands.rs).
- Produces: Tauri command `mcp_reconcile_link(id: String, harness: String, scope: String, key: String, project_path: Option<String>) -> BackendResult<McpActivationResult>`. `key` is the on-disk config key of the discovered entry; when it differs from `id` it is removed after the library entry is written.

- [ ] **Step 1: Write the failing tests**

Append to the commands.rs tests module:

```rust
    #[tokio::test]
    async fn reconcile_link_rewrites_key_and_clears_candidate() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".kiro/settings"))
            .await
            .unwrap();

        // Library server "unity-mcp"; on disk the same invocation sits under
        // key "unityMCP" in kiro/global.
        let spec = McpServerSpec {
            id: "unity-mcp".into(),
            name: "Unity MCP".into(),
            description: None,
            source: crate::backend::mcp::spec::McpSource {
                kind: "manual".into(),
                url: None,
            },
            transport: crate::backend::mcp::spec::McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "unity-mcp".into()],
            env: Default::default(),
            url: None,
            headers: Default::default(),
            variants: vec![],
        };
        seed_library(&app_home, &[spec]).await;
        tokio::fs::write(
            home.join(".kiro/settings/mcp.json"),
            r#"{"mcpServers":{"unityMCP":{"command":"npx","args":["-y","unity-mcp"]}}}"#,
        )
        .await
        .unwrap();

        let before = mcp_reconcile_impl(None, Some(app_home.clone()), Some(home.clone()))
            .await
            .unwrap();
        let cand = before.imports.iter().find(|c| c.key == "unityMCP").unwrap();
        assert_eq!(cand.matches_library_id.as_deref(), Some("unity-mcp"));

        let result = mcp_reconcile_link_impl(
            "unity-mcp".into(),
            "kiro".into(),
            "global".into(),
            "unityMCP".into(),
            None,
            Some(app_home.clone()),
            Some(home.clone()),
        )
        .await
        .unwrap();
        assert!(result.active);

        // Old key gone, library id present.
        let raw = tokio::fs::read_to_string(home.join(".kiro/settings/mcp.json"))
            .await
            .unwrap();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let servers = doc.get("mcpServers").unwrap().as_object().unwrap();
        assert!(servers.get("unityMCP").is_none());
        assert!(servers.get("unity-mcp").is_some());

        // Fully reconciled: no candidate, no drift.
        let after = mcp_reconcile_impl(None, Some(app_home), Some(home))
            .await
            .unwrap();
        assert!(after.imports.is_empty(), "imports: {:?}", after.imports);
        assert!(after.conflicts.is_empty(), "conflicts: {:?}", after.conflicts);
    }

    #[tokio::test]
    async fn reconcile_link_same_key_is_plain_activate() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".cursor")).await.unwrap();
        seed_library(&app_home, &[test_spec("context7")]).await;
        tokio::fs::write(home.join(".cursor/mcp.json"), r#"{"mcpServers":{}}"#)
            .await
            .unwrap();

        mcp_reconcile_link_impl(
            "context7".into(),
            "cursor".into(),
            "global".into(),
            "context7".into(),
            None,
            Some(app_home),
            Some(home.clone()),
        )
        .await
        .unwrap();

        let raw = tokio::fs::read_to_string(home.join(".cursor/mcp.json"))
            .await
            .unwrap();
        assert!(raw.contains("\"context7\""));
    }
```

(`test_spec` is the existing helper used by `mcp_status_tolerates_malformed_target` — reuse it; if its spec shape differs, adapt only the assertion on the raw string.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test reconcile_link`
Expected: compile error "cannot find function `mcp_reconcile_link_impl`".

- [ ] **Step 3: Implement the command**

Insert after `mcp_reconcile_dismiss_impl` in commands.rs. Modeled directly on `mcp_activate_impl` (~line 2488) with the key-removal addition, all under one lock hold:

```rust
/// Resolve a matched import candidate: activate the library server on the
/// candidate's target and, when the on-disk key differs from the library id,
/// remove the old key (activation wrote the entry under the library id).
#[tauri::command]
pub async fn mcp_reconcile_link(
    id: String,
    harness: String,
    scope: String,
    key: String,
    project_path: Option<String>,
) -> BackendResult<McpActivationResult> {
    mcp_reconcile_link_impl(id, harness, scope, key, project_path, None, None).await
}

pub async fn mcp_reconcile_link_impl(
    id: String,
    harness: String,
    scope: String,
    key: String,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
    home_dir_override: Option<PathBuf>,
) -> BackendResult<McpActivationResult> {
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    let servers = load_library(&app_home).await?;
    let spec = servers
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| BackendError::NotFound(format!("No library server with id {id:?}")))?;

    let adapter = adapter_for(&harness)?;
    let home_dir = resolve_home_dir(home_dir_override)?;
    let project_root = resolve_project_root(project_path)?;
    let path = config_path_for(adapter, &scope, &home_dir, project_root.as_deref())?;

    let inv = resolve_effective(spec, &harness, &scope, None)?;
    {
        let _guard = MCP_LIBRARY_LOCK.lock().await;
        write_entry(&path, adapter, &id, &inv).await?;
        if key != id {
            remove_entry(&path, adapter, &key).await?;
        }
    }

    Ok(McpActivationResult {
        server_id: id,
        harness,
        scope: scope.clone(),
        config_path: path.to_string_lossy().into_owned(),
        active: true,
        trust_note: (adapter.project_trust_note && scope == "project")
            .then(|| PROJECT_TRUST_NOTE.to_string()),
    })
}
```

Error-handling note (spec §Error handling): `write_entry` failing leaves the old key untouched (removal only runs after a successful write) — no extra code needed, just don't reorder.

Register in `src-tauri/src/lib.rs` next to `mcp_reconcile_dismiss`:

```rust
        backend::commands::mcp_reconcile_link,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test reconcile_link`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backend/commands.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): reconcile link command for matched import candidates"
```

---

### Task 3: Backend — Claude Code plugin MCP scan (import-only)

**Files:**
- Modify: `src-tauri/src/backend/commands.rs` (`mcp_reconcile_impl`; new helper `scan_claude_plugin_mcps`; tests)
- Modify: `src-tauri/src/backend/types.rs` (`McpImportCandidate`: add `managed_note`)

**Interfaces:**
- Consumes: `parse_entry`, `invocation_eq`, `expected_observed`, `adapter_for("claude")`, `dismissed::fingerprint` from Tasks 0/1.
- Produces:
  - Plugin candidates in the reconcile response: `foundIn[].scope` is the pseudo-scope `"plugin:<shortName>"` (e.g. `plugin:claude-mem`), `foundIn[].harness` is `"claude"`, `managedNote` is `"Managed by a Claude Code plugin — Skillworks won't modify it."`.
  - `McpImportCandidate.managed_note: Option<String>` (camelCase `managedNote`, omitted when None).
  - Plugin entries never appear in `conflicts` and are suppressed when the library already covers them (id match OR invocation-equal).

- [ ] **Step 1: Write the failing tests**

Append to the commands.rs tests module:

```rust
    async fn seed_claude_plugin(home: &std::path::Path, plugin_key: &str, mcp_json: &str) {
        // installed_plugins.json v2 shape observed on real machines:
        // { "version": 2, "plugins": { "name@marketplace": [ { "scope": "user",
        //   "installPath": "...", ... } ] } }
        let install = home.join(format!(".claude/plugins/cache/{plugin_key}"));
        tokio::fs::create_dir_all(&install).await.unwrap();
        tokio::fs::write(install.join(".mcp.json"), mcp_json)
            .await
            .unwrap();
        let manifest_path = home.join(".claude/plugins/installed_plugins.json");
        let existing = tokio::fs::read_to_string(&manifest_path).await.ok();
        let mut doc: serde_json::Value = existing
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({"version": 2, "plugins": {}}));
        doc["plugins"][plugin_key] = serde_json::json!([
            {"scope": "user", "installPath": install.to_string_lossy(), "version": "1.0.0"}
        ]);
        tokio::fs::create_dir_all(home.join(".claude/plugins"))
            .await
            .unwrap();
        tokio::fs::write(&manifest_path, doc.to_string()).await.unwrap();
    }

    #[tokio::test]
    async fn reconcile_surfaces_plugin_mcps_import_only() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        seed_claude_plugin(
            &home,
            "atlassian@claude-plugins-official",
            r#"{"mcpServers":{"atlassian":{"type":"http","url":"https://mcp.atlassian.com/v1/mcp/authv2"}}}"#,
        )
        .await;

        let out = mcp_reconcile_impl(None, Some(app_home), Some(home))
            .await
            .unwrap();
        let cand = out.imports.iter().find(|c| c.key == "atlassian").unwrap();
        assert_eq!(cand.found_in.len(), 1);
        assert_eq!(cand.found_in[0].harness, "claude");
        assert_eq!(cand.found_in[0].scope, "plugin:atlassian");
        assert!(cand.managed_note.is_some());
        assert!(cand.matches_library_id.is_none());
        assert!(out.conflicts.is_empty());
    }

    #[tokio::test]
    async fn reconcile_suppresses_plugin_mcps_already_in_library() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(&home).await.unwrap();

        // Library already has an id-matching server (different invocation).
        let mut by_id = test_spec("atlassian");
        by_id.transport = crate::backend::mcp::spec::McpTransport::Stdio;
        // And an invocation-equal server under a different id.
        let by_inv = McpServerSpec {
            id: "jira".into(),
            name: "Jira".into(),
            description: None,
            source: crate::backend::mcp::spec::McpSource {
                kind: "manual".into(),
                url: None,
            },
            transport: crate::backend::mcp::spec::McpTransport::Http,
            command: None,
            args: vec![],
            env: Default::default(),
            url: Some("https://mcp.example.com/mcp".into()),
            headers: Default::default(),
            variants: vec![],
        };
        seed_library(&app_home, &[by_id, by_inv]).await;

        seed_claude_plugin(
            &home,
            "atlassian@claude-plugins-official",
            r#"{"mcpServers":{"atlassian":{"type":"http","url":"https://x.example.com/mcp"}}}"#,
        )
        .await;
        seed_claude_plugin(
            &home,
            "jira-plugin@claude-plugins-official",
            r#"{"mcpServers":{"jira-remote":{"type":"http","url":"https://mcp.example.com/mcp"}}}"#,
        )
        .await;

        let out = mcp_reconcile_impl(None, Some(app_home), Some(home))
            .await
            .unwrap();
        // id "atlassian" exists in library -> suppressed even though invocation differs.
        assert!(out.imports.iter().all(|c| c.key != "atlassian"));
        // "jira-remote" matches "jira" by invocation -> suppressed.
        assert!(out.imports.iter().all(|c| c.key != "jira-remote"));
        // And plugin entries never produce drift.
        assert!(out.conflicts.is_empty());
    }

    #[tokio::test]
    async fn reconcile_warns_on_malformed_plugin_manifest() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        seed_claude_plugin(&home, "broken@mp", "{ not json").await;

        let out = mcp_reconcile_impl(None, Some(app_home), Some(home))
            .await
            .unwrap();
        assert!(out.imports.is_empty());
        assert!(
            out.warnings.iter().any(|w| w.contains("broken")),
            "warnings: {:?}",
            out.warnings
        );
    }
```

Note: `test_spec(...)` — check its field types before use; if it doesn't allow mutation as written, construct the spec longhand like `by_inv`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test reconcile_surfaces_plugin reconcile_suppresses_plugin reconcile_warns_on_malformed_plugin`
Expected: FAIL — `managed_note` field missing (compile) first; after adding the type field they fail on missing candidates.

- [ ] **Step 3: Add `managed_note` to the type**

In `types.rs`, `McpImportCandidate` gains:

```rust
    /// Present on entries owned by an external manager (e.g. a Claude Code
    /// plugin). Import-only: no link, no drift, no reapply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_note: Option<String>,
```

Update the candidate constructor in `mcp_reconcile_impl` (Task 1's version) with `managed_note: None`, and fix any test constructors.

- [ ] **Step 4: Implement the plugin scan**

In commands.rs, private helper above `mcp_reconcile_impl`:

```rust
const PLUGIN_MANAGED_NOTE: &str =
    "Managed by a Claude Code plugin — Skillworks won't modify it.";

/// Scan Claude Code plugin manifests for MCP servers. Returns
/// (key, observed, config_path, pseudo_scope) tuples plus warnings.
/// Import-only by design: callers must not drift-check these entries.
async fn scan_claude_plugin_mcps(
    home_dir: &std::path::Path,
) -> (Vec<(String, ObservedInvocation, String, String)>, Vec<String>) {
    let mut found = Vec::new();
    let mut warnings = Vec::new();
    let manifest_path = home_dir.join(".claude/plugins/installed_plugins.json");
    let bytes = match tokio::fs::read(&manifest_path).await {
        Ok(b) => b,
        Err(_) => return (found, warnings), // no plugins installed — normal
    };
    let doc: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("claude plugins manifest: {e}"));
            return (found, warnings);
        }
    };
    let adapter = match adapter_for("claude") {
        Ok(a) => a,
        Err(_) => return (found, warnings),
    };
    let plugins = match doc.get("plugins").and_then(|p| p.as_object()) {
        Some(p) => p,
        None => return (found, warnings),
    };
    for (plugin_key, installs) in plugins {
        let short_name = plugin_key.split('@').next().unwrap_or(plugin_key);
        let scope = format!("plugin:{short_name}");
        let Some(installs) = installs.as_array() else {
            continue;
        };
        for install in installs {
            let Some(install_path) = install.get("installPath").and_then(|v| v.as_str()) else {
                continue;
            };
            let mcp_path = std::path::Path::new(install_path).join(".mcp.json");
            let bytes = match tokio::fs::read(&mcp_path).await {
                Ok(b) => b,
                Err(_) => continue, // plugin without MCP servers — normal
            };
            let doc: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    warnings.push(format!("claude plugin \"{short_name}\": {e}"));
                    continue;
                }
            };
            let Some(servers) = doc.get("mcpServers").and_then(|v| v.as_object()) else {
                continue;
            };
            for (key, value) in servers {
                match parse_entry(adapter, value) {
                    Ok(obs) => found.push((
                        key.clone(),
                        obs,
                        mcp_path.to_string_lossy().into_owned(),
                        scope.clone(),
                    )),
                    Err(e) => {
                        warnings.push(format!("claude plugin \"{short_name}\" \"{key}\": {e}"))
                    }
                }
            }
        }
    }
    (found, warnings)
}
```

Then in `mcp_reconcile_impl`, after the adapter loop closes (~line 2905) and before `let mut imports = Vec::new();`, add plugin groups (kept out of the normal `groups` merge so config-file targets never mix with plugin pseudo-targets — plugin candidates carry the managed note, normal ones don't):

```rust
    // Claude Code plugin MCPs — import-only (spec §5).
    let mut plugin_groups: Vec<ImportGroup> = Vec::new();
    {
        let (plugin_entries, plugin_warnings) = scan_claude_plugin_mcps(&home_dir).await;
        warnings.extend(plugin_warnings);
        for (key, observed, config_path, scope) in plugin_entries {
            // Suppress when the library already covers it: id match or
            // invocation-equal expected rendering (any library server).
            if library.iter().any(|s| s.id == key) {
                continue;
            }
            let adapter = adapter_for("claude")?;
            if library.iter().any(|s| {
                expected_observed(adapter, s, &scope)
                    .map(|(exp, _)| invocation_eq(&exp, &observed))
                    .unwrap_or(false)
            }) {
                continue;
            }
            let fp = super::mcp::dismissed::fingerprint(&observed);
            if dismissed.iter().any(|d| {
                d.key == key && d.harness == "claude" && d.scope == scope && d.fingerprint == fp
            }) {
                continue;
            }
            let target_ref = ReconcileTargetRef {
                harness: "claude".to_string(),
                scope,
                config_path,
            };
            match plugin_groups
                .iter_mut()
                .find(|g| g.key == key && invocation_eq(&g.observed, &observed))
            {
                Some(g) => g.found_in.push(target_ref),
                None => plugin_groups.push(ImportGroup {
                    key,
                    observed,
                    found_in: vec![target_ref],
                    matches: None,
                }),
            }
        }
    }
```

Then extend the candidate-building loop to run over both lists, tagging plugin ones. Replace `for g in groups {` with:

```rust
    let groups_with_note: Vec<(ImportGroup, Option<String>)> = groups
        .into_iter()
        .map(|g| (g, None))
        .chain(
            plugin_groups
                .into_iter()
                .map(|g| (g, Some(PLUGIN_MANAGED_NOTE.to_string()))),
        )
        .collect();
    for (g, managed_note) in groups_with_note {
```

…and set `managed_note` on the pushed `McpImportCandidate` (replacing Task 1's `managed_note: None` in this loop).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test reconcile_`
Expected: all reconcile tests PASS (including Tasks 1–2's).

- [ ] **Step 6: Run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS. Fix any `McpImportCandidate` construction sites the compiler flags.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/backend/commands.rs src-tauri/src/backend/types.rs
git commit -m "feat(mcp): import-only discovery of Claude Code plugin MCP servers"
```

---

### Task 4: Frontend — Link + Dismiss buttons, plugin note rendering

**Files:**
- Modify: `public/mcp-logic.js` (`buildMcpRoutes` ~line 61, `foundInSummary` ~line 318)
- Modify: `public/mcp-servers.js` (`renderImportCandidate` ~line 1328, `handleImportCandidate` neighborhood, `bindDomEvents` discovered-section click handler ~line 1583)
- Test: `test/mcp-logic.test.js`, `test/ui/mcp-servers.spec.js`

**Interfaces:**
- Consumes: backend `mcp_reconcile_link` / `mcp_reconcile_dismiss` (Tasks 1–2); candidate fields `fingerprint`, `managedNote` in the reconcile response.
- Produces:
  - Routes: `POST /api/mcp/servers/reconcile/link` → `mcp_reconcile_link` (body `{id, harness, scope, key, projectPath}`), `POST /api/mcp/servers/reconcile/dismiss` → `mcp_reconcile_dismiss` (body `{key, fingerprint, targets}`).
  - `foundInSummary` renders scope `"plugin:x"` as `"plugin: x"` (e.g. "Claude Code / plugin: atlassian").
  - Buttons `[data-mcp-link="<i>"]`, `[data-mcp-dismiss-candidate="<i>"]` on import rows; handlers `handleReconcileLink(index)`, `handleReconcileDismiss(index)`.

- [ ] **Step 1: Write failing node tests for `foundInSummary`**

Append to `test/mcp-logic.test.js` (match the file's existing `node:test` import/assert style):

```js
test("foundInSummary prettifies plugin pseudo-scope", () => {
  assert.equal(
    foundInSummary([{ harness: "claude", scope: "plugin:atlassian" }]),
    "Claude Code / plugin: atlassian"
  );
});

test("buildMcpRoutes exposes reconcile link and dismiss routes", () => {
  const routes = buildMcpRoutes();
  const link = routes.find(([, , cmd]) => cmd === "mcp_reconcile_link");
  const dismiss = routes.find(([, , cmd]) => cmd === "mcp_reconcile_dismiss");
  assert.ok(link && link[0] === "POST" && link[1].test("/api/mcp/servers/reconcile/link"));
  assert.ok(dismiss && dismiss[0] === "POST" && dismiss[1].test("/api/mcp/servers/reconcile/dismiss"));
  assert.deepEqual(
    link[3](new URL("http://x/api/mcp/servers/reconcile/link"), {
      id: "unity-mcp", harness: "kiro", scope: "global", key: "unityMCP", projectPath: "/p",
    }),
    { id: "unity-mcp", harness: "kiro", scope: "global", key: "unityMCP", projectPath: "/p" }
  );
  assert.deepEqual(
    dismiss[3](new URL("http://x/api/mcp/servers/reconcile/dismiss"), {
      key: "srv", fingerprint: "fp", targets: [{ harness: "kiro", scope: "global" }],
    }),
    { key: "srv", fingerprint: "fp", targets: [{ harness: "kiro", scope: "global" }] }
  );
});
```

Run: `npm test`
Expected: FAIL (missing routes; summary renders "plugin:atlassian" verbatim).

- [ ] **Step 2: Implement in `mcp-logic.js`**

Add the two routes at the end of the array in `buildMcpRoutes` (before the closing `];`):

```js
    ["POST", /^\/api\/mcp\/servers\/reconcile\/link$/, "mcp_reconcile_link",
      (_url, body) => ({
        id: body && body.id,
        harness: body && body.harness,
        scope: body && body.scope,
        key: body && body.key,
        projectPath: body && body.projectPath,
      })],

    ["POST", /^\/api\/mcp\/servers\/reconcile\/dismiss$/, "mcp_reconcile_dismiss",
      (_url, body) => ({
        key: body && body.key,
        fingerprint: body && body.fingerprint,
        targets: (body && body.targets) || [],
      })],
```

In `foundInSummary`, replace the scope usage:

```js
export function foundInSummary(foundIn) {
  const items = Array.isArray(foundIn) ? foundIn : [];
  return items
    .map((t) => {
      const label = (MCP_HARNESSES.find((h) => h.id === t.harness) || {}).label || t.harness;
      const scope = String(t.scope || "").startsWith("plugin:")
        ? `plugin: ${String(t.scope).slice("plugin:".length)}`
        : t.scope;
      return `${label} / ${scope}`;
    })
    .join(" · ");
}
```

Run: `npm test` — expected: PASS.

- [ ] **Step 3: Update `renderImportCandidate` (Serena: `replace_symbol_body` on `renderImportCandidate` in `public/mcp-servers.js`)**

```js
function renderImportCandidate(candidate, index) {
  const warnings = Array.isArray(candidate.warnings) ? candidate.warnings : [];
  const matched = Boolean(candidate.matchesLibraryId);
  const matchHint = matched
    ? `<p class="mcp-servers-hint">Looks like <strong>${escapeHtml(libraryServerName(candidate.matchesLibraryId))}</strong>, already in your library.</p>`
    : "";
  const managedNote = candidate.managedNote
    ? `<p class="mcp-servers-trust-note">${escapeHtml(candidate.managedNote)}</p>`
    : "";
  const linkPending = state.reconcilePending.has(`link:${index}`);
  const dismissPending = state.reconcilePending.has(`dismiss:${index}`);
  const primary = matched
    ? `<button type="button" class="button primary" data-mcp-link="${index}" ${linkPending ? "disabled" : ""}>${linkPending ? "Linking…" : `Link to ${escapeHtml(libraryServerName(candidate.matchesLibraryId))}`}</button>`
    : `<button type="button" class="button primary" data-mcp-import="${index}">Import</button>`;
  return `
    <li class="mcp-servers-reconcile-row" data-mcp-import-row="${index}">
      <div class="mcp-servers-reconcile-row-main">
        <span class="mcp-servers-reconcile-key">${escapeHtml(candidate.key)}</span>
        <p class="mcp-servers-hint">Found in: ${escapeHtml(foundInSummary(candidate.foundIn))}</p>
        ${matchHint}
        ${managedNote}
        ${warnings.length ? `<ul class="mcp-servers-add-warnings">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="button-row">
        ${primary}
        <button type="button" class="button ghost" data-mcp-dismiss-candidate="${index}" ${dismissPending ? "disabled" : ""}>${dismissPending ? "Dismissing…" : "Dismiss"}</button>
      </div>
    </li>`;
}
```

- [ ] **Step 4: Add handlers (Serena: `insert_after_symbol` after `handleImportCandidate`)**

```js
async function handleReconcileLink(index) {
  const candidate = state.imports[index];
  if (!candidate || !candidate.matchesLibraryId) return;
  const id = candidate.matchesLibraryId;
  const name = libraryServerName(id);
  const pendingKey = `link:${index}`;
  state.reconcilePending.add(pendingKey);
  renderReconcile();
  try {
    // Link every target the candidate was found in. Sequential on purpose:
    // parallel writes to different harness configs are safe, but keeping it
    // simple avoids interleaved error toasts.
    for (const target of candidate.foundIn || []) {
      await api("/api/mcp/servers/reconcile/link", {
        method: "POST",
        body: {
          id,
          harness: target.harness,
          scope: target.scope,
          key: candidate.key,
          projectPath: target.scope === "project" ? projectPath() : undefined,
        },
      });
    }
    fireToastLocal(`Linked ${candidate.key} to ${name}.`);
  } catch (err) {
    console.error("[mcp-servers] reconcile link failed", err);
  } finally {
    state.reconcilePending.delete(pendingKey);
    await refreshAll();
  }
}

async function handleReconcileDismiss(index) {
  const candidate = state.imports[index];
  if (!candidate) return;
  const pendingKey = `dismiss:${index}`;
  state.reconcilePending.add(pendingKey);
  renderReconcile();
  try {
    await api("/api/mcp/servers/reconcile/dismiss", {
      method: "POST",
      body: {
        key: candidate.key,
        fingerprint: candidate.fingerprint,
        targets: (candidate.foundIn || []).map((t) => ({ harness: t.harness, scope: t.scope })),
      },
    });
    fireToastLocal(`Dismissed ${candidate.key}. It'll come back if its config changes.`);
  } catch (err) {
    console.error("[mcp-servers] reconcile dismiss failed", err);
  } finally {
    state.reconcilePending.delete(pendingKey);
    await refreshAll();
  }
}
```

Check that `projectPath()` is the existing helper in `mcp-servers.js` (Serena symbol `projectPath`); if it takes no arguments and returns the current project path or undefined, use as written — otherwise mirror how `withProject` derives it.

- [ ] **Step 5: Wire events**

In `bindDomEvents`'s `els.discovered` click handler (the block handling `[data-mcp-import]`, ~line 1583), insert after the `importBtn` branch:

```js
      const linkBtn = event.target.closest("[data-mcp-link]");
      if (linkBtn) {
        handleReconcileLink(Number(linkBtn.dataset.mcpLink));
        return;
      }
      const dismissCandidateBtn = event.target.closest("[data-mcp-dismiss-candidate]");
      if (dismissCandidateBtn) {
        handleReconcileDismiss(Number(dismissCandidateBtn.dataset.mcpDismissCandidate));
        return;
      }
```

Use Serena `replace_content` with a regex anchored on the `importBtn` branch.

- [ ] **Step 6: Playwright tests**

In `test/ui/mcp-servers.spec.js`: extend `RECONCILE_FIXTURE.imports` — add `fingerprint: "fp-ctx"` to the existing `ctx` candidate, plus two new candidates:

```js
    {
      key: "unityMCP",
      suggestedSpec: {
        id: "unitymcp", name: "unityMCP", source: { kind: "discovered" },
        transport: "stdio", command: "npx", args: ["-y", "unity-mcp"],
        env: {}, headers: {}, variants: [],
      },
      foundIn: [{ harness: "kiro", scope: "global", configPath: "/tmp/kiro.json" }],
      matchesLibraryId: "everything",
      fingerprint: "fp-unity",
      warnings: [],
    },
    {
      key: "atlassian",
      suggestedSpec: {
        id: "atlassian", name: "atlassian", source: { kind: "discovered" },
        transport: "http", args: [], env: {}, headers: {},
        url: "https://mcp.atlassian.com/v1/mcp/authv2", variants: [],
      },
      foundIn: [{ harness: "claude", scope: "plugin:atlassian", configPath: "/x/.mcp.json" }],
      fingerprint: "fp-atl",
      managedNote: "Managed by a Claude Code plugin — Skillworks won't modify it.",
      warnings: [],
    },
```

New tests (follow the file's existing route-mock + navigation pattern):

```js
test("matched candidate offers Link and Dismiss, not Import", async ({ page }) => {
  // ...standard setup/mocks/navigation from existing tests...
  const row = page.locator('[data-mcp-import-row]', { hasText: "unityMCP" });
  await expect(row.locator("[data-mcp-link]")).toHaveText(/Link to Everything/);
  await expect(row.locator("[data-mcp-dismiss-candidate]")).toBeVisible();
  await expect(row.locator("[data-mcp-import]")).toHaveCount(0);
});

test("dismiss posts key+fingerprint+targets and refreshes", async ({ page }) => {
  // ...standard setup/mocks/navigation from existing tests...
  let captured = null;
  let dismissed = false;
  await page.route("**/api/mcp/servers/reconcile/dismiss", async (route) => {
    captured = route.request().postDataJSON();
    dismissed = true;
    await route.fulfill({ json: {} });
  });
  // The reconcile mock must consult `dismissed`: serve RECONCILE_FIXTURE
  // before the dismiss, and the same fixture minus the unityMCP candidate
  // after (refreshAll re-fetches reconcile once the POST resolves).
  const row = page.locator("[data-mcp-import-row]", { hasText: "unityMCP" });
  await row.locator("[data-mcp-dismiss-candidate]").click();
  await expect(page.locator("[data-mcp-import-row]", { hasText: "unityMCP" })).toHaveCount(0);
  expect(captured).toEqual({
    key: "unityMCP",
    fingerprint: "fp-unity",
    targets: [{ harness: "kiro", scope: "global" }],
  });
});

test("plugin candidate shows managed note and plugin scope label", async ({ page }) => {
  const row = page.locator('[data-mcp-import-row]', { hasText: "atlassian" });
  await expect(row).toContainText("Claude Code / plugin: atlassian");
  await expect(row).toContainText("Managed by a Claude Code plugin");
  await expect(row.locator("[data-mcp-link]")).toHaveCount(0);
  await expect(row.locator("[data-mcp-import]")).toBeVisible();
});
```

Fill the `dismiss posts…` test body concretely: register `page.route` for `**/api/mcp/servers/reconcile/dismiss` that records `route.request().postDataJSON()` into a local variable and fulfills `{}`; after clicking, `expect(captured).toEqual({ key: "unityMCP", fingerprint: "fp-unity", targets: [{ harness: "kiro", scope: "global" }] })`; then assert `page.locator('[data-mcp-import-row]', { hasText: "unityMCP" })` has count 0 once the post-dismiss reconcile fixture is served.

- [ ] **Step 7: Run the suites**

Run: `npm test && npm run test:ui`
Expected: PASS (existing reconcile spec tests may need their fixtures updated for the new `fingerprint` field — update, don't delete).

- [ ] **Step 8: Commit**

```bash
git add public/mcp-logic.js public/mcp-servers.js test/mcp-logic.test.js test/ui/mcp-servers.spec.js
git commit -m "feat(mcp): link and dismiss actions for reconcile import candidates"
```

---

### Task 5: Frontend — auto-dismiss "Added to your library" cards

**Files:**
- Modify: `public/mcp-servers.js` (`handleAddCard` ~line 1285, `renderDraftCard` ~line 1147, new `scheduleAddedCardRemoval`)
- Modify: `public/styles.css` (leaving transition)
- Test: `test/ui/mcp-servers.spec.js`

**Interfaces:**
- Consumes: `state.add.cards`, `renderAdd`.
- Produces: module constants `ADDED_CARD_LINGER_MS = 2500`, `ADDED_CARD_FADE_MS = 280`; card flag `card.leaving` (renders class `is-leaving`); `scheduleAddedCardRemoval(cardKey)`.

- [ ] **Step 1: Write the failing Playwright test**

Append to `test/ui/mcp-servers.spec.js` (reuse the existing add-flow mocks — the suite already has a test adding a card via mocked `POST /api/mcp/servers`; follow it):

```js
test("added card auto-dismisses after a short linger", async ({ page }) => {
  // ...setup + add a server via the existing add-card flow...
  const added = page.locator(".mcp-servers-card-added");
  await expect(added).toBeVisible();
  // 2500ms linger + 280ms fade + margin.
  await expect(page.locator(".mcp-servers-draft-card")).toHaveCount(0, { timeout: 5000 });
});
```

Run: `npm run test:ui -- --grep "auto-dismisses"`
Expected: FAIL (card persists).

- [ ] **Step 2: Implement the timer**

In `mcp-servers.js`, near `newAddCard` (~line 79) add:

```js
const ADDED_CARD_LINGER_MS = 2500;
const ADDED_CARD_FADE_MS = 280;

function removeAddCard(cardKey) {
  const before = state.add.cards.length;
  state.add.cards = state.add.cards.filter((c) => c.key !== cardKey);
  if (state.add.cards.length !== before) renderAdd();
}

// Post-add cards have no buttons (renderDraftCard hides the row once
// card.added is set), so this timer is their only removal path.
function scheduleAddedCardRemoval(cardKey) {
  window.setTimeout(() => {
    const card = state.add.cards.find((c) => c.key === cardKey);
    if (!card) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      removeAddCard(cardKey);
      return;
    }
    card.leaving = true;
    renderAdd();
    window.setTimeout(() => removeAddCard(cardKey), ADDED_CARD_FADE_MS);
  }, ADDED_CARD_LINGER_MS);
}
```

In `handleAddCard`, right after `card.added = true;`:

```js
    card.added = true;
    scheduleAddedCardRemoval(card.key);
```

In `renderDraftCard`, change the opening `<article>` line to carry the class:

```js
    <article class="mcp-servers-draft-card${card.leaving ? " is-leaving" : ""}" data-mcp-card="${card.key}">
```

- [ ] **Step 3: Add the CSS**

In `public/styles.css`, next to the existing `.mcp-servers-draft-card` rules (grep for the class):

```css
.mcp-servers-draft-card.is-leaving {
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 280ms ease, transform 280ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .mcp-servers-draft-card.is-leaving {
    transition: none;
    transform: none;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:ui -- --grep "auto-dismisses"`
Expected: PASS. Also run the full `npm run test:ui` — the pre-existing add-flow test may assert on the added card's presence; if it now races the 2.5s timer, tighten that test to make its assertions immediately after the add (do not extend the linger).

- [ ] **Step 5: Commit**

```bash
git add public/mcp-servers.js public/styles.css test/ui/mcp-servers.spec.js
git commit -m "feat(mcp): auto-dismiss added draft cards after a short linger"
```

---

### Task 6: Frontend — scroll to the new draft card on Import

**Files:**
- Modify: `public/mcp-servers.js` (`handleImportCandidate`)
- Modify: `public/styles.css` (highlight flash)
- Test: `test/ui/mcp-servers.spec.js`

**Interfaces:**
- Consumes: `newAddCard`, `renderAdd`, `els.add`.
- Produces: highlight class `is-highlighted` on the new card; `HIGHLIGHT_MS = 1200`.

- [ ] **Step 1: Write the failing Playwright test**

```js
test("import scrolls the new draft card into view and highlights it", async ({ page }) => {
  // ...setup with RECONCILE_FIXTURE (the unmatched "ctx" candidate)...
  await page.locator("[data-mcp-import]").first().click();
  const card = page.locator(".mcp-servers-draft-card");
  await expect(card).toHaveClass(/is-highlighted/);
  await expect(card).toBeInViewport();
});
```

Run: `npm run test:ui -- --grep "scrolls the new draft card"`
Expected: FAIL (no highlight class).

- [ ] **Step 2: Implement (Serena: `replace_symbol_body` on `handleImportCandidate`)**

```js
const HIGHLIGHT_MS = 1200;

function handleImportCandidate(index) {
  const candidate = state.imports[index];
  if (!candidate) return;
  const card = newAddCard(candidate.suggestedSpec, []);
  state.add.cards.push(card);
  renderAdd();
  // The add panel sits above the reconcile panel — without moving the
  // viewport the click looks like a no-op.
  requestAnimationFrame(() => {
    const el = els.add && els.add.querySelector(`[data-mcp-card="${cssAttrEscape(card.key)}"]`);
    if (!el) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    el.classList.add("is-highlighted");
    window.setTimeout(() => el.classList.remove("is-highlighted"), HIGHLIGHT_MS);
  });
}
```

(`cssAttrEscape` already exists in the file — see the symbols overview. Put `HIGHLIGHT_MS` next to the Task 5 constants, not inside the function.)

Note: the highlight class lives on the DOM node, so any re-render within the 1.2 s (e.g. a `refreshAll` completing) simply drops it early — acceptable, don't persist it in state.

- [ ] **Step 3: Add the CSS**

```css
.mcp-servers-draft-card.is-highlighted {
  animation: mcp-card-flash 1.2s ease;
}

@keyframes mcp-card-flash {
  0% { box-shadow: 0 0 0 3px var(--green); }
  100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0); }
}

@media (prefers-reduced-motion: reduce) {
  .mcp-servers-draft-card.is-highlighted {
    animation: none;
    box-shadow: 0 0 0 3px var(--green);
  }
}
```

(If `--green` isn't the token name in `:root`, use the accent token the design system defines — check `public/styles.css` `:root` ~line 2148.)

- [ ] **Step 4: Run the test**

Run: `npm run test:ui -- --grep "scrolls the new draft card"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/mcp-servers.js public/styles.css test/ui/mcp-servers.spec.js
git commit -m "feat(mcp): scroll and highlight the draft card created by reconcile import"
```

---

### Task 7: Frontend — "Add as variant" / "Update variant" on drift rows

**Files:**
- Modify: `public/mcp-logic.js` (new pure helpers `uniqueVariantLabel`, `variantFromConflict`)
- Modify: `public/mcp-servers.js` (`renderConflictEntry`, new `handleReconcileAdoptVariant`, `bindDomEvents`)
- Test: `test/mcp-logic.test.js`, `test/ui/mcp-servers.spec.js`

**Interfaces:**
- Consumes: conflict fields `serverId`, `harness`, `scope`, `diff` (array of `{field, expected, observed}`), `observedSpec` (library spec with drifted fields overwritten from disk), `variantLabel`, `adoptable`; `specWithVariants(server, variants)` and the PATCH save path in `mcp-servers.js`; variant semantics: set fields replace wholly (`resolve_effective` in `spec.rs`), so drifted field groups take the **full** observed value from `observedSpec`.
- Produces:
  - `uniqueVariantLabel(base: string, variants: Array<{label}>): string` — returns `base`, or `base (2)`, `base (3)`… on collision.
  - `variantFromConflict(conflict, server): { variants: Array, action: "add"|"update", label: string } | null` — `variants` is the server's full new variants array ready for `specWithVariants`; `null` when no diff field is modelable in a variant (only `enabled`/`tools` drifted).
  - Button `[data-mcp-adopt-variant="<i>"]` on conflict rows.

- [ ] **Step 1: Write the failing node tests**

Append to `test/mcp-logic.test.js`:

```js
test("uniqueVariantLabel suffixes on collision", () => {
  assert.equal(uniqueVariantLabel("kiro (global)", []), "kiro (global)");
  assert.equal(
    uniqueVariantLabel("kiro (global)", [{ label: "kiro (global)" }]),
    "kiro (global) (2)"
  );
  assert.equal(
    uniqueVariantLabel("kiro (global)", [{ label: "kiro (global)" }, { label: "kiro (global) (2)" }]),
    "kiro (global) (3)"
  );
});

test("variantFromConflict adds a scoped variant with only drifted groups", () => {
  const server = {
    id: "ctx", transport: "stdio", command: "npx",
    args: ["-y", "pkg"], env: { A: "1" }, headers: {}, variants: [],
  };
  const conflict = {
    serverId: "ctx", harness: "kiro", scope: "global", adoptable: true,
    diff: [
      { field: "args", expected: "-y pkg", observed: "-y pkg --flag" },
      { field: "env.B", observed: "2" },
    ],
    observedSpec: {
      ...server, args: ["-y", "pkg", "--flag"], env: { A: "1", B: "2" },
    },
  };
  const out = variantFromConflict(conflict, server);
  assert.equal(out.action, "add");
  assert.equal(out.variants.length, 1);
  const v = out.variants[0];
  assert.equal(v.label, "kiro (global)");
  assert.deepEqual(v.appliesTo, { harness: "kiro", scope: "global" });
  assert.deepEqual(v.args, ["-y", "pkg", "--flag"]);
  assert.deepEqual(v.env, { A: "1", B: "2" });
  assert.equal(v.command, undefined);
  assert.equal(v.transport, undefined);
});

test("variantFromConflict updates the controlling variant in place", () => {
  const server = {
    id: "ctx", transport: "stdio", command: "npx",
    args: ["-y", "pkg"], env: {}, headers: {},
    variants: [
      { label: "kiro tweak", appliesTo: { harness: "kiro" }, args: ["-y", "pkg", "--old"] },
      { label: "other", appliesTo: { harness: "cursor" } },
    ],
  };
  const conflict = {
    serverId: "ctx", harness: "kiro", scope: "global", adoptable: false,
    variantLabel: "kiro tweak",
    diff: [{ field: "args", expected: "-y pkg --old", observed: "-y pkg --new" }],
    observedSpec: { ...server, args: ["-y", "pkg", "--new"] },
  };
  const out = variantFromConflict(conflict, server);
  assert.equal(out.action, "update");
  assert.equal(out.label, "kiro tweak");
  assert.equal(out.variants.length, 2);
  const updated = out.variants.find((v) => v.label === "kiro tweak");
  assert.deepEqual(updated.args, ["-y", "pkg", "--new"]);
  // Untouched override fields and appliesTo survive.
  assert.deepEqual(updated.appliesTo, { harness: "kiro" });
});

test("variantFromConflict returns null when nothing is modelable", () => {
  const server = { id: "ctx", transport: "stdio", command: "npx", args: [], env: {}, headers: {}, variants: [] };
  const conflict = {
    serverId: "ctx", harness: "opencode", scope: "global", adoptable: true,
    diff: [{ field: "enabled", expected: "true", observed: "false" }],
    observedSpec: server,
  };
  assert.equal(variantFromConflict(conflict, server), null);
});
```

Run: `npm test`
Expected: FAIL ("uniqueVariantLabel is not defined").

- [ ] **Step 2: Implement the helpers in `mcp-logic.js`**

```js
export function uniqueVariantLabel(base, variants) {
  const labels = new Set((variants || []).map((v) => v.label));
  if (!labels.has(base)) return base;
  let n = 2;
  while (labels.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

// Field groups a variant can model. `enabled`/`tools` are renderer-owned
// discriminants with no variant representation — diffs touching only those
// cannot be captured, hence the null return.
const VARIANT_GROUPS = ["transport", "command", "args", "url", "env", "headers"];

function driftedGroups(diff) {
  const groups = new Set();
  for (const d of Array.isArray(diff) ? diff : []) {
    const field = String(d.field || "");
    if (field.startsWith("env.")) groups.add("env");
    else if (field.startsWith("headers.")) groups.add("headers");
    else if (VARIANT_GROUPS.includes(field)) groups.add(field);
  }
  return groups;
}

// Build the server's next variants array for a drift row. Variant overrides
// replace whole fields (see resolve_effective in spec.rs), so each drifted
// group takes the FULL observed value from observedSpec.
export function variantFromConflict(conflict, server) {
  const groups = driftedGroups(conflict.diff);
  if (!groups.size) return null;
  const spec = conflict.observedSpec || {};
  const overrides = {};
  if (groups.has("transport")) overrides.transport = spec.transport;
  if (groups.has("command")) overrides.command = spec.command;
  if (groups.has("args")) overrides.args = Array.isArray(spec.args) ? [...spec.args] : [];
  if (groups.has("url")) overrides.url = spec.url;
  if (groups.has("env")) overrides.env = { ...(spec.env || {}) };
  if (groups.has("headers")) overrides.headers = { ...(spec.headers || {}) };

  const variants = Array.isArray(server.variants) ? server.variants : [];
  if (conflict.adoptable === false && conflict.variantLabel) {
    const idx = variants.findIndex((v) => v.label === conflict.variantLabel);
    if (idx === -1) return null;
    const next = variants.map((v, i) => (i === idx ? { ...v, ...overrides } : v));
    return { variants: next, action: "update", label: conflict.variantLabel };
  }
  const label = uniqueVariantLabel(`${conflict.harness} (${conflict.scope})`, variants);
  const variant = {
    label,
    appliesTo: { harness: conflict.harness, scope: conflict.scope },
    ...overrides,
  };
  return { variants: [...variants, variant], action: "add", label };
}
```

Run: `npm test` — expected: PASS.

- [ ] **Step 3: Render the button (`replace_content` on `renderConflictEntry`'s button-row)**

Import the helpers in `mcp-servers.js`'s existing `mcp-logic.js` import statement. In `renderConflictEntry`, before the `return`, compute:

```js
  const server = state.servers.find((s) => s.id === conflict.serverId);
  const variantPlan = server ? variantFromConflict(conflict, server) : null;
  const variantPending = state.reconcilePending.has(`variant:${index}`);
  const variantBtnLabel = variantPending
    ? "Saving variant…"
    : conflict.adoptable === false && conflict.variantLabel
      ? `Update variant "${escapeHtml(conflict.variantLabel)}"`
      : "Add as variant";
```

and extend the `button-row` div:

```js
      <div class="button-row">
        <button type="button" class="button" data-mcp-reapply="${index}" ${reapplyPending ? "disabled" : ""}>${reapplyPending ? "Reapplying…" : "Reapply library"}</button>
        <button type="button" class="button ghost" data-mcp-adopt="${index}" ${adoptPending || !adoptable ? "disabled" : ""}>${adoptPending ? "Adopting…" : "Adopt into library"}</button>
        <button type="button" class="button ghost" data-mcp-adopt-variant="${index}" ${variantPending || !variantPlan ? "disabled" : ""}>${variantBtnLabel}</button>
      </div>
```

- [ ] **Step 4: Handler + wiring**

Insert after `handleReconcileAdopt` (Serena `insert_after_symbol`):

```js
async function handleReconcileAdoptVariant(index) {
  const conflict = state.conflicts[index];
  if (!conflict) return;
  const server = state.servers.find((s) => s.id === conflict.serverId);
  if (!server) return;
  const plan = variantFromConflict(conflict, server);
  if (!plan) return;
  if (
    plan.action === "update" &&
    !window.confirm(
      `Update variant "${plan.label}" with the on-disk values for ${libraryServerName(conflict.serverId)}?`
    )
  ) {
    return;
  }
  const key = `variant:${index}`;
  state.reconcilePending.add(key);
  renderReconcile();
  try {
    const spec = specWithVariants(server, plan.variants);
    const response = await api("/api/mcp/servers", { method: "PATCH", body: { spec } });
    const servers = Array.isArray(response && response.servers) ? response.servers : state.servers;
    state.servers = servers;
    fireToastLocal(
      plan.action === "update"
        ? `Updated variant "${plan.label}".`
        : `Added variant "${plan.label}" to ${libraryServerName(conflict.serverId)}.`
    );
  } catch (err) {
    console.error("[mcp-servers] adopt-as-variant failed", err);
  } finally {
    state.reconcilePending.delete(key);
    await refreshAll();
  }
}
```

Wire in `bindDomEvents`'s discovered click handler after the `adoptBtn` branch:

```js
      const adoptVariantBtn = event.target.closest("[data-mcp-adopt-variant]");
      if (adoptVariantBtn) {
        handleReconcileAdoptVariant(Number(adoptVariantBtn.dataset.mcpAdoptVariant));
      }
```

- [ ] **Step 5: Playwright tests**

The suite's `RECONCILE_FIXTURE` already contains a drift entry; make sure the drifted server exists in `SERVERS` (it does: drift is against a fixture server). Add a second drift entry with `adoptable: false, variantLabel: "kiro tweak"` against a server whose `variants` include `{ label: "kiro tweak", appliesTo: { harness: "kiro" } }` (extend one SERVERS entry). Tests:

```js
test("drift row offers Add as variant and saves a scoped variant", async ({ page }) => {
  // ...standard setup/mocks/navigation from existing tests...
  let patched = null;
  await page.route("**/api/mcp/servers", async (route) => {
    if (route.request().method() === "PATCH") {
      patched = route.request().postDataJSON();
      await route.fulfill({ json: { servers: SERVERS } });
      return;
    }
    await route.fulfill({ json: { servers: SERVERS } });
  });
  const row = page.locator("[data-mcp-conflict-row]").first(); // the adoptable drift row
  await row.locator("[data-mcp-adopt-variant]").click();
  await expect
    .poll(() => patched && patched.spec && patched.spec.variants.length)
    .toBe(1);
  const v = patched.spec.variants[0];
  // The fixture's drift entry targets a concrete harness/scope — assert
  // against those exact values (e.g. cursor/global in RECONCILE_FIXTURE).
  expect(v.appliesTo).toEqual({ harness: "cursor", scope: "global" });
  expect(v.label).toBe("cursor (global)");
});

test("variant-controlled drift row offers Update variant", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const row = page.locator("[data-mcp-conflict-row]").nth(1);
  await expect(row.locator("[data-mcp-adopt-variant]")).toHaveText(/Update variant "kiro tweak"/);
  await expect(row.locator("[data-mcp-adopt]")).toBeDisabled();
});
```

Fill the capture pattern the same way as Task 4 Step 6 (record `postDataJSON()`, fulfill with `{ servers: SERVERS }`).

- [ ] **Step 6: Run the suites**

Run: `npm test && npm run test:ui`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/mcp-logic.js public/mcp-servers.js test/mcp-logic.test.js test/ui/mcp-servers.spec.js
git commit -m "feat(mcp): adopt drift as a scoped variant from reconcile rows"
```

---

### Task 8: Full verification sweep

**Files:** none new — verification only.

- [ ] **Step 1: Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS, zero failures.

- [ ] **Step 2: JS unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Frontend build**

Run: `npm run build`
Expected: clean Vite build, no errors.

- [ ] **Step 4: Full Playwright suite**

Run: `npm run test:ui`
Expected: PASS (all pre-existing + new tests).

- [ ] **Step 5: Manual smoke (optional but recommended)**

Run `npm run desktop:dev`, open the MCP servers tab and confirm against the real machine state: the unityMCP candidate shows Link/Dismiss; plugin MCPs (e.g. atlassian) appear with the managed note; adding a server auto-clears its card; Import jumps to the card.

- [ ] **Step 6: Commit anything outstanding**

```bash
git status --short
# stage + commit any stragglers with an appropriate message; nothing expected here.
```
