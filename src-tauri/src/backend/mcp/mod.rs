//! MCP server management: canonical library + per-harness config engine.
//!
//! Phase A of the MCP-management feature (see
//! docs/superpowers/specs/2026-07-20-mcp-management-phase-a-design.md).

pub mod adapters;
pub mod dismissed;
pub mod engine;
pub mod net;
pub mod parse;
pub mod reconcile;
pub mod spec;
