#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct DesktopServer(Mutex<Option<CommandChild>>);

impl Drop for DesktopServer {
    fn drop(&mut self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(DesktopServer(Mutex::new(None)))
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            start_server_sidecar(app);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Skillworks desktop");
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
