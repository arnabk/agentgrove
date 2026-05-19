//! Core domain types and errors for AgentGrove.
//!
//! This crate is pure (no I/O). All other crates depend on it.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod error;
pub mod ids;
pub mod project;

pub use error::{Error, Result};
pub use ids::{ChatId, ProjectId, PromptId, WorktreeId};
pub use project::Project;
