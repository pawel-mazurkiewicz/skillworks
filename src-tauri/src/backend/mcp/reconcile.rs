//! Comparison + import-shaping helpers for discovery reconciliation.

use serde::Serialize;

use super::engine::ObservedInvocation;
use super::spec::{McpServerSpec, McpSource, McpTransport};

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
