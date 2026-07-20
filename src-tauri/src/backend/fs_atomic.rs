use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use super::state::{BackendError, BackendResult};

/// Atomically write `value` as pretty-printed JSON to `path`.
///
/// Mirrors `writeJson` in `src/core.js`: write to a sibling temp file in the
/// same directory, fsync the contents to disk, then rename over the target.
/// The rename is atomic on the same filesystem, so readers either see the
/// previous file or the new one — never a half-written intermediate.
pub async fn write_json_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> BackendResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| BackendError::Validation(format!("path has no parent: {}", path.display())))?;

    fs::create_dir_all(parent).await?;

    // Suffix the temp filename with the pid for the same reason core.js does:
    // crash-safety across concurrent writers under the same app home.
    let pid = std::process::id();
    let file_name = path
        .file_name()
        .ok_or_else(|| BackendError::Validation(format!("path has no file name: {}", path.display())))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(format!(".{}.tmp", pid));
    let tmp_path = parent.join(&tmp_name);

    let mut payload = serde_json::to_vec_pretty(value)?;
    payload.push(b'\n');

    {
        let mut file = fs::File::create(&tmp_path).await?;
        file.write_all(&payload).await?;
        file.flush().await?;
        file.sync_all().await?;
    }

    if let Err(err) = fs::rename(&tmp_path, path).await {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(err.into());
    }

    Ok(())
}

/// Atomically write raw bytes to `path` using the same temp-then-rename strategy
/// as [`write_json_atomic`]. Used for non-JSON config files (e.g. TOML).
pub async fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> BackendResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| BackendError::Validation(format!("path has no parent: {}", path.display())))?;

    fs::create_dir_all(parent).await?;

    let pid = std::process::id();
    let file_name = path
        .file_name()
        .ok_or_else(|| BackendError::Validation(format!("path has no file name: {}", path.display())))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(format!(".{}.tmp", pid));
    let tmp_path = parent.join(&tmp_name);

    {
        let mut file = fs::File::create(&tmp_path).await?;
        file.write_all(bytes).await?;
        file.flush().await?;
        file.sync_all().await?;
    }

    if let Err(err) = fs::rename(&tmp_path, path).await {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(err.into());
    }

    Ok(())
}

/// Copy an existing config file to a timestamped sibling before we modify it,
/// so a user can recover their previous harness config. No-op when the file
/// does not yet exist (a fresh registration creating the file). Returns the
/// backup path when one was written.
pub async fn backup_existing(path: &Path) -> BackendResult<Option<PathBuf>> {
    if !fs::try_exists(path).await.unwrap_or(false) {
        return Ok(None);
    }
    let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let backup_path = path.with_file_name(format!("{file_name}.skillworks-backup-{timestamp}"));
    fs::copy(path, &backup_path).await?;
    Ok(Some(backup_path))
}
