//! Register the bundled Skillworks MCP server with known coding harnesses.
//!
//! "Launching" a stdio MCP server means writing its invocation into each
//! harness's config so the harness spawns and talks to it. We support three
//! harnesses automatically — Claude Code, Codex, and OpenCode — each with its
//! own config file + format. All writers are idempotent and only touch the
//! `skillworks` entry, leaving any other configured servers untouched.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::state::{BackendError, BackendResult};

/// Key under which the server is registered in every harness config.
pub const MCP_SERVER_KEY: &str = "skillworks";

/// How a harness should spawn the MCP server.
#[derive(Debug, Clone)]
pub struct McpInvocation {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// Status of the MCP registration for a single harness.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessMcpStatus {
    pub harness_id: String,
    pub label: String,
    pub config_path: String,
    pub registered: bool,
    pub server_path: String,
    pub node_present: bool,
}

/// The harnesses we can configure automatically.
pub fn auto_harnesses() -> &'static [(&'static str, &'static str)] {
    &[
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("opencode", "OpenCode"),
    ]
}

fn label_for(harness_id: &str) -> &'static str {
    auto_harnesses()
        .iter()
        .find(|(id, _)| *id == harness_id)
        .map(|(_, label)| *label)
        .unwrap_or("Unknown")
}

/// Resolve the config file each harness reads, relative to `home_dir`.
pub fn config_path(home_dir: &Path, harness_id: &str) -> BackendResult<PathBuf> {
    let path = match harness_id {
        "claude" => home_dir.join(".claude.json"),
        "codex" => home_dir.join(".codex").join("config.toml"),
        "opencode" => home_dir
            .join(".config")
            .join("opencode")
            .join("opencode.json"),
        other => {
            return Err(BackendError::Validation(format!(
                "Unsupported harness: {other}"
            )))
        }
    };
    Ok(path)
}

/// Build the per-harness invocation. `server_path` is the absolute path to the
/// bundled `mcp-server.js`; `app_home` pins the shared Skillworks home so the
/// server and desktop app read the same config.
pub fn invocation_for(harness_id: &str, server_path: &Path, app_home: &Path) -> McpInvocation {
    let args = vec![
        server_path.to_string_lossy().into_owned(),
        "--harness".to_string(),
        harness_id.to_string(),
        "--app-home".to_string(),
        app_home.to_string_lossy().into_owned(),
        "--project-from-cwd".to_string(),
    ];
    McpInvocation {
        command: "node".to_string(),
        args,
        env: BTreeMap::new(),
    }
}

/// Best-effort check that a `node` executable exists on PATH.
pub fn node_present() -> bool {
    let path_var = match std::env::var_os("PATH") {
        Some(v) => v,
        None => return false,
    };
    let candidates = if cfg!(windows) {
        vec!["node.exe", "node.cmd"]
    } else {
        vec!["node"]
    };
    std::env::split_paths(&path_var).any(|dir| {
        candidates
            .iter()
            .any(|name| dir.join(name).is_file())
    })
}

/// Report whether `skillworks` is registered for a harness.
pub async fn status(
    home_dir: &Path,
    harness_id: &str,
    server_path: &Path,
) -> BackendResult<HarnessMcpStatus> {
    let path = config_path(home_dir, harness_id)?;
    let registered = is_registered(&path, harness_id).await?;
    Ok(HarnessMcpStatus {
        harness_id: harness_id.to_string(),
        label: label_for(harness_id).to_string(),
        config_path: path.to_string_lossy().into_owned(),
        registered,
        server_path: server_path.to_string_lossy().into_owned(),
        node_present: node_present(),
    })
}

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

/// Register (or update) the server for a harness.
pub async fn register(
    home_dir: &Path,
    harness_id: &str,
    invocation: &McpInvocation,
) -> BackendResult<()> {
    let adapter = super::mcp::adapters::adapter_for(harness_id)?;
    let path = config_path(home_dir, harness_id)?;
    super::mcp::engine::write_entry(&path, adapter, MCP_SERVER_KEY, &to_effective(invocation)).await
}

/// Remove the server entry for a harness, leaving other servers intact.
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::fs;

    /// Test-only helper: read a JSON config file as a bare object map. The
    /// production read path now goes through `mcp::engine::read_entries`;
    /// this stays test-local because several tests assert on the full
    /// document shape (unrelated top-level keys, sibling servers), not just
    /// the `skillworks` entry.
    async fn read_json_object(
        path: &Path,
    ) -> BackendResult<serde_json::Map<String, serde_json::Value>> {
        match fs::read(path).await {
            Ok(bytes) => {
                if bytes.iter().all(|b| b.is_ascii_whitespace()) {
                    return Ok(serde_json::Map::new());
                }
                let value: serde_json::Value = serde_json::from_slice(&bytes)?;
                match value {
                    serde_json::Value::Object(map) => Ok(map),
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

    fn invocation() -> McpInvocation {
        McpInvocation {
            command: "node".to_string(),
            args: vec![
                "/res/mcp/mcp-server.js".to_string(),
                "--harness".to_string(),
                "claude".to_string(),
            ],
            env: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn claude_register_creates_and_preserves_other_servers() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"x"}},"foo":1}"#,
        )
        .await
        .unwrap();

        register(dir.path(), "claude", &invocation()).await.unwrap();

        let doc = read_json_object(&path).await.unwrap();
        assert!(doc.get("foo").is_some(), "unrelated keys preserved");
        let servers = doc.get("mcpServers").unwrap().as_object().unwrap();
        assert!(servers.contains_key("other"), "other servers preserved");
        let sk = servers.get("skillworks").unwrap();
        assert_eq!(sk["type"], "stdio");
        assert_eq!(sk["command"], "node");

        // Idempotent.
        register(dir.path(), "claude", &invocation()).await.unwrap();
        let servers = read_json_object(&path)
            .await
            .unwrap()
            .get("mcpServers")
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(servers.len(), 2);

        assert!(is_registered(&path, "claude").await.unwrap());
        unregister(dir.path(), "claude").await.unwrap();
        assert!(!is_registered(&path, "claude").await.unwrap());
        // other server still there
        let servers = read_json_object(&path)
            .await
            .unwrap()
            .get("mcpServers")
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        assert!(servers.contains_key("other"));
    }

    #[tokio::test]
    async fn claude_register_on_missing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        register(dir.path(), "claude", &invocation()).await.unwrap();
        assert!(is_registered(&path, "claude").await.unwrap());

        // No pre-existing file -> nothing to back up.
        let backups = backup_files(dir.path(), ".claude.json").await;
        assert!(backups.is_empty(), "no backup for fresh file; got {backups:?}");
    }

    async fn backup_files(dir: &Path, base: &str) -> Vec<String> {
        let prefix = format!("{base}.skillworks-backup-");
        let mut out = Vec::new();
        let mut entries = fs::read_dir(dir).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) {
                out.push(name);
            }
        }
        out
    }

    #[tokio::test]
    async fn register_backs_up_existing_config() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        let original = r#"{"mcpServers":{"other":{"command":"x"}}}"#;
        fs::write(&path, original).await.unwrap();

        register(dir.path(), "claude", &invocation()).await.unwrap();

        let backups = backup_files(dir.path(), ".claude.json").await;
        assert_eq!(backups.len(), 1, "one backup written; got {backups:?}");
        let backup_path = dir.path().join(&backups[0]);
        let backup_contents = fs::read_to_string(&backup_path).await.unwrap();
        assert_eq!(
            backup_contents, original,
            "backup preserves the pre-modification contents"
        );
    }

    #[tokio::test]
    async fn opencode_register_uses_command_array() {
        let dir = TempDir::new().unwrap();
        let path = config_path(dir.path(), "opencode").unwrap();
        register(dir.path(), "opencode", &invocation()).await.unwrap();
        let doc = read_json_object(&path).await.unwrap();
        let sk = doc.get("mcp").unwrap().get("skillworks").unwrap();
        assert_eq!(sk["type"], "local");
        assert_eq!(sk["enabled"], true);
        let command = sk["command"].as_array().unwrap();
        assert_eq!(command[0], "node");
        assert_eq!(command[1], "/res/mcp/mcp-server.js");
        assert!(is_registered(&path, "opencode").await.unwrap());
        unregister(dir.path(), "opencode").await.unwrap();
        assert!(!is_registered(&path, "opencode").await.unwrap());
    }

    #[tokio::test]
    async fn codex_register_preserves_comments_and_other_servers() {
        let dir = TempDir::new().unwrap();
        let path = config_path(dir.path(), "codex").unwrap();
        fs::create_dir_all(path.parent().unwrap()).await.unwrap();
        fs::write(
            &path,
            "# my codex config\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n",
        )
        .await
        .unwrap();

        register(dir.path(), "codex", &invocation()).await.unwrap();

        // Re-register: must stay valid TOML with a single canonical subtable,
        // never accumulating duplicate dotted keys.
        register(dir.path(), "codex", &invocation()).await.unwrap();

        let text = fs::read_to_string(&path).await.unwrap();
        assert!(text.contains("# my codex config"), "comment preserved; got:\n{text}");
        assert!(text.contains("[mcp_servers.other]"), "other server preserved; got:\n{text}");
        assert!(text.contains("[mcp_servers.skillworks]"), "canonical header; got:\n{text}");
        assert!(text.contains("--harness"), "args written; got:\n{text}");

        // The output must re-parse as valid TOML (no duplicate keys).
        let reparsed = text
            .parse::<toml_edit::DocumentMut>()
            .unwrap_or_else(|e| panic!("re-registered TOML invalid: {e}\n{text}"));
        let sk = reparsed["mcp_servers"]["skillworks"].as_table().unwrap();
        assert_eq!(sk["command"].as_str(), Some("node"));

        assert!(is_registered(&path, "codex").await.unwrap());
        unregister(dir.path(), "codex").await.unwrap();
        assert!(!is_registered(&path, "codex").await.unwrap());
        let text = fs::read_to_string(&path).await.unwrap();
        assert!(text.contains("[mcp_servers.other]"), "other server kept after unregister");
    }

    #[tokio::test]
    async fn invocation_includes_identity_and_app_home() {
        let inv = invocation_for("codex", Path::new("/res/mcp-server.js"), Path::new("/home/.skillworks"));
        assert_eq!(inv.command, "node");
        assert!(inv.args.contains(&"--harness".to_string()));
        assert!(inv.args.contains(&"codex".to_string()));
        assert!(inv.args.contains(&"/home/.skillworks".to_string()));
        assert!(inv.args.contains(&"--project-from-cwd".to_string()));
    }
}
