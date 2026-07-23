//! Clone-and-install flow for git-hosted skills.
//!
//! Ports `previewGitInstall` and `installFromGit` from `src/server.js`.
//! Uses the `git2` crate (vendored libgit2) so we don't depend on a system
//! `git` binary. The flow is: parse the (URL, ref, subdir) tuple, clone to a
//! `TempDir`, walk for skill candidates, and either render a preview plan or
//! actually run the import (`super::imports::import_source`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use git2::{FetchOptions, RemoteCallbacks, Repository};
use tempfile::TempDir;
use tokio::fs;

use super::imports::{
    find_duplicate_vault_skill, find_import_candidates, import_source, is_inside_path,
    ImportCandidate,
};
use super::skills::safe_segment;
use super::state::{BackendError, BackendResult};
use super::types::{
    GitInstallCandidate, GitInstallPlan, GitInstallSource, GitInstallSummary, GitInstallTarget,
    GitInstallTargetLink, TargetRecord,
};

/// Parsed git source. Mirrors `server.js::parseGitSource`.
#[derive(Debug, Clone)]
pub struct GitSource {
    pub repo_url: String,
    pub git_ref: String,
    pub subdir: String,
}

impl GitSource {
    pub fn to_dto(&self) -> GitInstallSource {
        GitInstallSource {
            repo_url: self.repo_url.clone(),
            r#ref: self.git_ref.clone(),
            subdir: self.subdir.clone(),
        }
    }
}

/// Parse a user-supplied repo URL with optional `#ref:subdir` fragment.
/// Mirrors `server.js::parseGitSource`.
pub fn parse_git_source(
    raw_repo_url: &str,
    explicit_ref: Option<&str>,
) -> BackendResult<GitSource> {
    let raw = raw_repo_url.trim();
    if raw.is_empty() {
        return Err(BackendError::Validation(
            "Git repository URL is required".to_string(),
        ));
    }

    let mut repo_url = raw.to_string();
    let mut git_ref = explicit_ref.unwrap_or("").trim().to_string();
    let mut subdir = String::new();

    if let Some(hash_idx) = raw.find('#') {
        repo_url = raw[..hash_idx].to_string();
        let fragment = &raw[hash_idx + 1..];
        if let Some(colon_idx) = fragment.find(':') {
            if git_ref.is_empty() {
                git_ref = fragment[..colon_idx].to_string();
            }
            subdir = fragment[colon_idx + 1..].to_string();
        } else if git_ref.is_empty() {
            git_ref = fragment.to_string();
        }
    }

    if repo_url.trim().is_empty() {
        return Err(BackendError::Validation(
            "Git repository URL is required".to_string(),
        ));
    }
    if subdir.contains("..") {
        return Err(BackendError::Validation(
            "Git subdirectory cannot contain '..'".to_string(),
        ));
    }
    Ok(GitSource {
        repo_url: repo_url.trim().to_string(),
        git_ref,
        subdir: subdir.trim_start_matches('/').to_string(),
    })
}

/// Clone `source.repo_url` into a fresh temp directory, optionally checking
/// out `source.git_ref`. Returns the temp dir handle (kept alive by the
/// caller) and the absolute path of the install root (clone path + subdir).
pub fn clone_repo(source: &GitSource) -> BackendResult<(TempDir, PathBuf)> {
    let temp_root = tempfile::Builder::new()
        .prefix("skillworks-git-")
        .tempdir()
        .map_err(BackendError::Io)?;
    let clone_path = temp_root.path().join("repo");

    let mut callbacks = RemoteCallbacks::new();
    callbacks.transfer_progress(|_| true);

    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks);
    // libgit2's local transport (used for `file://...` and bare-repo paths)
    // does not support shallow fetch; only ask for depth on remote URLs.
    if !is_local_transport(&source.repo_url) {
        fetch_opts.depth(1);
    }

    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fetch_opts);
    if !source.git_ref.is_empty() {
        builder.branch(&source.git_ref);
    }

    let repo = builder
        .clone(&source.repo_url, &clone_path)
        .map_err(|e| BackendError::Validation(format!("git clone failed: {e}")))?;

    // If a ref was supplied and the branch checkout didn't already land us
    // there, try resolving as a tag/commit and detaching HEAD onto it.
    if !source.git_ref.is_empty() {
        if let Err(_) = ensure_ref_checked_out(&repo, &source.git_ref) {
            // Best-effort; bail loudly only if neither branch nor revparse
            // worked. The branch-based clone path already handles the common
            // case.
        }
    }

    let install_root = if source.subdir.is_empty() {
        clone_path.clone()
    } else {
        clone_path.join(&source.subdir)
    };
    Ok((temp_root, install_root))
}

/// Heuristic: treat anything that looks like a local path (`file://...`,
/// absolute path, or relative) as a local transport. libgit2's local
/// transport rejects shallow fetch with `12 (Net)`.
fn is_local_transport(url: &str) -> bool {
    if url.starts_with("file://") {
        return true;
    }
    if url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("git://")
        || url.starts_with("ssh://")
        || url.starts_with("git@")
    {
        return false;
    }
    // Anything else: assume it's a local path.
    true
}

fn ensure_ref_checked_out(repo: &Repository, git_ref: &str) -> Result<(), git2::Error> {
    let obj = repo.revparse_single(git_ref)?;
    repo.checkout_tree(&obj, None)?;
    repo.set_head_detached(obj.id())?;
    Ok(())
}

/// Build the preview plan for `repo_url` / `git_ref`. Mirrors
/// `server.js::previewGitInstall` + the per-candidate planning loop in
/// `core.js::previewInstall`.
pub async fn preview_git_install(
    repo_url: &str,
    git_ref: Option<&str>,
    vault_root: &Path,
    targets: Vec<TargetRecord>,
) -> BackendResult<GitInstallPlan> {
    let source = parse_git_source(repo_url, git_ref)?;
    let (temp, install_root) = clone_repo(&source)?;
    // Hold onto `temp` for the duration of the candidate walk; once we drop
    // it on return the cloned dir is cleaned up.
    let plan = build_plan_for_root(&source, &install_root, vault_root, targets).await?;
    drop(temp);
    Ok(plan)
}

async fn build_plan_for_root(
    source: &GitSource,
    install_root: &Path,
    vault_root: &Path,
    targets: Vec<TargetRecord>,
) -> BackendResult<GitInstallPlan> {
    let candidates = find_import_candidates(install_root).await?;
    let mut used_destination_bases: HashSet<String> = HashSet::new();
    let mut used_link_names: HashSet<String> = HashSet::new();
    let mut plan: Vec<GitInstallCandidate> = Vec::new();

    for candidate in &candidates {
        let desired_name = if candidate.metadata.name.is_empty() {
            candidate
                .entry_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            candidate.metadata.name.clone()
        };
        let link_base = safe_segment(&desired_name);
        let mut link_name = link_base.clone();
        if used_link_names.contains(&link_name) {
            link_name = format!("{}-{}", link_base, short_hash(&candidate.real_path));
        }
        used_link_names.insert(link_name.clone());

        let mut action = "move".to_string();
        let mut vault_destination = String::new();
        let mut will_dedupe = false;
        let mut skip_reason = String::new();

        if is_inside_path(&candidate.real_path, vault_root) {
            action = "skip".into();
            skip_reason = "Already in vault".into();
            vault_destination = candidate.real_path.to_string_lossy().into_owned();
        } else if is_inside_path(vault_root, &candidate.real_path) {
            action = "skip".into();
            skip_reason = "Refusing to move a skill into its own child directory".into();
        } else if let Some(existing) = find_duplicate_vault_skill(vault_root, candidate).await? {
            action = "dedupe".into();
            will_dedupe = true;
            vault_destination = existing.to_string_lossy().into_owned();
        } else {
            let base_name = safe_segment(&desired_name);
            let mut base = base_name.clone();
            let mut index = 2;
            loop {
                let collision = used_destination_bases.contains(&base)
                    || fs::try_exists(vault_root.join(&base))
                        .await
                        .unwrap_or(false);
                if !collision {
                    break;
                }
                base = format!("{base_name}-{index}");
                index += 1;
            }
            used_destination_bases.insert(base.clone());
            vault_destination = vault_root.join(&base).to_string_lossy().into_owned();
        }

        let target_links: Vec<GitInstallTargetLink> = if action == "skip" {
            Vec::new()
        } else {
            targets
                .iter()
                .map(|t| GitInstallTargetLink {
                    target_id: t.id.clone(),
                    target_label: t.label.clone(),
                    scope: t.scope.clone(),
                    link_name: link_name.clone(),
                    link_path: PathBuf::from(&t.path)
                        .join(&link_name)
                        .to_string_lossy()
                        .into_owned(),
                })
                .collect()
        };

        let source_key = source_key_for(candidate, install_root);

        plan.push(GitInstallCandidate {
            name: desired_name,
            description: candidate.metadata.description.clone(),
            source_path: candidate.entry_path.to_string_lossy().into_owned(),
            real_source_path: candidate.real_path.to_string_lossy().into_owned(),
            source_key,
            kind: candidate.kind.clone(),
            action,
            skip_reason,
            will_dedupe,
            vault_destination,
            link_name,
            target_links,
        });
    }

    let to_move = plan.iter().filter(|p| p.action == "move").count() as u32;
    let to_dedupe = plan.iter().filter(|p| p.action == "dedupe").count() as u32;
    let to_skip = plan.iter().filter(|p| p.action == "skip").count() as u32;

    Ok(GitInstallPlan {
        source: source.to_dto(),
        vault_root: vault_root.to_string_lossy().into_owned(),
        candidates: plan,
        targets: targets
            .into_iter()
            .map(|t| GitInstallTarget {
                id: t.id,
                label: t.label,
                scope: t.scope,
                path: t.path,
            })
            .collect(),
        summary: GitInstallSummary {
            candidates: candidates.len() as u32,
            to_move,
            to_dedupe,
            to_skip,
        },
    })
}

/// Execute the install for `repo_url`. Returns the `(imported, skipped,
/// install_root, candidates)` so the caller can hand off to
/// `enable_imported_skills`.
///
/// `selected_source_keys`: `None` installs every candidate found in the
/// repo; `Some(keys)` installs only the candidates whose source key (path
/// relative to the install root — the preview plan's `sourceKey`) is in the
/// list. An empty list or an unknown key is a validation error and nothing
/// is moved.
pub async fn install_from_git(
    repo_url: &str,
    git_ref: Option<&str>,
    vault_root: &Path,
    selected_source_keys: Option<&[String]>,
) -> BackendResult<(
    Vec<super::types::ImportedSkill>,
    Vec<super::types::ImportSkipped>,
    PathBuf,
    Vec<ImportCandidate>,
)> {
    let source = parse_git_source(repo_url, git_ref)?;
    let (temp, install_root) = clone_repo(&source)?;
    // Snapshot candidates BEFORE the import (their `entry_path` lives under
    // the temp clone dir; once moved into the vault the relative path map
    // would no longer resolve).
    let candidates = find_import_candidates(&install_root).await?;

    let (imported, skipped) = match selected_source_keys {
        None => import_source(vault_root, &install_root, true).await?,
        Some(keys) => {
            if keys.is_empty() {
                return Err(BackendError::Validation("No skills selected".to_string()));
            }
            let available: HashSet<String> = candidates
                .iter()
                .map(|c| source_key_for(c, &install_root))
                .collect();
            for key in keys {
                if !available.contains(key) {
                    return Err(BackendError::Validation(format!(
                        "Selected skill not found in repository: {key} (re-run the preview)"
                    )));
                }
            }
            let selected: HashSet<&str> = keys.iter().map(String::as_str).collect();
            let mut imported = Vec::new();
            let mut skipped = Vec::new();
            for candidate in &candidates {
                if !selected.contains(source_key_for(candidate, &install_root).as_str()) {
                    continue;
                }
                // Importing the candidate's own directory finds exactly that
                // one skill (the walker stops at the first SKILL.md), so the
                // vault collision/dedupe logic runs per selected skill.
                let (mut i, mut s) = import_source(vault_root, &candidate.entry_path, true).await?;
                imported.append(&mut i);
                skipped.append(&mut s);
            }
            (imported, skipped)
        }
    };
    drop(temp);
    Ok((imported, skipped, install_root, candidates))
}

/// Candidate path relative to the install root — the same `sourceKey` the
/// preview plan exposes and `commands.rs::candidate_source_key` computes
/// from `ImportedSkill.from`.
pub fn source_key_for(candidate: &ImportCandidate, install_root: &Path) -> String {
    source_key_for_path(&candidate.entry_path, install_root)
}

/// Core source-key derivation shared by the preview plan, the install
/// selection filter, and `commands.rs::candidate_source_key`: the path
/// relative to `install_root`, falling back to the unstripped path.
pub fn source_key_for_path(path: &Path, install_root: &Path) -> String {
    path.strip_prefix(install_root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

fn short_hash(path: &Path) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let result = hasher.finalize();
    result
        .iter()
        .take(4)
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use tempfile::TempDir;

    fn build_fixture_repo(working: &Path, skills: &[(&str, &str)]) -> Repository {
        let repo = Repository::init(working).expect("init");
        for (rel, body) in skills {
            let path = working.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, body).unwrap();
        }
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        repo
    }

    fn clone_to_bare(working: &Path, bare_path: &Path) {
        // Make a fresh bare clone of the working repo. libgit2's local
        // transport handles `file://` URLs (and plain paths) without
        // needing git on PATH.
        let mut builder = git2::build::RepoBuilder::new();
        builder.bare(true);
        builder.clone(working.to_str().unwrap(), bare_path).unwrap();
    }

    fn url_for_path(p: &Path) -> String {
        format!("file://{}", p.to_string_lossy())
    }

    #[test]
    fn parse_git_source_handles_fragment() {
        let s = parse_git_source("https://github.com/foo/bar#main:packages/x", None).unwrap();
        assert_eq!(s.repo_url, "https://github.com/foo/bar");
        assert_eq!(s.git_ref, "main");
        assert_eq!(s.subdir, "packages/x");
    }

    #[test]
    fn parse_git_source_explicit_ref_wins() {
        let s = parse_git_source("https://github.com/foo/bar#main:pkg", Some("v1.0.0")).unwrap();
        assert_eq!(s.git_ref, "v1.0.0");
        assert_eq!(s.subdir, "pkg");
    }

    #[test]
    fn parse_git_source_rejects_traversal() {
        let err = parse_git_source("https://github.com/foo/bar#main:../escape", None).unwrap_err();
        match err {
            BackendError::Validation(msg) => assert!(msg.contains("'..'")),
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn preview_git_install_against_local_bare_repo() {
        let dir = TempDir::new().unwrap();
        let working = dir.path().join("work");
        let bare = dir.path().join("bare.git");
        build_fixture_repo(
            &working,
            &[
                (
                    "skills/swiftui/SKILL.md",
                    "---\nname: SwiftUI\ndescription: x\n---\n\nbody\n",
                ),
                (
                    "skills/react/SKILL.md",
                    "---\nname: React\ndescription: y\n---\n\nbody\n",
                ),
            ],
        );
        clone_to_bare(&working, &bare);

        let vault_root = dir.path().join("vault");
        std::fs::create_dir_all(&vault_root).unwrap();

        let plan = preview_git_install(&url_for_path(&bare), None, &vault_root, vec![])
            .await
            .expect("preview");
        assert_eq!(plan.summary.candidates, 2);
        assert_eq!(plan.summary.to_move, 2);
        assert_eq!(plan.summary.to_dedupe, 0);
        assert_eq!(plan.summary.to_skip, 0);
        let names: HashSet<String> = plan.candidates.iter().map(|c| c.name.clone()).collect();
        assert!(names.contains("SwiftUI"));
        assert!(names.contains("React"));
        let swiftui = plan
            .candidates
            .iter()
            .find(|c| c.name == "SwiftUI")
            .expect("SwiftUI candidate");
        assert_eq!(swiftui.description, "x");
    }

    #[tokio::test]
    async fn install_from_git_against_local_bare_repo_moves_into_vault() {
        let dir = TempDir::new().unwrap();
        let working = dir.path().join("work");
        let bare = dir.path().join("bare.git");
        build_fixture_repo(
            &working,
            &[(
                "skills/swiftui/SKILL.md",
                "---\nname: SwiftUI\ndescription: x\n---\n\nbody\n",
            )],
        );
        clone_to_bare(&working, &bare);

        let vault_root = dir.path().join("vault");
        std::fs::create_dir_all(&vault_root).unwrap();

        let (imported, skipped, _install_root, candidates) =
            install_from_git(&url_for_path(&bare), None, &vault_root, None)
                .await
                .expect("install");
        assert_eq!(imported.len(), 1);
        assert!(skipped.is_empty());
        assert_eq!(candidates.len(), 1);
        // Vault has the skill now.
        assert!(vault_root.join("swiftui").join("SKILL.md").is_file());
    }

    #[tokio::test]
    async fn install_from_git_with_selection_installs_only_selected() {
        let dir = TempDir::new().unwrap();
        let working = dir.path().join("work");
        let bare = dir.path().join("bare.git");
        build_fixture_repo(
            &working,
            &[
                (
                    "skills/rust/SKILL.md",
                    "---\nname: Rust\ndescription: x\n---\n\nbody\n",
                ),
                (
                    "skills/apollo/SKILL.md",
                    "---\nname: Apollo\ndescription: y\n---\n\nbody\n",
                ),
            ],
        );
        clone_to_bare(&working, &bare);

        let vault_root = dir.path().join("vault");
        std::fs::create_dir_all(&vault_root).unwrap();

        let selection = vec!["skills/rust".to_string()];
        let (imported, skipped, _install_root, candidates) =
            install_from_git(&url_for_path(&bare), None, &vault_root, Some(&selection))
                .await
                .expect("install");

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "Rust");
        assert!(skipped.is_empty());
        // The candidate snapshot still reports the full repo so the caller
        // can map source keys for every skill it saw.
        assert_eq!(candidates.len(), 2);
        assert!(vault_root.join("rust").join("SKILL.md").is_file());
        assert!(!vault_root.join("apollo").exists());
    }

    #[tokio::test]
    async fn install_from_git_with_unknown_selected_key_errors() {
        let dir = TempDir::new().unwrap();
        let working = dir.path().join("work");
        let bare = dir.path().join("bare.git");
        build_fixture_repo(
            &working,
            &[(
                "skills/rust/SKILL.md",
                "---\nname: Rust\ndescription: x\n---\n\nbody\n",
            )],
        );
        clone_to_bare(&working, &bare);

        let vault_root = dir.path().join("vault");
        std::fs::create_dir_all(&vault_root).unwrap();

        let selection = vec!["skills/nope".to_string()];
        let err = install_from_git(&url_for_path(&bare), None, &vault_root, Some(&selection))
            .await
            .unwrap_err();
        match err {
            BackendError::Validation(msg) => assert!(msg.contains("skills/nope")),
            other => panic!("expected validation error, got {other:?}"),
        }
        // Nothing was moved into the vault.
        assert!(std::fs::read_dir(&vault_root).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn install_from_git_with_empty_selection_errors() {
        let dir = TempDir::new().unwrap();
        let working = dir.path().join("work");
        let bare = dir.path().join("bare.git");
        build_fixture_repo(
            &working,
            &[(
                "skills/rust/SKILL.md",
                "---\nname: Rust\ndescription: x\n---\n\nbody\n",
            )],
        );
        clone_to_bare(&working, &bare);

        let vault_root = dir.path().join("vault");
        std::fs::create_dir_all(&vault_root).unwrap();

        let selection: Vec<String> = vec![];
        let err = install_from_git(&url_for_path(&bare), None, &vault_root, Some(&selection))
            .await
            .unwrap_err();
        match err {
            BackendError::Validation(msg) => assert!(msg.contains("No skills selected")),
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn install_from_git_selected_duplicate_still_dedupes() {
        let dir = TempDir::new().unwrap();
        let working = dir.path().join("work");
        let bare = dir.path().join("bare.git");
        let body = "---\nname: Rust\ndescription: x\n---\n\nbody\n";
        build_fixture_repo(&working, &[("skills/rust/SKILL.md", body)]);
        clone_to_bare(&working, &bare);

        // Pre-seed the vault with an identical skill so the import dedupes.
        let vault_root = dir.path().join("vault");
        std::fs::create_dir_all(vault_root.join("existing-rust")).unwrap();
        std::fs::write(vault_root.join("existing-rust").join("SKILL.md"), body).unwrap();

        let selection = vec!["skills/rust".to_string()];
        let (imported, _skipped, _root, _candidates) =
            install_from_git(&url_for_path(&bare), None, &vault_root, Some(&selection))
                .await
                .expect("install");

        assert_eq!(imported.len(), 1);
        assert!(imported[0].deduped);
        // No second copy was created.
        assert!(!vault_root.join("rust").exists());
    }
}
