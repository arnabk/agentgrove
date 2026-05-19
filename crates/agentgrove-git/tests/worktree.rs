//! Live worktree mutations against a tempdir git repo.

use agentgrove_git::{add_worktree, init_repo, list_worktrees, remove_worktree};
use std::fs;
use tempfile::tempdir;

#[tokio::test]
async fn init_then_add_then_remove_worktree() {
    let dir = tempdir().unwrap();
    let repo = dir.path().join("repo");
    init_repo(&repo).await.unwrap();

    let wt = dir.path().join("wt-a");
    add_worktree(&repo, &wt, "feature-a", "main").await.unwrap();

    assert!(wt.exists(), "worktree dir must exist");
    let listing = list_worktrees(&repo).await.unwrap();
    assert!(
        listing.contains("wt-a"),
        "worktree must appear in listing: {listing}"
    );

    // The new worktree should be on the new branch.
    let head = fs::read_to_string(wt.join(".git")).unwrap_or_default();
    assert!(
        !head.is_empty(),
        ".git pointer file expected inside worktree"
    );

    remove_worktree(&repo, &wt).await.unwrap();
    assert!(!wt.exists(), "worktree dir must be removed");
}

#[tokio::test]
async fn add_with_invalid_base_ref_fails_cleanly() {
    let dir = tempdir().unwrap();
    let repo = dir.path().join("repo");
    init_repo(&repo).await.unwrap();

    let wt = dir.path().join("wt-x");
    let err = add_worktree(&repo, &wt, "broken", "nonexistent-ref")
        .await
        .unwrap_err();
    // Just assert it's a non-zero git failure, not a panic.
    let msg = format!("{err}");
    assert!(msg.contains("git command failed"), "got: {msg}");
}
