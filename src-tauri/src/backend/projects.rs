//! Project-record helpers ported from `src/core.js`.
//!
//! Covers `expandHome`, `normalizePath`, `normalizeProjectPath`,
//! `normalizeProjectRecords`, `buildProjectRecord`, and `mergeProjectRecords`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use tokio::fs;

use super::skills::find_skill_roots;
use super::types::{ProjectRecord, ProjectSkillSource, ProjectSource};

/// Resolve `~` and force an absolute path. Mirrors `core.js::expandHome`.
pub fn expand_home(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.is_empty() {
        return p.to_path_buf();
    }
    if s == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    }
    if let Some(stripped) = s.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    p.to_path_buf()
}

/// Convert backslashes to forward slashes for stable IDs. Mirrors
/// `core.js::normalizePath`.
pub fn normalize_path_string(input: &str) -> String {
    input.replace('\\', "/")
}

/// Mirror of `core.js::normalizeProjectPath`: expand `~`, then resolve to an
/// absolute path. Does not require the path to exist.
pub fn normalize_project_path(p: &Path) -> PathBuf {
    let expanded = expand_home(p);
    if expanded.is_absolute() {
        // `path::resolve` semantics — collapse `.`/`..` components.
        clean_path(&expanded)
    } else if let Ok(cwd) = std::env::current_dir() {
        clean_path(&cwd.join(expanded))
    } else {
        expanded
    }
}

/// Equivalent of Node's `path.resolve` for already-absolute paths: collapse
/// `.` and `..` segments without touching the filesystem.
fn clean_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in p.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Construct a [`ProjectRecord`] from disk. Mirrors
/// `core.js::buildProjectRecord`.
pub async fn build_project_record(
    project_path: &Path,
    source: ProjectSource,
) -> ProjectRecord {
    let normalized = normalize_project_path(project_path);
    let skill_sources = find_project_skill_sources(&normalized).await;
    let skill_source_count = skill_sources.len() as u32;
    let name = normalized
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| normalized.to_string_lossy().into_owned());

    ProjectRecord {
        path: normalized.to_string_lossy().into_owned(),
        name,
        source: source.as_str().to_string(),
        skill_source_count,
        skill_sources,
        last_seen_at: Utc::now().to_rfc3339(),
        pinned_set_ids: Vec::new(),
    }
}

/// Inspect the standard project-local skill source folders and return the
/// non-empty ones. Mirrors `core.js::findProjectSkillSources`.
pub async fn find_project_skill_sources(project_root: &Path) -> Vec<ProjectSkillSource> {
    let candidates = [
        project_root.join("skills"),
        project_root.join(".agents").join("skills"),
        project_root.join(".codex").join("skills"),
        project_root.join(".claude").join("skills"),
    ];
    let mut out = Vec::new();
    for candidate in &candidates {
        let roots = find_skill_roots(candidate).await.unwrap_or_default();
        if !roots.is_empty() {
            out.push(ProjectSkillSource {
                path: candidate.to_string_lossy().into_owned(),
                skill_count: roots.len() as u32,
            });
        }
    }
    out
}

/// Sanitize + de-dupe a list of project records. Accepts the JSON-y shape the
/// config can hold (string or object). Mirrors
/// `core.js::normalizeProjectRecords`.
pub fn normalize_project_records(records: Vec<serde_json::Value>) -> Vec<ProjectRecord> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();

    for record in records {
        let raw_path = match &record {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Object(obj) => obj
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default(),
            _ => String::new(),
        };
        if raw_path.is_empty() {
            continue;
        }
        let project_path = normalize_project_path(Path::new(&raw_path));
        let key = project_path.to_string_lossy().into_owned();
        if !seen.insert(key.clone()) {
            continue;
        }

        let obj = record.as_object();
        let name = obj
            .and_then(|o| o.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                project_path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| key.clone())
            });
        let source = obj
            .and_then(|o| o.get("source"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "manual".to_string());
        let skill_source_count = obj
            .and_then(|o| o.get("skillSourceCount"))
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(0);
        let skill_sources = obj
            .and_then(|o| o.get("skillSources"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|val| serde_json::from_value(val.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        let last_seen_at = obj
            .and_then(|o| o.get("lastSeenAt"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let pinned_set_ids = obj
            .and_then(|o| o.get("pinnedSetIds"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        out.push(ProjectRecord {
            path: key,
            name,
            source,
            skill_source_count,
            skill_sources,
            last_seen_at,
            pinned_set_ids,
        });
    }

    out
}

/// Merge two normalized project lists. Mirrors `core.js::mergeProjectRecords`:
/// existing manual entries stay manual; otherwise the incoming source wins.
/// The resulting list is sorted by name.
pub fn merge_project_records(
    existing: Vec<ProjectRecord>,
    incoming: Vec<ProjectRecord>,
) -> Vec<ProjectRecord> {
    let mut merged: BTreeMap<String, ProjectRecord> = BTreeMap::new();
    for record in existing {
        merged.insert(record.path.clone(), record);
    }

    for record in incoming {
        let entry = merged.entry(record.path.clone());
        match entry {
            std::collections::btree_map::Entry::Vacant(v) => {
                v.insert(record);
            }
            std::collections::btree_map::Entry::Occupied(mut o) => {
                let current = o.get().clone();
                let source = if current.source == "manual" {
                    "manual".to_string()
                } else {
                    record.source.clone()
                };
                let name = if !current.name.is_empty() {
                    current.name.clone()
                } else {
                    record.name.clone()
                };
                o.insert(ProjectRecord {
                    path: record.path,
                    name,
                    source,
                    skill_source_count: record.skill_source_count,
                    skill_sources: record.skill_sources,
                    last_seen_at: record.last_seen_at,
                    pinned_set_ids: record.pinned_set_ids,
                });
            }
        }
    }

    let mut values: Vec<ProjectRecord> = merged.into_values().collect();
    values.sort_by(|a, b| a.name.cmp(&b.name));
    values
}

/// Async wrapper that checks whether a directory exists. Used by the state
/// builder to populate `project.exists`.
pub async fn path_exists(p: &Path) -> bool {
    fs::try_exists(p).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_project_path_expands_home() {
        let home = dirs::home_dir().unwrap();
        let normalized = normalize_project_path(Path::new("~/projects/example"));
        assert_eq!(normalized, home.join("projects/example"));
    }

    #[test]
    fn normalize_project_path_collapses_segments() {
        let normalized = normalize_project_path(Path::new("/tmp/a/./b/../c"));
        assert_eq!(normalized, PathBuf::from("/tmp/a/c"));
    }

    #[test]
    fn merge_project_records_dedupes_by_path() {
        let existing = vec![ProjectRecord {
            path: "/tmp/a".to_string(),
            name: "a".to_string(),
            source: "manual".to_string(),
            skill_source_count: 0,
            skill_sources: Vec::new(),
            last_seen_at: String::new(),
            pinned_set_ids: Vec::new(),
        }];
        let incoming = vec![
            ProjectRecord {
                path: "/tmp/a".to_string(),
                name: "a".to_string(),
                source: "scan".to_string(),
                skill_source_count: 2,
                skill_sources: Vec::new(),
                last_seen_at: "2026-01-01T00:00:00Z".to_string(),
                pinned_set_ids: Vec::new(),
            },
            ProjectRecord {
                path: "/tmp/b".to_string(),
                name: "b".to_string(),
                source: "scan".to_string(),
                skill_source_count: 1,
                skill_sources: Vec::new(),
                last_seen_at: String::new(),
                pinned_set_ids: Vec::new(),
            },
        ];

        let merged = merge_project_records(existing, incoming);
        assert_eq!(merged.len(), 2);
        let a = merged.iter().find(|r| r.path == "/tmp/a").unwrap();
        assert_eq!(a.source, "manual", "manual entries stay manual");
        assert_eq!(a.skill_source_count, 2, "incoming counts win");
        let b = merged.iter().find(|r| r.path == "/tmp/b").unwrap();
        assert_eq!(b.source, "scan");
    }

    #[test]
    fn normalize_project_records_dedupes_and_defaults() {
        let raw = vec![
            serde_json::json!({ "path": "/tmp/a", "name": "A", "source": "manual" }),
            serde_json::json!("/tmp/a"),
            serde_json::json!({ "path": "/tmp/b" }),
        ];
        let normalized = normalize_project_records(raw);
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0].path, "/tmp/a");
        assert_eq!(normalized[0].name, "A");
        assert_eq!(normalized[1].path, "/tmp/b");
        assert_eq!(normalized[1].name, "b");
        assert_eq!(normalized[1].source, "manual");
    }
}
