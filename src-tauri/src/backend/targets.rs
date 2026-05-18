//! Built-in harness/project target catalog plus `build_targets` /
//! `inspect_target` ported from `src/core.js`.
//!
//! The data table `HARNESS_TARGETS` / `PROJECT_TARGETS` mirrors the JS
//! constant 1:1 — keep them in lockstep when a new harness is added.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use tokio::fs;

use super::skills::{read_manifest, read_skill_metadata, MANIFEST_FILE, SKILL_FILE};
use super::state::BackendResult;
use super::symlinks::{is_symlink_to, list_target_entries};
use super::types::{SkillRecord, SkillStatus, TargetRecord, UnmanagedEntry};

/// One entry in the built-in target table.
#[derive(Debug, Clone)]
pub struct HarnessTargetDef {
    pub id: &'static str,
    pub harness: &'static str,
    pub scope: &'static str,
    pub label: &'static str,
    pub short_label: &'static str,
    pub path_parts: &'static [&'static str],
}

static HARNESS_TARGETS: &[HarnessTargetDef] = &[
    HarnessTargetDef { id: "codex-global",      harness: "Codex",       scope: "global", label: "Codex global",       short_label: "CX G", path_parts: &[".codex", "skills"] },
    HarnessTargetDef { id: "claude-global",     harness: "Claude",      scope: "global", label: "Claude global",      short_label: "CL G", path_parts: &[".claude", "skills"] },
    HarnessTargetDef { id: "agents-global",     harness: "Agents",      scope: "global", label: "Agents global",      short_label: "AG G", path_parts: &[".agents", "skills"] },
    HarnessTargetDef { id: "gemini-global",     harness: "Gemini",      scope: "global", label: "Gemini global",      short_label: "GM G", path_parts: &[".gemini", "skills"] },
    HarnessTargetDef { id: "copilot-global",    harness: "Copilot",     scope: "global", label: "Copilot global",     short_label: "CP G", path_parts: &[".copilot", "skills"] },
    HarnessTargetDef { id: "opencode-global",   harness: "OpenCode",    scope: "global", label: "OpenCode global",    short_label: "OC G", path_parts: &[".config", "opencode", "skills"] },
    HarnessTargetDef { id: "antigravity-global",harness: "Antigravity", scope: "global", label: "Antigravity global", short_label: "AV G", path_parts: &[".gemini", "antigravity", "skills"] },
    HarnessTargetDef { id: "cursor-global",     harness: "Cursor",      scope: "global", label: "Cursor global",      short_label: "CR G", path_parts: &[".cursor", "skills"] },
    HarnessTargetDef { id: "kiro-global",       harness: "Kiro",        scope: "global", label: "Kiro global",        short_label: "KR G", path_parts: &[".kiro", "skills"] },
    HarnessTargetDef { id: "codebuddy-global",  harness: "CodeBuddy",   scope: "global", label: "CodeBuddy global",   short_label: "CB G", path_parts: &[".codebuddy", "skills"] },
    HarnessTargetDef { id: "openclaw-global",   harness: "OpenClaw",    scope: "global", label: "OpenClaw global",    short_label: "OW G", path_parts: &[".openclaw", "skills"] },
    HarnessTargetDef { id: "trae-global",       harness: "Trae",        scope: "global", label: "Trae global",        short_label: "TR G", path_parts: &[".trae", "skills"] },
    HarnessTargetDef { id: "qoder-global",      harness: "Qoder",       scope: "global", label: "Qoder global",       short_label: "QD G", path_parts: &[".qoder", "skills"] },
];

static PROJECT_TARGETS: &[HarnessTargetDef] = &[
    HarnessTargetDef { id: "codex-project",     harness: "Codex",     scope: "project", label: "Codex project",     short_label: "CX P", path_parts: &[".codex", "skills"] },
    HarnessTargetDef { id: "claude-project",    harness: "Claude",    scope: "project", label: "Claude project",    short_label: "CL P", path_parts: &[".claude", "skills"] },
    HarnessTargetDef { id: "agents-project",    harness: "Agents",    scope: "project", label: "Agents project",    short_label: "AG P", path_parts: &[".agents", "skills"] },
    HarnessTargetDef { id: "gemini-project",    harness: "Gemini",    scope: "project", label: "Gemini project",    short_label: "GM P", path_parts: &[".gemini", "skills"] },
    HarnessTargetDef { id: "copilot-project",   harness: "Copilot",   scope: "project", label: "Copilot project",   short_label: "CP P", path_parts: &[".copilot", "skills"] },
    HarnessTargetDef { id: "opencode-project",  harness: "OpenCode",  scope: "project", label: "OpenCode project",  short_label: "OC P", path_parts: &[".opencode", "skills"] },
    HarnessTargetDef { id: "cursor-project",    harness: "Cursor",    scope: "project", label: "Cursor project",    short_label: "CR P", path_parts: &[".cursor", "skills"] },
    HarnessTargetDef { id: "kiro-project",      harness: "Kiro",      scope: "project", label: "Kiro project",      short_label: "KR P", path_parts: &[".kiro", "skills"] },
    HarnessTargetDef { id: "codebuddy-project", harness: "CodeBuddy", scope: "project", label: "CodeBuddy project", short_label: "CB P", path_parts: &[".codebuddy", "skills"] },
    HarnessTargetDef { id: "openclaw-project",  harness: "OpenClaw",  scope: "project", label: "OpenClaw project",  short_label: "OW P", path_parts: &[".openclaw", "skills"] },
    HarnessTargetDef { id: "trae-project",      harness: "Trae",      scope: "project", label: "Trae project",      short_label: "TR P", path_parts: &[".trae", "skills"] },
    HarnessTargetDef { id: "qoder-project",     harness: "Qoder",     scope: "project", label: "Qoder project",     short_label: "QD P", path_parts: &[".qoder", "skills"] },
];

static BUILT_IN_TARGET_IDS: Lazy<std::collections::HashSet<&'static str>> = Lazy::new(|| {
    HARNESS_TARGETS
        .iter()
        .chain(PROJECT_TARGETS.iter())
        .map(|t| t.id)
        .collect()
});

/// Slice of the global (home-rooted) target table.
pub fn built_in_harness_targets() -> &'static [HarnessTargetDef] {
    HARNESS_TARGETS
}

/// Slice of the project-rooted target table.
pub fn built_in_project_targets() -> &'static [HarnessTargetDef] {
    PROJECT_TARGETS
}

pub fn is_built_in_target_id(id: &str) -> bool {
    BUILT_IN_TARGET_IDS.contains(id)
}

// ---------------------------------------------------------------------------
// Custom-target normalization (port of `normalizeCustomTargets`).
// ---------------------------------------------------------------------------

/// Forgiving variant of [`normalize_custom_targets`]: errors are swallowed
/// and an empty list returned. Mirrors `core.js::safeReadCustomTargets`.
pub fn safe_read_custom_targets(input: &serde_json::Value) -> Vec<serde_json::Value> {
    normalize_custom_targets(input).unwrap_or_default()
}

/// Validate a JSON list of custom targets and return the normalized objects.
/// Mirrors `core.js::normalizeCustomTargets`.
pub fn normalize_custom_targets(input: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    if input.is_null() {
        return Ok(Vec::new());
    }
    let arr = match input {
        serde_json::Value::Array(a) => a,
        _ => return Err("customTargets must be an array".to_string()),
    };

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(arr.len());

    for raw in arr {
        let obj = raw
            .as_object()
            .ok_or_else(|| "Each custom target must be an object".to_string())?;

        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            return Err("Custom target requires an id".to_string());
        }
        if BUILT_IN_TARGET_IDS.contains(id.as_str()) {
            return Err(format!("Custom target id collides with built-in: {id}"));
        }
        if !seen.insert(id.clone()) {
            return Err(format!("Duplicate custom target id: {id}"));
        }

        let scope = match obj.get("scope").and_then(|v| v.as_str()) {
            Some("project") => "project",
            Some("global") => "global",
            _ => return Err(format!("Custom target {id} requires scope \"global\" or \"project\"")),
        };

        let mut entry = serde_json::Map::new();
        entry.insert("id".into(), serde_json::Value::String(id.clone()));
        entry.insert(
            "label".into(),
            serde_json::Value::String(
                obj.get("label")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| id.clone()),
            ),
        );
        entry.insert(
            "harness".into(),
            serde_json::Value::String(
                obj.get("harness")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Custom".to_string()),
            ),
        );
        entry.insert("scope".into(), serde_json::Value::String(scope.to_string()));

        if let Some(sl) = obj
            .get("shortLabel")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            entry.insert("shortLabel".into(), serde_json::Value::String(sl));
        }

        if scope == "global" {
            if obj.get("relativePath").is_some() {
                return Err(format!(
                    "Global custom target {id} must not set relativePath; use an absolute path"
                ));
            }
            let raw_path = obj
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("Global custom target {id} requires an absolute path"))?;
            let resolved = expand_home(Path::new(&raw_path));
            if !resolved.is_absolute() {
                return Err(format!("Global custom target {id} requires an absolute path"));
            }
            entry.insert(
                "path".into(),
                serde_json::Value::String(resolved.to_string_lossy().into_owned()),
            );
        } else {
            if obj.get("path").is_some() {
                return Err(format!(
                    "Project custom target {id} must not set absolute path; use a relative path"
                ));
            }
            let candidate = obj
                .get("relativePath")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("Project custom target {id} requires a relative path"))?;
            if Path::new(&candidate).is_absolute() || candidate.starts_with('~') {
                return Err(format!("Project custom target {id} requires a relative path"));
            }
            entry.insert("relativePath".into(), serde_json::Value::String(candidate));
        }

        out.push(serde_json::Value::Object(entry));
    }

    Ok(out)
}

fn expand_home(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
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

// ---------------------------------------------------------------------------
// buildTargets / inspectTarget.
// ---------------------------------------------------------------------------

/// Build the full list of skill destinations for a given home dir, project
/// path, and set of custom targets. Mirrors `core.js::buildTargets`.
///
/// Returns targets in the shape `inspect_target` will later fill in: the
/// `exists`, `manifest_path`, `enabled_skill_ids`, `skill_statuses`, and
/// `unmanaged` fields are defaulted.
pub fn build_targets(
    home_dir: &Path,
    project_path: &Path,
    custom_targets: &[serde_json::Value],
) -> Vec<TargetRecord> {
    let mut out = Vec::new();

    for def in HARNESS_TARGETS {
        let path: PathBuf = def
            .path_parts
            .iter()
            .fold(home_dir.to_path_buf(), |acc, seg| acc.join(seg));
        out.push(TargetRecord {
            id: def.id.to_string(),
            label: def.label.to_string(),
            harness: def.harness.to_string(),
            scope: def.scope.to_string(),
            short_label: Some(def.short_label.to_string()),
            path: path.to_string_lossy().into_owned(),
            path_parts: def.path_parts.iter().map(|s| s.to_string()).collect(),
            custom: false,
            exists: false,
            manifest_path: String::new(),
            enabled_skill_ids: Vec::new(),
            skill_statuses: BTreeMap::new(),
            unmanaged: Vec::new(),
        });
    }

    for def in PROJECT_TARGETS {
        let path: PathBuf = def
            .path_parts
            .iter()
            .fold(project_path.to_path_buf(), |acc, seg| acc.join(seg));
        out.push(TargetRecord {
            id: def.id.to_string(),
            label: def.label.to_string(),
            harness: def.harness.to_string(),
            scope: def.scope.to_string(),
            short_label: Some(def.short_label.to_string()),
            path: path.to_string_lossy().into_owned(),
            path_parts: def.path_parts.iter().map(|s| s.to_string()).collect(),
            custom: false,
            exists: false,
            manifest_path: String::new(),
            enabled_skill_ids: Vec::new(),
            skill_statuses: BTreeMap::new(),
            unmanaged: Vec::new(),
        });
    }

    for raw in custom_targets {
        let Some(obj) = raw.as_object() else { continue };
        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let label = obj
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();
        let harness = obj
            .get("harness")
            .and_then(|v| v.as_str())
            .unwrap_or("Custom")
            .to_string();
        let scope = obj
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("global")
            .to_string();
        let short_label = obj
            .get("shortLabel")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| Some(label.clone()));

        let resolved_path = if scope == "global" {
            PathBuf::from(obj.get("path").and_then(|v| v.as_str()).unwrap_or_default())
        } else {
            let rel = obj
                .get("relativePath")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            project_path.join(rel)
        };

        out.push(TargetRecord {
            id,
            label,
            harness,
            scope,
            short_label,
            path: resolved_path.to_string_lossy().into_owned(),
            path_parts: Vec::new(),
            custom: true,
            exists: false,
            manifest_path: String::new(),
            enabled_skill_ids: Vec::new(),
            skill_statuses: BTreeMap::new(),
            unmanaged: Vec::new(),
        });
    }

    out
}

/// Fill in the live-disk-state fields of `target`. Mirrors
/// `core.js::inspectTarget`.
pub async fn inspect_target(
    mut target: TargetRecord,
    skills: &[SkillRecord],
    vault_root: &Path,
) -> BackendResult<TargetRecord> {
    let target_path = PathBuf::from(&target.path);
    let target_exists = fs::try_exists(&target_path).await.unwrap_or(false);
    let manifest = read_manifest(&target_path).await.unwrap_or_default();

    let entries = if target_exists {
        list_target_entries(&target_path).await
    } else {
        Vec::new()
    };

    let mut links_by_real_path: HashMap<PathBuf, LinkInfo> = HashMap::new();
    let mut unmanaged: Vec<UnmanagedEntry> = Vec::new();

    for (name, entry_path) in entries {
        if name == MANIFEST_FILE {
            continue;
        }

        let Ok(meta) = fs::symlink_metadata(&entry_path).await else {
            continue;
        };

        if meta.file_type().is_symlink() {
            match fs::canonicalize(&entry_path).await {
                Ok(resolved) => {
                    let skill_md_present = fs::try_exists(resolved.join(SKILL_FILE))
                        .await
                        .unwrap_or(false);
                    let managed = is_inside_path(&resolved, vault_root);
                    links_by_real_path.insert(
                        resolved.clone(),
                        LinkInfo {
                            name: name.clone(),
                            path: entry_path.to_string_lossy().into_owned(),
                            managed,
                        },
                    );

                    if skill_md_present && !managed {
                        let metadata = read_skill_metadata(&resolved).await.ok();
                        let display_name = metadata
                            .as_ref()
                            .map(|m| m.name.clone())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| name.clone());
                        let description = metadata
                            .as_ref()
                            .map(|m| m.description.clone())
                            .unwrap_or_default();
                        unmanaged.push(UnmanagedEntry {
                            name: display_name,
                            description,
                            path: entry_path.to_string_lossy().into_owned(),
                            real_path: resolved.to_string_lossy().into_owned(),
                            target: resolved.to_string_lossy().into_owned(),
                            kind: "symlink".to_string(),
                            importable: true,
                        });
                    }
                }
                Err(_) => {
                    unmanaged.push(UnmanagedEntry {
                        name,
                        description: String::new(),
                        path: entry_path.to_string_lossy().into_owned(),
                        real_path: String::new(),
                        target: String::new(),
                        kind: "broken-symlink".to_string(),
                        importable: false,
                    });
                }
            }
            continue;
        }

        if meta.file_type().is_dir()
            && fs::try_exists(entry_path.join(SKILL_FILE))
                .await
                .unwrap_or(false)
        {
            let metadata = read_skill_metadata(&entry_path).await.ok();
            let display_name = metadata
                .as_ref()
                .map(|m| m.name.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| name.clone());
            let description = metadata
                .as_ref()
                .map(|m| m.description.clone())
                .unwrap_or_default();
            let real = fs::canonicalize(&entry_path)
                .await
                .unwrap_or_else(|_| entry_path.clone());
            unmanaged.push(UnmanagedEntry {
                name: display_name,
                description,
                path: entry_path.to_string_lossy().into_owned(),
                real_path: real.to_string_lossy().into_owned(),
                target: String::new(),
                kind: "directory".to_string(),
                importable: true,
            });
        }
    }

    let mut statuses: BTreeMap<String, SkillStatus> = BTreeMap::new();
    let mut enabled_skill_ids = Vec::new();

    for skill in skills {
        let skill_real = PathBuf::from(&skill.real_path);
        let manifest_record = manifest.managed_links.get(&skill.id);
        let manifest_link_name = manifest_record.and_then(|entry| {
            entry
                .0
                .get("linkName")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
        let enabled_link = links_by_real_path.get(&skill_real);

        let planned_name = manifest_link_name
            .clone()
            .unwrap_or_else(|| skill.link_name.clone());
        let planned_path = target_path.join(&planned_name);
        let planned_exists = fs::symlink_metadata(&planned_path).await.is_ok();
        let planned_is_link_to_skill = is_symlink_to(&planned_path, &skill_real).await;
        let conflict = planned_exists && enabled_link.is_none() && !planned_is_link_to_skill;

        if enabled_link.is_some() {
            enabled_skill_ids.push(skill.id.clone());
        }

        let link_name = enabled_link
            .map(|l| l.name.clone())
            .unwrap_or_else(|| planned_name.clone());
        let link_path = enabled_link
            .map(|l| l.path.clone())
            .unwrap_or_else(|| planned_path.to_string_lossy().into_owned());
        let managed = enabled_link.map(|l| l.managed).unwrap_or(false) || manifest_record.is_some();

        statuses.insert(
            skill.id.clone(),
            SkillStatus {
                enabled: enabled_link.is_some(),
                managed,
                link_name,
                link_path,
                conflict,
                stale_manifest: manifest_record.is_some() && enabled_link.is_none(),
            },
        );
    }

    target.exists = target_exists;
    target.manifest_path = target_path.join(MANIFEST_FILE).to_string_lossy().into_owned();
    target.enabled_skill_ids = enabled_skill_ids;
    target.skill_statuses = statuses;
    target.unmanaged = unmanaged;
    Ok(target)
}

struct LinkInfo {
    name: String,
    path: String,
    managed: bool,
}

fn is_inside_path(candidate: &Path, parent: &Path) -> bool {
    let (Ok(cand), Ok(par)) = (
        candidate.canonicalize().or_else(|_| Ok::<_, std::io::Error>(candidate.to_path_buf())),
        parent.canonicalize().or_else(|_| Ok::<_, std::io::Error>(parent.to_path_buf())),
    ) else {
        return false;
    };
    cand.starts_with(&par)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn build_targets_includes_all_built_ins() {
        let home = PathBuf::from("/tmp/home");
        let project = PathBuf::from("/tmp/project");
        let targets = build_targets(&home, &project, &[]);
        let expected_globals = HARNESS_TARGETS.len();
        let expected_projects = PROJECT_TARGETS.len();
        assert_eq!(targets.len(), expected_globals + expected_projects);

        let claude_global = targets.iter().find(|t| t.id == "claude-global").unwrap();
        assert_eq!(claude_global.path, "/tmp/home/.claude/skills");
        assert_eq!(claude_global.scope, "global");
        assert!(!claude_global.custom);

        let cursor_project = targets.iter().find(|t| t.id == "cursor-project").unwrap();
        assert_eq!(cursor_project.path, "/tmp/project/.cursor/skills");
        assert_eq!(cursor_project.scope, "project");
    }

    #[test]
    fn build_targets_appends_custom_global() {
        let home = PathBuf::from("/tmp/home");
        let project = PathBuf::from("/tmp/project");
        let customs = vec![serde_json::json!({
            "id": "custom-a",
            "label": "Custom A",
            "harness": "Custom",
            "scope": "global",
            "path": "/opt/skills",
        })];
        let targets = build_targets(&home, &project, &customs);
        let custom = targets.iter().find(|t| t.id == "custom-a").unwrap();
        assert!(custom.custom);
        assert_eq!(custom.path, "/opt/skills");
        assert_eq!(custom.harness, "Custom");
    }

    #[test]
    fn build_targets_resolves_custom_project_relative() {
        let home = PathBuf::from("/tmp/home");
        let project = PathBuf::from("/tmp/project");
        let customs = vec![serde_json::json!({
            "id": "custom-rel",
            "label": "rel",
            "scope": "project",
            "relativePath": "tools/skills",
        })];
        let targets = build_targets(&home, &project, &customs);
        let custom = targets.iter().find(|t| t.id == "custom-rel").unwrap();
        assert_eq!(custom.path, "/tmp/project/tools/skills");
    }

    #[tokio::test]
    async fn inspect_target_with_managed_symlinks() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        let skill_dir = vault.join("ios/swiftui");
        fs::create_dir_all(&skill_dir).await.unwrap();
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: SwiftUI\ndescription: x\n---\n",
        )
        .await
        .unwrap();

        // Manually build the skill record (matches what discover_skills produces).
        let real_path = fs::canonicalize(&skill_dir).await.unwrap();
        let skill = SkillRecord {
            id: "ios/swiftui".to_string(),
            name: "SwiftUI".to_string(),
            description: "x".to_string(),
            author: "ios".to_string(),
            relative_path: "ios/swiftui".to_string(),
            type_: String::new(),
            path: skill_dir.to_string_lossy().into_owned(),
            real_path: real_path.to_string_lossy().into_owned(),
            link_name: "swiftui".to_string(),
            tags: vec!["iOS".into()],
            skill_file: skill_dir.join(SKILL_FILE).to_string_lossy().into_owned(),
            size_bytes: 0,
            modified_at: String::new(),
        };

        let target_dir = dir.path().join("home/.claude/skills");
        fs::create_dir_all(&target_dir).await.unwrap();
        let link_path = target_dir.join("swiftui");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&skill_dir, &link_path).unwrap();

        let target = TargetRecord {
            id: "claude-global".to_string(),
            label: "Claude global".to_string(),
            harness: "Claude".to_string(),
            scope: "global".to_string(),
            short_label: Some("CL G".to_string()),
            path: target_dir.to_string_lossy().into_owned(),
            path_parts: vec![".claude".into(), "skills".into()],
            custom: false,
            exists: false,
            manifest_path: String::new(),
            enabled_skill_ids: Vec::new(),
            skill_statuses: BTreeMap::new(),
            unmanaged: Vec::new(),
        };

        let inspected = inspect_target(target, std::slice::from_ref(&skill), &vault)
            .await
            .unwrap();
        assert!(inspected.exists);
        assert_eq!(inspected.enabled_skill_ids, vec!["ios/swiftui"]);
        let status = &inspected.skill_statuses["ios/swiftui"];
        assert!(status.enabled);
        assert!(status.managed);
        assert!(!status.conflict);
        assert!(inspected.unmanaged.is_empty());
    }

    #[tokio::test]
    async fn inspect_target_with_unmanaged_files() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        fs::create_dir_all(&vault).await.unwrap();
        let target_dir = dir.path().join("home/.claude/skills");
        fs::create_dir_all(&target_dir).await.unwrap();

        // Unmanaged directory-style skill present in the target.
        let foreign = target_dir.join("foreign-skill");
        fs::create_dir_all(&foreign).await.unwrap();
        fs::write(
            foreign.join(SKILL_FILE),
            "---\nname: Foreign\ndescription: y\n---\n",
        )
        .await
        .unwrap();

        let target = TargetRecord {
            id: "claude-global".to_string(),
            label: "Claude global".to_string(),
            harness: "Claude".to_string(),
            scope: "global".to_string(),
            short_label: Some("CL G".to_string()),
            path: target_dir.to_string_lossy().into_owned(),
            path_parts: vec![".claude".into(), "skills".into()],
            custom: false,
            exists: false,
            manifest_path: String::new(),
            enabled_skill_ids: Vec::new(),
            skill_statuses: BTreeMap::new(),
            unmanaged: Vec::new(),
        };

        let inspected = inspect_target(target, &[], &vault).await.unwrap();
        assert_eq!(inspected.unmanaged.len(), 1);
        let entry = &inspected.unmanaged[0];
        assert_eq!(entry.name, "Foreign");
        assert_eq!(entry.kind, "directory");
        assert!(entry.importable);
    }
}
