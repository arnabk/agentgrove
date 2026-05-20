//! E2E for the folder-picker filesystem browser.

use crate::support::BeHarness;
use serde_json::Value;

#[tokio::test]
async fn home_returns_starting_dir_and_roots() {
    let h = BeHarness::start().await;
    let res = h.get("/api/fs/home").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert!(body["home"].as_str().is_some());
    let roots = body["roots"].as_array().expect("roots array");
    assert!(!roots.is_empty(), "at least one filesystem root");
}

#[tokio::test]
async fn browse_lists_directories_only() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("alpha")).unwrap();
    std::fs::create_dir(dir.path().join("bravo")).unwrap();
    std::fs::write(dir.path().join("ignored.txt"), "x").unwrap();
    let url = format!(
        "/api/fs/browse?path={}",
        urlencoding::encode(&dir.path().to_string_lossy())
    );
    let res = h.get(&url).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let entries = body["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["alpha", "bravo"]);
    for e in entries {
        assert_eq!(e["is_dir"], true);
    }
    // Parent should resolve to the tempdir's parent (or null at root).
    let parent = body["parent"].as_str();
    assert!(parent.is_some());
}

#[tokio::test]
async fn browse_rejects_non_absolute_path() {
    let h = BeHarness::start().await;
    let res = h.get("/api/fs/browse?path=relative").send().await.unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn browse_returns_404_for_missing_path() {
    let h = BeHarness::start().await;
    let res = h
        .get("/api/fs/browse?path=/this/does/not/exist/agentgrove-test")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}
