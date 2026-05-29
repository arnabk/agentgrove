//! L4 tests for `/api/layout` endpoints.
//!
//! Restart-survival is covered in `persistence.rs`. This file
//! covers the route's input validation + happy-path roundtrip
//! without bouncing the server.

use crate::support::BeHarness;
use serde_json::{json, Value};

#[tokio::test]
async fn put_global_then_get_roundtrips_blob() {
    let h = BeHarness::start().await;
    let blob = json!({"theme": "dark-default", "rail_width": 280});
    assert_eq!(
        h.put("/api/layout/global")
            .json(&json!({"blob": blob}))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let snap: Value = h
        .get_auth("/api/layout")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snap["global"], blob);
}

#[tokio::test]
async fn put_scope_supports_project_root_and_worktree_scopes() {
    let h = BeHarness::start().await;

    // Project-root scope (no worktree).
    h.put("/api/layout/scope?project=proj-a")
        .json(&json!({"blob": {"k":"v1"}}))
        .send()
        .await
        .unwrap();
    // Worktree-scoped layout for the same project.
    h.put("/api/layout/scope?project=proj-a&worktree=wt-x")
        .json(&json!({"blob": {"k":"v2"}}))
        .send()
        .await
        .unwrap();

    let snap: Value = h
        .get_auth("/api/layout")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scopes = snap["scopes"].as_array().unwrap();
    assert_eq!(scopes.len(), 2);
    // Should include both rows; order is project-id then worktree-id.
    let entries: Vec<(&str, &str, &Value)> = scopes
        .iter()
        .map(|s| {
            (
                s["project_id"].as_str().unwrap(),
                s["worktree_id"].as_str().unwrap(),
                &s["blob"],
            )
        })
        .collect();
    assert!(entries
        .iter()
        .any(|(p, w, b)| *p == "proj-a" && w.is_empty() && (*b)["k"] == "v1"));
    assert!(entries
        .iter()
        .any(|(p, w, b)| *p == "proj-a" && *w == "wt-x" && (*b)["k"] == "v2"));
}

#[tokio::test]
async fn put_scope_rejects_empty_project() {
    let h = BeHarness::start().await;
    assert_eq!(
        h.put("/api/layout/scope?project=")
            .json(&json!({"blob": {}}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
}

#[tokio::test]
async fn put_scope_is_upsert() {
    let h = BeHarness::start().await;
    h.put("/api/layout/scope?project=proj-up")
        .json(&json!({"blob": {"v": 1}}))
        .send()
        .await
        .unwrap();
    h.put("/api/layout/scope?project=proj-up")
        .json(&json!({"blob": {"v": 2}}))
        .send()
        .await
        .unwrap();
    let snap: Value = h
        .get_auth("/api/layout")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scopes = snap["scopes"].as_array().unwrap();
    let row = scopes
        .iter()
        .find(|s| s["project_id"] == "proj-up")
        .unwrap();
    assert_eq!(row["blob"]["v"], 2);
}
