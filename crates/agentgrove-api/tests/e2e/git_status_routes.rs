//! E2E for /api/git/status.

use crate::support::BeHarness;
use serde_json::{json, Value};

#[tokio::test]
async fn git_status_for_non_git_dir_returns_empty() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let url = format!(
        "/api/git/status?path={}",
        urlencoding::encode(&dir.path().to_string_lossy())
    );
    let res = h.get(&url).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["entries"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn git_status_reports_untracked_and_modified_files() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    // Add a tracked file we will then modify.
    std::fs::write(dir.path().join("tracked.txt"), "v1\n").unwrap();
    let _ = tokio::process::Command::new("git")
        .args(["add", "tracked.txt"])
        .current_dir(dir.path())
        .output()
        .await
        .unwrap();
    let _ = tokio::process::Command::new("git")
        .args(["commit", "-m", "add tracked"])
        .current_dir(dir.path())
        .output()
        .await
        .unwrap();
    // Now produce one modified + one untracked.
    std::fs::write(dir.path().join("tracked.txt"), "v2\n").unwrap();
    std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();

    let url = format!(
        "/api/git/status?path={}",
        urlencoding::encode(&dir.path().to_string_lossy())
    );
    let res = h.get(&url).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let by_path: std::collections::HashMap<&str, &Value> = entries
        .iter()
        .map(|e| (e["path"].as_str().unwrap(), e))
        .collect();
    let m = by_path["tracked.txt"];
    assert_eq!(m["modified"], true);
    let u = by_path["new.txt"];
    assert_eq!(u["untracked"], true);
}

#[tokio::test]
async fn git_status_rejects_relative_path() {
    let h = BeHarness::start().await;
    let res = h.get("/api/git/status?path=relative").send().await.unwrap();
    assert_eq!(res.status(), 400);
}

/// Discard a TRACKED file: working-tree edits revert to HEAD, the
/// file is still on disk, and the BE reports `restored`.
#[tokio::test]
async fn git_discard_restores_tracked_file() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    std::fs::write(dir.path().join("a.txt"), "v1\n").unwrap();
    let _ = tokio::process::Command::new("git")
        .args(["add", "a.txt"])
        .current_dir(dir.path())
        .output()
        .await
        .unwrap();
    let _ = tokio::process::Command::new("git")
        .args(["commit", "-m", "init a"])
        .current_dir(dir.path())
        .output()
        .await
        .unwrap();
    // Modify so there's something to revert.
    std::fs::write(dir.path().join("a.txt"), "v2-DIRTY\n").unwrap();

    let res = h
        .post("/api/git/discard")
        .json(&json!({"cwd": dir.path().to_string_lossy(), "rel_path": "a.txt"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "body={}", res.text().await.unwrap());
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["outcome"], "restored");

    let restored = std::fs::read_to_string(dir.path().join("a.txt")).unwrap();
    assert_eq!(restored, "v1\n");
}

/// Discard an UNTRACKED file: the file is deleted from disk and the
/// BE reports `deleted_untracked`.
#[tokio::test]
async fn git_discard_deletes_untracked_file() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    std::fs::write(dir.path().join("fresh.txt"), "hi\n").unwrap();
    assert!(dir.path().join("fresh.txt").exists());

    let res = h
        .post("/api/git/discard")
        .json(&json!({"cwd": dir.path().to_string_lossy(), "rel_path": "fresh.txt"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["outcome"], "deleted_untracked");
    assert!(!dir.path().join("fresh.txt").exists());
}

/// Discard a path with no recorded change is a no-op, NOT an error.
/// This matches VSCode's idempotent behaviour when the user double-
/// clicks the discard icon.
#[tokio::test]
async fn git_discard_noop_for_clean_path() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    // Nothing exists at this path — should be noop, not 500.
    let res = h
        .post("/api/git/discard")
        .json(&json!({"cwd": dir.path().to_string_lossy(), "rel_path": "missing.txt"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["outcome"], "noop");
}

/// Discard rejects `..` traversal — paths must stay inside `cwd`.
/// Surfaces as 400 because the git crate's input validation maps to
/// `GitError::NonZero { code: -1 }`, which the HTTP layer remaps.
#[tokio::test]
async fn git_discard_rejects_path_traversal() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    let res = h
        .post("/api/git/discard")
        .json(&json!({"cwd": dir.path().to_string_lossy(), "rel_path": "../escape"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

/// Discard rejects an absolute rel_path with 400 — same defence as
/// the traversal case.
#[tokio::test]
async fn git_discard_rejects_absolute_rel_path() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    let res = h
        .post("/api/git/discard")
        .json(&json!({"cwd": dir.path().to_string_lossy(), "rel_path": "/etc/passwd"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}
