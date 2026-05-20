//! E2E for project-scoped chat routes + no-cap behavior.

use crate::support::BeHarness;
use serde_json::{json, Value};

async fn make_project(h: &BeHarness) -> String {
    let dir = tempfile::tempdir().unwrap();
    let body = json!({ "name": "p", "root": dir.path().to_string_lossy() });
    let res = h.post("/api/projects").json(&body).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let p: Value = res.json().await.unwrap();
    p["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn create_then_list_chats_for_project() {
    let h = BeHarness::start().await;
    let pid = make_project(&h).await;
    let body = json!({"title":"first","provider":"fake","model":"echo"});
    let created = h
        .post(&format!("/api/projects/{pid}/chats"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);
    let chat: Value = created.json().await.unwrap();
    assert_eq!(chat["project_id"], pid);
    assert!(chat["worktree_id"].is_null());

    let list = h
        .get(&format!("/api/projects/{pid}/chats"))
        .send()
        .await
        .unwrap();
    let arr: Value = list.json().await.unwrap();
    assert_eq!(arr.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn no_cap_allows_more_than_five_chats_per_project() {
    let h = BeHarness::start().await;
    let pid = make_project(&h).await;
    for i in 0..7 {
        let body = json!({
            "title": format!("c{i}"),
            "provider": "fake",
            "model": "echo",
        });
        let res = h
            .post(&format!("/api/projects/{pid}/chats"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            200,
            "create chat {i}: {}",
            res.text().await.unwrap()
        );
    }
    let list: Value = h
        .get(&format!("/api/projects/{pid}/chats"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 7);
}

#[tokio::test]
async fn create_for_unknown_project_404() {
    let h = BeHarness::start().await;
    let res = h
        .post("/api/projects/does-not-exist/chats")
        .json(&json!({"title":"x","provider":"fake","model":"echo"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}
