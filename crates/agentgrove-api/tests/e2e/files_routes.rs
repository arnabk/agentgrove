//! E2E for `/api/projects/:id/files/search` + `/reindex`.

use crate::support::BeHarness;
use serde_json::{json, Value};

/// Make a temp directory with a few files + a gitignored dir, register
/// it as a project, and return (harness, project_id, tempdir).
async fn fixture() -> (BeHarness, String, tempfile::TempDir) {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    // Sample tree.
    std::fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
    std::fs::write(dir.path().join("README.md"), "hi").unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/main.rs"), "fn main(){}").unwrap();
    std::fs::write(dir.path().join("src/lib.rs"), "pub fn x(){}").unwrap();
    std::fs::create_dir_all(dir.path().join("ignored")).unwrap();
    std::fs::write(dir.path().join("ignored/leak.txt"), "").unwrap();

    let body = json!({ "name": "fi", "root": dir.path().to_string_lossy() });
    let created = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200, "project create failed");
    let p: Value = created.json().await.unwrap();
    let id = p["id"].as_str().unwrap().to_owned();
    (h, id, dir)
}

/// Empty query should land hits + report `total_indexed > 0`.
#[tokio::test]
async fn search_empty_query_returns_indexed_paths() {
    let (h, id, _dir) = fixture().await;
    let res = h
        .get_auth(&format!("/api/projects/{id}/files/search"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let total = body["total_indexed"].as_u64().unwrap();
    assert!(total >= 3, "expected ≥3 indexed entries, got {total}");
    let hits = body["hits"].as_array().unwrap();
    assert!(!hits.is_empty());
}

/// Fuzzy query should rank a matching file first.
#[tokio::test]
async fn search_finds_a_specific_file() {
    let (h, id, _dir) = fixture().await;
    let res = h
        .get_auth(&format!("/api/projects/{id}/files/search?q=main.rs"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let hits = body["hits"].as_array().unwrap();
    assert!(!hits.is_empty(), "no hits for 'main.rs'");
    assert!(
        hits[0]["path"].as_str().unwrap().ends_with("main.rs"),
        "top hit was {hits:?}"
    );
    assert!(hits[0]["abs"].as_str().unwrap().ends_with("main.rs"));
}

/// `.gitignore` is respected — `ignored/` entries don't leak.
#[tokio::test]
async fn search_skips_gitignored_paths() {
    let (h, id, _dir) = fixture().await;
    let res = h
        .get_auth(&format!("/api/projects/{id}/files/search?q=leak"))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    let hits = body["hits"].as_array().unwrap();
    let any_leak = hits.iter().any(|h| {
        h["path"]
            .as_str()
            .map(|p| p.contains("ignored/"))
            .unwrap_or(false)
    });
    assert!(!any_leak, "gitignored dir leaked: {hits:?}");
}

/// Unknown project id returns 404.
#[tokio::test]
async fn search_unknown_project_404() {
    let h = BeHarness::start().await;
    let res = h
        .get_auth("/api/projects/does-not-exist/files/search?q=x")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

/// `limit` is honoured + clamped server-side.
#[tokio::test]
async fn search_respects_limit_parameter() {
    let (h, id, _dir) = fixture().await;
    let res = h
        .get_auth(&format!("/api/projects/{id}/files/search?limit=2"))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    let hits = body["hits"].as_array().unwrap();
    assert!(hits.len() <= 2);
}

/// `/reindex` re-walks the project tree + reports the count.
#[tokio::test]
async fn reindex_returns_fresh_count() {
    let (h, id, dir) = fixture().await;
    // Warm the cache.
    h.get_auth(&format!("/api/projects/{id}/files/search"))
        .send()
        .await
        .unwrap();
    // Add a new file + force re-scan.
    std::fs::write(dir.path().join("new.txt"), "").unwrap();
    let res = h
        .post_auth(&format!("/api/projects/{id}/files/reindex"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let n = body["indexed"].as_u64().unwrap();
    assert!(n >= 4, "expected ≥4 after adding new.txt, got {n}");
}

/// `/reindex` on unknown project returns 404.
#[tokio::test]
async fn reindex_unknown_project_404() {
    let h = BeHarness::start().await;
    let res = h
        .post_auth("/api/projects/missing/files/reindex")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}
