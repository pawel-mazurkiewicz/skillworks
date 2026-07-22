use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Utc;
use serde::Serialize;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use super::state::{BackendError, BackendResult};

/// Process-wide counter appended to every temp filename alongside the pid.
/// The pid alone is not enough to make the temp path unique: within a
/// single app process, two concurrent writers targeting the *same* config
/// path (e.g. two `mcp_activate` calls racing on one harness config) would
/// otherwise share one `<file>.<pid>.tmp` name, so one writer's
/// create/write/rename could interleave with another's and either corrupt
/// the temp file or lose one writer's rename. Combining pid + a per-call
/// sequence number guarantees distinct temp paths even when many writers
/// in this process target the same file concurrently.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_tmp_suffix() -> String {
    let pid = std::process::id();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    format!(".{}.{}.tmp", pid, seq)
}

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

    // Suffix the temp filename with the pid + a per-call sequence number so
    // concurrent writers (even within this one process) never share a temp
    // path. See `unique_tmp_suffix` for why the pid alone isn't sufficient.
    let file_name = path
        .file_name()
        .ok_or_else(|| BackendError::Validation(format!("path has no file name: {}", path.display())))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(unique_tmp_suffix());
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

    let file_name = path
        .file_name()
        .ok_or_else(|| BackendError::Validation(format!("path has no file name: {}", path.display())))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(unique_tmp_suffix());
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
    // Millisecond precision keeps the name readable while letting same-second
    // mutations (e.g. a bulk activate/deactivate from the UI) produce distinct
    // backup filenames. A trailing counter guards the residual
    // same-millisecond case so an earlier recovery point is never silently
    // overwritten by `fs::copy`.
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%3fZ").to_string();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let base = format!("{file_name}.skillworks-backup-{timestamp}");
    let mut backup_path = path.with_file_name(&base);
    let mut n = 2;
    while fs::try_exists(&backup_path).await.unwrap_or(false) {
        backup_path = path.with_file_name(format!("{base}-{n}"));
        n += 1;
    }
    fs::copy(path, &backup_path).await?;
    Ok(Some(backup_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_tmp_suffix_never_repeats_within_a_process() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let suffix = unique_tmp_suffix();
            assert!(seen.insert(suffix), "temp suffix collided");
        }
    }

    /// Regression test for the shared-temp-file race: many tasks
    /// concurrently `write_json_atomic`-ing the *same* path (same pid, same
    /// target file) must never collide on the temp filename. Before the
    /// per-call sequence number, all these writers shared one
    /// `<file>.<pid>.tmp` path and could race the create/write/rename
    /// cycle; every write below should land cleanly with the file always
    /// containing one complete, valid JSON document afterwards.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_writes_to_same_path_never_corrupt_or_race() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("shared.json");

        let mut handles = Vec::new();
        for i in 0..64u32 {
            let path = path.clone();
            handles.push(tokio::spawn(async move {
                write_json_atomic(&path, &serde_json::json!({"writer": i})).await
            }));
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }

        // Whichever writer landed last, the file must be exactly one valid
        // JSON document (no truncation, no interleaved bytes from two
        // writers sharing a temp file).
        let bytes = fs::read(&path).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .expect("final file must be valid JSON, not a corrupted interleave");
        assert!(value.get("writer").is_some());
    }
}
