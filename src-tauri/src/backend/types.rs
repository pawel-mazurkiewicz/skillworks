//! DTOs that travel over IPC between the Tauri Rust backend and the
//! JavaScript frontend. Filled in across later phases of the Rust backend
//! refactor (see `docs/superpowers/plans/2026-05-19-rust-backend-refactor.md`).
//!
//! All structs in this module should derive `serde::Serialize` /
//! `serde::Deserialize` with `#[serde(rename_all = "camelCase")]` so the JS
//! field names stay unchanged across the port.
