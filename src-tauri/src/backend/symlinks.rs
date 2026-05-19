//! Symlink helpers ported from `src/core.js`.
//!
//! Covers `isSymlinkTo`, `unlinkIfSymlink`, `removeKnownSymlinksTo`,
//! `isSkillEnabledInTarget`, and `listTargetEntries`. These helpers are
//! consumed by the target inspection logic in `targets.rs` and (in later
//! phases) by the enable/disable/import flows.

use std::path::{Path, PathBuf};

use tokio::fs;

use super::skills::MANIFEST_FILE;
use super::state::BackendResult;
use super::types::{SkillRecord, TargetRecord};

/// Returns `true` when `candidate` is a symlink whose canonical destination
/// equals `expected_real_path`. Matches `core.js::isSymlinkTo`.
pub async fn is_symlink_to(candidate: &Path, expected_real_path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(candidate).await else {
        return false;
    };
    if !meta.file_type().is_symlink() {
        return false;
    }
    let Ok(real) = fs::canonicalize(candidate).await else {
        return false;
    };
    let Ok(expected) = fs::canonicalize(expected_real_path).await else {
        return real == expected_real_path;
    };
    real == expected
}

/// Best-effort unlink of `candidate` when it is a symlink. No-ops on
/// non-symlink targets or missing paths. Matches `core.js::unlinkIfSymlink`.
///
/// On Windows, directory symlinks need `remove_dir`; `remove_file` fails with
/// access denied. On Unix, both work for symlinks but `remove_file` is
/// canonical.
pub async fn unlink_if_symlink(candidate: &Path) -> BackendResult<()> {
    if let Ok(meta) = fs::symlink_metadata(candidate).await {
        if meta.file_type().is_symlink() {
            #[cfg(windows)]
            {
                if let Ok(target_meta) = fs::metadata(candidate).await {
                    if target_meta.is_dir() {
                        fs::remove_dir(candidate).await?;
                        return Ok(());
                    }
                }
            }
            fs::remove_file(candidate).await?;
        }
    }
    Ok(())
}

/// Enumerate the immediate children of `target_path`. Returns `(name, path)`
/// pairs and silently swallows read errors (mirrors
/// `core.js::listTargetEntries`).
pub async fn list_target_entries(target_path: &Path) -> Vec<(String, PathBuf)> {
    let mut entries = match fs::read_dir(target_path).await {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push((name, entry.path()));
    }
    out
}

/// `true` when `skill` is currently linked into `target` (the target dir has
/// any symlink whose canonical destination is `skill.real_path`). Matches
/// `core.js::isSkillEnabledInTarget`.
pub async fn is_skill_enabled_in_target(
    target: &TargetRecord,
    skill: &SkillRecord,
) -> BackendResult<bool> {
    let target_path = Path::new(&target.path);
    if !fs::try_exists(target_path).await.unwrap_or(false) {
        return Ok(false);
    }
    let skill_real = PathBuf::from(&skill.real_path);
    for (name, entry_path) in list_target_entries(target_path).await {
        if name == MANIFEST_FILE {
            continue;
        }
        if is_symlink_to(&entry_path, &skill_real).await {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Walk every known target for `project_path` and remove symlinks whose
/// canonical destination equals `real_source_path`. Matches
/// `core.js::removeKnownSymlinksTo`.
pub async fn remove_known_symlinks_to(
    real_source_path: &Path,
    targets: &[TargetRecord],
) -> BackendResult<()> {
    for target in targets {
        let target_path = Path::new(&target.path);
        if !fs::try_exists(target_path).await.unwrap_or(false) {
            continue;
        }
        for (name, entry_path) in list_target_entries(target_path).await {
            if name == MANIFEST_FILE {
                continue;
            }
            if is_symlink_to(&entry_path, real_source_path).await {
                let _ = fs::remove_file(&entry_path).await;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn is_symlink_to_detects_match() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("source");
        fs::create_dir_all(&source).await.unwrap();
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&source, &link).unwrap();

        assert!(is_symlink_to(&link, &source).await);
        assert!(!is_symlink_to(&link, dir.path()).await);
    }

    #[tokio::test]
    async fn unlink_if_symlink_removes_link_but_not_dir() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("source");
        fs::create_dir_all(&source).await.unwrap();
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, &link).unwrap();

        unlink_if_symlink(&link).await.unwrap();
        assert!(!link.exists());
        assert!(source.exists(), "source dir must survive");

        // On non-symlink path: no error, no-op.
        unlink_if_symlink(&source).await.unwrap();
        assert!(source.exists());
    }
}
