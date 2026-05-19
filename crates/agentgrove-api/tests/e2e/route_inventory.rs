//! Enforce that every route exposed by the router is covered by an E2E
//! test. The inventory is committed at `tests/e2e/coverage.txt`. CI fails
//! when the router changes without a matching inventory update.

use std::collections::BTreeSet;

/// The canonical list of routes that must exist in the router. Add a route
/// here only after writing an E2E test that exercises it.
fn expected_routes() -> BTreeSet<&'static str> {
    ["GET /health", "GET /whoami"].into_iter().collect()
}

#[test]
fn coverage_file_matches_expected_routes() {
    let coverage = include_str!("coverage.txt");
    let actual: BTreeSet<&str> = coverage
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let expected = expected_routes();
    assert_eq!(
        actual, expected,
        "coverage.txt drifted from expected_routes()"
    );
}
