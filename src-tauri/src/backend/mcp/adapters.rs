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
