//! Canonical MCP server library: harness-agnostic specs, variants, and
//! the on-disk library at `<app_home>/mcp/servers.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use super::super::fs_atomic::write_json_atomic;
use super::super::state::{BackendError, BackendResult};
use super::adapters::adapter_for;

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
        McpTransport::Stdio if command.as_deref().unwrap_or("").is_empty() => Err(
            BackendError::Validation(format!("{context}: stdio transport requires a command")),
        ),
        McpTransport::Http | McpTransport::Sse if url.as_deref().unwrap_or("").is_empty() => {
            Err(BackendError::Validation(format!(
                "{context}: {} transport requires a url",
                if transport == McpTransport::Http {
                    "http"
                } else {
                    "sse"
                }
            )))
        }
        _ => Ok(()),
    }
}

fn validate_variants(spec: &McpServerSpec) -> BackendResult<()> {
    let mut seen = Vec::new();
    for v in &spec.variants {
        if v.label.trim().is_empty() {
            return Err(BackendError::Validation(format!(
                "{}: variant label must not be empty",
                spec.id
            )));
        }
        if seen.contains(&v.label) {
            return Err(BackendError::Validation(format!(
                "{}: duplicate variant label {:?}",
                spec.id, v.label
            )));
        }
        seen.push(v.label.clone());
        if let Some(applies) = &v.applies_to {
            if let Some(h) = &applies.harness {
                adapter_for(h).map_err(|_| {
                    BackendError::Validation(format!(
                        "{}: variant {:?} targets unknown harness {h:?}",
                        spec.id, v.label
                    ))
                })?;
            }
            if let Some(s) = &applies.scope {
                if s != "global" && s != "project" {
                    return Err(BackendError::Validation(format!(
                        "{}: variant {:?} has invalid scope {s:?}",
                        spec.id, v.label
                    )));
                }
            }
        }
        // effective invocation must be valid
        let inv_transport = v.transport.unwrap_or(spec.transport);
        let inv_command = v.command.clone().or_else(|| spec.command.clone());
        let inv_url = v.url.clone().or_else(|| spec.url.clone());
        check_transport_fields(
            inv_transport,
            &inv_command,
            &inv_url,
            &format!("{} variant {:?}", spec.id, v.label),
        )?;
    }
    Ok(())
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
    check_transport_fields(spec.transport, &spec.command, &spec.url, &spec.id)?;
    validate_variants(spec)
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
    resolve_effective_selection(spec, harness_id, scope, variant_label).map(|(inv, _)| inv)
}

/// Like [`resolve_effective`], but also returns the label of the variant that
/// was selected for this target (`None` = canonical fields). Reconcile uses
/// this to detect when drift on a target is controlled by a variant, where a
/// blind adopt into the canonical fields would leave the variant overriding.
pub fn resolve_effective_selection(
    spec: &McpServerSpec,
    harness_id: &str,
    scope: &str,
    variant_label: Option<&str>,
) -> BackendResult<(EffectiveInvocation, Option<String>)> {
    let variant: Option<&McpVariant> =
        match variant_label {
            Some(label) => Some(spec.variants.iter().find(|v| v.label == label).ok_or_else(
                || {
                    BackendError::NotFound(format!(
                        "Variant {label:?} not found on server {:?}",
                        spec.id
                    ))
                },
            )?),
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
    let selected = variant.map(|v| v.label.clone());
    Ok((inv, selected))
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
    write_json_atomic(
        &path,
        &LibraryFile {
            servers: servers.to_vec(),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn stdio_spec() -> McpServerSpec {
        McpServerSpec {
            id: "context7".into(),
            name: "Context7".into(),
            description: None,
            source: McpSource {
                kind: "manual".into(),
                url: None,
            },
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec!["-y".into(), "@upstash/context7-mcp".into()],
            env: Default::default(),
            url: None,
            headers: Default::default(),
            variants: vec![],
        }
    }

    fn spec_with_variant(v: McpVariant) -> McpServerSpec {
        let mut s = stdio_spec();
        s.variants = vec![v];
        s
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
                command: None,
                args: None,
                env: None,
                url: Some("https://mcp.context7.com/mcp".into()),
                headers: None,
            },
            McpVariant {
                label: "codex-tweak".into(),
                applies_to: Some(McpAppliesTo {
                    harness: Some("codex".into()),
                    scope: None,
                }),
                transport: None,
                command: None,
                args: Some(vec![
                    "-y".into(),
                    "@upstash/context7-mcp".into(),
                    "--codex".into(),
                ]),
                env: None,
                url: None,
                headers: None,
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
        assert_eq!(
            inv.args.last().map(String::as_str),
            Some("@upstash/context7-mcp")
        );
        // Unknown label errors.
        assert!(resolve_effective(&s, "claude", "global", Some("nope")).is_err());
    }

    #[test]
    fn resolve_effective_scores_harness_and_scope() {
        let mut s = stdio_spec();
        s.variants = vec![
            McpVariant {
                label: "scope-only".into(),
                applies_to: Some(McpAppliesTo {
                    harness: None,
                    scope: Some("project".into()),
                }),
                transport: None,
                command: None,
                args: Some(vec!["scope".into()]),
                env: None,
                url: None,
                headers: None,
            },
            McpVariant {
                label: "both".into(),
                applies_to: Some(McpAppliesTo {
                    harness: Some("claude".into()),
                    scope: Some("project".into()),
                }),
                transport: None,
                command: None,
                args: Some(vec!["both".into()]),
                env: None,
                url: None,
                headers: None,
            },
        ];
        // Full match beats partial.
        let inv = resolve_effective(&s, "claude", "project", None).unwrap();
        assert_eq!(inv.args, vec!["both".to_string()]);
        // A variant whose Some-field mismatches is skipped entirely.
        let inv = resolve_effective(&s, "gemini", "project", None).unwrap();
        assert_eq!(inv.args, vec!["scope".to_string()]);
        let inv = resolve_effective(&s, "gemini", "global", None).unwrap();
        assert_eq!(
            inv.args,
            vec!["-y".to_string(), "@upstash/context7-mcp".to_string()]
        );
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

    #[test]
    fn validate_rejects_bad_variants() {
        // empty label
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "".into(),
            applies_to: None,
            transport: None,
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
        }))
        .is_err());
        // duplicate labels
        let mut s = stdio_spec();
        let v = McpVariant {
            label: "x".into(),
            applies_to: None,
            transport: None,
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
        };
        s.variants = vec![v.clone(), v];
        assert!(validate_spec(&s).is_err());
        // unknown harness in applies_to
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "a".into(),
            applies_to: Some(McpAppliesTo {
                harness: Some("emacs".into()),
                scope: None
            }),
            transport: None,
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
        }))
        .is_err());
        // bad scope
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "a".into(),
            applies_to: Some(McpAppliesTo {
                harness: None,
                scope: Some("universe".into())
            }),
            transport: None,
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
        }))
        .is_err());
        // variant flips to http without url -> unusable effective invocation
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "broken-remote".into(),
            applies_to: None,
            transport: Some(McpTransport::Http),
            command: None,
            args: None,
            env: None,
            url: None,
            headers: None,
        }))
        .is_err());
        // valid variant still passes
        assert!(validate_spec(&spec_with_variant(McpVariant {
            label: "remote".into(),
            applies_to: None,
            transport: Some(McpTransport::Http),
            command: None,
            args: None,
            env: None,
            url: Some("https://x/mcp".into()),
            headers: None,
        }))
        .is_ok());
    }
}
