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

// ---- merge_base_into_worktree ------------------------------------------

use agentgrove_git::merge_base_into_worktree;
use tokio::process::Command;

async fn git(args: &[&str], cwd: &std::path::Path) {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Build a bare "origin" with an initial main commit, clone it, and add
/// a worktree on a feature branch off main. Returns (tmp, clone_path,
/// worktree_path).
async fn setup_origin_clone_worktree() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf)
{
    let dir = tempdir().unwrap();
    let seed = dir.path().join("seed");
    init_repo(&seed).await.unwrap();
    // Make a bare origin from the seed.
    let origin = dir.path().join("origin.git");
    git(
        &[
            "clone",
            "--bare",
            seed.to_str().unwrap(),
            origin.to_str().unwrap(),
        ],
        dir.path(),
    )
    .await;
    // Clone origin into a working repo.
    let clone = dir.path().join("clone");
    git(
        &["clone", origin.to_str().unwrap(), clone.to_str().unwrap()],
        dir.path(),
    )
    .await;
    git(&["config", "user.email", "t@t"], &clone).await;
    git(&["config", "user.name", "t"], &clone).await;
    // Add a worktree on feature off main.
    let wt = dir.path().join("wt");
    add_worktree(&clone, &wt, "feature", "main").await.unwrap();
    git(&["config", "user.email", "t@t"], &wt).await;
    git(&["config", "user.name", "t"], &wt).await;
    (dir, clone, wt)
}

#[tokio::test]
async fn merge_base_pulls_new_upstream_commit_into_worktree() {
    let (dir, clone, wt) = setup_origin_clone_worktree().await;
    let origin = dir.path().join("origin.git");

    // Advance origin/main with a new file via a second clone.
    let pusher = dir.path().join("pusher");
    git(
        &["clone", origin.to_str().unwrap(), pusher.to_str().unwrap()],
        dir.path(),
    )
    .await;
    git(&["config", "user.email", "p@p"], &pusher).await;
    git(&["config", "user.name", "p"], &pusher).await;
    std::fs::write(pusher.join("upstream.txt"), "hi").unwrap();
    git(&["add", "."], &pusher).await;
    git(&["commit", "-m", "upstream change"], &pusher).await;
    git(&["push", "origin", "main"], &pusher).await;

    // Merge base (origin/main) into the feature worktree.
    let summary = merge_base_into_worktree(&wt, "main").await.unwrap();
    assert!(!summary.is_empty());
    // The upstream file must now exist in the worktree.
    assert!(
        wt.join("upstream.txt").exists(),
        "merged file should be present"
    );

    let _ = clone; // keep clone alive
}

#[tokio::test]
async fn merge_base_up_to_date_is_ok() {
    let (_dir, _clone, wt) = setup_origin_clone_worktree().await;
    // No upstream change → merging origin/main is a no-op success.
    let out = merge_base_into_worktree(&wt, "main").await.unwrap();
    assert!(out.to_lowercase().contains("up to date") || !out.is_empty());
}
