//! DTOs that travel over IPC between the Tauri Rust backend and the
//! JavaScript frontend. Filled in across later phases of the Rust backend
//! refactor (see `docs/superpowers/plans/2026-05-19-rust-backend-refactor.md`).
//!
//! All structs in this module derive `serde::Serialize` / `serde::Deserialize`
//! with `#[serde(rename_all = "camelCase")]` so the JS field names stay
//! unchanged across the port.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Parsed `SKILL.md` metadata. Mirrors the object returned by
/// `readSkillMetadata` in `src/core.js`, plus the additional bookkeeping
/// fields (`tags`, `version`, `raw`) requested by the Rust refactor plan.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub author: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The `type` (or `category`) field as resolved by `readSkillMetadata`.
    /// Kept as an `Option` to distinguish "absent" from "empty string"; the
    /// JS layer treats both as falsy.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_: Option<String>,
    /// The full parsed frontmatter, retained for forward-compat with
    /// frontmatter keys the typed fields do not yet cover. Serialized as a
    /// JSON object so the JS frontend can introspect it directly.
    #[serde(default)]
    pub raw: serde_json::Value,
}

/// A skill discovered inside the vault. Field set matches `discoverSkills`
/// in `src/core.js` (so the existing frontend stays source-compatible),
/// extended with `skillFile`, `sizeBytes`, and `modifiedAt` for the Rust
/// refactor plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    /// Canonical relative-path-derived ID (`normalizePath(relative(vault, root))`).
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    /// Same as `id`; preserved as a separate field for parity with `core.js`.
    pub relative_path: String,
    /// `type` / `category` from the frontmatter (`""` when absent), matching
    /// the JS shape.
    #[serde(rename = "type")]
    pub type_: String,
    /// Absolute path to the skill directory.
    pub path: String,
    /// `fs::realpath`-resolved version of `path` (follows symlinks).
    pub real_path: String,
    /// Symlink basename used when this skill is linked into a target.
    /// Assigned during discovery from `safeSegment(name)`, disambiguated
    /// with a short hash on collision.
    pub link_name: String,
    pub tags: Vec<String>,
    /// Absolute path to the skill's `SKILL.md` file.
    pub skill_file: String,
    /// Byte length of `SKILL.md`.
    pub size_bytes: u64,
    /// RFC3339 timestamp of `SKILL.md`'s last modification.
    pub modified_at: String,
}

/// Per-target manifest stored as `.agent-skill-manager.json` inside every
/// skill destination directory. Mirrors the JS shape from
/// `core.js::readManifest` / `writeManifest`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    /// Map of symlink basename → manifest entry describing the link the app
    /// owns. Using `BTreeMap` keeps the serialized output stable across
    /// writes (helpful for diff-friendly storage).
    pub managed_links: BTreeMap<String, ManifestEntry>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: 1,
            managed_links: BTreeMap::new(),
        }
    }
}

/// Single managed-link record inside a target manifest. The JS code writes
/// these as opaque objects; we keep the value typed as `serde_json::Value`
/// for now since the inner schema (skill id, source path, set membership)
/// is still in flux and will be hardened in later phases.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct ManifestEntry(pub serde_json::Value);
