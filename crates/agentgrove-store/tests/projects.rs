//! Component tests for `ProjectRepo`. Real SQLite in a tempdir per test.

use agentgrove_store::{open_pool, run_migrations, NewProject, ProjectError, ProjectRepo};
use std::path::PathBuf;
use tempfile::tempdir;

#[cfg(unix)]
fn abs(p: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/agentgrove-test-{p}"))
}

#[cfg(windows)]
fn abs(p: &str) -> PathBuf {
    PathBuf::from(format!(r"C:\agentgrove-test-{p}"))
}

async fn fresh_repo() -> (tempfile::TempDir, ProjectRepo) {
    let dir = tempdir().unwrap();
    let pool = open_pool(dir.path()).await.expect("open pool");
    run_migrations(&pool).await.expect("migrate");
    (dir, ProjectRepo::new(pool))
}

#[tokio::test]
async fn migrations_are_idempotent() {
    let dir = tempdir().unwrap();
    let pool = open_pool(dir.path()).await.unwrap();
    run_migrations(&pool).await.unwrap();
    run_migrations(&pool).await.unwrap();
}

#[tokio::test]
async fn create_then_get_roundtrips() {
    let (_dir, repo) = fresh_repo().await;
    let p = repo
        .create(NewProject {
            name: "demo".into(),
            root: abs("a"),
        })
        .await
        .unwrap();
    let fetched = repo.get(&p.id).await.unwrap();
    assert_eq!(fetched, p);
}

#[tokio::test]
async fn create_trims_name() {
    let (_dir, repo) = fresh_repo().await;
    let p = repo
        .create(NewProject {
            name: "  hello  ".into(),
            root: abs("b"),
        })
        .await
        .unwrap();
    assert_eq!(p.name, "hello");
}

#[tokio::test]
async fn create_rejects_empty_name() {
    let (_dir, repo) = fresh_repo().await;
    let err = repo
        .create(NewProject {
            name: "   ".into(),
            root: abs("c"),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectError::EmptyName), "got {err:?}");
}

#[tokio::test]
async fn create_rejects_relative_root() {
    let (_dir, repo) = fresh_repo().await;
    let err = repo
        .create(NewProject {
            name: "x".into(),
            root: PathBuf::from("relative/path"),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectError::RelativeRoot(_)), "got {err:?}");
}

#[tokio::test]
async fn create_rejects_duplicate_root() {
    let (_dir, repo) = fresh_repo().await;
    let _ = repo
        .create(NewProject {
            name: "one".into(),
            root: abs("dup"),
        })
        .await
        .unwrap();
    let err = repo
        .create(NewProject {
            name: "two".into(),
            root: abs("dup"),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, ProjectError::DuplicateRoot(_)), "got {err:?}");
}

#[tokio::test]
async fn list_returns_in_insertion_order() {
    let (_dir, repo) = fresh_repo().await;
    let a = repo
        .create(NewProject {
            name: "a".into(),
            root: abs("la"),
        })
        .await
        .unwrap();
    let b = repo
        .create(NewProject {
            name: "b".into(),
            root: abs("lb"),
        })
        .await
        .unwrap();
    let all = repo.list().await.unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, a.id);
    assert_eq!(all[1].id, b.id);
}

#[tokio::test]
async fn delete_removes_existing_returns_true() {
    let (_dir, repo) = fresh_repo().await;
    let p = repo
        .create(NewProject {
            name: "z".into(),
            root: abs("del"),
        })
        .await
        .unwrap();
    assert!(repo.delete(&p.id).await.unwrap());
    let err = repo.get(&p.id).await.unwrap_err();
    assert!(matches!(err, ProjectError::NotFound(_)));
}

#[tokio::test]
async fn delete_missing_returns_false() {
    let (_dir, repo) = fresh_repo().await;
    assert!(!repo.delete("nonexistent").await.unwrap());
}

#[tokio::test]
async fn get_unknown_returns_not_found() {
    let (_dir, repo) = fresh_repo().await;
    let err = repo.get("nope").await.unwrap_err();
    assert!(matches!(err, ProjectError::NotFound(_)));
}
