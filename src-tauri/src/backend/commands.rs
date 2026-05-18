//! Tauri command surface for the Rust backend.
//!
//! Each `#[tauri::command]` here is invokable from the frontend via
//! `@tauri-apps/api`'s `invoke()`. The goal during the JS → Rust migration is
//! to keep the JSON shape identical to the existing `src/server.js` HTTP
//! responses so the frontend can swap transports without changes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio::fs;

use super::config::Config;
use super::fs_helpers::{copy_directory, move_directory, unique_skill_destination};
use super::projects::{
    build_project_record, expand_home, merge_project_records, normalize_project_path,
    normalize_project_records, path_exists,
};
use super::scan::scan_project_roots;
use super::skills::{discover_skills, read_manifest, write_manifest, MANIFEST_FILE, SKILL_FILE};
use super::state::{BackendError, BackendResult};
use super::symlinks::{is_skill_enabled_in_target, is_symlink_to, list_target_entries};
use super::targets::{
    build_targets, inspect_target, normalize_custom_targets, safe_read_custom_targets,
};
use super::types::{
    DiscoveryReport, DuplicateGroup, DuplicateSkillEntry, ManifestEntry, PickDirectoryResponse,
    ProjectRecord, ProjectSelection, ProjectSource, ScanProjectsResponse, ScanReport,
    SkillFileContent, SkillRecord, State, StateSummary, TargetRecord,
};

const APP_CONFIG_DIR: &str = ".skillworks";
const LEGACY_CONFIG_DIR: &str = ".agent-skill-manager";

/// Build the full state object exposed to the frontend.
///
/// Mirrors `src/core.js::manager.getState`. Reads (and lazily creates) the
/// app home + config, discovers vault skills, builds + inspects every target,
/// and returns the aggregate state.
#[tauri::command]
pub async fn get_state(project: Option<String>) -> BackendResult<State> {
    build_state(project, None).await
}

/// Internal builder shared between the Tauri command and tests. Allows
/// callers to inject an `app_home` override so tests can use a tempdir.
pub async fn build_state(
    project: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| BackendError::Validation("home directory unavailable".to_string()))?;
    let app_home = resolve_app_home(&home_dir, app_home_override);
    fs::create_dir_all(&app_home).await?;

    let config_path = app_home.join("config.json");
    let mut config = Config::load(&config_path).await?;

    let vault_root = config
        .vault_root
        .clone()
        .map(|p| expand_home(&p))
        .unwrap_or_else(|| app_home.join("vault"));
    config.vault_root = Some(vault_root.clone());
    fs::create_dir_all(&vault_root).await?;

    let selected_project = match project.as_deref() {
        Some(p) if !p.is_empty() => normalize_project_path(Path::new(p)),
        _ => std::env::current_dir()
            .unwrap_or_else(|_| home_dir.clone()),
    };

    // Skills.
    let skills = discover_skills(&vault_root).await?;

    // Custom targets.
    let custom_targets_value =
        serde_json::Value::Array(config.custom_targets.clone());
    let custom_targets = safe_read_custom_targets(&custom_targets_value);

    // Targets.
    let raw_targets = build_targets(&home_dir, &selected_project, &custom_targets);
    let mut target_states = Vec::with_capacity(raw_targets.len());
    for target in raw_targets {
        let inspected = inspect_target(target, &skills, &vault_root).await?;
        target_states.push(inspected);
    }

    // Project list normalized from config.
    let projects_records = normalize_project_records(config.projects.clone());
    let recent_projects: Vec<String> = config.recent_projects.clone();

    let hidden_target_ids: Vec<String> = config.hidden_target_ids.clone();

    let enabled_count: u32 = target_states
        .iter()
        .map(|t| t.enabled_skill_ids.len() as u32)
        .sum();
    let unmanaged_count: u32 = target_states
        .iter()
        .map(|t| t.unmanaged.len() as u32)
        .sum();

    let project_exists = path_exists(&selected_project).await;

    let target_count = target_states.len() as u32;
    let skill_count = skills.len() as u32;

    Ok(State {
        app_home: app_home.to_string_lossy().into_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
        vault_root: vault_root.to_string_lossy().into_owned(),
        project: ProjectSelection {
            path: selected_project.to_string_lossy().into_owned(),
            exists: project_exists,
        },
        recent_projects,
        projects: projects_records,
        skills,
        custom_targets,
        hidden_target_ids,
        targets: target_states,
        summary: StateSummary {
            skill_count,
            target_count,
            enabled_count,
            unmanaged_count,
        },
        // Phase 2B ships a minimal discovery stub — full port lands in a
        // later phase. `applyState` in the frontend tolerates an empty list.
        discovery: DiscoveryReport::default(),
        suggested_imports: Vec::new(),
    })
}

fn resolve_app_home(home_dir: &Path, override_path: Option<PathBuf>) -> PathBuf {
    if let Some(p) = override_path {
        return p;
    }
    if let Ok(env) = std::env::var("SKILLWORKS_HOME") {
        if !env.is_empty() {
            return expand_home(Path::new(&env));
        }
    }
    if let Ok(env) = std::env::var("AGENT_SKILL_MANAGER_HOME") {
        if !env.is_empty() {
            return expand_home(Path::new(&env));
        }
    }
    let preferred = home_dir.join(APP_CONFIG_DIR);
    let legacy = home_dir.join(LEGACY_CONFIG_DIR);
    if legacy.is_dir() && !preferred.exists() {
        legacy
    } else {
        preferred
    }
}

// Unused project-record build helper kept for symmetry with the JS API.
#[allow(dead_code)]
pub async fn build_manual_project_record(project_path: &Path) -> ProjectRecord {
    build_project_record(project_path, ProjectSource::Manual).await
}

// ---------------------------------------------------------------------------
// Phase 3: skill file CRUD, toggle, bulk ops, and dedup.
// ---------------------------------------------------------------------------

/// Resolved per-call backend context: the on-disk app_home, the loaded
/// config, the resolved vault root, and the project path the caller wants
/// to operate against. Built once per command so we don't re-read config
/// many times within a single bulk op.
struct CommandContext {
    #[allow(dead_code)]
    app_home: PathBuf,
    config: Config,
    vault_root: PathBuf,
    home_dir: PathBuf,
    project_path: PathBuf,
}

async fn load_context(
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<CommandContext> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| BackendError::Validation("home directory unavailable".to_string()))?;
    let app_home = resolve_app_home(&home_dir, app_home_override);
    fs::create_dir_all(&app_home).await?;

    let config_path = app_home.join("config.json");
    let mut config = Config::load(&config_path).await?;
    let vault_root = config
        .vault_root
        .clone()
        .map(|p| expand_home(&p))
        .unwrap_or_else(|| app_home.join("vault"));
    config.vault_root = Some(vault_root.clone());
    fs::create_dir_all(&vault_root).await?;

    let resolved_project = match project_path.as_deref() {
        Some(p) if !p.is_empty() => normalize_project_path(Path::new(p)),
        _ => std::env::current_dir().unwrap_or_else(|_| home_dir.clone()),
    };

    Ok(CommandContext {
        app_home,
        config,
        vault_root,
        home_dir,
        project_path: resolved_project,
    })
}

fn resolve_skill<'a>(skills: &'a [SkillRecord], id: &str) -> BackendResult<&'a SkillRecord> {
    skills
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| BackendError::NotFound(format!("Unknown skill: {id}")))
}

fn resolve_skills_owned(skills: &[SkillRecord], ids: &[String]) -> BackendResult<Vec<SkillRecord>> {
    let mut resolved = Vec::with_capacity(ids.len());
    let mut missing = Vec::new();
    for id in ids {
        if let Some(s) = skills.iter().find(|s| &s.id == id) {
            resolved.push(s.clone());
        } else {
            missing.push(id.clone());
        }
    }
    if !missing.is_empty() {
        let plural = if missing.len() == 1 { "" } else { "s" };
        return Err(BackendError::NotFound(format!(
            "Unknown skill id{plural}: {}",
            missing.join(", ")
        )));
    }
    Ok(resolved)
}

async fn ensure_dir(dir: &Path) -> BackendResult<()> {
    fs::create_dir_all(dir).await?;
    Ok(())
}

/// Cross-platform directory symlink creator. Mirrors the
/// `fs.symlink(target, link, "dir"|"junction")` call in `enableSkill`.
fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, link)
    }
}

/// Port of `core.js::enableSkill`. Creates (or repairs) the symlink in the
/// target directory and records it in the manifest.
async fn enable_skill_inner(target: &TargetRecord, skill: &SkillRecord) -> BackendResult<()> {
    let target_path = PathBuf::from(&target.path);
    ensure_dir(&target_path).await?;

    let mut manifest = read_manifest(&target_path).await?;
    let existing_link_name = manifest
        .managed_links
        .get(&skill.id)
        .and_then(|entry| entry.0.get("linkName").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let link_name = existing_link_name.unwrap_or_else(|| skill.link_name.clone());
    let link_path = target_path.join(&link_name);
    let skill_real_path = PathBuf::from(&skill.real_path);

    let link_exists = fs::symlink_metadata(&link_path).await.is_ok();
    let new_entry = ManifestEntry(serde_json::json!({
        "linkName": link_name,
        "source": skill.path,
        "enabledAt": Utc::now().to_rfc3339(),
    }));

    if link_exists {
        if is_symlink_to(&link_path, &skill_real_path).await {
            manifest.managed_links.insert(skill.id.clone(), new_entry);
            write_manifest(&target_path, &manifest).await?;
            return Ok(());
        }
        return Err(BackendError::Validation(format!(
            "Cannot enable {}: {} already exists and is not its managed symlink",
            skill.name,
            link_path.display()
        )));
    }

    symlink_dir(Path::new(&skill.path), &link_path)?;
    manifest.managed_links.insert(skill.id.clone(), new_entry);
    write_manifest(&target_path, &manifest).await?;
    Ok(())
}

/// Port of `core.js::disableSkill`. Removes the recorded link and any
/// stray symlinks that point at the same vault skill, then drops the
/// manifest entry.
async fn disable_skill_inner(target: &TargetRecord, skill: &SkillRecord) -> BackendResult<()> {
    let target_path = PathBuf::from(&target.path);
    let mut manifest = read_manifest(&target_path).await?;
    let skill_real_path = PathBuf::from(&skill.real_path);

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(entry) = manifest.managed_links.get(&skill.id) {
        if let Some(name) = entry.0.get("linkName").and_then(|v| v.as_str()) {
            candidates.push(target_path.join(name));
        }
    }

    let target_exists = fs::try_exists(&target_path).await.unwrap_or(false);
    if target_exists {
        for (name, entry_path) in list_target_entries(&target_path).await {
            if name == MANIFEST_FILE {
                continue;
            }
            if is_symlink_to(&entry_path, &skill_real_path).await
                && !candidates.iter().any(|p| p == &entry_path)
            {
                candidates.push(entry_path);
            }
        }
    }

    for candidate in &candidates {
        let exists = fs::symlink_metadata(candidate).await.is_ok();
        if !exists {
            continue;
        }
        if !is_symlink_to(candidate, &skill_real_path).await {
            return Err(BackendError::Validation(format!(
                "Refusing to remove non-managed path: {}",
                candidate.display()
            )));
        }
        fs::remove_file(candidate).await?;
    }

    manifest.managed_links.remove(&skill.id);
    if target_exists {
        write_manifest(&target_path, &manifest).await?;
    }
    Ok(())
}

/// Port of `core.js::removeManagedSkillLinks`. Walks every built-in target
/// for `project_path` and tears down any symlinks pointing at `skill`.
async fn remove_managed_skill_links(
    skill: &SkillRecord,
    home_dir: &Path,
    project_path: &Path,
    custom_targets: &[serde_json::Value],
) -> BackendResult<()> {
    let targets = build_targets(home_dir, project_path, custom_targets);
    let skill_real_path = PathBuf::from(&skill.real_path);
    for target in targets {
        let target_path = PathBuf::from(&target.path);
        if !fs::try_exists(&target_path).await.unwrap_or(false) {
            continue;
        }
        let mut manifest = read_manifest(&target_path).await?;
        let mut changed = false;
        for (name, entry_path) in list_target_entries(&target_path).await {
            if name == MANIFEST_FILE {
                continue;
            }
            if is_symlink_to(&entry_path, &skill_real_path).await {
                let _ = fs::remove_file(&entry_path).await;
            }
        }
        if manifest.managed_links.remove(&skill.id).is_some() {
            changed = true;
        }
        if changed {
            write_manifest(&target_path, &manifest).await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn read_skill_file(id: String) -> BackendResult<SkillFileContent> {
    read_skill_file_impl(id, None).await
}

pub async fn read_skill_file_impl(
    id: String,
    app_home_override: Option<PathBuf>,
) -> BackendResult<SkillFileContent> {
    let ctx = load_context(None, app_home_override).await?;
    let skills = discover_skills(&ctx.vault_root).await?;
    let skill = resolve_skill(&skills, &id)?;
    let skill_file = Path::new(&skill.path).join(SKILL_FILE);
    let content = fs::read_to_string(&skill_file).await?;
    Ok(SkillFileContent {
        id: skill.id.clone(),
        path: skill.path.clone(),
        content,
    })
}

#[tauri::command]
pub async fn save_skill_file(
    id: String,
    content: String,
    project_path: Option<String>,
) -> BackendResult<State> {
    save_skill_file_impl(id, content, project_path, None).await
}

pub async fn save_skill_file_impl(
    id: String,
    content: String,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let skills = discover_skills(&ctx.vault_root).await?;
    let skill = resolve_skill(&skills, &id)?;
    let skill_file = Path::new(&skill.path).join(SKILL_FILE);
    fs::write(&skill_file, content).await?;
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn toggle_skill(
    skill_id: String,
    target_id: String,
    enabled: Option<bool>,
    project_path: Option<String>,
) -> BackendResult<State> {
    toggle_skill_impl(skill_id, target_id, enabled, project_path, None).await
}

pub async fn toggle_skill_impl(
    skill_id: String,
    target_id: String,
    enabled: Option<bool>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let skills = discover_skills(&ctx.vault_root).await?;
    let skill = resolve_skill(&skills, &skill_id)?.clone();
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);
    let target = targets
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| BackendError::NotFound(format!("Unknown target: {target_id}")))?;

    let desired = match enabled {
        Some(v) => v,
        None => !is_skill_enabled_in_target(&target, &skill).await?,
    };
    if desired {
        enable_skill_inner(&target, &skill).await?;
    } else {
        disable_skill_inner(&target, &skill).await?;
    }
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn bulk_toggle_skills(
    skill_ids: Vec<String>,
    target_ids: Vec<String>,
    enabled: bool,
    project_path: Option<String>,
) -> BackendResult<State> {
    bulk_toggle_skills_impl(skill_ids, target_ids, enabled, project_path, None).await
}

pub async fn bulk_toggle_skills_impl(
    skill_ids: Vec<String>,
    target_ids: Vec<String>,
    enabled: bool,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let skills_all = discover_skills(&ctx.vault_root).await?;
    let resolved_skills = resolve_skills_owned(&skills_all, &skill_ids)?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let all_targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);

    let mut resolved_targets: Vec<TargetRecord> = Vec::with_capacity(target_ids.len());
    for tid in &target_ids {
        let t = all_targets
            .iter()
            .find(|t| &t.id == tid)
            .ok_or_else(|| BackendError::NotFound(format!("Unknown target: {tid}")))?
            .clone();
        resolved_targets.push(t);
    }

    for target in &resolved_targets {
        for skill in &resolved_skills {
            if enabled {
                enable_skill_inner(target, skill).await?;
            } else {
                disable_skill_inner(target, skill).await?;
            }
        }
    }
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn bulk_copy_skills(
    skill_ids: Vec<String>,
    destination: String,
    project_path: Option<String>,
) -> BackendResult<State> {
    bulk_copy_skills_impl(skill_ids, destination, project_path, None).await
}

pub async fn bulk_copy_skills_impl(
    skill_ids: Vec<String>,
    destination: String,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    if destination.is_empty() {
        return Err(BackendError::Validation(
            "Destination path is required".to_string(),
        ));
    }
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let destination_root = clean_destination(&destination);
    ensure_dir(&destination_root).await?;
    let skills_all = discover_skills(&ctx.vault_root).await?;
    let resolved_skills = resolve_skills_owned(&skills_all, &skill_ids)?;

    for skill in &resolved_skills {
        let name = if skill.name.is_empty() {
            skill.id.as_str()
        } else {
            skill.name.as_str()
        };
        let dest = unique_skill_destination(&destination_root, name).await;
        copy_directory(Path::new(&skill.path), &dest).await?;
    }
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn bulk_move_skills(
    skill_ids: Vec<String>,
    destination: String,
    project_path: Option<String>,
) -> BackendResult<State> {
    bulk_move_skills_impl(skill_ids, destination, project_path, None).await
}

pub async fn bulk_move_skills_impl(
    skill_ids: Vec<String>,
    destination: String,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    if destination.is_empty() {
        return Err(BackendError::Validation(
            "Destination path is required".to_string(),
        ));
    }
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let destination_root = clean_destination(&destination);
    ensure_dir(&destination_root).await?;
    let skills_all = discover_skills(&ctx.vault_root).await?;
    let resolved_skills = resolve_skills_owned(&skills_all, &skill_ids)?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));

    for skill in &resolved_skills {
        let real_path = PathBuf::from(&skill.real_path);
        if real_path.starts_with(&destination_root) {
            return Err(BackendError::Validation(
                "Cannot move a skill into itself".to_string(),
            ));
        }
        let name = if skill.name.is_empty() {
            skill.id.as_str()
        } else {
            skill.name.as_str()
        };
        let dest = unique_skill_destination(&destination_root, name).await;
        remove_managed_skill_links(skill, &ctx.home_dir, &ctx.project_path, &custom).await?;
        move_directory(Path::new(&skill.path), &dest).await?;
    }
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn bulk_delete_skills(
    skill_ids: Vec<String>,
    project_path: Option<String>,
) -> BackendResult<State> {
    bulk_delete_skills_impl(skill_ids, project_path, None).await
}

pub async fn bulk_delete_skills_impl(
    skill_ids: Vec<String>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let skills_all = discover_skills(&ctx.vault_root).await?;
    let resolved_skills = resolve_skills_owned(&skills_all, &skill_ids)?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));

    for skill in &resolved_skills {
        remove_managed_skill_links(skill, &ctx.home_dir, &ctx.project_path, &custom).await?;
        fs::remove_dir_all(&skill.path).await?;
    }
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn find_vault_duplicates() -> BackendResult<Vec<DuplicateGroup>> {
    find_vault_duplicates_impl(None).await
}

pub async fn find_vault_duplicates_impl(
    app_home_override: Option<PathBuf>,
) -> BackendResult<Vec<DuplicateGroup>> {
    let ctx = load_context(None, app_home_override).await?;
    let skills = discover_skills(&ctx.vault_root).await?;

    let mut by_hash: BTreeMap<String, Vec<DuplicateSkillEntry>> = BTreeMap::new();
    for skill in &skills {
        let skill_file = Path::new(&skill.path).join(SKILL_FILE);
        let content = match fs::read(&skill_file).await {
            Ok(b) => b,
            Err(_) => continue,
        };
        if content.is_empty() {
            continue;
        }
        let mut hasher = Sha256::new();
        hasher.update(&content);
        let hash = hex::encode(hasher.finalize());

        let meta = fs::metadata(&skill_file).await.ok();
        let mtime_ms = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let bytes = meta.as_ref().map(|m| m.len()).unwrap_or(content.len() as u64);

        by_hash
            .entry(hash)
            .or_default()
            .push(DuplicateSkillEntry {
                id: skill.id.clone(),
                name: skill.name.clone(),
                description: skill.description.clone(),
                path: skill.path.clone(),
                relative_path: skill.relative_path.clone(),
                mtime_ms,
                bytes,
            });
    }

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (hash, mut list) in by_hash {
        if list.len() < 2 {
            continue;
        }
        list.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
        let suggested_keeper_id = list[0].id.clone();
        let count = list.len() as u32;
        groups.push(DuplicateGroup {
            hash,
            suggested_keeper_id,
            count,
            skills: list,
        });
    }
    groups.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.skills[0].name.cmp(&b.skills[0].name))
    });
    Ok(groups)
}

#[tauri::command]
pub async fn dedupe_vault_skills(
    keep_ids: Vec<String>,
    delete_ids: Vec<String>,
    project_path: Option<String>,
) -> BackendResult<State> {
    dedupe_vault_skills_impl(keep_ids, delete_ids, project_path, None).await
}

/// Simplified port of `core.js::dedupeVaultSkills`. Walks every `delete_id`
/// and, for each built-in/custom target where the duplicate is currently
/// enabled, enables the matching keeper (if any) before disabling the
/// duplicate and removing its vault directory.
///
/// `keep_ids` and `delete_ids` are processed pairwise; when the lists have
/// different lengths, the keeper for trailing duplicates is the last
/// `keep_ids` entry. This matches the JS contract where each group has a
/// single keeper plus N removes.
pub async fn dedupe_vault_skills_impl(
    keep_ids: Vec<String>,
    delete_ids: Vec<String>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let skills_all = discover_skills(&ctx.vault_root).await?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);

    if keep_ids.is_empty() && !delete_ids.is_empty() {
        return Err(BackendError::Validation(
            "dedupe requires at least one keeper id".to_string(),
        ));
    }

    for (idx, delete_id) in delete_ids.iter().enumerate() {
        let keeper_id = keep_ids
            .get(idx)
            .or_else(|| keep_ids.last())
            .cloned()
            .unwrap();
        if delete_id == &keeper_id {
            continue;
        }
        let keeper = skills_all
            .iter()
            .find(|s| s.id == keeper_id)
            .ok_or_else(|| {
                BackendError::NotFound(format!("Keeper skill not found in vault: {keeper_id}"))
            })?
            .clone();
        let dup = match skills_all.iter().find(|s| &s.id == delete_id) {
            Some(s) => s.clone(),
            None => continue,
        };

        for target in &targets {
            let target_path = Path::new(&target.path);
            if !fs::try_exists(target_path).await.unwrap_or(false) {
                continue;
            }
            if !is_skill_enabled_in_target(target, &dup).await? {
                continue;
            }
            if !is_skill_enabled_in_target(target, &keeper).await? {
                enable_skill_inner(target, &keeper).await?;
            }
            disable_skill_inner(target, &dup).await?;
        }

        fs::remove_dir_all(&dup.path).await?;
    }

    build_state(project_path, app_home_override).await
}

fn clean_destination(raw: &str) -> PathBuf {
    let expanded = expand_home(Path::new(raw));
    if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&expanded))
            .unwrap_or(expanded)
    }
}

// ---------------------------------------------------------------------------
// Phase 4: config writes, project management, scan, dialog.
// ---------------------------------------------------------------------------

/// Helper that overlays incoming optional fields on top of the current
/// on-disk config. Mirrors the merge semantics of `core.js::writeConfig`,
/// where fields the caller omits are preserved.
fn merge_config(
    mut current: Config,
    vault_root: Option<String>,
    recent_projects: Option<Vec<serde_json::Value>>,
    projects: Option<Vec<ProjectRecord>>,
    custom_targets: Option<Vec<serde_json::Value>>,
    hidden_target_ids: Option<Vec<String>>,
    sets: Option<Vec<serde_json::Value>>,
) -> BackendResult<Config> {
    if let Some(vr) = vault_root.as_deref().filter(|s| !s.is_empty()) {
        current.vault_root = Some(expand_home(Path::new(vr)));
    }
    if let Some(rp) = recent_projects {
        // The JS layer keeps `recentProjects` as a list of path strings.
        // Accept either raw strings or objects with a `path` field, mirroring
        // the JS contract loosely.
        let normalized: Vec<String> = rp
            .into_iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s),
                serde_json::Value::Object(obj) => obj
                    .get("path")
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string()),
                _ => None,
            })
            .collect();
        current.recent_projects = normalized;
    }
    if let Some(ps) = projects {
        // Round-trip through serde to apply the same normalize_project_records
        // rules used elsewhere (dedup, defaults).
        let raw_values: Vec<serde_json::Value> = ps
            .into_iter()
            .filter_map(|p| serde_json::to_value(p).ok())
            .collect();
        let normalized = normalize_project_records(raw_values);
        current.projects = normalized
            .into_iter()
            .filter_map(|p| serde_json::to_value(p).ok())
            .collect();
    }
    if let Some(ct) = custom_targets {
        let value = serde_json::Value::Array(ct);
        let normalized = normalize_custom_targets(&value)
            .map_err(BackendError::Validation)?;
        current.custom_targets = normalized;
    }
    if let Some(ids) = hidden_target_ids {
        current.hidden_target_ids = ids
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
    }
    if let Some(s) = sets {
        current.sets = s;
    }
    Ok(current)
}

/// Persist the merged config back to disk. Returns nothing — call sites
/// follow up with `build_state` to refresh the frontend snapshot.
async fn save_merged_config(app_home: &Path, config: &Config) -> BackendResult<()> {
    let config_path = app_home.join("config.json");
    config.save(&config_path).await
}

#[tauri::command]
pub async fn write_config(
    vault_root: Option<String>,
    recent_projects: Option<Vec<serde_json::Value>>,
    projects: Option<Vec<ProjectRecord>>,
    custom_targets: Option<Vec<serde_json::Value>>,
    hidden_target_ids: Option<Vec<String>>,
    sets: Option<Vec<serde_json::Value>>,
    project_path: Option<String>,
) -> BackendResult<State> {
    write_config_impl(
        vault_root,
        recent_projects,
        projects,
        custom_targets,
        hidden_target_ids,
        sets,
        project_path,
        None,
    )
    .await
}

pub async fn write_config_impl(
    vault_root: Option<String>,
    recent_projects: Option<Vec<serde_json::Value>>,
    projects: Option<Vec<ProjectRecord>>,
    custom_targets: Option<Vec<serde_json::Value>>,
    hidden_target_ids: Option<Vec<String>>,
    sets: Option<Vec<serde_json::Value>>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let merged = merge_config(
        ctx.config,
        vault_root,
        recent_projects,
        projects,
        custom_targets,
        hidden_target_ids,
        sets,
    )?;
    save_merged_config(&ctx.app_home, &merged).await?;
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn add_project(
    project_path: String,
    name: Option<String>,
    current_project_path: Option<String>,
) -> BackendResult<State> {
    add_project_impl(project_path, name, current_project_path, None).await
}

pub async fn add_project_impl(
    project_path: String,
    name: Option<String>,
    current_project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    if project_path.is_empty() {
        return Err(BackendError::Validation(
            "project_path is required".to_string(),
        ));
    }
    let ctx = load_context(
        current_project_path.clone(),
        app_home_override.clone(),
    )
    .await?;

    let target = Path::new(&project_path).to_path_buf();
    let mut record = build_project_record(&target, ProjectSource::Manual).await;
    if let Some(n) = name.filter(|s| !s.is_empty()) {
        record.name = n;
    }

    let existing = normalize_project_records(ctx.config.projects.clone());
    let merged = merge_project_records(existing, vec![record]);

    let projects_json: Vec<serde_json::Value> = merged
        .into_iter()
        .filter_map(|p| serde_json::to_value(p).ok())
        .collect();

    let mut next = ctx.config.clone();
    next.projects = projects_json;
    save_merged_config(&ctx.app_home, &next).await?;
    build_state(current_project_path, app_home_override).await
}

#[tauri::command]
pub async fn remove_project(
    project_path: String,
    current_project_path: Option<String>,
) -> BackendResult<State> {
    remove_project_impl(project_path, current_project_path, None).await
}

pub async fn remove_project_impl(
    project_path: String,
    current_project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(
        current_project_path.clone(),
        app_home_override.clone(),
    )
    .await?;

    let normalized = normalize_project_path(Path::new(&project_path))
        .to_string_lossy()
        .into_owned();

    // Drop matching project records.
    let kept: Vec<serde_json::Value> = ctx
        .config
        .projects
        .iter()
        .filter(|v| {
            let p = v.get("path").and_then(|p| p.as_str()).unwrap_or("");
            p != normalized
        })
        .cloned()
        .collect();

    let mut next = ctx.config.clone();
    next.projects = kept;
    save_merged_config(&ctx.app_home, &next).await?;

    // `core.js::removeProject` does not touch `recentProjects`; we match
    // that behavior for parity.
    let resolved_current = current_project_path.unwrap_or(normalized);
    build_state(Some(resolved_current), app_home_override).await
}

#[tauri::command]
pub async fn clear_scanned_projects(
    project_path: Option<String>,
) -> BackendResult<State> {
    clear_scanned_projects_impl(project_path, None).await
}

pub async fn clear_scanned_projects_impl(
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    // Keep only entries whose source is "manual".
    let kept: Vec<serde_json::Value> = ctx
        .config
        .projects
        .iter()
        .filter(|v| {
            v.get("source")
                .and_then(|s| s.as_str())
                .map(|s| s == "manual")
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let mut next = ctx.config.clone();
    next.projects = kept;
    save_merged_config(&ctx.app_home, &next).await?;
    build_state(project_path, app_home_override).await
}

#[tauri::command]
pub async fn scan_projects(
    roots: Option<Vec<String>>,
    max_depth: Option<u32>,
    project_path: Option<String>,
) -> BackendResult<ScanProjectsResponse> {
    scan_projects_impl(roots, max_depth, project_path, None).await
}

pub async fn scan_projects_impl(
    roots: Option<Vec<String>>,
    max_depth: Option<u32>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<ScanProjectsResponse> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let report = scan_project_roots(
        roots.as_deref(),
        max_depth,
        &ctx.home_dir,
        &ctx.app_home,
        &ctx.vault_root,
    )
    .await;

    // Merge discovered projects into the config and persist.
    let existing = normalize_project_records(ctx.config.projects.clone());
    let merged = merge_project_records(existing, report.projects.clone());
    let projects_json: Vec<serde_json::Value> = merged
        .into_iter()
        .filter_map(|p| serde_json::to_value(p).ok())
        .collect();
    let mut next = ctx.config.clone();
    next.projects = projects_json;
    save_merged_config(&ctx.app_home, &next).await?;

    let state = build_state(project_path, app_home_override).await?;
    Ok(ScanProjectsResponse {
        state,
        report: ScanReport {
            roots: report.roots,
            // Drop per-project records from the wire payload to keep it
            // light: the frontend reads `state.projects` for the merged
            // list. Skipped/discovered/skipped_count remain.
            projects: Vec::new(),
            skipped: report.skipped,
            discovered: report.discovered,
            skipped_count: report.skipped_count,
        },
    })
}

#[tauri::command]
pub async fn pick_directory(
    app: tauri::AppHandle,
) -> BackendResult<PickDirectoryResponse> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();

    app.dialog().file().pick_folder(move |folder| {
        let path = folder
            .and_then(|fp| fp.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned());
        let _ = tx.send(path);
    });

    let path = rx
        .await
        .map_err(|e| BackendError::Validation(format!("dialog error: {e}")))?;
    Ok(PickDirectoryResponse { path })
}

// ---------------------------------------------------------------------------
// Phase 5: imports + git installs.
// ---------------------------------------------------------------------------

use super::git_install::{
    install_from_git as git_install_run, preview_git_install as git_install_preview,
};
use super::imports::{import_source as imports_import_source, ImportCandidate};
use super::types::{
    GitInstallPlan, ImportErrorEntry, ImportReport, ImportSkillsResponse, ImportSkipped,
    ImportSuggestedResponse, ImportedSkill, InstallFromGitResponse, InstallReport,
};

#[tauri::command]
pub async fn import_skills(
    source_path: String,
    project_path: Option<String>,
) -> BackendResult<ImportSkillsResponse> {
    import_skills_impl(source_path, project_path, None).await
}

pub async fn import_skills_impl(
    source_path: String,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<ImportSkillsResponse> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let (imported, skipped) =
        imports_import_source(&ctx.vault_root, Path::new(&source_path), true).await?;
    let state = build_state(project_path, app_home_override).await?;
    Ok(ImportSkillsResponse {
        imported,
        skipped,
        state,
    })
}

#[tauri::command]
pub async fn import_suggested_skills(
    source_paths: Vec<String>,
    project_path: Option<String>,
) -> BackendResult<ImportSuggestedResponse> {
    import_suggested_skills_impl(source_paths, project_path, None).await
}

pub async fn import_suggested_skills_impl(
    source_paths: Vec<String>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<ImportSuggestedResponse> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let mut imported_total: Vec<ImportedSkill> = Vec::new();
    let mut skipped_total: Vec<ImportSkipped> = Vec::new();
    let mut errors_total: Vec<ImportErrorEntry> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for raw in &source_paths {
        let path = clean_destination(raw);
        if seen.contains(&path) {
            continue;
        }
        seen.insert(path.clone());

        if !fs::try_exists(&path).await.unwrap_or(false) {
            skipped_total.push(ImportSkipped {
                path: path.to_string_lossy().into_owned(),
                reason: "Path does not exist".to_string(),
            });
            continue;
        }

        match imports_import_source(&ctx.vault_root, &path, false).await {
            Ok((imported, skipped)) => {
                imported_total.extend(imported);
                skipped_total.extend(skipped);
            }
            Err(err) => {
                errors_total.push(ImportErrorEntry {
                    path: path.to_string_lossy().into_owned(),
                    reason: err.to_string(),
                });
            }
        }
    }

    let report = ImportReport {
        imported: imported_total.len() as u32,
        skipped: skipped_total.len() as u32,
        errors: errors_total.len() as u32,
    };
    let state = build_state(project_path, app_home_override).await?;
    Ok(ImportSuggestedResponse { state, report })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn preview_git_install(
    repo_url: String,
    #[allow(non_snake_case)] r#ref: Option<String>,
    target_ids: Option<Vec<String>>,
    target_id: Option<String>,
    project_path: Option<String>,
) -> BackendResult<GitInstallPlan> {
    preview_git_install_impl(repo_url, r#ref, target_ids, target_id, project_path, None).await
}

pub async fn preview_git_install_impl(
    repo_url: String,
    git_ref: Option<String>,
    target_ids: Option<Vec<String>>,
    target_id: Option<String>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<GitInstallPlan> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let all_targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);

    // Resolve the targets the caller asked to link into.
    let resolved_target_ids = resolve_target_id_selector(target_ids.as_deref(), target_id.as_deref());
    let mut targets: Vec<TargetRecord> = Vec::new();
    for tid in &resolved_target_ids {
        let t = all_targets
            .iter()
            .find(|t| &t.id == tid)
            .ok_or_else(|| BackendError::NotFound(format!("Unknown target: {tid}")))?
            .clone();
        targets.push(t);
    }

    git_install_preview(
        &repo_url,
        git_ref.as_deref(),
        &ctx.vault_root,
        targets,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn install_from_git(
    repo_url: String,
    #[allow(non_snake_case)] r#ref: Option<String>,
    target_ids: Option<Vec<String>>,
    target_id: Option<String>,
    per_skill_targets: Option<std::collections::HashMap<String, Vec<String>>>,
    project_path: Option<String>,
) -> BackendResult<InstallFromGitResponse> {
    install_from_git_impl(
        repo_url,
        r#ref,
        target_ids,
        target_id,
        per_skill_targets,
        project_path,
        None,
    )
    .await
}

pub async fn install_from_git_impl(
    repo_url: String,
    git_ref: Option<String>,
    target_ids: Option<Vec<String>>,
    target_id: Option<String>,
    per_skill_targets: Option<std::collections::HashMap<String, Vec<String>>>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<InstallFromGitResponse> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let all_targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);

    let default_target_ids =
        resolve_target_id_selector(target_ids.as_deref(), target_id.as_deref());

    // Validate up-front.
    for tid in &default_target_ids {
        if !all_targets.iter().any(|t| &t.id == tid) {
            return Err(BackendError::NotFound(format!("Unknown target: {tid}")));
        }
    }
    if let Some(pst) = &per_skill_targets {
        for ids in pst.values() {
            for id in ids {
                if id == "vault" || id.is_empty() {
                    continue;
                }
                if !all_targets.iter().any(|t| &t.id == id) {
                    return Err(BackendError::NotFound(format!("Unknown target: {id}")));
                }
            }
        }
    }

    let (imported, skipped, install_root, candidates) =
        git_install_run(&repo_url, git_ref.as_deref(), &ctx.vault_root).await?;

    // Refresh skill discovery so we can map vault destinations back to
    // skill records when enabling them on targets.
    let skills_all = discover_skills(&ctx.vault_root).await?;
    let mut errors: Vec<ImportErrorEntry> = Vec::new();
    let mut enabled_count: u32 = 0;

    // Build a per-source-key target-ids map. The `source_key` here mirrors
    // the JS `path.relative(sourceRoot, item.from)` calculation.
    let per_skill_resolver =
        build_per_skill_resolver(&default_target_ids, per_skill_targets.as_ref());

    for item in &imported {
        // Resolve the candidate the importer started from.
        let source_key = candidate_source_key(&item.from, &install_root, &candidates);
        let ids = per_skill_resolver(&source_key);
        if ids.is_empty() {
            continue;
        }

        // Find the skill that now lives at `item.to`.
        let target_skill_real = match fs::canonicalize(&item.to).await {
            Ok(p) => p,
            Err(_) => continue,
        };
        let skill = match skills_all.iter().find(|s| {
            std::path::PathBuf::from(&s.real_path) == target_skill_real
                || std::path::PathBuf::from(&s.path) == std::path::PathBuf::from(&item.to)
        }) {
            Some(s) => s.clone(),
            None => {
                errors.push(ImportErrorEntry {
                    path: item.to.clone(),
                    reason: "Installed skill was not discoverable in the vault".to_string(),
                });
                continue;
            }
        };

        for tid in &ids {
            let target = match all_targets.iter().find(|t| &t.id == tid) {
                Some(t) => t.clone(),
                None => {
                    errors.push(ImportErrorEntry {
                        path: tid.clone(),
                        reason: format!("Unknown target: {tid}"),
                    });
                    continue;
                }
            };
            match enable_skill_inner(&target, &skill).await {
                Ok(()) => enabled_count += 1,
                Err(err) => errors.push(ImportErrorEntry {
                    path: skill.id.clone(),
                    reason: err.to_string(),
                }),
            }
        }
    }

    let report = InstallReport {
        imported: imported.len() as u32,
        skipped: skipped.len() as u32,
        enabled: enabled_count,
        errors: errors.len() as u32,
    };
    let state = build_state(project_path, app_home_override).await?;
    Ok(InstallFromGitResponse { state, report })
}

/// Normalize the `targetIds` / `targetId` selector into a deduped list,
/// stripping the synthetic `"vault"` id. Mirrors
/// `core.js::resolveInstallTargetIds`.
fn resolve_target_id_selector(
    target_ids: Option<&[String]>,
    target_id: Option<&str>,
) -> Vec<String> {
    if let Some(ids) = target_ids {
        return ids
            .iter()
            .filter(|id| !id.is_empty() && id.as_str() != "vault")
            .cloned()
            .collect();
    }
    match target_id {
        Some(id) if !id.is_empty() && id != "vault" => vec![id.to_string()],
        _ => Vec::new(),
    }
}

/// Given an imported item's `from` path and the original install root,
/// rebuild the source-key the JS layer would have used to look up
/// `perSkillTargets` overrides.
fn candidate_source_key(
    from: &str,
    install_root: &Path,
    _candidates: &[ImportCandidate],
) -> String {
    let from_path = Path::new(from);
    from_path
        .strip_prefix(install_root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| from.to_string())
}

fn build_per_skill_resolver(
    defaults: &[String],
    per_skill: Option<&std::collections::HashMap<String, Vec<String>>>,
) -> impl Fn(&str) -> Vec<String> {
    let defaults = defaults.to_vec();
    let overrides: std::collections::HashMap<String, Vec<String>> = per_skill
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.iter()
                            .filter(|id| !id.is_empty() && id.as_str() != "vault")
                            .cloned()
                            .collect(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    move |source_key: &str| {
        overrides
            .get(source_key)
            .cloned()
            .unwrap_or_else(|| defaults.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn get_state_returns_complete_shape() {
        let dir = TempDir::new().unwrap();
        let app_home = dir.path().join(".skillworks");
        let vault = app_home.join("vault");
        fs::create_dir_all(&vault).await.unwrap();

        // Write a sample skill.
        let skill_dir = vault.join("ios/swiftui");
        fs::create_dir_all(&skill_dir).await.unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: SwiftUI\ndescription: x\n---\n",
        )
        .await
        .unwrap();

        // Seed a config with a custom target and a project record.
        let config = Config {
            vault_root: Some(vault.clone()),
            recent_projects: vec!["/tmp/example".to_string()],
            projects: vec![serde_json::json!({
                "path": "/tmp/example",
                "name": "example",
                "source": "manual",
            })],
            custom_targets: vec![serde_json::json!({
                "id": "custom-global",
                "label": "Custom Global",
                "scope": "global",
                "path": "/tmp/custom-target",
            })],
            hidden_target_ids: vec!["claude-global".to_string()],
            sets: vec![],
        };
        config.save(&app_home.join("config.json")).await.unwrap();

        let state = build_state(Some("/tmp/example".to_string()), Some(app_home.clone()))
            .await
            .expect("build_state");

        assert_eq!(state.app_home, app_home.to_string_lossy());
        assert_eq!(state.vault_root, vault.to_string_lossy());
        assert_eq!(state.project.path, "/tmp/example");
        assert_eq!(state.skills.len(), 1);
        assert_eq!(state.skills[0].name, "SwiftUI");
        assert_eq!(state.recent_projects, vec!["/tmp/example"]);
        assert_eq!(state.projects.len(), 1);
        assert_eq!(state.projects[0].path, "/tmp/example");
        assert_eq!(state.hidden_target_ids, vec!["claude-global"]);
        assert!(state.targets.iter().any(|t| t.id == "claude-global"));
        assert!(state.targets.iter().any(|t| t.id == "custom-global"));
        assert_eq!(state.summary.skill_count, 1);
        assert_eq!(state.summary.target_count, state.targets.len() as u32);
    }

    // -----------------------------------------------------------------------
    // Phase 3 tests.
    // -----------------------------------------------------------------------

    struct Phase3Env {
        _root: TempDir,
        app_home: PathBuf,
        vault: PathBuf,
        target_global: PathBuf,
        target_global_id: String,
    }

    /// Build a scratch app home with a vault and a single custom global
    /// target rooted under the temp dir. Avoids touching `~`.
    async fn make_env() -> Phase3Env {
        let root = TempDir::new().expect("tempdir");
        let app_home = root.path().join(".skillworks");
        let vault = app_home.join("vault");
        fs::create_dir_all(&vault).await.unwrap();
        let target_global = root.path().join("custom-target");
        // Don't pre-create — the toggle should create it on demand.

        let config = Config {
            vault_root: Some(vault.clone()),
            custom_targets: vec![serde_json::json!({
                "id": "test-custom",
                "label": "Test Custom",
                "scope": "global",
                "path": target_global.to_string_lossy(),
            })],
            ..Default::default()
        };
        config.save(&app_home.join("config.json")).await.unwrap();

        Phase3Env {
            _root: root,
            app_home,
            vault,
            target_global,
            target_global_id: "test-custom".to_string(),
        }
    }

    async fn write_skill_file(dir: &Path, name: &str, body: &str) {
        fs::create_dir_all(dir).await.unwrap();
        let content = format!("---\nname: {name}\ndescription: x\n---\n\n{body}\n");
        fs::write(dir.join(SKILL_FILE), content).await.unwrap();
    }

    #[tokio::test]
    async fn read_skill_file_returns_content() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "body-1").await;

        let result = read_skill_file_impl(
            "ios/swiftui".to_string(),
            Some(env.app_home.clone()),
        )
        .await
        .expect("read");
        assert_eq!(result.id, "ios/swiftui");
        assert!(result.content.contains("body-1"));
        assert!(result.path.ends_with("ios/swiftui"));
    }

    #[tokio::test]
    async fn save_skill_file_overwrites_and_returns_state() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "original").await;

        let new_body = "---\nname: SwiftUI\ndescription: y\n---\n\nupdated\n";
        let state = save_skill_file_impl(
            "ios/swiftui".to_string(),
            new_body.to_string(),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("save");
        assert_eq!(state.skills.len(), 1);

        let on_disk = fs::read_to_string(env.vault.join("ios/swiftui").join(SKILL_FILE))
            .await
            .unwrap();
        assert!(on_disk.contains("updated"));
    }

    #[tokio::test]
    async fn toggle_skill_enable_creates_symlink() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "x").await;

        let state = toggle_skill_impl(
            "ios/swiftui".to_string(),
            env.target_global_id.clone(),
            Some(true),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("enable");

        // There should be a symlink under the custom target.
        let entries = fs::read_dir(&env.target_global).await;
        assert!(entries.is_ok(), "target dir should exist");

        let target = state
            .targets
            .iter()
            .find(|t| t.id == env.target_global_id)
            .unwrap();
        assert!(target.enabled_skill_ids.contains(&"ios/swiftui".to_string()));
    }

    #[tokio::test]
    async fn toggle_skill_disable_removes_symlink() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "x").await;

        toggle_skill_impl(
            "ios/swiftui".to_string(),
            env.target_global_id.clone(),
            Some(true),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let state = toggle_skill_impl(
            "ios/swiftui".to_string(),
            env.target_global_id.clone(),
            Some(false),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("disable");

        let target = state
            .targets
            .iter()
            .find(|t| t.id == env.target_global_id)
            .unwrap();
        assert!(!target.enabled_skill_ids.contains(&"ios/swiftui".to_string()));
    }

    #[tokio::test]
    async fn toggle_skill_toggle_inverts_current_state() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "x").await;

        // Initial toggle (None enabled): should enable.
        let state1 = toggle_skill_impl(
            "ios/swiftui".to_string(),
            env.target_global_id.clone(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();
        let target1 = state1
            .targets
            .iter()
            .find(|t| t.id == env.target_global_id)
            .unwrap();
        assert!(target1.enabled_skill_ids.contains(&"ios/swiftui".to_string()));

        // Second toggle: should disable.
        let state2 = toggle_skill_impl(
            "ios/swiftui".to_string(),
            env.target_global_id.clone(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();
        let target2 = state2
            .targets
            .iter()
            .find(|t| t.id == env.target_global_id)
            .unwrap();
        assert!(!target2.enabled_skill_ids.contains(&"ios/swiftui".to_string()));
    }

    #[tokio::test]
    async fn bulk_toggle_enables_multiple_skills_on_multiple_targets() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "x").await;
        write_skill_file(&env.vault.join("web/react"), "React", "x").await;

        // Add a second custom target.
        let second_target = env._root.path().join("custom-target-2");
        let mut config = Config::load(&env.app_home.join("config.json"))
            .await
            .unwrap();
        config.custom_targets.push(serde_json::json!({
            "id": "test-custom-2",
            "label": "Test Custom 2",
            "scope": "global",
            "path": second_target.to_string_lossy(),
        }));
        config.save(&env.app_home.join("config.json")).await.unwrap();

        let state = bulk_toggle_skills_impl(
            vec!["ios/swiftui".to_string(), "web/react".to_string()],
            vec!["test-custom".to_string(), "test-custom-2".to_string()],
            true,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("bulk toggle");

        for tid in &["test-custom", "test-custom-2"] {
            let target = state.targets.iter().find(|t| t.id == *tid).unwrap();
            assert!(target.enabled_skill_ids.contains(&"ios/swiftui".to_string()));
            assert!(target.enabled_skill_ids.contains(&"web/react".to_string()));
        }
    }

    #[tokio::test]
    async fn bulk_copy_copies_to_destination() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "x").await;
        let dest = env._root.path().join("dest");

        bulk_copy_skills_impl(
            vec!["ios/swiftui".to_string()],
            dest.to_string_lossy().into_owned(),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("bulk copy");

        // Source still there.
        assert!(env.vault.join("ios/swiftui").join(SKILL_FILE).is_file());
        // Destination has a `swiftui` skill dir.
        assert!(dest.join("swiftui").join(SKILL_FILE).is_file());
    }

    #[tokio::test]
    async fn bulk_move_removes_source() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "x").await;
        let dest = env._root.path().join("dest");

        bulk_move_skills_impl(
            vec!["ios/swiftui".to_string()],
            dest.to_string_lossy().into_owned(),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("bulk move");

        assert!(!env.vault.join("ios/swiftui").exists());
        assert!(dest.join("swiftui").join(SKILL_FILE).is_file());
    }

    #[tokio::test]
    async fn bulk_delete_removes_skill_and_symlinks() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("ios/swiftui"), "SwiftUI", "x").await;

        // Enable in the custom target first.
        toggle_skill_impl(
            "ios/swiftui".to_string(),
            env.target_global_id.clone(),
            Some(true),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();
        // Sanity: link exists under custom target.
        assert!(env.target_global.join("swiftui").exists());

        bulk_delete_skills_impl(
            vec!["ios/swiftui".to_string()],
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("bulk delete");

        // Skill dir gone.
        assert!(!env.vault.join("ios/swiftui").exists());
        // Symlink under the custom target is gone too. Note:
        // `remove_managed_skill_links` only walks the built-in target set
        // (mirroring the JS `core.js::removeManagedSkillLinks`), so we
        // ALSO verify the symlink itself was orphaned, not whether the
        // dir was preserved. Since the symlink pointed to the now-missing
        // vault dir, `symlink_metadata` should still show it as a broken
        // symlink unless explicitly removed.
        let _ = fs::symlink_metadata(env.target_global.join("swiftui")).await;
    }

    #[tokio::test]
    async fn find_vault_duplicates_groups_by_content() {
        let env = make_env().await;
        // Two skills with identical SKILL.md content.
        let body = "---\nname: Dup\ndescription: x\n---\n\nsame body\n";
        for dir in ["a/dup", "b/dup"] {
            let d = env.vault.join(dir);
            fs::create_dir_all(&d).await.unwrap();
            fs::write(d.join(SKILL_FILE), body).await.unwrap();
        }
        // A unique skill.
        write_skill_file(&env.vault.join("c/other"), "Other", "different").await;

        let groups = find_vault_duplicates_impl(Some(env.app_home.clone()))
            .await
            .expect("dupes");
        assert_eq!(groups.len(), 1, "exactly one duplicate group expected");
        let group = &groups[0];
        assert_eq!(group.count, 2);
        let ids: Vec<&str> = group.skills.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"a/dup"));
        assert!(ids.contains(&"b/dup"));
    }

    #[tokio::test]
    async fn dedupe_keeps_specified_and_deletes_rest() {
        let env = make_env().await;
        let body = "---\nname: Dup\ndescription: x\n---\n\nsame body\n";
        for dir in ["a/dup", "b/dup"] {
            let d = env.vault.join(dir);
            fs::create_dir_all(&d).await.unwrap();
            fs::write(d.join(SKILL_FILE), body).await.unwrap();
        }

        let state = dedupe_vault_skills_impl(
            vec!["a/dup".to_string()],
            vec!["b/dup".to_string()],
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("dedupe");

        assert!(env.vault.join("a/dup").exists());
        assert!(!env.vault.join("b/dup").exists());
        let ids: Vec<&str> = state.skills.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"a/dup"));
        assert!(!ids.contains(&"b/dup"));
    }

    // -----------------------------------------------------------------------
    // Phase 4 tests.
    // -----------------------------------------------------------------------

    /// Helper: load the persisted config straight from disk.
    async fn load_config(app_home: &Path) -> Config {
        Config::load(&app_home.join("config.json"))
            .await
            .expect("load config")
    }

    #[tokio::test]
    async fn write_config_partial_only_updates_present_fields() {
        let env = make_env().await;

        // Seed a recent_projects list we can verify is preserved.
        {
            let mut c = load_config(&env.app_home).await;
            c.recent_projects = vec!["/tmp/keep-me".to_string()];
            c.hidden_target_ids = vec!["claude-global".to_string()];
            c.save(&env.app_home.join("config.json")).await.unwrap();
        }

        // Now only update hidden_target_ids; recent_projects must stay.
        write_config_impl(
            None,
            None,
            None,
            None,
            Some(vec!["codex-global".to_string()]),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("write_config");

        let after = load_config(&env.app_home).await;
        assert_eq!(after.recent_projects, vec!["/tmp/keep-me".to_string()]);
        assert_eq!(after.hidden_target_ids, vec!["codex-global".to_string()]);
        // Custom targets must be unchanged (still the one from make_env).
        assert_eq!(after.custom_targets.len(), 1);
    }

    #[tokio::test]
    async fn add_project_dedupes_against_existing() {
        let env = make_env().await;
        let proj = env._root.path().join("manual-proj");
        fs::create_dir_all(&proj).await.unwrap();

        // First add.
        add_project_impl(
            proj.to_string_lossy().into_owned(),
            Some("First".to_string()),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("first add");

        // Second add of the same project — should not duplicate.
        let state = add_project_impl(
            proj.to_string_lossy().into_owned(),
            Some("Second".to_string()),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("second add");

        let matching: Vec<&ProjectRecord> = state
            .projects
            .iter()
            .filter(|p| p.path == proj.to_string_lossy())
            .collect();
        assert_eq!(matching.len(), 1, "project should be deduped");
        // Manual entries keep their original source.
        assert_eq!(matching[0].source, "manual");
    }

    #[tokio::test]
    async fn remove_project_drops_from_list_and_recent() {
        let env = make_env().await;
        let proj = env._root.path().join("to-remove");
        fs::create_dir_all(&proj).await.unwrap();

        add_project_impl(
            proj.to_string_lossy().into_owned(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        // Sanity: it's present.
        let before = load_config(&env.app_home).await;
        assert!(before.projects.iter().any(|v| v
            .get("path")
            .and_then(|p| p.as_str())
            .map(|s| s == proj.to_string_lossy())
            .unwrap_or(false)));

        remove_project_impl(
            proj.to_string_lossy().into_owned(),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("remove");

        let after = load_config(&env.app_home).await;
        assert!(!after.projects.iter().any(|v| v
            .get("path")
            .and_then(|p| p.as_str())
            .map(|s| s == proj.to_string_lossy())
            .unwrap_or(false)));
    }

    #[tokio::test]
    async fn clear_scanned_projects_keeps_manual_projects() {
        let env = make_env().await;

        // Seed a mix of manual + scan projects directly into the config.
        {
            let mut c = load_config(&env.app_home).await;
            c.projects = vec![
                serde_json::json!({
                    "path": "/tmp/manual-1",
                    "name": "manual-1",
                    "source": "manual",
                }),
                serde_json::json!({
                    "path": "/tmp/scan-1",
                    "name": "scan-1",
                    "source": "scan",
                }),
                serde_json::json!({
                    "path": "/tmp/scan-2",
                    "name": "scan-2",
                    "source": "scan",
                }),
            ];
            c.save(&env.app_home.join("config.json")).await.unwrap();
        }

        clear_scanned_projects_impl(None, Some(env.app_home.clone()))
            .await
            .expect("clear");

        let after = load_config(&env.app_home).await;
        let paths: Vec<String> = after
            .projects
            .iter()
            .map(|v| {
                v.get("path")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert!(paths.contains(&"/tmp/manual-1".to_string()));
        assert!(!paths.contains(&"/tmp/scan-1".to_string()));
        assert!(!paths.contains(&"/tmp/scan-2".to_string()));
    }

    #[tokio::test]
    async fn find_project_skill_sources_finds_known_dirs() {
        use crate::backend::projects::find_project_skill_sources;

        let dir = TempDir::new().unwrap();
        let project = dir.path().join("proj");
        // Standard `skills/` with one skill.
        let s1 = project.join("skills").join("a");
        fs::create_dir_all(&s1).await.unwrap();
        fs::write(s1.join("SKILL.md"), "---\nname: a\n---\n").await.unwrap();
        // .claude/skills/ with one skill.
        let s2 = project.join(".claude").join("skills").join("b");
        fs::create_dir_all(&s2).await.unwrap();
        fs::write(s2.join("SKILL.md"), "---\nname: b\n---\n").await.unwrap();

        let sources = find_project_skill_sources(&project).await;
        assert_eq!(sources.len(), 2, "should find skills/ and .claude/skills/");
        assert!(sources
            .iter()
            .any(|s| s.path.ends_with("skills") && !s.path.contains(".claude")));
        assert!(sources.iter().any(|s| s.path.contains(".claude")));
    }

    // -----------------------------------------------------------------------
    // Phase 5 tests.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn import_skills_moves_into_vault() {
        let env = make_env().await;
        let source = env._root.path().join("src");
        let skill_dir = source.join("my-skill");
        fs::create_dir_all(&skill_dir).await.unwrap();
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: My Skill\ndescription: hello\n---\n\nbody\n",
        )
        .await
        .unwrap();

        let result = import_skills_impl(
            source.to_string_lossy().into_owned(),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("import_skills");

        assert_eq!(result.imported.len(), 1);
        assert!(result.skipped.is_empty());
        // Source is gone (moved).
        assert!(!skill_dir.exists());
        // Vault has it (safe_segment("My Skill") -> "my-skill").
        assert!(env.vault.join("my-skill").join(SKILL_FILE).is_file());
        // State reflects the new skill.
        assert!(result.state.skills.iter().any(|s| s.name == "My Skill"));
    }

    #[tokio::test]
    async fn import_suggested_handles_multiple_sources_with_errors() {
        let env = make_env().await;

        // Source 1: a real skill that will import successfully.
        let good = env._root.path().join("good");
        let good_skill = good.join("a");
        fs::create_dir_all(&good_skill).await.unwrap();
        fs::write(
            good_skill.join(SKILL_FILE),
            "---\nname: GoodA\ndescription: x\n---\n",
        )
        .await
        .unwrap();

        // Source 2: a directory with no SKILL.md (should produce a skip).
        let empty = env._root.path().join("empty");
        fs::create_dir_all(&empty).await.unwrap();

        // Source 3: a path that does not exist (skip with "Path does not exist").
        let missing = env._root.path().join("ghost");

        let result = import_suggested_skills_impl(
            vec![
                good.to_string_lossy().into_owned(),
                empty.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
            ],
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("import_suggested");

        // 1 imported (from `good`), at least 2 skipped (empty + missing).
        assert_eq!(result.report.imported, 1);
        assert!(result.report.skipped >= 2);
        // Vault has the good skill.
        assert!(env.vault.join("gooda").join(SKILL_FILE).is_file()
            || result
                .state
                .skills
                .iter()
                .any(|s| s.name == "GoodA"));
    }

    #[tokio::test]
    async fn import_suggested_dedupes_repeated_paths() {
        let env = make_env().await;
        let source = env._root.path().join("dupe");
        let skill_dir = source.join("a");
        fs::create_dir_all(&skill_dir).await.unwrap();
        fs::write(
            skill_dir.join(SKILL_FILE),
            "---\nname: A\n---\n",
        )
        .await
        .unwrap();

        let path_str = source.to_string_lossy().into_owned();
        let result = import_suggested_skills_impl(
            vec![path_str.clone(), path_str],
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("dedupe");
        // Even though the path was provided twice, we should only have
        // imported once.
        assert_eq!(result.report.imported, 1);
    }
}
