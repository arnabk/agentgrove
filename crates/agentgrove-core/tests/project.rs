//! Component-level tests for the `Project` aggregate.

use agentgrove_core::{Error, Project};
use std::path::PathBuf;

#[cfg(unix)]
fn abs_path() -> PathBuf {
    PathBuf::from("/tmp/agentgrove-test")
}

#[cfg(windows)]
fn abs_path() -> PathBuf {
    PathBuf::from(r"C:\agentgrove-test")
}

#[test]
fn new_project_requires_non_empty_name() {
    let err = Project::new("   ", abs_path()).unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "got: {err:?}");
}

#[test]
fn new_project_requires_absolute_root() {
    let err = Project::new("demo", "relative/path").unwrap_err();
    assert!(matches!(err, Error::InvalidInput(_)), "got: {err:?}");
}

#[test]
fn new_project_trims_name() {
    let p = Project::new("  hello  ", abs_path()).unwrap();
    assert_eq!(p.name, "hello");
    assert_eq!(p.root, abs_path());
}

#[test]
fn new_project_assigns_unique_ids() {
    let a = Project::new("a", abs_path()).unwrap();
    let b = Project::new("b", abs_path()).unwrap();
    assert_ne!(a.id, b.id);
}

#[test]
fn project_roundtrips_through_json() {
    let p = Project::new("hello", abs_path()).unwrap();
    let json = serde_json::to_string(&p).unwrap();
    let back: Project = serde_json::from_str(&json).unwrap();
    assert_eq!(p, back);
}
