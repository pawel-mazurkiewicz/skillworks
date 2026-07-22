# MCP Discovery Reconciliation (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only `mcp_discover` into full reconciliation — invocation-aware matching of harness config entries against library specs, review-card import of unmanaged entries, and surface-plus-fix for drifted managed entries.

**Architecture:** A per-adapter reverse mapping (`parse_entry`, the inverse of `render_entry`) plus a `render_entry_value` normalizer land in `engine.rs`. Comparison helpers (`invocation_eq`, `diff_invocation`, `spec_from_observed`) land in a new `mcp/reconcile.rs`. One new read command `mcp_reconcile` orchestrates classification. The three mutating actions reuse existing commands (`mcp_add_manual`, `mcp_activate`, `mcp_update_server`). The Phase D discovered panel becomes a two-section Reconcile surface.

**Tech Stack:** Rust (Tauri backend, `serde_json`, `toml_edit`, `tokio`, `tempfile` tests), vanilla ES modules frontend (`node --test`, Playwright).

## Global Constraints

- **No new mutating commands.** Import → `mcp_add_manual`; reapply-library → `mcp_activate`; adopt-config → `mcp_update_server`. Only the read-side `mcp_reconcile` is added.
- **Matching is exact invocation-field equality**, compared *after* normalizing both sides through the same `render_entry_value → parse_entry` pipeline (so format-level ambiguities like Codex's implicit sse→http collapse symmetrically and never read as false drift). No fuzzy/semantic matching.
- **`invocation_eq` ignores `unmapped` keys** (a user's `timeout`, `disabled`, etc.) so harmless extra config keys are not drift.
- Imported specs use `source = { kind: "discovered", url: None }`.
- Adapter set, tri-state variant semantics, and Phase B URL path are unchanged.
- `mcp_discover` / `DiscoveredMcpEntry` stay in place (still unit-tested); the frontend panel switches its data source to `mcp_reconcile`.
- Commit messages: conventional style, **no `Co-Authored-By` trailer**.
- Full gate before the phase is done: `cargo test` (from `src-tauri/`), `npm test`, `npm run build`, `npm run test:ui` — all green.

## File Structure

- `src-tauri/src/backend/mcp/engine.rs` — add `ObservedInvocation`, `parse_entry`, `render_entry_value`.
- `src-tauri/src/backend/mcp/reconcile.rs` — NEW: `FieldDiff`, `invocation_eq`, `diff_invocation`, `effective_to_observed`-free comparison, `spec_from_observed`.
- `src-tauri/src/backend/mcp/mod.rs` — `pub mod reconcile;`.
- `src-tauri/src/backend/mcp/parse/mod.rs` + `parse/assembly.rs` — expose `slugify` and `placeholder_warnings` as `pub(crate)`.
- `src-tauri/src/backend/types.rs` — add `ReconcileTargetRef`, `McpImportCandidate`, `McpDriftEntry`, `McpReconcileResponse`.
- `src-tauri/src/backend/commands.rs` — add `mcp_reconcile` + `mcp_reconcile_impl`.
- `src-tauri/src/lib.rs` — register `mcp_reconcile` in `generate_handler!`.
- `public/mcp-logic.js` — add reconcile route; add `splitReconcile`, `formatDiffRow`, `foundInSummary` pure helpers.
- `public/mcp-servers.js` — replace the read-only discovered panel with the two-section Reconcile surface + import/reapply/adopt wiring.
- Tests: extend `engine.rs`/`reconcile.rs`/`commands.rs` `#[cfg(test)]`; `test/mcp-logic.test.js`; `test/ui/mcp-servers.spec.js`.

---

### Task 1: Reverse mapping — `parse_entry` + `render_entry_value` (engine.rs)

**Files:**
- Modify: `src-tauri/src/backend/mcp/engine.rs`

**Interfaces:**
- Consumes: `McpAdapter`, `CommandStyle`, `ConfigFormat`, `Discriminator`, `RemoteUrlField` (adapters.rs); `McpTransport`, `EffectiveInvocation` (spec.rs); `render_entry_json`, `render_entry_toml`, `toml_item_to_json` (same file).
- Produces: `pub struct ObservedInvocation { transport, command, args, env, headers, url, unmapped }`; `pub fn parse_entry(&McpAdapter, &Value) -> BackendResult<ObservedInvocation>`; `pub fn render_entry_value(&McpAdapter, &EffectiveInvocation) -> Value`.

- [ ] **Step 1: Write the failing round-trip test**

Add to `engine.rs`'s `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn parse_entry_round_trips_render_for_every_adapter() {
        // Codex is implicit-transport: sse renders as a bare url and reads
        // back as http, so exercise stdio + http only for the round trip.
        for id in ["claude", "codex", "cursor", "opencode", "gemini", "copilot", "kiro"] {
            let a = adapter_for(id).unwrap();
            for inv in [stdio_inv(), http_inv()] {
                let value = render_entry_value(a, &inv);
                let obs = parse_entry(a, &value).unwrap();
                assert_eq!(obs.transport, inv.transport, "{id} transport");
                assert_eq!(obs.command, inv.command, "{id} command");
                assert_eq!(obs.args, inv.args, "{id} args");
                assert_eq!(obs.env, inv.env, "{id} env");
                assert_eq!(obs.url, inv.url, "{id} url");
                assert_eq!(obs.headers, inv.headers, "{id} headers");
            }
        }
    }

    #[test]
    fn parse_entry_records_unmapped_keys() {
        let a = adapter_for("cursor").unwrap();
        let v = json!({"command": "npx", "args": ["-y", "pkg"], "timeout": 30, "disabled": false});
        let obs = parse_entry(a, &v).unwrap();
        assert_eq!(obs.command.as_deref(), Some("npx"));
        assert!(obs.unmapped.contains(&"timeout".to_string()));
        assert!(obs.unmapped.contains(&"disabled".to_string()));
    }

    #[test]
    fn parse_entry_gemini_sse_uses_url_field() {
        let a = adapter_for("gemini").unwrap();
        let obs = parse_entry(a, &json!({"url": "https://x/mcp"})).unwrap();
        assert_eq!(obs.transport, McpTransport::Sse);
        let obs = parse_entry(a, &json!({"httpUrl": "https://x/mcp"})).unwrap();
        assert_eq!(obs.transport, McpTransport::Http);
    }

    #[test]
    fn parse_entry_opencode_argv_and_environment() {
        let a = adapter_for("opencode").unwrap();
        let v = json!({"type": "local", "command": ["npx", "-y", "pkg"], "environment": {"K": "V"}, "enabled": true});
        let obs = parse_entry(a, &v).unwrap();
        assert_eq!(obs.command.as_deref(), Some("npx"));
        assert_eq!(obs.args, vec!["-y".to_string(), "pkg".to_string()]);
        assert_eq!(obs.env.get("K").map(String::as_str), Some("V"));
        assert!(obs.unmapped.is_empty());
    }

    #[test]
    fn parse_entry_rejects_incoherent_entry() {
        let a = adapter_for("cursor").unwrap();
        // stdio-shaped but no command and no url
        assert!(parse_entry(a, &json!({"args": ["x"]})).is_err());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --lib mcp::engine::tests::parse_entry`
Expected: FAIL — `parse_entry` / `render_entry_value` / `ObservedInvocation` not found.

- [ ] **Step 3: Implement `ObservedInvocation`, `parse_entry`, `render_entry_value`**

Add near the top of `engine.rs` (after the existing `use` lines, updating the adapters import to include `CommandStyle` and `RemoteUrlField` which are already imported, plus `ConfigFormat` already imported):

```rust
use std::collections::BTreeMap;

/// The canonical invocation observed in an on-disk config entry — the inverse
/// of `render_entry_*`. `unmapped` records keys we do not model (timeout,
/// disabled, autoApprove, …) so callers can surface them without losing them.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservedInvocation {
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub unmapped: Vec<String>,
}

fn json_string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(map)) = value {
        for (k, v) in map {
            let s = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.insert(k.clone(), s);
        }
    }
    out
}

fn json_string_vec(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn infer_transport(
    command: &Option<String>,
    adapter: &McpAdapter,
    obj: &serde_json::Map<String, Value>,
) -> McpTransport {
    if command.is_some() {
        return McpTransport::Stdio;
    }
    if adapter.remote_url_field == RemoteUrlField::GeminiSplit {
        if obj.contains_key("httpUrl") {
            return McpTransport::Http;
        }
        if obj.contains_key("url") {
            return McpTransport::Sse;
        }
    }
    McpTransport::Http
}

/// Deterministic inverse of `render_entry_*`. `value` is an entry as produced
/// by `read_entries` (TOML is already normalized to JSON there, and via
/// `render_entry_value` here), so a single JSON-shaped parser covers both
/// formats.
pub fn parse_entry(adapter: &McpAdapter, value: &Value) -> BackendResult<ObservedInvocation> {
    let obj = value.as_object().ok_or_else(|| {
        BackendError::Validation("MCP config entry is not an object".into())
    })?;

    let headers_key = if adapter.format == ConfigFormat::Toml {
        "http_headers"
    } else {
        "headers"
    };
    let env_key = adapter.env_field;

    let mut consumed: Vec<&str> = vec!["type", "enabled", env_key, headers_key];

    let mut command: Option<String> = None;
    let mut args: Vec<String> = Vec::new();
    match adapter.command_style {
        CommandStyle::SeparateArgs => {
            if let Some(Value::String(c)) = obj.get("command") {
                command = Some(c.clone());
            }
            args = json_string_vec(obj.get("args"));
            consumed.push("command");
            consumed.push("args");
        }
        CommandStyle::ArgvArray => {
            match obj.get("command") {
                Some(Value::Array(_)) => {
                    let all = json_string_vec(obj.get("command"));
                    let mut it = all.into_iter();
                    command = it.next();
                    args = it.collect();
                }
                Some(Value::String(c)) => command = Some(c.clone()),
                _ => {}
            }
            consumed.push("command");
        }
    }

    let env = json_string_map(obj.get(env_key));
    let headers = json_string_map(obj.get(headers_key));

    let url: Option<String> = match adapter.remote_url_field {
        RemoteUrlField::GeminiSplit => {
            consumed.push("httpUrl");
            consumed.push("url");
            obj.get("httpUrl")
                .or_else(|| obj.get("url"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        }
        RemoteUrlField::Url => {
            consumed.push("url");
            obj.get("url").and_then(|v| v.as_str()).map(str::to_string)
        }
    };

    let type_str = obj.get("type").and_then(|v| v.as_str());
    let transport = match adapter.discriminator {
        Discriminator::ClaudeTypes => match type_str {
            Some("http") => McpTransport::Http,
            Some("sse") => McpTransport::Sse,
            Some("stdio") => McpTransport::Stdio,
            _ => infer_transport(&command, adapter, obj),
        },
        Discriminator::OpenCodeTypes => match type_str {
            Some("remote") => McpTransport::Http,
            Some("local") => McpTransport::Stdio,
            _ => infer_transport(&command, adapter, obj),
        },
        Discriminator::CopilotTypes => match type_str {
            Some("http") => McpTransport::Http,
            Some("sse") => McpTransport::Sse,
            Some("local") => McpTransport::Stdio,
            _ => infer_transport(&command, adapter, obj),
        },
        Discriminator::None => infer_transport(&command, adapter, obj),
    };

    match transport {
        McpTransport::Stdio if command.as_deref().unwrap_or("").is_empty() => {
            return Err(BackendError::Validation(
                "stdio config entry has no command".into(),
            ));
        }
        McpTransport::Http | McpTransport::Sse if url.as_deref().unwrap_or("").is_empty() => {
            return Err(BackendError::Validation(
                "remote config entry has no url".into(),
            ));
        }
        _ => {}
    }

    let unmapped: Vec<String> = obj
        .keys()
        .filter(|k| !consumed.contains(&k.as_str()))
        .cloned()
        .collect();

    Ok(ObservedInvocation {
        transport,
        command,
        args,
        env,
        url,
        headers,
        unmapped,
    })
}

/// Render an effective invocation to the JSON value shape that `read_entries`
/// yields for this adapter (TOML normalized via `toml_item_to_json`). Used to
/// compute the "expected" observed invocation for drift comparison so both
/// sides pass through identical normalization.
pub fn render_entry_value(adapter: &McpAdapter, inv: &EffectiveInvocation) -> Value {
    match adapter.format {
        ConfigFormat::Json => render_entry_json(adapter, inv),
        ConfigFormat::Toml => {
            toml_item_to_json(&toml_edit::Item::Table(render_entry_toml(inv)))
        }
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd src-tauri && cargo test --lib mcp::engine`
Expected: PASS (all engine tests, old + new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backend/mcp/engine.rs
git commit -m "feat(mcp): reverse-map config entries (parse_entry) + render_entry_value"
```

---

### Task 2: Comparison helpers — `mcp/reconcile.rs`

**Files:**
- Create: `src-tauri/src/backend/mcp/reconcile.rs`
- Modify: `src-tauri/src/backend/mcp/mod.rs`

**Interfaces:**
- Consumes: `ObservedInvocation` (engine.rs); `McpServerSpec`, `McpSource`, `McpTransport` (spec.rs).
- Produces: `pub struct FieldDiff { field, expected, observed }` (Serialize, camelCase); `pub fn invocation_eq(&ObservedInvocation, &ObservedInvocation) -> bool`; `pub fn diff_invocation(&ObservedInvocation, &ObservedInvocation) -> Vec<FieldDiff>`; `pub fn spec_from_observed(String, String, &ObservedInvocation) -> McpServerSpec`.

- [ ] **Step 1: Declare the module**

In `src-tauri/src/backend/mcp/mod.rs`, add alongside the other `pub mod` lines:

```rust
pub mod reconcile;
```

- [ ] **Step 2: Write the failing tests (in the new file)**

Create `src-tauri/src/backend/mcp/reconcile.rs` with only the test module first is impractical; instead write the file with impl + tests in Step 3–4. For TDD, write this test block at the bottom now and a stub `pub fn invocation_eq` returning `false` to see it fail. To keep it simple, create the file with the full test module and stubbed bodies:

```rust
//! Comparison + import-shaping helpers for discovery reconciliation.

use serde::Serialize;

use super::engine::ObservedInvocation;
use super::spec::{McpServerSpec, McpSource, McpTransport};

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn stdio(args: &[&str]) -> ObservedInvocation {
        ObservedInvocation {
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            unmapped: vec![],
        }
    }

    #[test]
    fn eq_ignores_unmapped() {
        let mut a = stdio(&["-y", "pkg"]);
        let mut b = stdio(&["-y", "pkg"]);
        a.unmapped = vec!["timeout".into()];
        b.unmapped = vec![];
        assert!(invocation_eq(&a, &b));
    }

    #[test]
    fn eq_is_arg_order_sensitive() {
        assert!(!invocation_eq(&stdio(&["a", "b"]), &stdio(&["b", "a"])));
    }

    #[test]
    fn diff_reports_changed_fields() {
        let mut expected = stdio(&["-y", "pkg"]);
        expected.env.insert("TOKEN".into(), "old".into());
        let mut observed = stdio(&["-y", "pkg", "--flag"]);
        observed.env.insert("TOKEN".into(), "new".into());
        let diffs = diff_invocation(&expected, &observed);
        let fields: Vec<&str> = diffs.iter().map(|d| d.field.as_str()).collect();
        assert!(fields.contains(&"args"));
        assert!(fields.contains(&"env.TOKEN"));
    }

    #[test]
    fn spec_from_observed_marks_discovered() {
        let spec = spec_from_observed("ctx7".into(), "ctx7".into(), &stdio(&["-y", "pkg"]));
        assert_eq!(spec.id, "ctx7");
        assert_eq!(spec.source.kind, "discovered");
        assert_eq!(spec.command.as_deref(), Some("npx"));
        assert!(spec.variants.is_empty());
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test --lib mcp::reconcile`
Expected: FAIL — `invocation_eq` etc. not found.

- [ ] **Step 4: Implement the helpers (above the test module)**

Insert between the `use` lines and `#[cfg(test)]`:

```rust
/// A single field-level difference between the library-expected invocation and
/// what is on disk. Rendered in the drift UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff {
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<String>,
}

fn transport_str(t: McpTransport) -> &'static str {
    match t {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    }
}

/// Canonical-field equality; deliberately ignores `unmapped`.
pub fn invocation_eq(a: &ObservedInvocation, b: &ObservedInvocation) -> bool {
    a.transport == b.transport
        && a.command == b.command
        && a.args == b.args
        && a.env == b.env
        && a.url == b.url
        && a.headers == b.headers
}

fn diff_string_map(
    prefix: &str,
    expected: &std::collections::BTreeMap<String, String>,
    observed: &std::collections::BTreeMap<String, String>,
    out: &mut Vec<FieldDiff>,
) {
    let mut keys: Vec<&String> = expected.keys().chain(observed.keys()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        let e = expected.get(k);
        let o = observed.get(k);
        if e != o {
            out.push(FieldDiff {
                field: format!("{prefix}.{k}"),
                expected: e.cloned(),
                observed: o.cloned(),
            });
        }
    }
}

/// Field-level diff (expected = library, observed = on disk).
pub fn diff_invocation(
    expected: &ObservedInvocation,
    observed: &ObservedInvocation,
) -> Vec<FieldDiff> {
    let mut out = Vec::new();
    if expected.transport != observed.transport {
        out.push(FieldDiff {
            field: "transport".into(),
            expected: Some(transport_str(expected.transport).into()),
            observed: Some(transport_str(observed.transport).into()),
        });
    }
    if expected.command != observed.command {
        out.push(FieldDiff {
            field: "command".into(),
            expected: expected.command.clone(),
            observed: observed.command.clone(),
        });
    }
    if expected.args != observed.args {
        out.push(FieldDiff {
            field: "args".into(),
            expected: Some(expected.args.join(" ")),
            observed: Some(observed.args.join(" ")),
        });
    }
    if expected.url != observed.url {
        out.push(FieldDiff {
            field: "url".into(),
            expected: expected.url.clone(),
            observed: observed.url.clone(),
        });
    }
    diff_string_map("env", &expected.env, &observed.env, &mut out);
    diff_string_map("headers", &expected.headers, &observed.headers, &mut out);
    out
}

/// Build a ready-to-review library spec from an observed invocation.
pub fn spec_from_observed(id: String, name: String, obs: &ObservedInvocation) -> McpServerSpec {
    McpServerSpec {
        id,
        name,
        description: None,
        source: McpSource {
            kind: "discovered".into(),
            url: None,
        },
        transport: obs.transport,
        command: obs.command.clone(),
        args: obs.args.clone(),
        env: obs.env.clone(),
        url: obs.url.clone(),
        headers: obs.headers.clone(),
        variants: vec![],
    }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd src-tauri && cargo test --lib mcp::reconcile`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backend/mcp/mod.rs src-tauri/src/backend/mcp/reconcile.rs
git commit -m "feat(mcp): reconcile comparison helpers (invocation_eq, diff_invocation)"
```

---

### Task 3: Expose Phase B `slugify` + `placeholder_warnings`

**Files:**
- Modify: `src-tauri/src/backend/mcp/parse/assembly.rs`
- Modify: `src-tauri/src/backend/mcp/parse/mod.rs`

**Interfaces:**
- Produces: `pub(crate) fn slugify(&str) -> String` and `pub(crate) fn placeholder_warnings(&McpServerSpec) -> Vec<String>`, re-exported from `parse` so `commands.rs` can call `parse::{slugify, placeholder_warnings}`.

- [ ] **Step 1: Widen visibility in `assembly.rs`**

Change the two private signatures (currently `fn slugify(` and `fn placeholder_warnings(`) to `pub(crate) fn slugify(` and `pub(crate) fn placeholder_warnings(`. Leave bodies untouched.

- [ ] **Step 2: Re-export from `parse/mod.rs`**

In `src-tauri/src/backend/mcp/parse/mod.rs`, add a re-export next to the existing `pub use` lines:

```rust
pub(crate) use assembly::{placeholder_warnings, slugify};
```

(If `assembly` is declared `mod assembly;`, keep it; the `pub(crate) use` re-export is what widens reach. If an existing `pub use assembly::…` line already lists items, extend that list instead of adding a duplicate.)

- [ ] **Step 3: Verify it still builds**

Run: `cd src-tauri && cargo build --lib`
Expected: builds clean (a dead-code warning is acceptable until Task 4 consumes them; if `-D warnings` is set in CI, Task 4 lands in the same PR so the final gate is green).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/backend/mcp/parse/assembly.rs src-tauri/src/backend/mcp/parse/mod.rs
git commit -m "refactor(mcp): expose slugify + placeholder_warnings for reconcile"
```

---

### Task 4: `mcp_reconcile` command + IPC types

**Files:**
- Modify: `src-tauri/src/backend/types.rs`
- Modify: `src-tauri/src/backend/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `parse_entry`, `render_entry_value`, `ObservedInvocation` (engine.rs); `invocation_eq`, `diff_invocation`, `spec_from_observed`, `FieldDiff` (reconcile.rs); `resolve_effective`, `validate_spec`, `load_library` (spec.rs); `adapters`, `config_path_for` (adapters.rs); `read_entries` (engine.rs); `parse::{slugify, placeholder_warnings}`; existing `resolve_mcp_app_home`, `resolve_home_dir`, `resolve_project_root`, `PROJECT_TRUST_NOTE` (commands.rs).
- Produces: `mcp_reconcile(project_path: Option<String>) -> BackendResult<McpReconcileResponse>` (+ `_impl`); the four new types.

- [ ] **Step 1: Add IPC types to `types.rs`**

Append near the existing `DiscoveredMcpEntry` definition:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileTargetRef {
    pub harness: String,
    pub scope: String,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportCandidate {
    pub key: String,
    pub suggested_spec: super::mcp::spec::McpServerSpec,
    pub found_in: Vec<ReconcileTargetRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches_library_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDriftEntry {
    pub server_id: String,
    pub harness: String,
    pub scope: String,
    pub config_path: String,
    pub diff: Vec<super::mcp::reconcile::FieldDiff>,
    /// The library spec with its canonical invocation replaced by what is on
    /// disk — ready for the "adopt config → update library" PATCH.
    pub observed_spec: super::mcp::spec::McpServerSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReconcileResponse {
    pub imports: Vec<McpImportCandidate>,
    pub conflicts: Vec<McpDriftEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}
```

- [ ] **Step 2: Write the failing command test**

Add to the `#[cfg(test)] mod tests` in `commands.rs` (reuse the tempdir/library-seeding style already present there; helper to seed a library file `<app_home>/mcp/servers.json` and a harness config). Write these cases:

```rust
    async fn seed_library(app_home: &std::path::Path, servers: &[McpServerSpec]) {
        crate::backend::mcp::spec::save_library(app_home, servers).await.unwrap();
    }

    #[tokio::test]
    async fn reconcile_flags_unmanaged_drift_and_dedup() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".cursor")).await.unwrap();
        tokio::fs::create_dir_all(home.join(".kiro/settings")).await.unwrap();

        // Library server "context7" (stdio npx). We'll drift it in cursor and
        // leave an unmanaged "extra" in kiro; and put an invocation-identical
        // copy of context7 under a different key "ctx" in kiro.
        let ctx = McpServerSpec {
            id: "context7".into(), name: "Context7".into(), description: None,
            source: McpSource { kind: "manual".into(), url: None },
            transport: McpTransport::Stdio, command: Some("npx".into()),
            args: vec!["-y".into(), "@upstash/context7-mcp".into()],
            env: Default::default(), url: None, headers: Default::default(), variants: vec![],
        };
        seed_library(&app_home, &[ctx]).await;

        // cursor global: context7 present but drifted (extra arg).
        tokio::fs::write(home.join(".cursor/mcp.json"),
            r#"{"mcpServers":{"context7":{"command":"npx","args":["-y","@upstash/context7-mcp","--verbose"]},"extra":{"command":"foo","args":[]}}}"#).await.unwrap();
        // kiro global: an invocation-identical copy of context7 under key "ctx".
        tokio::fs::write(home.join(".kiro/settings/mcp.json"),
            r#"{"mcpServers":{"ctx":{"command":"npx","args":["-y","@upstash/context7-mcp"]}}}"#).await.unwrap();

        let out = mcp_reconcile_impl(None, Some(app_home.clone()), Some(home.clone())).await.unwrap();

        // One drift entry for cursor/context7.
        assert_eq!(out.conflicts.len(), 1);
        assert_eq!(out.conflicts[0].server_id, "context7");
        assert_eq!(out.conflicts[0].harness, "cursor");
        assert!(out.conflicts[0].diff.iter().any(|d| d.field == "args"));

        // Import candidates: "extra" (unknown) and "ctx" (matches context7).
        let keys: Vec<&str> = out.imports.iter().map(|c| c.key.as_str()).collect();
        assert!(keys.contains(&"extra"));
        let ctx_cand = out.imports.iter().find(|c| c.key == "ctx").unwrap();
        assert_eq!(ctx_cand.matches_library_id.as_deref(), Some("context7"));
        // "extra" is a plain unknown.
        let extra = out.imports.iter().find(|c| c.key == "extra").unwrap();
        assert!(extra.matches_library_id.is_none());
        assert_eq!(extra.suggested_spec.source.kind, "discovered");
    }

    #[tokio::test]
    async fn reconcile_dedups_identical_invocation_across_targets() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".cursor")).await.unwrap();
        tokio::fs::create_dir_all(home.join(".kiro/settings")).await.unwrap();
        // Same unmanaged "srv" (identical stdio invocation) in cursor + kiro.
        let body = r#"{"mcpServers":{"srv":{"command":"npx","args":["-y","srv"]}}}"#;
        tokio::fs::write(home.join(".cursor/mcp.json"), body).await.unwrap();
        tokio::fs::write(home.join(".kiro/settings/mcp.json"), body).await.unwrap();

        let out = mcp_reconcile_impl(None, Some(app_home), Some(home)).await.unwrap();
        let srv: Vec<_> = out.imports.iter().filter(|c| c.key == "srv").collect();
        assert_eq!(srv.len(), 1, "identical invocation collapses to one candidate");
        assert_eq!(srv[0].found_in.len(), 2, "lists both targets");
    }

    #[tokio::test]
    async fn reconcile_warns_on_placeholder_and_malformed() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".cursor")).await.unwrap();
        // placeholder env + a malformed sibling file handled elsewhere; here a
        // placeholder token should attach a candidate warning.
        tokio::fs::write(home.join(".cursor/mcp.json"),
            r#"{"mcpServers":{"srv":{"command":"npx","args":["-y","srv"],"env":{"TOKEN":"YOUR_TOKEN_HERE"}}}}"#).await.unwrap();
        let out = mcp_reconcile_impl(None, Some(app_home), Some(home)).await.unwrap();
        let srv = out.imports.iter().find(|c| c.key == "srv").unwrap();
        assert!(srv.warnings.iter().any(|w| w.contains("placeholder")));
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test --lib commands::tests::reconcile`
Expected: FAIL — `mcp_reconcile_impl` not found.

- [ ] **Step 4: Implement `mcp_reconcile` + `mcp_reconcile_impl`**

Add near `mcp_discover_impl` in `commands.rs`. Add the needed imports to the existing `use super::mcp::…` groups: `engine::{parse_entry, render_entry_value, ObservedInvocation}`, `reconcile::{diff_invocation, invocation_eq, spec_from_observed}`, `parse::{placeholder_warnings, slugify}`, and the four types from `types`.

```rust
struct ImportGroup {
    key: String,
    observed: ObservedInvocation,
    found_in: Vec<ReconcileTargetRef>,
    matches: Option<String>,
}

/// Expected observed-invocation for a library spec at a target, normalized
/// through the same render→parse pipeline as on-disk entries.
fn expected_observed(
    adapter: &super::mcp::adapters::McpAdapter,
    spec: &McpServerSpec,
    scope: &str,
) -> BackendResult<ObservedInvocation> {
    let inv = resolve_effective(spec, adapter.harness_id, scope, None)?;
    let value = render_entry_value(adapter, &inv);
    parse_entry(adapter, &value)
}

/// The library spec with its canonical invocation replaced by what is on disk
/// (id/name/description/variants preserved) — the payload for "adopt config".
fn adopt_spec(library: &McpServerSpec, observed: &ObservedInvocation) -> McpServerSpec {
    let mut s = library.clone();
    s.transport = observed.transport;
    s.command = observed.command.clone();
    s.args = observed.args.clone();
    s.env = observed.env.clone();
    s.url = observed.url.clone();
    s.headers = observed.headers.clone();
    s
}

#[tauri::command]
pub async fn mcp_reconcile(
    project_path: Option<String>,
) -> BackendResult<McpReconcileResponse> {
    mcp_reconcile_impl(project_path, None, None).await
}

pub async fn mcp_reconcile_impl(
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
    home_dir_override: Option<PathBuf>,
) -> BackendResult<McpReconcileResponse> {
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    let library = load_library(&app_home).await?;
    let home_dir = resolve_home_dir(home_dir_override)?;
    let project_root = resolve_project_root(project_path)?;

    let mut warnings: Vec<String> = Vec::new();
    let mut conflicts: Vec<McpDriftEntry> = Vec::new();
    let mut groups: Vec<ImportGroup> = Vec::new();

    for adapter in adapters() {
        let mut targets = vec![("global", config_path_for(adapter, "global", &home_dir, None)?)];
        if let Some(root) = project_root.as_deref() {
            targets.push(("project", config_path_for(adapter, "project", &home_dir, Some(root))?));
        }
        for (scope, path) in targets {
            let entries = match read_entries(&path, adapter).await {
                Ok(e) => e,
                Err(e) => {
                    warnings.push(format!("{} ({scope}): {e}", adapter.harness_id));
                    continue;
                }
            };
            for (key, value) in entries {
                let observed = match parse_entry(adapter, &value) {
                    Ok(o) => o,
                    Err(e) => {
                        warnings.push(format!("{}/{scope} \"{key}\": {e}", adapter.harness_id));
                        continue;
                    }
                };
                let config_path = path.to_string_lossy().into_owned();

                if let Some(spec) = library.iter().find(|s| s.id == key) {
                    match expected_observed(adapter, spec, scope) {
                        Ok(expected) => {
                            if !invocation_eq(&expected, &observed) {
                                conflicts.push(McpDriftEntry {
                                    server_id: key.clone(),
                                    harness: adapter.harness_id.to_string(),
                                    scope: scope.to_string(),
                                    config_path,
                                    diff: diff_invocation(&expected, &observed),
                                    observed_spec: adopt_spec(spec, &observed),
                                    trust_note: (adapter.project_trust_note && scope == "project")
                                        .then(|| PROJECT_TRUST_NOTE.to_string()),
                                });
                            }
                        }
                        Err(e) => warnings.push(format!(
                            "{}/{scope} \"{key}\": {e}",
                            adapter.harness_id
                        )),
                    }
                    continue;
                }

                let matches = library.iter().find_map(|s| {
                    expected_observed(adapter, s, scope)
                        .ok()
                        .filter(|exp| invocation_eq(exp, &observed))
                        .map(|_| s.id.clone())
                });
                let target_ref = ReconcileTargetRef {
                    harness: adapter.harness_id.to_string(),
                    scope: scope.to_string(),
                    config_path,
                };
                match groups
                    .iter_mut()
                    .find(|g| g.key == key && invocation_eq(&g.observed, &observed))
                {
                    Some(g) => {
                        g.found_in.push(target_ref);
                        if g.matches.is_none() {
                            g.matches = matches;
                        }
                    }
                    None => groups.push(ImportGroup {
                        key: key.clone(),
                        observed,
                        found_in: vec![target_ref],
                        matches,
                    }),
                }
            }
        }
    }

    let mut imports = Vec::new();
    for g in groups {
        let id = slugify(&g.key);
        if id.is_empty() {
            warnings.push(format!("\"{}\": cannot derive a valid id — skipped", g.key));
            continue;
        }
        let spec = spec_from_observed(id, g.key.clone(), &g.observed);
        if let Err(e) = validate_spec(&spec) {
            warnings.push(format!("\"{}\": {e}", g.key));
            continue;
        }
        let mut cand_warnings = placeholder_warnings(&spec);
        if !g.observed.unmapped.is_empty() {
            cand_warnings.push(format!(
                "ignored config keys: {}",
                g.observed.unmapped.join(", ")
            ));
        }
        imports.push(McpImportCandidate {
            key: g.key,
            suggested_spec: spec,
            found_in: g.found_in,
            matches_library_id: g.matches,
            warnings: cand_warnings,
        });
    }

    Ok(McpReconcileResponse {
        imports,
        conflicts,
        warnings,
    })
}
```

Ensure the four new types are imported at the top of `commands.rs` (extend the existing `use super::types::{…}` group).

- [ ] **Step 5: Register the command in `lib.rs`**

In `src-tauri/src/lib.rs`, add `mcp_reconcile` to the `tauri::generate_handler!` list, next to `mcp_discover`.

- [ ] **Step 6: Run tests + build**

Run: `cd src-tauri && cargo test --lib mcp && cargo test --lib commands::tests::reconcile && cargo build --lib`
Expected: PASS + clean build.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/backend/types.rs src-tauri/src/backend/commands.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): mcp_reconcile command — classify import candidates + drift"
```

---

### Task 5: Frontend pure helpers (mcp-logic.js)

**Files:**
- Modify: `public/mcp-logic.js`
- Test: `test/mcp-logic.test.js`

**Interfaces:**
- Produces: a `GET /api/mcp/servers/reconcile → mcp_reconcile` route; `export function foundInSummary(foundIn)`; `export function formatDiffValue(value)`; `export function splitReconcile(response)` returning `{ imports, conflicts, warnings }` with safe defaults.

- [ ] **Step 1: Write the failing tests**

Add to `test/mcp-logic.test.js`:

```js
import { foundInSummary, formatDiffValue, splitReconcile, buildMcpRoutes } from "../public/mcp-logic.js";

test("buildMcpRoutes exposes reconcile route", () => {
  const routes = buildMcpRoutes();
  const hit = routes.find((r) => "/api/mcp/servers/reconcile".match(r[1]));
  assert.ok(hit, "reconcile route present");
  assert.equal(hit[2], "mcp_reconcile");
});

test("foundInSummary lists harness/scope pairs", () => {
  const s = foundInSummary([
    { harness: "claude", scope: "global" },
    { harness: "cursor", scope: "project" },
  ]);
  assert.match(s, /Claude Code/);
  assert.match(s, /global/);
  assert.match(s, /cursor|Cursor/);
});

test("formatDiffValue renders empty/undefined as an explicit dash", () => {
  assert.equal(formatDiffValue(undefined), "—");
  assert.equal(formatDiffValue(""), "—");
  assert.equal(formatDiffValue("npx"), "npx");
});

test("splitReconcile tolerates missing fields", () => {
  const r = splitReconcile(null);
  assert.deepEqual(r, { imports: [], conflicts: [], warnings: [] });
  const r2 = splitReconcile({ imports: [{ key: "x" }] });
  assert.equal(r2.imports.length, 1);
  assert.deepEqual(r2.conflicts, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Add the reconcile route**

In `buildMcpRoutes()` (public/mcp-logic.js), add after the `discover` route:

```js
    ["GET", /^\/api\/mcp\/servers\/reconcile$/, "mcp_reconcile", (url) => ({
      projectPath: url.searchParams.get("project") || undefined,
    })],
```

- [ ] **Step 4: Add the helpers**

Append to `public/mcp-logic.js` (they may reference `MCP_HARNESSES` defined above):

```js
// Human summary of a candidate's foundIn list, e.g.
// "Claude Code / global · Cursor / project".
export function foundInSummary(foundIn) {
  const items = Array.isArray(foundIn) ? foundIn : [];
  return items
    .map((t) => {
      const label = (MCP_HARNESSES.find((h) => h.id === t.harness) || {}).label || t.harness;
      return `${label} / ${t.scope}`;
    })
    .join(" · ");
}

// Drift diff cells: render an absent/empty value as an explicit em dash so
// "added" vs "removed" reads clearly in the table.
export function formatDiffValue(value) {
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

// Normalize an mcp_reconcile response into stable arrays.
export function splitReconcile(response) {
  const r = response || {};
  return {
    imports: Array.isArray(r.imports) ? r.imports : [],
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/mcp-logic.js test/mcp-logic.test.js
git commit -m "feat(mcp): reconcile route + pure helpers in mcp-logic"
```

---

### Task 6: Reconcile panel — two sections + import/reapply/adopt wiring

**Files:**
- Modify: `public/mcp-servers.js`
- Test: `test/ui/mcp-servers.spec.js`

**Interfaces:**
- Consumes: `splitReconcile`, `foundInSummary`, `formatDiffValue`, `escapeHtml`, `MCP_HARNESSES` (mcp-logic.js); the existing add/review-card open function, the existing activate/update request helpers, and `refreshAll`/state-slice pattern already in `mcp-servers.js`.
- Produces: a Reconcile surface replacing `renderDiscovered`; import → opens the review card seeded from `suggestedSpec`; reapply → `POST …/activate`; adopt → `PATCH …/servers`.

**Context for the implementer:** `mcp-servers.js` already fetches discover in `loadAll` (around line 146–154) and renders a read-only panel in `renderDiscovered` (around line 1306–1352). The tab has an existing add/review-card flow (used by the from-URL and manual paths) and existing activate/update calls (used by the matrix and editor). Reuse those — do not build new request plumbing. Follow the file's established state-slice / render / event-delegation conventions. No React.

- [ ] **Step 1: Write the failing Playwright smoke test**

Add to `test/ui/mcp-servers.spec.js` a spec that mocks `/api/mcp/servers/reconcile` to return one import candidate and one drift entry, then asserts:
- both sections render (an "Unmanaged" / import row for the candidate key, and a "Needs attention" / drift row for the server id);
- clicking the candidate's **Import** button opens the review card prefilled (an input carries the suggested id/name);
- clicking a drift row's **Reapply** button fires a request to `**/activate` (assert via `page.waitForRequest`);
- clicking **Adopt** fires a `PATCH` to `**/api/mcp/servers`.

Mock the reconcile route in the existing `page.route("**/api/mcp/**", …)` handler (follow the file's current mocking pattern), returning e.g.:

```js
// reconcile mock body
{
  imports: [{
    key: "ctx",
    suggestedSpec: { id: "ctx", name: "ctx", source: { kind: "discovered" },
      transport: "stdio", command: "npx", args: ["-y", "pkg"], env: {}, headers: {}, variants: [] },
    foundIn: [{ harness: "cursor", scope: "global", configPath: "/tmp/cursor.json" }],
    warnings: [],
  }],
  conflicts: [{
    serverId: "context7", harness: "cursor", scope: "global",
    configPath: "/tmp/cursor.json",
    diff: [{ field: "args", expected: "-y a", observed: "-y a --v" }],
    observedSpec: { id: "context7", name: "Context7", source: { kind: "manual" },
      transport: "stdio", command: "npx", args: ["-y", "a", "--v"], env: {}, headers: {}, variants: [] },
  }],
  warnings: [],
}
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:ui`
Expected: FAIL — the new sections/buttons don't exist yet.

- [ ] **Step 3: Switch the data source to reconcile**

In `loadAll` (mcp-servers.js ~146), replace the `discover` fetch with the reconcile endpoint and store the split result:

```js
const [library, statuses, reconcile] = await Promise.all([
  api(withProject("/api/mcp/servers")),
  api(withProject("/api/mcp/servers/status")),
  api(withProject("/api/mcp/servers/reconcile")),
]);
// …
const split = splitReconcile(reconcile);
state.imports = split.imports;
state.conflicts = split.conflicts;
state.reconcileWarnings = split.warnings;
```

Remove the now-unused `state.discovered` assignment. Import `splitReconcile`, `foundInSummary`, `formatDiffValue` from `./mcp-logic.js`.

- [ ] **Step 4: Replace `renderDiscovered` with `renderReconcile`**

Render two sections into the same panel element (`els.discovered`, or rename to `els.reconcile` if the query selector is updated in `index.html` — keep the existing element id to avoid template churn, just change the render body):

- **Section A "Unmanaged servers"** — for each `state.imports` candidate: the `key`, a "Found in: " + `foundInSummary(candidate.foundIn)` line, each `warnings` entry in an amber note, an **Import** button (`data-mcp-import` carrying the candidate index), and — when `matchesLibraryId` is set — an inline hint "looks like **&lt;that server's name&gt;**, already in your library" (resolve the name from `state.library` by id, fall back to the id).
- **Section B "Needs attention"** — for each `state.conflicts` entry: server name (resolve from `state.library`, fall back to `serverId`) + a harness/scope chip, a compact diff table with columns *field · expected · on disk* using `formatDiffValue`, the `trustNote` if present, and two buttons **Reapply library** (`data-mcp-reapply`) and **Adopt into library** (`data-mcp-adopt`), each carrying the conflict index.
- Render `state.reconcileWarnings` as a muted footer note when non-empty.
- Empty state (no imports, no conflicts): `Everything in your harness configs matches your library.`
- Remove the "future update" footer entirely.

- [ ] **Step 5: Wire the three actions (event delegation)**

In the panel's click handler (extend `bindDomEvents`):

- `data-mcp-import`: look up `state.imports[i].suggestedSpec`, open the existing review/add card seeded with it (same entry point the from-URL flow uses to present a draft for confirmation). On confirm, the existing card already POSTs `mcp_add_manual`; after success, call `refreshAll()`.
- `data-mcp-reapply`: confirm dialog, then POST to `/api/mcp/servers/${serverId}/activate` with `{ harness, scope, projectPath }` (mirror the matrix's activate call). On success, `refreshAll()`.
- `data-mcp-adopt`: confirm dialog, then PATCH `/api/mcp/servers` with `{ spec: state.conflicts[i].observedSpec }` (the drift entry already carries `observedSpec` — the library spec with the on-disk invocation merged in — from Task 4). This routes to `mcp_update_server`. On success, `refreshAll()`.

- [ ] **Step 6: Run the UI smoke + full gate**

Run: `npm run test:ui`
Expected: PASS.
Then: `npm test && npm run build && (cd src-tauri && cargo test)`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add public/mcp-servers.js test/ui/mcp-servers.spec.js src-tauri/src/backend/types.rs src-tauri/src/backend/commands.rs
git commit -m "feat(mcp): reconcile panel — import candidates, drift, reapply/adopt"
```

---

## Self-Review

- **Spec coverage:** parse_entry (§3), invocation_eq/diff_invocation (§3.1), mcp_reconcile classification incl. dedup + matchesLibraryId + placeholder warnings (§4), IPC types (§4.1), reuse-existing mutations (§5), two-section panel (§6), error handling via per-target/per-entry warnings (§7), full test matrix (§8) — all mapped to Tasks 1–6.
- **Type consistency:** `ObservedInvocation` (engine.rs) is produced in Task 1 and consumed in Tasks 2/4; `FieldDiff` (reconcile.rs) produced in Task 2, referenced by `McpDriftEntry` in Task 4; `spec_from_observed` signature `(String, String, &ObservedInvocation)` consistent across Tasks 2/4. Frontend `splitReconcile`/`foundInSummary`/`formatDiffValue` produced in Task 5, consumed in Task 6.
- **Adopt dependency resolved in Task 4:** `McpDriftEntry.observed_spec` (library spec + on-disk invocation) ships from `mcp_reconcile`, so Task 6's adopt action is a direct PATCH with no cross-task retrofit.
- **Placeholder scan:** no TBD/TODO; every code step carries complete code or explicit, concrete DOM instructions against named existing entry points.
