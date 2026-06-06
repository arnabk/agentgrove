//! Git operations for AgentGrove.
//!
//! Read-only operations (status, diff, blob lookup) use `gix`. Worktree
//! mutations shell out to the `git` binary (see ADR-0004).

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod branches;
pub mod drift;
pub mod inspect;
pub mod status;
pub mod worktree;

pub use branches::{list_local, switch_branch, BranchInfo};
pub use drift::{
    check_drift_full, check_drift_quick, check_pr, detect_forge, DriftInfo, ForgeInfo, PrInfo,
};
pub use inspect::{inspect_repo, RepoInfo};
pub use status::{status, StatusEntry};
pub use worktree::{
    add_worktree, delete_branch, discard_path, fetch_ref, init_repo, list_worktrees,
    prune_worktrees, remove_worktree, rename_branch, DiscardOutcome, GitError,
};

/// Returns this crate's version string. Used by smoke tests.
#[must_use]
pub fn gix_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
