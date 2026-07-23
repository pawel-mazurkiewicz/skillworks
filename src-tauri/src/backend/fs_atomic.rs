use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::Utc;
use serde::{Deserialize, Serialize};
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
pub async fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> BackendResult<()> {
    let parent = path.parent().ok_or_else(|| {
        BackendError::Validation(format!("path has no parent: {}", path.display()))
    })?;

    fs::create_dir_all(parent).await?;

    // Suffix the temp filename with the pid + a per-call sequence number so
    // concurrent writers (even within this one process) never share a temp
    // path. See `unique_tmp_suffix` for why the pid alone isn't sufficient.
    let file_name = path.file_name().ok_or_else(|| {
        BackendError::Validation(format!("path has no file name: {}", path.display()))
    })?;
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
    let parent = path.parent().ok_or_else(|| {
        BackendError::Validation(format!("path has no parent: {}", path.display()))
    })?;

    fs::create_dir_all(parent).await?;

    let file_name = path.file_name().ok_or_else(|| {
        BackendError::Validation(format!("path has no file name: {}", path.display()))
    })?;
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

// --- Cross-process advisory file locking ---
//
// The Tauri desktop app (this process) and the legacy Node MCP stdio server
// both perform read-modify-write cycles on the same on-disk files (the MCP
// server library, the dismissed-candidates list, harness config files).
// Without coordination, two concurrent RMW cycles from the two processes can
// silently lose one writer's update (last writer wins). This implements a
// simple advisory lock-file protocol, mirrored byte-for-byte in the Node
// implementation (`src/mcp-core.js`'s `withFileLock`) so the two processes
// actually exclude each other:
//
//   - The lock for a protected file `P` is `P` + `.lock`, created via
//     create-new (O_CREAT|O_EXCL) containing JSON `{"pid", "acquiredAt"}`.
//   - On a create failure because the lock already exists: if the existing
//     lock's `acquiredAt` is older than 10s, its holder likely crashed
//     without releasing it — delete it and retry immediately. Otherwise
//     sleep 50ms and retry, up to a total wait of ~2s, then fail.
//   - Release = delete the lock file.

const LOCK_STALE_AFTER_MS: u64 = 10_000;
const LOCK_RETRY_DELAY_MS: u64 = 50;
const LOCK_MAX_WAIT_MS: u64 = 2_000;

#[derive(Serialize)]
struct LockPayload {
    pid: u32,
    #[serde(rename = "acquiredAt")]
    acquired_at: u64,
}

#[derive(Deserialize)]
struct LockPayloadRead {
    #[serde(default, rename = "acquiredAt")]
    acquired_at: u64,
}

fn lock_path_for(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// RAII guard for an advisory cross-process lock on the file passed to
/// [`with_file_lock`] / [`acquire_file_lock`]. Releases the lock (deletes the
/// lock file) on drop. Uses a synchronous remove because `Drop::drop` cannot
/// be async; this is a single small unlink and mirrors the same tradeoff
/// `tempfile`-style guards make elsewhere.
pub struct FileLockGuard {
    lock_path: PathBuf,
}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

/// Acquire the advisory lock file for `path` (i.e. `<path>.lock`), taking
/// over a stale lock (see module docs) and retrying with backoff otherwise.
pub async fn acquire_file_lock(path: &Path) -> BackendResult<FileLockGuard> {
    let lock_path = lock_path_for(path);
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let payload = LockPayload {
        pid: std::process::id(),
        acquired_at: now_ms(),
    };
    let mut bytes = serde_json::to_vec(&payload)?;
    bytes.push(b'\n');

    let deadline = Instant::now() + Duration::from_millis(LOCK_MAX_WAIT_MS);
    loop {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .await
        {
            Ok(mut file) => {
                file.write_all(&bytes).await?;
                file.flush().await?;
                file.sync_all().await?;
                return Ok(FileLockGuard { lock_path });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Ok(existing) = fs::read(&lock_path).await {
                    if let Ok(parsed) = serde_json::from_slice::<LockPayloadRead>(&existing) {
                        if now_ms().saturating_sub(parsed.acquired_at) > LOCK_STALE_AFTER_MS {
                            // Stale — the previous holder likely crashed
                            // without releasing it. Take it over and retry
                            // immediately (no backoff sleep).
                            let _ = fs::remove_file(&lock_path).await;
                            continue;
                        }
                    }
                }
                if Instant::now() >= deadline {
                    return Err(BackendError::Validation(format!(
                        "could not acquire lock on {}",
                        path.display()
                    )));
                }
                tokio::time::sleep(Duration::from_millis(LOCK_RETRY_DELAY_MS)).await;
            }
            Err(err) => return Err(err.into()),
        }
    }
}

/// Run `f` while holding the advisory cross-process lock for `path`, so a
/// whole read-modify-write cycle (load -> mutate -> save) is serialized
/// against both other tasks in this process and the Node MCP server process.
/// The lock must wrap the *whole* cycle, not just the final write — locking
/// only around the save would still let two readers interleave and one's
/// update silently overwrite the other's.
pub async fn with_file_lock<T, F, Fut>(path: &Path, f: F) -> BackendResult<T>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = BackendResult<T>>,
{
    let _guard = acquire_file_lock(path).await?;
    f().await
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

    /// `with_file_lock` must serialize a whole read-modify-write cycle: many
    /// concurrent "increment a counter field" cycles through the helper must
    /// all land, none silently lost to a last-writer-wins race.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn with_file_lock_serializes_concurrent_read_modify_write_cycles() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("counter.json");
        write_json_atomic(&path, &serde_json::json!({"count": 0}))
            .await
            .unwrap();

        let mut handles = Vec::new();
        for _ in 0..32u32 {
            let path = path.clone();
            handles.push(tokio::spawn(async move {
                with_file_lock(&path, || async {
                    let bytes = fs::read(&path).await?;
                    let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;
                    let count = value["count"].as_u64().unwrap();
                    value["count"] = serde_json::json!(count + 1);
                    write_json_atomic(&path, &value).await?;
                    Ok(())
                })
                .await
            }));
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }

        let bytes = fs::read(&path).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value["count"].as_u64().unwrap(),
            32,
            "every increment must survive; a lower count means a lock did not \
             actually serialize two overlapping read-modify-write cycles"
        );
    }

    /// A lock file left behind by a holder that crashed without releasing it
    /// (`acquiredAt` far in the past) must be taken over rather than blocking
    /// forever.
    #[tokio::test]
    async fn stale_lock_is_taken_over() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("target.json");
        write_json_atomic(&path, &serde_json::json!({"count": 0}))
            .await
            .unwrap();

        let lock_path = lock_path_for(&path);
        let stale_acquired_at = now_ms() - (LOCK_STALE_AFTER_MS + 1_000);
        let stale_payload = serde_json::json!({"pid": 999_999, "acquiredAt": stale_acquired_at});
        fs::write(&lock_path, serde_json::to_vec(&stale_payload).unwrap())
            .await
            .unwrap();

        // Should take over the stale lock (near-)immediately rather than
        // waiting out the full ~2s retry budget.
        let started = Instant::now();
        let guard = acquire_file_lock(&path).await.unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "stale lock should be taken over immediately, took {:?}",
            started.elapsed()
        );
        drop(guard);
        assert!(!fs::try_exists(&lock_path).await.unwrap_or(false));
    }
}
