//! E2E for editor + terminal routes.

use crate::support::BeHarness;
use serde_json::{json, Value};

#[tokio::test]
async fn editor_read_write_roundtrip() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("foo.txt");

    // Write.
    let w = h
        .post_auth("/api/editor/file")
        .json(&json!({
            "path": f.to_string_lossy(),
            "content": "hello editor"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(w.status(), 204);

    // Read.
    let r = h
        .get_auth(&format!(
            "/api/editor/file?path={}",
            urlencoding::encode(&f.to_string_lossy())
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["content"], "hello editor");
}

#[tokio::test]
async fn editor_tree_lists_entries() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "x").unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let r = h
        .get_auth(&format!(
            "/api/editor/tree?path={}",
            urlencoding::encode(&dir.path().to_string_lossy())
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let arr: Value = r.json().await.unwrap();
    assert_eq!(arr.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn terminal_spawn_write_history() {
    let h = BeHarness::start().await;
    let res = h
        .post_auth("/api/terminals")
        .json(&json!({"cols": 80, "rows": 24}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let term: Value = res.json().await.unwrap();
    let id = term["id"].as_str().unwrap().to_owned();

    let w = h
        .post_auth(&format!("/api/terminals/{id}/write"))
        .json(&json!({"data": "echo hi\n"}))
        .send()
        .await
        .unwrap();
    assert_eq!(w.status(), 204);

    // Give the shell a moment to echo.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let hist = h
        .get_auth(&format!("/api/terminals/{id}/history"))
        .send()
        .await
        .unwrap();
    assert_eq!(hist.status(), 200);

    let del = h
        .delete_auth(&format!("/api/terminals/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);
}
