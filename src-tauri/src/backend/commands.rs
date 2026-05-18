use super::state::BackendError;

/// Stubbed scaffold for `get_state`. Phase 2 of the Rust backend refactor
/// will replace this with a real implementation that composes skill,
/// target, and project data into the same shape as the JS server's
/// `GET /api/state` response.
#[tauri::command]
pub async fn get_state(project: Option<String>) -> Result<serde_json::Value, BackendError> {
    Ok(serde_json::json!({
        "appHome": "/tmp/stub",
        "configPath": "/tmp/stub/config.json",
        "vaultRoot": "/tmp/stub/vault",
        "project": { "path": project.unwrap_or_default() },
        "skills": [],
        "targets": [],
        "projects": [],
        "recentProjects": [],
    }))
}
