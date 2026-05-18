//! Skill discovery and per-target manifests.
//!
//! Ports `findSkillRoots`, `readSkillMetadata`, `discoverSkills`,
//! `readManifest`, and `writeManifest` from `src/core.js`. The goal is byte-
//! for-byte parity with the JS layer's output (IDs, sort order, link-name
//! disambiguation, manifest shape) so the existing frontend can talk to
//! either backend during the migration window.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sha1::{Digest, Sha1};
use tokio::fs;
use walkdir::WalkDir;

use super::fs_atomic::write_json_atomic;
use super::frontmatter;
use super::state::{BackendError, BackendResult};
use super::types::{Manifest, SkillMetadata, SkillRecord};

/// File names recognized by the skill layer. Kept as module constants so
/// the values stay in lockstep with `src/core.js`.
pub const SKILL_FILE: &str = "SKILL.md";
pub const MANIFEST_FILE: &str = ".agent-skill-manager.json";

const SKIP_DIRS: &[&str] = &[".git", "node_modules"];

/// Read and parse a skill's `SKILL.md` into a [`SkillMetadata`].
///
/// Mirrors `readSkillMetadata` in `core.js`, with two additions:
/// 1. We retain the full parsed frontmatter on `metadata.raw`.
/// 2. We expose `version` if the frontmatter sets it.
pub async fn read_skill_metadata(skill_dir: &Path) -> BackendResult<SkillMetadata> {
    let skill_path = skill_dir.join(SKILL_FILE);
    let raw_text = fs::read_to_string(&skill_path).await?;
    let parsed = frontmatter::parse(&raw_text);

    let name = frontmatter::string_field(&parsed.data, "name").unwrap_or_default();
    let description =
        frontmatter::string_field(&parsed.data, "description").unwrap_or_default();
    let author = frontmatter::string_field(&parsed.data, "author").unwrap_or_default();
    let version = frontmatter::string_field(&parsed.data, "version");

    // Matches `metadata.type || metadata.category` in `core.js::readSkillMetadata`.
    let type_ = frontmatter::string_field(&parsed.data, "type")
        .or_else(|| frontmatter::string_field(&parsed.data, "category"));

    // `tags` may legitimately come from the frontmatter as a list; honor that
    // when present. `discoverSkills` is still the canonical place to compute
    // inferred tags when this field is empty.
    let tags = match parsed.data.get("tags") {
        Some(serde_yaml::Value::Sequence(seq)) => seq
            .iter()
            .filter_map(|v| match v {
                serde_yaml::Value::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        Some(serde_yaml::Value::String(s)) => s
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect(),
        _ => Vec::new(),
    };

    // Re-encode the YAML frontmatter as JSON so the IPC layer can hand it to
    // the frontend without an extra serializer round-trip.
    let raw = serde_yaml::from_value::<serde_json::Value>(parsed.data.clone())
        .unwrap_or(serde_json::Value::Null);

    Ok(SkillMetadata {
        name,
        description,
        author,
        tags,
        version,
        type_,
        raw,
    })
}

/// Walk `dir` recursively and return every directory that directly contains
/// a `SKILL.md` file. Ports `findSkillRoots` from `core.js`.
///
/// Behavior notes:
/// - When `dir` itself contains a `SKILL.md`, only `[dir]` is returned (the
///   JS code short-circuits the same way).
/// - `.git` and `node_modules` are skipped to match the JS walker.
/// - Once a directory matches, descent into its children stops (a skill is
///   atomic; nested `SKILL.md` inside a skill is ignored).
/// - Results are sorted lexicographically by absolute path.
pub async fn find_skill_roots(dir: &Path) -> BackendResult<Vec<PathBuf>> {
    if !fs::try_exists(dir).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    let root_skill_md = dir.join(SKILL_FILE);
    if fs::try_exists(&root_skill_md).await.unwrap_or(false) {
        return Ok(vec![dir.to_path_buf()]);
    }

    // `walkdir` is sync; we wrap it in `spawn_blocking` so we don't stall the
    // async runtime on large vaults. The traversal cost dominates the
    // wrapper overhead.
    let dir = dir.to_path_buf();
    let roots = tokio::task::spawn_blocking(move || {
        let mut found: Vec<PathBuf> = Vec::new();
        let walker = WalkDir::new(&dir)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                // Always allow the root through.
                if entry.depth() == 0 {
                    return true;
                }
                if !entry.file_type().is_dir() {
                    return true;
                }
                let name = entry.file_name().to_string_lossy();
                !SKIP_DIRS.iter().any(|s| *s == name)
            });

        // Once a directory is recognized as a skill root, we prune its
        // subtree so nested skills don't create duplicates.
        let mut pruned: Vec<PathBuf> = Vec::new();
        for entry in walker.flatten() {
            if !entry.file_type().is_dir() {
                continue;
            }
            let path = entry.path();
            // Skip anything under an already-recorded root.
            if pruned.iter().any(|root| path.starts_with(root)) {
                continue;
            }
            if path.join(SKILL_FILE).is_file() {
                found.push(path.to_path_buf());
                pruned.push(path.to_path_buf());
            }
        }
        found.sort();
        found
    })
    .await
    .map_err(|err| BackendError::Validation(format!("walkdir join error: {err}")))?;

    Ok(roots)
}

/// Discover every skill under `vault_root` and return a sorted list with
/// disambiguated link names. Ports `discoverSkills` from `core.js`.
///
/// Ordering and link-name assignment match the JS implementation exactly:
/// skills are sorted by `name` (then a deterministic `safe_segment` of that
/// name becomes the link basename; collisions are suffixed with the first
/// 8 hex chars of `SHA-1(id)`).
pub async fn discover_skills(vault_root: &Path) -> BackendResult<Vec<SkillRecord>> {
    let roots = find_skill_roots(vault_root).await?;
    let mut skills = Vec::with_capacity(roots.len());

    for root in roots {
        let skill_md = root.join(SKILL_FILE);
        let metadata = read_skill_metadata(&root).await?;
        let file_meta = fs::metadata(&skill_md).await?;

        let relative = root
            .strip_prefix(vault_root)
            .unwrap_or(&root)
            .to_path_buf();
        let id = normalize_path(&relative);

        let real_path = fs::canonicalize(&root)
            .await
            .unwrap_or_else(|_| root.clone());

        let modified_at = file_meta
            .modified()
            .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
            .unwrap_or_default();

        let name = if metadata.name.is_empty() {
            root.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            metadata.name.clone()
        };

        let author = if metadata.author.is_empty() {
            infer_author(&id)
        } else {
            metadata.author.clone()
        };

        let type_ = metadata.type_.clone().unwrap_or_default();

        let tags_seed = format!("{} {} {}", name, metadata.description, id);
        let tags = infer_tags(&tags_seed);

        skills.push(SkillRecord {
            id: id.clone(),
            name,
            description: metadata.description,
            author,
            relative_path: id,
            type_,
            path: root.to_string_lossy().into_owned(),
            real_path: real_path.to_string_lossy().into_owned(),
            link_name: String::new(),
            tags,
            skill_file: skill_md.to_string_lossy().into_owned(),
            size_bytes: file_meta.len(),
            modified_at,
        });
    }

    // Sort by name (locale-insensitive; `localeCompare` defaults to a
    // case-sensitive code-point compare on ASCII, which matches `Ord` for
    // our purposes).
    skills.sort_by(|a, b| a.name.cmp(&b.name));

    let mut used = std::collections::HashSet::<String>::new();
    for skill in skills.iter_mut() {
        let base = safe_segment(if skill.name.is_empty() {
            &skill.relative_path
        } else {
            &skill.name
        });
        let mut link_name = base.clone();
        if used.contains(&link_name) {
            link_name = format!("{}-{}", base, short_hash(&skill.id));
        }
        used.insert(link_name.clone());
        skill.link_name = link_name;
    }

    Ok(skills)
}

/// Read the per-target manifest from `skill_dir/.agent-skill-manager.json`.
/// Returns a default manifest when the file does not exist, matching
/// `core.js::readManifest`.
pub async fn read_manifest(skill_dir: &Path) -> BackendResult<Manifest> {
    let manifest_path = skill_dir.join(MANIFEST_FILE);
    match fs::read(&manifest_path).await {
        Ok(bytes) => {
            // Be tolerant of older manifests that omit `managedLinks` /
            // `version`: deserialize via `Value`, then merge over the default.
            let raw: serde_json::Value =
                serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
            let mut manifest = Manifest::default();
            if let Some(version) = raw.get("version").and_then(|v| v.as_u64()) {
                manifest.version = version as u32;
            }
            if let Some(managed) = raw.get("managedLinks").and_then(|v| v.as_object()) {
                for (key, value) in managed {
                    manifest.managed_links.insert(
                        key.clone(),
                        super::types::ManifestEntry(value.clone()),
                    );
                }
            }
            Ok(manifest)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(err) => Err(BackendError::Io(err)),
    }
}

/// Atomically write a manifest. Creates parent directories as needed,
/// matching `core.js::writeManifest`.
pub async fn write_manifest(skill_dir: &Path, manifest: &Manifest) -> BackendResult<()> {
    fs::create_dir_all(skill_dir).await?;
    write_json_atomic(&skill_dir.join(MANIFEST_FILE), manifest).await
}

// ---------------------------------------------------------------------------
// Helpers (ported from `core.js` utility section).
// ---------------------------------------------------------------------------

fn normalize_path(path: &Path) -> String {
    // `core.js::normalizePath` swaps the OS separator for `/`; on Unix this
    // is a no-op, on Windows it converts `\` → `/`.
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn infer_author(id: &str) -> String {
    let parts: Vec<&str> = id.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() > 1 {
        parts[0].to_string()
    } else {
        "Local".to_string()
    }
}

fn safe_segment(value: &str) -> String {
    let lowered = value.to_lowercase();
    // Replace any run of characters outside [a-z0-9._-] with a single dash.
    let mut segment = String::with_capacity(lowered.len());
    let mut last_was_dash = false;
    for ch in lowered.chars() {
        let allowed = ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || matches!(ch, '.' | '_' | '-');
        if allowed {
            segment.push(ch);
            last_was_dash = ch == '-';
        } else if !last_was_dash {
            segment.push('-');
            last_was_dash = true;
        }
    }
    // Trim leading / trailing dashes.
    let trimmed = segment.trim_matches('-').to_string();
    // Cap at 80 chars to match `core.js`.
    let capped: String = trimmed.chars().take(80).collect();
    if capped.is_empty() {
        "skill".to_string()
    } else {
        capped
    }
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(value.as_bytes());
    let result = hasher.finalize();
    let hex = result.iter().map(|b| format!("{b:02x}")).collect::<String>();
    hex.chars().take(8).collect()
}

/// Port of `inferTags`: a small rule-based tagger that turns the skill's
/// (name + description + id) into 1–3 broad category tags.
fn infer_tags(text: &str) -> Vec<String> {
    use regex::Regex;
    let haystack = text.to_lowercase();
    let rules: &[(&str, &str)] = &[
        ("iOS", r"\b(swift|swiftui|xcode|ios|app intents?|siri|widget)\b"),
        (
            "Web",
            r"\b(react|vue|svelte|frontend|tailwind|css|html|browser|vite)\b",
        ),
        (
            "Backend",
            r"\b(node|express|api|backend|oauth|redis|postgres|database|microservice)\b",
        ),
        (
            "Infra",
            r"\b(terraform|devops|ci/cd|github actions|docker|kubernetes|deploy)\b",
        ),
        (
            "Docs",
            r"\b(docx|document|pptx|presentation|xlsx|spreadsheet|pdf)\b",
        ),
        (
            "Media",
            r"\b(image|video|vision|shader|multimodal|audio|gif)\b",
        ),
    ];

    let mut tags = Vec::new();
    for (label, pattern) in rules {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(&haystack) {
                tags.push((*label).to_string());
            }
        }
    }
    if tags.is_empty() {
        vec!["General".to_string()]
    } else {
        tags.truncate(3);
        tags
    }
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
    async fn read_skill_metadata_full() {
        let dir = TempDir::new().unwrap();
        let skill_dir = dir.path().join("swiftui");
        fs::create_dir_all(&skill_dir).await.unwrap();
        let body = "---\nname: SwiftUI Patterns\ndescription: Use for SwiftUI iOS views.\nauthor: Paweł\nversion: 1.2.0\ntype: ios\n---\n\n# Body\n";
        fs::write(skill_dir.join(SKILL_FILE), body).await.unwrap();

        let metadata = read_skill_metadata(&skill_dir).await.unwrap();
        assert_eq!(metadata.name, "SwiftUI Patterns");
        assert_eq!(metadata.description, "Use for SwiftUI iOS views.");
        assert_eq!(metadata.author, "Paweł");
        assert_eq!(metadata.version.as_deref(), Some("1.2.0"));
        assert_eq!(metadata.type_.as_deref(), Some("ios"));
    }

    #[tokio::test]
    async fn read_skill_metadata_missing_fields() {
        let dir = TempDir::new().unwrap();
        let skill_dir = dir.path().join("empty");
        fs::create_dir_all(&skill_dir).await.unwrap();
        fs::write(skill_dir.join(SKILL_FILE), "no frontmatter here\n")
            .await
            .unwrap();

        let metadata = read_skill_metadata(&skill_dir).await.unwrap();
        assert_eq!(metadata.name, "");
        assert_eq!(metadata.description, "");
        assert_eq!(metadata.author, "");
        assert!(metadata.version.is_none());
        assert!(metadata.type_.is_none());
    }

    #[tokio::test]
    async fn discover_skills_finds_nested() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        write_skill(
            &vault.join("ios/swiftui"),
            "SwiftUI Patterns",
            "Use for SwiftUI iOS views.",
        )
        .await;
        write_skill(
            &vault.join("web/react"),
            "React Patterns",
            "Use for React frontend.",
        )
        .await;
        write_skill(
            &vault.join("backend/node/express"),
            "Express Routing",
            "Use for Node Express API design.",
        )
        .await;
        // Should be skipped:
        fs::create_dir_all(vault.join("node_modules/foo")).await.unwrap();
        fs::write(
            vault.join("node_modules/foo").join(SKILL_FILE),
            "---\nname: Hidden\n---\n",
        )
        .await
        .unwrap();

        let skills = discover_skills(&vault).await.unwrap();
        let ids: Vec<&str> = skills.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["backend/node/express", "web/react", "ios/swiftui"]
        );
        // Sorted by name: "Express Routing", "React Patterns", "SwiftUI Patterns".
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Express Routing", "React Patterns", "SwiftUI Patterns"]
        );

        // Tags are inferred from name/description/id.
        let swiftui = skills
            .iter()
            .find(|s| s.id == "ios/swiftui")
            .expect("swiftui skill");
        assert!(swiftui.tags.contains(&"iOS".to_string()));

        // Link names are unique safe segments.
        let express = skills
            .iter()
            .find(|s| s.id == "backend/node/express")
            .unwrap();
        assert_eq!(express.link_name, "express-routing");

        // Author falls back to the first path segment when the frontmatter
        // omits it.
        assert_eq!(express.author, "backend");
    }

    #[tokio::test]
    async fn discover_skills_disambiguates_link_names() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        write_skill(&vault.join("a/dup"), "Dup", "first").await;
        write_skill(&vault.join("b/dup"), "Dup", "second").await;

        let skills = discover_skills(&vault).await.unwrap();
        assert_eq!(skills.len(), 2);
        let names: std::collections::HashSet<_> =
            skills.iter().map(|s| s.link_name.clone()).collect();
        assert_eq!(names.len(), 2, "link names must be unique: {:?}", names);
        assert!(names.iter().any(|n| n == "dup"));
        assert!(names.iter().any(|n| n.starts_with("dup-")));
    }

    #[tokio::test]
    async fn discover_skills_empty_vault() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path().join("vault");
        fs::create_dir_all(&vault).await.unwrap();
        let skills = discover_skills(&vault).await.unwrap();
        assert!(skills.is_empty());
    }

    #[tokio::test]
    async fn manifest_round_trip() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("target");
        fs::create_dir_all(&target).await.unwrap();

        // Missing → default.
        let initial = read_manifest(&target).await.unwrap();
        assert_eq!(initial, Manifest::default());

        // Write a populated manifest.
        let mut manifest = Manifest::default();
        manifest.managed_links.insert(
            "swiftui-patterns".to_string(),
            super::super::types::ManifestEntry(serde_json::json!({
                "skillId": "ios/swiftui",
                "sourcePath": "/vault/ios/swiftui",
                "linkName": "swiftui-patterns",
            })),
        );
        write_manifest(&target, &manifest).await.unwrap();

        // Round-trip.
        let loaded = read_manifest(&target).await.unwrap();
        assert_eq!(loaded, manifest);

        // The file should be written under MANIFEST_FILE.
        assert!(target.join(MANIFEST_FILE).is_file());
    }

    #[tokio::test]
    async fn find_skill_roots_at_root() {
        let dir = TempDir::new().unwrap();
        write_skill(dir.path(), "Top Skill", "lives at root").await;
        let roots = find_skill_roots(dir.path()).await.unwrap();
        assert_eq!(roots, vec![dir.path().to_path_buf()]);
    }

    #[tokio::test]
    async fn find_skill_roots_missing_dir() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("nope");
        let roots = find_skill_roots(&missing).await.unwrap();
        assert!(roots.is_empty());
    }
}
