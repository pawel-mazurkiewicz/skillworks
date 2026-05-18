//! Import flows ported from `src/core.js`.
//!
//! Covers `findImportCandidates`, `importSource`, `importSkills`, and
//! `importPaths`. Imports MOVE skill directories into the vault root (the
//! source is removed once the move succeeds) — this mirrors the JS contract
//! and the user-facing copy in the UI.
//!
//! The companion duplicate-detection helper (`findDuplicateVaultSkill`)
//! lives here too because it is only used during imports.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tokio::fs;

use super::fs_helpers::{move_directory, unique_skill_destination};
use super::projects::expand_home;
use super::skills::{find_skill_roots, read_skill_metadata, safe_segment, SKILL_FILE};
use super::state::{BackendError, BackendResult};
use super::symlinks::unlink_if_symlink;
use super::types::{ImportSkipped, ImportedSkill, SkillMetadata};

/// A single import candidate. Mirrors the object returned by
/// `core.js::findImportCandidates`.
#[derive(Debug, Clone)]
pub struct ImportCandidate {
    /// The path the walker entered (may be a symlink).
    pub entry_path: PathBuf,
    /// The canonical (realpath-resolved) skill directory.
    pub real_path: PathBuf,
    /// `"directory" | "symlink"`.
    pub kind: String,
    pub metadata: SkillMetadata,
}

const SKIP_DIRS: &[&str] = &[".git", "node_modules"];

/// Walk `root` looking for skill directories. Mirrors
/// `core.js::findImportCandidates`: stops descending the moment it finds a
/// directory with a `SKILL.md` (treats it as a single skill); follows
/// symlinks but resolves them to their canonical path; deduplicates by
/// canonical path; sorts by entry path.
pub async fn find_import_candidates(root: &Path) -> BackendResult<Vec<ImportCandidate>> {
    let absolute_root = if root.is_absolute() {
        expand_home(root)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        cwd.join(expand_home(root))
    };

    let mut seen_real: HashSet<PathBuf> = HashSet::new();
    let mut out: Vec<ImportCandidate> = Vec::new();

    walk_for_candidates(&absolute_root, &mut seen_real, &mut out).await?;
    out.sort_by(|a, b| a.entry_path.cmp(&b.entry_path));
    Ok(out)
}

fn boxed_walk<'a>(
    current: &'a Path,
    seen: &'a mut HashSet<PathBuf>,
    out: &'a mut Vec<ImportCandidate>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = BackendResult<()>> + Send + 'a>> {
    Box::pin(walk_for_candidates(current, seen, out))
}

async fn walk_for_candidates(
    current: &Path,
    seen: &mut HashSet<PathBuf>,
    out: &mut Vec<ImportCandidate>,
) -> BackendResult<()> {
    let lstat = match fs::symlink_metadata(current).await {
        Ok(meta) => meta,
        Err(_) => return Ok(()),
    };

    if lstat.file_type().is_symlink() {
        add_candidate(current, "symlink", seen, out).await?;
        return Ok(());
    }

    if !lstat.is_dir() {
        return Ok(());
    }

    if fs::try_exists(current.join(SKILL_FILE)).await.unwrap_or(false) {
        add_candidate(current, "directory", seen, out).await?;
        return Ok(());
    }

    let mut entries = match fs::read_dir(current).await {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    let mut children: Vec<PathBuf> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_DIRS.iter().any(|s| *s == name) {
            continue;
        }
        // Only descend into directories / symlinks.
        let entry_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !entry_type.is_dir() && !entry_type.is_symlink() {
            continue;
        }
        children.push(entry.path());
    }
    children.sort();
    for child in children {
        boxed_walk(&child, seen, out).await?;
    }
    Ok(())
}

async fn add_candidate(
    entry_path: &Path,
    kind: &str,
    seen: &mut HashSet<PathBuf>,
    out: &mut Vec<ImportCandidate>,
) -> BackendResult<()> {
    let real = match fs::canonicalize(entry_path).await {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    if seen.contains(&real) {
        return Ok(());
    }
    if !fs::try_exists(real.join(SKILL_FILE)).await.unwrap_or(false) {
        return Ok(());
    }
    let metadata = read_skill_metadata(&real).await?;
    seen.insert(real.clone());
    out.push(ImportCandidate {
        entry_path: entry_path.to_path_buf(),
        real_path: real,
        kind: kind.to_string(),
        metadata,
    });
    Ok(())
}

/// Walk every vault skill and return the path of the first skill whose
/// `SKILL.md` matches the candidate's. Mirrors
/// `core.js::findDuplicateVaultSkill`.
pub async fn find_duplicate_vault_skill(
    vault_root: &Path,
    candidate: &ImportCandidate,
) -> BackendResult<Option<PathBuf>> {
    let candidate_skill_file = match fs::read(candidate.real_path.join(SKILL_FILE)).await {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    if candidate_skill_file.is_empty() {
        return Ok(None);
    }
    let desired_name = if candidate.metadata.name.is_empty() {
        candidate
            .entry_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        candidate.metadata.name.clone()
    };
    let primary = vault_root.join(safe_segment(&desired_name));
    if skill_file_matches(&primary, &candidate_skill_file).await {
        return Ok(Some(primary));
    }
    let roots = find_skill_roots(vault_root).await?;
    for root in roots {
        if root == primary {
            continue;
        }
        if skill_file_matches(&root, &candidate_skill_file).await {
            return Ok(Some(root));
        }
    }
    Ok(None)
}

async fn skill_file_matches(skill_root: &Path, expected: &[u8]) -> bool {
    match fs::read(skill_root.join(SKILL_FILE)).await {
        Ok(actual) => !actual.is_empty() && actual == expected,
        Err(_) => false,
    }
}

/// Return `true` when `candidate` is the same path as `parent` or lives
/// inside it. Mirrors `core.js::isInsidePath`.
pub fn is_inside_path(candidate: &Path, parent: &Path) -> bool {
    match candidate.strip_prefix(parent) {
        Ok(rest) => rest.as_os_str().is_empty() || rest.components().next().is_some(),
        Err(_) => false,
    }
}

/// Move every candidate under `source` into the vault. Mirrors
/// `core.js::importSource`.
///
/// `require_exists = true` (the `import_skills` flow) errors out when the
/// source path is missing; `false` (the `import_paths` flow) treats a
/// missing source as a skip.
pub async fn import_source(
    vault_root: &Path,
    source_path: &Path,
    require_exists: bool,
) -> BackendResult<(Vec<ImportedSkill>, Vec<ImportSkipped>)> {
    let source = if source_path.is_absolute() {
        expand_home(source_path)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        cwd.join(expand_home(source_path))
    };

    if require_exists && !fs::try_exists(&source).await.unwrap_or(false) {
        return Err(BackendError::Validation(format!(
            "Import path does not exist: {}",
            source.display()
        )));
    }

    let candidates = find_import_candidates(&source).await?;
    let mut imported: Vec<ImportedSkill> = Vec::new();
    let mut skipped: Vec<ImportSkipped> = Vec::new();

    for candidate in &candidates {
        if is_inside_path(&candidate.real_path, vault_root) {
            if candidate.kind == "symlink" {
                let _ = unlink_if_symlink(&candidate.entry_path).await;
            }
            skipped.push(ImportSkipped {
                path: candidate.entry_path.to_string_lossy().into_owned(),
                reason: "Already in vault".to_string(),
            });
            continue;
        }

        if is_inside_path(vault_root, &candidate.real_path) {
            skipped.push(ImportSkipped {
                path: candidate.entry_path.to_string_lossy().into_owned(),
                reason: "Refusing to move a skill into its own child directory".to_string(),
            });
            continue;
        }

        let desired_name = if candidate.metadata.name.is_empty() {
            candidate
                .entry_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            candidate.metadata.name.clone()
        };

        if let Some(existing) = find_duplicate_vault_skill(vault_root, candidate).await? {
            // Source is a duplicate of an existing vault skill — drop the
            // source directory and record a dedupe.
            let _ = fs::remove_dir_all(&candidate.real_path).await;
            if candidate.kind == "symlink" {
                let _ = unlink_if_symlink(&candidate.entry_path).await;
            }
            imported.push(ImportedSkill {
                name: desired_name,
                from: candidate.entry_path.to_string_lossy().into_owned(),
                moved_source: candidate.real_path.to_string_lossy().into_owned(),
                to: existing.to_string_lossy().into_owned(),
                kind: candidate.kind.clone(),
                deduped: true,
            });
            continue;
        }

        let destination = unique_skill_destination(vault_root, &desired_name).await;
        move_directory(&candidate.real_path, &destination).await?;
        if candidate.kind == "symlink" {
            let _ = unlink_if_symlink(&candidate.entry_path).await;
        }
        imported.push(ImportedSkill {
            name: desired_name,
            from: candidate.entry_path.to_string_lossy().into_owned(),
            moved_source: candidate.real_path.to_string_lossy().into_owned(),
            to: destination.to_string_lossy().into_owned(),
            kind: candidate.kind.clone(),
            deduped: false,
        });
    }

    if candidates.is_empty() {
        skipped.push(ImportSkipped {
            path: source.to_string_lossy().into_owned(),
            reason: "No SKILL.md files found".to_string(),
        });
    }

    Ok((imported, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn write_skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).await.unwrap();
        let body = format!(
            "---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"
        );
        fs::write(dir.join(SKILL_FILE), body).await.unwrap();
    }

    #[tokio::test]
    async fn find_import_candidates_walks_recursively() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("src");
        write_skill(&source.join("a"), "A", "first").await;
        write_skill(&source.join("nested/b"), "B", "second").await;
        // .git should be skipped.
        fs::create_dir_all(source.join(".git/foo")).await.unwrap();
        fs::write(source.join(".git/foo").join(SKILL_FILE), "---\nname: gitskill\n---\n")
            .await
            .unwrap();

        let candidates = find_import_candidates(&source).await.unwrap();
        let names: Vec<&str> = candidates.iter().map(|c| c.metadata.name.as_str()).collect();
        assert!(names.contains(&"A"));
        assert!(names.contains(&"B"));
        assert_eq!(candidates.len(), 2, "should skip .git contents");
    }

    #[tokio::test]
    async fn find_import_candidates_dedupes_symlinks() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("src");
        let real = dir.path().join("real-skill");
        write_skill(&real, "Real", "x").await;
        fs::create_dir_all(&source).await.unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, source.join("link-to-real")).unwrap();
        write_skill(&source.join("direct"), "Direct", "y").await;
        // Also add a sibling symlink pointing at the same canonical path.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, source.join("link2")).unwrap();

        let candidates = find_import_candidates(&source).await.unwrap();
        let real_paths: HashSet<PathBuf> =
            candidates.iter().map(|c| c.real_path.clone()).collect();
        // One per canonical path: real, direct.
        assert_eq!(real_paths.len(), 2);
    }

    #[tokio::test]
    async fn import_source_moves_into_vault() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        fs::create_dir_all(&vault).await.unwrap();
        let source = dir.path().join("src");
        write_skill(&source.join("foo"), "Foo", "x").await;
        let original = source.join("foo");
        assert!(original.exists());

        let (imported, skipped) = import_source(&vault, &source, true).await.unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(skipped.len(), 0);
        // Source was moved, not copied.
        assert!(!original.exists());
        // Vault now contains "foo" (safe_segment("Foo") -> "foo").
        assert!(vault.join("foo").join(SKILL_FILE).is_file());
    }

    #[tokio::test]
    async fn import_source_skips_when_no_skills() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        fs::create_dir_all(&vault).await.unwrap();
        let source = dir.path().join("empty");
        fs::create_dir_all(&source).await.unwrap();

        let (imported, skipped) = import_source(&vault, &source, true).await.unwrap();
        assert!(imported.is_empty());
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].reason, "No SKILL.md files found");
    }

    #[tokio::test]
    async fn import_source_dedupes_against_existing_vault_skill() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        fs::create_dir_all(&vault).await.unwrap();
        // Pre-existing vault skill.
        let existing = vault.join("foo");
        write_skill(&existing, "Foo", "x").await;
        let existing_body = fs::read(existing.join(SKILL_FILE)).await.unwrap();

        // Source skill with identical SKILL.md bytes.
        let source = dir.path().join("src");
        fs::create_dir_all(&source.join("foo")).await.unwrap();
        fs::write(source.join("foo").join(SKILL_FILE), &existing_body)
            .await
            .unwrap();

        let (imported, skipped) = import_source(&vault, &source, true).await.unwrap();
        assert_eq!(imported.len(), 1);
        assert!(imported[0].deduped, "should mark dedupe");
        assert!(skipped.is_empty());
        // Source got removed (the importer drops dupes).
        assert!(!source.join("foo").exists());
        // The pre-existing vault skill is untouched.
        assert!(existing.join(SKILL_FILE).is_file());
    }
}
