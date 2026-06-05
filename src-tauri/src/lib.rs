#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod backend;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            backend::commands::get_state,
            backend::commands::read_skill_file,
            backend::commands::save_skill_file,
            backend::commands::toggle_skill,
            backend::commands::bulk_toggle_skills,
            backend::commands::bulk_copy_skills,
            backend::commands::bulk_move_skills,
            backend::commands::bulk_delete_skills,
            backend::commands::find_vault_duplicates,
            backend::commands::dedupe_vault_skills,
            backend::commands::write_config,
            backend::commands::add_project,
            backend::commands::remove_project,
            backend::commands::clear_scanned_projects,
            backend::commands::scan_projects,
            backend::commands::pick_directory,
            backend::commands::import_skills,
            backend::commands::import_suggested_skills,
            backend::commands::preview_git_install,
            backend::commands::install_from_git,
            backend::commands::list_sets,
            backend::commands::create_set,
            backend::commands::update_set,
            backend::commands::delete_set,
            backend::commands::snapshot_set,
            backend::commands::plan_apply_set,
            backend::commands::apply_set,
            backend::commands::set_project_pinned_sets,
            backend::commands::fetch_marketplace_skills,
            backend::commands::create_skill,
            backend::commands::mcp_registration_status,
            backend::commands::register_mcp_server,
            backend::commands::unregister_mcp_server,
            backend::commands::mcp_manual_snippet,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skillworks desktop");
}
