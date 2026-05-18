#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::CommandEvent;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

pub mod backend;

pub struct DesktopServer(pub Mutex<Option<CommandChild>>);

impl Drop for DesktopServer {
    fn drop(&mut self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopServer(Mutex::new(None)))
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
        ])
        .setup(|_app| {
            #[cfg(not(debug_assertions))]
            start_server_sidecar(_app);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Skillworks desktop")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let server = app_handle.state::<DesktopServer>();
                if let Ok(mut child) = server.0.lock() {
                    if let Some(c) = child.take() {
                        let _ = c.kill();
                    }
                };
            }
        });
}

#[cfg(not(debug_assertions))]
fn start_server_sidecar(app: &mut tauri::App) {
    let sidecar = app
        .shell()
        .sidecar("skillworks-server")
        .expect("failed to create Skillworks server sidecar command");
    let (mut rx, child) = sidecar
        .args(["--host", "127.0.0.1", "--port", "5179"])
        .spawn()
        .expect("failed to start Skillworks server sidecar");

    let state = app.state::<DesktopServer>();
    *state.0.lock().expect("desktop server state poisoned") = Some(child);

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[skillworks-server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[skillworks-server] {}", String::from_utf8_lossy(&line));
                }
                _ => {}
            }
        }
    });
}
