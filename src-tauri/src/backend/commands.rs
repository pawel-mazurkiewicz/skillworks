//! Tauri command surface for the Rust backend.
//!
//! Each `#[tauri::command]` here is invokable from the frontend via
//! `@tauri-apps/api`'s `invoke()`. The goal during the JS → Rust migration is
//! to keep the JSON shape identical to the existing `src/server.js` HTTP
//! responses so the frontend can swap transports without changes.

use std::path::{Path, PathBuf};

use tokio::fs;

use super::config::Config;
use super::projects::{
    build_project_record, expand_home, normalize_project_path, normalize_project_records,
    path_exists,
};
use super::skills::discover_skills;
use super::state::{BackendError, BackendResult};
use super::targets::{build_targets, inspect_target, safe_read_custom_targets};
use super::types::{
    DiscoveryReport, ProjectRecord, ProjectSelection, ProjectSource, State, StateSummary,
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
}
