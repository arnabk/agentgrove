//! E2E for `/api/projects`.

use crate::support::BeHarness;
use serde_json::{json, Value};

#[tokio::test]
async fn list_initially_empty() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/api/projects").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn create_get_list_delete_cycle() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let body = json!({ "name": "demo", "root": dir.path().to_string_lossy() });

    let created = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);
    let p: Value = created.json().await.unwrap();
    assert_eq!(p["name"], "demo");
    let id = p["id"].as_str().unwrap().to_owned();

    let list = h.get_auth("/api/projects").send().await.unwrap();
    let arr: Value = list.json().await.unwrap();
    assert_eq!(arr.as_array().unwrap().len(), 1);

    let one = h
        .get_auth(&format!("/api/projects/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(one.status(), 200);

    let del = h
        .delete_auth(&format!("/api/projects/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    let missing = h
        .get_auth(&format!("/api/projects/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
}

#[tokio::test]
async fn create_rejects_missing_path() {
    let h = BeHarness::start().await;
    let body = json!({
        "name": "x",
        "root": "/this/path/does/not/exist/agentgrove-test"
    });
    let res = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn create_without_name_uses_basename() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let body = json!({ "root": dir.path().to_string_lossy() });
    let res = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let p: Value = res.json().await.unwrap();
    let expected = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(p["name"], expected);
}

#[tokio::test]
async fn create_with_blank_name_falls_back_to_basename() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let body = json!({ "name": "  ", "root": dir.path().to_string_lossy() });
    let res = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let p: Value = res.json().await.unwrap();
    let expected = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(p["name"], expected);
}

#[tokio::test]
async fn create_conflict_on_duplicate_root() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let body = json!({ "name": "a", "root": dir.path().to_string_lossy() });
    let r1 = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r1.status(), 200);
    let r2 = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r2.status(), 409);
}
