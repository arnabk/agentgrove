//! Persistence layer for AgentGrove.
//!
//! M1 scope: SQLite-backed metadata + on-disk content-addressed blobs.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod blob;
pub mod db;
pub mod project;
pub mod worktree;

pub use blob::{BlobStore, Sha256};
pub use db::{open_pool, run_migrations, DbPool};
pub use project::{NewProject, ProjectError, ProjectRecord, ProjectRepo};
pub use worktree::{NewWorktree, WorktreeError, WorktreeRecord, WorktreeRepo, WorktreeStatus};
