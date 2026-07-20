# MCP Server Management Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A canonical MCP-server library plus a table-driven engine that activates/deactivates servers into 7 harnesses' config files (global + project scope), replacing the hand-rolled 3-harness `mcp_register.rs` writers.

**Architecture:** New `backend/mcp/` Rust module: `spec.rs` (library data model + variant resolution), `adapters.rs` (static per-harness descriptor table, mirroring `targets.rs`), `engine.rs` (generic JSON/TOML read-merge-write). New Tauri commands in `commands.rs`. `mcp_register.rs` refactored to call the engine.

**Tech Stack:** Rust (Tauri backend), serde_json, toml_edit, tokio, tempfile (tests). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-mcp-management-phase-a-design.md` — read it first.
- v1 harness ids, exactly: `claude`, `codex`, `cursor`, `opencode`, `gemini`, `copilot`, `kiro`.
- Library file: `<app_home>/mcp/servers.json`, shape `{"servers": [...]}`.
- Every config mutation: backup first (`.skillworks-backup-<timestamp>` sibling, existing pattern), then atomic write (`fs_atomic`).
- Only ever touch our own entry (keyed by spec `id`); preserve all sibling servers and unknown keys. TOML must preserve comments (`toml_edit`).
- All IPC-facing structs: `#[serde(rename_all = "camelCase")]` (codebase convention in `types.rs`).
- Deactivate = remove the entry. Never manage out-of-band enable/disable state.
- Server `id` charset: `^[a-z0-9][a-z0-9-]*$` — validate manually (no regex crate; do not add one).
- Test style: `#[tokio::test]` + `tempfile::TempDir`, as in `mcp_register.rs` tests.
- Run Rust tests from `src-tauri/`: `cargo test <filter>`. Full gate before finishing: `cargo test` + `npm test` + `npm run build` from repo root.
- Commit after every task; conventional-commit messages; no Co-Authored-By lines (user rule).

---

### Task 1: `mcp/spec.rs` — data model, validation, variant resolution, library I/O

**Files:**
- Create: `src-tauri/src/backend/mcp/mod.rs`
- Create: `src-tauri/src/backend/mcp/spec.rs`
- Modify: `src-tauri/src/backend/mod.rs` (add `pub mod mcp;`)

**Interfaces:**
- Produces (used by every later task):
  - `McpTransport` (enum: `Stdio | Http | Sse`, serde lowercase)
  - `McpServerSpec`, `McpVariant`, `McpAppliesTo`, `McpSource` (all serde camelCase)
  - `EffectiveInvocation { transport: McpTransport, command: Option<String>, args: Vec<String>, env: BTreeMap<String,String>, url: Option<String>, headers: BTreeMap<String,String> }`
  - `validate_spec(&McpServerSpec) -> BackendResult<()>`
  - `resolve_effective(&McpServerSpec, harness_id: &str, scope: &str, variant_label: Option<&str>) -> BackendResult<EffectiveInvocation>`
  - `library_path(app_home: &Path) -> PathBuf`
  - `load_library(app_home: &Path) -> BackendResult<Vec<McpServerSpec>>` (missing file → empty vec)
  - `save_library(app_home: &Path, servers: &[McpServerSpec]) -> BackendResult<()>`

- [ ] **Step 1: Create module scaffolding**

`src-tauri/src/backend/mcp/mod.rs`:
```rust
//! MCP server management: canonical library + per-harness config engine.
//!
//! Phase A of the MCP-management feature (see
//! docs/superpowers/specs/2026-07-20-mcp-management-phase-a-design.md).

pub mod spec;
```

In `src-tauri/src/backend/mod.rs`, add `pub mod mcp;` after `pub mod marketplace;` (keep the list alphabetical).

- [ ] **Step 2: Write the failing tests**

Create `spec.rs` with ONLY the test module first (types referenced don't exist yet, so this fails to compile — that is the failing state for a compiled language):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn stdio_spec() -> McpServerSpec {
        McpServerSpec {
            id: "context7".into(),
            name: "Context7".into(),
            description: None,
            source: McpSource { kind: "manual".into(), url: None },
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "@upstash/context7-mcp".into()],
            env: Default::default(),
            url: None,
            headers: Default::default(),
            variants: vec![],
        }
    }

    #[test]
    fn validate_accepts_good_stdio_spec() {
        validate_spec(&stdio_spec()).unwrap();
    }

    #[test]
    fn validate_rejects_bad_ids() {
        for bad in ["", "Has Space", "UPPER", "-leading", "trailing space "] {
            let mut s = stdio_spec();
            s.id = bad.into();
            assert!(validate_spec(&s).is_err(), "id {bad:?} should be rejected");
        }
    }

    #[test]
    fn validate_rejects_transport_field_mismatch() {
        let mut s = stdio_spec();
        s.command = None; // stdio without command
        assert!(validate_spec(&s).is_err());
        let mut s = stdio_spec();
        s.transport = McpTransport::Http; // http without url
        assert!(validate_spec(&s).is_err());
    }

    #[test]
    fn resolve_effective_uses_canonical_without_variants() {
        let inv = resolve_effective(&stdio_spec(), "claude", "global", None).unwrap();
        assert_eq!(inv.command.as_deref(), Some("npx"));
        assert_eq!(inv.transport, McpTransport::Stdio);
    }

    #[test]
    fn resolve_effective_prefers_explicit_label_then_applies_to() {
        let mut s = stdio_spec();
        s.variants = vec![
            McpVariant {
                label: "http".into(),
                applies_to: None,
                transport: Some(McpTransport::Http),
                command: None, args: None, env: None,
                url: Some("https://mcp.context7.com/mcp".into()),
                headers: None,
            },
            McpVariant {
                label: "codex-tweak".into(),
                applies_to: Some(McpAppliesTo { harness: Some("codex".into()), scope: None }),
                transport: None,
                command: None,
                args: Some(vec!["-y".into(), "@upstash/context7-mcp".into(), "--codex".into()]),
                env: None, url: None, headers: None,
            },
        ];
        // Explicit label wins.
        let inv = resolve_effective(&s, "claude", "global", Some("http")).unwrap();
        assert_eq!(inv.transport, McpTransport::Http);
        assert_eq!(inv.url.as_deref(), Some("https://mcp.context7.com/mcp"));
        // applies_to match auto-selects for codex...
        let inv = resolve_effective(&s, "codex", "global", None).unwrap();
        assert_eq!(inv.args.last().map(String::as_str), Some("--codex"));
        // ...but not for cursor (falls back to canonical).
        let inv = resolve_effective(&s, "cursor", "global", None).unwrap();
        assert_eq!(inv.args.last().map(String::as_str), Some("@upstash/context7-mcp"));
        // Unknown label errors.
        assert!(resolve_effective(&s, "claude", "global", Some("nope")).is_err());
    }

    #[test]
    fn resolve_effective_scores_harness_and_scope() {
        let mut s = stdio_spec();
        s.variants = vec![
            McpVariant {
                label: "scope-only".into(),
                applies_to: Some(McpAppliesTo { harness: None, scope: Some("project".into()) }),
                transport: None, command: None,
                args: Some(vec!["scope".into()]),
                env: None, url: None, headers: None,
            },
            McpVariant {
                label: "both".into(),
                applies_to: Some(McpAppliesTo { harness: Some("claude".into()), scope: Some("project".into()) }),
                transport: None, command: None,
                args: Some(vec!["both".into()]),
                env: None, url: None, headers: None,
            },
        ];
        // Full match beats partial.
        let inv = resolve_effective(&s, "claude", "project", None).unwrap();
        assert_eq!(inv.args, vec!["both".to_string()]);
        // A variant whose Some-field mismatches is skipped entirely.
        let inv = resolve_effective(&s, "gemini", "project", None).unwrap();
        assert_eq!(inv.args, vec!["scope".to_string()]);
        let inv = resolve_effective(&s, "gemini", "global", None).unwrap();
        assert_eq!(inv.args, vec!["-y".to_string(), "@upstash/context7-mcp".to_string()]);
    }

    #[tokio::test]
    async fn library_round_trip_and_missing_file() {
        let dir = TempDir::new().unwrap();
        assert!(load_library(dir.path()).await.unwrap().is_empty());
        let servers = vec![stdio_spec()];
        save_library(dir.path(), &servers).await.unwrap();
        let loaded = load_library(dir.path()).await.unwrap();
        assert_eq!(loaded, servers);
        assert!(library_path(dir.path()).ends_with("mcp/servers.json"));
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test backend::mcp::spec 2>&1 | tail -5`
Expected: compile error (`McpServerSpec` not found).

- [ ] **Step 4: Implement the module above the test block**

```rust
//! Canonical MCP server library: harness-agnostic specs, variants, and
//! the on-disk library at `<app_home>/mcp/servers.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use super::super::fs_atomic::write_json_atomic;
use super::super::state::{BackendError, BackendResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSource {
    pub kind: String, // "url" | "manual" | "discovered"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppliesTo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>, // "global" | "project"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpVariant {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applies_to: Option<McpAppliesTo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSpec {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: McpSource,
    pub transport: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub variants: Vec<McpVariant>,
}

/// A fully-resolved invocation (canonical spec + selected variant overlay).
/// This is what the engine translates into a harness dialect.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveInvocation {
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn check_transport_fields(
    transport: McpTransport,
    command: &Option<String>,
    url: &Option<String>,
    context: &str,
) -> BackendResult<()> {
    match transport {
        McpTransport::Stdio if command.as_deref().unwrap_or("").is_empty() => {
            Err(BackendError::Validation(format!(
                "{context}: stdio transport requires a command"
            )))
        }
        McpTransport::Http | McpTransport::Sse
            if url.as_deref().unwrap_or("").is_empty() =>
        {
            Err(BackendError::Validation(format!(
                "{context}: {} transport requires a url",
                if transport == McpTransport::Http { "http" } else { "sse" }
            )))
        }
        _ => Ok(()),
    }
}

pub fn validate_spec(spec: &McpServerSpec) -> BackendResult<()> {
    if !valid_id(&spec.id) {
        return Err(BackendError::Validation(format!(
            "Invalid server id {:?}: must match ^[a-z0-9][a-z0-9-]*$",
            spec.id
        )));
    }
    if spec.name.trim().is_empty() {
        return Err(BackendError::Validation("Server name is required".into()));
    }
    check_transport_fields(spec.transport, &spec.command, &spec.url, &spec.id)
}

/// Pick the variant for a target: explicit label > best `applies_to` match
/// (harness match scores 2, scope match scores 1; every `Some` field must
/// match or the variant is skipped) > canonical fields.
pub fn resolve_effective(
    spec: &McpServerSpec,
    harness_id: &str,
    scope: &str,
    variant_label: Option<&str>,
) -> BackendResult<EffectiveInvocation> {
    let variant: Option<&McpVariant> = match variant_label {
        Some(label) => Some(
            spec.variants
                .iter()
                .find(|v| v.label == label)
                .ok_or_else(|| {
                    BackendError::NotFound(format!(
                        "Variant {label:?} not found on server {:?}",
                        spec.id
                    ))
                })?,
        ),
        None => spec
            .variants
            .iter()
            .filter_map(|v| {
                let applies = v.applies_to.as_ref()?;
                let mut score = 0;
                if let Some(h) = &applies.harness {
                    if h != harness_id {
                        return None;
                    }
                    score += 2;
                }
                if let Some(s) = &applies.scope {
                    if s != scope {
                        return None;
                    }
                    score += 1;
                }
                (score > 0).then_some((score, v))
            })
            .max_by_key(|(score, _)| *score)
            .map(|(_, v)| v),
    };

    let mut inv = EffectiveInvocation {
        transport: spec.transport,
        command: spec.command.clone(),
        args: spec.args.clone(),
        env: spec.env.clone(),
        url: spec.url.clone(),
        headers: spec.headers.clone(),
    };
    if let Some(v) = variant {
        if let Some(t) = v.transport {
            inv.transport = t;
        }
        if let Some(c) = &v.command {
            inv.command = Some(c.clone());
        }
        if let Some(a) = &v.args {
            inv.args = a.clone();
        }
        if let Some(e) = &v.env {
            inv.env = e.clone();
        }
        if let Some(u) = &v.url {
            inv.url = Some(u.clone());
        }
        if let Some(h) = &v.headers {
            inv.headers = h.clone();
        }
    }
    check_transport_fields(inv.transport, &inv.command, &inv.url, &spec.id)?;
    Ok(inv)
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LibraryFile {
    #[serde(default)]
    servers: Vec<McpServerSpec>,
}

pub fn library_path(app_home: &Path) -> PathBuf {
    app_home.join("mcp").join("servers.json")
}

pub async fn load_library(app_home: &Path) -> BackendResult<Vec<McpServerSpec>> {
    let path = library_path(app_home);
    match fs::read(&path).await {
        Ok(bytes) => {
            let file: LibraryFile = serde_json::from_slice(&bytes)?;
            Ok(file.servers)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(BackendError::Io(err)),
    }
}

pub async fn save_library(app_home: &Path, servers: &[McpServerSpec]) -> BackendResult<()> {
    let path = library_path(app_home);
    write_json_atomic(&path, &LibraryFile { servers: servers.to_vec() }).await
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test backend::mcp::spec 2>&1 | tail -5`
Expected: `test result: ok. 7 passed`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backend/mod.rs src-tauri/src/backend/mcp/
git commit -m "feat(mcp): canonical server spec, variant resolution, library I/O"
```

---

### Task 2: `mcp/adapters.rs` — the 7-harness descriptor table

**Files:**
- Create: `src-tauri/src/backend/mcp/adapters.rs`
- Modify: `src-tauri/src/backend/mcp/mod.rs` (add `pub mod adapters;`)

**Interfaces:**
- Produces:
  - `ConfigFormat` (`Json | Toml`), `CommandStyle` (`SeparateArgs | ArgvArray`), `Discriminator` (`None | ClaudeTypes | OpenCodeTypes | CopilotTypes`), `RemoteUrlField` (`Url | GeminiSplit`)
  - `McpAdapter { harness_id, label, format, global_path_parts, project_path_parts, key_path, command_style, env_field, discriminator, remote_url_field, project_trust_note }` (all `&'static`)
  - `adapters() -> &'static [McpAdapter]`
  - `adapter_for(harness_id: &str) -> BackendResult<&'static McpAdapter>`
  - `config_path_for(adapter: &McpAdapter, scope: &str, home_dir: &Path, project_root: Option<&Path>) -> BackendResult<PathBuf>`

- [ ] **Step 1: Write the failing tests**

Create `adapters.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn table_covers_the_v1_seven() {
        let ids: Vec<&str> = adapters().iter().map(|a| a.harness_id).collect();
        assert_eq!(
            ids,
            vec!["claude", "codex", "cursor", "opencode", "gemini", "copilot", "kiro"]
        );
    }

    #[test]
    fn adapter_for_rejects_unknown() {
        assert!(adapter_for("emacs").is_err());
        assert_eq!(adapter_for("claude").unwrap().harness_id, "claude");
    }

    #[test]
    fn paths_resolve_against_home_and_project() {
        let home = Path::new("/home/u");
        let proj = Path::new("/repo");
        let cases = [
            ("claude", "/home/u/.claude.json", "/repo/.mcp.json"),
            ("codex", "/home/u/.codex/config.toml", "/repo/.codex/config.toml"),
            ("cursor", "/home/u/.cursor/mcp.json", "/repo/.cursor/mcp.json"),
            ("opencode", "/home/u/.config/opencode/opencode.json", "/repo/opencode.json"),
            ("gemini", "/home/u/.gemini/settings.json", "/repo/.gemini/settings.json"),
            ("copilot", "/home/u/.copilot/mcp-config.json", "/repo/.mcp.json"),
            ("kiro", "/home/u/.kiro/settings/mcp.json", "/repo/.kiro/settings/mcp.json"),
        ];
        for (id, global, project) in cases {
            let a = adapter_for(id).unwrap();
            assert_eq!(
                config_path_for(a, "global", home, None).unwrap(),
                Path::new(global),
                "{id} global"
            );
            assert_eq!(
                config_path_for(a, "project", home, Some(proj)).unwrap(),
                Path::new(project),
                "{id} project"
            );
        }
    }

    #[test]
    fn project_scope_requires_project_root() {
        let a = adapter_for("claude").unwrap();
        assert!(config_path_for(a, "project", Path::new("/h"), None).is_err());
        assert!(config_path_for(a, "weird-scope", Path::new("/h"), None).is_err());
    }

    #[test]
    fn trust_notes_and_formats() {
        assert!(adapter_for("claude").unwrap().project_trust_note);
        assert!(adapter_for("codex").unwrap().project_trust_note);
        assert!(!adapter_for("cursor").unwrap().project_trust_note);
        assert_eq!(adapter_for("codex").unwrap().format, ConfigFormat::Toml);
        assert_eq!(adapter_for("opencode").unwrap().env_field, "environment");
        assert_eq!(adapter_for("opencode").unwrap().key_path, &["mcp"]);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test backend::mcp::adapters 2>&1 | tail -5`
Expected: compile error (`adapters` not found).

- [ ] **Step 3: Implement above the tests**

```rust
//! Per-harness MCP config descriptors — the data table that drives
//! `engine.rs`. Mirrors the style of `targets.rs::HARNESS_TARGETS`.
//! Sources: research 2026-07-20, see the Phase A spec §4.

use std::path::{Path, PathBuf};

use super::super::state::{BackendError, BackendResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFormat {
    Json,
    Toml,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandStyle {
    /// `"command": "npx", "args": [...]`
    SeparateArgs,
    /// OpenCode: `"command": ["npx", ...args]`
    ArgvArray,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Discriminator {
    /// No `type` field; harness infers transport from `command` vs `url`.
    None,
    /// Claude Code: `type: "stdio" | "http" | "sse"`.
    ClaudeTypes,
    /// OpenCode: `type: "local" | "remote"` (+ `enabled: true`).
    OpenCodeTypes,
    /// Copilot CLI: `type: "local" | "http" | "sse"`.
    CopilotTypes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteUrlField {
    /// `url` for both http and sse.
    Url,
    /// Gemini: `httpUrl` for streamable-http, `url` for sse.
    GeminiSplit,
}

#[derive(Debug)]
pub struct McpAdapter {
    pub harness_id: &'static str,
    pub label: &'static str,
    pub format: ConfigFormat,
    pub global_path_parts: &'static [&'static str],
    pub project_path_parts: &'static [&'static str],
    pub key_path: &'static [&'static str],
    pub command_style: CommandStyle,
    pub env_field: &'static str,
    pub discriminator: Discriminator,
    pub remote_url_field: RemoteUrlField,
    pub project_trust_note: bool,
}

static ADAPTERS: &[McpAdapter] = &[
    McpAdapter {
        harness_id: "claude",
        label: "Claude Code",
        format: ConfigFormat::Json,
        global_path_parts: &[".claude.json"],
        project_path_parts: &[".mcp.json"],
        key_path: &["mcpServers"],
        command_style: CommandStyle::SeparateArgs,
        env_field: "env",
        discriminator: Discriminator::ClaudeTypes,
        remote_url_field: RemoteUrlField::Url,
        project_trust_note: true,
    },
    McpAdapter {
        harness_id: "codex",
        label: "Codex",
        format: ConfigFormat::Toml,
        global_path_parts: &[".codex", "config.toml"],
        project_path_parts: &[".codex", "config.toml"],
        key_path: &["mcp_servers"],
        command_style: CommandStyle::SeparateArgs,
        env_field: "env",
        discriminator: Discriminator::None,
        remote_url_field: RemoteUrlField::Url,
        project_trust_note: true,
    },
    McpAdapter {
        harness_id: "cursor",
        label: "Cursor",
        format: ConfigFormat::Json,
        global_path_parts: &[".cursor", "mcp.json"],
        project_path_parts: &[".cursor", "mcp.json"],
        key_path: &["mcpServers"],
        command_style: CommandStyle::SeparateArgs,
        env_field: "env",
        discriminator: Discriminator::None,
        remote_url_field: RemoteUrlField::Url,
        project_trust_note: false,
    },
    McpAdapter {
        harness_id: "opencode",
        label: "OpenCode",
        format: ConfigFormat::Json,
        global_path_parts: &[".config", "opencode", "opencode.json"],
        project_path_parts: &["opencode.json"],
        key_path: &["mcp"],
        command_style: CommandStyle::ArgvArray,
        env_field: "environment",
        discriminator: Discriminator::OpenCodeTypes,
        remote_url_field: RemoteUrlField::Url,
        project_trust_note: false,
    },
    McpAdapter {
        harness_id: "gemini",
        label: "Gemini CLI",
        format: ConfigFormat::Json,
        global_path_parts: &[".gemini", "settings.json"],
        project_path_parts: &[".gemini", "settings.json"],
        key_path: &["mcpServers"],
        command_style: CommandStyle::SeparateArgs,
        env_field: "env",
        discriminator: Discriminator::None,
        remote_url_field: RemoteUrlField::GeminiSplit,
        project_trust_note: false,
    },
    McpAdapter {
        harness_id: "copilot",
        label: "Copilot CLI",
        format: ConfigFormat::Json,
        global_path_parts: &[".copilot", "mcp-config.json"],
        project_path_parts: &[".mcp.json"],
        key_path: &["mcpServers"],
        command_style: CommandStyle::SeparateArgs,
        env_field: "env",
        discriminator: Discriminator::CopilotTypes,
        remote_url_field: RemoteUrlField::Url,
        project_trust_note: false,
    },
    McpAdapter {
        harness_id: "kiro",
        label: "Kiro",
        format: ConfigFormat::Json,
        global_path_parts: &[".kiro", "settings", "mcp.json"],
        project_path_parts: &[".kiro", "settings", "mcp.json"],
        key_path: &["mcpServers"],
        command_style: CommandStyle::SeparateArgs,
        env_field: "env",
        discriminator: Discriminator::None,
        remote_url_field: RemoteUrlField::Url,
        project_trust_note: false,
    },
];

pub fn adapters() -> &'static [McpAdapter] {
    ADAPTERS
}

pub fn adapter_for(harness_id: &str) -> BackendResult<&'static McpAdapter> {
    ADAPTERS
        .iter()
        .find(|a| a.harness_id == harness_id)
        .ok_or_else(|| {
            BackendError::Validation(format!("Unsupported MCP harness: {harness_id}"))
        })
}

pub fn config_path_for(
    adapter: &McpAdapter,
    scope: &str,
    home_dir: &Path,
    project_root: Option<&Path>,
) -> BackendResult<PathBuf> {
    let (base, parts): (&Path, &[&str]) = match scope {
        "global" => (home_dir, adapter.global_path_parts),
        "project" => {
            let root = project_root.ok_or_else(|| {
                BackendError::Validation(
                    "Project scope requires an active project".to_string(),
                )
            })?;
            (root, adapter.project_path_parts)
        }
        other => {
            return Err(BackendError::Validation(format!(
                "Unknown scope: {other} (expected \"global\" or \"project\")"
            )))
        }
    };
    let mut path = base.to_path_buf();
    for part in parts {
        path.push(part);
    }
    Ok(path)
}
```

Add `pub mod adapters;` to `mcp/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test backend::mcp::adapters 2>&1 | tail -5`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backend/mcp/
git commit -m "feat(mcp): per-harness adapter descriptor table for the v1 seven"
```

---

### Task 3: `mcp/engine.rs` — canonical→dialect rendering (pure functions)

**Files:**
- Create: `src-tauri/src/backend/mcp/engine.rs`
- Modify: `src-tauri/src/backend/mcp/mod.rs` (add `pub mod engine;`)

**Interfaces:**
- Consumes: `McpAdapter` fields (Task 2), `EffectiveInvocation`, `McpTransport` (Task 1).
- Produces:
  - `render_entry_json(adapter: &McpAdapter, inv: &EffectiveInvocation) -> serde_json::Value` — used for all 6 JSON harnesses
  - `render_entry_toml(inv: &EffectiveInvocation) -> toml_edit::Table` — Codex

- [ ] **Step 1: Write the failing tests**

Create `engine.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mcp::adapters::adapter_for;
    use crate::backend::mcp::spec::{EffectiveInvocation, McpTransport};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn stdio_inv() -> EffectiveInvocation {
        EffectiveInvocation {
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "pkg".into()],
            env: BTreeMap::from([("K".to_string(), "V".to_string())]),
            url: None,
            headers: BTreeMap::new(),
        }
    }

    fn http_inv() -> EffectiveInvocation {
        EffectiveInvocation {
            transport: McpTransport::Http,
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some("https://x.example/mcp".into()),
            headers: BTreeMap::from([("Authorization".to_string(), "Bearer t".to_string())]),
        }
    }

    #[test]
    fn claude_dialect() {
        let a = adapter_for("claude").unwrap();
        assert_eq!(
            render_entry_json(a, &stdio_inv()),
            json!({"type": "stdio", "command": "npx", "args": ["-y", "pkg"], "env": {"K": "V"}})
        );
        assert_eq!(
            render_entry_json(a, &http_inv()),
            json!({"type": "http", "url": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}})
        );
    }

    #[test]
    fn cursor_kiro_implicit_dialect() {
        for id in ["cursor", "kiro"] {
            let a = adapter_for(id).unwrap();
            assert_eq!(
                render_entry_json(a, &stdio_inv()),
                json!({"command": "npx", "args": ["-y", "pkg"], "env": {"K": "V"}}),
                "{id}"
            );
            assert_eq!(
                render_entry_json(a, &http_inv()),
                json!({"url": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}}),
                "{id}"
            );
        }
    }

    #[test]
    fn opencode_dialect_argv_environment_enabled() {
        let a = adapter_for("opencode").unwrap();
        assert_eq!(
            render_entry_json(a, &stdio_inv()),
            json!({"type": "local", "command": ["npx", "-y", "pkg"], "environment": {"K": "V"}, "enabled": true})
        );
        assert_eq!(
            render_entry_json(a, &http_inv()),
            json!({"type": "remote", "url": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}, "enabled": true})
        );
    }

    #[test]
    fn gemini_dialect_splits_remote_url_field() {
        let a = adapter_for("gemini").unwrap();
        assert_eq!(
            render_entry_json(a, &http_inv()),
            json!({"httpUrl": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}})
        );
        let mut sse = http_inv();
        sse.transport = McpTransport::Sse;
        assert_eq!(
            render_entry_json(a, &sse),
            json!({"url": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}})
        );
    }

    #[test]
    fn copilot_dialect_types() {
        let a = adapter_for("copilot").unwrap();
        assert_eq!(render_entry_json(a, &stdio_inv())["type"], "local");
        assert_eq!(render_entry_json(a, &http_inv())["type"], "http");
    }

    #[test]
    fn empty_env_and_headers_are_omitted() {
        let a = adapter_for("claude").unwrap();
        let mut inv = stdio_inv();
        inv.env.clear();
        let v = render_entry_json(a, &inv);
        assert!(v.get("env").is_none());
        let mut r = http_inv();
        r.headers.clear();
        let v = render_entry_json(a, &r);
        assert!(v.get("headers").is_none());
    }

    #[test]
    fn codex_toml_dialect() {
        let t = render_entry_toml(&stdio_inv());
        assert_eq!(t["command"].as_str(), Some("npx"));
        assert_eq!(t["args"].as_array().unwrap().len(), 2);
        assert_eq!(t["env"]["K"].as_str(), Some("V"));
        let t = render_entry_toml(&http_inv());
        assert_eq!(t["url"].as_str(), Some("https://x.example/mcp"));
        assert_eq!(t["http_headers"]["Authorization"].as_str(), Some("Bearer t"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test backend::mcp::engine 2>&1 | tail -5`
Expected: compile error (`render_entry_json` not found).

- [ ] **Step 3: Implement the render functions**

```rust
//! Generic MCP config engine: canonical invocation → harness dialect, plus
//! (Task 4/5) file-level read/insert/remove for JSON and TOML configs.

use serde_json::{json, Value};

use super::adapters::{CommandStyle, Discriminator, McpAdapter, RemoteUrlField};
use super::spec::{EffectiveInvocation, McpTransport};

fn discriminator_value(d: Discriminator, transport: McpTransport) -> Option<&'static str> {
    match (d, transport) {
        (Discriminator::None, _) => None,
        (Discriminator::ClaudeTypes, McpTransport::Stdio) => Some("stdio"),
        (Discriminator::ClaudeTypes, McpTransport::Http) => Some("http"),
        (Discriminator::ClaudeTypes, McpTransport::Sse) => Some("sse"),
        (Discriminator::OpenCodeTypes, McpTransport::Stdio) => Some("local"),
        (Discriminator::OpenCodeTypes, _) => Some("remote"),
        (Discriminator::CopilotTypes, McpTransport::Stdio) => Some("local"),
        (Discriminator::CopilotTypes, McpTransport::Http) => Some("http"),
        (Discriminator::CopilotTypes, McpTransport::Sse) => Some("sse"),
    }
}

/// Render one server entry in the dialect of a JSON-format harness.
pub fn render_entry_json(adapter: &McpAdapter, inv: &EffectiveInvocation) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(t) = discriminator_value(adapter.discriminator, inv.transport) {
        obj.insert("type".into(), json!(t));
    }
    match inv.transport {
        McpTransport::Stdio => {
            let command = inv.command.clone().unwrap_or_default();
            match adapter.command_style {
                CommandStyle::SeparateArgs => {
                    obj.insert("command".into(), json!(command));
                    obj.insert("args".into(), json!(inv.args));
                }
                CommandStyle::ArgvArray => {
                    let mut argv = vec![command];
                    argv.extend(inv.args.iter().cloned());
                    obj.insert("command".into(), json!(argv));
                }
            }
            if !inv.env.is_empty() {
                obj.insert(adapter.env_field.into(), json!(inv.env));
            }
        }
        McpTransport::Http | McpTransport::Sse => {
            let url_key = match (adapter.remote_url_field, inv.transport) {
                (RemoteUrlField::GeminiSplit, McpTransport::Http) => "httpUrl",
                _ => "url",
            };
            obj.insert(url_key.into(), json!(inv.url.clone().unwrap_or_default()));
            if !inv.headers.is_empty() {
                obj.insert("headers".into(), json!(inv.headers));
            }
        }
    }
    if adapter.discriminator == Discriminator::OpenCodeTypes {
        obj.insert("enabled".into(), json!(true));
    }
    Value::Object(obj)
}

/// Render one server entry as a Codex `[mcp_servers.<id>]` table.
pub fn render_entry_toml(inv: &EffectiveInvocation) -> toml_edit::Table {
    let mut entry = toml_edit::Table::new();
    match inv.transport {
        McpTransport::Stdio => {
            entry["command"] = toml_edit::value(inv.command.clone().unwrap_or_default());
            let mut args = toml_edit::Array::new();
            for arg in &inv.args {
                args.push(arg.clone());
            }
            entry["args"] = toml_edit::value(args);
            if !inv.env.is_empty() {
                let mut env = toml_edit::Table::new();
                for (k, v) in &inv.env {
                    env[k.as_str()] = toml_edit::value(v.clone());
                }
                entry["env"] = toml_edit::Item::Table(env);
            }
        }
        McpTransport::Http | McpTransport::Sse => {
            entry["url"] = toml_edit::value(inv.url.clone().unwrap_or_default());
            if !inv.headers.is_empty() {
                let mut headers = toml_edit::InlineTable::new();
                for (k, v) in &inv.headers {
                    headers.insert(k, v.clone().into());
                }
                entry["http_headers"] = toml_edit::value(headers);
            }
        }
    }
    entry
}
```

Add `pub mod engine;` to `mcp/mod.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test backend::mcp::engine 2>&1 | tail -5`
Expected: `test result: ok. 7 passed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backend/mcp/
git commit -m "feat(mcp): canonical-to-dialect entry rendering for all v1 harnesses"
```

---

### Task 4: engine file operations (JSON + TOML read/insert/remove)

**Files:**
- Modify: `src-tauri/src/backend/fs_atomic.rs` (move `backup_existing` here, make `pub`)
- Modify: `src-tauri/src/backend/mcp_register.rs` (import `backup_existing` from `fs_atomic` instead of its private copy; delete the private fn)
- Modify: `src-tauri/src/backend/mcp/engine.rs`

**Interfaces:**
- Consumes: `render_entry_json` / `render_entry_toml` (Task 3), `config_path_for` (Task 2).
- Produces:
  - `pub async fn backup_existing(path: &Path) -> BackendResult<Option<PathBuf>>` (now in `fs_atomic`)
  - `write_entry(path: &Path, adapter: &McpAdapter, id: &str, inv: &EffectiveInvocation) -> BackendResult<()>`
  - `remove_entry(path: &Path, adapter: &McpAdapter, id: &str) -> BackendResult<bool>` (true = removed)
  - `read_entries(path: &Path, adapter: &McpAdapter) -> BackendResult<Vec<(String, serde_json::Value)>>` (TOML values converted to JSON; missing file → empty)

- [ ] **Step 1: Move `backup_existing` into `fs_atomic.rs`**

Cut the `backup_existing` fn (and its `chrono::Utc` import need) from `mcp_register.rs` into `fs_atomic.rs` verbatim, marked `pub`. In `mcp_register.rs` add `use super::fs_atomic::backup_existing;`.

Run: `cd src-tauri && cargo test mcp_register 2>&1 | tail -3`
Expected: existing tests still pass (`ok`).

- [ ] **Step 2: Write the failing tests (append to `engine.rs` tests module)**

```rust
    use tempfile::TempDir;
    use tokio::fs;

    #[tokio::test]
    async fn json_write_read_remove_preserves_siblings() {
        let dir = TempDir::new().unwrap();
        let a = adapter_for("cursor").unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(&path, r#"{"mcpServers":{"other":{"command":"x"}},"custom":1}"#)
            .await
            .unwrap();

        write_entry(&path, a, "context7", &stdio_inv()).await.unwrap();
        // Idempotent re-write.
        write_entry(&path, a, "context7", &stdio_inv()).await.unwrap();

        let entries = read_entries(&path, a).await.unwrap();
        let ids: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
        assert!(ids.contains(&"other") && ids.contains(&"context7"));
        assert_eq!(entries.len(), 2);

        // Unknown top-level keys survive.
        let doc: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(doc["custom"], 1);

        assert!(remove_entry(&path, a, "context7").await.unwrap());
        assert!(!remove_entry(&path, a, "context7").await.unwrap()); // second time: nothing to do
        let entries = read_entries(&path, a).await.unwrap();
        assert_eq!(entries.len(), 1, "sibling kept after remove");
    }

    #[tokio::test]
    async fn json_write_creates_missing_file_and_dirs() {
        let dir = TempDir::new().unwrap();
        let a = adapter_for("kiro").unwrap();
        let path = dir.path().join(".kiro/settings/mcp.json");
        write_entry(&path, a, "s1", &stdio_inv()).await.unwrap();
        let entries = read_entries(&path, a).await.unwrap();
        assert_eq!(entries[0].0, "s1");
    }

    #[tokio::test]
    async fn json_malformed_config_is_error_not_clobber() {
        let dir = TempDir::new().unwrap();
        let a = adapter_for("cursor").unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(&path, "{ not json").await.unwrap();
        assert!(write_entry(&path, a, "s1", &stdio_inv()).await.is_err());
        assert_eq!(fs::read_to_string(&path).await.unwrap(), "{ not json");
    }

    #[tokio::test]
    async fn json_mutation_writes_backup() {
        let dir = TempDir::new().unwrap();
        let a = adapter_for("cursor").unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(&path, r#"{"mcpServers":{}}"#).await.unwrap();
        write_entry(&path, a, "s1", &stdio_inv()).await.unwrap();
        let mut found_backup = false;
        let mut rd = fs::read_dir(dir.path()).await.unwrap();
        while let Some(e) = rd.next_entry().await.unwrap() {
            if e.file_name().to_string_lossy().contains(".skillworks-backup-") {
                found_backup = true;
            }
        }
        assert!(found_backup);
    }

    #[tokio::test]
    async fn toml_write_read_remove_preserves_comments() {
        let dir = TempDir::new().unwrap();
        let a = adapter_for("codex").unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "# keep me\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n")
            .await
            .unwrap();

        write_entry(&path, a, "context7", &stdio_inv()).await.unwrap();
        write_entry(&path, a, "context7", &stdio_inv()).await.unwrap(); // idempotent

        let text = fs::read_to_string(&path).await.unwrap();
        assert!(text.contains("# keep me"));
        assert!(text.contains("[mcp_servers.other]"));
        assert!(text.contains("[mcp_servers.context7]"));

        let entries = read_entries(&path, a).await.unwrap();
        assert_eq!(entries.len(), 2);
        let ctx = &entries.iter().find(|(k, _)| k == "context7").unwrap().1;
        assert_eq!(ctx["command"], "npx");

        assert!(remove_entry(&path, a, "context7").await.unwrap());
        let text = fs::read_to_string(&path).await.unwrap();
        assert!(text.contains("[mcp_servers.other]"));
        assert!(!text.contains("context7"));
    }

    #[tokio::test]
    async fn read_entries_missing_file_is_empty() {
        let dir = TempDir::new().unwrap();
        let a = adapter_for("claude").unwrap();
        let entries = read_entries(&dir.path().join("nope.json"), a).await.unwrap();
        assert!(entries.is_empty());
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test backend::mcp::engine 2>&1 | tail -5`
Expected: compile error (`write_entry` not found).

- [ ] **Step 4: Implement the file operations in `engine.rs`**

```rust
use std::path::Path;

use tokio::fs;

use super::super::fs_atomic::{backup_existing, write_bytes_atomic, write_json_atomic};
use super::super::state::{BackendError, BackendResult};
use super::adapters::ConfigFormat;

async fn read_json_doc(path: &Path) -> BackendResult<serde_json::Map<String, Value>> {
    match fs::read(path).await {
        Ok(bytes) => {
            if bytes.iter().all(|b| b.is_ascii_whitespace()) {
                return Ok(serde_json::Map::new());
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                BackendError::Validation(format!("Invalid JSON in {}: {e}", path.display()))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(BackendError::Validation(format!(
                    "Config is not a JSON object: {}",
                    path.display()
                ))),
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(err) => Err(BackendError::Io(err)),
    }
}

async fn read_toml_doc(path: &Path) -> BackendResult<toml_edit::DocumentMut> {
    match fs::read_to_string(path).await {
        Ok(text) => text.parse::<toml_edit::DocumentMut>().map_err(|e| {
            BackendError::Validation(format!("Invalid TOML in {}: {e}", path.display()))
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(toml_edit::DocumentMut::new())
        }
        Err(err) => Err(BackendError::Io(err)),
    }
}

/// Walk `adapter.key_path` in a JSON doc, creating objects as needed, and
/// return the servers map.
fn json_servers_mut<'a>(
    doc: &'a mut serde_json::Map<String, Value>,
    key_path: &[&str],
) -> BackendResult<&'a mut serde_json::Map<String, Value>> {
    let mut current = doc;
    for key in key_path {
        let entry = current
            .entry(key.to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        current = entry.as_object_mut().ok_or_else(|| {
            BackendError::Validation(format!("Config key {key:?} is not an object"))
        })?;
    }
    Ok(current)
}

fn toml_item_to_json(item: &toml_edit::Item) -> Value {
    if let Some(v) = item.as_str() {
        return json!(v);
    }
    if let Some(v) = item.as_bool() {
        return json!(v);
    }
    if let Some(v) = item.as_integer() {
        return json!(v);
    }
    if let Some(arr) = item.as_array() {
        return Value::Array(
            arr.iter()
                .map(|v| match v.as_str() {
                    Some(s) => json!(s),
                    None => json!(v.to_string()),
                })
                .collect(),
        );
    }
    if let Some(t) = item.as_table_like() {
        let mut map = serde_json::Map::new();
        for (k, v) in t.iter() {
            map.insert(k.to_string(), toml_item_to_json(v));
        }
        return Value::Object(map);
    }
    json!(item.to_string())
}

/// Insert/replace only `id` in the config at `path`, creating file/dirs as
/// needed. Backs up an existing file before writing atomically.
pub async fn write_entry(
    path: &Path,
    adapter: &McpAdapter,
    id: &str,
    inv: &EffectiveInvocation,
) -> BackendResult<()> {
    match adapter.format {
        ConfigFormat::Json => {
            let mut doc = read_json_doc(path).await?;
            let servers = json_servers_mut(&mut doc, adapter.key_path)?;
            servers.insert(id.to_string(), render_entry_json(adapter, inv));
            backup_existing(path).await?;
            write_json_atomic(path, &Value::Object(doc)).await
        }
        ConfigFormat::Toml => {
            let mut doc = read_toml_doc(path).await?;
            let root_key = adapter.key_path[0];
            if !doc.contains_key(root_key) {
                doc[root_key] = toml_edit::Item::Table(toml_edit::Table::new());
            }
            let servers = doc[root_key].as_table_mut().ok_or_else(|| {
                BackendError::Validation(format!("{root_key} is not a table"))
            })?;
            servers.insert(id, toml_edit::Item::Table(render_entry_toml(inv)));
            backup_existing(path).await?;
            write_bytes_atomic(path, doc.to_string().as_bytes()).await
        }
    }
}

/// Remove only `id`. Returns true when an entry was actually removed.
pub async fn remove_entry(
    path: &Path,
    adapter: &McpAdapter,
    id: &str,
) -> BackendResult<bool> {
    if !fs::try_exists(path).await.unwrap_or(false) {
        return Ok(false);
    }
    match adapter.format {
        ConfigFormat::Json => {
            let mut doc = read_json_doc(path).await?;
            let mut current: Option<&mut serde_json::Map<String, Value>> = Some(&mut doc);
            for key in adapter.key_path {
                current = current
                    .and_then(|m| m.get_mut(*key))
                    .and_then(|v| v.as_object_mut());
            }
            let removed = current.map(|m| m.remove(id).is_some()).unwrap_or(false);
            if removed {
                backup_existing(path).await?;
                write_json_atomic(path, &Value::Object(doc)).await?;
            }
            Ok(removed)
        }
        ConfigFormat::Toml => {
            let mut doc = read_toml_doc(path).await?;
            let removed = doc
                .get_mut(adapter.key_path[0])
                .and_then(|i| i.as_table_mut())
                .map(|t| t.remove(id).is_some())
                .unwrap_or(false);
            if removed {
                backup_existing(path).await?;
                write_bytes_atomic(path, doc.to_string().as_bytes()).await?;
            }
            Ok(removed)
        }
    }
}

/// List (id, entry-as-json) pairs in a config. Missing file → empty.
pub async fn read_entries(
    path: &Path,
    adapter: &McpAdapter,
) -> BackendResult<Vec<(String, Value)>> {
    match adapter.format {
        ConfigFormat::Json => {
            let doc = read_json_doc(path).await?;
            let mut current: Option<&serde_json::Map<String, Value>> = Some(&doc);
            for key in adapter.key_path {
                current = current
                    .and_then(|m| m.get(*key))
                    .and_then(|v| v.as_object());
            }
            Ok(current
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default())
        }
        ConfigFormat::Toml => {
            let doc = read_toml_doc(path).await?;
            Ok(doc
                .get(adapter.key_path[0])
                .and_then(|i| i.as_table())
                .map(|t| {
                    t.iter()
                        .map(|(k, v)| (k.to_string(), toml_item_to_json(v)))
                        .collect()
                })
                .unwrap_or_default())
        }
    }
}
```

Note: `write_json_atomic` / `write_bytes_atomic` already create parent dirs (verify in `fs_atomic.rs`; if not, add `fs::create_dir_all(parent)` before the write in both `write_entry` arms).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test backend::mcp::engine 2>&1 | tail -5`
Expected: `test result: ok. 13 passed`

- [ ] **Step 6: Run the full backend suite (no regressions from the `backup_existing` move)**

Run: `cd src-tauri && cargo test 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/backend/
git commit -m "feat(mcp): generic JSON/TOML entry write/remove/read with backup + atomic write"
```

---

### Task 5: IPC response types

**Files:**
- Modify: `src-tauri/src/backend/types.rs` (append at end, before tests if any)

**Interfaces:**
- Produces (consumed by Task 6/7 commands and the future frontend):

```rust
/// Status of one library server against one harness target.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTargetStatus {
    pub server_id: String,
    pub harness: String,
    pub scope: String,
    pub config_path: String,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpActivationResult {
    pub server_id: String,
    pub harness: String,
    pub scope: String,
    pub config_path: String,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_note: Option<String>,
}

/// A server entry found in a harness config that no library spec claims.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcpEntry {
    pub harness: String,
    pub scope: String,
    pub config_path: String,
    pub key: String,
    pub entry: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLibraryResponse {
    pub servers: Vec<super::mcp::spec::McpServerSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}
```

- [ ] **Step 1: Add the four structs above to `types.rs`**
- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/backend/types.rs
git commit -m "feat(mcp): IPC response types for MCP management"
```

---

### Task 6: library commands — `mcp_list_library`, `mcp_add_manual`, `mcp_remove_server`

**Files:**
- Modify: `src-tauri/src/backend/commands.rs`

**Interfaces:**
- Consumes: `load_library`/`save_library`/`validate_spec` (Task 1), `McpLibraryResponse` (Task 5), existing `resolve_app_home` + `load_context` conventions in `commands.rs`.
- Produces (Tauri commands + testable `_impl`s):
  - `mcp_list_library() -> McpLibraryResponse`; `mcp_list_library_impl(app_home_override: Option<PathBuf>)`
  - `mcp_add_manual(spec: McpServerSpec) -> McpLibraryResponse`; `mcp_add_manual_impl(spec, app_home_override)`
  - `mcp_remove_server(id: String) -> McpLibraryResponse`; `mcp_remove_server_impl(id, app_home_override, home_dir_override: Option<PathBuf>)` — warnings list targets where the server is still active

- [ ] **Step 1: Write the failing tests (in `commands.rs`'s existing `#[cfg(test)]` module, or create one at the end following the file's current test placement)**

```rust
    #[tokio::test]
    async fn mcp_library_add_list_remove() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");

        let spec = crate::backend::mcp::spec::McpServerSpec {
            id: "context7".into(),
            name: "Context7".into(),
            description: None,
            source: crate::backend::mcp::spec::McpSource { kind: "manual".into(), url: None },
            transport: crate::backend::mcp::spec::McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "@upstash/context7-mcp".into()],
            env: Default::default(),
            url: None,
            headers: Default::default(),
            variants: vec![],
        };

        let resp = mcp_add_manual_impl(spec.clone(), Some(app_home.clone()))
            .await
            .unwrap();
        assert_eq!(resp.servers.len(), 1);

        // Duplicate id rejected.
        assert!(mcp_add_manual_impl(spec.clone(), Some(app_home.clone()))
            .await
            .is_err());

        // Invalid spec rejected.
        let mut bad = spec.clone();
        bad.id = "Bad Id".into();
        assert!(mcp_add_manual_impl(bad, Some(app_home.clone())).await.is_err());

        let resp = mcp_list_library_impl(Some(app_home.clone())).await.unwrap();
        assert_eq!(resp.servers[0].id, "context7");

        let resp = mcp_remove_server_impl(
            "context7".into(),
            Some(app_home.clone()),
            Some(dir.path().join("home")),
        )
        .await
        .unwrap();
        assert!(resp.servers.is_empty());

        // Removing a non-existent id errors.
        assert!(mcp_remove_server_impl(
            "context7".into(),
            Some(app_home),
            Some(dir.path().join("home"))
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn mcp_remove_warns_when_still_active() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(&home).await.unwrap();

        // Put the server in the library AND activate it for cursor global.
        let spec = crate::backend::mcp::spec::McpServerSpec {
            id: "context7".into(),
            name: "Context7".into(),
            description: None,
            source: crate::backend::mcp::spec::McpSource { kind: "manual".into(), url: None },
            transport: crate::backend::mcp::spec::McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec![],
            env: Default::default(),
            url: None,
            headers: Default::default(),
            variants: vec![],
        };
        mcp_add_manual_impl(spec, Some(app_home.clone())).await.unwrap();
        mcp_activate_impl(
            "context7".into(), "cursor".into(), "global".into(),
            None, None, Some(app_home.clone()), Some(home.clone()),
        )
        .await
        .unwrap();

        let resp = mcp_remove_server_impl("context7".into(), Some(app_home), Some(home))
            .await
            .unwrap();
        assert!(resp.warnings.iter().any(|w| w.contains("cursor")), "{:?}", resp.warnings);
    }
```

(The second test also exercises `mcp_activate_impl` from Task 7 — write both tests now; they stay red until Task 7 lands. If the project's test discipline prefers strictly green-per-task, move the second test into Task 7's step 1 instead.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test mcp_library 2>&1 | tail -5`
Expected: compile error (`mcp_add_manual_impl` not found).

- [ ] **Step 3: Implement in `commands.rs`**

Add imports: `use super::mcp::spec::{load_library, save_library, validate_spec, McpServerSpec};` and `use super::types::{McpLibraryResponse, ...};`

```rust
fn resolve_home_dir(home_dir_override: Option<PathBuf>) -> BackendResult<PathBuf> {
    match home_dir_override {
        Some(p) => Ok(p),
        None => dirs::home_dir()
            .ok_or_else(|| BackendError::Validation("home directory unavailable".to_string())),
    }
}

async fn resolve_mcp_app_home(app_home_override: Option<PathBuf>) -> BackendResult<PathBuf> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| BackendError::Validation("home directory unavailable".to_string()))?;
    let app_home = resolve_app_home(&home_dir, app_home_override);
    fs::create_dir_all(&app_home).await?;
    Ok(app_home)
}

#[tauri::command]
pub async fn mcp_list_library() -> BackendResult<McpLibraryResponse> {
    mcp_list_library_impl(None).await
}

pub async fn mcp_list_library_impl(
    app_home_override: Option<PathBuf>,
) -> BackendResult<McpLibraryResponse> {
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    Ok(McpLibraryResponse {
        servers: load_library(&app_home).await?,
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn mcp_add_manual(spec: McpServerSpec) -> BackendResult<McpLibraryResponse> {
    mcp_add_manual_impl(spec, None).await
}

pub async fn mcp_add_manual_impl(
    spec: McpServerSpec,
    app_home_override: Option<PathBuf>,
) -> BackendResult<McpLibraryResponse> {
    validate_spec(&spec)?;
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    let mut servers = load_library(&app_home).await?;
    if servers.iter().any(|s| s.id == spec.id) {
        return Err(BackendError::Validation(format!(
            "A server with id {:?} already exists in the library",
            spec.id
        )));
    }
    servers.push(spec);
    save_library(&app_home, &servers).await?;
    Ok(McpLibraryResponse { servers, warnings: Vec::new() })
}

#[tauri::command]
pub async fn mcp_remove_server(id: String) -> BackendResult<McpLibraryResponse> {
    mcp_remove_server_impl(id, None, None).await
}

pub async fn mcp_remove_server_impl(
    id: String,
    app_home_override: Option<PathBuf>,
    home_dir_override: Option<PathBuf>,
) -> BackendResult<McpLibraryResponse> {
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    let mut servers = load_library(&app_home).await?;
    let before = servers.len();
    servers.retain(|s| s.id != id);
    if servers.len() == before {
        return Err(BackendError::NotFound(format!("No library server with id {id:?}")));
    }

    // Warn (do not deactivate) where the entry is still present in configs.
    let home_dir = resolve_home_dir(home_dir_override)?;
    let mut warnings = Vec::new();
    for adapter in super::mcp::adapters::adapters() {
        let path = super::mcp::adapters::config_path_for(adapter, "global", &home_dir, None)?;
        let entries = super::mcp::engine::read_entries(&path, adapter).await?;
        if entries.iter().any(|(k, _)| k == &id) {
            warnings.push(format!(
                "{id} is still active in {} global ({})",
                adapter.harness_id,
                path.display()
            ));
        }
    }

    save_library(&app_home, &servers).await?;
    Ok(McpLibraryResponse { servers, warnings })
}
```

(`resolve_app_home` and `fs` are already in `commands.rs` scope. Project-scope warnings are skipped in remove — remove has no project context; `mcp_status` covers it.)

- [ ] **Step 4: Run tests to verify the first test passes**

Run: `cd src-tauri && cargo test mcp_library_add_list_remove 2>&1 | tail -5`
Expected: PASS (the `mcp_remove_warns_when_still_active` test still fails to compile if kept here — see step 1 note; move it to Task 7 in that case).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backend/commands.rs
git commit -m "feat(mcp): library commands (list/add/remove) with active-target warnings"
```

---

### Task 7: activation commands — `mcp_activate`, `mcp_deactivate`, `mcp_status`, `mcp_discover`

**Files:**
- Modify: `src-tauri/src/backend/commands.rs`

**Interfaces:**
- Consumes: everything above; `expand_home` from `projects.rs` for `project_path`.
- Produces:
  - `mcp_activate(id, harness, scope, variant_label: Option<String>, project_path: Option<String>) -> McpActivationResult` + `_impl(..., app_home_override, home_dir_override)`
  - `mcp_deactivate(id, harness, scope, project_path: Option<String>) -> McpActivationResult` + `_impl(...)`
  - `mcp_status(project_path: Option<String>) -> Vec<McpTargetStatus>` + `_impl(...)`
  - `mcp_discover(project_path: Option<String>) -> Vec<DiscoveredMcpEntry>` + `_impl(...)`

- [ ] **Step 1: Write the failing tests**

```rust
    fn test_spec(id: &str) -> crate::backend::mcp::spec::McpServerSpec {
        crate::backend::mcp::spec::McpServerSpec {
            id: id.into(),
            name: id.into(),
            description: None,
            source: crate::backend::mcp::spec::McpSource { kind: "manual".into(), url: None },
            transport: crate::backend::mcp::spec::McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "pkg".into()],
            env: Default::default(),
            url: None,
            headers: Default::default(),
            variants: vec![],
        }
    }

    #[tokio::test]
    async fn mcp_activate_deactivate_status_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");
        let home = dir.path().join("home");
        let project = dir.path().join("repo");
        tokio::fs::create_dir_all(&home).await.unwrap();
        tokio::fs::create_dir_all(&project).await.unwrap();

        mcp_add_manual_impl(test_spec("context7"), Some(app_home.clone())).await.unwrap();

        // Global activate for claude writes ~/.claude.json.
        let res = mcp_activate_impl(
            "context7".into(), "claude".into(), "global".into(),
            None, None, Some(app_home.clone()), Some(home.clone()),
        ).await.unwrap();
        assert!(res.active);
        let doc: serde_json::Value = serde_json::from_slice(
            &tokio::fs::read(home.join(".claude.json")).await.unwrap(),
        ).unwrap();
        assert_eq!(doc["mcpServers"]["context7"]["command"], "npx");

        // Project activate for claude writes <repo>/.mcp.json + returns trust note.
        let res = mcp_activate_impl(
            "context7".into(), "claude".into(), "project".into(),
            None, Some(project.to_string_lossy().into_owned()),
            Some(app_home.clone()), Some(home.clone()),
        ).await.unwrap();
        assert!(res.trust_note.is_some());
        assert!(project.join(".mcp.json").exists());

        // Status reflects both, and covers all 7 global + 7 project rows.
        let statuses = mcp_status_impl(
            Some(project.to_string_lossy().into_owned()),
            Some(app_home.clone()), Some(home.clone()),
        ).await.unwrap();
        assert_eq!(statuses.len(), 14);
        let claude_g = statuses.iter()
            .find(|s| s.harness == "claude" && s.scope == "global").unwrap();
        assert!(claude_g.active);
        let cursor_g = statuses.iter()
            .find(|s| s.harness == "cursor" && s.scope == "global").unwrap();
        assert!(!cursor_g.active);

        // Without a project only 7 global rows come back.
        let statuses = mcp_status_impl(None, Some(app_home.clone()), Some(home.clone()))
            .await.unwrap();
        assert_eq!(statuses.len(), 7);

        // Deactivate global.
        let res = mcp_deactivate_impl(
            "context7".into(), "claude".into(), "global".into(),
            None, Some(app_home.clone()), Some(home.clone()),
        ).await.unwrap();
        assert!(!res.active);
        let doc: serde_json::Value = serde_json::from_slice(
            &tokio::fs::read(home.join(".claude.json")).await.unwrap(),
        ).unwrap();
        assert!(doc["mcpServers"].get("context7").is_none());
    }

    #[tokio::test]
    async fn mcp_activate_validates_inputs() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        mcp_add_manual_impl(test_spec("s1"), Some(app_home.clone())).await.unwrap();

        // Unknown server id.
        assert!(mcp_activate_impl(
            "nope".into(), "claude".into(), "global".into(),
            None, None, Some(app_home.clone()), Some(home.clone()),
        ).await.is_err());
        // Unknown harness.
        assert!(mcp_activate_impl(
            "s1".into(), "emacs".into(), "global".into(),
            None, None, Some(app_home.clone()), Some(home.clone()),
        ).await.is_err());
        // Project scope without project path.
        assert!(mcp_activate_impl(
            "s1".into(), "claude".into(), "project".into(),
            None, None, Some(app_home.clone()), Some(home.clone()),
        ).await.is_err());
    }

    #[tokio::test]
    async fn mcp_discover_finds_unmanaged_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let app_home = dir.path().join("apphome");
        let home = dir.path().join("home");
        tokio::fs::create_dir_all(home.join(".cursor")).await.unwrap();
        tokio::fs::write(
            home.join(".cursor/mcp.json"),
            r#"{"mcpServers":{"handmade":{"command":"x"}}}"#,
        ).await.unwrap();

        mcp_add_manual_impl(test_spec("context7"), Some(app_home.clone())).await.unwrap();
        mcp_activate_impl(
            "context7".into(), "cursor".into(), "global".into(),
            None, None, Some(app_home.clone()), Some(home.clone()),
        ).await.unwrap();

        let found = mcp_discover_impl(None, Some(app_home), Some(home)).await.unwrap();
        // Managed entry excluded; handmade one reported.
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, "handmade");
        assert_eq!(found[0].harness, "cursor");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test mcp_activate 2>&1 | tail -5`
Expected: compile error (`mcp_activate_impl` not found).

- [ ] **Step 3: Implement in `commands.rs`**

```rust
use super::mcp::adapters::{adapter_for, adapters, config_path_for};
use super::mcp::engine::{read_entries, remove_entry, write_entry};
use super::mcp::spec::resolve_effective;
use super::types::{DiscoveredMcpEntry, McpActivationResult, McpTargetStatus};

const PROJECT_TRUST_NOTE: &str =
    "This harness requires first-run approval of project-scope MCP servers inside the tool.";

fn resolve_project_root(project_path: Option<String>) -> BackendResult<Option<PathBuf>> {
    Ok(match project_path {
        Some(p) if !p.trim().is_empty() => Some(PathBuf::from(expand_home(p.trim()))),
        _ => None,
    })
}

#[tauri::command]
pub async fn mcp_activate(
    id: String,
    harness: String,
    scope: String,
    variant_label: Option<String>,
    project_path: Option<String>,
) -> BackendResult<McpActivationResult> {
    mcp_activate_impl(id, harness, scope, variant_label, project_path, None, None).await
}

pub async fn mcp_activate_impl(
    id: String,
    harness: String,
    scope: String,
    variant_label: Option<String>,
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

    let inv = resolve_effective(spec, &harness, &scope, variant_label.as_deref())?;
    write_entry(&path, adapter, &id, &inv).await?;

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

#[tauri::command]
pub async fn mcp_deactivate(
    id: String,
    harness: String,
    scope: String,
    project_path: Option<String>,
) -> BackendResult<McpActivationResult> {
    mcp_deactivate_impl(id, harness, scope, project_path, None, None).await
}

pub async fn mcp_deactivate_impl(
    id: String,
    harness: String,
    scope: String,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
    home_dir_override: Option<PathBuf>,
) -> BackendResult<McpActivationResult> {
    // Deliberately does NOT require the id to be in the library: you can
    // deactivate an entry whose spec was removed.
    let _ = resolve_mcp_app_home(app_home_override).await?;
    let adapter = adapter_for(&harness)?;
    let home_dir = resolve_home_dir(home_dir_override)?;
    let project_root = resolve_project_root(project_path)?;
    let path = config_path_for(adapter, &scope, &home_dir, project_root.as_deref())?;
    remove_entry(&path, adapter, &id).await?;
    Ok(McpActivationResult {
        server_id: id,
        harness,
        scope,
        config_path: path.to_string_lossy().into_owned(),
        active: false,
        trust_note: None,
    })
}

#[tauri::command]
pub async fn mcp_status(project_path: Option<String>) -> BackendResult<Vec<McpTargetStatus>> {
    mcp_status_impl(project_path, None, None).await
}

pub async fn mcp_status_impl(
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
    home_dir_override: Option<PathBuf>,
) -> BackendResult<Vec<McpTargetStatus>> {
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    let servers = load_library(&app_home).await?;
    let home_dir = resolve_home_dir(home_dir_override)?;
    let project_root = resolve_project_root(project_path)?;

    let mut out = Vec::new();
    for adapter in adapters() {
        let mut targets = vec![("global", config_path_for(adapter, "global", &home_dir, None)?)];
        if let Some(root) = project_root.as_deref() {
            targets.push(("project", config_path_for(adapter, "project", &home_dir, Some(root))?));
        }
        for (scope, path) in targets {
            let entries = read_entries(&path, adapter).await?;
            let active_ids: Vec<&String> = entries.iter().map(|(k, _)| k).collect();
            for spec in &servers {
                out.push(McpTargetStatus {
                    server_id: spec.id.clone(),
                    harness: adapter.harness_id.to_string(),
                    scope: scope.to_string(),
                    config_path: path.to_string_lossy().into_owned(),
                    active: active_ids.iter().any(|k| *k == &spec.id),
                    trust_note: (adapter.project_trust_note && scope == "project")
                        .then(|| PROJECT_TRUST_NOTE.to_string()),
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn mcp_discover(
    project_path: Option<String>,
) -> BackendResult<Vec<DiscoveredMcpEntry>> {
    mcp_discover_impl(project_path, None, None).await
}

pub async fn mcp_discover_impl(
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
    home_dir_override: Option<PathBuf>,
) -> BackendResult<Vec<DiscoveredMcpEntry>> {
    let app_home = resolve_mcp_app_home(app_home_override).await?;
    let library_ids: Vec<String> = load_library(&app_home)
        .await?
        .into_iter()
        .map(|s| s.id)
        .collect();
    let home_dir = resolve_home_dir(home_dir_override)?;
    let project_root = resolve_project_root(project_path)?;

    let mut out = Vec::new();
    for adapter in adapters() {
        let mut targets = vec![("global", config_path_for(adapter, "global", &home_dir, None)?)];
        if let Some(root) = project_root.as_deref() {
            targets.push(("project", config_path_for(adapter, "project", &home_dir, Some(root))?));
        }
        for (scope, path) in targets {
            for (key, entry) in read_entries(&path, adapter).await? {
                if !library_ids.contains(&key) {
                    out.push(DiscoveredMcpEntry {
                        harness: adapter.harness_id.to_string(),
                        scope: scope.to_string(),
                        config_path: path.to_string_lossy().into_owned(),
                        key,
                        entry,
                    });
                }
            }
        }
    }
    Ok(out)
}
```

Note on the test asserting `statuses.len() == 14` with one library server: 7 adapters × (global + project). With N library servers it is `N × rows`. Note also `mcp_status_impl` swallows nothing: a malformed config file surfaces as an error — acceptable for Phase A (frontend shows toast).

- [ ] **Step 4: Run tests to verify they pass (including Task 6's deferred warning test)**

Run: `cd src-tauri && cargo test mcp_ 2>&1 | tail -6`
Expected: all `mcp_*` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backend/commands.rs
git commit -m "feat(mcp): activate/deactivate/status/discover commands over the engine"
```

---

### Task 8: refactor `mcp_register.rs` onto the engine

**Files:**
- Modify: `src-tauri/src/backend/mcp_register.rs`

**Interfaces:**
- Public surface UNCHANGED: `MCP_SERVER_KEY`, `McpInvocation`, `HarnessMcpStatus`, `auto_harnesses()`, `config_path()`, `invocation_for()`, `node_present()`, `status()`, `register()`, `unregister()`.
- Consumes: `adapter_for`, `write_entry`, `remove_entry`, `read_entries` from `mcp/`.

- [ ] **Step 1: Re-implement `register`/`unregister`/`is_registered` via the engine**

Keep `config_path()` as-is (it matches the adapter table's global paths — claude/codex/opencode). Replace bodies:

```rust
fn to_effective(invocation: &McpInvocation) -> super::mcp::spec::EffectiveInvocation {
    super::mcp::spec::EffectiveInvocation {
        transport: super::mcp::spec::McpTransport::Stdio,
        command: Some(invocation.command.clone()),
        args: invocation.args.clone(),
        env: invocation.env.clone(),
        url: None,
        headers: std::collections::BTreeMap::new(),
    }
}

pub async fn register(
    home_dir: &Path,
    harness_id: &str,
    invocation: &McpInvocation,
) -> BackendResult<()> {
    let adapter = super::mcp::adapters::adapter_for(harness_id)?;
    let path = config_path(home_dir, harness_id)?;
    super::mcp::engine::write_entry(&path, adapter, MCP_SERVER_KEY, &to_effective(invocation)).await
}

pub async fn unregister(home_dir: &Path, harness_id: &str) -> BackendResult<()> {
    let adapter = super::mcp::adapters::adapter_for(harness_id)?;
    let path = config_path(home_dir, harness_id)?;
    super::mcp::engine::remove_entry(&path, adapter, MCP_SERVER_KEY).await?;
    Ok(())
}

async fn is_registered(path: &Path, harness_id: &str) -> BackendResult<bool> {
    let adapter = super::mcp::adapters::adapter_for(harness_id)?;
    let entries = super::mcp::engine::read_entries(path, adapter).await?;
    Ok(entries.iter().any(|(k, _)| k == MCP_SERVER_KEY))
}
```

Delete the now-unused private fns: `register_claude`, `register_opencode`, `register_codex`, `unregister_json`, `unregister_codex`, `read_json_object`, `read_toml_doc` (the engine owns these). Keep `backup_existing` import removal in mind (moved in Task 4). KEEP all existing tests untouched — they are the equivalence proof.

Note: `config_path()` still rejects harnesses outside claude/codex/opencode, preserving the old error behavior for the self-registration flow even though `adapter_for` now knows more harnesses.

- [ ] **Step 2: Run the old tests as the equivalence gate**

Run: `cd src-tauri && cargo test mcp_register 2>&1 | tail -5`
Expected: all pre-existing `mcp_register` tests pass unmodified. Watch specifically: `claude_register_creates_and_preserves_other_servers` (asserts `type == "stdio"`), `opencode_register_uses_command_array` (asserts `enabled == true` and argv-array command), `codex_register_preserves_comments_and_other_servers` (comments survive).

- [ ] **Step 3: Full suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -4`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/backend/mcp_register.rs
git commit -m "refactor(mcp): reimplement skillworks self-registration on the generic engine"
```

---

### Task 9: register commands + full gate

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the seven commands to `generate_handler!`**

After `backend::commands::mcp_manual_snippet,` add:

```rust
            backend::commands::mcp_list_library,
            backend::commands::mcp_add_manual,
            backend::commands::mcp_remove_server,
            backend::commands::mcp_activate,
            backend::commands::mcp_deactivate,
            backend::commands::mcp_status,
            backend::commands::mcp_discover,
```

- [ ] **Step 2: Full verification gate**

Run, from repo root:
```bash
cd src-tauri && cargo test 2>&1 | tail -4 && cargo check 2>&1 | tail -2
cd .. && npm test 2>&1 | tail -6 && npm run build 2>&1 | tail -3
```
Expected: cargo tests all pass, `npm test` 46/46 (Node side untouched), build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(mcp): expose MCP management commands over IPC"
```

---

## Self-Review Notes

- **Spec coverage:** §3 → Task 1; §4 → Task 2; §5 → Tasks 3–4; §6 → Tasks 5–7; §8 → Task 8; §9 → tests throughout; §7 error cases → Tasks 1/2/4/7 tests. `mcp_discover` is read-only per §2 non-goals. Frontend/UI intentionally absent (Phase D).
- **Type consistency:** `EffectiveInvocation`, `McpAdapter` field names, and command signatures are quoted identically across tasks.
- **Known judgment calls encoded:** empty `env`/`headers` omitted (old claude writer emitted `env: {}`; no test asserts it); OpenCode entries always get `enabled: true`; `mcp_deactivate` works for non-library ids; remove-server warns on global scope only.
