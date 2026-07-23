//! Phase B: heuristic URL → draft-spec ingestion.
//! Spec: docs/superpowers/specs/2026-07-20-mcp-management-phase-b-design.md
//!
//! Split per Phase D §5.2: `url` (network-free URL classification), `fences`
//! (fence scanning + JSONC tolerance), `heuristics` (H1/H2/H3 candidate
//! extraction), `assembly` (draft grouping, folding, placeholder warnings).

mod assembly;
mod fences;
mod heuristics;
mod url;

pub use assembly::{extract_drafts, ExtractionResult};
pub use url::{source_for_url, FetchPlan};

pub(crate) use assembly::{placeholder_warnings, slugify};
