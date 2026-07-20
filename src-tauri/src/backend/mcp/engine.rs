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
