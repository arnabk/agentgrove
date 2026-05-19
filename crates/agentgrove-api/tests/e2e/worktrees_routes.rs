//! E2E for `/api/projects/:id/worktrees`.

use crate::support::BeHarness;
use serde_json::{json, Value};

async fn make_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    dir
}

async fn make_project(h: &BeHarness) -> (tempfile::TempDir, String) {
    let dir = make_repo().await;
    let res = h
        .post_auth("/api/projects")
        .json(&json!({"name":"wt-test","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let p: Value = res.json().await.unwrap();
    (dir, p["id"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn worktree_create_list_delete() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;

    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature-y","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "body={}", res.text().await.unwrap());

    let list = h
        .get_auth(&format!("/api/projects/{project_id}/worktrees"))
        .send()
        .await
        .unwrap();
    let arr: Value = list.json().await.unwrap();
    assert_eq!(arr.as_array().unwrap().len(), 1);
    let wt_id = arr[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(arr[0]["status"], "ready");

    let del = h
        .delete_auth(&format!("/api/projects/{project_id}/worktrees/{wt_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);
}

#[tokio::test]
async fn worktree_pre_script_runs() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;

    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({
            "branch": "with-script",
            "base_ref": "main",
            "pre_script": "echo prescript-ok"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn worktree_pre_script_failure_returns_400() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;

    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({
            "branch": "bad-script",
            "base_ref": "main",
            "pre_script": "exit 3"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn list_worktrees_for_unknown_project_404() {
    let h = BeHarness::start().await;
    let res = h
        .get_auth("/api/projects/does-not-exist/worktrees")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}
