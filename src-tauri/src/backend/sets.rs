//! Port of `src/sets.js`. Owns the canonical on-disk shape of a saved set
//! plus the read/write helpers for the two storage scopes:
//!
//! - **Global sets** live in `~/.<app-home>/config.json` under `sets: []`.
//! - **Project-local sets** live in
//!   `<projectPath>/.agent-skill-manager/sets.json`.
//!
//! Higher-level CRUD + apply logic lives in `commands.rs`; this module
//! provides the small set of pure helpers it composes from.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rand::RngCore;
use tokio::fs;

use super::config::Config;
use super::fs_atomic::write_json_atomic;
use super::state::{BackendError, BackendResult};
use super::types::{Set, SetEntry};

/// Directory inside a project root where Skillworks stores project-local
/// metadata. Mirrors `PROJECT_SETS_DIR` in `src/sets.js`.
const PROJECT_SETS_DIR: &str = ".agent-skill-manager";
/// File inside [`PROJECT_SETS_DIR`] that holds the project's saved sets.
const PROJECT_SETS_FILE: &str = "sets.json";

/// Generate a new set id: `set_` + 12 hex chars (6 random bytes), matching
/// `crypto.randomBytes(6).toString("hex")` in `src/sets.js::newSetId`.
pub fn new_set_id() -> String {
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("set_{}", hex::encode(bytes))
}

/// Normalize, trim, and dedup a raw entries array. Mirrors
/// `src/sets.js::normalizeEntries`: skips non-objects, requires both
/// `skillName` and `targetKey` to be non-empty strings after trimming, and
/// dedupes by the `(skillName, targetKey)` pair while preserving order.
pub fn normalize_entries(entries: &serde_json::Value) -> Vec<SetEntry> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let arr = match entries.as_array() {
        Some(arr) => arr,
        None => return out,
    };
    for entry in arr {
        let obj = match entry.as_object() {
            Some(o) => o,
            None => continue,
        };
        let skill_name = obj
            .get("skillName")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let target_key = obj
            .get("targetKey")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if skill_name.is_empty() || target_key.is_empty() {
            continue;
        }
        let key = format!("{skill_name} {target_key}");
        if !seen.insert(key) {
            continue;
        }
        out.push(SetEntry {
            skill_name,
            target_key,
        });
    }
    out
}

/// Normalize a raw set value loaded from disk into a typed [`Set`].
/// Returns `None` for non-objects and for sets whose `name` field is
/// missing or blank — same fall-through behavior as
/// `src/sets.js::normalizeSet`.
///
/// `project_path` is only consulted when `scope == "project"` and is then
/// stamped onto the resulting record (so callers don't have to walk the
/// file path back to compute it).
pub fn normalize_set(
    raw: &serde_json::Value,
    scope: &str,
    project_path: Option<&Path>,
) -> Option<Set> {
    let obj = raw.as_object()?;
    let id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(new_set_id);
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if name.is_empty() {
        return None;
    }
    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let now = Utc::now().to_rfc3339();
    let created_at = obj
        .get("createdAt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| now.clone());
    let updated_at = obj
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or(now);
    let entries = normalize_entries(obj.get("entries").unwrap_or(&serde_json::Value::Null));
    let scoped_project = if scope == "project" {
        project_path.map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };
    Some(Set {
        id,
        name,
        description,
        scope: scope.to_string(),
        project_path: scoped_project,
        entries,
        created_at,
        updated_at,
    })
}

/// Absolute path to a project's `sets.json` file (creating the file is the
/// caller's responsibility). Mirrors `src/sets.js::projectSetsPath`.
pub fn project_sets_path(project_path: &Path) -> PathBuf {
    project_path.join(PROJECT_SETS_DIR).join(PROJECT_SETS_FILE)
}

/// Read every set saved under a project root. Returns an empty list when
/// the file does not exist, matching the JS `ENOENT` branch.
pub async fn read_project_sets(project_path: &Path) -> BackendResult<Vec<Set>> {
    let path = project_sets_path(project_path);
    match fs::read(&path).await {
        Ok(bytes) => {
            let parsed: serde_json::Value = serde_json::from_slice(&bytes)?;
            let arr = parsed
                .get("sets")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut out = Vec::with_capacity(arr.len());
            for raw in arr {
                if let Some(set) = normalize_set(&raw, "project", Some(project_path)) {
                    out.push(set);
                }
            }
            Ok(out)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(BackendError::Io(err)),
    }
}

/// Atomically persist `sets` to `<projectPath>/.agent-skill-manager/sets.json`.
pub async fn write_project_sets(project_path: &Path, sets: &[Set]) -> BackendResult<()> {
    let path = project_sets_path(project_path);
    let value = serde_json::json!({ "sets": sets });
    write_json_atomic(&path, &value).await
}

/// Read + normalize every global set out of the loaded [`Config`]. Mirrors
/// `src/sets.js::listGlobalSets`.
pub fn list_global_sets(config: &Config) -> Vec<Set> {
    config
        .sets
        .iter()
        .filter_map(|raw| normalize_set(raw, "global", None))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_set_id_is_unique_and_well_formed() {
        let a = new_set_id();
        let b = new_set_id();
        assert!(a.starts_with("set_"));
        assert!(b.starts_with("set_"));
        assert_eq!(a.len(), "set_".len() + 12);
        assert_eq!(b.len(), "set_".len() + 12);
        let hex_a = &a["set_".len()..];
        assert!(hex_a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "ids should not collide");
    }

    #[test]
    fn normalize_entries_strips_blanks_and_dedups() {
        let raw = serde_json::json!([
            { "skillName": " a ", "targetKey": "claude-global" },
            { "skillName": "a", "targetKey": "claude-global" }, // dedup
            { "skillName": "b", "targetKey": "" },             // dropped
            { "skillName": "", "targetKey": "x" },             // dropped
            "not-an-object",                                    // dropped
            { "skillName": "c", "targetKey": "codex-global" },
        ]);
        let entries = normalize_entries(&raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].skill_name, "a");
        assert_eq!(entries[0].target_key, "claude-global");
        assert_eq!(entries[1].skill_name, "c");
        assert_eq!(entries[1].target_key, "codex-global");
    }

    #[test]
    fn normalize_set_strips_unknown_keys_and_validates() {
        // Set without a name is rejected.
        let bad = serde_json::json!({ "name": "   " });
        assert!(normalize_set(&bad, "global", None).is_none());

        // Set with garbage fields keeps only the known ones; entries are
        // normalized; createdAt/updatedAt default to "now".
        let raw = serde_json::json!({
            "id": "set_abc123",
            "name": "  Frontend  ",
            "description": "  build the UI ",
            "junk": 42,
            "entries": [
                { "skillName": "design", "targetKey": "claude-global", "extra": "x" }
            ],
        });
        let normalized = normalize_set(&raw, "global", None).expect("should normalize");
        assert_eq!(normalized.id, "set_abc123");
        assert_eq!(normalized.name, "Frontend");
        assert_eq!(normalized.description, "build the UI");
        assert_eq!(normalized.scope, "global");
        assert!(normalized.project_path.is_none());
        assert_eq!(normalized.entries.len(), 1);
        assert_eq!(normalized.entries[0].skill_name, "design");
        assert!(!normalized.created_at.is_empty());
        assert!(!normalized.updated_at.is_empty());

        // Project-scoped set: project_path is stamped from the caller.
        let project_root = Path::new("/tmp/example");
        let scoped = normalize_set(&raw, "project", Some(project_root))
            .expect("project set should normalize");
        assert_eq!(scoped.scope, "project");
        assert_eq!(
            scoped.project_path.as_deref(),
            Some("/tmp/example"),
            "project_path should be filled in"
        );
    }
}
