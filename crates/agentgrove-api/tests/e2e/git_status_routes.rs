//! E2E for /api/git/status.

use crate::support::BeHarness;
use serde_json::Value;

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
