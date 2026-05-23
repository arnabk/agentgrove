//! E2E for the per-project scratchpad endpoints.

use crate::support::BeHarness;
use serde_json::{json, Value};

async fn make_project(h: &BeHarness) -> String {
    let dir = tempfile::tempdir().unwrap();
    let body = json!({ "name": "pad", "root": dir.path().to_string_lossy() });
    let res = h.post("/api/projects").json(&body).send().await.unwrap();
    assert_eq!(
        res.status(),
        200,
        "create project: {}",
        res.text().await.unwrap()
    );
    let p: Value = serde_json::from_str(
        &h.get(&format!("/api/projects"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    )
    .unwrap();
    p[0]["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn scratchpad_get_returns_empty_for_new_project() {
    let h = BeHarness::start().await;
    let pid = make_project(&h).await;
    let res = h
        .get(&format!("/api/projects/{pid}/scratchpad"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["body"], "");
}

#[tokio::test]
async fn scratchpad_put_then_get_roundtrips_rich_text_html() {
    let h = BeHarness::start().await;
    let pid = make_project(&h).await;
    let html = "<h1>Hello</h1><ul data-type=\"taskList\"><li data-checked=\"true\"><label><input type=\"checkbox\" checked></label><div><p>Done</p></div></li></ul>";

    let put = h
        .client
        .put(format!("{}/api/projects/{}/scratchpad", h.base_url, pid))
        .json(&json!({ "body": html }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        put.status(),
        200,
        "put scratchpad: {}",
        put.text().await.unwrap()
    );

    let got = h
        .get(&format!("/api/projects/{pid}/scratchpad"))
        .send()
        .await
        .unwrap();
    let body: Value = got.json().await.unwrap();
    assert_eq!(body["body"], html);
}
