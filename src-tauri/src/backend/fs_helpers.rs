//! Filesystem helpers shared by the skill CRUD / bulk operations.
//!
//! Mirrors `copyDirectory`, `moveDirectory`, and `uniqueSkillDestination`
//! from `src/core.js`. Directory traversal skips `.git` and `node_modules`
//! to match the JS behavior.

use std::path::{Path, PathBuf};

use tokio::fs;

use super::state::{BackendError, BackendResult};

const SKIP_DIRS: &[&str] = &[".git", "node_modules"];

fn should_skip(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| *s == name)
}

/// Recursively copy `from` into `to`. Errors when `to` already exists, to
/// match `fs.cp({ errorOnExist: true })` in `core.js::copyDirectory`. The
/// `.git` / `node_modules` filter matches the JS implementation.
pub async fn copy_directory(from: &Path, to: &Path) -> BackendResult<()> {
    if fs::try_exists(to).await.unwrap_or(false) {
        return Err(BackendError::Validation(format!(
            "destination already exists: {}",
            to.display()
        )));
    }
    let from = from.to_path_buf();
    let to = to.to_path_buf();
    tokio::task::spawn_blocking(move || copy_dir_blocking(&from, &to))
        .await
        .map_err(|err| BackendError::Validation(format!("copy join error: {err}")))?
}

fn copy_dir_blocking(from: &Path, to: &Path) -> BackendResult<()> {
    let meta = std::fs::symlink_metadata(from)?;
    let file_type = meta.file_type();

    if file_type.is_symlink() {
        // Re-create symlinks rather than copying their targets, mirroring
        // what `fs.cp` does by default (it would clone the link). We use
        // `read_link` + `symlink` so a vault skill that points elsewhere
        // is preserved.
        let target = std::fs::read_link(from)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, to)?;
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, to)?;
            } else {
                std::os::windows::fs::symlink_file(&target, to)?;
            }
        }
        return Ok(());
    }

    if file_type.is_file() {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
        return Ok(());
    }

    if file_type.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if should_skip(&name_str) {
                continue;
            }
            let src = entry.path();
            let dst = to.join(&name);
            copy_dir_blocking(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
const CROSS_DEVICE_ERROR: i32 = libc::EXDEV;
#[cfg(windows)]
const CROSS_DEVICE_ERROR: i32 = 17; // ERROR_NOT_SAME_DEVICE

/// Move (rename) a directory. Falls back to copy + delete when the rename
/// crosses a filesystem boundary. Mirrors `core.js::moveDirectory`.
pub async fn move_directory(from: &Path, to: &Path) -> BackendResult<()> {
    match fs::rename(from, to).await {
        Ok(()) => Ok(()),
        Err(err) => {
            let crosses_devices = err.raw_os_error() == Some(CROSS_DEVICE_ERROR);
            if !crosses_devices {
                return Err(BackendError::Io(err));
            }
            copy_directory(from, to).await?;
            fs::remove_dir_all(from).await?;
            Ok(())
        }
    }
}

/// Produce a vault-relative destination path that does not collide with an
/// existing entry. Mirrors `core.js::uniqueSkillDestination`.
pub async fn unique_skill_destination(root: &Path, name: &str) -> PathBuf {
    let base = super::skills::safe_segment(name);
    let mut candidate = root.join(&base);
    let mut index = 2u32;
    while fs::try_exists(&candidate).await.unwrap_or(false) {
        candidate = root.join(format!("{base}-{index}"));
        index += 1;
    }
    candidate
}

