use std::path::Path;

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
