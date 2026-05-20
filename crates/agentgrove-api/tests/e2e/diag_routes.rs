//! E2E for /api/diag/memory.

use crate::support::BeHarness;
use serde_json::Value;

#[tokio::test]
async fn diag_memory_returns_backend_entry() {
    let h = BeHarness::start().await;
    let res = h.get("/api/diag/memory").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert!(body["backend"]["pid"].as_u64().is_some());
    assert_eq!(body["backend"]["kind"], "backend");
    // Backend RSS should be > 0 since we're literally running.
    let rss = body["backend"]["rss_bytes"].as_u64().unwrap_or(0);
    assert!(rss > 0, "expected backend RSS > 0, got {rss}");
    assert!(body["children"].is_array());
    assert!(body["total_rss_bytes"].as_u64().unwrap_or(0) >= rss);
}
