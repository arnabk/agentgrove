//! E2E for `/api/projects/:id/worktrees`.

use crate::support::BeHarness;
use serde_json::{json, Value};

async fn make_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    agentgrove_git::init_repo(dir.path()).await.unwrap();
    dir
}

/// Poll the project's worktree list until the entry with `wt_id`
/// reaches a terminal status (`ready` or `failed`). Times out after
/// 5 s so tests fail fast if the BE is stuck.
async fn wait_for_terminal_status(
    h: &BeHarness,
    project_id: &str,
    wt_id: &str,
) -> String {
    for _ in 0..50 {
        let arr: Value = h
            .get_auth(&format!("/api/projects/{project_id}/worktrees"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if let Some(items) = arr.as_array() {
            if let Some(item) = items.iter().find(|i| i["id"] == wt_id) {
                let status = item["status"].as_str().unwrap_or("").to_string();
                if status == "ready" || status == "failed" {
                    return status;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("worktree {wt_id} did not reach terminal status in time");
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
    let created: Value = res.json().await.unwrap();
    let wt_id = created["id"].as_str().unwrap().to_owned();
    // POST returns immediately while git work happens in the
    // background. Poll until the entry reaches a terminal status.
    let status = wait_for_terminal_status(&h, &project_id, &wt_id).await;
    assert_eq!(status, "ready");

    let list = h
        .get_auth(&format!("/api/projects/{project_id}/worktrees"))
        .send()
        .await
        .unwrap();
    let arr: Value = list.json().await.unwrap();
    assert_eq!(arr.as_array().unwrap().len(), 1);
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
    let wt: Value = res.json().await.unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    let status = wait_for_terminal_status(&h, &project_id, &wt_id).await;
    assert_eq!(status, "ready");
}

#[tokio::test]
async fn worktree_pre_script_failure_marks_status_failed() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;

    // POST returns 200 immediately even when the pre-script will
    // fail — the background task surfaces the failure by flipping
    // the worktree's status to `failed` and publishing stderr/exit
    // events on the LogBus topic.
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
    assert_eq!(res.status(), 200);
    let wt: Value = res.json().await.unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    let status = wait_for_terminal_status(&h, &project_id, &wt_id).await;
    assert_eq!(status, "failed");
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
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &id_a).await,
        "ready"
    );

    let res_b = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"bugfix-beta","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res_b.status(), 200);
    let wt_b: Value = res_b.json().await.unwrap();
    let id_b = wt_b["id"].as_str().unwrap().to_owned();
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &id_b).await,
        "ready"
    );

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
    // Wait for the background creation task to finish before
    // soft-deleting so the worktree's `git worktree remove` can run
    // cleanly.
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &id).await,
        "ready"
    );

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

/// PATCH rename happy path. Creates a worktree, renames its branch,
/// and verifies the new name lands both in the metadata row and in
/// the on-disk git repo (via `git branch --list`). Confirms we
/// changed the right thing without affecting the worktree path.
#[tokio::test]
async fn worktree_rename_succeeds() {
    let h = BeHarness::start().await;
    let (dir, project_id) = make_project(&h).await;

    // Create.
    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature/rename-me","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let wt: Value = res.json().await.unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    let original_path = wt["path"].as_str().unwrap().to_owned();
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &wt_id).await,
        "ready"
    );

    // Rename via PATCH.
    let rename = h
        .patch(&format!(
            "/api/projects/{project_id}/worktrees/{wt_id}"
        ))
        .json(&json!({"branch":"feature/renamed"}))
        .send()
        .await
        .unwrap();
    assert_eq!(rename.status(), 200, "body={}", rename.text().await.unwrap());
    let renamed: Value = rename.json().await.unwrap();
    assert_eq!(renamed["branch"], "feature/renamed");
    // Path is intentionally NOT moved — verifies the "rename branch
    // only" product decision.
    assert_eq!(renamed["path"].as_str().unwrap(), original_path);

    // List shows the new branch label.
    let list: Value = h
        .get_auth(&format!("/api/projects/{project_id}/worktrees"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list[0]["branch"], "feature/renamed");

    // Git itself agrees — the old branch is gone, the new one exists.
    let out = std::process::Command::new("git")
        .args(["-C", &dir.path().to_string_lossy(), "branch", "--list"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("feature/renamed"), "branches:\n{stdout}");
    assert!(
        !stdout.contains("feature/rename-me"),
        "old branch still present:\n{stdout}"
    );
}

/// PATCH rename rejects an empty / whitespace-only branch with 400.
#[tokio::test]
async fn worktree_rename_rejects_empty_branch() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;
    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature/x","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    let wt_id = res
        .json::<Value>()
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &wt_id).await,
        "ready"
    );

    let bad = h
        .patch(&format!(
            "/api/projects/{project_id}/worktrees/{wt_id}"
        ))
        .json(&json!({"branch":"   "}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
}

/// PATCH rename rejects a collision against another live worktree's
/// branch with 409. We don't bother covering the history-collision
/// case separately — both go through the same code path; this test
/// pins the BAD_REQUEST→CONFLICT mapping that the FE relies on.
#[tokio::test]
async fn worktree_rename_collision_returns_409() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;

    // Two worktrees on distinct branches.
    let a = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature/a","base_ref":"main"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let id_a = a["id"].as_str().unwrap().to_owned();
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &id_a).await,
        "ready"
    );

    let b = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature/b","base_ref":"main"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let id_b = b["id"].as_str().unwrap().to_owned();
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &id_b).await,
        "ready"
    );

    // Try to rename B onto A's branch.
    let clash = h
        .patch(&format!(
            "/api/projects/{project_id}/worktrees/{id_b}"
        ))
        .json(&json!({"branch":"feature/a"}))
        .send()
        .await
        .unwrap();
    assert_eq!(clash.status(), 409, "body={}", clash.text().await.unwrap());
}

/// DELETE with `?delete_branch=true` removes both the worktree dir
/// AND the local branch. Verifies the local git state with
/// `git branch --list`.
#[tokio::test]
async fn worktree_delete_with_branch_removes_branch() {
    let h = BeHarness::start().await;
    let (dir, project_id) = make_project(&h).await;

    let wt = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature/drop-me","base_ref":"main"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &wt_id).await,
        "ready"
    );

    let del = h
        .delete_auth(&format!(
            "/api/projects/{project_id}/worktrees/{wt_id}?delete_branch=true"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204, "body={}", del.text().await.unwrap());

    // Branch no longer in git.
    let out = std::process::Command::new("git")
        .args(["-C", &dir.path().to_string_lossy(), "branch", "--list"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        !stdout.contains("feature/drop-me"),
        "branch was not deleted:\n{stdout}"
    );
}

/// A worktree created WITHOUT a per-call `pre_script` inherits the
/// project-level `pre_worktree_script`. We can't observe the script
/// body directly from the worktree DTO (it's stored, not surfaced),
/// so we use a script that creates a sentinel file inside the new
/// worktree dir — the file's existence proves the script ran with
/// the project default.
#[tokio::test]
async fn worktree_inherits_project_pre_script_when_unset() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;
    // Configure the project default.
    let set = h
        .patch(&format!("/api/projects/{project_id}"))
        .json(&serde_json::json!({
            "pre_worktree_script": "touch inherited.flag"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(set.status(), 200);

    // Create a worktree with NO per-call pre_script.
    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&serde_json::json!({"branch":"feature/inherit","base_ref":"main"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let wt: Value = res.json().await.unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    let wt_path = std::path::PathBuf::from(wt["path"].as_str().unwrap());
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &wt_id).await,
        "ready"
    );
    assert!(
        wt_path.join("inherited.flag").exists(),
        "expected project-level pre_script to have created the sentinel file at {}",
        wt_path.display()
    );
}

/// A per-call `pre_script` overrides the project-level default. We
/// drop two sentinel filenames so the test can tell which branch of
/// the resolution logic actually ran.
#[tokio::test]
async fn worktree_pre_script_override_wins_over_project_default() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;
    h.patch(&format!("/api/projects/{project_id}"))
        .json(&serde_json::json!({
            "pre_worktree_script": "touch project-default.flag"
        }))
        .send()
        .await
        .unwrap();
    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&serde_json::json!({
            "branch":"feature/override",
            "base_ref":"main",
            "pre_script": "touch override.flag"
        }))
        .send()
        .await
        .unwrap();
    let wt: Value = res.json().await.unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    let wt_path = std::path::PathBuf::from(wt["path"].as_str().unwrap());
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &wt_id).await,
        "ready"
    );
    assert!(
        wt_path.join("override.flag").exists(),
        "override script did not run"
    );
    assert!(
        !wt_path.join("project-default.flag").exists(),
        "project default ran even though an override was supplied"
    );
}

/// Whitespace-only override is treated as "inherit" — matches the FE
/// convention that leaving the override input blank means "use the
/// project default", regardless of trailing whitespace from copy-paste.
#[tokio::test]
async fn worktree_whitespace_override_falls_back_to_project_default() {
    let h = BeHarness::start().await;
    let (_dir, project_id) = make_project(&h).await;
    h.patch(&format!("/api/projects/{project_id}"))
        .json(&serde_json::json!({
            "pre_worktree_script": "touch inherited.flag"
        }))
        .send()
        .await
        .unwrap();
    let res = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&serde_json::json!({
            "branch":"feature/ws",
            "base_ref":"main",
            "pre_script": "   \n  "
        }))
        .send()
        .await
        .unwrap();
    let wt: Value = res.json().await.unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    let wt_path = std::path::PathBuf::from(wt["path"].as_str().unwrap());
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &wt_id).await,
        "ready"
    );
    assert!(
        wt_path.join("inherited.flag").exists(),
        "whitespace-only override should have fallen back to the project default"
    );
}

/// DELETE without the query param (default behaviour) keeps the
/// branch around — this is the existing contract; pinned here so we
/// don't regress it accidentally.
#[tokio::test]
async fn worktree_delete_without_flag_keeps_branch() {
    let h = BeHarness::start().await;
    let (dir, project_id) = make_project(&h).await;

    let wt = h
        .post_auth(&format!("/api/projects/{project_id}/worktrees"))
        .json(&json!({"branch":"feature/keep-me","base_ref":"main"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let wt_id = wt["id"].as_str().unwrap().to_owned();
    assert_eq!(
        wait_for_terminal_status(&h, &project_id, &wt_id).await,
        "ready"
    );

    let del = h
        .delete_auth(&format!(
            "/api/projects/{project_id}/worktrees/{wt_id}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    let out = std::process::Command::new("git")
        .args(["-C", &dir.path().to_string_lossy(), "branch", "--list"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("feature/keep-me"),
        "branch was unexpectedly deleted:\n{stdout}"
    );
}
