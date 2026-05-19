use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use super::fs_atomic::write_json_atomic;
use super::state::{BackendError, BackendResult};

/// Mirror of the JSON shape written to `~/.agent-skill-manager/config.json`
/// by `src/core.js::writeConfig`.
///
/// Fields that the JS layer treats as opaque arrays of objects (custom
/// targets, project records, sets) are kept as `serde_json::Value` for now;
/// they will be promoted to typed structs in later phases of the refactor as
/// the corresponding logic is ported.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Absolute path to the vault root. When absent on disk, `core.js`
    /// defaults to `<appHome>/vault`; we preserve `None` here so callers
    /// can apply the same defaulting rule against their resolved app home.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_root: Option<PathBuf>,

    /// Recently-opened project paths, most recent first.
    #[serde(default)]
    pub recent_projects: Vec<String>,

    /// Project records — opaque for now (mirrors `normalizeProjectRecords`).
    #[serde(default)]
    pub projects: Vec<serde_json::Value>,

    /// User-defined custom targets (additional skill-install destinations).
    #[serde(default)]
    pub custom_targets: Vec<serde_json::Value>,

    /// Target IDs the user has hidden from the manage view.
    #[serde(default)]
    pub hidden_target_ids: Vec<String>,

    /// Saved skill sets (port of `src/sets.js`).
    #[serde(default)]
    pub sets: Vec<serde_json::Value>,
}

impl Config {
    /// Load a config from disk. Returns a default (empty) `Config` when the
    /// file does not exist, matching `readJson(path, {})` in `core.js`.
    pub async fn load(path: &Path) -> BackendResult<Self> {
        match fs::read(path).await {
            Ok(bytes) => {
                let config = serde_json::from_slice::<Config>(&bytes)?;
                Ok(config)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(err) => Err(BackendError::Io(err)),
        }
    }

    /// Atomically persist this config to disk.
    pub async fn save(&self, path: &Path) -> BackendResult<()> {
        write_json_atomic(path, self).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn config_round_trip() {
        let dir = TempDir::new().expect("tempdir");
        let config_path = dir.path().join("config.json");

        let original = Config {
            vault_root: Some(PathBuf::from("/tmp/some-vault")),
            recent_projects: vec![
                "/Users/example/project-a".to_string(),
                "/Users/example/project-b".to_string(),
            ],
            projects: vec![serde_json::json!({
                "path": "/Users/example/project-a",
                "name": "project-a",
                "source": "manual",
            })],
            custom_targets: vec![serde_json::json!({
                "id": "custom-one",
                "label": "Custom One",
                "scope": "global",
                "path": "/Users/example/custom",
            })],
            hidden_target_ids: vec!["claude-code".to_string()],
            sets: vec![serde_json::json!({ "id": "set-1", "name": "Default" })],
        };

        original
            .save(&config_path)
            .await
            .expect("save config");

        let loaded = Config::load(&config_path).await.expect("load config");
        assert_eq!(loaded, original);
    }

    #[tokio::test]
    async fn config_load_missing_returns_default() {
        let dir = TempDir::new().expect("tempdir");
        let missing = dir.path().join("does-not-exist.json");
        let loaded = Config::load(&missing).await.expect("load missing");
        assert_eq!(loaded, Config::default());
    }

    #[tokio::test]
    async fn config_save_creates_parent_dirs() {
        let dir = TempDir::new().expect("tempdir");
        let nested = dir.path().join("a/b/c/config.json");
        let config = Config::default();
        config.save(&nested).await.expect("save nested");
        assert!(nested.exists());
    }
}
