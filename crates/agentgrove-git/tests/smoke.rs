//! Smoke test that the crate is wired and a `gix` repository can be
//! initialized in a tempdir on every supported OS.

use tempfile::tempdir;

#[test]
fn can_init_a_gix_repo_in_tempdir() {
    let dir = tempdir().unwrap();
    let repo = gix::init(dir.path()).expect("init repo");
    assert!(repo.path().exists(), "repo .git dir must exist");
}

#[test]
fn crate_exposes_version() {
    assert!(!agentgrove_git::gix_version().is_empty());
}
