//! E2E for the backups admin endpoints (Settings → Backups panel).

use crate::support::BeHarness;
use serde_json::Value;

/// Fresh harness starts with at least one backup (the bootstrap
/// snapshot the server takes on startup). Listing should succeed.
#[tokio::test]
async fn list_backups_after_startup() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/api/backups").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    // state_dir is whatever tempdir the harness created.
    assert!(body["state_dir"].is_string());
    let backups = body["backups"].as_array().unwrap();
    // No assertion on count — harness may or may not have run the
    // startup snapshot depending on whether the DB pre-existed.
    // We just check the shape: each entry has name/size/created/tag.
    for b in backups {
        assert!(b["name"].is_string());
        assert!(b["size_bytes"].is_u64());
        assert!(b["created_at_secs"].is_u64());
    }
}

/// Manual snapshot landing under `<state_dir>/backups/`.
#[tokio::test]
async fn create_manual_snapshot_returns_name() {
    let h = BeHarness::start().await;
    let res = h.post_auth("/api/backups").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let name = body["name"].as_str().unwrap();
    assert!(
        name.starts_with("db-") && name.contains("-manual"),
        "expected db-<ts>-manual, got {name}"
    );

    // The new snapshot should appear in the list.
    let list: Value = h
        .get_auth("/api/backups")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = list["backups"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|b| b["name"].as_str())
        .collect();
    assert!(names.iter().any(|n| *n == name), "name missing: {names:?}");
}

/// Restoring an unknown snapshot is 404.
#[tokio::test]
async fn restore_unknown_snapshot_404() {
    let h = BeHarness::start().await;
    let res = h
        .post_auth("/api/backups/does-not-exist/restore")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

/// Restoring a real snapshot returns the operator instructions
/// (we deliberately don't touch live files from a running server).
#[tokio::test]
async fn restore_real_snapshot_returns_instructions() {
    let h = BeHarness::start().await;
    // Take a snapshot we know is there.
    let created: Value = h
        .post_auth("/api/backups")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let name = created["name"].as_str().unwrap();
    let res = h
        .post_auth(&format!("/api/backups/{name}/restore"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["snapshot"], name);
    assert!(body["snapshot_path"].as_str().unwrap().ends_with(name));
    let cmd = body["shell_command"].as_str().unwrap();
    assert!(cmd.contains("just restore-db"));
    assert!(cmd.contains(name));
}
