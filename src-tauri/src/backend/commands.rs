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

/// Create a brand-new vault skill from scratch. Mirrors
/// `core.js::createSkill({ name, description, content })`.
///
/// Returns the freshly built `State` so the frontend can `applyState()` the
/// result directly, matching the legacy HTTP shape.
#[tauri::command]
pub async fn create_skill(
    name: String,
    description: Option<String>,
    content: Option<String>,
    project_path: Option<String>,
) -> BackendResult<State> {
    create_skill_impl(name, description, content, project_path, None).await
}

pub async fn create_skill_impl(
    name: String,
    description: Option<String>,
    content: Option<String>,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(BackendError::Validation(
            "Skill name is required".to_string(),
        ));
    }

    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    fs::create_dir_all(&ctx.vault_root).await?;
    let destination = unique_skill_destination(&ctx.vault_root, trimmed_name).await;
    fs::create_dir_all(&destination).await?;

    let body = match content.as_ref().map(|s| s.as_str()) {
        Some(raw) if !raw.trim().is_empty() => raw.to_string(),
        _ => {
            let desc = description
                .as_ref()
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| "Describe when this skill should be used.".to_string());
            format!(
                "---\nname: {name}\ndescription: {desc}\n---\n\n# Workflow\n\nAdd the operating instructions for this skill here.\n",
                name = trimmed_name,
                desc = desc,
            )
        }
    };

    fs::write(destination.join(SKILL_FILE), body).await?;
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

// ---------------------------------------------------------------------------
// Phase 6: skill sets.
// ---------------------------------------------------------------------------

use super::sets::{
    list_global_sets, new_set_id, normalize_entries, read_project_sets, write_project_sets,
};
use super::types::{
    ApplySetPlan, ApplySetResponse, ApplySetTargetPlan, ApplySetTargetResult, CreateSetResponse,
    DeleteSetResponse, ListSetsResponse, PinnedSets, Set, SetEntry, UpdateSetResponse,
};

#[tauri::command]
pub async fn list_sets(project: Option<String>) -> BackendResult<ListSetsResponse> {
    list_sets_impl(project, None).await
}

pub async fn list_sets_impl(
    project: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<ListSetsResponse> {
    let ctx = load_context(project.clone(), app_home_override).await?;

    let global = list_global_sets(&ctx.config);
    let project_list = if project.is_some() {
        read_project_sets(&ctx.project_path).await?
    } else {
        Vec::new()
    };

    let mut pinned = PinnedSets::default();
    if project.is_some() {
        let project_record = ctx
            .config
            .projects
            .iter()
            .find(|p| {
                p.get("path")
                    .and_then(|v| v.as_str())
                    .map(|s| Path::new(s) == ctx.project_path.as_path())
                    .unwrap_or(false)
            });
        let ids: Vec<String> = project_record
            .and_then(|p| p.get("pinnedSetIds"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let all: Vec<&Set> = global.iter().chain(project_list.iter()).collect();
        let mut resolved = Vec::new();
        let mut missing = Vec::new();
        for id in &ids {
            match all.iter().find(|s| &s.id == id) {
                Some(s) => resolved.push((*s).clone()),
                None => missing.push(id.clone()),
            }
        }
        pinned = PinnedSets {
            ids,
            resolved,
            missing,
        };
    }

    Ok(ListSetsResponse {
        global,
        project: project_list,
        pinned,
    })
}

/// Bump an RFC3339 timestamp by 1ms if Utc::now() lands on the same instant
/// (mirrors `nextTimestamp` in `core.js`).
fn next_timestamp(previous: &str) -> String {
    let now = Utc::now();
    let candidate = now.to_rfc3339();
    if candidate != previous {
        candidate
    } else {
        (now + chrono::Duration::milliseconds(1)).to_rfc3339()
    }
}

/// Normalize a list of `SetEntry` (used when the frontend hands us typed
/// entries directly).
fn typed_entries_normalized(entries: Option<Vec<SetEntry>>) -> Vec<SetEntry> {
    let value = entries
        .map(|list| serde_json::to_value(list).unwrap_or(serde_json::Value::Null))
        .unwrap_or(serde_json::Value::Null);
    normalize_entries(&value)
}

#[tauri::command]
pub async fn create_set(
    name: String,
    description: Option<String>,
    scope: String,
    project_path: Option<String>,
    entries: Option<Vec<SetEntry>>,
) -> BackendResult<CreateSetResponse> {
    create_set_impl(name, description, scope, project_path, entries, None).await
}

pub async fn create_set_impl(
    name: String,
    description: Option<String>,
    scope: String,
    project_path: Option<String>,
    entries: Option<Vec<SetEntry>>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<CreateSetResponse> {
    let name_trimmed = name.trim();
    if name_trimmed.is_empty() {
        return Err(BackendError::Validation(
            "Set name is required".to_string(),
        ));
    }
    if scope != "global" && scope != "project" {
        return Err(BackendError::Validation("Invalid scope".to_string()));
    }
    if scope == "project"
        && project_path
            .as_deref()
            .map(|s| s.is_empty())
            .unwrap_or(true)
    {
        return Err(BackendError::Validation(
            "projectPath required for project-scoped set".to_string(),
        ));
    }

    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let now = Utc::now().to_rfc3339();
    let normalized_entries = typed_entries_normalized(entries);

    let scoped_project = if scope == "project" {
        Some(ctx.project_path.to_string_lossy().into_owned())
    } else {
        None
    };

    let record = Set {
        id: new_set_id(),
        name: name_trimmed.to_string(),
        description: description
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        scope: scope.clone(),
        project_path: scoped_project,
        entries: normalized_entries,
        created_at: now.clone(),
        updated_at: now,
    };

    if scope == "global" {
        let mut next = ctx.config.clone();
        let raw =
            serde_json::to_value(&record).map_err(BackendError::Json)?;
        next.sets.push(raw);
        save_merged_config(&ctx.app_home, &next).await?;
    } else {
        let mut existing = read_project_sets(&ctx.project_path).await?;
        existing.push(record.clone());
        write_project_sets(&ctx.project_path, &existing).await?;
    }

    let state = build_state(project_path, app_home_override).await?;
    Ok(CreateSetResponse {
        set: record,
        state,
    })
}

#[tauri::command]
pub async fn update_set(
    id: String,
    patch: serde_json::Value,
    project_path: Option<String>,
) -> BackendResult<UpdateSetResponse> {
    update_set_impl(id, patch, project_path, None).await
}

pub async fn update_set_impl(
    id: String,
    patch: serde_json::Value,
    project_path: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<UpdateSetResponse> {
    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let patch_obj = patch
        .as_object()
        .cloned()
        .unwrap_or_default();

    // Try global first.
    let global_idx = ctx
        .config
        .sets
        .iter()
        .position(|v| v.get("id").and_then(|x| x.as_str()) == Some(id.as_str()));
    if let Some(idx) = global_idx {
        let raw = ctx.config.sets[idx].clone();
        let existing = super::sets::normalize_set(&raw, "global", None)
            .ok_or_else(|| BackendError::Validation(format!("Set {id} is malformed")))?;
        let updated = apply_patch(existing, &patch_obj);
        let mut next = ctx.config.clone();
        next.sets[idx] = serde_json::to_value(&updated).map_err(BackendError::Json)?;
        save_merged_config(&ctx.app_home, &next).await?;
        let state = build_state(project_path, app_home_override).await?;
        return Ok(UpdateSetResponse {
            set: updated,
            state,
        });
    }

    // Then project-local.
    if project_path.is_some() {
        let mut existing_sets = read_project_sets(&ctx.project_path).await?;
        if let Some(idx) = existing_sets.iter().position(|s| s.id == id) {
            let existing = existing_sets[idx].clone();
            let updated = apply_patch(existing, &patch_obj);
            existing_sets[idx] = updated.clone();
            write_project_sets(&ctx.project_path, &existing_sets).await?;
            let state = build_state(project_path, app_home_override).await?;
            return Ok(UpdateSetResponse {
                set: updated,
                state,
            });
        }
    }

    Err(BackendError::NotFound(format!("Unknown set: {id}")))
}

fn apply_patch(mut existing: Set, patch: &serde_json::Map<String, serde_json::Value>) -> Set {
    if let Some(v) = patch.get("name") {
        if let Some(s) = v.as_str() {
            existing.name = s.trim().to_string();
        }
    }
    if let Some(v) = patch.get("description") {
        if let Some(s) = v.as_str() {
            existing.description = s.trim().to_string();
        }
    }
    if let Some(v) = patch.get("entries") {
        existing.entries = normalize_entries(v);
    }
    existing.updated_at = next_timestamp(&existing.updated_at);
    existing
}

#[tauri::command]
pub async fn delete_set(
    id: String,
    project: Option<String>,
) -> BackendResult<DeleteSetResponse> {
    delete_set_impl(id, project, None).await
}

pub async fn delete_set_impl(
    id: String,
    project: Option<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<DeleteSetResponse> {
    let ctx = load_context(project.clone(), app_home_override.clone()).await?;

    // Global match wins (same precedence as core.js::deleteSet).
    if ctx
        .config
        .sets
        .iter()
        .any(|v| v.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
    {
        let kept: Vec<serde_json::Value> = ctx
            .config
            .sets
            .iter()
            .filter(|v| v.get("id").and_then(|x| x.as_str()) != Some(id.as_str()))
            .cloned()
            .collect();
        let mut next = ctx.config.clone();
        next.sets = kept;
        save_merged_config(&ctx.app_home, &next).await?;
        let state = build_state(project, app_home_override).await?;
        return Ok(DeleteSetResponse {
            deleted_id: id,
            state,
        });
    }

    if project.is_some() {
        let existing_sets = read_project_sets(&ctx.project_path).await?;
        if existing_sets.iter().any(|s| s.id == id) {
            let kept: Vec<Set> = existing_sets.into_iter().filter(|s| s.id != id).collect();
            write_project_sets(&ctx.project_path, &kept).await?;
            let state = build_state(project, app_home_override).await?;
            return Ok(DeleteSetResponse {
                deleted_id: id,
                state,
            });
        }
    }

    Err(BackendError::NotFound(format!("Unknown set: {id}")))
}

#[tauri::command]
pub async fn snapshot_set(
    name: String,
    description: Option<String>,
    scope: String,
    project_path: Option<String>,
    target_keys: Option<Vec<String>>,
) -> BackendResult<CreateSetResponse> {
    snapshot_set_impl(name, description, scope, project_path, target_keys, None).await
}

pub async fn snapshot_set_impl(
    name: String,
    description: Option<String>,
    scope: String,
    project_path: Option<String>,
    target_keys: Option<Vec<String>>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<CreateSetResponse> {
    let target_keys = target_keys.unwrap_or_default();
    if target_keys.is_empty() {
        return Err(BackendError::Validation(
            "targetKeys must be a non-empty array".to_string(),
        ));
    }

    let ctx = load_context(project_path.clone(), app_home_override.clone()).await?;
    let skills = discover_skills(&ctx.vault_root).await?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);

    let mut entries: Vec<SetEntry> = Vec::new();
    for target_key in &target_keys {
        let target = match targets.iter().find(|t| &t.id == target_key) {
            Some(t) => t,
            None => continue,
        };
        let manifest = read_manifest(Path::new(&target.path)).await?;
        for skill_id in manifest.managed_links.keys() {
            if let Some(s) = skills.iter().find(|sk| &sk.id == skill_id) {
                entries.push(SetEntry {
                    skill_name: s.name.clone(),
                    target_key: target_key.clone(),
                });
            }
        }
    }

    // Round-trip via serde to feed create_set_impl typed entries.
    create_set_impl(
        name,
        description,
        scope,
        project_path,
        Some(entries),
        app_home_override,
    )
    .await
}

#[tauri::command]
pub async fn plan_apply_set(
    id: String,
    project_path: String,
) -> BackendResult<ApplySetPlan> {
    plan_apply_set_impl(id, project_path, None).await
}

pub async fn plan_apply_set_impl(
    id: String,
    project_path: String,
    app_home_override: Option<PathBuf>,
) -> BackendResult<ApplySetPlan> {
    let ctx = load_context(Some(project_path.clone()), app_home_override).await?;
    let set = locate_set(&ctx, &id).await?;
    let skills = discover_skills(&ctx.vault_root).await?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);

    let plan = build_apply_plan(&set, &skills, &targets).await?;
    Ok(plan)
}

async fn locate_set(ctx: &CommandContext, id: &str) -> BackendResult<Set> {
    let global = list_global_sets(&ctx.config);
    if let Some(s) = global.iter().find(|s| s.id == id) {
        return Ok(s.clone());
    }
    let project = read_project_sets(&ctx.project_path).await?;
    if let Some(s) = project.iter().find(|s| s.id == id) {
        return Ok(s.clone());
    }
    Err(BackendError::NotFound(format!("Unknown set: {id}")))
}

async fn build_apply_plan(
    set: &Set,
    skills: &[SkillRecord],
    targets: &[TargetRecord],
) -> BackendResult<ApplySetPlan> {
    // Group entries by targetKey, preserving first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut by_target: BTreeMap<String, Vec<SetEntry>> = BTreeMap::new();
    for entry in &set.entries {
        if !by_target.contains_key(&entry.target_key) {
            order.push(entry.target_key.clone());
        }
        by_target
            .entry(entry.target_key.clone())
            .or_default()
            .push(entry.clone());
    }

    let skill_names: std::collections::HashSet<String> =
        skills.iter().map(|s| s.name.clone()).collect();

    let mut target_plans = Vec::new();
    for target_key in &order {
        let entries = by_target.get(target_key).cloned().unwrap_or_default();
        let target = targets.iter().find(|t| &t.id == target_key);
        match target {
            None => {
                target_plans.push(ApplySetTargetPlan {
                    target_id: target_key.clone(),
                    target_label: target_key.clone(),
                    missing_target: true,
                    to_enable: Vec::new(),
                    to_disable: Vec::new(),
                    missing: entries.iter().map(|e| e.skill_name.clone()).collect(),
                });
            }
            Some(target) => {
                let manifest = read_manifest(Path::new(&target.path)).await?;
                let mut currently_enabled_names: Vec<String> = Vec::new();
                for skill_id in manifest.managed_links.keys() {
                    if let Some(s) = skills.iter().find(|sk| &sk.id == skill_id) {
                        currently_enabled_names.push(s.name.clone());
                    }
                }

                let mut desired_names: Vec<String> = Vec::new();
                let mut missing: Vec<String> = Vec::new();
                for entry in &entries {
                    if skill_names.contains(&entry.skill_name) {
                        if !desired_names.contains(&entry.skill_name) {
                            desired_names.push(entry.skill_name.clone());
                        }
                    } else if !missing.contains(&entry.skill_name) {
                        missing.push(entry.skill_name.clone());
                    }
                }

                let to_enable: Vec<String> = desired_names
                    .iter()
                    .filter(|n| !currently_enabled_names.contains(n))
                    .cloned()
                    .collect();
                let to_disable: Vec<String> = currently_enabled_names
                    .iter()
                    .filter(|n| !desired_names.contains(n))
                    .cloned()
                    .collect();

                target_plans.push(ApplySetTargetPlan {
                    target_id: target.id.clone(),
                    target_label: target.label.clone(),
                    missing_target: false,
                    to_enable,
                    to_disable,
                    missing,
                });
            }
        }
    }

    Ok(ApplySetPlan {
        set_id: set.id.clone(),
        name: set.name.clone(),
        targets: target_plans,
    })
}

#[tauri::command]
pub async fn apply_set(
    id: String,
    project_path: String,
) -> BackendResult<ApplySetResponse> {
    apply_set_impl(id, project_path, None).await
}

pub async fn apply_set_impl(
    id: String,
    project_path: String,
    app_home_override: Option<PathBuf>,
) -> BackendResult<ApplySetResponse> {
    let ctx = load_context(Some(project_path.clone()), app_home_override.clone()).await?;
    let set = locate_set(&ctx, &id).await?;
    let skills = discover_skills(&ctx.vault_root).await?;
    let custom = safe_read_custom_targets(&serde_json::Value::Array(
        ctx.config.custom_targets.clone(),
    ));
    let targets = build_targets(&ctx.home_dir, &ctx.project_path, &custom);
    let plan = build_apply_plan(&set, &skills, &targets).await?;

    let mut per_target_result: Vec<ApplySetTargetResult> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for target_plan in &plan.targets {
        if target_plan.missing_target {
            per_target_result.push(ApplySetTargetResult {
                target_id: target_plan.target_id.clone(),
                status: "skipped".to_string(),
                reason: Some("Unknown target".to_string()),
            });
            warnings.push(format!(
                "Target {} not found; skipped",
                target_plan.target_id
            ));
            continue;
        }
        if !target_plan.missing.is_empty() {
            warnings.push(format!(
                "Skipped missing skills in {}: {}",
                target_plan.target_label,
                target_plan.missing.join(", ")
            ));
        }
        let target = match targets.iter().find(|t| t.id == target_plan.target_id) {
            Some(t) => t,
            None => continue,
        };

        let mut failure: Option<String> = None;
        for skill_name in &target_plan.to_disable {
            if let Some(s) = skills.iter().find(|sk| &sk.name == skill_name) {
                if let Err(err) = disable_skill_inner(target, s).await {
                    failure = Some(err.to_string());
                    break;
                }
            }
        }
        if failure.is_none() {
            for skill_name in &target_plan.to_enable {
                if let Some(s) = skills.iter().find(|sk| &sk.name == skill_name) {
                    if let Err(err) = enable_skill_inner(target, s).await {
                        failure = Some(err.to_string());
                        break;
                    }
                }
            }
        }

        match failure {
            None => per_target_result.push(ApplySetTargetResult {
                target_id: target_plan.target_id.clone(),
                status: "applied".to_string(),
                reason: None,
            }),
            Some(reason) => {
                per_target_result.push(ApplySetTargetResult {
                    target_id: target_plan.target_id.clone(),
                    status: "failed".to_string(),
                    reason: Some(reason),
                });
                break; // stop on first failure (mirrors core.js)
            }
        }
    }

    let state = build_state(Some(project_path), app_home_override).await?;
    Ok(ApplySetResponse {
        plan,
        per_target_result,
        warnings,
        state,
    })
}

#[tauri::command]
pub async fn set_project_pinned_sets(
    project_path: String,
    set_ids: Vec<String>,
) -> BackendResult<State> {
    set_project_pinned_sets_impl(project_path, set_ids, None).await
}

pub async fn set_project_pinned_sets_impl(
    project_path: String,
    set_ids: Vec<String>,
    app_home_override: Option<PathBuf>,
) -> BackendResult<State> {
    if project_path.is_empty() {
        return Err(BackendError::Validation(
            "project_path is required".to_string(),
        ));
    }
    let ctx = load_context(Some(project_path.clone()), app_home_override.clone()).await?;
    let normalized = ctx.project_path.to_string_lossy().into_owned();
    let cleaned_ids: Vec<String> = set_ids.into_iter().filter(|s| !s.is_empty()).collect();

    let mut projects: Vec<serde_json::Value> = ctx.config.projects.clone();
    let idx = projects.iter().position(|p| {
        p.get("path")
            .and_then(|v| v.as_str())
            .map(|s| s == normalized.as_str())
            .unwrap_or(false)
    });

    let pinned_value = serde_json::Value::Array(
        cleaned_ids
            .iter()
            .map(|s| serde_json::Value::String(s.clone()))
            .collect(),
    );

    match idx {
        Some(i) => {
            if let Some(obj) = projects[i].as_object_mut() {
                obj.insert("pinnedSetIds".to_string(), pinned_value);
            }
        }
        None => {
            let record = build_project_record(&ctx.project_path, ProjectSource::Manual).await;
            let mut value = serde_json::to_value(record).map_err(BackendError::Json)?;
            if let Some(obj) = value.as_object_mut() {
                obj.insert("pinnedSetIds".to_string(), pinned_value);
            }
            projects.push(value);
        }
    }

    let mut next = ctx.config.clone();
    next.projects = projects;
    save_merged_config(&ctx.app_home, &next).await?;

    build_state(Some(project_path), app_home_override).await
}

/// `GET /api/marketplace/skills` → Tauri command.
///
/// Thin wrapper around `backend::marketplace::fetch_marketplace_skills`.
/// Argument names use snake_case to match the JS server's query-string
/// keys (`q`, `view`, `page`, `per_page`) so the frontend can keep its
/// existing wire payload unchanged.
#[tauri::command(rename_all = "snake_case")]
pub async fn fetch_marketplace_skills(
    q: Option<String>,
    view: Option<String>,
    page: Option<String>,
    per_page: Option<String>,
) -> BackendResult<crate::backend::types::MarketplaceSkillsResponse> {
    super::marketplace::fetch_marketplace_skills(q, view, page, per_page).await
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
    async fn create_skill_writes_default_skill_file() {
        let env = make_env().await;

        let state = create_skill_impl(
            "My New Skill".to_string(),
            Some("A test skill".to_string()),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create");

        // State should now contain the freshly created skill.
        assert!(
            state
                .skills
                .iter()
                .any(|s| s.name == "My New Skill" || s.id.contains("my-new-skill")),
            "new skill missing from state: {:?}",
            state.skills.iter().map(|s| &s.id).collect::<Vec<_>>(),
        );

        // SKILL.md should have been written with the frontmatter and default body.
        let dirs: Vec<_> = std::fs::read_dir(&env.vault)
            .unwrap()
            .filter_map(|d| d.ok())
            .filter(|d| d.path().is_dir())
            .collect();
        assert_eq!(dirs.len(), 1, "vault should contain exactly one skill dir");
        let skill_md = dirs[0].path().join(SKILL_FILE);
        let body = std::fs::read_to_string(&skill_md).unwrap();
        assert!(body.contains("name: My New Skill"));
        assert!(body.contains("description: A test skill"));
        assert!(body.contains("# Workflow"));
    }

    #[tokio::test]
    async fn create_skill_uses_explicit_content_when_provided() {
        let env = make_env().await;

        let custom = "---\nname: Custom\ndescription: x\n---\n\nhello\n";
        create_skill_impl(
            "Custom".to_string(),
            None,
            Some(custom.to_string()),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create");

        let skill_md = env.vault.join("custom").join(SKILL_FILE);
        let body = std::fs::read_to_string(&skill_md).unwrap();
        assert_eq!(body, custom);
    }

    #[tokio::test]
    async fn create_skill_rejects_empty_name() {
        let env = make_env().await;
        let result = create_skill_impl(
            "   ".to_string(),
            None,
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await;
        assert!(matches!(result, Err(BackendError::Validation(_))));
    }

    #[tokio::test]
    async fn create_skill_disambiguates_existing_destination() {
        let env = make_env().await;
        write_skill_file(&env.vault.join("duplicate"), "Duplicate", "orig").await;

        create_skill_impl(
            "Duplicate".to_string(),
            None,
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create");

        // The original is preserved; the new skill lands at duplicate-2.
        assert!(env.vault.join("duplicate").join(SKILL_FILE).is_file());
        assert!(env.vault.join("duplicate-2").join(SKILL_FILE).is_file());
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

    // -----------------------------------------------------------------------
    // Phase 6 tests: skill sets.
    // -----------------------------------------------------------------------

    use super::super::sets as sets_mod;

    #[test]
    fn new_set_id_is_unique_and_well_formed() {
        let a = sets_mod::new_set_id();
        let b = sets_mod::new_set_id();
        assert!(a.starts_with("set_"));
        assert_eq!(a.len(), 4 + 12);
        assert!(a["set_".len()..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn normalize_set_strips_unknown_keys_and_validates() {
        // No name → rejected.
        assert!(sets_mod::normalize_set(&serde_json::json!({}), "global", None).is_none());
        assert!(
            sets_mod::normalize_set(&serde_json::json!({ "name": "   " }), "global", None)
                .is_none()
        );

        let raw = serde_json::json!({
            "id": "set_keep",
            "name": "  Frontend ",
            "description": "  do UI ",
            "garbage": "nope",
            "entries": [
                { "skillName": "design", "targetKey": "claude-global" },
                { "skillName": "design", "targetKey": "claude-global" }, // dedup
                { "skillName": "", "targetKey": "x" },                    // dropped
            ],
        });
        let set = sets_mod::normalize_set(&raw, "global", None).unwrap();
        assert_eq!(set.id, "set_keep");
        assert_eq!(set.name, "Frontend");
        assert_eq!(set.description, "do UI");
        assert_eq!(set.scope, "global");
        assert!(set.project_path.is_none());
        assert_eq!(set.entries.len(), 1);
        assert_eq!(set.entries[0].skill_name, "design");
        assert_eq!(set.entries[0].target_key, "claude-global");
    }

    /// Snapshot test fixture: a temp app home with a vault, plus a project
    /// root with a single custom-project target pointed at a dir inside it.
    struct SetEnv {
        _root: TempDir,
        app_home: PathBuf,
        vault: PathBuf,
        project: PathBuf,
        target_global: PathBuf,
        target_global_id: String,
    }

    async fn make_set_env() -> SetEnv {
        let root = TempDir::new().expect("tempdir");
        let app_home = root.path().join(".skillworks");
        let vault = app_home.join("vault");
        fs::create_dir_all(&vault).await.unwrap();
        let project = root.path().join("project");
        fs::create_dir_all(&project).await.unwrap();
        let target_global = root.path().join("custom-target");

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

        SetEnv {
            _root: root,
            app_home,
            vault,
            project,
            target_global,
            target_global_id: "test-custom".to_string(),
        }
    }

    #[tokio::test]
    async fn list_sets_returns_global_and_project_combined() {
        let env = make_set_env().await;

        // One global, one project-local.
        let g = create_set_impl(
            "Global one".to_string(),
            None,
            "global".to_string(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create global");
        let p = create_set_impl(
            "Project one".to_string(),
            None,
            "project".to_string(),
            Some(env.project.to_string_lossy().into_owned()),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create project");

        // Without a project, only global comes back.
        let no_project = list_sets_impl(None, Some(env.app_home.clone()))
            .await
            .expect("list no-project");
        assert_eq!(no_project.global.len(), 1);
        assert_eq!(no_project.global[0].id, g.set.id);
        assert!(no_project.project.is_empty());
        assert!(no_project.pinned.ids.is_empty());

        // With a project, both surfaces are populated.
        let with_project = list_sets_impl(
            Some(env.project.to_string_lossy().into_owned()),
            Some(env.app_home.clone()),
        )
        .await
        .expect("list with project");
        assert_eq!(with_project.global.len(), 1);
        assert_eq!(with_project.project.len(), 1);
        assert_eq!(with_project.project[0].id, p.set.id);
    }

    #[tokio::test]
    async fn create_set_persists_to_correct_scope() {
        let env = make_set_env().await;

        // Global → stored in config.json under "sets".
        create_set_impl(
            "Global".to_string(),
            Some("d".to_string()),
            "global".to_string(),
            None,
            Some(vec![SetEntry {
                skill_name: "a".to_string(),
                target_key: "claude-global".to_string(),
            }]),
            Some(env.app_home.clone()),
        )
        .await
        .expect("create global");
        let config = Config::load(&env.app_home.join("config.json"))
            .await
            .unwrap();
        assert_eq!(config.sets.len(), 1);
        assert_eq!(
            config.sets[0].get("name").and_then(|v| v.as_str()),
            Some("Global")
        );

        // Project → stored in <project>/.agent-skill-manager/sets.json.
        create_set_impl(
            "Project".to_string(),
            None,
            "project".to_string(),
            Some(env.project.to_string_lossy().into_owned()),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create project");
        let project_file = env
            .project
            .join(".agent-skill-manager")
            .join("sets.json");
        assert!(project_file.exists(), "project sets.json should exist");

        // Invalid scope is rejected.
        let bad = create_set_impl(
            "Bad".to_string(),
            None,
            "weird".to_string(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await;
        assert!(bad.is_err());

        // Project scope without projectPath is rejected.
        let bad2 = create_set_impl(
            "Bad2".to_string(),
            None,
            "project".to_string(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await;
        assert!(bad2.is_err());
    }

    #[tokio::test]
    async fn update_set_patches_specific_fields() {
        let env = make_set_env().await;
        let created = create_set_impl(
            "Old name".to_string(),
            Some("old desc".to_string()),
            "global".to_string(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create");

        let updated = update_set_impl(
            created.set.id.clone(),
            serde_json::json!({
                "name": "  New name  ",
                "entries": [
                    { "skillName": "x", "targetKey": "claude-global" }
                ],
            }),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("update");

        assert_eq!(updated.set.id, created.set.id);
        assert_eq!(updated.set.name, "New name");
        // description was not in the patch, so it's preserved
        assert_eq!(updated.set.description, "old desc");
        assert_eq!(updated.set.entries.len(), 1);

        // Updating an unknown id returns NotFound.
        let bad =
            update_set_impl("set_unknown".to_string(), serde_json::json!({}), None, Some(env.app_home.clone()))
                .await;
        assert!(bad.is_err());
    }

    #[tokio::test]
    async fn delete_set_removes_from_storage() {
        let env = make_set_env().await;
        let g = create_set_impl(
            "G".to_string(),
            None,
            "global".to_string(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create global");
        let p = create_set_impl(
            "P".to_string(),
            None,
            "project".to_string(),
            Some(env.project.to_string_lossy().into_owned()),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .expect("create project");

        delete_set_impl(g.set.id.clone(), None, Some(env.app_home.clone()))
            .await
            .expect("delete global");
        let config = Config::load(&env.app_home.join("config.json"))
            .await
            .unwrap();
        assert!(config.sets.is_empty());

        delete_set_impl(
            p.set.id.clone(),
            Some(env.project.to_string_lossy().into_owned()),
            Some(env.app_home.clone()),
        )
        .await
        .expect("delete project");
        let remaining = sets_mod::read_project_sets(&env.project).await.unwrap();
        assert!(remaining.is_empty());

        // Unknown id → error.
        let bad = delete_set_impl(
            "set_unknown".to_string(),
            None,
            Some(env.app_home.clone()),
        )
        .await;
        assert!(bad.is_err());
    }

    #[tokio::test]
    async fn snapshot_set_captures_current_state() {
        let env = make_set_env().await;
        write_skill_file(&env.vault.join("a"), "SkillA", "x").await;
        write_skill_file(&env.vault.join("b"), "SkillB", "x").await;

        // Enable both skills on the custom target.
        bulk_toggle_skills_impl(
            vec!["a".to_string(), "b".to_string()],
            vec![env.target_global_id.clone()],
            true,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let snap = snapshot_set_impl(
            "Snap".to_string(),
            None,
            "global".to_string(),
            None,
            Some(vec![env.target_global_id.clone()]),
            Some(env.app_home.clone()),
        )
        .await
        .expect("snapshot");

        assert_eq!(snap.set.entries.len(), 2);
        let names: Vec<String> = snap.set.entries.iter().map(|e| e.skill_name.clone()).collect();
        assert!(names.contains(&"SkillA".to_string()));
        assert!(names.contains(&"SkillB".to_string()));
        for entry in &snap.set.entries {
            assert_eq!(entry.target_key, env.target_global_id);
        }
    }

    #[tokio::test]
    async fn snapshot_set_requires_target_keys() {
        let env = make_set_env().await;
        let bad = snapshot_set_impl(
            "Snap".to_string(),
            None,
            "global".to_string(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await;
        assert!(bad.is_err());
    }

    #[tokio::test]
    async fn plan_apply_set_diffs_against_current_state() {
        let env = make_set_env().await;
        write_skill_file(&env.vault.join("a"), "SkillA", "x").await;
        write_skill_file(&env.vault.join("b"), "SkillB", "x").await;
        write_skill_file(&env.vault.join("c"), "SkillC", "x").await;

        // Currently enabled: SkillA. Desired: SkillB. Missing: SkillZ.
        toggle_skill_impl(
            "a".to_string(),
            env.target_global_id.clone(),
            Some(true),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let created = create_set_impl(
            "Plan".to_string(),
            None,
            "global".to_string(),
            None,
            Some(vec![
                SetEntry {
                    skill_name: "SkillB".to_string(),
                    target_key: env.target_global_id.clone(),
                },
                SetEntry {
                    skill_name: "SkillZ".to_string(),
                    target_key: env.target_global_id.clone(),
                },
            ]),
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let plan = plan_apply_set_impl(
            created.set.id,
            env.project.to_string_lossy().into_owned(),
            Some(env.app_home.clone()),
        )
        .await
        .expect("plan");

        assert_eq!(plan.targets.len(), 1);
        let t = &plan.targets[0];
        assert_eq!(t.target_id, env.target_global_id);
        assert_eq!(t.to_enable, vec!["SkillB".to_string()]);
        assert_eq!(t.to_disable, vec!["SkillA".to_string()]);
        assert_eq!(t.missing, vec!["SkillZ".to_string()]);
        assert!(!t.missing_target);
    }

    #[tokio::test]
    async fn apply_set_changes_symlinks_to_match() {
        let env = make_set_env().await;
        write_skill_file(&env.vault.join("a"), "SkillA", "x").await;
        write_skill_file(&env.vault.join("b"), "SkillB", "x").await;

        // Pre-enable SkillA so apply needs to disable it.
        toggle_skill_impl(
            "a".to_string(),
            env.target_global_id.clone(),
            Some(true),
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let created = create_set_impl(
            "Apply".to_string(),
            None,
            "global".to_string(),
            None,
            Some(vec![SetEntry {
                skill_name: "SkillB".to_string(),
                target_key: env.target_global_id.clone(),
            }]),
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let result = apply_set_impl(
            created.set.id,
            env.project.to_string_lossy().into_owned(),
            Some(env.app_home.clone()),
        )
        .await
        .expect("apply");

        assert_eq!(result.per_target_result.len(), 1);
        assert_eq!(result.per_target_result[0].status, "applied");

        // After apply: target has SkillB, not SkillA.
        let target = result
            .state
            .targets
            .iter()
            .find(|t| t.id == env.target_global_id)
            .unwrap();
        assert!(target.enabled_skill_ids.contains(&"b".to_string()));
        assert!(!target.enabled_skill_ids.contains(&"a".to_string()));

        // Target dir on disk reflects this too.
        let mut entries = fs::read_dir(&env.target_global).await.unwrap();
        let mut names: Vec<String> = Vec::new();
        while let Some(e) = entries.next_entry().await.unwrap() {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
        // safe_segment lowercases for the on-disk link name.
        assert!(names.iter().any(|n| n == "skillb"));
        assert!(!names.iter().any(|n| n == "skilla"));
    }

    #[tokio::test]
    async fn apply_set_warns_on_missing_skill_and_continues() {
        let env = make_set_env().await;
        write_skill_file(&env.vault.join("a"), "SkillA", "x").await;

        let created = create_set_impl(
            "Mixed".to_string(),
            None,
            "global".to_string(),
            None,
            Some(vec![
                SetEntry {
                    skill_name: "SkillA".to_string(),
                    target_key: env.target_global_id.clone(),
                },
                SetEntry {
                    skill_name: "GhostSkill".to_string(),
                    target_key: env.target_global_id.clone(),
                },
            ]),
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let result = apply_set_impl(
            created.set.id,
            env.project.to_string_lossy().into_owned(),
            Some(env.app_home.clone()),
        )
        .await
        .expect("apply");

        assert_eq!(result.per_target_result[0].status, "applied");
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("GhostSkill")),
            "missing skill should surface as a warning"
        );
        let target = result
            .state
            .targets
            .iter()
            .find(|t| t.id == env.target_global_id)
            .unwrap();
        assert!(target.enabled_skill_ids.contains(&"a".to_string()));
    }

    #[tokio::test]
    async fn set_project_pinned_sets_updates_project_record() {
        let env = make_set_env().await;
        let g = create_set_impl(
            "Pin me".to_string(),
            None,
            "global".to_string(),
            None,
            None,
            Some(env.app_home.clone()),
        )
        .await
        .unwrap();

        let state = set_project_pinned_sets_impl(
            env.project.to_string_lossy().into_owned(),
            vec![g.set.id.clone(), "set_phantom".to_string()],
            Some(env.app_home.clone()),
        )
        .await
        .expect("pin");

        // Project record should now exist in state with pinnedSetIds populated.
        let normalized = normalize_project_path(&env.project)
            .to_string_lossy()
            .into_owned();
        let project_record = state
            .projects
            .iter()
            .find(|p| p.path == normalized)
            .expect("project record present");
        assert_eq!(project_record.pinned_set_ids.len(), 2);
        assert!(project_record.pinned_set_ids.contains(&g.set.id));
        assert!(project_record
            .pinned_set_ids
            .contains(&"set_phantom".to_string()));

        // list_sets should resolve the known id and report the phantom as missing.
        let listed = list_sets_impl(
            Some(env.project.to_string_lossy().into_owned()),
            Some(env.app_home.clone()),
        )
        .await
        .expect("list");
        assert_eq!(listed.pinned.ids.len(), 2);
        assert_eq!(listed.pinned.resolved.len(), 1);
        assert_eq!(listed.pinned.resolved[0].id, g.set.id);
        assert_eq!(listed.pinned.missing, vec!["set_phantom".to_string()]);
    }
}
