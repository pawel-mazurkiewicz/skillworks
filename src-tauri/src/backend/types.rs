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

// ---------------------------------------------------------------------------
// Target DTOs (Phase 2B).
// ---------------------------------------------------------------------------

/// A skill destination directory the manager knows about.
///
/// Field set matches the union of `buildTargets` (in `core.js`, returns the
/// skeleton including `pathParts`/`custom`) and `inspectTarget` (which adds
/// `exists`, `manifestPath`, `enabledSkillIds`, `skillStatuses`, and the
/// `unmanaged` list). All fields are included unconditionally so the
/// frontend doesn't need to defend against optional shapes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRecord {
    pub id: String,
    pub label: String,
    pub harness: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_label: Option<String>,
    /// Absolute path to the target directory.
    pub path: String,
    /// Components used to compose `path` (relative to home or project).
    /// Empty for custom targets (which set `path`/`relativePath` directly).
    #[serde(default)]
    pub path_parts: Vec<String>,
    pub custom: bool,

    // Fields populated by `inspect_target`. Defaulted so the bare
    // `build_targets` result can serialize without inspection.
    #[serde(default)]
    pub exists: bool,
    #[serde(default)]
    pub manifest_path: String,
    #[serde(default)]
    pub enabled_skill_ids: Vec<String>,
    /// Per-skill status keyed by skill id. Uses `BTreeMap` for deterministic
    /// JSON ordering.
    #[serde(default)]
    pub skill_statuses: BTreeMap<String, SkillStatus>,
    #[serde(default)]
    pub unmanaged: Vec<UnmanagedEntry>,
}

/// Status of a single skill inside a target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub enabled: bool,
    pub managed: bool,
    pub link_name: String,
    pub link_path: String,
    pub conflict: bool,
    pub stale_manifest: bool,
}

/// An entry inside a target directory that wasn't installed by the manager.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmanagedEntry {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub path: String,
    #[serde(default)]
    pub real_path: String,
    /// Always present for symlink entries; empty otherwise.
    #[serde(default)]
    pub target: String,
    /// `"symlink" | "broken-symlink" | "directory"`.
    pub kind: String,
    pub importable: bool,
}

// ---------------------------------------------------------------------------
// Project DTOs (Phase 2B).
// ---------------------------------------------------------------------------

/// A project the user has registered or that scanning has discovered.
/// Mirrors `core.js::normalizeProjectRecords` / `buildProjectRecord`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub path: String,
    pub name: String,
    /// `"manual" | "scan" | "recent"` (free-form to match JS).
    pub source: String,
    #[serde(default)]
    pub skill_source_count: u32,
    #[serde(default)]
    pub skill_sources: Vec<ProjectSkillSource>,
    #[serde(default)]
    pub last_seen_at: String,
    #[serde(default)]
    pub pinned_set_ids: Vec<String>,
}

/// Origin of a [`ProjectRecord`] when constructing one from scratch.
#[derive(Debug, Clone, Copy)]
pub enum ProjectSource {
    Manual,
    Scanned,
    Recent,
}

impl ProjectSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectSource::Manual => "manual",
            ProjectSource::Scanned => "scan",
            ProjectSource::Recent => "recent",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillSource {
    pub path: String,
    pub skill_count: u32,
}

// ---------------------------------------------------------------------------
// Aggregate state returned by `get_state`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub app_home: String,
    pub config_path: String,
    pub vault_root: String,
    pub project: ProjectSelection,
    pub recent_projects: Vec<String>,
    pub projects: Vec<ProjectRecord>,
    pub skills: Vec<SkillRecord>,
    pub custom_targets: Vec<serde_json::Value>,
    pub hidden_target_ids: Vec<String>,
    pub targets: Vec<TargetRecord>,
    pub summary: StateSummary,
    pub discovery: DiscoveryReport,
    pub suggested_imports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSelection {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSummary {
    pub skill_count: u32,
    pub target_count: u32,
    pub enabled_count: u32,
    pub unmanaged_count: u32,
}

/// Minimal port of `core.js::discoverSources`. The frontend currently consumes
/// `discovery.sources` (each with `path`, `exists`, `importable`,
/// `importMode`, `skillCount`, `configFileCount`, `samples`) and
/// `discovery.summary`. We emit those fields with sensible defaults; the full
/// inspection pass will land in a later phase.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub sources: Vec<serde_json::Value>,
    pub summary: DiscoverySummary,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySummary {
    pub source_count: u32,
    pub existing_count: u32,
    pub importable_count: u32,
    pub skill_count: u32,
    pub config_file_count: u32,
}

// ---------------------------------------------------------------------------
// Skill CRUD DTOs (Phase 3).
// ---------------------------------------------------------------------------

/// Result of `read_skill_file`. Mirrors `core.js::readSkillFile`, which
/// returns `{ skill, content }`. We keep the `id` and `path` flat for
/// convenience in the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileContent {
    pub id: String,
    pub path: String,
    pub content: String,
}

/// One skill in a duplicate group as reported by `findVaultDuplicates`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub relative_path: String,
    /// Modification time in milliseconds since the Unix epoch (matches the
    /// JS `mtimeMs` field).
    pub mtime_ms: u64,
    pub bytes: u64,
}

/// Group of duplicate vault skills (identical `SKILL.md` bytes). Mirrors
/// the shape `core.js::findVaultDuplicates` emits for each group.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub hash: String,
    pub suggested_keeper_id: String,
    pub count: u32,
    pub skills: Vec<DuplicateSkillEntry>,
}

// ---------------------------------------------------------------------------
// Phase 4: scan / project / dialog DTOs.
// ---------------------------------------------------------------------------

/// Skipped scan entry: a directory the walker bailed on, with a reason.
/// Mirrors the `{ path, reason }` shape emitted by
/// `core.js::scanProjectRoots`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSkippedEntry {
    pub path: String,
    pub reason: String,
}

/// Per-scan summary returned to the frontend. Mirrors the fields the JS
/// client consumes from `scanProjects`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Resolved roots that were walked.
    pub roots: Vec<String>,
    /// Project records discovered by this scan (post-merge dedup with
    /// existing config records happens upstream).
    #[serde(default)]
    pub projects: Vec<ProjectRecord>,
    /// Directories that were skipped (with their reason).
    #[serde(default)]
    pub skipped: Vec<ScanSkippedEntry>,
    /// Aggregate counts for the simplified Phase-4 surface.
    #[serde(default)]
    pub discovered: u32,
    /// Total skipped count (mirrors `skipped.len()`).
    #[serde(default)]
    pub skipped_count: u32,
}

/// Top-level response for `scan_projects`: scan report + the refreshed
/// application state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProjectsResponse {
    pub state: State,
    pub report: ScanReport,
}

/// Response for `pick_directory`. `path` is `None` when the user cancelled
/// the picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDirectoryResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

// ---------------------------------------------------------------------------
// Phase 5: imports + git install DTOs.
// ---------------------------------------------------------------------------

/// One skill the importer moved (or deduped) into the vault. Mirrors the
/// per-item shape produced by `core.js::importSource` (the `imported` list).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSkill {
    pub name: String,
    pub from: String,
    pub moved_source: String,
    pub to: String,
    /// `"directory" | "symlink"`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deduped: bool,
}

/// A path the importer chose not to move, with a human-readable reason.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkipped {
    pub path: String,
    pub reason: String,
}

/// Per-source error in `import_suggested_skills` / `import_paths`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportErrorEntry {
    pub path: String,
    pub reason: String,
}

/// Aggregate counts returned alongside the refreshed state from an import.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u32,
    pub skipped: u32,
    pub errors: u32,
}

/// Response shape for `import_skills`: full per-item lists plus the
/// refreshed state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillsResponse {
    pub imported: Vec<ImportedSkill>,
    pub skipped: Vec<ImportSkipped>,
    pub state: State,
}

/// Response shape for `import_suggested_skills`: collapsed counts plus the
/// refreshed state (matches the existing `/api/import-paths` server route).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSuggestedResponse {
    pub state: State,
    pub report: ImportReport,
}

/// A single candidate row in `preview_git_install`'s plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallCandidate {
    pub name: String,
    pub source_path: String,
    pub real_source_path: String,
    pub source_key: String,
    pub kind: String,
    /// `"move" | "dedupe" | "skip"`.
    pub action: String,
    #[serde(default)]
    pub skip_reason: String,
    #[serde(default)]
    pub will_dedupe: bool,
    pub vault_destination: String,
    pub link_name: String,
    pub target_links: Vec<GitInstallTargetLink>,
}

/// Per-target link entry inside a `GitInstallCandidate`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallTargetLink {
    pub target_id: String,
    pub target_label: String,
    pub scope: String,
    pub link_name: String,
    pub link_path: String,
}

/// One of the targets the install plan would link skills into.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallTarget {
    pub id: String,
    pub label: String,
    pub scope: String,
    pub path: String,
}

/// Origin descriptor echoed in the plan (parsed from `repoUrl` + `ref`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallSource {
    pub repo_url: String,
    #[serde(default)]
    pub r#ref: String,
    #[serde(default)]
    pub subdir: String,
}

/// Aggregate counts for the plan. Mirrors `previewInstall.summary` in
/// `core.js`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallSummary {
    pub candidates: u32,
    pub to_move: u32,
    pub to_dedupe: u32,
    pub to_skip: u32,
}

/// Top-level response for `preview_git_install`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallPlan {
    pub source: GitInstallSource,
    pub vault_root: String,
    pub candidates: Vec<GitInstallCandidate>,
    pub targets: Vec<GitInstallTarget>,
    pub summary: GitInstallSummary,
}

/// Aggregate counts returned by `install_from_git`. Mirrors the
/// `/api/install-git` response (`{ state, report: { imported, skipped,
/// enabled, errors } }`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub imported: u32,
    pub skipped: u32,
    pub enabled: u32,
    pub errors: u32,
}

/// Top-level response for `install_from_git`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallFromGitResponse {
    pub state: State,
    pub report: InstallReport,
}

// ---------------------------------------------------------------------------
// Phase 6: Skill set DTOs.
// ---------------------------------------------------------------------------

/// A saved skill set: a named collection of `(skillName, targetKey)` pairs
/// that can be applied to flip the matrix to a known configuration in one
/// step. Mirrors the JS shape produced by `src/sets.js::normalizeSet`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Set {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// `"global"` or `"project"`.
    pub scope: String,
    /// Present iff `scope == "project"`. Skipped on serialize when absent
    /// so global sets match the JS shape exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub entries: Vec<SetEntry>,
    pub created_at: String,
    pub updated_at: String,
}

/// One `(skillName, targetKey)` pair inside a [`Set`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetEntry {
    pub skill_name: String,
    pub target_key: String,
}

/// `listSets` response: global + project-scoped sets plus the project's
/// pinned-set resolution. Mirrors `core.js::listSets`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSetsResponse {
    pub global: Vec<Set>,
    pub project: Vec<Set>,
    pub pinned: PinnedSets,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedSets {
    pub ids: Vec<String>,
    pub resolved: Vec<Set>,
    pub missing: Vec<String>,
}

/// Response from `create_set` / `snapshot_set`: the new set plus refreshed
/// state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSetResponse {
    pub set: Set,
    pub state: State,
}

/// Response from `update_set`: the updated set plus refreshed state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSetResponse {
    pub set: Set,
    pub state: State,
}

/// Response from `delete_set`: the deleted id plus refreshed state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSetResponse {
    pub deleted_id: String,
    pub state: State,
}

/// Per-target plan row from `plan_apply_set`. Mirrors the rows pushed onto
/// `result.targets` in `core.js::planApplySet`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySetTargetPlan {
    pub target_id: String,
    pub target_label: String,
    /// Set to `true` (and serialized) when the touched target id doesn't
    /// resolve to a known target. JS uses `missingTarget: true` only on
    /// the missing rows; we mirror that with `skip_serializing_if`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing_target: bool,
    pub to_enable: Vec<String>,
    pub to_disable: Vec<String>,
    pub missing: Vec<String>,
}

/// Result of `plan_apply_set`: a dry-run plan that tells the UI what apply
/// will do without changing any symlinks. Mirrors
/// `core.js::planApplySet`'s return shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySetPlan {
    pub set_id: String,
    pub name: String,
    pub targets: Vec<ApplySetTargetPlan>,
}

/// Per-target result of `apply_set`. Status is one of `"applied" |
/// "failed" | "skipped"`. `reason` is populated for non-success rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySetTargetResult {
    pub target_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Top-level response from `apply_set`: the plan that was executed, the
/// per-target outcome, any warnings, and the refreshed state. Mirrors
/// `core.js::applySet`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySetResponse {
    pub plan: ApplySetPlan,
    pub per_target_result: Vec<ApplySetTargetResult>,
    pub warnings: Vec<String>,
    pub state: State,
}
