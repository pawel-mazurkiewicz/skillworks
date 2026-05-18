//! Project-discovery helpers ported from `src/core.js`.
//!
//! Covers `scanProjectRoots`, `walkForProjects`, `defaultScanRoots`,
//! `hasProjectMarker`, `shouldSkipProjectRoot`, `shouldSkipScanDir`,
//! `inferProjectRootFromSkillDir`, `isGlobalHarnessSkillDir`,
//! `hasHiddenPathSegment`, and `normalizeScanRoots`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use tokio::fs;

use super::projects::normalize_project_path;
use super::skills::find_skill_roots;
use super::types::{ProjectRecord, ProjectSkillSource, ScanReport, ScanSkippedEntry};

const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "settings.gradle",
    "Package.swift",
    "Gemfile",
    "composer.json",
    "mix.exs",
    "deno.json",
    "bun.lockb",
];

const SCAN_SKIP_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    ".svn",
    ".hg",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "target",
    "DerivedData",
    "Library",
    "Applications",
    "System",
    "Volumes",
    "private",
    "tmp",
    "temp",
    "__pycache__",
];

/// Inputs the walker carries down the recursion. Mirrors the `context`
/// object in `core.js::walkForProjects`.
#[derive(Debug, Clone)]
pub struct ScanContext {
    pub home_dir: PathBuf,
    pub app_home: PathBuf,
    pub vault_root: PathBuf,
    pub max_depth: u32,
}

/// Mirror of `core.js::isInsidePath`. True when `candidate == parent` or
/// `candidate` lies strictly under `parent` without using `..`.
pub fn is_inside_path(candidate: &Path, parent: &Path) -> bool {
    let candidate = clean_path(candidate);
    let parent = clean_path(parent);
    if candidate == parent {
        return true;
    }
    candidate.starts_with(&parent)
}

fn clean_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in p.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Default scan roots when the caller doesn't supply any. Mirrors
/// `core.js::defaultScanRoots`. The JS version returns the same list on
/// every platform; we replicate that.
pub fn default_scan_roots(home_dir: &Path) -> Vec<PathBuf> {
    [
        "code",
        "projects",
        "dev",
        "src",
        "work",
        "Developer",
    ]
    .iter()
    .map(|name| home_dir.join(name))
    .collect()
}

/// Resolve and de-dupe scan roots, expanding `~` and falling back to the
/// defaults when the caller passes nothing. Mirrors
/// `core.js::normalizeScanRoots`.
pub fn normalize_scan_roots(roots: Option<&[String]>, home_dir: &Path) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let defaults = default_scan_roots(home_dir);
    let raw: Vec<PathBuf> = match roots {
        Some(rs) if !rs.is_empty() => rs.iter().map(|s| PathBuf::from(s)).collect(),
        _ => defaults,
    };
    for root in raw {
        let resolved = normalize_project_path(&root);
        let key = resolved.to_string_lossy().into_owned();
        if seen.insert(key) {
            out.push(resolved);
        }
    }
    out
}

/// Detect whether a folder looks like the root of a project. Mirrors
/// `core.js::hasProjectMarker`.
pub async fn has_project_marker(project_root: &Path) -> bool {
    for marker in PROJECT_MARKERS {
        let path = project_root.join(marker);
        if fs::metadata(&path).await.is_ok() {
            return true;
        }
    }
    false
}

/// Skip well-known noisy directories during the scan walk. Mirrors
/// `core.js::shouldSkipScanDir`.
pub fn should_skip_scan_dir(current: &Path, ctx: &ScanContext) -> bool {
    let name = current
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if SCAN_SKIP_NAMES.contains(&name.as_str()) {
        return true;
    }
    let skip_roots = [
        ctx.app_home.clone(),
        ctx.home_dir.join(".codex").join("plugins").join("cache"),
        ctx.home_dir.join(".agents").join("plugins").join("cache"),
        ctx.home_dir.join(".claude").join("plugins").join("cache"),
    ];
    skip_roots.iter().any(|p| is_inside_path(current, p))
}

/// Decide whether a candidate project root should be dropped. Mirrors
/// `core.js::shouldSkipProjectRoot`.
pub async fn should_skip_project_root(project_root: &Path, ctx: &ScanContext) -> bool {
    if project_root == ctx.home_dir
        || is_inside_path(project_root, &ctx.app_home)
        || is_inside_path(project_root, &ctx.vault_root)
    {
        return true;
    }
    if has_hidden_path_segment(project_root, &ctx.home_dir) {
        return true;
    }
    if !has_project_marker(project_root).await {
        return true;
    }
    false
}

/// True when any segment of `project_root` relative to `home_dir` starts
/// with `.` (a dotfile/dotdir). Mirrors `core.js::hasHiddenPathSegment`.
pub fn has_hidden_path_segment(project_root: &Path, home_dir: &Path) -> bool {
    let project_root = clean_path(project_root);
    let home_dir = clean_path(home_dir);
    let rel = match project_root.strip_prefix(&home_dir) {
        Ok(r) => r.to_path_buf(),
        Err(_) => return false,
    };
    if rel.as_os_str().is_empty() {
        return false;
    }
    rel.components().any(|c| {
        c.as_os_str()
            .to_string_lossy()
            .starts_with('.')
    })
}

/// Derive a project root from a `skills` directory. Mirrors
/// `core.js::inferProjectRootFromSkillDir`.
pub fn infer_project_root_from_skill_dir(skill_dir: &Path) -> Option<PathBuf> {
    let parent = skill_dir.parent()?;
    let parent_name = parent
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if matches!(parent_name.as_str(), ".agents" | ".codex" | ".claude") {
        return parent.parent().map(|p| p.to_path_buf());
    }
    Some(parent.to_path_buf())
}

/// True when a skill dir is one of the well-known global harness paths
/// under `home_dir`. Mirrors `core.js::isGlobalHarnessSkillDir`.
pub fn is_global_harness_skill_dir(skill_dir: &Path, home_dir: &Path) -> bool {
    let resolved = clean_path(skill_dir);
    let candidates = [
        home_dir.join(".agents").join("skills"),
        home_dir.join(".codex").join("skills"),
        home_dir.join(".claude").join("skills"),
    ];
    candidates.iter().any(|p| clean_path(p) == resolved)
}

/// Iterative walker that mirrors `core.js::walkForProjects`. Populates
/// `project_map` and `skipped` in place. The async stack-based loop keeps
/// us off recursive-async pitfalls.
pub async fn walk_for_projects(
    root: &Path,
    ctx: &ScanContext,
    project_map: &mut BTreeMap<PathBuf, ProjectRecord>,
    skipped: &mut Vec<ScanSkippedEntry>,
) {
    // Each stack entry is (current path, depth).
    let mut stack: Vec<(PathBuf, u32)> = vec![(root.to_path_buf(), 0)];

    while let Some((current, depth)) = stack.pop() {
        let lstat = match fs::symlink_metadata(&current).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !lstat.is_dir() || lstat.file_type().is_symlink() {
            continue;
        }
        if should_skip_scan_dir(&current, ctx) {
            continue;
        }

        let basename = current
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();

        if basename == "skills" {
            if let Some(project_root) = infer_project_root_from_skill_dir(&current) {
                if !is_global_harness_skill_dir(&current, &ctx.home_dir)
                    && !should_skip_project_root(&project_root, ctx).await
                {
                    let roots = find_skill_roots(&current).await.unwrap_or_default();
                    if !roots.is_empty() {
                        let project_key = clean_path(&project_root);
                        let source = ProjectSkillSource {
                            path: current.to_string_lossy().into_owned(),
                            skill_count: roots.len() as u32,
                        };
                        let now = Utc::now().to_rfc3339();
                        let name = project_key
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| {
                                project_key.to_string_lossy().into_owned()
                            });
                        project_map
                            .entry(project_key.clone())
                            .and_modify(|existing| {
                                existing.skill_source_count += 1;
                                existing.skill_sources.push(source.clone());
                                existing.last_seen_at = now.clone();
                            })
                            .or_insert(ProjectRecord {
                                path: project_key.to_string_lossy().into_owned(),
                                name,
                                source: "scan".to_string(),
                                skill_source_count: 1,
                                skill_sources: vec![source],
                                last_seen_at: now,
                                pinned_set_ids: Vec::new(),
                            });
                    }
                    // Whether or not we recorded the project, the JS code
                    // returns here so we don't recurse into the skills/
                    // directory itself.
                    continue;
                }
            }
        }

        if depth >= ctx.max_depth {
            continue;
        }

        let entries = match fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(err) => {
                skipped.push(ScanSkippedEntry {
                    path: current.to_string_lossy().into_owned(),
                    reason: err.to_string(),
                });
                continue;
            }
        };

        let mut entries = entries;
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => {
                    let file_type = match entry.file_type().await {
                        Ok(ft) => ft,
                        Err(_) => continue,
                    };
                    if !file_type.is_dir() {
                        continue;
                    }
                    stack.push((entry.path(), depth + 1));
                }
                Ok(None) => break,
                Err(err) => {
                    skipped.push(ScanSkippedEntry {
                        path: current.to_string_lossy().into_owned(),
                        reason: err.to_string(),
                    });
                    break;
                }
            }
        }
    }
}

/// Top-level scan: walk every root, accumulating discovered project
/// records. Mirrors `core.js::scanProjectRoots`.
pub async fn scan_project_roots(
    roots: Option<&[String]>,
    max_depth: Option<u32>,
    home_dir: &Path,
    app_home: &Path,
    vault_root: &Path,
) -> ScanReport {
    let roots = normalize_scan_roots(roots, home_dir);
    let max_depth = max_depth.unwrap_or(10);
    let ctx = ScanContext {
        home_dir: home_dir.to_path_buf(),
        app_home: app_home.to_path_buf(),
        vault_root: vault_root.to_path_buf(),
        max_depth,
    };

    let mut project_map: BTreeMap<PathBuf, ProjectRecord> = BTreeMap::new();
    let mut skipped: Vec<ScanSkippedEntry> = Vec::new();

    for root in &roots {
        if fs::metadata(root).await.is_err() {
            skipped.push(ScanSkippedEntry {
                path: root.to_string_lossy().into_owned(),
                reason: "Path does not exist".to_string(),
            });
            continue;
        }
        walk_for_projects(root, &ctx, &mut project_map, &mut skipped).await;
    }

    let mut projects: Vec<ProjectRecord> = project_map.into_values().collect();
    projects.sort_by(|a, b| a.path.cmp(&b.path));

    let discovered = projects.len() as u32;
    let skipped_count = skipped.len() as u32;

    ScanReport {
        roots: roots
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        projects,
        skipped,
        discovered,
        skipped_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn root_dir() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn is_inside_path_basic() {
        assert!(is_inside_path(
            Path::new("/a/b/c"),
            Path::new("/a/b"),
        ));
        assert!(is_inside_path(Path::new("/a/b"), Path::new("/a/b")));
        assert!(!is_inside_path(Path::new("/a/bc"), Path::new("/a/b")));
        assert!(!is_inside_path(Path::new("/x"), Path::new("/a/b")));
    }

    #[test]
    fn default_scan_roots_includes_well_known_dirs() {
        let home = PathBuf::from("/Users/example");
        let roots = default_scan_roots(&home);
        assert!(roots.iter().any(|r| r.ends_with("code")));
        assert!(roots.iter().any(|r| r.ends_with("projects")));
        assert!(roots.iter().any(|r| r.ends_with("Developer")));
    }

    #[test]
    fn normalize_scan_roots_dedupes_and_expands() {
        let home = PathBuf::from("/Users/example");
        let inputs = vec![
            "/Users/example/code".to_string(),
            "/Users/example/code".to_string(),
            "/Users/example/work".to_string(),
        ];
        let resolved = normalize_scan_roots(Some(&inputs), &home);
        assert_eq!(resolved.len(), 2);
    }

    #[test]
    fn normalize_scan_roots_defaults_when_empty() {
        let home = PathBuf::from("/Users/example");
        let resolved = normalize_scan_roots(None, &home);
        assert!(!resolved.is_empty());
        let empty: Vec<String> = Vec::new();
        let resolved_empty = normalize_scan_roots(Some(&empty), &home);
        assert!(!resolved_empty.is_empty());
    }

    #[test]
    fn has_hidden_path_segment_detects_dotdirs() {
        let home = PathBuf::from("/Users/example");
        assert!(has_hidden_path_segment(
            &PathBuf::from("/Users/example/.codex/skills"),
            &home,
        ));
        assert!(!has_hidden_path_segment(
            &PathBuf::from("/Users/example/code/project"),
            &home,
        ));
        // Path outside home is not "hidden" via the home-relative check.
        assert!(!has_hidden_path_segment(
            &PathBuf::from("/tmp/.hidden/proj"),
            &home,
        ));
    }

    #[test]
    fn infer_project_root_strips_known_parents() {
        assert_eq!(
            infer_project_root_from_skill_dir(&PathBuf::from(
                "/repo/example/.agents/skills"
            )),
            Some(PathBuf::from("/repo/example")),
        );
        assert_eq!(
            infer_project_root_from_skill_dir(&PathBuf::from("/repo/example/skills")),
            Some(PathBuf::from("/repo/example")),
        );
    }

    #[test]
    fn is_global_harness_skill_dir_detects_known() {
        let home = PathBuf::from("/Users/example");
        assert!(is_global_harness_skill_dir(
            &PathBuf::from("/Users/example/.claude/skills"),
            &home,
        ));
        assert!(!is_global_harness_skill_dir(
            &PathBuf::from("/Users/example/code/proj/skills"),
            &home,
        ));
    }

    #[tokio::test]
    async fn has_project_marker_detects_git_dir() {
        let dir = root_dir();
        let proj = dir.path().join("proj");
        fs::create_dir_all(proj.join(".git")).await.unwrap();
        assert!(has_project_marker(&proj).await);
        assert!(!has_project_marker(dir.path()).await);
    }

    #[tokio::test]
    async fn scan_project_roots_finds_git_repos_within_depth() {
        let dir = root_dir();
        let home = dir.path().to_path_buf();
        let app_home = home.join(".skillworks");
        let vault = app_home.join("vault");
        fs::create_dir_all(&vault).await.unwrap();

        // Project with a git marker and a skill dir.
        let proj = home.join("code").join("proj-a");
        fs::create_dir_all(&proj).await.unwrap();
        fs::write(proj.join("Cargo.toml"), "[package]\nname=\"x\"\n").await.unwrap();
        let skill_dir = proj.join("skills").join("hello");
        fs::create_dir_all(&skill_dir).await.unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: hello\n---\n").await.unwrap();

        let roots = vec![home.join("code").to_string_lossy().into_owned()];
        let report = scan_project_roots(
            Some(&roots),
            Some(8),
            &home,
            &app_home,
            &vault,
        )
        .await;

        assert_eq!(report.discovered, 1, "should find one project");
        assert_eq!(report.projects[0].path, proj.to_string_lossy());
        assert_eq!(report.projects[0].source, "scan");
        assert_eq!(report.projects[0].skill_source_count, 1);
    }

    #[tokio::test]
    async fn scan_project_roots_skips_node_modules_and_dotdirs() {
        let dir = root_dir();
        let home = dir.path().to_path_buf();
        let app_home = home.join(".skillworks");
        let vault = app_home.join("vault");
        fs::create_dir_all(&vault).await.unwrap();

        // Real project we want to find.
        let real = home.join("code").join("real");
        fs::create_dir_all(&real).await.unwrap();
        fs::write(real.join("Cargo.toml"), "[package]\nname=\"r\"\n").await.unwrap();
        let real_skill = real.join("skills").join("a");
        fs::create_dir_all(&real_skill).await.unwrap();
        fs::write(real_skill.join("SKILL.md"), "---\nname: a\n---\n").await.unwrap();

        // node_modules sub-project that should be skipped.
        let nm = home.join("code").join("nm").join("node_modules").join("fake");
        fs::create_dir_all(&nm).await.unwrap();
        fs::write(nm.join("package.json"), "{}").await.unwrap();
        let nm_skill = nm.join("skills").join("x");
        fs::create_dir_all(&nm_skill).await.unwrap();
        fs::write(nm_skill.join("SKILL.md"), "---\nname: x\n---\n").await.unwrap();

        // Hidden dotdir under home that should be skipped.
        let hidden = home.join(".codex").join("plugins").join("cache").join("p");
        fs::create_dir_all(&hidden).await.unwrap();
        fs::write(hidden.join("package.json"), "{}").await.unwrap();
        let hidden_skill = hidden.join("skills").join("y");
        fs::create_dir_all(&hidden_skill).await.unwrap();
        fs::write(hidden_skill.join("SKILL.md"), "---\nname: y\n---\n").await.unwrap();

        let roots = vec![home.to_string_lossy().into_owned()];
        let report = scan_project_roots(
            Some(&roots),
            Some(10),
            &home,
            &app_home,
            &vault,
        )
        .await;

        let paths: Vec<String> = report.projects.iter().map(|p| p.path.clone()).collect();
        assert!(paths.iter().any(|p| p == &real.to_string_lossy()),
            "real project should be discovered, got: {:?}", paths);
        assert!(!paths.iter().any(|p| p.contains("node_modules")),
            "node_modules entries must be skipped, got: {:?}", paths);
        assert!(!paths.iter().any(|p| p.contains("/.codex/")),
            "hidden plugins cache entries must be skipped, got: {:?}", paths);
    }

    #[tokio::test]
    async fn scan_project_roots_respects_max_depth() {
        let dir = root_dir();
        let home = dir.path().to_path_buf();
        let app_home = home.join(".skillworks");
        let vault = app_home.join("vault");
        fs::create_dir_all(&vault).await.unwrap();

        // 5 levels deep below the scan root.
        let deep = home
            .join("code")
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("proj");
        fs::create_dir_all(&deep).await.unwrap();
        fs::write(deep.join("Cargo.toml"), "[package]\nname=\"d\"\n").await.unwrap();
        let skill_dir = deep.join("skills").join("x");
        fs::create_dir_all(&skill_dir).await.unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: x\n---\n").await.unwrap();

        let roots = vec![home.join("code").to_string_lossy().into_owned()];

        // Too shallow: should miss it.
        let shallow = scan_project_roots(Some(&roots), Some(2), &home, &app_home, &vault).await;
        assert_eq!(
            shallow.discovered, 0,
            "should not find project beyond max_depth=2"
        );

        // Deep enough: should find it.
        let deep_report =
            scan_project_roots(Some(&roots), Some(10), &home, &app_home, &vault).await;
        assert_eq!(
            deep_report.discovered, 1,
            "should find project at depth 5 with max_depth=10"
        );
    }
}
