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
/// same field set `invocation_eq` compares (`unmapped` excluded).
///
/// Returns a SHA-256 digest of the canonical JSON rather than the JSON itself:
/// `env`/`headers` can carry secrets (API tokens, auth headers) that must not
/// be written verbatim to dismissed.json. The digest is still deterministic
/// (BTreeMap keys sorted, field order fixed here), so a change to any
/// fingerprinted field yields a different value and the candidate resurfaces.
pub fn fingerprint(obs: &ObservedInvocation) -> String {
    use sha2::{Digest, Sha256};
    let canonical = serde_json::json!({
        "transport": format!("{:?}", obs.transport),
        "command": obs.command,
        "args": obs.args,
        "env": obs.env,
        "url": obs.url,
        "headers": obs.headers,
        "enabled": obs.enabled,
        "tools": obs.tools,
    })
    .to_string();
    hex::encode(Sha256::digest(canonical.as_bytes()))
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

    #[test]
    fn fingerprint_hashes_and_omits_secrets() {
        let mut secret = obs(&["-y", "pkg"]);
        secret
            .env
            .insert("API_TOKEN".into(), "super-secret-value".into());
        secret
            .headers
            .insert("Authorization".into(), "Bearer secret-header".into());
        let fp = fingerprint(&secret);

        // The persisted fingerprint must not leak secret material.
        assert!(!fp.contains("super-secret-value"));
        assert!(!fp.contains("secret-header"));
        // It is a hex-encoded SHA-256 digest (64 lowercase hex chars).
        assert_eq!(fp.len(), 64);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));

        // Changing a fingerprinted field still changes the digest.
        let mut changed = obs(&["-y", "pkg"]);
        changed
            .env
            .insert("API_TOKEN".into(), "different-value".into());
        changed
            .headers
            .insert("Authorization".into(), "Bearer secret-header".into());
        assert_ne!(fp, fingerprint(&changed));
    }
}
