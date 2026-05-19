//! `/health` is public and returns `{"status": "ok", "version": ...}`.

use crate::support::BeHarness;

#[tokio::test]
async fn health_returns_ok_without_auth() {
    let h = BeHarness::start().await;
    let res = h.get_anon("/health").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert!(body["version"].as_str().is_some());
}
