//! Persistence layer for AgentGrove.
//!
//! M1 scope: SQLite-backed metadata + on-disk content-addressed blobs.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod blob;
pub mod chat;
pub mod db;
pub mod layout;
pub mod project;
pub mod provider_secret;
pub mod queue;
pub mod secret;
pub mod worktree;

pub use blob::{BlobStore, Sha256};
pub use chat::{ChatError, ChatRepo, ChatRow, PromptRow};
pub use db::{open_pool, run_migrations, snapshot_db_to_backups, DbPool, MAX_DB_BACKUPS};
pub use layout::{LayoutError, LayoutRepo};
pub use project::{NewProject, ProjectError, ProjectRecord, ProjectRepo};
pub use provider_secret::{
    ProviderSecret, ProviderSecretError, ProviderSecretRepo, ProviderSecretSummary,
};
pub use queue::{QueueError, QueueItemRow, QueueMode, QueueRepo, QueueStatus};
pub use secret::{SecretError, SecretKeyring};
pub use worktree::{NewWorktree, WorktreeError, WorktreeRecord, WorktreeRepo, WorktreeStatus};
