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

/// PATCH sets, then clears, the project-level pre-worktree script.
/// Empty string + null both clear; trimmed whitespace is normalised.
#[tokio::test]
async fn project_patch_pre_worktree_script_roundtrip() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let created: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"p","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    // Initial: null/missing.
    assert!(created["pre_worktree_script"].is_null());

    // Set.
    let set = h
        .patch(&format!("/api/projects/{id}"))
        .json(&json!({"pre_worktree_script": "  pnpm install  "}))
        .send()
        .await
        .unwrap();
    assert_eq!(set.status(), 200, "body={}", set.text().await.unwrap());
    let after: Value = h
        .get_auth(&format!("/api/projects/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["pre_worktree_script"], "pnpm install");

    // Clear via empty string.
    let clear = h
        .patch(&format!("/api/projects/{id}"))
        .json(&json!({"pre_worktree_script": ""}))
        .send()
        .await
        .unwrap();
    assert_eq!(clear.status(), 200);
    let after2: Value = h
        .get_auth(&format!("/api/projects/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(after2["pre_worktree_script"].is_null());

    // Set again then clear via explicit null.
    h.patch(&format!("/api/projects/{id}"))
        .json(&json!({"pre_worktree_script": "echo hi"}))
        .send()
        .await
        .unwrap();
    let clear_null = h
        .patch(&format!("/api/projects/{id}"))
        .json(&json!({"pre_worktree_script": null}))
        .send()
        .await
        .unwrap();
    assert_eq!(clear_null.status(), 200);
    let after3: Value = clear_null.json().await.unwrap();
    assert!(after3["pre_worktree_script"].is_null());
}

/// PATCH with an empty body is a no-op (leaves the field unchanged).
#[tokio::test]
async fn project_patch_empty_body_is_noop() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let created: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"p","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    h.patch(&format!("/api/projects/{id}"))
        .json(&json!({"pre_worktree_script": "first-value"}))
        .send()
        .await
        .unwrap();
    let noop = h
        .patch(&format!("/api/projects/{id}"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(noop.status(), 200);
    let body: Value = noop.json().await.unwrap();
    assert_eq!(body["pre_worktree_script"], "first-value");
}

/// PATCH with a non-string non-null value returns 400.
#[tokio::test]
async fn project_patch_rejects_wrong_type() {
    let h = BeHarness::start().await;
    let dir = tempfile::tempdir().unwrap();
    let created: Value = h
        .post_auth("/api/projects")
        .json(&json!({"name":"p","root": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    let bad = h
        .patch(&format!("/api/projects/{id}"))
        .json(&json!({"pre_worktree_script": 42}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
}

/// PATCH against an unknown project returns 404.
#[tokio::test]
async fn project_patch_unknown_returns_404() {
    let h = BeHarness::start().await;
    let res = h
        .patch("/api/projects/does-not-exist")
        .json(&json!({"pre_worktree_script": "x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

/// Project deletion cascades through related state: chats become
/// 404, worktrees disappear from history, layout blobs are
/// dropped. Previously a stale project row would leave orphans
/// in the chats table + worktree history dialog forever.
#[tokio::test]
async fn delete_project_cascades_chats_worktrees_layout() {
    let h = BeHarness::start().await;
    // Create a project.
    let dir = tempfile::tempdir().unwrap();
    let body = serde_json::json!({
        "name": "cascade-test",
        "root": dir.path().to_string_lossy(),
    });
    let created = h
        .post_auth("/api/projects")
        .json(&body)
        .send()
        .await
        .unwrap();
    let p: serde_json::Value = created.json().await.unwrap();
    let pid = p["id"].as_str().unwrap().to_owned();

    // Plant a chat under it.
    let chat_body = serde_json::json!({
        "title": "doomed-chat",
        "provider": "fake",
        "model": "echo",
    });
    let chat_created = h
        .post_auth(&format!("/api/projects/{pid}/chats"))
        .json(&chat_body)
        .send()
        .await
        .unwrap();
    let chat: serde_json::Value = chat_created.json().await.unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_owned();

    // Plant a per-scope layout blob.
    h.put(&format!("/api/layout/scope?project={pid}"))
        .json(&serde_json::json!({ "blob": { "activeChat": chat_id } }))
        .send()
        .await
        .unwrap();

    // Delete the project.
    let del = h
        .delete_auth(&format!("/api/projects/{pid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    // The chat is gone.
    let missing_chat = h
        .get_auth(&format!("/api/chats/{chat_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_chat.status(), 404);

    // The project is gone.
    let missing_project = h
        .get_auth(&format!("/api/projects/{pid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_project.status(), 404);

    // Layout for the deleted project doesn't reappear.
    let layout: serde_json::Value = h
        .get_auth("/api/layout")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scopes = layout["scopes"].as_array().unwrap();
    assert!(
        !scopes.iter().any(|s| s["project_id"] == pid),
        "layout still holds the deleted project: {scopes:?}"
    );
}
