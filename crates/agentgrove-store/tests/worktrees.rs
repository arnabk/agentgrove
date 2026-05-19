//! Component tests for `WorktreeRepo`.

use agentgrove_store::{
    open_pool, run_migrations, NewProject, NewWorktree, ProjectRepo, WorktreeError, WorktreeRepo,
    WorktreeStatus,
};
use std::path::PathBuf;
use tempfile::tempdir;

#[cfg(unix)]
fn abs(p: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/agentgrove-wt-test-{p}"))
}

#[cfg(windows)]
fn abs(p: &str) -> PathBuf {
    PathBuf::from(format!(r"C:\agentgrove-wt-test-{p}"))
}

async fn seed_project() -> (tempfile::TempDir, ProjectRepo, WorktreeRepo, String) {
    let dir = tempdir().unwrap();
    let pool = open_pool(dir.path()).await.unwrap();
    run_migrations(&pool).await.unwrap();
    let projects = ProjectRepo::new(pool.clone());
    let p = projects
        .create(NewProject {
            name: "owner".into(),
            root: abs("project"),
        })
        .await
        .unwrap();
    let worktrees = WorktreeRepo::new(pool);
    (dir, projects, worktrees, p.id)
}

#[tokio::test]
async fn create_returns_record_with_creating_status() {
    let (_d, _p, wr, project_id) = seed_project().await;
    let w = wr
        .create(NewWorktree {
            project_id: project_id.clone(),
            branch: "feature-x".into(),
            base_ref: "main".into(),
            path: abs("wt-a"),
            pre_script: Some("echo hi".into()),
            post_script: None,
        })
        .await
        .unwrap();
    assert_eq!(w.status, WorktreeStatus::Creating);
    assert_eq!(w.project_id, project_id);
    assert_eq!(w.branch, "feature-x");
    assert_eq!(w.pre_script.as_deref(), Some("echo hi"));
    assert!(w.post_script.is_none());
}

#[tokio::test]
async fn set_status_persists_change() {
    let (_d, _p, wr, project_id) = seed_project().await;
    let w = wr
        .create(NewWorktree {
            project_id,
            branch: "b".into(),
            base_ref: "main".into(),
            path: abs("wt-b"),
            pre_script: None,
            post_script: None,
        })
        .await
        .unwrap();
    wr.set_status(&w.id, WorktreeStatus::Ready).await.unwrap();
    let got = wr.get(&w.id).await.unwrap();
    assert_eq!(got.status, WorktreeStatus::Ready);
}

#[tokio::test]
async fn list_for_project_returns_inserted_worktrees() {
    let (_d, _p, wr, project_id) = seed_project().await;
    let _a = wr
        .create(NewWorktree {
            project_id: project_id.clone(),
            branch: "a".into(),
            base_ref: "main".into(),
            path: abs("wt-c"),
            pre_script: None,
            post_script: None,
        })
        .await
        .unwrap();
    let _b = wr
        .create(NewWorktree {
            project_id: project_id.clone(),
            branch: "b".into(),
            base_ref: "main".into(),
            path: abs("wt-d"),
            pre_script: None,
            post_script: None,
        })
        .await
        .unwrap();
    let all = wr.list_for_project(&project_id).await.unwrap();
    assert_eq!(all.len(), 2);
}

#[tokio::test]
async fn create_rejects_relative_path() {
    let (_d, _p, wr, project_id) = seed_project().await;
    let err = wr
        .create(NewWorktree {
            project_id,
            branch: "x".into(),
            base_ref: "main".into(),
            path: PathBuf::from("relative"),
            pre_script: None,
            post_script: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeError::RelativePath(_)), "{err:?}");
}

#[tokio::test]
async fn create_rejects_empty_branch() {
    let (_d, _p, wr, project_id) = seed_project().await;
    let err = wr
        .create(NewWorktree {
            project_id,
            branch: "  ".into(),
            base_ref: "main".into(),
            path: abs("wt-e"),
            pre_script: None,
            post_script: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeError::EmptyBranch), "{err:?}");
}

#[tokio::test]
async fn create_rejects_duplicate_path() {
    let (_d, _p, wr, project_id) = seed_project().await;
    wr.create(NewWorktree {
        project_id: project_id.clone(),
        branch: "first".into(),
        base_ref: "main".into(),
        path: abs("wt-dup"),
        pre_script: None,
        post_script: None,
    })
    .await
    .unwrap();
    let err = wr
        .create(NewWorktree {
            project_id,
            branch: "second".into(),
            base_ref: "main".into(),
            path: abs("wt-dup"),
            pre_script: None,
            post_script: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(err, WorktreeError::DuplicatePath(_)), "{err:?}");
}

#[tokio::test]
async fn delete_removes_existing_row() {
    let (_d, _p, wr, project_id) = seed_project().await;
    let w = wr
        .create(NewWorktree {
            project_id,
            branch: "del".into(),
            base_ref: "main".into(),
            path: abs("wt-del"),
            pre_script: None,
            post_script: None,
        })
        .await
        .unwrap();
    assert!(wr.delete(&w.id).await.unwrap());
    let err = wr.get(&w.id).await.unwrap_err();
    assert!(matches!(err, WorktreeError::NotFound(_)));
}
