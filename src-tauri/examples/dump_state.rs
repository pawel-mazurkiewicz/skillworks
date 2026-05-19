//! Phase 2B parity helper: dump `get_state` JSON for an arbitrary app home /
//! project so the result can be diffed against `src/server.js`.
//!
//! Usage:
//!   cargo run --example dump_state -- <APP_HOME> [PROJECT_PATH]
//!
//! Both environment variables are exported before invocation:
//!   SKILLWORKS_HOME=<app_home>

use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let app_home: PathBuf = args
        .next()
        .map(PathBuf::from)
        .expect("usage: dump_state <APP_HOME> [PROJECT]");
    let project = args.next();

    let state = skillworks_desktop::backend::commands::build_state(project, Some(app_home))
        .await
        .expect("build_state");
    let json = serde_json::to_string_pretty(&state).expect("serialize");
    println!("{json}");
}
