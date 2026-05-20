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

#[tokio::test]
async fn worktree_history_lists_and_filters_after_delete() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;

    // Create two worktrees with distinct branch names.
    let res_a = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature-alpha","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res_a.status(), 200);
    let wt_a: Value = res_a.json().await.unwrap();
    let id_a = wt_a["id"].as_str().unwrap().to_owned();

    let res_b = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"bugfix-beta","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res_b.status(), 200);
    let wt_b: Value = res_b.json().await.unwrap();
    let id_b = wt_b["id"].as_str().unwrap().to_owned();

    // Soft-delete both.
    for id in [&id_a, &id_b] {
        let del = h
            .delete_auth(&format!("/api/projects/{project_id}/worktrees/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(del.status(), 204);
    }

    // History without filter returns both.
    let hist = h
        .get_auth("/api/worktrees/history")
        .send()
        .await
        .unwrap();
    assert_eq!(hist.status(), 200);
    let arr: Value = hist.json().await.unwrap();
    let items = arr.as_array().unwrap();
    assert!(items.len() >= 2);
    assert!(items.iter().all(|w| w["removed_at"].is_string()));

    // Branch substring filter.
    let hist_f = h
        .get_auth("/api/worktrees/history?q=alpha")
        .send()
        .await
        .unwrap();
    assert_eq!(hist_f.status(), 200);
    let arr_f: Value = hist_f.json().await.unwrap();
    let items_f = arr_f.as_array().unwrap();
    assert_eq!(items_f.len(), 1);
    assert_eq!(items_f[0]["branch"], "feature-alpha");

    // project_id filter.
    let hist_p = h
        .get_auth(&format!("/api/worktrees/history?project_id={project_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(hist_p.status(), 200);
    let arr_p: Value = hist_p.json().await.unwrap();
    assert!(arr_p
        .as_array()
        .unwrap()
        .iter()
        .all(|w| w["project_id"] == project_id));

    // Empty q is treated as no filter.
    let hist_empty = h
        .get_auth("/api/worktrees/history?q=")
        .send()
        .await
        .unwrap();
    assert_eq!(hist_empty.status(), 200);
    let arr_e: Value = hist_empty.json().await.unwrap();
    assert!(arr_e.as_array().unwrap().len() >= 2);
}

#[tokio::test]
async fn worktree_restore_clears_removed_at() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;

    // Create + delete one.
    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"restorable","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let wt: Value = res.json().await.unwrap();
    let id = wt["id"].as_str().unwrap().to_owned();

    let del = h
        .delete_auth(&format!("/api/projects/{project_id}/worktrees/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    // Live list no longer contains it.
    let live = h
        .get_auth(&format!("/api/projects/{project_id}/worktrees"))
        .send()
        .await
        .unwrap();
    let live_arr: Value = live.json().await.unwrap();
    assert!(live_arr.as_array().unwrap().is_empty());

    // Restore.
    let rest = h
        .post_auth(&format!("/api/worktrees/{id}/restore"))
        .send()
        .await
        .unwrap();
    assert_eq!(rest.status(), 200, "body={}", rest.text().await.unwrap());
    let restored: Value = rest.json().await.unwrap();
    assert_eq!(restored["id"], id);
    assert!(restored["removed_at"].is_null());

    // Restore again -> 409 (already live).
    let again = h
        .post_auth(&format!("/api/worktrees/{id}/restore"))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 409);

    // Restore unknown -> 404.
    let nf = h
        .post_auth("/api/worktrees/does-not-exist/restore")
        .send()
        .await
        .unwrap();
    assert_eq!(nf.status(), 404);
}
