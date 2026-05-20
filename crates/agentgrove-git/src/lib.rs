//! Git operations for AgentGrove.
//!
//! Read-only operations (status, diff, blob lookup) use `gix`. Worktree
//! mutations shell out to the `git` binary (see ADR-0004).

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod branches;
pub mod inspect;
pub mod status;
pub mod worktree;

pub use branches::{list_local, switch_branch, BranchInfo};
pub use inspect::{inspect_repo, RepoInfo};
pub use status::{status, StatusEntry};
pub use worktree::{add_worktree, init_repo, list_worktrees, remove_worktree, GitError};

/// Returns this crate's version string. Used by smoke tests.
#[must_use]
pub fn gix_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
