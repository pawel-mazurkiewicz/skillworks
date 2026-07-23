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
        assert_ne!(
            fingerprint(&obs(&["-y", "pkg"])),
            fingerprint(&obs(&["-y", "pkg", "--x"]))
        );
        let mut e = obs(&["-y", "pkg"]);
        e.env.insert("TOKEN".into(), "t".into());
        assert_ne!(fingerprint(&obs(&["-y", "pkg"])), fingerprint(&e));
    }
}
