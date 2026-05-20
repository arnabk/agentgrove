//! E2E for branch listing + switch routes.

use crate::support::BeHarness;
use serde_json::{json, Value};

async fn make_git_project(h: &BeHarness) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    let body = json!({ "name": "g", "root": dir.path().to_string_lossy() });
    let res = h.post("/api/projects").json(&body).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let p: Value = res.json().await.unwrap();
    (dir, p["id"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn list_branches_returns_initial_main_as_current() {
    let h = BeHarness::start().await;
    let (_dir, pid) = make_git_project(&h).await;
    let res = h
        .get(&format!("/api/projects/{pid}/branches"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let arr: Value = res.json().await.unwrap();
    let entries = arr.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "main");
    assert_eq!(entries[0]["current"], true);
}

#[tokio::test]
async fn switch_with_create_changes_current_branch() {
    let h = BeHarness::start().await;
    let (_dir, pid) = make_git_project(&h).await;
    let res = h
        .post(&format!("/api/projects/{pid}/branch"))
        .json(&json!({ "branch": "feature/x", "create": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204, "{}", res.text().await.unwrap());
    let list: Value = h
        .get(&format!("/api/projects/{pid}/branches"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"feature/x"));
    let current = list
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["current"].as_bool().unwrap_or(false))
        .unwrap();
    assert_eq!(current["name"], "feature/x");
}

#[tokio::test]
async fn switch_to_missing_branch_returns_400() {
    let h = BeHarness::start().await;
    let (_dir, pid) = make_git_project(&h).await;
    let res = h
        .post(&format!("/api/projects/{pid}/branch"))
        .json(&json!({ "branch": "no-such" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}
