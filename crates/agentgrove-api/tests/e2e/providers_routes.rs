//! L4 endpoint coverage for `GET /api/providers`.
//!
//! We don't assume the `claude` CLI is on the test host's PATH; the
//! provider list is always returned (every known provider gets a
//! descriptor even when its CLI is missing). When `claude` *is*
//! installed, the response should report `available: true`.

use crate::support::BeHarness;
use serde_json::Value;

#[tokio::test]
async fn providers_route_returns_claude_descriptor() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/api/providers").send().await.unwrap();
    assert_eq!(res.status(), 200, "body={}", res.text().await.unwrap());
    let body: Value = res.json().await.unwrap();
    let arr = body.as_array().expect("providers list is a JSON array");
    assert!(
        !arr.is_empty(),
        "expected at least one provider in the registry"
    );
    let claude = arr
        .iter()
        .find(|p| p["id"] == "claude")
        .expect("claude provider missing from /api/providers");
    assert_eq!(claude["label"], "Claude");
    assert_eq!(claude["default_model"], "sonnet");
    assert_eq!(claude["supports_resume"], true);
    assert!(
        claude["install_hint"]
            .as_str()
            .unwrap_or("")
            .starts_with("https://"),
        "install hint should be a URL"
    );
    // `available` depends on the host but the field must be a bool.
    assert!(claude["available"].is_boolean());
}

#[tokio::test]
async fn providers_route_reports_version_when_cli_present() {
    let h = BeHarness::start().await;
    let res = h.get_auth("/api/providers").send().await.unwrap();
    let body: Value = res.json().await.unwrap();
    let arr = body.as_array().unwrap();
    let claude = arr.iter().find(|p| p["id"] == "claude").unwrap();
    if which::which("claude").is_ok() {
        assert_eq!(claude["available"], true);
        assert!(
            claude["path"].is_string() && !claude["path"].as_str().unwrap().is_empty(),
            "path should be set when CLI is installed"
        );
        assert!(
            claude["version"].is_string(),
            "version should be reported when CLI is installed"
        );
    } else {
        assert_eq!(claude["available"], false);
        assert!(claude["path"].is_null());
        assert!(claude["version"].is_null());
    }
}
