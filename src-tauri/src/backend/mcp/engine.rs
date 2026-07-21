//! Generic MCP config engine: canonical invocation → harness dialect, plus
//! (Task 4/5) file-level read/insert/remove for JSON and TOML configs.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};
use tokio::fs;

use super::super::fs_atomic::{backup_existing, write_bytes_atomic, write_json_atomic};
use super::super::state::{BackendError, BackendResult};
use super::adapters::{CommandStyle, ConfigFormat, Discriminator, McpAdapter, RemoteUrlField};
use super::spec::{EffectiveInvocation, McpTransport};

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
    let obj = value
        .as_object()
        .ok_or_else(|| BackendError::Validation("MCP config entry is not an object".into()))?;

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
        ConfigFormat::Toml => toml_item_to_json(&toml_edit::Item::Table(render_entry_toml(inv))),
    }
}

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
    // Copilot CLI's mcp-config schema documents a `tools` array on every
    // server entry (local and remote), used to allow-list which of the
    // server's tools Copilot may call; omitting it defaults to `*` (all
    // tools) but Copilot's docs show it explicitly set, so emit the
    // documented default rather than relying on the implicit one. No
    // per-server allow-list support yet — always `["*"]`. Guarded to the
    // copilot adapter only; no other harness's dialect uses this field.
    if adapter.harness_id == "copilot" {
        obj.insert("tools".into(), json!(["*"]));
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
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(toml_edit::DocumentMut::new()),
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
            let servers = doc[root_key]
                .as_table_mut()
                .ok_or_else(|| BackendError::Validation(format!("{root_key} is not a table")))?;
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
    // `try_exists` only maps a `NotFound` metadata error to `Ok(false)`;
    // every other error (e.g. `PermissionDenied` on the file or a parent
    // directory) is returned as-is. The old `.unwrap_or(false)` collapsed
    // *all* of those into "doesn't exist", so a permission error on the
    // config file read as a successful no-op deactivation instead of the
    // I/O failure it actually was. Only a real NotFound should short-circuit
    // here; everything else must propagate.
    match fs::try_exists(path).await {
        Ok(false) => return Ok(false),
        Ok(true) => {}
        Err(err) => return Err(err.into()),
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
        let local = render_entry_json(a, &stdio_inv());
        assert_eq!(local["type"], "local");
        assert_eq!(local["tools"], json!(["*"]), "copilot entries default to allow all tools");
        let remote = render_entry_json(a, &http_inv());
        assert_eq!(remote["type"], "http");
        assert_eq!(remote["tools"], json!(["*"]));
    }

    #[test]
    fn tools_field_is_copilot_only() {
        // No other harness's dialect should pick up Copilot's `tools`
        // allow-list field.
        for id in ["claude", "cursor", "kiro", "opencode", "gemini"] {
            let a = adapter_for(id).unwrap();
            assert!(
                render_entry_json(a, &stdio_inv()).get("tools").is_none(),
                "{id} unexpectedly got a tools field"
            );
        }
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
        assert_eq!(
            t["http_headers"]["Authorization"].as_str(),
            Some("Bearer t")
        );
    }

    use tempfile::TempDir;
    use tokio::fs;

    #[tokio::test]
    async fn json_write_read_remove_preserves_siblings() {
        let dir = TempDir::new().unwrap();
        let a = adapter_for("cursor").unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"x"}},"custom":1}"#,
        )
        .await
        .unwrap();

        write_entry(&path, a, "context7", &stdio_inv())
            .await
            .unwrap();
        // Idempotent re-write.
        write_entry(&path, a, "context7", &stdio_inv())
            .await
            .unwrap();

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
            if e.file_name()
                .to_string_lossy()
                .contains(".skillworks-backup-")
            {
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
        fs::write(
            &path,
            "# keep me\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n",
        )
        .await
        .unwrap();

        write_entry(&path, a, "context7", &stdio_inv())
            .await
            .unwrap();
        write_entry(&path, a, "context7", &stdio_inv())
            .await
            .unwrap(); // idempotent

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
        let entries = read_entries(&dir.path().join("nope.json"), a)
            .await
            .unwrap();
        assert!(entries.is_empty());
    }

    /// Regression test: `remove_entry` used to collapse every `try_exists`
    /// error (not just `NotFound`) into "file doesn't exist" -> `Ok(false)`,
    /// so a permission error read as a successful no-op deactivation
    /// instead of the I/O failure it actually was. Lock down the parent
    /// directory so `try_exists` on a file inside it returns
    /// `PermissionDenied`, not `NotFound`, and assert that now propagates
    /// as an `Err` rather than a silent `Ok(false)`.
    #[cfg(unix)]
    #[tokio::test]
    async fn remove_entry_propagates_permission_errors_instead_of_reporting_missing() {
        use std::os::unix::fs::PermissionsExt;

        // Root ignores directory permission bits, so this guard would be
        // meaningless (and would leave a locked-down directory around) when
        // the test runs as root (e.g. some CI/container setups).
        if unsafe { libc::geteuid() } == 0 {
            return;
        }

        let dir = TempDir::new().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir_all(&locked).await.unwrap();
        let path = locked.join("mcp.json");
        let a = adapter_for("claude").unwrap();

        fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))
            .await
            .unwrap();

        let result = remove_entry(&path, a, "s1").await;

        // Restore permissions before any cleanup/assertions that could
        // otherwise fail to tear down the TempDir.
        fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();

        assert!(
            matches!(result, Err(BackendError::Io(_))),
            "permission error must propagate, not read as a missing-file no-op: {result:?}"
        );
    }

    #[test]
    fn parse_entry_round_trips_render_for_every_adapter() {
        // Codex is implicit-transport: sse renders as a bare url and reads
        // back as http, so exercise stdio + http only for the round trip.
        for id in [
            "claude", "codex", "cursor", "opencode", "gemini", "copilot", "kiro",
        ] {
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
}
